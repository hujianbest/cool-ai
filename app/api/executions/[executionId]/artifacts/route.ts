import {
  executionDatabasePath,
  executionReadResponse,
  readQuery,
} from "@/app/api/_shared/execution/execution-read-api";
import { executionReadService } from "@/src/composition";

type RouteContext = { params: Promise<{ executionId: string }> };

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const { executionId } = await context.params;
  return executionReadResponse("GET /api/executions/:executionId/artifacts", () =>
    executionReadService.listExecutionArtifacts(executionDatabasePath(), executionId, readQuery(request)));
}
