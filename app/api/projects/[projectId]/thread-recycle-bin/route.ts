import { join } from "node:path";

import {
  internalErrorResponse,
  storageErrorResponse,
} from "@/app/api/_shared/api-errors";
import { SchemaError, threadLifecycleService } from "@/src/composition";
import {
  collaborationErrorBody,
  CollaborationError,
} from "@/src/modules/public-collaboration";

type RouteContext = {
  params: Promise<{ projectId: string }>;
};

const RESOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$/;
const DECIMAL_INTEGER = /^(0|[1-9][0-9]*)$/;
const LIMIT_MAX = 100;
const NO_STORE = { "cache-control": "no-store" };

function databasePath(): string {
  return process.env.COCKPIT_DB_PATH ?? join(process.cwd(), ".data", "cockpit.sqlite");
}

function invalidInput(fields: Record<string, string>): never {
  throw new CollaborationError(
    "INVALID_INPUT",
    400,
    "Thread recycle bin input is invalid.",
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

// Query whitelist is exactly {cursor, limit}, each single-valued (032 A-191
// no-store + thread-tag-batch static-segment precedent); the cursor stays
// opaque here — its encoding is validated by the service seam.
function parseListQuery(request: Request): { cursor?: string; limit?: number } {
  const url = new URL(request.url);
  const fields: Record<string, string> = {};
  if (url.hash) fields.fragment = "unknown";
  for (const key of new Set(url.searchParams.keys())) {
    if (key !== "cursor" && key !== "limit") fields[key] = "unknown";
  }
  const cursorValues = url.searchParams.getAll("cursor");
  const limitValues = url.searchParams.getAll("limit");
  if (cursorValues.length > 1) fields.cursor = "duplicate";
  if (limitValues.length > 1) fields.limit = "duplicate";

  let cursor: string | undefined;
  const rawCursor = cursorValues[0];
  if (rawCursor !== undefined && cursorValues.length === 1) {
    if (rawCursor.length === 0) fields.cursor = "required";
    else cursor = rawCursor;
  }

  let limit: number | undefined;
  const rawLimit = limitValues[0];
  if (rawLimit !== undefined && limitValues.length === 1) {
    if (rawLimit.length === 0) {
      fields.limit = "required";
    } else if (!DECIMAL_INTEGER.test(rawLimit)) {
      fields.limit = "invalid_format";
    } else {
      const parsed = Number(rawLimit);
      if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > LIMIT_MAX) {
        fields.limit = "invalid_range";
      } else {
        limit = parsed;
      }
    }
  }

  if (Object.keys(fields).length > 0) invalidInput(fields);
  return {
    ...(cursor === undefined ? {} : { cursor }),
    ...(limit === undefined ? {} : { limit }),
  };
}

function recycleBinErrorResponse(error: unknown, route: string): Response {
  if (error instanceof CollaborationError) {
    return Response.json(collaborationErrorBody(error), {
      headers: NO_STORE,
      status: error.httpStatus,
    });
  }
  if (error instanceof SchemaError) {
    return Response.json(
      { error: { code: error.code, message: error.message } },
      { headers: NO_STORE, status: 503 },
    );
  }
  return storageErrorResponse(error) ?? internalErrorResponse(route);
}

export async function GET(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const projectId = parseProjectId((await context.params).projectId);
    const result = threadLifecycleService.listDeletedThreads(
      databasePath(),
      projectId,
      parseListQuery(request),
    );
    return Response.json(result.body, {
      headers: NO_STORE,
      status: result.status,
    });
  } catch (error) {
    return recycleBinErrorResponse(
      error,
      "GET /api/projects/:projectId/thread-recycle-bin",
    );
  }
}
