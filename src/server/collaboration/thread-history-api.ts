import { join } from "node:path";

import { collaborationErrorResponse } from "@/src/server/collaboration/collaboration-api";
import { CollaborationError } from "@/src/modules/public-collaboration";
import {
  readThreadFacts,
  readThreadMessages,
} from "@/src/adapters/outbound/sqlite/public-collaboration/thread-service";

type RouteContext = {
  params: Promise<{ projectId: string; threadId: string }>;
};

type HistoryKind = "messages" | "facts";

const RESOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$/;
const DECIMAL_INTEGER = /^(0|[1-9][0-9]*)$/;

function databasePath(): string {
  return process.env.COCKPIT_DB_PATH ?? join(process.cwd(), ".data", "cockpit.sqlite");
}

function invalidInput(fields: Record<string, string>): never {
  throw new CollaborationError(
    "INVALID_INPUT",
    400,
    "Thread history input is invalid.",
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

function parseInteger(
  values: string[],
  field: "after" | "limit",
  minimum: number,
  maximum: number,
  fallback: number,
  fields: Record<string, string>,
): number {
  if (values.length === 0) return fallback;
  if (values.length !== 1) {
    fields[field] = "duplicate";
    return fallback;
  }
  const value = values[0]!;
  if (!DECIMAL_INTEGER.test(value)) {
    fields[field] = value === "" ? "required" : "invalid_format";
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    fields[field] = "invalid_range";
    return fallback;
  }
  return parsed;
}

function parseQuery(url: URL): { after: number; limit: number } {
  const fields: Record<string, string> = {};
  if (url.hash) fields.fragment = "unknown";
  for (const key of new Set(url.searchParams.keys())) {
    if (key !== "after" && key !== "limit") fields[key] = "unknown";
  }
  const after = parseInteger(
    url.searchParams.getAll("after"),
    "after",
    0,
    Number.MAX_SAFE_INTEGER,
    0,
    fields,
  );
  const limit = parseInteger(
    url.searchParams.getAll("limit"),
    "limit",
    1,
    200,
    50,
    fields,
  );
  if (Object.keys(fields).length > 0) invalidInput(fields);
  return { after, limit };
}

export async function threadHistoryGet(
  kind: HistoryKind,
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const params = await context.params;
    const projectId = parsePathId(params.projectId, "projectId");
    const threadId = parsePathId(params.threadId, "threadId");
    const query = parseQuery(new URL(request.url));
    const result = kind === "messages"
      ? readThreadMessages(databasePath(), projectId, threadId, query)
      : readThreadFacts(databasePath(), projectId, threadId, query);
    return Response.json(result.body, { status: result.status });
  } catch (error) {
    return collaborationErrorResponse(
      error,
      `GET /api/projects/:projectId/threads/:threadId/${kind}`,
    );
  }
}
