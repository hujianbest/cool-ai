import { join } from "node:path";

import { collaborationErrorResponse } from "@/app/api/_shared/collaboration/collaboration-api";
import { inputHistoryService } from "@/src/composition";
import { CollaborationError } from "@/src/modules/public-collaboration";

type RouteContext = {
  params: Promise<{ projectId: string }>;
};

const RESOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$/;

function databasePath(): string {
  return process.env.COCKPIT_DB_PATH ?? join(process.cwd(), ".data", "cockpit.sqlite");
}

function invalidInput(fields: Record<string, string>): never {
  throw new CollaborationError(
    "INVALID_INPUT",
    400,
    "Input history input is invalid.",
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

function parseSearchQuery(request: Request): string {
  const url = new URL(request.url);
  const fields: Record<string, string> = {};
  if (url.hash) fields.fragment = "unknown";
  for (const key of new Set(url.searchParams.keys())) {
    if (key !== "query") fields[key] = "unknown";
  }
  if (url.searchParams.getAll("query").length > 1) fields.query = "invalid_format";
  if (Object.keys(fields).length > 0) invalidInput(fields);
  return url.searchParams.get("query") ?? "";
}

function requireNoUrlSuffix(request: Request): void {
  const url = new URL(request.url);
  const fields: Record<string, string> = {};
  if (url.hash) fields.fragment = "unknown";
  for (const key of new Set(url.searchParams.keys())) fields[key] = "unknown";
  if (Object.keys(fields).length > 0) invalidInput(fields);
}

export async function inputHistoryGet(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const params = await context.params;
    const projectId = parseProjectId(params.projectId);
    const query = parseSearchQuery(request);
    const result = inputHistoryService.searchInputHistory(
      databasePath(),
      projectId,
      query,
    );
    return Response.json(result.body, { status: result.status });
  } catch (error) {
    return collaborationErrorResponse(
      error,
      "GET /api/projects/:projectId/input-history",
    );
  }
}

export async function inputHistoryDelete(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const params = await context.params;
    const projectId = parseProjectId(params.projectId);
    requireNoUrlSuffix(request);
    const result = inputHistoryService.clearInputHistory(databasePath(), projectId);
    return Response.json(result.body, { status: result.status });
  } catch (error) {
    return collaborationErrorResponse(
      error,
      "DELETE /api/projects/:projectId/input-history",
    );
  }
}
