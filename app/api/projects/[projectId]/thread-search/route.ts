import { join } from "node:path";

import {
  internalErrorResponse,
  storageErrorResponse,
} from "@/app/api/_shared/api-errors";
import { SchemaError, threadSearchQueries } from "@/src/composition";
import { OperationsProjectionError } from "@/src/modules/operations-projection";

type RouteContext = {
  params: Promise<{ projectId: string }>;
};

type FieldError = { code: string; field: string };

const RESOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$/;
const DECIMAL_INTEGER = /^(0|[1-9][0-9]*)$/;
const CURSOR_CHARSET = /^[A-Za-z0-9_-]+$/;
const QUERY_MAX_GRAPHEMES = 200;
const CURSOR_MAX_LENGTH = 200;
const LIMIT_MAX = 50;
const NO_STORE = { "cache-control": "no-store" };

const segmenter = new Intl.Segmenter("zh-CN", { granularity: "grapheme" });

function databasePath(): string {
  return process.env.COCKPIT_DB_PATH ?? join(process.cwd(), ".data", "cockpit.sqlite");
}

function invalidInput(fields: FieldError[]): Response {
  return Response.json(
    {
      error: {
        code: "INVALID_INPUT",
        fields,
        message: "Thread search query is invalid.",
      },
    },
    { headers: NO_STORE, status: 400 },
  );
}

function parseProjectId(value: string): string | Response {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return invalidInput([{ code: "invalid_format", field: "projectId" }]);
  }
  if (
    decoded === "."
    || decoded === ".."
    || decoded.includes("/")
    || decoded.includes("\\")
    || decoded.includes("\0")
    || !RESOURCE_ID.test(decoded)
  ) {
    return invalidInput([{ code: "invalid_format", field: "projectId" }]);
  }
  return decoded;
}

function parseThreadSearchQuery(
  request: Request,
): { before?: string; limit?: number; query: string } | { response: Response } {
  const url = new URL(request.url);
  const fields: FieldError[] = [];
  if (url.hash) fields.push({ code: "unknown", field: "fragment" });
  for (const key of new Set(url.searchParams.keys())) {
    if (key !== "q" && key !== "limit" && key !== "before") {
      fields.push({ code: "unknown", field: key });
    }
  }
  const qValues = url.searchParams.getAll("q");
  const limitValues = url.searchParams.getAll("limit");
  const beforeValues = url.searchParams.getAll("before");
  if (qValues.length > 1) fields.push({ code: "duplicate", field: "q" });
  if (limitValues.length > 1) fields.push({ code: "duplicate", field: "limit" });
  if (beforeValues.length > 1) fields.push({ code: "duplicate", field: "before" });

  let query: string | undefined;
  const rawQuery = qValues[0];
  if (rawQuery === undefined || rawQuery.trim().length === 0) {
    fields.push({ code: "required", field: "q" });
  } else if (
    Array.from(segmenter.segment(rawQuery.trim())).length > QUERY_MAX_GRAPHEMES
  ) {
    fields.push({ code: "too_long", field: "q" });
  } else {
    query = rawQuery;
  }

  let limit: number | undefined;
  const rawLimit = limitValues[0];
  if (rawLimit !== undefined) {
    if (rawLimit.length === 0) {
      fields.push({ code: "required", field: "limit" });
    } else if (!DECIMAL_INTEGER.test(rawLimit)) {
      fields.push({ code: "invalid_format", field: "limit" });
    } else {
      const parsed = Number(rawLimit);
      if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > LIMIT_MAX) {
        fields.push({ code: "invalid_range", field: "limit" });
      } else {
        limit = parsed;
      }
    }
  }

  let before: string | undefined;
  const rawBefore = beforeValues[0];
  if (rawBefore !== undefined) {
    if (rawBefore.length === 0) {
      fields.push({ code: "required", field: "before" });
    } else if (rawBefore.length > CURSOR_MAX_LENGTH || !CURSOR_CHARSET.test(rawBefore)) {
      fields.push({ code: "invalid_format", field: "before" });
    } else {
      before = rawBefore;
    }
  }

  if (fields.length > 0) return { response: invalidInput(fields) };
  if (query === undefined) {
    // Unreachable: a missing/empty q always pushes a field error above.
    return { response: invalidInput([{ code: "required", field: "q" }]) };
  }
  return {
    query,
    ...(before === undefined ? {} : { before }),
    ...(limit === undefined ? {} : { limit }),
  };
}

function threadSearchErrorResponse(error: unknown, route: string): Response {
  if (error instanceof OperationsProjectionError) {
    const status =
      error.code === "PROJECT_NOT_FOUND"
        ? 404
        : error.code === "PROJECTION_REBUILD_IN_PROGRESS"
          ? 409
          : error.code === "INVALID_INPUT"
            ? 400
            : 500;
    return Response.json(
      { error: { code: error.code, message: error.message } },
      { headers: NO_STORE, status },
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

export async function GET(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const projectId = parseProjectId((await context.params).projectId);
    if (projectId instanceof Response) return projectId;
    const query = parseThreadSearchQuery(request);
    if ("response" in query) return query.response;
    const page = threadSearchQueries.searchProjectThreads(
      databasePath(),
      projectId,
      query,
    );
    return Response.json(page, { headers: NO_STORE });
  } catch (error) {
    return threadSearchErrorResponse(
      error,
      "GET /api/projects/:projectId/thread-search",
    );
  }
}
