import {
  executionDatabasePath,
  executionReadResponse,
} from "@/app/api/_shared/execution/execution-read-api";
import { executionReadService } from "@/src/composition";

type RouteContext = { params: Promise<{ executionId: string }> };

export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  const { executionId } = await context.params;
  return executionReadResponse("GET /api/executions/:executionId", () =>
    executionReadService.readExecutionDetail(executionDatabasePath(), executionId));
}
