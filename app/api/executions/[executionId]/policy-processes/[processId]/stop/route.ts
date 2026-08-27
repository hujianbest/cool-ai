import { join } from "node:path";

import { z } from "zod";

import {
  executionErrorResponse,
  readBoundedExecutionJson,
} from "@/app/api/_shared/execution/execution-api";
import { policyProcessReconciliation, policyProcessService } from "@/src/composition";

type RouteContext = {
  params: Promise<{ executionId: string; processId: string }>;
};

const inputSchema = z.object({
  expectedVersion: z.number().int().positive(),
}).strict();

function databasePath(): string {
  return process.env.COCKPIT_DB_PATH ?? join(process.cwd(), ".data", "cockpit.sqlite");
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const { executionId, processId } = await context.params;
  const parsed = await readBoundedExecutionJson(request);
  if (!parsed.ok) return parsed.response;
  const input = inputSchema.safeParse(parsed.value);
  if (
    !executionId
    || !processId
    || executionId.length > 200
    || processId.length > 200
    || !input.success
  ) {
    return Response.json(
      { error: { code: "INVALID_INPUT", message: "Policy process stop input is invalid." } },
      { status: 400 },
    );
  }
  try {
    policyProcessReconciliation.ensurePolicyProcessesReconciled(databasePath());
    return Response.json(
      policyProcessService.stopPolicyProcess(
        databasePath(),
        executionId,
        processId,
        input.data.expectedVersion,
      ),
    );
  } catch (error) {
    return executionErrorResponse(
      error,
      "POST /api/executions/:executionId/policy-processes/:processId/stop",
    );
  }
}
