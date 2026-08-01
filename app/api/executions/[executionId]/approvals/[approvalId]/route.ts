import { join } from "node:path";

import { decideExecutionApproval } from "@/src/server/execution/execution-approval-service";
import {
  executionErrorResponse,
  readBoundedExecutionJson,
} from "@/src/server/execution/execution-api";
import { executionApprovalInputSchema } from "@/src/shared/execution-contracts";

type RouteContext = {
  params: Promise<{ approvalId: string; executionId: string }>;
};

function databasePath(): string {
  return process.env.COCKPIT_DB_PATH ?? join(process.cwd(), ".data", "cockpit.sqlite");
}

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const { approvalId, executionId } = await context.params;
  const parsed = await readBoundedExecutionJson(request);
  if (!parsed.ok) return parsed.response;
  const input = executionApprovalInputSchema.safeParse(parsed.value);
  if (!input.success) {
    return Response.json(
      { error: { code: "INVALID_INPUT", message: "Approval input is invalid." } },
      { status: 400 },
    );
  }
  try {
    const result = await decideExecutionApproval(
      databasePath(),
      executionId,
      approvalId,
      input.data,
    );
    return Response.json(result.body, { status: result.status });
  } catch (error) {
    return executionErrorResponse(
      error,
      "POST /api/executions/:executionId/approvals/:approvalId",
    );
  }
}
