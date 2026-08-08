import { join } from "node:path";
import { TextDecoder } from "node:util";

import { collaborationErrorResponse } from "@/src/server/collaboration/collaboration-api";
import { CollaborationError } from "@/src/server/collaboration/collaboration-errors";
import { controlThreadRun } from "@/src/server/collaboration/run-service";

type RouteContext = {
  params: Promise<{ projectId: string; threadId: string; runId: string }>;
};

const RESOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$/;
const BODY_LIMIT = 65_536;

function databasePath(): string {
  return process.env.COCKPIT_DB_PATH ?? join(process.cwd(), ".data", "cockpit.sqlite");
}

function invalidInput(fields: Record<string, string>): never {
  throw new CollaborationError(
    "INVALID_INPUT",
    400,
    "Run control input is invalid.",
    { fields },
  );
}

function parsePathId(value: string, field: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return invalidInput({ [field]: "invalid_format" });
  }
  if (
    decoded === "."
    || decoded === ".."
    || decoded.includes("/")
    || decoded.includes("\\")
    || decoded.includes("\0")
    || !RESOURCE_ID.test(decoded)
  ) {
    return invalidInput({ [field]: "invalid_format" });
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
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
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
    && (!/^(0|[1-9][0-9]*)$/.test(declaredLength) || Number(declaredLength) > BODY_LIMIT)
  ) {
    throw new CollaborationError("BODY_TOO_LARGE", 413, "Request body is too large.");
  }
  const chunks: Uint8Array[] = [];
  let length = 0;
  const reader = request.body?.getReader();
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > BODY_LIMIT) {
        await reader.cancel();
        throw new CollaborationError("BODY_TOO_LARGE", 413, "Request body is too large.");
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

export async function threadRunControlPost(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const params = await context.params;
    const projectId = parsePathId(params.projectId, "projectId");
    const threadId = parsePathId(params.threadId, "threadId");
    const runId = parsePathId(params.runId, "runId");
    requireNoUrlSuffix(request);
    const input = await readStrictJson(request);
    const result = controlThreadRun(
      databasePath(),
      projectId,
      threadId,
      runId,
      input,
    );
    return Response.json(result.body, { status: result.status });
  } catch (error) {
    return collaborationErrorResponse(
      error,
      "POST /api/projects/:projectId/threads/:threadId/runs/:runId/control",
    );
  }
}
