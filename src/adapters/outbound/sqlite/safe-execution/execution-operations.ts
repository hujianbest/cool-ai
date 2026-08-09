import type { DatabaseSync } from "node:sqlite";

import { ExecutionError } from "@/src/modules/safe-execution";

const TERMINAL_ACTION_STATUSES = [
  "succeeded",
  "failed",
  "interrupted",
  "discarded",
] as const;

type TerminalActionStatus = (typeof TERMINAL_ACTION_STATUSES)[number];
type OperationKind =
  | "start"
  | "start_resume"
  | "advance"
  | "approve"
  | "reject"
  | "revoke"
  | "replace_request"
  | "pause"
  | "continue"
  | "retry"
  | "stop"
  | "stage"
  | "merge"
  | "resolve_manual"
  | "policy_update"
  | "recover";
type ActionKind =
  | "sandbox_build"
  | "model"
  | "file_list"
  | "file_read"
  | "file_write"
  | "command"
  | "stage_compute"
  | "merge_apply"
  | "merge_recover"
  | "manual_resolution";
type PublicEnvelopeSchema<T> = { parse(value: unknown): T };
type CompletedOperation<T> = { body: T; status: number };

type OperationRow = {
  actionCount: number;
  executionId: string | null;
  httpStatus: number | null;
  kind: OperationKind;
  requestHash: string;
  responseJson: string | null;
  status: "pending" | "completed";
};

function transaction<T>(database: DatabaseSync, operation: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the stable operation error.
    }
    throw error;
  }
}

function operationRow(
  database: DatabaseSync,
  projectId: string,
  operationId: string,
): OperationRow | undefined {
  return database.prepare(
    `SELECT execution_id AS executionId,kind,request_hash AS requestHash,
            action_count AS actionCount,status,http_status AS httpStatus,
            response_json AS responseJson
     FROM execution_operations WHERE project_id=? AND id=?`,
  ).get(projectId, operationId) as OperationRow | undefined;
}

function assertIdentity(
  row: OperationRow,
  kind: OperationKind,
  requestHash: string,
): void {
  if (row.kind !== kind || row.requestHash !== requestHash) {
    throw new ExecutionError(
      "OPERATION_CONFLICT",
      409,
      "Operation id was already used for different input.",
    );
  }
}

function completedBody<T>(
  row: OperationRow,
  responseSchema: PublicEnvelopeSchema<T>,
): CompletedOperation<T> {
  if (row.status !== "completed" || row.httpStatus === null || row.responseJson === null) {
    throw new ExecutionError("OPERATION_IN_PROGRESS", 409, "Operation is still in progress.");
  }
  return {
    body: responseSchema.parse(JSON.parse(row.responseJson)),
    status: row.httpStatus,
  };
}

function serialized(value: unknown, label: string): string {
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json, "utf8") > 262_144) {
    throw new ExecutionError(
      "RESPONSE_LIMIT_EXCEEDED",
      413,
      `${label} exceeds the operation storage limit.`,
    );
  }
  return json;
}

export function readExecutionOperation<T>(
  database: DatabaseSync,
  input: {
    kind: OperationKind;
    operationId: string;
    projectId: string;
    requestHash: string;
    responseSchema: PublicEnvelopeSchema<T>;
  },
): CompletedOperation<T> | null {
  const row = operationRow(database, input.projectId, input.operationId);
  if (!row) return null;
  assertIdentity(row, input.kind, input.requestHash);
  return completedBody(row, input.responseSchema);
}

