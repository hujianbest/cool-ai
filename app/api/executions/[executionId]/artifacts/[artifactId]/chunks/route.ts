import {
  executionDatabasePath,
  executionReadResponse,
  readQuery,
} from "@/src/server/execution/execution-read-api";
import { listArtifactChunks } from "@/src/adapters/outbound/sqlite/safe-execution/execution-read-service";

type RouteContext = {
  params: Promise<{ artifactId: string; executionId: string }>;
};

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const { artifactId, executionId } = await context.params;
  return executionReadResponse(
    "GET /api/executions/:executionId/artifacts/:artifactId/chunks",
    () => listArtifactChunks(
      executionDatabasePath(),
      executionId,
      artifactId,
      readQuery(request),
    ),
  );
}
