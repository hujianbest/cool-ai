import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import {
  readVerifiedWorkspaceTextFile,
  workspaceEditPathSegments,
  WORKSPACE_EDIT_TEXT_BYTES,
  type SandboxFileHandleAdapter,
} from "@/src/adapters/outbound/workspace/workspace-browse-adapter";
import {
  WorkspaceError,
  type CreateWorkspaceEditInput,
  type PutWorkspaceEditDraftInput,
  type WorkspaceEditDiff,
  type WorkspaceEditDiffStatus,
  type WorkspaceEditSession,
} from "@/src/modules/project-workspace";

export type WorkspaceEditRuntime<Handle> = {
  editRoot: string;
  fs: SandboxFileHandleAdapter<Handle> & {
    writeNativeVerifiedFile?(input: {
      bytes: Uint8Array;
      expectedHash: string | null;
      pathSegments: string[];
      sandboxRoot: string;
    }): { hash: string; identity: string };
  };
};

type SessionRow = {
  baselineHash: string;
  id: string;
  relativePath: string;
  stagedHash: string | null;
  status: WorkspaceEditSession["status"];
  version: number;
};

function pathKeyFor(relativePath: string): string {
  return process.platform === "win32"
    ? relativePath.toLocaleLowerCase("en-US")
    : relativePath;
}

function clock(): string {
  return new Date().toISOString();
}

function boundWorkspaceRoot(databasePath: string, projectId: string): string {
  const database = openDatabase(databasePath);
  try {
    const project = database
      .prepare("SELECT workspace_path AS workspacePath FROM projects WHERE id = ?")
      .get(projectId) as { workspacePath: string | null } | undefined;
    if (!project) {
      throw new WorkspaceError("PROJECT_NOT_FOUND", "Project was not found.");
    }
    if (!project.workspacePath) {
      throw new WorkspaceError(
        "WORKSPACE_NOT_BOUND",
        "Project has no ready workspace binding.",
      );
    }
    return project.workspacePath;
  } finally {
    database.close();
  }
}

function validateOperationId(operationId: string): string {
  if (
    typeof operationId !== "string"
    || operationId.length < 1
    || operationId.length > 128
    || operationId.includes("\0")
  ) {
    throw new WorkspaceError("INVALID_INPUT", "Workspace edit input is invalid.", [
      { field: "operationId", code: "invalid_format" },
    ]);
  }
  return operationId;
}

function toSession(row: SessionRow): WorkspaceEditSession {
  return {
    expectedHash: row.baselineHash,
    path: row.relativePath,
    sessionId: row.id,
    stagedHash: row.stagedHash,
    status: row.status,
    version: row.version,
  };
}

function draftFilePath(editRoot: string, sessionId: string, relativePath: string): string {
  const root = resolve(editRoot);
  const target = resolve(join(root, sessionId, ...relativePath.split("/")));
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  const comparableTarget = process.platform === "win32"
    ? target.toLocaleLowerCase("en-US")
    : target;
  const comparablePrefix = process.platform === "win32"
    ? prefix.toLocaleLowerCase("en-US")
    : prefix;
  if (!comparableTarget.startsWith(comparablePrefix)) {
    throw new WorkspaceError(
      "WORKSPACE_PATH_REJECTED",
      "Workspace path cannot be verified inside the binding root.",
    );
  }
  return target;
}

function writeDraftBytes(
  editRoot: string,
  sessionId: string,
  relativePath: string,
  bytes: Uint8Array,
): void {
  const target = draftFilePath(editRoot, sessionId, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes);
}