export function beginExternalOperation(
  database: DatabaseSync,
  input: {
    action: {
      actionId: string;
      attemptId: string;
      kind: ActionKind;
      overallDeadlineAt: string;
      requestHash: string;
    };
    executionId: string;
    kind: OperationKind;
    operationId: string;
    projectId: string;
    requestHash: string;
    responseSchema: PublicEnvelopeSchema<unknown>;
    timestamp: string;
  },
): { actionIndex: number; status: "pending" } | CompletedOperation<unknown> {
  return transaction(database, () => {
    const existing = operationRow(database, input.projectId, input.operationId);
    if (existing) {
      assertIdentity(existing, input.kind, input.requestHash);
      if (
        existing.status === "completed"
        && existing.httpStatus !== null
        && existing.responseJson !== null
      ) {
        return {
          body: input.responseSchema.parse(JSON.parse(existing.responseJson)),
          status: existing.httpStatus,
        };
      }
      throw new ExecutionError("OPERATION_IN_PROGRESS", 409, "Operation is still in progress.");
    }

    if (input.kind === "advance") {
      const sameExecution = database.prepare(`
        SELECT 1 FROM execution_actions
        WHERE execution_id=? AND status IN ('pending','running') LIMIT 1
      `).get(input.executionId);
      if (sameExecution) {
        throw new ExecutionError(
          "OPERATION_IN_PROGRESS",
          409,
          "Execution already has an active action.",
        );
      }
      const activeExecutions = Number((database.prepare(`
        SELECT COUNT(DISTINCT execution_id) AS count
        FROM execution_actions
        WHERE project_id=? AND status IN ('pending','running')
      `).get(input.projectId) as { count: number }).count);
      if (activeExecutions >= 2) {
        throw new ExecutionError(
          "OPERATION_IN_PROGRESS",
          409,
          "Two execution actions are already active for this project.",
        );
      }
    }

    database.prepare(
      `INSERT INTO execution_operations (
         id,project_id,execution_id,kind,request_hash,has_external_actions,
         action_count,final_action_index,status,http_status,response_json,created_at,updated_at
       ) VALUES (?, ?, ?, ?, ?, 1, 1, NULL, 'pending', NULL, NULL, ?, ?)`,
    ).run(
      input.operationId,
      input.projectId,
      input.executionId,
      input.kind,
      input.requestHash,
      input.timestamp,
      input.timestamp,
    );
    database.prepare(
      `INSERT INTO execution_actions (
         id,project_id,execution_id,attempt_id,operation_id,action_index,kind,status,
         request_hash,lease_token,lease_expires_at,overall_deadline_at,
         last_heartbeat_at,result_json,error_code,created_at,started_at,finished_at
       ) VALUES (?, ?, ?, ?, ?, 0, ?, 'pending', ?, NULL, NULL, ?, NULL, NULL, NULL, ?, NULL, NULL)`,
    ).run(
      input.action.actionId,
      input.projectId,
      input.executionId,
      input.action.attemptId,
      input.operationId,
      input.action.kind,
      input.action.requestHash,
      input.action.overallDeadlineAt,
      input.timestamp,
    );
    return { actionIndex: 0, status: "pending" };
  });
}

export function acquireOperationAction(
  database: DatabaseSync,
  input: {
    actionIndex: number;
    leaseExpiresAt: string;
    leaseToken: string;
    operationId: string;
    projectId: string;
    startedAt: string;
  },
): { actionIndex: number; status: "running" } {
  return transaction(database, () => {
    const result = database.prepare(
      `UPDATE execution_actions AS target
       SET status='running',lease_token=?,lease_expires_at=?,
           last_heartbeat_at=?,started_at=coalesce(started_at,?)
       WHERE target.project_id=? AND target.operation_id=?
         AND target.action_index=? AND target.status='pending'
         AND EXISTS (
           SELECT 1 FROM execution_operations o
           WHERE o.project_id=target.project_id AND o.id=target.operation_id
             AND o.status='pending' AND o.action_count>target.action_index
         )
         AND NOT EXISTS (
           SELECT 1 FROM execution_actions prior
           WHERE prior.project_id=target.project_id
             AND prior.operation_id=target.operation_id
             AND prior.action_index<target.action_index
             AND prior.status NOT IN ('succeeded','failed','interrupted','discarded')
         )
         AND NOT EXISTS (
           SELECT 1 FROM execution_actions running
           WHERE running.execution_id=target.execution_id AND running.status='running'
         )`,
    ).run(
      input.leaseToken,
      input.leaseExpiresAt,
      input.startedAt,
      input.startedAt,
      input.projectId,
      input.operationId,
      input.actionIndex,
    );
    if (result.changes !== 1) {
      throw new ExecutionError(
        "OPERATION_IN_PROGRESS",
        409,
        "Action could not be acquired in the requested sequence.",
      );
    }
    return { actionIndex: input.actionIndex, status: "running" };
  });
}

