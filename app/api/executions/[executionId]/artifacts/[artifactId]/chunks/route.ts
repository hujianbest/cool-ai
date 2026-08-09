import {
  executionDatabasePath,
  executionReadResponse,
  readQuery,
} from "@/app/api/_shared/execution/execution-read-api";
import { executionReadService } from "@/src/composition";

type RouteContext = {
  params: Promise<{ artifactId: string; executionId: string }>;
};

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const { artifactId, executionId } = await context.params;
  return executionReadResponse(
    "GET /api/executions/:executionId/artifacts/:artifactId/chunks",
    () => executionReadService.listArtifactChunks(
      executionDatabasePath(),
      executionId,
      artifactId,
      readQuery(request),
    ),
  );
}
