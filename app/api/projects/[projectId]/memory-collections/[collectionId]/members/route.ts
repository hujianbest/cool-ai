import { join } from "node:path";

import { memoryApiError, readMemoryJson } from "@/app/api/_shared/memory-api";
import { memoryCollections } from "@/src/composition";

type RouteContext = {
  params: Promise<{ collectionId: string; projectId: string }>;
};

function databasePath(): string {
  return process.env.COCKPIT_DB_PATH ?? join(process.cwd(), ".data", "cockpit.sqlite");
}

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const { collectionId, projectId } = await context.params;
  const body = await readMemoryJson(request);
  if (!body.ok) return body.response;
  if (
    typeof body.value !== "object"
    || body.value === null
    || !("memoryId" in body.value)
    || typeof body.value.memoryId !== "string"
    || Object.keys(body.value).length !== 1
  ) {
    return Response.json(
      { error: { code: "INVALID_INPUT", message: "Collection member request is invalid." } },
      { status: 400 },
    );
  }
  try {
    memoryCollections.addMemoryToCollection(
      databasePath(),
      projectId,
      collectionId,
      { memoryId: body.value.memoryId },
    );
    return new Response(null, { status: 204 });
  } catch (error) {
    return memoryApiError(error, "POST /api/projects/:projectId/memory-collections/:collectionId/members");
  }
}
