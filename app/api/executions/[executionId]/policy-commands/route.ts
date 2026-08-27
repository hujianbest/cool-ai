import { join } from "node:path";

import { policyProcessReconciliation, policyProcessService } from "@/src/composition";
import { ExecutionError } from "@/src/modules/safe-execution";

type RouteContext = { params: Promise<{ executionId: string }> };

function databasePath(): string {
  return process.env.COCKPIT_DB_PATH ?? join(process.cwd(), ".data", "cockpit.sqlite");
}

export async function GET(
  _request: Request,
  context: RouteContext,
): Promise<Response> {
  const { executionId } = await context.params;
  if (!executionId || executionId.length > 200) {
    return Response.json(
      { error: { code: "INVALID_INPUT", message: "Execution id is invalid." } },
      { status: 400 },
    );
  }
  try {
    policyProcessReconciliation.ensurePolicyProcessesReconciled(databasePath());
    return Response.json(policyProcessService.listExecutionPolicyCommands(
      databasePath(),
      executionId,
    ));
  } catch (error) {
    if (error instanceof ExecutionError) {
      return Response.json(
        { error: { code: error.code, message: "Policy command request failed." } },
        { status: error.httpStatus },
      );
    }
    return Response.json(
      { error: { code: "INTERNAL_ERROR", message: "Policy command service failed." } },
      { status: 500 },
    );
  }
}
