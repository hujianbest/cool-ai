import { join } from "node:path";

import { memoryApiError, readMemoryJson } from "@/app/api/_shared/memory-api";
import { memoryService } from "@/src/composition";
import type { CreateMemoryInput } from "@/src/modules/knowledge-provenance";
import {
  memoryCreateResponseSchema,
  memoryListResponseSchema,
} from "@/src/shared/memory-contracts";

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
    const includeInactive =
      new URL(request.url).searchParams.get("includeInactive") === "1";
    return Response.json(memoryListResponseSchema.parse({
      memories: memoryService.listMemories(databasePath(), projectId, includeInactive),
    }));
  } catch (error) {
    return memoryApiError(error, "GET /api/projects/:projectId/memories");
  }
}

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const { projectId } = await context.params;
  const body = await readMemoryJson(request);
  if (!body.ok) return body.response;
  try {
    return Response.json(
      memoryCreateResponseSchema.parse({
        memory: memoryService.createMemory(
          databasePath(),
          projectId,
          body.value as CreateMemoryInput,
        ),
      }),
      { status: 201 },
    );
  } catch (error) {
    return memoryApiError(error, "POST /api/projects/:projectId/memories");
  }
}
