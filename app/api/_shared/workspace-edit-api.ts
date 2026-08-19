import { dirname, join } from "node:path";

import {
  internalErrorResponse,
  storageErrorResponse,
} from "@/app/api/_shared/api-errors";
import { workspaceEditService } from "@/src/composition";
import { windowsVerifiedExecution } from "@/src/composition/execution-host";
import { WorkspaceError } from "@/src/modules/project-workspace";

type RouteContext = {
  params: Promise<{ projectId: string; editId?: string }>;
};

type FieldError = { code: string; field: string };

const PATH_LIMIT = 4096;
const OPERATION_LIMIT = 128;
const NO_STORE = { "cache-control": "no-store" };

function databasePath(): string {
  return process.env.COCKPIT_DB_PATH ?? join(process.cwd(), ".data", "cockpit.sqlite");
}

function editRoot(dbPath: string): string {
  const configured = process.env.COCKPIT_WORKSPACE_EDIT_ROOT;
  if (configured && configured.length > 0) return configured;
  if (dbPath.startsWith("file:") || dbPath === ":memory:") {
    return join(process.cwd(), ".data", "workspace-edits");
  }
  return join(dirname(dbPath), "workspace-edits");
}

function workspaceEditErrorResponse(error: WorkspaceError): Response {
  const status =
    error.code === "PROJECT_NOT_FOUND"
    || error.code === "WORKSPACE_NOT_BOUND"
    || error.code === "WORKSPACE_ENTRY_NOT_FOUND"
    || error.code === "WORKSPACE_EDIT_NOT_FOUND"
      ? 404
      : error.code === "RESOURCE_CONFLICT"
        ? 409
        : error.code === "WORKSPACE_FILE_TOO_LARGE"
          ? 413
          : error.code === "WORKSPACE_BROWSE_UNAVAILABLE"
            ? 503
            : error.code === "WORKSPACE_PATH_REJECTED"
              || error.code === "WORKSPACE_NOT_EDITABLE"
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
        message: "Workspace edit input is invalid.",
      },
    },
    { headers: NO_STORE, status: 400 },
  );
}

function editErrorResponse(error: unknown, route: string): Response {
  if (error instanceof WorkspaceError) return workspaceEditErrorResponse(error);
  return storageErrorResponse(error) ?? internalErrorResponse(route);
}

function parseCreateBody(body: unknown):
  | { operationId: string; path: string }
  | { response: Response } {
  const candidate =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  const fields: FieldError[] = [];
  for (const key of Object.keys(candidate)) {
    if (key !== "path" && key !== "operationId") {
      fields.push({ code: "unknown", field: key });
    }
  }
  if (!("path" in candidate)) {
    fields.push({ code: "required", field: "path" });
  } else if (typeof candidate.path !== "string") {
    fields.push({ code: "invalid_type", field: "path" });
  } else if (
    candidate.path.length < 1
    || candidate.path.length > PATH_LIMIT
    || candidate.path.includes("\0")
  ) {
    fields.push({ code: "invalid_format", field: "path" });
  }
  if (!("operationId" in candidate)) {
    fields.push({ code: "required", field: "operationId" });
  } else if (typeof candidate.operationId !== "string") {
    fields.push({ code: "invalid_type", field: "operationId" });
  } else if (
    candidate.operationId.length < 1
    || candidate.operationId.length > OPERATION_LIMIT
    || candidate.operationId.includes("\0")
  ) {
    fields.push({ code: "invalid_format", field: "operationId" });
  }
  if (fields.length > 0) return { response: invalidInput(fields) };
  return {
    operationId: candidate.operationId as string,
    path: candidate.path as string,
  };
}

export async function workspaceEditsPost(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const { projectId } = await context.params;
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json(
        { error: { code: "INVALID_JSON", message: "Request body must be valid JSON." } },
        { headers: NO_STORE, status: 400 },
      );
    }
    const parsed = parseCreateBody(body);
    if ("response" in parsed) return parsed.response;
    const dbPath = databasePath();
    const adapters = windowsVerifiedExecution.createWindowsVerifiedExecutionAdapters();
    const session = await workspaceEditService.createWorkspaceEdit(
      dbPath,
      projectId,
      { operationId: parsed.operationId, relativePath: parsed.path },
      { editRoot: editRoot(dbPath), fs: adapters.fileAdapter },
    );
    return Response.json(session, { headers: NO_STORE, status: 201 });
  } catch (error) {
    return editErrorResponse(error, "POST /api/projects/:projectId/workspace/edits");
  }
}

