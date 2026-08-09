import { join } from "node:path";

import { collaborationErrorResponse } from "@/app/api/_shared/collaboration/collaboration-api";
import { runService } from "@/src/composition";

type RouteContext = { params: Promise<{ projectId: string }> };

function databasePath(): string {
  return process.env.COCKPIT_DB_PATH ?? join(process.cwd(), ".data", "cockpit.sqlite");
}

export async function GET(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const { projectId } = await context.params;
  try {
    const searchParams = new URL(request.url).searchParams;
    return Response.json(
      runService.getCollaboration(databasePath(), projectId, {
        events: runService.parseReadCursor(searchParams, "eventAfter", "eventLimit"),
        messages: runService.parseReadCursor(searchParams, "messageAfter", "messageLimit"),
      }),
    );
  } catch (error) {
    return collaborationErrorResponse(
      error,
      "GET /api/projects/:projectId/collaboration",
    );
  }
}
