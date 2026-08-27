import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { consumeApprovedApprovalById } from "@/src/adapters/outbound/sqlite/governance/approval-store";
import { appendExecutionAuditOutboxRow } from "@/src/adapters/outbound/sqlite/safe-execution/audit-event-outbox";
import { ExecutionError } from "@/src/modules/safe-execution";
import type { RecoveryExecuteInput, RecoveryExecuteResponse } from "@/src/modules/safe-execution";
import {
  previewRecoveryAction,
  recoveryActionsFor,
  recoveryCatalogEntry,
  RECOVERY_CONFIRM_EXECUTE,
  RECOVERY_CONFIRM_UNDO,
} from "@/src/modules/safe-execution";

export type RecoveryAction = {
  approvalRequired: boolean;
  id: string;
  reversible: boolean;
  title: string;
};

export { previewRecoveryAction, recoveryActionsFor };

export function listRecoveryActions(
  databasePath: string,
  projectId: string,
  executionId: string,
): RecoveryAction[] {
  const database = openDatabase(databasePath);
  try {
    const project = database.prepare("SELECT 1 AS found FROM projects WHERE id=?").get(projectId);
    if (project === undefined) {
      throw new ExecutionError("PROJECT_NOT_FOUND", 404, "Project was not found.");
    }
    const execution = database.prepare(`
      SELECT status,reason_code AS reasonCode
      FROM executions
      WHERE project_id=? AND id=?
    `).get(projectId, executionId) as
      | { reasonCode: string | null; status: string }
      | undefined;
    if (execution === undefined) return [];
    return recoveryActionsFor(execution.status, execution.reasonCode);
  } finally {
    database.close();
  }
}

function catalogEntry(actionId: string) {
  return recoveryCatalogEntry(actionId);
}

function requestHash(
  projectId: string,
  executionId: string,
  input: RecoveryExecuteInput,
): string {
  return createHash("sha256")
    .update(JSON.stringify({
      actionId: input.actionId,
      confirmation: input.confirmation,
      executionId,
      expectedVersion: input.expectedVersion,
      projectId,
    }))
    .digest("hex");
}

function requireProject(database: DatabaseSync, projectId: string): void {
  const project = database.prepare("SELECT 1 AS found FROM projects WHERE id=?").get(projectId);
  if (project === undefined) {
    throw new ExecutionError("PROJECT_NOT_FOUND", 404, "Project was not found.");
  }
}

function loadExecution(
  database: DatabaseSync,
  projectId: string,
  executionId: string,
): {
  attemptNo: number;
  reasonCode: string | null;
  sequence: number;
  status: string;
  version: number;
} {
  const execution = database.prepare(`
    SELECT status,reason_code AS reasonCode,version,
           current_attempt_no AS attemptNo,
           next_event_sequence AS sequence
    FROM executions
    WHERE project_id=? AND id=?
  `).get(projectId, executionId) as
    | {
      attemptNo: number;
      reasonCode: string | null;
      sequence: number;
      status: string;
      version: number;
    }
    | undefined;
  if (execution === undefined) {
    throw new ExecutionError("EXECUTION_NOT_FOUND", 404, "Execution was not found.");
  }
  return execution;
}

function replayOrUndefined(
  database: DatabaseSync,
  projectId: string,
  operationId: string,
  hash: string,
): RecoveryExecuteResponse | undefined {
  const stored = database.prepare(`
    SELECT kind,request_hash AS requestHash,status,http_status AS httpStatus,
           response_json AS responseJson
    FROM execution_operations
    WHERE project_id=? AND id=?
  `).get(projectId, operationId) as
    | {
      httpStatus: number | null;
      kind: string;
      requestHash: string;
      responseJson: string | null;
      status: string;
    }
    | undefined;
  if (stored === undefined) return undefined;
  if (stored.kind !== "recover" || stored.requestHash !== hash) {
    throw new ExecutionError(
      "OPERATION_CONFLICT",
      409,
      "Operation id was already used for different input.",
    );
  }
  if (stored.status !== "completed" || stored.httpStatus === null || stored.responseJson === null) {
    throw new ExecutionError("OPERATION_IN_PROGRESS", 409, "Operation is still in progress.");
  }
  return JSON.parse(stored.responseJson) as RecoveryExecuteResponse;
}

