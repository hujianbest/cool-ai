import { join } from "node:path";

import {
  internalErrorResponse,
  storageErrorResponse,
} from "@/app/api/_shared/api-errors";
import { workspaceBrowseService } from "@/src/composition";
import { windowsVerifiedExecution } from "@/src/composition/execution-host";
import { WorkspaceError } from "@/src/modules/project-workspace";

type RouteContext = {
  params: Promise<{ projectId: string }>;
};

type FieldError = { code: string; field: string };

const PATH_LIMIT = 4096;
const NO_STORE = { "cache-control": "no-store" };

function databasePath(): string {
  return process.env.COCKPIT_DB_PATH ?? join(process.cwd(), ".data", "cockpit.sqlite");
}

function workspaceBrowseErrorResponse(error: WorkspaceError): Response {
  const status =
    error.code === "PROJECT_NOT_FOUND"
    || error.code === "WORKSPACE_NOT_BOUND"
    || error.code === "WORKSPACE_ENTRY_NOT_FOUND"
      ? 404
      : error.code === "WORKSPACE_FILE_TOO_LARGE"
        ? 413
        : error.code === "WORKSPACE_BROWSE_UNAVAILABLE"
          ? 503
          : error.code === "WORKSPACE_PATH_REJECTED"
            ? 422
            : 400;
  return Response.json(
    {
      error: {
        code: error.code,
        ...(error.fields ? { fields: error.fields } : {}),
        message: error.message,
      },
    },
    { headers: NO_STORE, status },
  );
}

function invalidInput(fields: FieldError[]): Response {
  return Response.json(
    {
      error: {
        code: "INVALID_INPUT",
        fields,
        message: "Workspace browse input is invalid.",
      },
    },
    { headers: NO_STORE, status: 400 },
  );
}

function parseBrowsePath(request: Request): { path: string } | { response: Response } {
  const url = new URL(request.url);
  const fields: FieldError[] = [];
  if (url.hash) fields.push({ code: "unknown", field: "fragment" });
  const paths: string[] = [];
  for (const [key, value] of url.searchParams.entries()) {
    if (key !== "path") fields.push({ code: "unknown", field: key });
    else paths.push(value);
  }
  if (paths.length === 0) {
    fields.push({ code: "required", field: "path" });
  } else if (
    paths.length > 1
    || paths[0]!.length === 0
    || paths[0]!.length > PATH_LIMIT
    || paths[0]!.includes("\0")
  ) {
    fields.push({ code: "invalid_format", field: "path" });
  }
  if (fields.length > 0) return { response: invalidInput(fields) };
  return { path: paths[0]! };
}

function browseErrorResponse(error: unknown, route: string): Response {
  if (error instanceof WorkspaceError) return workspaceBrowseErrorResponse(error);
  return storageErrorResponse(error) ?? internalErrorResponse(route);
}

export async function workspaceBrowseFilesGet(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const { projectId } = await context.params;
    const parsed = parseBrowsePath(request);
    if ("response" in parsed) return parsed.response;
    const adapters = windowsVerifiedExecution.createWindowsVerifiedExecutionAdapters();
    const listing = await workspaceBrowseService.listWorkspaceDirectory(
      databasePath(),
      projectId,
      parsed.path,
      adapters.fileAdapter,
    );
    return Response.json(listing, { headers: NO_STORE });
  } catch (error) {
    return browseErrorResponse(error, "GET /api/projects/:projectId/workspace/files");
  }
}

export async function workspaceBrowseFileGet(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const { projectId } = await context.params;
    const parsed = parseBrowsePath(request);
    if ("response" in parsed) return parsed.response;
    const adapters = windowsVerifiedExecution.createWindowsVerifiedExecutionAdapters();
    const preview = await workspaceBrowseService.readWorkspaceFilePreview(
      databasePath(),
      projectId,
      parsed.path,
      adapters.fileAdapter,
    );
    return Response.json(preview, { headers: NO_STORE });
  } catch (error) {
    return browseErrorResponse(error, "GET /api/projects/:projectId/workspace/file");
  }
}
