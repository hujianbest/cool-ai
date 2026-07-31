import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { ExecutionError } from "@/src/server/execution/execution-service";

type CasResult = { affectedRows: 0 | 1 };
type TerminalStatus = "succeeded" | "failed";

const DB_NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const DB_LEASE_END = "strftime('%Y-%m-%dT%H:%M:%fZ','now','+120 seconds')";

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
      // Preserve the stable action error.
    }
    throw error;
  }
}

function serialize(value: unknown, label: string): string {
  const json = JSON.stringify(value);
  if (json === undefined || Buffer.byteLength(json, "utf8") > 262_144) {
    throw new ExecutionError(
      "RESPONSE_LIMIT_EXCEEDED",
      413,
      `${label} exceeds the action storage limit.`,
    );
  }
  return json;
}

type PendingActionRow = {
  executionId: string;
  kind: string;
  status: string;
};

export function acquireExecutionAction(
  database: DatabaseSync,
  input: {
    actionIndex: number;
    operationId: string;
    projectId: string;
  },
): { affectedRows: 0 | 1; leaseToken: string | null } {
  return transaction(database, () => {
    const action = database.prepare(`
      SELECT a.execution_id AS executionId,a.kind,a.status
      FROM execution_actions a
      JOIN execution_operations o
        ON o.project_id=a.project_id AND o.id=a.operation_id
      JOIN executions e
        ON e.project_id=a.project_id AND e.id=a.execution_id
      WHERE a.project_id=? AND a.operation_id=? AND a.action_index=?
        AND a.status='pending' AND o.status='pending'
        AND a.overall_deadline_at>${DB_NOW}
        AND (
          a.kind='sandbox_build'
          OR (
            e.status IN ('queued','running')
            AND (e.business_deadline_at IS NULL OR e.business_deadline_at>${DB_NOW})
          )
        )
    `).get(input.projectId, input.operationId, input.actionIndex) as
      | PendingActionRow
      | undefined;
    if (!action) return { affectedRows: 0, leaseToken: null };

    if (action.kind !== "sandbox_build") {
      const execution = database.prepare(`
        UPDATE executions
        SET status='running',
            first_running_at=coalesce(first_running_at,${DB_NOW}),
            business_deadline_at=coalesce(
              business_deadline_at,
              strftime('%Y-%m-%dT%H:%M:%fZ','now','+900 seconds')
            ),
            updated_at=${DB_NOW},
            version=version+1
        WHERE project_id=? AND id=? AND status='queued'
          AND (
            (first_running_at IS NULL AND business_deadline_at IS NULL)
            OR (
              first_running_at IS NOT NULL
              AND business_deadline_at>${DB_NOW}
            )
          )
      `).run(input.projectId, action.executionId);
      if (execution.changes !== 1) {
        const running = database.prepare(`
          SELECT 1 FROM executions
          WHERE project_id=? AND id=? AND status='running'
            AND first_running_at IS NOT NULL
            AND business_deadline_at>${DB_NOW}
        `).get(input.projectId, action.executionId);
        if (!running) return { affectedRows: 0, leaseToken: null };
      }
    }

    const leaseToken = randomUUID();
    const acquired = database.prepare(`
      UPDATE execution_actions AS target
      SET status='running',
          lease_token=?,
          lease_expires_at=min(${DB_LEASE_END},target.overall_deadline_at),
          last_heartbeat_at=${DB_NOW},
          started_at=coalesce(target.started_at,${DB_NOW})
      WHERE target.project_id=? AND target.operation_id=?
        AND target.action_index=? AND target.status='pending'
        AND target.overall_deadline_at>${DB_NOW}
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
          WHERE running.execution_id=target.execution_id
            AND running.status='running'
        )
    `).run(leaseToken, input.projectId, input.operationId, input.actionIndex);
    if (acquired.changes !== 1) {
      throw new ExecutionError(
        "OPERATION_IN_PROGRESS",
        409,
        "Action could not be acquired in the requested sequence.",
      );
    }
    return { affectedRows: 1, leaseToken };
  });
}