export async function createWorkspaceEdit<Handle>(
  databasePath: string,
  projectId: string,
  input: CreateWorkspaceEditInput,
  runtime: WorkspaceEditRuntime<Handle>,
): Promise<WorkspaceEditSession> {
  const operationId = validateOperationId(input.operationId);
  const workspaceRoot = boundWorkspaceRoot(databasePath, projectId);
  const file = await readVerifiedWorkspaceTextFile({
    fs: runtime.fs,
    relativePath: input.relativePath,
    workspaceRoot,
  });
  const baselineHash = createHash("sha256").update(file.bytes).digest("hex");
  const pathKey = pathKeyFor(file.path);
  const occurredAt = clock();
  const database = openDatabase(databasePath);
  try {
    database.exec("BEGIN IMMEDIATE");
    const replay = database
      .prepare(`
        SELECT id, relative_path AS relativePath, status, baseline_hash AS baselineHash,
               staged_hash AS stagedHash, version
        FROM workspace_edit_sessions
        WHERE project_id=? AND latest_operation_id=?
      `)
      .get(projectId, operationId) as SessionRow | undefined;
    if (replay) {
      database.exec("COMMIT");
      return toSession(replay);
    }
    const sessionId = randomUUID();
    writeDraftBytes(runtime.editRoot, sessionId, file.path, file.bytes);
    const locator = JSON.stringify({
      kind: "workspace_edit_draft",
      path: file.path,
      sessionId,
    });
    database.prepare(`
      INSERT INTO workspace_edit_sessions(
        id, project_id, relative_path, path_key, status, expected_mtime, baseline_hash,
        draft_locator_json, version, latest_operation_id, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,1,?,?,?)
    `).run(
      sessionId,
      projectId,
      file.path,
      pathKey,
      "editing",
      occurredAt,
      baselineHash,
      locator,
      operationId,
      occurredAt,
      occurredAt,
    );
    database.exec("COMMIT");
    return {
      expectedHash: baselineHash,
      path: file.path,
      sessionId,
      stagedHash: null,
      status: "editing",
      version: 1,
    };
  } catch (error) {
    if (database.isTransaction) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Preserve the original failure.
      }
    }
    const constraint = error as { code?: string };
    if (constraint.code === "ERR_SQLITE_CONSTRAINT_UNIQUE" || String(error).includes("UNIQUE")) {
      throw new WorkspaceError(
        "RESOURCE_CONFLICT",
        "An active workspace edit already exists for this project.",
      );
    }
    throw error;
  } finally {
    database.close();
  }
}

export function getWorkspaceEdit(
  databasePath: string,
  projectId: string,
  sessionId: string,
): WorkspaceEditSession {
  if (
    typeof sessionId !== "string"
    || sessionId.length < 1
    || sessionId.length > 128
    || sessionId.includes("\0")
  ) {
    throw new WorkspaceError("INVALID_INPUT", "Workspace edit input is invalid.", [
      { field: "sessionId", code: "invalid_format" },
    ]);
  }
  const database = openDatabase(databasePath);
  try {
    const row = database
      .prepare(`
        SELECT id, relative_path AS relativePath, status, baseline_hash AS baselineHash,
               staged_hash AS stagedHash, version
        FROM workspace_edit_sessions
        WHERE project_id=? AND id=?
      `)
      .get(projectId, sessionId) as SessionRow | undefined;
    if (!row) {
      throw new WorkspaceError("WORKSPACE_EDIT_NOT_FOUND", "Workspace edit was not found.");
    }
    return toSession(row);
  } finally {
    database.close();
  }
}

const TERMINAL_STATUSES = new Set(["merged", "abandoned"]);
const LOCKED_STATUSES = new Set(["staged", "awaiting_approval", "merging", "merged", "abandoned"]);

