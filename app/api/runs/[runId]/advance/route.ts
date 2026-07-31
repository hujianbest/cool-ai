import { join } from "node:path";

import { executeAdvance } from "@/src/server/collaboration/advance-executor";
import {
  collaborationErrorResponse,
  readCollaborationJson,
} from "@/src/server/collaboration/collaboration-api";

type RouteContext = { params: Promise<{ runId: string }> };

function databasePath(): string {
  return process.env.COCKPIT_DB_PATH ?? join(process.cwd(), ".data", "cockpit.sqlite");
}

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const { runId } = await context.params;
  const parsed = await readCollaborationJson(request);
  if (!parsed.ok) return parsed.response;
  try {
    const result = await executeAdvance(databasePath(), runId, parsed.value);
    return Response.json(result.body, { status: result.status });
  } catch (error) {
    return collaborationErrorResponse(error, "POST /api/runs/:runId/advance");
  }
}
