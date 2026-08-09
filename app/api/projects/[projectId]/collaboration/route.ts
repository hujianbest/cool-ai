import { join } from "node:path";

import { collaborationErrorResponse } from "@/src/server/collaboration/collaboration-api";
import {
  getCollaboration,
  parseReadCursor,
} from "@/src/adapters/outbound/sqlite/public-collaboration/run-service";

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
      getCollaboration(databasePath(), projectId, {
        events: parseReadCursor(searchParams, "eventAfter", "eventLimit"),
        messages: parseReadCursor(searchParams, "messageAfter", "messageLimit"),
      }),
    );
  } catch (error) {
    return collaborationErrorResponse(
      error,
      "GET /api/projects/:projectId/collaboration",
    );
  }
}
