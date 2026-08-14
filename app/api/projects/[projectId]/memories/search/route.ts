import { join } from "node:path";

import { memoryApiError } from "@/app/api/_shared/memory-api";
import { memoryService } from "@/src/composition";
import { MemoryError } from "@/src/modules/knowledge-provenance";
import type { SearchMemoriesOptions } from "@/src/modules/knowledge-provenance";
import {
  memorySearchResponseSchema,
  memorySourceTypeSchema,
  memoryTypeSchema,
} from "@/src/shared/memory-contracts";

type RouteContext = { params: Promise<{ projectId: string }> };
type FieldError = { code: string; field: string };

const DECIMAL_INTEGER = /^(0|[1-9][0-9]*)$/;
const QUERY_MAX_GRAPHEMES = 200;
const LIMIT_MAX = 50;
const NO_STORE = { "cache-control": "no-store" };
const ALLOWED_KEYS = new Set(["q", "type", "sourceType", "version", "limit"]);
const segmenter = new Intl.Segmenter("zh-CN", { granularity: "grapheme" });

function databasePath(): string {
  return process.env.COCKPIT_DB_PATH ?? join(process.cwd(), ".data", "cockpit.sqlite");
}

function invalidSearchQuery(fields: FieldError[]): never {
  throw new MemoryError(
    "INVALID_INPUT",
    400,
    "Memory search query is invalid.",
    fields,
  );
}

function parseMemorySearchQuery(request: Request): SearchMemoriesOptions {
  const url = new URL(request.url);
  const fields: FieldError[] = [];
  if (url.hash) fields.push({ code: "unknown", field: "fragment" });
  for (const key of new Set(url.searchParams.keys())) {
    if (!ALLOWED_KEYS.has(key)) fields.push({ code: "unknown", field: key });
  }

  const qValues = url.searchParams.getAll("q");
  const typeValues = url.searchParams.getAll("type");
  const sourceTypeValues = url.searchParams.getAll("sourceType");
  const versionValues = url.searchParams.getAll("version");
  const limitValues = url.searchParams.getAll("limit");
  if (qValues.length > 1) fields.push({ code: "duplicate", field: "q" });
  if (typeValues.length > 1) fields.push({ code: "duplicate", field: "type" });
  if (sourceTypeValues.length > 1) {
    fields.push({ code: "duplicate", field: "sourceType" });
  }
  if (versionValues.length > 1) fields.push({ code: "duplicate", field: "version" });
  if (limitValues.length > 1) fields.push({ code: "duplicate", field: "limit" });

  let query: string | undefined;
  const rawQuery = qValues[0];
  if (rawQuery === undefined || rawQuery.trim().length === 0) {
    fields.push({ code: "required", field: "q" });
  } else if (
    Array.from(segmenter.segment(rawQuery.trim())).length > QUERY_MAX_GRAPHEMES
  ) {
    fields.push({ code: "too_long", field: "q" });
  } else {
    query = rawQuery.trim();
  }

  let type: SearchMemoriesOptions["type"];
  const rawType = typeValues[0];
  if (rawType !== undefined) {
    const parsedType = memoryTypeSchema.safeParse(rawType);
    if (!parsedType.success) {
      fields.push({ code: "invalid_format", field: "type" });
    } else {
      type = parsedType.data;
    }
  }

  let sourceType: SearchMemoriesOptions["sourceType"];
  const rawSourceType = sourceTypeValues[0];
  if (rawSourceType !== undefined) {
    const parsedSource = memorySourceTypeSchema.safeParse(rawSourceType);
    if (!parsedSource.success) {
      fields.push({ code: "invalid_format", field: "sourceType" });
    } else {
      sourceType = parsedSource.data;
    }
  }

  let version: number | undefined;
  const rawVersion = versionValues[0];
  if (rawVersion !== undefined) {
    if (rawVersion.length === 0) {
      fields.push({ code: "required", field: "version" });
    } else if (!DECIMAL_INTEGER.test(rawVersion)) {
      fields.push({ code: "invalid_format", field: "version" });
    } else {
      const parsed = Number(rawVersion);
      if (!Number.isSafeInteger(parsed) || parsed < 1) {
        fields.push({ code: "invalid_range", field: "version" });
      } else {
        version = parsed;
      }
    }
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

  if (fields.length > 0) invalidSearchQuery(fields);
  if (query === undefined) {
    invalidSearchQuery([{ code: "required", field: "q" }]);
  }
  return {
    q: query,
    ...(limit === undefined ? {} : { limit }),
    ...(sourceType === undefined ? {} : { sourceType }),
    ...(type === undefined ? {} : { type }),
    ...(version === undefined ? {} : { version }),
  };
}

function withNoStore(response: Response): Response {
  response.headers.set("cache-control", "no-store");
  return response;
}

export async function GET(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const { projectId } = await context.params;
  try {
    const query = parseMemorySearchQuery(request);
    return Response.json(
      memorySearchResponseSchema.parse({
        results: memoryService.searchMemories(databasePath(), projectId, query),
      }),
      { headers: NO_STORE },
    );
  } catch (error) {
    return withNoStore(
      memoryApiError(error, "GET /api/projects/:projectId/memories/search"),
    );
  }
}
