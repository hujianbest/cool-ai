import { join } from "node:path";
import { TextDecoder } from "node:util";

import {
  internalErrorResponse,
  storageErrorResponse,
} from "@/app/api/_shared/api-errors";
import { memoryIndexRebuild, SchemaError } from "@/src/composition";
import { OperationsProjectionError } from "@/src/modules/operations-projection";

type RouteContext = { params: Promise<{ projectId: string }> };

const BODY_LIMIT = 65_536;
const DECIMAL_INTEGER = /^(0|[1-9][0-9]*)$/;
const NO_STORE = { "cache-control": "no-store" };
const RESOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function databasePath(): string {
  return process.env.COCKPIT_DB_PATH ?? join(process.cwd(), ".data", "cockpit.sqlite");
}

function failure(code: string, message: string, status: number): Response {
  return Response.json({ error: { code, message } }, { headers: NO_STORE, status });
}

function invalidInput(): never {
  throw new OperationsProjectionError("INVALID_INPUT", "Memory index rebuild input is invalid.");
}

function parseProjectId(value: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return invalidInput();
  }
  if (
    decoded === "."
    || decoded === ".."
    || decoded.includes("/")
    || decoded.includes("\\")
    || decoded.includes("\0")
    || !RESOURCE_ID.test(decoded)
  ) {
    return invalidInput();
  }
  return decoded;
}

async function readBody(request: Request): Promise<unknown> {
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    throw new OperationsProjectionError("INVALID_INPUT", "Content-Type must be application/json.");
  }
  const declared = request.headers.get("content-length");
  if (
    declared !== null
    && (!DECIMAL_INTEGER.test(declared) || Number(declared) > BODY_LIMIT)
  ) {
    throw new OperationsProjectionError("INVALID_INPUT", "Request body is too large.");
  }
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > BODY_LIMIT) {
        await reader.cancel();
        throw new OperationsProjectionError("INVALID_INPUT", "Request body is too large.");
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
    throw new OperationsProjectionError("INVALID_INPUT", "Request body must be valid JSON.");
  }
}

function parseInput(value: unknown): {
  confirmation: string;
  expectedVersion: number;
  operationId: string;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalidInput();
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).length !== 3
    || typeof input.confirmation !== "string"
    || !Number.isSafeInteger(input.expectedVersion)
    || Number(input.expectedVersion) < 1
    || typeof input.operationId !== "string"
    || !UUID.test(input.operationId)
  ) {
    invalidInput();
  }
  return {
    confirmation: input.confirmation,
    expectedVersion: Number(input.expectedVersion),
    operationId: input.operationId,
  };
}

function withNoStore(response: Response): Response {
  response.headers.set("cache-control", "no-store");
  return response;
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  try {
    const url = new URL(request.url);
    if (url.hash || Array.from(url.searchParams.keys()).length > 0) invalidInput();
    const projectId = parseProjectId((await context.params).projectId);
    const result = memoryIndexRebuild.rebuildMemorySearchIndex(
      databasePath(),
      projectId,
      parseInput(await readBody(request)),
    );
    return Response.json(result, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof OperationsProjectionError) {
      const status =
        error.code === "PROJECT_NOT_FOUND"
          ? 404
          : error.code === "INVALID_INPUT"
            || error.code === "MEMORY_INDEX_CONFIRMATION_REQUIRED"
            ? 400
            : error.code === "MEMORY_INDEX_VERSION_CONFLICT"
              || error.code === "MEMORY_INDEX_OPERATION_CONFLICT"
              || error.code === "PROJECTION_REBUILD_IN_PROGRESS"
              ? 409
              : 500;
      return failure(error.code, error.message, status);
    }
    if (error instanceof SchemaError) return failure(error.code, error.message, 503);
    return withNoStore(
      storageErrorResponse(error)
      ?? internalErrorResponse("POST /api/projects/:projectId/memory-index/rebuild"),
    );
  }
}
