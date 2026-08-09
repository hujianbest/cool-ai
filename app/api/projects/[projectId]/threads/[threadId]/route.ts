import { join } from "node:path";

import { collaborationErrorResponse } from "@/app/api/_shared/collaboration/collaboration-api";
import { threadService, turnOrchestrator } from "@/src/composition";
import { CollaborationError } from "@/src/modules/public-collaboration";

type RouteContext = {
  params: Promise<{ projectId: string; threadId: string }>;
};

const RESOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$/;

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
