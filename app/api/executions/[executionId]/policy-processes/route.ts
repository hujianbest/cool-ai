import { join } from "node:path";

import { z } from "zod";

import {
  executionErrorResponse,
  readBoundedExecutionJson,
} from "@/app/api/_shared/execution/execution-api";
import { policyProcessReconciliation, policyProcessService } from "@/src/composition";

type RouteContext = { params: Promise<{ executionId: string }> };

const commonSchema = {
  expectedExecutionVersion: z.number().int().positive(),
  operationId: z.string().uuid(),
};
const inputSchema = z.union([
  z.object({
    ...commonSchema,
    entryId: z.string().min(1).max(200),
  }).strict(),
  z.object({
    ...commonSchema,
    command: z.object({
      args: z.array(z.string().max(4_096)).max(128),
      executable: z.string().min(1).max(260),
      workdir: z.string().min(1).max(2_048),
    }).strict(),
  }).strict(),
  z.object({
    ...commonSchema,
    approvalId: z.string().uuid(),
  }).strict(),
]);

function databasePath(): string {
  return process.env.COCKPIT_DB_PATH ?? join(process.cwd(), ".data", "cockpit.sqlite");
}

function executionRoot(): string {
  return process.env.COCKPIT_EXECUTION_ROOT
    ?? join(process.cwd(), ".data", "executions");
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const { executionId } = await context.params;
  const parsed = await readBoundedExecutionJson(request);
  if (!parsed.ok) return parsed.response;
  const input = inputSchema.safeParse(parsed.value);
  if (!input.success || !executionId || executionId.length > 200) {
    return Response.json(
      { error: { code: "INVALID_INPUT", message: "Policy process input is invalid." } },
      { status: 400 },
    );
  }
  try {
    policyProcessReconciliation.ensurePolicyProcessesReconciled(databasePath());
    const result = "entryId" in input.data
      ? await policyProcessService.startPolicyProcessSession(databasePath(), executionId, input.data)
      : "approvalId" in input.data
        ? policyProcessService.startApprovedPolicyProcess(
          databasePath(),
          executionId,
          input.data,
          executionRoot(),
        )
        : policyProcessService.requestLabeledPolicyProcessApproval(
          databasePath(),
          executionId,
          input.data,
          executionRoot(),
        );
    return Response.json(result, {
      status: "status" in result && result.status === "running" ? 201 : 200,
    });
  } catch (error) {
    return executionErrorResponse(error, "POST /api/executions/:executionId/policy-processes");
  }
}
