import {
  executionDatabasePath,
  executionReadResponse,
} from "@/src/server/execution/execution-read-api";
import { readExecutionDetail } from "@/src/server/execution/execution-read-service";

type RouteContext = { params: Promise<{ executionId: string }> };

export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  const { executionId } = await context.params;
  return executionReadResponse("GET /api/executions/:executionId", () =>
    readExecutionDetail(executionDatabasePath(), executionId));
}
