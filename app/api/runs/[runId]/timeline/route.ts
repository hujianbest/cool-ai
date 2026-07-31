import { join } from "node:path";

import { collaborationErrorResponse } from "@/src/server/collaboration/collaboration-api";
import {
  getRunTimeline,
  parseReadCursor,
} from "@/src/server/collaboration/run-service";

type RouteContext = { params: Promise<{ runId: string }> };

function databasePath(): string {
  return process.env.COCKPIT_DB_PATH ?? join(process.cwd(), ".data", "cockpit.sqlite");
}

export async function GET(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const { runId } = await context.params;
  try {
    const cursor = parseReadCursor(new URL(request.url).searchParams);
    return Response.json(getRunTimeline(databasePath(), runId, cursor));
  } catch (error) {
    return collaborationErrorResponse(error, "GET /api/runs/:runId/timeline");
  }
}
