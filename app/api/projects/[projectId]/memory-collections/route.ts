import { join } from "node:path";

import { memoryApiError, readMemoryJson } from "@/app/api/_shared/memory-api";
import { memoryCollections } from "@/src/composition";

type RouteContext = { params: Promise<{ projectId: string }> };

function databasePath(): string {
  return process.env.COCKPIT_DB_PATH ?? join(process.cwd(), ".data", "cockpit.sqlite");
}

export async function GET(
  _request: Request,
  context: RouteContext,
): Promise<Response> {
  const { projectId } = await context.params;
  try {
    return Response.json({
      collections: memoryCollections.listMemoryCollections(databasePath(), projectId),
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return memoryApiError(error, "GET /api/projects/:projectId/memory-collections");
  }
}

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const { projectId } = await context.params;
  const body = await readMemoryJson(request);
  if (!body.ok) return body.response;
  if (
    typeof body.value !== "object"
    || body.value === null
    || !("name" in body.value)
    || typeof body.value.name !== "string"
    || Object.keys(body.value).length !== 1
  ) {
    return Response.json(
      { error: { code: "INVALID_INPUT", message: "Collection request is invalid." } },
      { status: 400 },
    );
  }
  try {
    return Response.json(
      {
        collection: memoryCollections.createMemoryCollection(
          databasePath(),
          projectId,
          { name: body.value.name },
        ),
      },
      { status: 201 },
    );
  } catch (error) {
    return memoryApiError(error, "POST /api/projects/:projectId/memory-collections");
  }
}
