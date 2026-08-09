import { join } from "node:path";

import { contextApiError } from "@/src/server/context-api";
import { createContextSnapshot } from "@/src/application/workflows/project-context-snapshot";

type RouteContext = { params: Promise<{ projectId: string }> };

function databasePath(): string {
  return process.env.COCKPIT_DB_PATH ?? join(process.cwd(), ".data", "cockpit.sqlite");
}

export async function GET(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const { projectId } = await context.params;
  const agentId = new URL(request.url).searchParams.get("agentId")?.trim() ?? "";
  if (!agentId) {
    return Response.json(
      {
        error: {
          code: "INVALID_INPUT",
          fields: [{ code: "required", field: "agentId" }],
          message: "Context request is invalid.",
        },
      },
      { status: 400 },
    );
  }
  try {
    return Response.json(
      createContextSnapshot(databasePath(), projectId, agentId),
    );
  } catch (error) {
    return contextApiError(error, "GET /api/projects/:projectId/context");
  }
}
