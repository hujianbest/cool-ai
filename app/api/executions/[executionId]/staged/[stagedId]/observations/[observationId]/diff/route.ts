import {
  executionDatabasePath,
  executionReadResponse,
  readQuery,
} from "@/app/api/_shared/execution/execution-read-api";
import { executionReadService } from "@/src/composition";

type RouteContext = {
  params: Promise<{ executionId: string; observationId: string; stagedId: string }>;
};

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const { executionId, observationId, stagedId } = await context.params;
  return executionReadResponse(
    "GET /api/executions/:executionId/staged/:stagedId/observations/:observationId/diff",
    () => executionReadService.readObservationDiff(
      executionDatabasePath(),
      executionId,
      stagedId,
      observationId,
      readQuery(request),
    ),
  );
}