function persistReceipt(
  database: DatabaseSync,
  input: {
    executionId: string;
    hash: string;
    operationId: string;
    projectId: string;
    response: RecoveryExecuteResponse;
  },
): void {
  database.prepare(`
    INSERT INTO execution_operations (
      id,project_id,execution_id,kind,request_hash,has_external_actions,
      action_count,final_action_index,status,http_status,response_json,created_at,updated_at
    ) VALUES (?, ?, ?, 'recover', ?, 0, 0, NULL, 'completed', 200, ?,
      strftime('%Y-%m-%dT%H:%M:%fZ','now'),
      strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  `).run(
    input.operationId,
    input.projectId,
    input.executionId,
    input.hash,
    JSON.stringify(input.response),
  );
}

function requireMatchingApproval(
  database: DatabaseSync,
  projectId: string,
  executionId: string,
  actionId: string,
): string {
  const row = database.prepare(`
    SELECT id FROM execution_approvals
    WHERE project_id=? AND execution_id=? AND status='approved'
      AND json_extract(public_request_json,'$.actionId')=?
    LIMIT 1
  `).get(projectId, executionId, actionId) as { id: string } | undefined;
  if (row === undefined) {
    throw new ExecutionError(
      "APPROVAL_REQUIRED",
      409,
      "Recovery action requires an unconsumed approval.",
    );
  }
  return row.id;
}

function applyAction(
  database: DatabaseSync,
  projectId: string,
  executionId: string,
  expectedVersion: number,
  actionId: string,
): string {
  if (actionId === "resume_queued") {
    const update = database.prepare(`
      UPDATE executions
      SET status='queued',resume_target=NULL,reason_code=NULL,
          version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE project_id=? AND id=? AND version=?
        AND status='stale' AND reason_code='STALE_EXECUTION'
    `).run(projectId, executionId, expectedVersion);
    if (update.changes !== 1) {
      throw new ExecutionError("VERSION_CONFLICT", 409, "Execution version changed.");
    }
    return "queued";
  }
  if (actionId === "abandon_unverified") {
    const update = database.prepare(`
      UPDATE executions
      SET status='stopped',reason_code=NULL,recovery_resolution='abandoned',
          version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE project_id=? AND id=? AND version=?
        AND status='paused' AND reason_code='SANDBOX_UNVERIFIABLE'
    `).run(projectId, executionId, expectedVersion);
    if (update.changes !== 1) {
      throw new ExecutionError("VERSION_CONFLICT", 409, "Execution version changed.");
    }
    return "stopped";
  }
  if (actionId === "resolve_merge_old" || actionId === "resolve_merge_new") {
    const recovered = actionId === "resolve_merge_old" ? "recovered_old" : "recovered_new";
    const toStatus = actionId === "resolve_merge_old" ? "conflicted" : "merged";
    const mergedAt = actionId === "resolve_merge_new"
      ? "strftime('%Y-%m-%dT%H:%M:%fZ','now')"
      : "NULL";
    const update = database.prepare(`
      UPDATE executions
      SET status=?,manual_recovery_required=0,recovery_resolution=?,
          reason_code=NULL,merged_at=${mergedAt},
          version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE project_id=? AND id=? AND version=?
        AND status='conflicted' AND manual_recovery_required=1
    `).run(toStatus, recovered, projectId, executionId, expectedVersion);
    if (update.changes !== 1) {
      throw new ExecutionError("VERSION_CONFLICT", 409, "Execution version changed.");
    }
    database.prepare(`
      UPDATE execution_merge_journals
      SET status=?,error_code=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE project_id=? AND execution_id=? AND status='manual_recovery'
    `).run(
      actionId === "resolve_merge_old" ? "resolved_old" : "resolved_new",
      projectId,
      executionId,
    );
    return toStatus;
  }
  throw new ExecutionError("INVALID_INPUT", 400, "Unknown recovery action.");
}

