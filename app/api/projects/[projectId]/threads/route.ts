import { join } from "node:path";
import { TextDecoder } from "node:util";

import { collaborationErrorResponse } from "@/app/api/_shared/collaboration/collaboration-api";
import { threadService } from "@/src/composition";
import { CollaborationError } from "@/src/modules/public-collaboration";

type RouteContext = {
  params: Promise<{ projectId: string }>;
};

const RESOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$/;
const DECIMAL_INTEGER = /^(0|[1-9][0-9]*)$/;
const BODY_LIMIT = 65_536;

function databasePath(): string {
  return process.env.COCKPIT_DB_PATH ?? join(process.cwd(), ".data", "cockpit.sqlite");
}

function invalidInput(fields: Record<string, string>): never {
  throw new CollaborationError(
    "INVALID_INPUT",
    400,
    "Thread input is invalid.",
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

function parseListQuery(request: Request): {
  cursor?: string;
  favoritesOnly?: boolean;
  limit?: number;
  tagId?: string;
} {
  const url = new URL(request.url);
  const fields: Record<string, string> = {};
  if (url.hash) fields.fragment = "unknown";
  for (const key of new Set(url.searchParams.keys())) {
    if (key !== "cursor" && key !== "favorites" && key !== "limit" && key !== "tagId") {
      fields[key] = "unknown";
    }
  }
  const cursorValues = url.searchParams.getAll("cursor");
  const limitValues = url.searchParams.getAll("limit");
  const favoritesValues = url.searchParams.getAll("favorites");
  const tagIdValues = url.searchParams.getAll("tagId");
  if (cursorValues.length > 1) fields.cursor = "duplicate";
  if (limitValues.length > 1) fields.limit = "duplicate";
  if (favoritesValues.length > 1) fields.favorites = "duplicate";
  if (tagIdValues.length > 1) fields.tagId = "duplicate";
  const cursor = cursorValues[0];
  const rawLimit = limitValues[0];
  const rawFavorites = favoritesValues[0];
  const rawTagId = tagIdValues[0];
  if (cursor !== undefined && cursor.length === 0) fields.cursor = "required";
  if (rawLimit !== undefined && !DECIMAL_INTEGER.test(rawLimit)) {
    fields.limit = rawLimit.length === 0 ? "required" : "invalid_format";
  }
  if (
    rawFavorites !== undefined
    && rawFavorites !== "true"
    && rawFavorites !== "false"
  ) {
    fields.favorites = rawFavorites.length === 0 ? "required" : "invalid_format";
  }
  if (rawTagId !== undefined) {
    if (rawTagId.length === 0) fields.tagId = "required";
    else if (!RESOURCE_ID.test(rawTagId)) fields.tagId = "invalid_format";
  }
  const limit = rawLimit === undefined ? undefined : Number(rawLimit);
  if (
    limit !== undefined
    && (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
  ) {
    fields.limit = "invalid_range";
  }
  if (Object.keys(fields).length > 0) invalidInput(fields);
  return {
    ...(cursor === undefined ? {} : { cursor }),
    ...(rawFavorites === undefined ? {} : { favoritesOnly: rawFavorites === "true" }),
    ...(limit === undefined ? {} : { limit }),
    ...(rawTagId === undefined ? {} : { tagId: rawTagId }),
  };
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
      || Number(declaredLength) > BODY_LIMIT)
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
      if (length > BODY_LIMIT) {
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

export async function GET(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const projectId = parseProjectId((await context.params).projectId);
    const result = threadService.listThreads(databasePath(), projectId, parseListQuery(request));
    return Response.json(result.body, { status: result.status });
  } catch (error) {
    return collaborationErrorResponse(
      error,
      "GET /api/projects/:projectId/threads",
    );
  }
}

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const projectId = parseProjectId((await context.params).projectId);
    requireNoUrlSuffix(request);
    const result = threadService.createThread(databasePath(), projectId, await readStrictJson(request));
    return Response.json(result.body, { status: result.status });
  } catch (error) {
    return collaborationErrorResponse(
      error,
      "POST /api/projects/:projectId/threads",
    );
  }
}
