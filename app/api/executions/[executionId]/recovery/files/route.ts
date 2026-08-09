import {
  executionDatabasePath,
  executionReadResponse,
  readQuery,
} from "@/src/server/execution/execution-read-api";
import { listRecoveryFiles } from "@/src/adapters/outbound/sqlite/safe-execution/execution-read-service";

type RouteContext = { params: Promise<{ executionId: string }> };

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const { executionId } = await context.params;
  return executionReadResponse("GET /api/executions/:executionId/recovery/files", () =>
    listRecoveryFiles(executionDatabasePath(), executionId, readQuery(request)));
}