export async function workspaceEditGet(
  _request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const { projectId, editId } = await context.params;
    if (!editId) {
      return invalidInput([{ code: "required", field: "editId" }]);
    }
    const session = workspaceEditService.getWorkspaceEdit(databasePath(), projectId, editId);
    return Response.json(session, { headers: NO_STORE });
  } catch (error) {
    return editErrorResponse(error, "GET /api/projects/:projectId/workspace/edits/:editId");
  }
}

function parsePutBody(body: unknown):
  | {
    content: string;
    expectedHash: string;
    expectedVersion: number;
    operationId: string;
  }
  | { response: Response } {
  const candidate =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  const fields: FieldError[] = [];
  for (const key of Object.keys(candidate)) {
    if (
      key !== "content"
      && key !== "expectedHash"
      && key !== "expectedVersion"
      && key !== "operationId"
    ) {
      fields.push({ code: "unknown", field: key });
    }
  }
  if (!("content" in candidate)) {
    fields.push({ code: "required", field: "content" });
  } else if (typeof candidate.content !== "string") {
    fields.push({ code: "invalid_type", field: "content" });
  } else if (candidate.content.includes("\0") || candidate.content.length > PATH_LIMIT * 128) {
    fields.push({ code: "invalid_format", field: "content" });
  }
  if (!("expectedHash" in candidate)) {
    fields.push({ code: "required", field: "expectedHash" });
  } else if (typeof candidate.expectedHash !== "string") {
    fields.push({ code: "invalid_type", field: "expectedHash" });
  } else if (!/^[0-9a-f]{64}$/u.test(candidate.expectedHash)) {
    fields.push({ code: "invalid_format", field: "expectedHash" });
  }
  if (!("expectedVersion" in candidate)) {
    fields.push({ code: "required", field: "expectedVersion" });
  } else if (typeof candidate.expectedVersion !== "number") {
    fields.push({ code: "invalid_type", field: "expectedVersion" });
  } else if (!Number.isInteger(candidate.expectedVersion) || candidate.expectedVersion < 1) {
    fields.push({ code: "invalid_format", field: "expectedVersion" });
  }
  if (!("operationId" in candidate)) {
    fields.push({ code: "required", field: "operationId" });
  } else if (typeof candidate.operationId !== "string") {
    fields.push({ code: "invalid_type", field: "operationId" });
  } else if (
    candidate.operationId.length < 1
    || candidate.operationId.length > OPERATION_LIMIT
    || candidate.operationId.includes("\0")
  ) {
    fields.push({ code: "invalid_format", field: "operationId" });
  }
  if (fields.length > 0) return { response: invalidInput(fields) };
  return {
    content: candidate.content as string,
    expectedHash: candidate.expectedHash as string,
    expectedVersion: candidate.expectedVersion as number,
    operationId: candidate.operationId as string,
  };
}

export async function workspaceEditPut(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const { projectId, editId } = await context.params;
    if (!editId) return invalidInput([{ code: "required", field: "editId" }]);
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json(
        { error: { code: "INVALID_JSON", message: "Request body must be valid JSON." } },
        { headers: NO_STORE, status: 400 },
      );
    }
    const parsed = parsePutBody(body);
    if ("response" in parsed) return parsed.response;
    const dbPath = databasePath();
    const adapters = windowsVerifiedExecution.createWindowsVerifiedExecutionAdapters();
    const session = await workspaceEditService.putWorkspaceEditDraft(
      dbPath,
      projectId,
      editId,
      parsed,
      { editRoot: editRoot(dbPath), fs: adapters.fileAdapter },
    );
    return Response.json(session, { headers: NO_STORE });
  } catch (error) {
    return editErrorResponse(error, "PUT /api/projects/:projectId/workspace/edits/:editId");
  }
}

export async function workspaceEditDiffGet(
  _request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const { projectId, editId } = await context.params;
    if (!editId) return invalidInput([{ code: "required", field: "editId" }]);
    const dbPath = databasePath();
    const adapters = windowsVerifiedExecution.createWindowsVerifiedExecutionAdapters();
    const diff = await workspaceEditService.getWorkspaceEditDiff(
      dbPath,
      projectId,
      editId,
      { editRoot: editRoot(dbPath), fs: adapters.fileAdapter },
    );
    return Response.json(diff, { headers: NO_STORE });
  } catch (error) {
    return editErrorResponse(
      error,
      "GET /api/projects/:projectId/workspace/edits/:editId/diff",
    );
  }
}

