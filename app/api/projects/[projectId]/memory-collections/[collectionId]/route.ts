import { join } from "node:path";

import { memoryApiError } from "@/app/api/_shared/memory-api";
import { memoryCollections } from "@/src/composition";

type RouteContext = { params: Promise<{ projectId: string; collectionId: string }> };

function databasePath(): string {
  return process.env.COCKPIT_DB_PATH ?? join(process.cwd(), ".data", "cockpit.sqlite");
}

export async function DELETE(
  _request: Request,
  context: RouteContext,
): Promise<Response> {
  const { collectionId, projectId } = await context.params;
  try {
    memoryCollections.deleteMemoryCollection(databasePath(), projectId, collectionId);
    return new Response(null, { status: 204 });
  } catch (error) {
    return memoryApiError(error, "DELETE /api/projects/:projectId/memory-collections/:collectionId");
  }
}
