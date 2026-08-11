import { join } from "node:path";

import {
  internalErrorResponse,
  storageErrorResponse,
} from "@/app/api/_shared/api-errors";
import { collaborationErrorResponse } from "@/app/api/_shared/collaboration/collaboration-api";
import {
  SchemaError,
  threadLifecycleService,
  threadService,
  turnOrchestrator,
} from "@/src/composition";
import {
  collaborationErrorBody,
  CollaborationError,
} from "@/src/modules/public-collaboration";

type RouteContext = {
  params: Promise<{ projectId: string; threadId: string }>;
};

const RESOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$/;
const NO_STORE = { "cache-control": "no-store" };

function databasePath(): string {
  return process.env.COCKPIT_DB_PATH ?? join(process.cwd(), ".data", "cockpit.sqlite");
}

function invalidInput(fields: Record<string, string>): never {
  throw new CollaborationError(
    "INVALID_INPUT",
    400,
    "Thread detail input is invalid.",
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

function parseQuery(url: URL): string | null {
  const fields: Record<string, string> = {};
  if (url.hash) fields.fragment = "unknown";
  for (const key of new Set(url.searchParams.keys())) {
    if (key !== "run") fields[key] = "unknown";
  }
  const runs = url.searchParams.getAll("run");
  if (runs.length > 1) fields.run = "duplicate";
  if (runs.length === 1 && !RESOURCE_ID.test(runs[0]!)) {
    fields.run = runs[0] === "" ? "required" : "invalid_format";
  }
  if (Object.keys(fields).length > 0) invalidInput(fields);
  return runs[0] ?? null;
}

function requireNoUrlSuffix(request: Request): void {
  const url = new URL(request.url);
  const fields: Record<string, string> = {};
  if (url.hash) fields.fragment = "unknown";
  for (const key of new Set(url.searchParams.keys())) fields[key] = "unknown";
  if (Object.keys(fields).length > 0) invalidInput(fields);
}

function threadLifecycleErrorResponse(error: unknown, route: string): Response {
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
    const params = await context.params;
    const projectId = parsePathId(params.projectId, "projectId");
    const threadId = parsePathId(params.threadId, "threadId");
    const selectedRunId = parseQuery(new URL(request.url));
    if (selectedRunId !== null) {
      turnOrchestrator.reconcileExpiredAttempt(databasePath(), {
        projectId,
        runId: selectedRunId,
        threadId,
      });
    }
    const result = threadService.readThreadDetail(
      databasePath(),
      projectId,
      threadId,
      selectedRunId,
    );
    return Response.json(result.body, { status: result.status });
  } catch (error) {
    return collaborationErrorResponse(
      error,
      "GET /api/projects/:projectId/threads/:threadId",
    );
  }
}

// The soft-delete command takes no body: any bytes are ignored (thread-draft
// DELETE precedent) while the URL stays strictly validated.
export async function DELETE(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const params = await context.params;
    const projectId = parsePathId(params.projectId, "projectId");
    const threadId = parsePathId(params.threadId, "threadId");
    requireNoUrlSuffix(request);
    const result = threadLifecycleService.deleteThread(
      databasePath(),
      projectId,
      threadId,
    );
    return Response.json(result.body, {
      headers: NO_STORE,
      status: result.status,
    });
  } catch (error) {
    return threadLifecycleErrorResponse(
      error,
      "DELETE /api/projects/:projectId/threads/:threadId",
    );
  }
}
