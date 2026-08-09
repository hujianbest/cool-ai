import {
  executionDatabasePath,
  executionReadResponse,
  readQuery,
} from "@/src/server/execution/execution-read-api";
import { listValidationChunks } from "@/src/adapters/outbound/sqlite/safe-execution/execution-read-service";

type RouteContext = {
  params: Promise<{ executionId: string; stream: string; validationId: string }>;
};

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const { executionId, stream, validationId } = await context.params;
  return executionReadResponse(
    "GET /api/executions/:executionId/validations/:validationId/:stream/chunks",
    () => {
      if (stream !== "stdout" && stream !== "stderr") {
        throw new Error("INVALID_READ_QUERY");
      }
      return listValidationChunks(
        executionDatabasePath(),
        executionId,
        validationId,
        stream,
        readQuery(request),
      );
    },
  );
}
