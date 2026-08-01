import { join } from "node:path";

import { controlExecution } from "@/src/server/execution/execution-control-service";
import {
  executionErrorResponse,
  readBoundedExecutionJson,
} from "@/src/server/execution/execution-api";
import { requestExecutionProcessTermination } from "@/src/server/execution/process-runner";
import { sandboxExecutor } from "@/src/server/execution/sandbox-executor";
import { executionControlInputSchema } from "@/src/shared/execution-contracts";

type RouteContext = { params: Promise<{ executionId: string }> };

function databasePath(): string {
  return process.env.COCKPIT_DB_PATH ?? join(process.cwd(), ".data", "cockpit.sqlite");
}

function executionRoot(): string {
  return process.env.COCKPIT_EXECUTION_ROOT
    ?? join(process.cwd(), ".data", "executions");
}

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const { executionId } = await context.params;
  const parsed = await readBoundedExecutionJson(request);
  if (!parsed.ok) return parsed.response;
  const input = executionControlInputSchema.safeParse(parsed.value);
  if (!input.success) {
    return Response.json(
      { error: { code: "INVALID_INPUT", message: "Execution control input is invalid." } },
      { status: 400 },
    );
  }
  try {
    const result = await controlExecution(
      databasePath(),
      executionId,
      input.data,
      {
        executionRoot: executionRoot(),
        requestProcessTermination: requestExecutionProcessTermination,
        sandboxExecutor: sandboxExecutor(),
      },
    );
    return Response.json(result.body, { status: result.status });
  } catch (error) {
    return executionErrorResponse(
      error,
      "POST /api/executions/:executionId/control",
    );
  }
}
