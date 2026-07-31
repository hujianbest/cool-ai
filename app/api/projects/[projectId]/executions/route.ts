import { join } from "node:path";

import {
  executionErrorResponse,
  readExecutionJson,
} from "@/src/server/execution/execution-api";
import {
  executionDatabasePath,
  executionReadResponse,
  readQuery,
} from "@/src/server/execution/execution-read-api";
import { listProjectExecutions } from "@/src/server/execution/execution-read-service";
import {
  startExecution,
} from "@/src/server/execution/execution-service";
import { sandboxExecutor } from "@/src/server/execution/sandbox-executor";
import { startExecutionInputSchema } from "@/src/shared/execution-contracts";

type RouteContext = { params: Promise<{ projectId: string }> };

function databasePath(): string {
  return process.env.COCKPIT_DB_PATH ?? join(process.cwd(), ".data", "cockpit.sqlite");
}

function executionRoot(): string {
  return process.env.COCKPIT_EXECUTION_ROOT
    ?? join(process.cwd(), ".data", "executions");
}

export async function GET(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const { projectId } = await context.params;
  return executionReadResponse("GET /api/projects/:projectId/executions", async () => {
    const page = await listProjectExecutions(executionDatabasePath(), projectId, readQuery(request));
    return new URL(request.url).search === ""
      ? { executions: page.items }
      : { executions: page.items, nextCursor: page.nextCursor };
  });
}

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const { projectId } = await context.params;
  const parsed = await readExecutionJson(request);
  if (!parsed.ok) return parsed.response;
  const input = startExecutionInputSchema.safeParse(parsed.value);
  if (!input.success) {
    return Response.json(
      { error: { code: "INVALID_INPUT", message: "Execution input is invalid." } },
      { status: 400 },
    );
  }
  try {
    const result = await startExecution(
      databasePath(),
      projectId,
      input.data,
      sandboxExecutor(),
      executionRoot(),
    );
    return Response.json(result.body, { status: result.status });
  } catch (error) {
    return executionErrorResponse(
      error,
      "POST /api/projects/:projectId/executions",
    );
  }
}