export function heartbeatExecutionAction(
  database: DatabaseSync,
  input: {
    actionId: string;
    leaseToken: string;
    projectId: string;
  },
): CasResult {
  return transaction(database, () => {
    const updated = database.prepare(`
      UPDATE execution_actions
      SET lease_expires_at=min(${DB_LEASE_END},overall_deadline_at),
          last_heartbeat_at=${DB_NOW}
      WHERE project_id=? AND id=? AND status='running' AND lease_token=?
        AND lease_expires_at>${DB_NOW}
        AND overall_deadline_at>${DB_NOW}
    `).run(input.projectId, input.actionId, input.leaseToken);
    return { affectedRows: updated.changes === 1 ? 1 : 0 };
  });
}

function completeReceipt(
  database: DatabaseSync,
  input: {
    actionId: string;
    bodyJson: string;
    httpStatus: number;
    projectId: string;
  },
): void {
  const completed = database.prepare(`
    UPDATE execution_operations
    SET status='completed',
        final_action_index=(
          SELECT action_index FROM execution_actions
          WHERE project_id=? AND id=?
        ),
        http_status=?,
        response_json=?,
        updated_at=${DB_NOW}
    WHERE project_id=?
      AND id=(
        SELECT operation_id FROM execution_actions
        WHERE project_id=? AND id=?
      )
      AND status='pending'
      AND action_count=(
        SELECT action_index+1 FROM execution_actions
        WHERE project_id=? AND id=?
      )
      AND NOT EXISTS (
        SELECT 1 FROM execution_actions pending
        WHERE pending.project_id=execution_operations.project_id
          AND pending.operation_id=execution_operations.id
          AND pending.status IN ('pending','running')
      )
  `).run(
    input.projectId,
    input.actionId,
    input.httpStatus,
    input.bodyJson,
    input.projectId,
    input.projectId,
    input.actionId,
    input.projectId,
    input.actionId,
  );
  if (completed.changes !== 1) {
    throw new ExecutionError(
      "EXECUTION_STATE_CONFLICT",
      409,
      "The terminal action could not complete its parent receipt.",
    );
  }
}

export function finalizeExecutionAction(
  database: DatabaseSync,
  input: {
    actionId: string;
    body: unknown;
    httpStatus: number;
    leaseToken: string;
    projectId: string;
    result: unknown;
    status: TerminalStatus;
  },
): CasResult {
  return finalizeExecutionActionWithEffects(database, input);
}

export function finalizeExecutionActionWithEffects(
  database: DatabaseSync,
  input: {
    actionId: string;
    body: unknown;
    effects?: (database: DatabaseSync) => void;
    httpStatus: number;
    leaseToken: string;
    projectId: string;
    result: unknown;
    status: TerminalStatus;
  },
): CasResult {
  const bodyJson = serialize(input.body, "Public response");
  const resultJson = serialize(input.result, "Action result");
  return transaction(database, () => {
    const finalized = database.prepare(`
      UPDATE execution_actions
      SET status=?,lease_token=NULL,lease_expires_at=NULL,
          result_json=?,error_code=NULL,finished_at=${DB_NOW}
      WHERE project_id=? AND id=? AND status='running' AND lease_token=?
        AND lease_expires_at>${DB_NOW}
        AND overall_deadline_at>${DB_NOW}
    `).run(
      input.status,
      resultJson,
      input.projectId,
      input.actionId,
      input.leaseToken,
    );
    if (finalized.changes !== 1) return { affectedRows: 0 };
    input.effects?.(database);
    completeReceipt(database, {
      actionId: input.actionId,
      bodyJson,
      httpStatus: input.httpStatus,
      projectId: input.projectId,
    });
    return { affectedRows: 1 };
  });
}

export function reconcileExecutionAction(
  database: DatabaseSync,
  input: {
    actionId: string;
    body: unknown;
    errorCode: string;
    httpStatus: number;
    projectId: string;
  },
): CasResult {
  const bodyJson = serialize(input.body, "Public response");
  return transaction(database, () => {
    const reconciled = database.prepare(`
      UPDATE execution_actions
      SET status='interrupted',lease_token=NULL,lease_expires_at=NULL,
          result_json=NULL,error_code=?,finished_at=${DB_NOW}
      WHERE project_id=? AND id=? AND status='running'
        AND (lease_expires_at<=${DB_NOW} OR overall_deadline_at<=${DB_NOW})
    `).run(input.errorCode, input.projectId, input.actionId);
    if (reconciled.changes !== 1) return { affectedRows: 0 };
    completeReceipt(database, {
      actionId: input.actionId,
      bodyJson,
      httpStatus: input.httpStatus,
      projectId: input.projectId,
    });
    return { affectedRows: 1 };
  });
}

