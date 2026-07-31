import {
  executionDatabasePath,
  executionReadResponse,
  readQuery,
} from "@/src/server/execution/execution-read-api";
import { listExecutionValidations } from "@/src/server/execution/execution-read-service";

type RouteContext = { params: Promise<{ executionId: string }> };

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const { executionId } = await context.params;
  return executionReadResponse("GET /api/executions/:executionId/validations", () =>
    listExecutionValidations(executionDatabasePath(), executionId, readQuery(request)));
}