function appendRecoveryEvent(
  database: DatabaseSync,
  input: {
    actionId: string;
    attemptNo: number;
    executionId: string;
    fromStatus: string;
    projectId: string;
    sequence: number;
    toStatus: string;
  },
): void {
  const eventId = randomUUID();
  const payload = {
    actionId: input.actionId,
    from: input.fromStatus,
    to: input.toStatus,
  };
  database.prepare(`
    INSERT INTO execution_events (
      id,project_id,execution_id,sequence,attempt_no,type,actor_type,actor_id,
      payload_json,created_at
    ) VALUES (?, ?, ?, ?, ?, 'recovery_executed', 'owner', NULL, ?,
      strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  `).run(
    eventId,
    input.projectId,
    input.executionId,
    input.sequence,
    input.attemptNo,
    JSON.stringify(payload),
  );
  database.prepare(`
    UPDATE executions SET next_event_sequence=next_event_sequence+1 WHERE id=?
  `).run(input.executionId);
  appendExecutionAuditOutboxRow(database, {
    actorId: null,
    actorType: "owner",
    attemptNo: input.attemptNo,
    eventId,
    eventType: "recovery_executed",
    executionId: input.executionId,
    projectId: input.projectId,
    sourcePayload: payload,
  });
}

export function executeRecoveryAction(
  databasePath: string,
  projectId: string,
  executionId: string,
  input: RecoveryExecuteInput,
): RecoveryExecuteResponse {
  if (input.confirmation !== RECOVERY_CONFIRM_EXECUTE) {
    throw new ExecutionError("INVALID_INPUT", 400, "Recovery confirmation is invalid.");
  }
  catalogEntry(input.actionId);
  const hash = requestHash(projectId, executionId, input);
  const database = openDatabase(databasePath);
  try {
    requireProject(database, projectId);
    const replayed = replayOrUndefined(database, projectId, input.operationId, hash);
    if (replayed !== undefined) return replayed;
    const execution = loadExecution(database, projectId, executionId);
    if (execution.version !== input.expectedVersion) {
      throw new ExecutionError("VERSION_CONFLICT", 409, "Execution version changed.");
    }
    const applicable = recoveryActionsFor(execution.status, execution.reasonCode)
      .find((action) => action.id === input.actionId);
    if (applicable === undefined) {
      throw new ExecutionError("INVALID_INPUT", 400, "Recovery action does not apply.");
    }
    let approvalId: string | undefined;
    if (applicable.approvalRequired) {
      approvalId = requireMatchingApproval(database, projectId, executionId, input.actionId);
    }
    database.exec("BEGIN");
    try {
      const toStatus = applyAction(
        database,
        projectId,
        executionId,
        input.expectedVersion,
        input.actionId,
      );
      if (approvalId !== undefined) {
        const consumed = consumeApprovedApprovalById(database, approvalId);
        if (consumed.changes !== 1) {
          throw new ExecutionError(
            "APPROVAL_REQUIRED",
            409,
            "Recovery action requires an unconsumed approval.",
          );
        }
      }
      appendRecoveryEvent(database, {
        actionId: input.actionId,
        attemptNo: execution.attemptNo,
        executionId,
        fromStatus: execution.status,
        projectId,
        sequence: execution.sequence,
        toStatus,
      });
      const response: RecoveryExecuteResponse = {
        actionId: input.actionId,
        executionId,
        fromStatus: execution.status,
        toStatus,
        version: input.expectedVersion + 1,
        writesFiles: false,
      };
      persistReceipt(database, {
        executionId,
        hash,
        operationId: input.operationId,
        projectId,
        response,
      });
      database.exec("COMMIT");
      return response;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
}

export function undoRecoveryAction(
  databasePath: string,
  projectId: string,
  executionId: string,
  input: RecoveryExecuteInput,
): RecoveryExecuteResponse {
  const entry = catalogEntry(input.actionId);
  if (!entry.reversible) {
    throw new ExecutionError("INVALID_INPUT", 400, "Recovery action is not reversible.");
  }
  if (input.confirmation !== RECOVERY_CONFIRM_UNDO) {
    throw new ExecutionError("INVALID_INPUT", 400, "Recovery confirmation is invalid.");
  }
  const database = openDatabase(databasePath);
  try {
    requireProject(database, projectId);
    loadExecution(database, projectId, executionId);
  } finally {
    database.close();
  }
  throw new ExecutionError("INVALID_INPUT", 400, "Recovery action is not reversible.");
}
