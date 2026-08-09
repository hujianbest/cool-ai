import { join } from "node:path";

import {
  executionErrorResponse,
  readBoundedExecutionJson,
} from "@/app/api/_shared/execution/execution-api";
import { executionControlService, processRunner, sandboxExecution } from "@/src/composition";
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
    const result = await executionControlService.controlExecution(
      databasePath(),
      executionId,
      input.data,
      {
        executionRoot: executionRoot(),
        requestProcessTermination: processRunner.requestExecutionProcessTermination,
        sandboxExecutor: sandboxExecution.sandboxExecutor(),
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
