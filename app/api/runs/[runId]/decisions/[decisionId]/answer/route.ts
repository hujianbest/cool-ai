import { join } from "node:path";

import {
  collaborationErrorResponse,
  readCollaborationJson,
} from "@/src/server/collaboration/collaboration-api";
import { answerDecision } from "@/src/server/collaboration/run-service";

type RouteContext = {
  params: Promise<{ decisionId: string; runId: string }>;
};

function databasePath(): string {
  return process.env.COCKPIT_DB_PATH ?? join(process.cwd(), ".data", "cockpit.sqlite");
}

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const { decisionId, runId } = await context.params;
  const parsed = await readCollaborationJson(request);
  if (!parsed.ok) return parsed.response;
  try {
    const result = answerDecision(databasePath(), runId, decisionId, parsed.value);
    return Response.json(result.body, { status: result.status });
  } catch (error) {
    return collaborationErrorResponse(
      error,
      "POST /api/runs/:runId/decisions/:decisionId/answer",
    );
  }
}
