import { join } from "node:path";

import {
  internalErrorResponse,
  storageErrorResponse,
} from "@/app/api/_shared/api-errors";
import { SchemaError, threadTagService } from "@/src/composition";
import { CollaborationError } from "@/src/modules/public-collaboration";

type RouteContext = {
  params: Promise<{ projectId: string; tagId: string }>;
};

const RESOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$/;
const NO_STORE = { "cache-control": "no-store" };

function databasePath(): string {
  return process.env.COCKPIT_DB_PATH ?? join(process.cwd(), ".data", "cockpit.sqlite");
}

function invalidInput(fields: Record<string, string>): Response {
  return Response.json(
    {
      error: {
        code: "INVALID_INPUT",
        fields,
        message: "Thread tag input is invalid.",
      },
    },
    { headers: NO_STORE, status: 400 },
  );
}

function parsePathId(field: string, value: string): string | Response {
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

function threadTagErrorResponse(error: unknown, route: string): Response {
  if (error instanceof CollaborationError) {
    return Response.json(
      { error: { code: error.code, message: error.message } },
      { headers: NO_STORE, status: error.httpStatus },
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

export async function DELETE(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const params = await context.params;
    const projectId = parsePathId("projectId", params.projectId);
    if (projectId instanceof Response) return projectId;
    const tagId = parsePathId("tagId", params.tagId);
    if (tagId instanceof Response) return tagId;
    const url = new URL(request.url);
    if (url.search || url.hash) {
      return invalidInput({ url: "unexpected_suffix" });
    }
    const result = threadTagService.deleteThreadTag(databasePath(), projectId, tagId);
    return Response.json(result.body, { headers: NO_STORE, status: result.status });
  } catch (error) {
    return threadTagErrorResponse(
      error,
      "DELETE /api/projects/:projectId/thread-tags/:tagId",
    );
  }
}