function parseVersionedBody(body: unknown):
  | { expectedVersion: number; operationId: string }
  | { response: Response } {
  const candidate =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  const fields: FieldError[] = [];
  for (const key of Object.keys(candidate)) {
    if (key !== "expectedVersion" && key !== "operationId" && key !== "stagedHash") {
      fields.push({ code: "unknown", field: key });
    }
  }
  if (!("expectedVersion" in candidate)) {
    fields.push({ code: "required", field: "expectedVersion" });
  } else if (typeof candidate.expectedVersion !== "number") {
    fields.push({ code: "invalid_type", field: "expectedVersion" });
  } else if (!Number.isInteger(candidate.expectedVersion) || candidate.expectedVersion < 1) {
    fields.push({ code: "invalid_format", field: "expectedVersion" });
  }
  if (!("operationId" in candidate)) {
    fields.push({ code: "required", field: "operationId" });
  } else if (typeof candidate.operationId !== "string") {
    fields.push({ code: "invalid_type", field: "operationId" });
  } else if (
    candidate.operationId.length < 1
    || candidate.operationId.length > OPERATION_LIMIT
    || candidate.operationId.includes("\0")
  ) {
    fields.push({ code: "invalid_format", field: "operationId" });
  }
  if (fields.length > 0) return { response: invalidInput(fields) };
  return {
    expectedVersion: candidate.expectedVersion as number,
    operationId: candidate.operationId as string,
  };
}

function runtime() {
  const dbPath = databasePath();
  const adapters = windowsVerifiedExecution.createWindowsVerifiedExecutionAdapters();
  return { dbPath, edit: { editRoot: editRoot(dbPath), fs: adapters.fileAdapter } };
}

export async function workspaceEditStagePost(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const { projectId, editId } = await context.params;
    if (!editId) return invalidInput([{ code: "required", field: "editId" }]);
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json(
        { error: { code: "INVALID_JSON", message: "Request body must be valid JSON." } },
        { headers: NO_STORE, status: 400 },
      );
    }
    const parsed = parseVersionedBody(body);
    if ("response" in parsed) return parsed.response;
    const { dbPath, edit } = runtime();
    const session = await workspaceEditService.stageWorkspaceEdit(
      dbPath,
      projectId,
      editId,
      parsed,
      edit,
    );
    return Response.json(session, { headers: NO_STORE });
  } catch (error) {
    return editErrorResponse(error, "POST /api/projects/:projectId/workspace/edits/:editId/stage");
  }
}

export async function workspaceEditAbandonPost(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const { projectId, editId } = await context.params;
    if (!editId) return invalidInput([{ code: "required", field: "editId" }]);
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json(
        { error: { code: "INVALID_JSON", message: "Request body must be valid JSON." } },
        { headers: NO_STORE, status: 400 },
      );
    }
    const parsed = parseVersionedBody(body);
    if ("response" in parsed) return parsed.response;
    const { dbPath, edit } = runtime();
    const session = await workspaceEditService.abandonWorkspaceEdit(
      dbPath,
      projectId,
      editId,
      parsed,
      edit,
    );
    return Response.json(session, { headers: NO_STORE });
  } catch (error) {
    return editErrorResponse(
      error,
      "POST /api/projects/:projectId/workspace/edits/:editId/abandon",
    );
  }
}

export async function workspaceEditMergePost(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const { projectId, editId } = await context.params;
    if (!editId) return invalidInput([{ code: "required", field: "editId" }]);
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json(
        { error: { code: "INVALID_JSON", message: "Request body must be valid JSON." } },
        { headers: NO_STORE, status: 400 },
      );
    }
    const parsed = parseVersionedBody(body);
    if ("response" in parsed) return parsed.response;
    const candidate = body as { stagedHash?: unknown };
    if (typeof candidate.stagedHash !== "string" || !/^[0-9a-f]{64}$/u.test(candidate.stagedHash)) {
      return invalidInput([{ code: "invalid_format", field: "stagedHash" }]);
    }
    const { dbPath, edit } = runtime();
    const session = await workspaceEditService.mergeWorkspaceEdit(
      dbPath,
      projectId,
      editId,
      { ...parsed, stagedHash: candidate.stagedHash },
      edit,
    );
    return Response.json(session, { headers: NO_STORE });
  } catch (error) {
    return editErrorResponse(error, "POST /api/projects/:projectId/workspace/edits/:editId/merge");
  }
}
