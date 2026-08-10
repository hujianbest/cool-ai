import { dirname, isAbsolute, join } from "node:path";

import { collaborationErrorResponse } from "@/app/api/_shared/collaboration/collaboration-api";
import { attachmentService } from "@/src/composition";
import { CollaborationError } from "@/src/modules/public-collaboration";

type RouteContext = {
  params: Promise<{ projectId: string; threadId: string }>;
};

type ItemRouteContext = {
  params: Promise<{ attachmentId: string; projectId: string; threadId: string }>;
};

const RESOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$/;
const BODY_LIMIT = attachmentService.ATTACHMENT_MAX_BYTES;

function databasePath(): string {
  return process.env.COCKPIT_DB_PATH ?? join(process.cwd(), ".data", "cockpit.sqlite");
}

// Attachment bytes live beside the database file under `.data/attachments/`.
// Tests and operators can point the root elsewhere with an absolute
// COCKPIT_ATTACHMENTS_ROOT; anything else fails closed.
function attachmentsRootFor(dbPath: string): string {
  const override = process.env.COCKPIT_ATTACHMENTS_ROOT;
  if (override !== undefined && override !== "") {
    if (!isAbsolute(override)) {
      throw new CollaborationError(
        "STORAGE_UNAVAILABLE",
        503,
        "Attachment storage is unavailable.",
      );
    }
    return override;
  }
  if (dbPath === ":memory:" || dbPath.startsWith("file:")) {
    throw new CollaborationError(
      "STORAGE_UNAVAILABLE",
      503,
      "Attachment storage is unavailable.",
    );
  }
  return join(dirname(dbPath), "attachments");
}

function invalidInput(fields: Record<string, string>): never {
  throw new CollaborationError(
    "INVALID_INPUT",
    400,
    "Attachment input is invalid.",
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

// The file name travels in the `name` query parameter: it is the only query
// key allowed, and percent-decoding keeps non-ASCII names intact (a header
// would be limited to latin-1). Content is validated server-side regardless.
function parseUploadName(request: Request): string {
  const url = new URL(request.url);
  const fields: Record<string, string> = {};
  if (url.hash) fields.fragment = "unknown";
  const names: string[] = [];
  for (const [key, value] of url.searchParams.entries()) {
    if (key !== "name") fields[key] = "unknown";
    else names.push(value);
  }
  if (names.length === 0) fields.name = "required";
  else if (names.length > 1) fields.name = "invalid_format";
  if (Object.keys(fields).length > 0) invalidInput(fields);
  return names[0]!;
}

function requireImageContentType(request: Request): void {
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  // Transport-level convergence only; the magic bytes are the sole type fact.
  if (mediaType === undefined || !mediaType.startsWith("image/")) {
    throw new CollaborationError(
      "UNSUPPORTED_MEDIA_TYPE",
      415,
      "Content-Type must be an image media type.",
    );
  }
}

async function readBinaryBody(request: Request): Promise<Uint8Array> {
  const declaredLength = request.headers.get("content-length");
  if (
    declaredLength !== null
    && (/^(0|[1-9][0-9]*)$/.test(declaredLength) === false
      || Number(declaredLength) > BODY_LIMIT)
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
  return bytes;
}

function requireNoUrlSuffix(request: Request): void {
  const url = new URL(request.url);
  const fields: Record<string, string> = {};
  if (url.hash) fields.fragment = "unknown";
  for (const key of new Set(url.searchParams.keys())) fields[key] = "unknown";
  if (Object.keys(fields).length > 0) invalidInput(fields);
}

export async function threadAttachmentPost(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const params = await context.params;
    const projectId = parsePathId(params.projectId, "projectId");
    const threadId = parsePathId(params.threadId, "threadId");
    const fileName = parseUploadName(request);
    requireImageContentType(request);
    const bytes = await readBinaryBody(request);
    const dbPath = databasePath();
    const result = attachmentService.uploadAttachment(
      dbPath,
      attachmentsRootFor(dbPath),
      projectId,
      threadId,
      { bytes, fileName },
    );
    return Response.json(result.body, { status: result.status });
  } catch (error) {
    return collaborationErrorResponse(
      error,
      "POST /api/projects/:projectId/threads/:threadId/attachments",
    );
  }
}

// Linked bytes are immutable (content is hash-pinned and re-linking is
// impossible), so private+immutable caching is safe; the stored magic-derived
// mime type is the only Content-Type source and nosniff pins it.
export async function threadAttachmentContentGet(
  request: Request,
  context: ItemRouteContext,
): Promise<Response> {
  try {
    const params = await context.params;
    const projectId = parsePathId(params.projectId, "projectId");
    const threadId = parsePathId(params.threadId, "threadId");
    const attachmentId = parsePathId(params.attachmentId, "attachmentId");
    requireNoUrlSuffix(request);
    const dbPath = databasePath();
    const content = attachmentService.readAttachmentContent(
      dbPath,
      attachmentsRootFor(dbPath),
      projectId,
      threadId,
      attachmentId,
    );
    return new Response(content.bytes, {
      headers: {
        "cache-control": "private, immutable",
        "content-type": content.mimeType,
        "x-content-type-options": "nosniff",
      },
      status: 200,
    });
  } catch (error) {
    return collaborationErrorResponse(
      error,
      "GET /api/projects/:projectId/threads/:threadId/attachments/:attachmentId/content",
    );
  }
}

export async function threadAttachmentDelete(
  request: Request,
  context: ItemRouteContext,
): Promise<Response> {
  try {
    const params = await context.params;
    const projectId = parsePathId(params.projectId, "projectId");
    const threadId = parsePathId(params.threadId, "threadId");
    const attachmentId = parsePathId(params.attachmentId, "attachmentId");
    requireNoUrlSuffix(request);
    const dbPath = databasePath();
    const result = attachmentService.removeAttachment(
      dbPath,
      attachmentsRootFor(dbPath),
      projectId,
      threadId,
      attachmentId,
    );
    return Response.json(result.body, { status: result.status });
  } catch (error) {
    return collaborationErrorResponse(
      error,
      "DELETE /api/projects/:projectId/threads/:threadId/attachments/:attachmentId",
    );
  }
}