export function appendOperationAction(
  database: DatabaseSync,
  input: {
    actionId: string;
    attemptId: string;
    executionId: string;
    kind: ActionKind;
    operationId: string;
    overallDeadlineAt: string;
    projectId: string;
    requestHash: string;
    timestamp: string;
  },
): { actionIndex: number; status: "pending" } {
  return transaction(database, () => {
    const parent = operationRow(database, input.projectId, input.operationId);
    if (
      !parent
      || parent.status !== "pending"
      || parent.executionId !== input.executionId
      || parent.actionCount >= 16
    ) {
      throw new ExecutionError(
        "EXECUTION_STATE_CONFLICT",
        409,
        "Operation cannot append another child action.",
      );
    }
    const previous = database.prepare(
      `SELECT status FROM execution_actions
       WHERE project_id=? AND operation_id=? AND action_index=?`,
    ).get(input.projectId, input.operationId, parent.actionCount - 1) as
      | { status: string }
      | undefined;
    if (!previous || !TERMINAL_ACTION_STATUSES.includes(previous.status as TerminalActionStatus)) {
      throw new ExecutionError(
        "EXECUTION_STATE_CONFLICT",
        409,
        "The previous child action is not terminal.",
      );
    }
    insertPendingAction(database, {
      ...input,
      actionIndex: parent.actionCount,
    });
    const updated = database.prepare(
      `UPDATE execution_operations SET action_count=action_count+1,updated_at=?
       WHERE project_id=? AND id=? AND status='pending' AND action_count=?`,
    ).run(input.timestamp, input.projectId, input.operationId, parent.actionCount);
    if (updated.changes !== 1) {
      throw new ExecutionError(
        "EXECUTION_STATE_CONFLICT",
        409,
        "Operation child count changed concurrently.",
      );
    }
    return { actionIndex: parent.actionCount, status: "pending" };
  });
}

function insertPendingAction(
  database: DatabaseSync,
  input: {
    actionId: string;
    actionIndex: number;
    attemptId: string;
    executionId: string;
    kind: ActionKind;
    operationId: string;
    overallDeadlineAt: string;
    projectId: string;
    requestHash: string;
    timestamp: string;
  },
): void {
  database.prepare(
    `INSERT INTO execution_actions (
       id,project_id,execution_id,attempt_id,operation_id,action_index,kind,status,
       request_hash,lease_token,lease_expires_at,overall_deadline_at,
       last_heartbeat_at,result_json,error_code,created_at,started_at,finished_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, NULL, ?, NULL, NULL, NULL, ?, NULL, NULL)`,
  ).run(
    input.actionId,
    input.projectId,
    input.executionId,
    input.attemptId,
    input.operationId,
    input.actionIndex,
    input.kind,
    input.requestHash,
    input.overallDeadlineAt,
    input.timestamp,
  );
}

function finalizeChild(
  database: DatabaseSync,
  input: {
    actionIndex: number;
    leaseToken: string;
    operationId: string;
    projectId: string;
    result: unknown;
    status: TerminalActionStatus;
    timestamp: string;
  },
): void {
  const result = database.prepare(
    `UPDATE execution_actions
     SET status=?,lease_token=NULL,lease_expires_at=NULL,result_json=?,
         error_code=NULL,finished_at=?
     WHERE project_id=? AND operation_id=? AND action_index=?
       AND status='running' AND lease_token=?`,
  ).run(
    input.status,
    serialized(input.result, "Action result"),
    input.timestamp,
    input.projectId,
    input.operationId,
    input.actionIndex,
    input.leaseToken,
  );
  if (result.changes !== 1) {
    throw new ExecutionError("ACTION_LEASE_LOST", 409, "Action finalization lost its lease.");
  }
}

