import { join } from "node:path";
import { TextDecoder } from "node:util";

import {
  internalErrorResponse,
  storageErrorResponse,
} from "@/app/api/_shared/api-errors";
import { SchemaError, threadTagService } from "@/src/composition";
import { CollaborationError } from "@/src/modules/public-collaboration";

type RouteContext = {
  params: Promise<{ projectId: string }>;
};

const RESOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$/;
const DECIMAL_INTEGER = /^(0|[1-9][0-9]*)$/;
const MAX_BODY_BYTES = 65_536;
const NO_STORE = { "cache-control": "no-store" };

function databasePath(): string {
  return process.env.COCKPIT_DB_PATH ?? join(process.cwd(), ".data", "cockpit.sqlite");
}

function invalidInput(fields: Record<string, string>): never {
  throw new CollaborationError(
    "INVALID_INPUT",
    400,
    "Thread tag input is invalid.",
    { fields },
  );
}

function parseProjectId(value: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return invalidInput({ projectId: "invalid_format" });
  }
  if (
    decoded === "."
    || decoded === ".."
    || decoded.includes("/")
    || decoded.includes("\\")
    || decoded.includes("\0")
    || !RESOURCE_ID.test(decoded)
  ) {
    return invalidInput({ projectId: "invalid_format" });
  }
  return decoded;
}

function requireNoUrlSuffix(request: Request): void {
  const url = new URL(request.url);
  const fields: Record<string, string> = {};
  if (url.hash) fields.fragment = "unknown";
  for (const key of new Set(url.searchParams.keys())) fields[key] = "unknown";
  if (Object.keys(fields).length > 0) invalidInput(fields);
}

async function readStrictJson(request: Request): Promise<unknown> {
  const mediaType = request.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (mediaType !== "application/json") {
    throw new CollaborationError(
      "UNSUPPORTED_MEDIA_TYPE",
      415,
      "Content-Type must be application/json.",
    );
  }
  const declaredLength = request.headers.get("content-length");
  if (
    declaredLength !== null
    && (!DECIMAL_INTEGER.test(declaredLength)
      || Number(declaredLength) > MAX_BODY_BYTES)
  ) {
    throw new CollaborationError(
      "BODY_TOO_LARGE",
      413,
      "Request body is too large.",
    );
  }

  const chunks: Uint8Array[] = [];
  let length = 0;
  const reader = request.body?.getReader();
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new CollaborationError(
          "BODY_TOO_LARGE",
          413,
          "Request body is too large.",
        );
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new CollaborationError(
      "INVALID_JSON",
      400,
      "Request body must be valid JSON.",
    );
  }
}

function threadTagErrorResponse(error: unknown, route: string): Response {
  if (error instanceof CollaborationError) {
    return Response.json(
      {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ? { fields: error.details.fields } : {}),
        },
      },
      { headers: NO_STORE, status: error.httpStatus },
    );
  }
  if (error instanceof SchemaError) {
    return Response.json(
      { error: { code: error.code, message: error.message } },
      { headers: NO_STORE, status: 503 },
    );
  }
  return storageErrorResponse(error) ?? internalErrorResponse(route);
}

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const projectId = parseProjectId((await context.params).projectId);
    requireNoUrlSuffix(request);
    const result = threadTagService.applyThreadTagBatch(
      databasePath(),
      projectId,
      await readStrictJson(request),
    );
    return Response.json(result.body, { headers: NO_STORE, status: result.status });
  } catch (error) {
    return threadTagErrorResponse(
      error,
      "POST /api/projects/:projectId/thread-tag-batch",
    );
  }
}
