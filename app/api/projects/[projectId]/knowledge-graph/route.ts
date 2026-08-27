import { join } from "node:path";

import { memoryApiError } from "@/app/api/_shared/memory-api";
import { knowledgeGraph } from "@/src/composition";

type RouteContext = { params: Promise<{ projectId: string }> };

const NO_STORE = { "cache-control": "no-store" };

function databasePath(): string {
  return process.env.COCKPIT_DB_PATH ?? join(process.cwd(), ".data", "cockpit.sqlite");
}

export async function GET(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const { projectId } = await context.params;
  const url = new URL(request.url);
  if (url.hash || Array.from(url.searchParams.keys()).length > 0) {
    return Response.json(
      { error: { code: "INVALID_INPUT", message: "Graph request is invalid." } },
      { headers: NO_STORE, status: 400 },
    );
  }
  try {
    return Response.json(
      knowledgeGraph.getKnowledgeGraph(databasePath(), projectId),
      { headers: NO_STORE },
    );
  } catch (error) {
    return memoryApiError(error, "GET /api/projects/:projectId/knowledge-graph");
  }
}
