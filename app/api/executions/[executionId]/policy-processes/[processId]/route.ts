import { join } from "node:path";

import { executionErrorResponse } from "@/app/api/_shared/execution/execution-api";
import { policyProcessReconciliation, policyProcessService } from "@/src/composition";

type RouteContext = {
  params: Promise<{ executionId: string; processId: string }>;
};

function databasePath(): string {
  return process.env.COCKPIT_DB_PATH ?? join(process.cwd(), ".data", "cockpit.sqlite");
}

export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  const { executionId, processId } = await context.params;
  if (!executionId || !processId || executionId.length > 200 || processId.length > 200) {
    return Response.json(
      { error: { code: "INVALID_INPUT", message: "Policy process identity is invalid." } },
      { status: 400 },
    );
  }
  try {
    policyProcessReconciliation.ensurePolicyProcessesReconciled(databasePath());
    return Response.json(
      policyProcessService.getPolicyProcess(databasePath(), executionId, processId),
    );
  } catch (error) {
    return executionErrorResponse(
      error,
      "GET /api/executions/:executionId/policy-processes/:processId",
    );
  }
}
