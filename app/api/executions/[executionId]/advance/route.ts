import { join } from "node:path";

import { advanceExecution } from "@/src/server/execution/action-orchestrator";
import {
  executionErrorResponse,
  readExecutionJson,
} from "@/src/server/execution/execution-api";
import {
  createWindowsVerifiedExecutionAdapters,
} from "@/src/server/execution/windows-verified-execution-adapter";
import { advanceExecutionInputSchema } from "@/src/shared/execution-contracts";

type RouteContext = { params: Promise<{ executionId: string }> };

function databasePath(): string {
  return process.env.COCKPIT_DB_PATH ?? join(process.cwd(), ".data", "cockpit.sqlite");
}

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const { executionId } = await context.params;
  const parsed = await readExecutionJson(request);
  if (!parsed.ok) return parsed.response;
  const input = advanceExecutionInputSchema.safeParse(parsed.value);
  if (!input.success) {
    return Response.json(
      { error: { code: "INVALID_INPUT", message: "Advance input is invalid." } },
      { status: 400 },
    );
  }
  try {
    const adapters = createWindowsVerifiedExecutionAdapters();
    const result = await advanceExecution(
      databasePath(),
      executionId,
      input.data,
      adapters,
    );
    return Response.json(result.body, { status: result.status });
  } catch (error) {
    return executionErrorResponse(
      error,
      "POST /api/executions/:executionId/advance",
    );
  }
}
