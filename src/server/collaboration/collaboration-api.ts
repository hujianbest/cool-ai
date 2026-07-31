import {
  collaborationErrorBody,
  CollaborationError,
} from "@/src/server/collaboration/collaboration-errors";
import { SchemaMigrationError } from "@/src/server/migrations";
import {
  internalErrorResponse,
  storageErrorResponse,
} from "@/src/server/api-errors";

export async function readCollaborationJson(
  request: Request,
): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  try {
    return { ok: true, value: await request.json() };
  } catch {
    return {
      ok: false,
      response: Response.json(
        { error: { code: "INVALID_JSON", message: "Request body must be valid JSON." } },
        { status: 400 },
      ),
    };
  }
}

export function collaborationErrorResponse(error: unknown, route: string): Response {
  if (error instanceof CollaborationError) {
    return Response.json(collaborationErrorBody(error), { status: error.httpStatus });
  }
  if (error instanceof SchemaMigrationError) {
    return Response.json(
      { error: { code: "STORAGE_UNAVAILABLE", message: "Storage is unavailable." } },
      { status: 503 },
    );
  }
  return storageErrorResponse(error) ?? internalErrorResponse(route);
}
