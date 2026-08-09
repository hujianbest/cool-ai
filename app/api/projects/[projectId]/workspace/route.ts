import { join } from "node:path";

import {
  internalErrorResponse,
  storageErrorResponse,
} from "@/src/server/api-errors";
import {
  bindWorkspace,
  getWorkspace,
} from "@/src/adapters/outbound/sqlite/project-workspace/workspace-service";
import { WorkspaceError } from "@/src/modules/project-workspace";

type RouteContext = {
  params: Promise<{ projectId: string }>;
};

type WorkspaceField = "path" | "expectedVersion" | "confirmRebind";
type FieldError = { field: WorkspaceField; code: string };

function databasePath(): string {
  return process.env.COCKPIT_DB_PATH ?? join(process.cwd(), ".data", "cockpit.sqlite");
}

function workspaceErrorResponse(error: WorkspaceError): Response {
  const status =
    error.code === "PROJECT_NOT_FOUND"
      ? 404
      : error.code === "RESOURCE_CONFLICT" ||
          error.code === "WORKSPACE_ALREADY_BOUND" ||
          error.code === "REBIND_CONFIRMATION_REQUIRED"
        ? 409
        : 400;
  return Response.json(
    {
      error: {
        code: error.code,
        ...(error.fields ? { fields: error.fields } : {}),
        message: error.message,
        ...(error.currentVersion !== undefined
          ? { currentVersion: error.currentVersion }
          : {}),
      },
    },
    { status },
  );
}

function workspaceInputFields(body: unknown): FieldError[] {
  const candidate =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  const fields: FieldError[] = [];
  if (!("path" in candidate)) {
    fields.push({ field: "path", code: "required" });
  } else if (typeof candidate.path !== "string") {
    fields.push({ field: "path", code: "invalid_type" });
  }
  if (!("expectedVersion" in candidate)) {
    fields.push({ field: "expectedVersion", code: "required" });
  } else if (typeof candidate.expectedVersion !== "number") {
    fields.push({ field: "expectedVersion", code: "invalid_type" });
  } else if (
    !Number.isInteger(candidate.expectedVersion) ||
    candidate.expectedVersion < 1
  ) {
    fields.push({ field: "expectedVersion", code: "invalid_format" });
  }
  if (!("confirmRebind" in candidate)) {
    fields.push({ field: "confirmRebind", code: "required" });
  } else if (typeof candidate.confirmRebind !== "boolean") {
    fields.push({ field: "confirmRebind", code: "invalid_type" });
  }
  return fields;
}

export async function GET(
  _request: Request,
  context: RouteContext,
): Promise<Response> {
  const { projectId } = await context.params;
  try {
    return Response.json(getWorkspace(databasePath(), projectId));
  } catch (error) {
    if (error instanceof WorkspaceError) return workspaceErrorResponse(error);
    return (
      storageErrorResponse(error) ??
      internalErrorResponse("GET /api/projects/:projectId/workspace")
    );
  }
}

export async function PUT(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const { projectId } = await context.params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: { code: "INVALID_JSON", message: "Request body must be valid JSON." } },
      { status: 400 },
    );
  }

  const fields = workspaceInputFields(body);
  if (fields.length > 0) {
    return Response.json(
      {
        error: {
          code: "INVALID_INPUT",
          fields,
          message: "Workspace input is invalid.",
        },
      },
      { status: 400 },
    );
  }

  const candidate = body as {
    path?: unknown;
    expectedVersion?: unknown;
    confirmRebind?: unknown;
  };

  try {
    return Response.json(
      await bindWorkspace(databasePath(), projectId, {
        path: candidate.path as string,
        expectedVersion: candidate.expectedVersion as number,
        confirmRebind: candidate.confirmRebind as boolean,
      }),
    );
  } catch (error) {
    if (error instanceof WorkspaceError) return workspaceErrorResponse(error);
    return (
      storageErrorResponse(error) ??
      internalErrorResponse("PUT /api/projects/:projectId/workspace")
    );
  }
}