function validateSessionId(sessionId: string): string {
  if (
    typeof sessionId !== "string"
    || sessionId.length < 1
    || sessionId.length > 128
    || sessionId.includes("\0")
  ) {
    throw new WorkspaceError("INVALID_INPUT", "Workspace edit input is invalid.", [
      { field: "sessionId", code: "invalid_format" },
    ]);
  }
  return sessionId;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function encodeDraftText(content: string): Uint8Array {
  if (typeof content !== "string" || content.includes("\0")) {
    throw new WorkspaceError("INVALID_INPUT", "Workspace edit input is invalid.", [
      { field: "content", code: "invalid_format" },
    ]);
  }
  const bytes = Buffer.from(content, "utf8");
  if (bytes.byteLength > WORKSPACE_EDIT_TEXT_BYTES) {
    throw new WorkspaceError(
      "WORKSPACE_FILE_TOO_LARGE",
      "File exceeds the workspace edit limit.",
    );
  }
  return bytes;
}

function unifiedDiff(path: string, before: string, after: string): string {
  if (before === after) return "";
  const oldLines = before.split("\n");
  const newLines = after.split("\n");
  return [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
    "",
  ].join("\n");
}

function diffStatus(input: {
  baselineHash: string;
  canonicalHash: string;
  draftHash: string;
}): WorkspaceEditDiffStatus {
  if (input.canonicalHash === input.baselineHash) {
    return input.draftHash === input.canonicalHash ? "editing" : "ready_to_stage";
  }
  if (input.draftHash === input.baselineHash) return "stale";
  if (input.draftHash === input.canonicalHash) return "stale";
  return "conflicted";
}

function loadSessionRow(
  databasePath: string,
  projectId: string,
  sessionId: string,
): SessionRow {
  const database = openDatabase(databasePath);
  try {
    const row = database
      .prepare(`
        SELECT id, relative_path AS relativePath, status, baseline_hash AS baselineHash,
               staged_hash AS stagedHash, version
        FROM workspace_edit_sessions
        WHERE project_id=? AND id=?
      `)
      .get(projectId, sessionId) as SessionRow | undefined;
    if (!row) {
      throw new WorkspaceError("WORKSPACE_EDIT_NOT_FOUND", "Workspace edit was not found.");
    }
    return row;
  } finally {
    database.close();
  }
}

export async function putWorkspaceEditDraft<Handle>(
  databasePath: string,
  projectId: string,
  sessionId: string,
  input: PutWorkspaceEditDraftInput,
  runtime: WorkspaceEditRuntime<Handle>,
): Promise<WorkspaceEditSession> {
  const id = validateSessionId(sessionId);
  const operationId = validateOperationId(input.operationId);
  const bytes = encodeDraftText(input.content);
  if (
    typeof input.expectedHash !== "string"
    || !/^[0-9a-f]{64}$/u.test(input.expectedHash)
  ) {
    throw new WorkspaceError("INVALID_INPUT", "Workspace edit input is invalid.", [
      { field: "expectedHash", code: "invalid_format" },
    ]);
  }
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw new WorkspaceError("INVALID_INPUT", "Workspace edit input is invalid.", [
      { field: "expectedVersion", code: "invalid_format" },
    ]);
  }
  const current = loadSessionRow(databasePath, projectId, id);
  if (LOCKED_STATUSES.has(current.status)) {
    throw new WorkspaceError("RESOURCE_CONFLICT", "Workspace edit can no longer be changed.");
  }
  if (current.version !== input.expectedVersion || current.baselineHash !== input.expectedHash) {
    throw new WorkspaceError(
      "RESOURCE_CONFLICT",
      "Workspace edit is stale.",
      undefined,
      current.version,
    );
  }
  writeDraftBytes(runtime.editRoot, current.id, current.relativePath, bytes);
  const occurredAt = clock();
  const database = openDatabase(databasePath);
  try {
    database.exec("BEGIN IMMEDIATE");
    const updated = database.prepare(`
      UPDATE workspace_edit_sessions
      SET version=version+1, latest_operation_id=?, updated_at=?, status='editing'
      WHERE project_id=? AND id=? AND version=? AND status NOT IN ('merged','abandoned')
    `).run(operationId, occurredAt, projectId, id, input.expectedVersion);
    if (updated.changes !== 1) {
      throw new WorkspaceError("RESOURCE_CONFLICT", "Workspace edit is stale.", undefined, current.version);
    }
    const row = database
      .prepare(`
        SELECT id, relative_path AS relativePath, status, baseline_hash AS baselineHash,
               staged_hash AS stagedHash, version
        FROM workspace_edit_sessions
        WHERE project_id=? AND id=?
      `)
      .get(projectId, id) as SessionRow;
    database.exec("COMMIT");
    return toSession(row);
  } catch (error) {
    if (database.isTransaction) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Preserve the original failure.
      }
    }
    throw error;
  } finally {
    database.close();
  }
}

