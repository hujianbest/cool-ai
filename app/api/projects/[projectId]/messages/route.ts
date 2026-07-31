import { join } from "node:path";

import {
  collaborationErrorResponse,
  readCollaborationJson,
} from "@/src/server/collaboration/collaboration-api";
import { appendProjectMessage } from "@/src/server/collaboration/run-service";

type RouteContext = { params: Promise<{ projectId: string }> };

function databasePath(): string {
  return process.env.COCKPIT_DB_PATH ?? join(process.cwd(), ".data", "cockpit.sqlite");
}

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const { projectId } = await context.params;
  const parsed = await readCollaborationJson(request);
  if (!parsed.ok) return parsed.response;
  try {
    const result = appendProjectMessage(databasePath(), projectId, parsed.value);
    return Response.json(result.body, { status: result.status });
  } catch (error) {
    return collaborationErrorResponse(
      error,
      "POST /api/projects/:projectId/messages",
    );
  }
}