export function finishOperationActionAndAppend(
  database: DatabaseSync,
  input: {
    actionIndex: number;
    leaseToken: string;
    nextAction: {
      actionId: string;
      attemptId: string;
      kind: ActionKind;
      overallDeadlineAt: string;
      requestHash: string;
    };
    operationId: string;
    projectId: string;
    result: unknown;
    status: TerminalActionStatus;
    timestamp: string;
  },
): { actionIndex: number; status: "pending" } {
  return transaction(database, () => {
    const parent = operationRow(database, input.projectId, input.operationId);
    if (
      !parent
      || parent.status !== "pending"
      || parent.executionId === null
      || parent.actionCount !== input.actionIndex + 1
      || parent.actionCount >= 16
    ) {
      throw new ExecutionError(
        "EXECUTION_STATE_CONFLICT",
        409,
        "Operation cannot advance to the next child action.",
      );
    }
    finalizeChild(database, input);
    insertPendingAction(database, {
      ...input.nextAction,
      actionIndex: parent.actionCount,
      executionId: parent.executionId,
      operationId: input.operationId,
      projectId: input.projectId,
      timestamp: input.timestamp,
    });
    const updated = database.prepare(
      `UPDATE execution_operations SET action_count=action_count+1,updated_at=?
       WHERE project_id=? AND id=? AND status='pending' AND action_count=?`,
    ).run(input.timestamp, input.projectId, input.operationId, parent.actionCount);
    if (updated.changes !== 1) {
      throw new ExecutionError(
        "EXECUTION_STATE_CONFLICT",
        409,
        "Operation child count changed concurrently.",
      );
    }
    return { actionIndex: parent.actionCount, status: "pending" };
  });
}

export function finalizeOperationAction<T>(
  database: DatabaseSync,
  input: {
    actionIndex: number;
    body: T;
    httpStatus: number;
    leaseToken: string;
    operationId: string;
    projectId: string;
    responseSchema: PublicEnvelopeSchema<T>;
    result: unknown;
    status: TerminalActionStatus;
    timestamp: string;
  },
): CompletedOperation<T> {
  const publicBody = input.responseSchema.parse(input.body);
  const responseJson = serialized(publicBody, "Public response");
  return transaction(database, () => {
    const parent = operationRow(database, input.projectId, input.operationId);
    if (!parent) {
      throw new ExecutionError("OPERATION_CONFLICT", 409, "Operation does not exist.");
    }
    if (parent.status === "completed") {
      return completedBody(parent, input.responseSchema);
    }
    if (parent.actionCount !== input.actionIndex + 1) {
      throw new ExecutionError(
        "EXECUTION_STATE_CONFLICT",
        409,
        "Only the final child action can complete its parent operation.",
      );
    }
    finalizeChild(database, input);
    const completed = database.prepare(
      `UPDATE execution_operations
       SET status='completed',final_action_index=?,http_status=?,response_json=?,updated_at=?
       WHERE project_id=? AND id=? AND status='pending' AND action_count=?
         AND NOT EXISTS (
           SELECT 1 FROM execution_actions a
           WHERE a.project_id=execution_operations.project_id
             AND a.operation_id=execution_operations.id
             AND a.status IN ('pending','running')
         )`,
    ).run(
      input.actionIndex,
      input.httpStatus,
      responseJson,
      input.timestamp,
      input.projectId,
      input.operationId,
      input.actionIndex + 1,
    );
    if (completed.changes !== 1) {
      throw new ExecutionError(
        "EXECUTION_STATE_CONFLICT",
        409,
        "Parent operation could not be completed at this child.",
      );
    }
    return { body: publicBody, status: input.httpStatus };
  });
}
