import { join } from "node:path";

import {
  internalErrorResponse,
  storageErrorResponse,
} from "@/app/api/_shared/api-errors";
import { openFolderAsProject, projects } from "@/src/composition";
import { WorkspaceError } from "@/src/modules/project-workspace";

function databasePath(): string {
  return process.env.COCKPIT_DB_PATH ?? join(process.cwd(), ".data", "cockpit.sqlite");
}

export async function GET(): Promise<Response> {
  try {
    return Response.json({ projects: projects.listProjects(databasePath()) });
  } catch (error) {
    return (
      storageErrorResponse(error) ??
      internalErrorResponse("GET /api/projects")
    );
  }
}

type ProjectInputFieldError = {
  code: "invalid_type" | "required" | "unexpected";
  field: string;
};

function projectInputFields(body: unknown): ProjectInputFieldError[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return [{ code: "required", field: "path" }];
  }
  const candidate = body as Record<string, unknown>;
  const fields: ProjectInputFieldError[] = [];
  if (!Object.hasOwn(candidate, "path")) {
    fields.push({ code: "required", field: "path" });
  } else if (typeof candidate.path !== "string") {
    fields.push({ code: "invalid_type", field: "path" });
  }
  if (Object.hasOwn(candidate, "path")) {
    for (const key of Object.keys(candidate)) {
      if (key !== "path") fields.push({ code: "unexpected", field: key });
    }
  }
  return fields;
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

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: { code: "INVALID_JSON", message: "Request body must be valid JSON." } },
      { status: 400 },
    );
  }

  const fields = projectInputFields(body);
  if (fields.length > 0) {
    return Response.json(
      {
        error: {
          code: "INVALID_INPUT",
          fields,
          message: "Project input is invalid.",
        },
      },
      { status: 400 },
    );
  }

  const path = (body as { path: string }).path;
  try {
    const result = await openFolderAsProject(databasePath(), path);
    return Response.json(
      { project: result.project },
      { status: result.created ? 201 : 200 },
    );
  } catch (error) {
    if (error instanceof WorkspaceError) return workspaceErrorResponse(error);
    return (
      storageErrorResponse(error) ??
      internalErrorResponse("POST /api/projects")
    );
  }
}
