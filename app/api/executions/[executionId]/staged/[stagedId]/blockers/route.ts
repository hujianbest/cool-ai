import {
  executionDatabasePath,
  executionReadResponse,
  readQuery,
} from "@/src/server/execution/execution-read-api";
import { listStagedBlockers } from "@/src/server/execution/execution-read-service";

type RouteContext = {
  params: Promise<{ executionId: string; stagedId: string }>;
};

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const { executionId, stagedId } = await context.params;
  return executionReadResponse(
    "GET /api/executions/:executionId/staged/:stagedId/blockers",
    () => listStagedBlockers(
      executionDatabasePath(),
      executionId,
      stagedId,
      readQuery(request),
    ),
  );
}
