import { join } from "node:path";

import { executionErrorResponse } from "@/app/api/_shared/execution/execution-api";
import { policyProcessReconciliation, policyProcessService } from "@/src/composition";

type RouteContext = {
  params: Promise<{ executionId: string; processId: string }>;
};

function databasePath(): string {
  return process.env.COCKPIT_DB_PATH ?? join(process.cwd(), ".data", "cockpit.sqlite");
}

function cursor(value: string | null): number | null {
  if (value === null) return 0;
  if (!/^\d{1,10}$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const { executionId, processId } = await context.params;
  const query = new URL(request.url).searchParams;
  const stdout = cursor(query.get("stdoutCursor"));
  const stderr = cursor(query.get("stderrCursor"));
  if (
    !executionId
    || !processId
    || executionId.length > 200
    || processId.length > 200
    || stdout === null
    || stderr === null
    || [...query.keys()].some((key) => key !== "stdoutCursor" && key !== "stderrCursor")
  ) {
    return Response.json(
      { error: { code: "INVALID_INPUT", message: "Policy process output query is invalid." } },
      { status: 400 },
    );
  }
  try {
    policyProcessReconciliation.ensurePolicyProcessesReconciled(databasePath());
    return Response.json(policyProcessService.getPolicyProcessOutput(
      databasePath(),
      executionId,
      processId,
      { stderr, stdout },
    ));
  } catch (error) {
    return executionErrorResponse(
      error,
      "GET /api/executions/:executionId/policy-processes/:processId/output",
    );
  }
}