export async function getWorkspaceEditDiff<Handle>(
  databasePath: string,
  projectId: string,
  sessionId: string,
  runtime: WorkspaceEditRuntime<Handle>,
): Promise<WorkspaceEditDiff> {
  const id = validateSessionId(sessionId);
  const current = loadSessionRow(databasePath, projectId, id);
  const workspaceRoot = boundWorkspaceRoot(databasePath, projectId);
  const canonical = await readVerifiedWorkspaceTextFile({
    fs: runtime.fs,
    relativePath: current.relativePath,
    workspaceRoot,
  });
  const draftBytes = readFileSync(draftFilePath(runtime.editRoot, current.id, current.relativePath));
  const draftText = draftBytes.toString("utf8");
  const canonicalText = Buffer.from(canonical.bytes).toString("utf8");
  const status = diffStatus({
    baselineHash: current.baselineHash,
    canonicalHash: sha256(canonical.bytes),
    draftHash: sha256(draftBytes),
  });
  const occurredAt = clock();
  const database = openDatabase(databasePath);
  try {
    database.exec("BEGIN IMMEDIATE");
    database.prepare(`
      UPDATE workspace_edit_sessions
      SET status=?, updated_at=?
      WHERE project_id=? AND id=? AND status NOT IN ('merged','abandoned','staged','awaiting_approval','merging')
    `).run(status, occurredAt, projectId, id);
    database.exec("COMMIT");
  } catch (error) {
    if (database.isTransaction) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Preserve the original failure.
      }
    }
    throw error;
  } finally {
    database.close();
  }
  return {
    diff: unifiedDiff(current.relativePath, canonicalText, draftText),
    path: current.relativePath,
    sessionId: current.id,
    status,
  };
}

type VersionedEditInput = {
  expectedVersion: number;
  operationId: string;
};

function assertVersion(current: SessionRow, expectedVersion: number): void {
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    throw new WorkspaceError("INVALID_INPUT", "Workspace edit input is invalid.", [
      { field: "expectedVersion", code: "invalid_format" },
    ]);
  }
  if (current.version !== expectedVersion) {
    throw new WorkspaceError("RESOURCE_CONFLICT", "Workspace edit is stale.", undefined, current.version);
  }
}

export async function abandonWorkspaceEdit<Handle>(
  databasePath: string,
  projectId: string,
  sessionId: string,
  input: VersionedEditInput,
  runtime: WorkspaceEditRuntime<Handle>,
): Promise<WorkspaceEditSession> {
  const id = validateSessionId(sessionId);
  const operationId = validateOperationId(input.operationId);
  const current = loadSessionRow(databasePath, projectId, id);
  if (TERMINAL_STATUSES.has(current.status)) {
    throw new WorkspaceError("RESOURCE_CONFLICT", "Workspace edit can no longer be changed.");
  }
  assertVersion(current, input.expectedVersion);
  const occurredAt = clock();
  const database = openDatabase(databasePath);
  try {
    database.exec("BEGIN IMMEDIATE");
    const updated = database.prepare(`
      UPDATE workspace_edit_sessions
      SET status='abandoned', version=version+1, latest_operation_id=?, updated_at=?, staged_hash=NULL
      WHERE project_id=? AND id=? AND version=? AND status NOT IN ('merged','abandoned')
    `).run(operationId, occurredAt, projectId, id, input.expectedVersion);
    if (updated.changes !== 1) {
      throw new WorkspaceError("RESOURCE_CONFLICT", "Workspace edit is stale.", undefined, current.version);
    }
    const row = database
      .prepare(`
        SELECT id, relative_path AS relativePath, status, baseline_hash AS baselineHash,
               staged_hash AS stagedHash, version
        FROM workspace_edit_sessions
        WHERE project_id=? AND id=?
      `)
      .get(projectId, id) as SessionRow;
    database.exec("COMMIT");
    rmSync(join(runtime.editRoot, current.id), { force: true, recursive: true });
    return toSession(row);
  } catch (error) {
    if (database.isTransaction) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Preserve the original failure.
      }
    }
    throw error;
  } finally {
    database.close();
  }
}

