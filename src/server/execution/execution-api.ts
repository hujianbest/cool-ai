import { internalErrorResponse, storageErrorResponse } from "@/src/server/api-errors";
import { ExecutionError } from "@/src/server/execution/execution-service";
import { SchemaMigrationError } from "@/src/server/migrations";

export async function readExecutionJson(
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

export async function readBoundedExecutionJson(
  request: Request,
  maximumBytes = 128 * 1024,
): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximumBytes) {
    return {
      ok: false,
      response: Response.json(
        { error: { code: "INVALID_INPUT", message: "Request body exceeds its limit." } },
        { status: 400 },
      ),
    };
  }
  try {
    const text = await request.text();
    if (Buffer.byteLength(text, "utf8") > maximumBytes) {
      return {
        ok: false,
        response: Response.json(
          { error: { code: "INVALID_INPUT", message: "Request body exceeds its limit." } },
          { status: 400 },
        ),
      };
    }
    return { ok: true, value: JSON.parse(text) as unknown };
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

export function executionErrorResponse(error: unknown, route: string): Response {
  if (error instanceof ExecutionError) {
    const message = error.httpStatus === 400
      ? "The request is invalid."
      : error.httpStatus === 403
        ? "The operation is not allowed."
        : error.httpStatus === 404
          ? "The requested execution resource was not found."
          : error.httpStatus === 409
            ? "The execution state conflicts with this request."
            : error.httpStatus === 413
              ? "The request or response exceeds its limit."
              : error.httpStatus === 422
                ? "The execution resource cannot be processed."
                : "The execution service is unavailable.";
    return Response.json(
      { error: { code: error.code, message } },
      { status: error.httpStatus },
    );
  }
  if (error instanceof SchemaMigrationError) {
    return Response.json(
      { error: { code: "STORAGE_UNAVAILABLE", message: "Storage is unavailable." } },
      { status: 503 },
    );
  }
  return storageErrorResponse(error) ?? internalErrorResponse(route);
}
