import {
  collaborationErrorBody,
  CollaborationError,
} from "@/src/server/collaboration/collaboration-errors";
import {
  internalErrorResponse,
  storageErrorResponse,
} from "@/src/server/api-errors";
import { SchemaError } from "@/src/server/storage/schema-error";

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
  if (error instanceof SchemaError) {
    return Response.json(
      { error: { code: error.code, message: error.message } },
      { status: 503 },
    );
  }
  return storageErrorResponse(error) ?? internalErrorResponse(route);
}