export async function stageWorkspaceEdit<Handle>(
  databasePath: string,
  projectId: string,
  sessionId: string,
  input: VersionedEditInput,
  runtime: WorkspaceEditRuntime<Handle>,
): Promise<WorkspaceEditSession> {
  const id = validateSessionId(sessionId);
  const operationId = validateOperationId(input.operationId);
  const current = loadSessionRow(databasePath, projectId, id);
  if (TERMINAL_STATUSES.has(current.status)) {
    throw new WorkspaceError("RESOURCE_CONFLICT", "Workspace edit can no longer be changed.");
  }
  assertVersion(current, input.expectedVersion);
  const workspaceRoot = boundWorkspaceRoot(databasePath, projectId);
  const canonical = await readVerifiedWorkspaceTextFile({
    fs: runtime.fs,
    relativePath: current.relativePath,
    workspaceRoot,
  });
  const draftBytes = readFileSync(draftFilePath(runtime.editRoot, current.id, current.relativePath));
  const status = diffStatus({
    baselineHash: current.baselineHash,
    canonicalHash: sha256(canonical.bytes),
    draftHash: sha256(draftBytes),
  });
  if (status !== "ready_to_stage") {
    throw new WorkspaceError(
      "RESOURCE_CONFLICT",
      "Workspace edit is not ready to stage.",
      undefined,
      current.version,
    );
  }
  const stagedHash = sha256(draftBytes);
  const occurredAt = clock();
  const database = openDatabase(databasePath);
  try {
    database.exec("BEGIN IMMEDIATE");
    const replay = database
      .prepare(`
        SELECT id, relative_path AS relativePath, status, baseline_hash AS baselineHash,
               staged_hash AS stagedHash, version
        FROM workspace_edit_sessions
        WHERE project_id=? AND latest_operation_id=?
      `)
      .get(projectId, operationId) as SessionRow | undefined;
    if (replay) {
      database.exec("COMMIT");
      return toSession(replay);
    }
    const updated = database.prepare(`
      UPDATE workspace_edit_sessions
      SET status='staged', staged_hash=?, version=version+1, latest_operation_id=?, updated_at=?
      WHERE project_id=? AND id=? AND version=? AND status NOT IN ('merged','abandoned')
    `).run(stagedHash, operationId, occurredAt, projectId, id, input.expectedVersion);
    if (updated.changes !== 1) {
      throw new WorkspaceError("RESOURCE_CONFLICT", "Workspace edit is stale.", undefined, current.version);
    }
    const row = database
      .prepare(`
        SELECT id, relative_path AS relativePath, status, baseline_hash AS baselineHash,
               staged_hash AS stagedHash, version
        FROM workspace_edit_sessions
        WHERE project_id=? AND id=?
      `)
      .get(projectId, id) as SessionRow;
    database.exec("COMMIT");
    return toSession(row);
  } catch (error) {
    if (database.isTransaction) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Preserve the original failure.
      }
    }
    throw error;
  } finally {
    database.close();
  }
}

