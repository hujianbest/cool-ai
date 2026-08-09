import { internalErrorResponse, storageErrorResponse } from "@/src/server/api-errors";
import { ExecutionError } from "@/src/server/execution/execution-service";
import { SchemaError } from "@/src/adapters/outbound/sqlite/schema-error";

export async function readBoundedExecutionJson(
  request: Request,
  maximumBytes = 128 * 1024,
): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  const declaredHeader = request.headers.get("content-length");
  const declaredBytes = declaredHeader === null ? null : Number(declaredHeader);
  const oversizedResponse = () => Response.json(
    { error: { code: "INVALID_INPUT", message: "Request body exceeds its limit." } },
    { status: 400 },
  );
  if (declaredBytes !== null && Number.isFinite(declaredBytes) && declaredBytes > maximumBytes) {
    return {
      ok: false,
      response: oversizedResponse(),
    };
  }

  try {
    const reader = request.body?.getReader();
    const chunks: Uint8Array[] = [];
    let receivedBytes = 0;
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        receivedBytes += value.byteLength;
        if (receivedBytes > maximumBytes) {
          await reader.cancel().catch(() => undefined);
          return { ok: false, response: oversizedResponse() };
        }
        chunks.push(value);
      }
    }

    const body = new Uint8Array(receivedBytes);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return {
      ok: true,
      value: JSON.parse(new TextDecoder().decode(body)) as unknown,
    };
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
  if (error instanceof SchemaError) {
    return Response.json(
      { error: { code: error.code, message: error.message } },
      { status: 503 },
    );
  }
  return storageErrorResponse(error) ?? internalErrorResponse(route);
}
