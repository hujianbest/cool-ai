import { join } from "node:path";

import {
  internalErrorResponse,
  storageErrorResponse,
} from "@/app/api/_shared/api-errors";
import { SchemaError, contributionInsight } from "@/src/composition";
import { OperationsProjectionError } from "@/src/modules/operations-projection";

const NO_STORE = { "cache-control": "no-store" };
const RESOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$/;

function databasePath(): string {
  return process.env.COCKPIT_DB_PATH ?? join(process.cwd(), ".data", "cockpit.sqlite");
}

function errorResponse(code: string, message: string, status: number): Response {
  return Response.json(
    { error: { code, message } },
    { headers: NO_STORE, status },
  );
}

function parseProjectId(value: string | null): string | undefined | Response {
  if (value === null) return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return errorResponse("INVALID_INPUT", "Contribution request is invalid.", 400);
  }
  if (
    decoded === "."
    || decoded === ".."
    || decoded.includes("/")
    || decoded.includes("\\")
    || decoded.includes("\0")
    || !RESOURCE_ID.test(decoded)
  ) {
    return errorResponse("INVALID_INPUT", "Contribution request is invalid.", 400);
  }
  return decoded;
}

function withNoStore(response: Response): Response {
  response.headers.set("cache-control", "no-store");
  return response;
}

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    if (url.hash) {
      return errorResponse("INVALID_INPUT", "Contribution request is invalid.", 400);
    }
    const keys = Array.from(url.searchParams.keys());
    if (keys.some((key) => key !== "projectId") || keys.length > 1) {
      return errorResponse("INVALID_INPUT", "Contribution request is invalid.", 400);
    }
    const projectId = parseProjectId(url.searchParams.get("projectId"));
    if (projectId instanceof Response) return projectId;
    return Response.json(
      contributionInsight.getContributionInsight(databasePath(), projectId),
      { headers: NO_STORE },
    );
  } catch (error) {
    if (error instanceof OperationsProjectionError) {
      const status =
        error.code === "PROJECT_NOT_FOUND"
          ? 404
          : error.code === "INVALID_INPUT"
            ? 400
            : 500;
      return errorResponse(error.code, error.message, status);
    }
    if (error instanceof SchemaError) {
      return errorResponse(error.code, error.message, 503);
    }
    return withNoStore(
      storageErrorResponse(error) ?? internalErrorResponse("GET /api/contribution"),
    );
  }
}