export function approveWorkspaceEditMerge(
  databasePath: string,
  projectId: string,
  sessionId: string,
  input: { operationId: string; stagedHash: string },
): { approvalId: string } {
  const id = validateSessionId(sessionId);
  const operationId = validateOperationId(input.operationId);
  if (!/^[0-9a-f]{64}$/u.test(input.stagedHash)) {
    throw new WorkspaceError("INVALID_INPUT", "Workspace edit input is invalid.", [
      { field: "stagedHash", code: "invalid_format" },
    ]);
  }
  const current = loadSessionRow(databasePath, projectId, id);
  if (
    current.stagedHash !== input.stagedHash
    || (current.status !== "staged" && current.status !== "awaiting_approval")
  ) {
    throw new WorkspaceError("RESOURCE_CONFLICT", "Workspace edit cannot be approved.");
  }
  const occurredAt = clock();
  const database = openDatabase(databasePath);
  try {
    database.exec("BEGIN IMMEDIATE");
    const existing = database
      .prepare(`
        SELECT id FROM workspace_edit_approvals
        WHERE project_id=? AND operation_id=?
      `)
      .get(projectId, operationId) as { id: string } | undefined;
    if (existing) {
      database.exec("COMMIT");
      return { approvalId: existing.id };
    }
    const approvalId = randomUUID();
    database.prepare(`
      INSERT INTO workspace_edit_approvals(
        id, project_id, session_id, staged_hash, status, operation_id, created_at, updated_at
      ) VALUES (?,?,?,?, 'approved', ?, ?, ?)
    `).run(approvalId, projectId, id, input.stagedHash, operationId, occurredAt, occurredAt);
    database.prepare(`
      UPDATE workspace_edit_sessions
      SET status='awaiting_approval', updated_at=?
      WHERE project_id=? AND id=?
    `).run(occurredAt, projectId, id);
    database.exec("COMMIT");
    return { approvalId };
  } catch (error) {
    if (database.isTransaction) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Preserve the original failure.
      }
    }
    throw error;
  } finally {
    database.close();
  }
}

function applyVerifiedCanonicalWrite(
  runtime: WorkspaceEditRuntime<unknown>,
  input: {
    baselineHash: string;
    bytes: Uint8Array;
    pathSegments: string[];
    workspaceRoot: string;
  },
): void {
  const writeNativeVerifiedFile = runtime.fs.writeNativeVerifiedFile;
  if (typeof writeNativeVerifiedFile !== "function") {
    throw new WorkspaceError(
      "WORKSPACE_BROWSE_UNAVAILABLE",
      "Verified workspace write is unavailable.",
    );
  }
  try {
    writeNativeVerifiedFile({
      bytes: input.bytes,
      expectedHash: input.baselineHash,
      pathSegments: input.pathSegments,
      sandboxRoot: input.workspaceRoot,
    });
  } catch {
    throw new WorkspaceError(
      "WORKSPACE_BROWSE_UNAVAILABLE",
      "Verified workspace write is unavailable.",
    );
  }
}