export function reconcileSandboxBuildAction(
  database: DatabaseSync,
  input: {
    actionId: string;
    body: unknown;
    cleanupConfirmed: boolean;
    httpStatus: number;
    projectId: string;
    reason: "SANDBOX_ACTION_INTERRUPTED" | "SANDBOX_BUILD_DEADLINE_EXCEEDED";
  },
): CasResult {
  const bodyJson = serialize(input.body, "Public response");
  return transaction(database, () => {
    const action = database.prepare(`
      SELECT execution_id AS executionId,attempt_id AS attemptId
      FROM execution_actions
      WHERE project_id=? AND id=? AND kind='sandbox_build' AND status='running'
        AND (lease_expires_at<=${DB_NOW} OR overall_deadline_at<=${DB_NOW})
    `).get(input.projectId, input.actionId) as
      | { attemptId: string; executionId: string }
      | undefined;
    if (!action) return { affectedRows: 0 };

    const interrupted = database.prepare(`
      UPDATE execution_actions
      SET status='interrupted',lease_token=NULL,lease_expires_at=NULL,
          result_json=NULL,error_code=?,finished_at=${DB_NOW}
      WHERE project_id=? AND id=? AND kind='sandbox_build' AND status='running'
        AND (lease_expires_at<=${DB_NOW} OR overall_deadline_at<=${DB_NOW})
    `).run(input.reason, input.projectId, input.actionId);
    if (interrupted.changes !== 1) return { affectedRows: 0 };

    const attemptStatus = input.cleanupConfirmed ? "interrupted" : "failed";
    const attempt = database.prepare(`
      UPDATE execution_attempts SET status=?,finished_at=${DB_NOW}
      WHERE project_id=? AND id=? AND execution_id=? AND status='preparing'
    `).run(attemptStatus, input.projectId, action.attemptId, action.executionId);
    if (attempt.changes !== 1) {
      throw new ExecutionError("EXECUTION_STATE_CONFLICT", 409, "Sandbox attempt could not be reconciled.");
    }

    const execution = input.cleanupConfirmed
      ? database.prepare(`
          UPDATE executions
          SET status='paused',resume_target='queued',reason_code=?,
              updated_at=${DB_NOW},version=version+1
          WHERE project_id=? AND id=? AND status='queued'
            AND first_running_at IS NULL AND business_deadline_at IS NULL
        `).run(input.reason, input.projectId, action.executionId)
      : database.prepare(`
          UPDATE executions
          SET status='failed',resume_target=NULL,reason_code=?,
              updated_at=${DB_NOW},version=version+1
          WHERE project_id=? AND id=? AND status='queued'
            AND first_running_at IS NULL AND business_deadline_at IS NULL
        `).run(input.reason, input.projectId, action.executionId);
    if (execution.changes !== 1) {
      throw new ExecutionError("EXECUTION_STATE_CONFLICT", 409, "Sandbox execution could not be reconciled.");
    }

    completeReceipt(database, {
      actionId: input.actionId,
      bodyJson,
      httpStatus: input.httpStatus,
      projectId: input.projectId,
    });
    return { affectedRows: 1 };
  });
}

export function discardExecutionAction(
  database: DatabaseSync,
  input: {
    actionId: string;
    body: unknown;
    httpStatus: number;
    projectId: string;
  },
): CasResult {
  const bodyJson = serialize(input.body, "Public response");
  return transaction(database, () => {
    const discarded = database.prepare(`
      UPDATE execution_actions
      SET status='discarded',lease_token=NULL,lease_expires_at=NULL,
          result_json=NULL,error_code=NULL,finished_at=${DB_NOW}
      WHERE project_id=? AND id=? AND status='running'
    `).run(input.projectId, input.actionId);
    if (discarded.changes !== 1) return { affectedRows: 0 };
    completeReceipt(database, {
      actionId: input.actionId,
      bodyJson,
      httpStatus: input.httpStatus,
      projectId: input.projectId,
    });
    return { affectedRows: 1 };
  });
}
