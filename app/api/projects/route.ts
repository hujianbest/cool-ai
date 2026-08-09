import { join } from "node:path";

import {
  internalErrorResponse,
  storageErrorResponse,
} from "@/src/server/api-errors";
import { createProject, listProjects } from "@/src/adapters/outbound/sqlite/project-workspace/projects";

function databasePath(): string {
  return process.env.COCKPIT_DB_PATH ?? join(process.cwd(), ".data", "cockpit.sqlite");
}

export async function GET(): Promise<Response> {
  try {
    return Response.json({ projects: listProjects(databasePath()) });
  } catch (error) {
    return (
      storageErrorResponse(error) ??
      internalErrorResponse("GET /api/projects")
    );
  }
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

  if (!body || typeof body !== "object" || typeof (body as { name?: unknown }).name !== "string") {
    return Response.json(
      { error: { code: "INVALID_INPUT", message: "Project name must be a string." } },
      { status: 400 },
    );
  }

  try {
    const project = createProject((body as { name: string }).name, databasePath());
    return Response.json({ project }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "Project name is required.") {
      return Response.json(
        { error: { code: "EMPTY_PROJECT_NAME", message: error.message } },
        { status: 400 },
      );
    }
    return (
      storageErrorResponse(error) ??
      internalErrorResponse("POST /api/projects")
    );
  }
}