export async function mergeWorkspaceEdit<Handle>(
  databasePath: string,
  projectId: string,
  sessionId: string,
  input: { expectedVersion: number; operationId: string; stagedHash: string },
  runtime: WorkspaceEditRuntime<Handle>,
): Promise<WorkspaceEditSession> {
  const id = validateSessionId(sessionId);
  const operationId = validateOperationId(input.operationId);
  if (!/^[0-9a-f]{64}$/u.test(input.stagedHash)) {
    throw new WorkspaceError("INVALID_INPUT", "Workspace edit input is invalid.", [
      { field: "stagedHash", code: "invalid_format" },
    ]);
  }
  if (typeof runtime.fs.writeNativeVerifiedFile !== "function") {
    throw new WorkspaceError(
      "WORKSPACE_BROWSE_UNAVAILABLE",
      "Verified workspace write is unavailable.",
    );
  }
  const current = loadSessionRow(databasePath, projectId, id);
  assertVersion(current, input.expectedVersion);
  const workspaceRoot = boundWorkspaceRoot(databasePath, projectId);
  const pathSegments = workspaceEditPathSegments(current.relativePath);
  const draftBytes = readFileSync(draftFilePath(runtime.editRoot, current.id, current.relativePath));
  if (sha256(draftBytes) !== input.stagedHash) {
    throw new WorkspaceError("RESOURCE_CONFLICT", "Workspace edit staged hash does not match.");
  }
  const occurredAt = clock();
  const database = openDatabase(databasePath);
  try {
    database.exec("BEGIN IMMEDIATE");
    const replay = database
      .prepare(`
        SELECT id, relative_path AS relativePath, status, baseline_hash AS baselineHash,
               staged_hash AS stagedHash, version
        FROM workspace_edit_sessions
        WHERE project_id=? AND latest_operation_id=?
      `)
      .get(projectId, operationId) as SessionRow | undefined;
    if (replay?.status === "merged") {
      database.exec("COMMIT");
      return toSession(replay);
    }
    const approval = database
      .prepare(`
        SELECT id FROM workspace_edit_approvals
        WHERE project_id=? AND session_id=? AND staged_hash=? AND status='approved'
      `)
      .get(projectId, id, input.stagedHash) as { id: string } | undefined;
    if (!approval || current.stagedHash !== input.stagedHash) {
      throw new WorkspaceError("RESOURCE_CONFLICT", "Workspace edit has no approved merge.");
    }
    const locked = database.prepare(`
      UPDATE workspace_edit_sessions
      SET status='merging', updated_at=?
      WHERE project_id=? AND id=? AND version=? AND status IN ('staged','awaiting_approval','merging')
    `).run(occurredAt, projectId, id, input.expectedVersion);
    if (locked.changes !== 1) {
      throw new WorkspaceError("RESOURCE_CONFLICT", "Workspace edit is stale.");
    }
    try {
      applyVerifiedCanonicalWrite(runtime, {
        baselineHash: current.baselineHash,
        bytes: draftBytes,
        pathSegments,
        workspaceRoot,
      });
    } catch (error) {
      const canonical = await readVerifiedWorkspaceTextFile({
        fs: runtime.fs,
        relativePath: current.relativePath,
        workspaceRoot,
      });
      if (sha256(canonical.bytes) !== input.stagedHash) {
        if (error instanceof WorkspaceError) throw error;
        throw new WorkspaceError("RESOURCE_CONFLICT", "Workspace edit is stale.");
      }
    }
    database.prepare(`
      UPDATE workspace_edit_approvals
      SET status='consumed', updated_at=?
      WHERE id=? AND status='approved'
    `).run(occurredAt, approval.id);
    database.prepare(`
      INSERT INTO workspace_edit_merge_journals(
        id, project_id, session_id, approval_id, operation_id, staged_hash, status, created_at
      ) VALUES (?,?,?,?,?,?,'completed',?)
    `).run(randomUUID(), projectId, id, approval.id, operationId, input.stagedHash, occurredAt);
    database.prepare(`
      UPDATE workspace_edit_sessions
      SET status='merged', version=version+1, latest_operation_id=?, updated_at=?
      WHERE project_id=? AND id=? AND version=?
    `).run(operationId, occurredAt, projectId, id, input.expectedVersion);
    const row = database
      .prepare(`
        SELECT id, relative_path AS relativePath, status, baseline_hash AS baselineHash,
               staged_hash AS stagedHash, version
        FROM workspace_edit_sessions
        WHERE project_id=? AND id=?
      `)
      .get(projectId, id) as SessionRow;
    database.exec("COMMIT");
    return toSession(row);
  } catch (error) {
    if (database.isTransaction) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Preserve the original failure.
      }
    }
    throw error;
  } finally {
    database.close();
  }
}
