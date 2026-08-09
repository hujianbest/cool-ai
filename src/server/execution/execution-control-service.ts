import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { canonicalRequestHash } from "@/src/server/collaboration/operation-receipts";
import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { captureExecutionFrozenInput } from "@/src/server/execution/execution-frozen-input";
import {
  ExecutionError,
  executionDtoFromDatabase,
} from "@/src/server/execution/execution-service";
import { preExecutionBoundary } from "@/src/server/execution/execution-usage-budget";
import type { SandboxExecutor } from "@/src/server/execution/sandbox-executor";
import {
  executionControlInputSchema,
  executionControlResponseSchema,
  type ExecutionControlInput,
  type ExecutionControlResponse,
} from "@/src/shared/execution-contracts";

type ControlAction = ExecutionControlInput["action"];
type ControlResult = { body: ExecutionControlResponse; status: number };
export type ExecutionControlDependencies = {
  executionRoot: string;
  requestProcessTermination(actionId: string): boolean;
  sandboxExecutor: SandboxExecutor;
};

type ExecutionRow = {
  agentId: string;
  businessDeadlineAt: string | null;
  currentAttemptNo: number;
  currentPolicyRevisionId: string;
  manualRecoveryRequired: number;
  missionId: string;
  projectId: string;
  reasonCode: string | null;
  resumeTarget: "queued" | "running" | "waiting_approval" | null;
  sourceRunId: string;
  sourceThreadId: string;
  status: string;
  version: number;
  workItemId: string;
  workspacePath: string | null;
};

type StoredOperation = {
  httpStatus: number | null;
  kind: string;
  requestHash: string;
  responseJson: string | null;
  status: "completed" | "pending";
};

function transaction<T>(database: DatabaseSync, operation: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const value = operation();
    database.exec("COMMIT");
    return value;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the stable execution error.
    }
    throw error;
  }
}

function executionRow(database: DatabaseSync, executionId: string): ExecutionRow {
  const row = database.prepare(`
    SELECT e.project_id AS projectId,
           e.source_collaboration_thread_id AS sourceThreadId,
           e.source_collaboration_run_id AS sourceRunId,
           e.mission_id AS missionId,e.work_item_id AS workItemId,e.agent_id AS agentId,
           e.current_policy_revision_id AS currentPolicyRevisionId,e.status,
           e.resume_target AS resumeTarget,e.reason_code AS reasonCode,
           e.manual_recovery_required AS manualRecoveryRequired,
           e.current_attempt_no AS currentAttemptNo,e.version,
           e.business_deadline_at AS businessDeadlineAt,p.workspace_path AS workspacePath
    FROM executions e JOIN projects p ON p.id=e.project_id WHERE e.id=?
  `).get(executionId) as ExecutionRow | undefined;
  if (!row) {
    throw new ExecutionError("EXECUTION_NOT_FOUND", 404, "Execution was not found.");
  }
  return row;
}

function errorBody(error: ExecutionError): {
  error: { code: string; message: string };
} {
  return { error: { code: error.code, message: error.message } };
}

function operation(
  database: DatabaseSync,
  projectId: string,
  operationId: string,
): StoredOperation | undefined {
  return database.prepare(`
    SELECT kind,request_hash AS requestHash,status,http_status AS httpStatus,
           response_json AS responseJson
    FROM execution_operations WHERE project_id=? AND id=?
  `).get(projectId, operationId) as StoredOperation | undefined;
}

function readReceipt(
  row: StoredOperation,
  action: ControlAction,
  requestHash: string,
): ControlResult {
  if (row.kind !== action || row.requestHash !== requestHash) {
    throw new ExecutionError(
      "OPERATION_CONFLICT",
      409,
      "Operation id was already used for different input.",
    );
  }
  if (row.status !== "completed" || row.httpStatus === null || row.responseJson === null) {
    throw new ExecutionError("OPERATION_IN_PROGRESS", 409, "Operation is still in progress.");
  }
  const body = JSON.parse(row.responseJson) as unknown;
  const parsed = executionControlResponseSchema.safeParse(body);
  if (parsed.success) return { body: parsed.data, status: row.httpStatus };
  const persisted = body as { error?: { code?: unknown; message?: unknown } };
  if (
    typeof persisted.error?.code === "string"
    && typeof persisted.error.message === "string"
  ) {
    throw new ExecutionError(
      persisted.error.code,
      row.httpStatus,
      persisted.error.message,
    );
  }
  throw new ExecutionError("INTERNAL_ERROR", 500, "Stored control receipt is invalid.");
}

function insertCompletedReceipt(
  database: DatabaseSync,
  input: {
    action: ControlAction;
    body: unknown;
    executionId: string;
    httpStatus: number;
    operationId: string;
    projectId: string;
    requestHash: string;
  },
): void {
  const json = JSON.stringify(input.body);
  if (Buffer.byteLength(json, "utf8") > 262_144) {
    throw new ExecutionError("RESPONSE_LIMIT_EXCEEDED", 413, "Control response is too large.");
  }
  database.prepare(`
    INSERT INTO execution_operations (
      id,project_id,execution_id,kind,request_hash,has_external_actions,
      action_count,final_action_index,status,http_status,response_json,created_at,updated_at
    ) VALUES (
      ?,?,?,?,?,0,0,NULL,'completed',?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'),
      strftime('%Y-%m-%dT%H:%M:%fZ','now')
    )
  `).run(
    input.operationId,
    input.projectId,
    input.executionId,
    input.action,
    input.requestHash,
    input.httpStatus,
    json,
  );
}

function appendEvent(
  database: DatabaseSync,
  executionId: string,
  attemptNo: number,
  type: string,
  payload: unknown,
): void {
  const identity = database.prepare(`
    SELECT project_id AS projectId,next_event_sequence AS sequence
    FROM executions WHERE id=?
  `).get(executionId) as { projectId: string; sequence: number };
  database.prepare(`
    INSERT INTO execution_events (
      id,project_id,execution_id,sequence,attempt_no,type,actor_type,actor_id,
      payload_json,created_at
    ) VALUES (?,?,?,?,?,?,'owner',NULL,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  `).run(
    randomUUID(),
    identity.projectId,
    executionId,
    identity.sequence,
    attemptNo,
    type,
    JSON.stringify(payload),
  );
  const incremented = database.prepare(`
    UPDATE executions SET next_event_sequence=next_event_sequence+1
    WHERE id=? AND next_event_sequence=?
  `).run(executionId, identity.sequence);
  if (incremented.changes !== 1) {
    throw new ExecutionError("EXECUTION_STATE_CONFLICT", 409, "Execution event sequence changed.");
  }
}

function discardActiveWork(
  database: DatabaseSync,
  executionId: string,
  reason: "OWNER_PAUSED" | "OWNER_STOPPED" | "OWNER_RETRY",
): string[] {
  const actions = database.prepare(`
    SELECT id,operation_id AS operationId,kind FROM execution_actions
    WHERE execution_id=? AND status IN ('pending','running')
  `).all(executionId) as Array<{ id: string; kind: string; operationId: string }>;
  const body = errorBody(new ExecutionError(
    "EXECUTION_STATE_CONFLICT",
    409,
    reason === "OWNER_STOPPED"
      ? "Execution was stopped before the action completed."
      : "Execution was controlled before the action completed.",
  ));
  for (const action of actions) {
    database.prepare(`
      UPDATE execution_actions
      SET status='discarded',lease_token=NULL,lease_expires_at=NULL,result_json=NULL,
          error_code=?,finished_at=coalesce(finished_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      WHERE id=? AND execution_id=? AND status IN ('pending','running')
    `).run(reason, action.id, executionId);
    database.prepare(`
      UPDATE execution_operations
      SET status='completed',final_action_index=action_count-1,http_status=409,
          response_json=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id=? AND execution_id=? AND status='pending' AND action_count>0
    `).run(JSON.stringify(body), action.operationId, executionId);
  }
  database.prepare(`
    UPDATE execution_model_calls
    SET status='discarded',error_category=?,
        finished_at=coalesce(finished_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    WHERE execution_id=? AND status='calling'
  `).run(reason.toLowerCase(), executionId);
  database.prepare(`
    UPDATE execution_tool_calls
    SET status='discarded',
        finished_at=coalesce(finished_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    WHERE execution_id=? AND status IN ('requested','waiting_approval')
  `).run(executionId);
  return actions.filter((action) => action.kind === "command").map((action) => action.id);
}

function assertNoActiveAction(database: DatabaseSync, executionId: string): void {
  if (database.prepare(`
    SELECT 1 FROM execution_actions
    WHERE execution_id=? AND status IN ('pending','running') LIMIT 1
  `).get(executionId)) {
    throw new ExecutionError(
      "OPERATION_IN_PROGRESS",
      409,
      "Execution still has an unconfirmed action.",
    );
  }
}

function assertContinuePreconditions(
  database: DatabaseSync,
  executionId: string,
  row: ExecutionRow,
): void {
  assertNoActiveAction(database, executionId);
  const attempt = database.prepare(`
    SELECT status FROM execution_attempts
    WHERE execution_id=? AND attempt_no=?
  `).get(executionId, row.currentAttemptNo) as { status: string } | undefined;
  if (!attempt) {
    throw new ExecutionError("EXECUTION_STATE_CONFLICT", 409, "Current attempt is missing.");
  }
  if (row.resumeTarget === "running" && !["ready", "acting"].includes(attempt.status)) {
    throw new ExecutionError("EXECUTION_STATE_CONFLICT", 409, "Attempt cannot resume running.");
  }
  if (row.resumeTarget === "queued" && !["preparing", "ready", "interrupted"].includes(attempt.status)) {
    throw new ExecutionError("EXECUTION_STATE_CONFLICT", 409, "Attempt cannot resume queued.");
  }
  if (
    row.resumeTarget === "waiting_approval"
    && !database.prepare(`
      SELECT 1 FROM execution_approvals
      WHERE execution_id=? AND status IN ('pending','approved') LIMIT 1
    `).get(executionId)
  ) {
    throw new ExecutionError(
      "EXECUTION_STATE_CONFLICT",
      409,
      "Waiting approval no longer exists.",
    );
  }
  if (row.resumeTarget === "running") {
    const boundary = preExecutionBoundary(database, executionId, "model");
    if (boundary) {
      throw new ExecutionError(boundary.boundary, 409, "Execution boundary is still reached.");
    }
  }
}

function assertRetryEligibility(database: DatabaseSync, executionId: string, row: ExecutionRow): void {
  if (
    !row.workspacePath
    || !database.prepare(`
      SELECT 1 FROM work_items w
      JOIN missions m ON m.id=w.mission_id AND m.project_id=?
      JOIN project_memberships pm
        ON pm.project_id=m.project_id AND pm.agent_id=w.assignee_agent_id
      JOIN agents a ON a.id=pm.agent_id
      JOIN providers p ON p.id=a.provider_id
      WHERE w.id=? AND w.status='in_progress' AND w.assignee_agent_id=? AND p.verified_at<>''
    `).get(row.projectId, row.workItemId, row.agentId)
  ) {
    throw new ExecutionError(
      "TASK_NOT_ELIGIBLE",
      409,
      "Task, Agent, provider, or workspace is no longer eligible.",
    );
  }
  const sourceRun = database.prepare(`
    SELECT 1 FROM collaboration_runs
    WHERE project_id=? AND thread_id=? AND id=? AND status='planned'
  `).get(row.projectId, row.sourceThreadId, row.sourceRunId);
  if (!sourceRun) {
    throw new ExecutionError("TASK_NOT_ELIGIBLE", 409, "Source collaboration tuple is no longer eligible.");
  }
  if (database.prepare(`
    SELECT 1 FROM executions
    WHERE id<>? AND (work_item_id=? OR agent_id=?)
      AND status IN ('queued','running','waiting_approval','paused','staged') LIMIT 1
  `).get(executionId, row.workItemId, row.agentId)) {
    throw new ExecutionError("TASK_EXECUTION_ACTIVE", 409, "Task or Agent already has an active execution.");
  }
  const activeCount = Number((database.prepare(`
    SELECT COUNT(*) AS count FROM executions
    WHERE project_id=? AND id<>?
      AND status IN ('queued','running','waiting_approval','paused','staged')
  `).get(row.projectId, executionId) as { count: number }).count);
  if (activeCount >= 2) {
    throw new ExecutionError("PROJECT_EXECUTION_LIMIT", 409, "Project execution limit is reached.");
  }
  const boundary = preExecutionBoundary(database, executionId, "model");
  if (boundary) {
    throw new ExecutionError(boundary.boundary, 409, "Execution budget is still exhausted.");
  }
}

function persistFailureReceipt(
  databasePath: string,
  executionId: string,
  input: ExecutionControlInput,
  requestHash: string,
  failure: ExecutionError,
): void {
  const database = openDatabase(databasePath);
  try {
    transaction(database, () => {
      const row = executionRow(database, executionId);
      const existing = operation(database, row.projectId, input.operationId);
      if (existing) {
        readReceipt(existing, input.action, requestHash);
        return;
      }
      insertCompletedReceipt(database, {
        action: input.action,
        body: errorBody(failure),
        executionId,
        httpStatus: failure.httpStatus,
        operationId: input.operationId,
        projectId: row.projectId,
        requestHash,
      });
    });
  } finally {
    database.close();
  }
}

export async function controlExecution(
  databasePath: string,
  executionId: string,
  rawInput: unknown,
  dependencies: ExecutionControlDependencies,
): Promise<ControlResult> {
  const parsed = executionControlInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new ExecutionError("INVALID_INPUT", 400, "Execution control input is invalid.");
  }
  const input = parsed.data;
  const requestHash = canonicalRequestHash({
    action: input.action,
    executionId,
    expectedVersion: input.expectedVersion,
    kind: "execution_control",
  });
  const terminationRequests: string[] = [];
  const retryRequest: { value: Parameters<SandboxExecutor>[0] | null } = {
    value: null,
  };
  const database = openDatabase(databasePath);
  let databaseOpen = true;
  try {
    const result = transaction(database, () => {
      const row = executionRow(database, executionId);
      const existing = operation(database, row.projectId, input.operationId);
      if (existing) return readReceipt(existing, input.action, requestHash);
      if (row.manualRecoveryRequired === 1) {
        throw new ExecutionError(
          "MANUAL_RECOVERY_REQUIRED",
          409,
          "Only an exact manual recovery resolution is allowed.",
        );
      }
      if (row.version !== input.expectedVersion) {
        throw new ExecutionError(
          "EXECUTION_STATE_CONFLICT",
          409,
          "Execution version is stale.",
        );
      }
      if (row.status === "stopped" || row.status === "merged") {
        throw new ExecutionError("EXECUTION_STATE_CONFLICT", 409, "Execution is terminal.");
      }

      const previousStatus = row.status;
      if (input.action === "pause") {
        if (!["queued", "running", "waiting_approval"].includes(row.status)) {
          throw new ExecutionError("EXECUTION_STATE_CONFLICT", 409, "Execution cannot be paused.");
        }
        terminationRequests.push(...discardActiveWork(database, executionId, "OWNER_PAUSED"));
        const paused = database.prepare(`
          UPDATE executions
          SET status='paused',resume_target=?,reason_code='OWNER_PAUSED',
              version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id=? AND version=? AND status=?
        `).run(row.status, executionId, input.expectedVersion, row.status);
        if (paused.changes !== 1) {
          throw new ExecutionError("EXECUTION_STATE_CONFLICT", 409, "Execution changed while pausing.");
        }
      } else if (input.action === "continue") {
        if (row.status !== "paused" || row.resumeTarget === null) {
          throw new ExecutionError("EXECUTION_STATE_CONFLICT", 409, "Execution cannot continue.");
        }
        assertContinuePreconditions(database, executionId, row);
        const continued = database.prepare(`
          UPDATE executions
          SET status=resume_target,resume_target=NULL,reason_code=NULL,
              version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id=? AND version=? AND status='paused' AND resume_target=?
        `).run(executionId, input.expectedVersion, row.resumeTarget);
        if (continued.changes !== 1) {
          throw new ExecutionError("EXECUTION_STATE_CONFLICT", 409, "Execution changed while continuing.");
        }
      } else if (input.action === "stop") {
        terminationRequests.push(...discardActiveWork(database, executionId, "OWNER_STOPPED"));
        database.prepare(`
          UPDATE execution_approvals
          SET status='expired',decided_at=coalesce(decided_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
          WHERE execution_id=? AND status IN ('pending','approved')
        `).run(executionId);
        const stopped = database.prepare(`
          UPDATE executions
          SET status='stopped',resume_target=NULL,reason_code='OWNER_STOPPED',
              version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id=? AND version=? AND status NOT IN ('stopped','merged')
        `).run(executionId, input.expectedVersion);
        if (stopped.changes !== 1) {
          throw new ExecutionError("EXECUTION_STATE_CONFLICT", 409, "Execution changed while stopping.");
        }
      } else {
        const interruptedPause = row.status === "paused"
          && (
            row.reasonCode?.includes("INTERRUPTED") === true
            || row.reasonCode?.includes("DEADLINE_EXCEEDED") === true
            || row.reasonCode === "PROCESS_TERMINATION_UNCONFIRMED"
          );
        if (
          !["stale", "failed", "conflicted"].includes(row.status)
          && !interruptedPause
        ) {
          throw new ExecutionError("EXECUTION_STATE_CONFLICT", 409, "Execution cannot be retried.");
        }
        assertNoActiveAction(database, executionId);
        assertRetryEligibility(database, executionId, row);
        const currentPolicy = database.prepare(`
          SELECT p.active_revision_id AS revisionId,p.version,r.policy_hash AS policyHash
          FROM project_validation_policies p
          JOIN project_validation_policy_revisions r
            ON r.project_id=p.project_id AND r.id=p.active_revision_id
          WHERE p.project_id=?
        `).get(row.projectId) as {
          policyHash: string;
          revisionId: string;
          version: number;
        } | undefined;
        if (!currentPolicy) {
          throw new ExecutionError("TASK_NOT_ELIGIBLE", 409, "Validation policy is unavailable.");
        }
        const frozen = captureExecutionFrozenInput(database, {
          agentId: row.agentId,
          baselineManifestHash: null,
          missionId: row.missionId,
          projectId: row.projectId,
          source: {
            projectId: row.projectId,
            runId: row.sourceRunId,
            threadId: row.sourceThreadId,
          },
          workItemId: row.workItemId,
        });
        const nextAttemptNo = row.currentAttemptNo + 1;
        const attemptId = randomUUID();
        const actionId = randomUUID();
        const sandboxRoot = join(
          resolve(dependencies.executionRoot),
          row.projectId,
          executionId,
          String(nextAttemptNo),
          "sandbox",
        );
        const clock = database.prepare(`
          SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS now,
                 strftime('%Y-%m-%dT%H:%M:%fZ','now','+900 seconds') AS deadline
        `).get() as { deadline: string; now: string };
        database.prepare(`
          UPDATE execution_attempts
          SET status='superseded',finished_at=coalesce(finished_at,?)
          WHERE execution_id=? AND attempt_no=? AND status<>'superseded'
        `).run(clock.now, executionId, row.currentAttemptNo);
        database.prepare(`
          INSERT INTO execution_attempts (
            id,project_id,execution_id,attempt_no,status,sandbox_root,
            baseline_manifest_path,sandbox_manifest_path,
            baseline_manifest_hash,sandbox_manifest_hash,
            frozen_public_json,frozen_private_json,frozen_context_hash,
            frozen_policy_revision_id,frozen_policy_version,frozen_policy_hash,
            started_at,finished_at
          ) VALUES (
            ?,?,?,?,'preparing',?,NULL,NULL,NULL,NULL,?,?,?,?,?,?,?,NULL
          )
        `).run(
          attemptId,
          row.projectId,
          executionId,
          nextAttemptNo,
          sandboxRoot,
          JSON.stringify(frozen.publicEnvelope),
          JSON.stringify(frozen.privateEnvelope),
          frozen.contextHash,
          currentPolicy.revisionId,
          currentPolicy.version,
          currentPolicy.policyHash,
          clock.now,
        );
        database.prepare(`
          UPDATE execution_approvals
          SET status='expired',decided_at=coalesce(decided_at,?)
          WHERE execution_id=? AND status IN ('pending','approved')
        `).run(clock.now, executionId);
        const retried = database.prepare(`
          UPDATE executions
          SET status='queued',resume_target=NULL,reason_code=NULL,current_attempt_no=?,
              current_policy_revision_id=?,version=version+1,updated_at=?
          WHERE id=? AND version=? AND status=?
        `).run(
          nextAttemptNo,
          currentPolicy.revisionId,
          clock.now,
          executionId,
          input.expectedVersion,
          row.status,
        );
        if (retried.changes !== 1) {
          throw new ExecutionError("EXECUTION_STATE_CONFLICT", 409, "Execution changed while retrying.");
        }
        database.prepare(`
          INSERT INTO execution_operations (
            id,project_id,execution_id,kind,request_hash,has_external_actions,
            action_count,final_action_index,status,http_status,response_json,created_at,updated_at
          ) VALUES (?, ?, ?, 'retry', ?, 1, 1, NULL, 'pending', NULL, NULL, ?, ?)
        `).run(input.operationId, row.projectId, executionId, requestHash, clock.now, clock.now);
        database.prepare(`
          INSERT INTO execution_actions (
            id,project_id,execution_id,attempt_id,operation_id,action_index,kind,status,
            request_hash,lease_token,lease_expires_at,overall_deadline_at,
            last_heartbeat_at,result_json,error_code,created_at,started_at,finished_at
          ) VALUES (
            ?,?,?,?, ?,0,'sandbox_build','pending',?,NULL,NULL,?,NULL,NULL,NULL,?,NULL,NULL
          )
        `).run(
          actionId,
          row.projectId,
          executionId,
          attemptId,
          input.operationId,
          requestHash,
          clock.deadline,
          clock.now,
        );
        appendEvent(database, executionId, nextAttemptNo, "attempt_started", {
          attemptNo: nextAttemptNo,
        });
        appendEvent(database, executionId, nextAttemptNo, "control_applied", {
          action: "retry",
        });
        retryRequest.value = {
          actionId,
          attemptId,
          canonicalRoot: row.workspacePath!,
          databasePath,
          executionId,
          leaseToken: "",
          operationId: input.operationId,
          overallDeadlineAt: clock.deadline,
          projectId: row.projectId,
          sandboxRoot,
        };
        return null;
      }

      const current = executionDtoFromDatabase(database, executionId);
      appendEvent(database, executionId, current.attemptNo, "status_changed", {
        from: previousStatus,
        reasonCode: current.reasonCode,
        to: current.status,
      });
      appendEvent(database, executionId, current.attemptNo, "control_applied", {
        action: input.action,
      });
      const body = executionControlResponseSchema.parse({
        execution: executionDtoFromDatabase(database, executionId),
      });
      insertCompletedReceipt(database, {
        action: input.action,
        body,
        executionId,
        httpStatus: 200,
        operationId: input.operationId,
        projectId: row.projectId,
        requestHash,
      });
      return { body, status: 200 };
    });

    for (const actionId of terminationRequests) {
      dependencies.requestProcessTermination(actionId);
    }
    const retryInput = retryRequest.value;
    if (retryInput !== null) {
      const leaseToken = randomUUID();
      const acquired = database.prepare(`
        UPDATE execution_actions
        SET status='running',lease_token=?,lease_expires_at=min(
              strftime('%Y-%m-%dT%H:%M:%fZ','now','+120 seconds'),
              overall_deadline_at
            ),last_heartbeat_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            started_at=coalesce(started_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        WHERE id=? AND status='pending'
      `).run(leaseToken, retryInput.actionId);
      if (acquired.changes !== 1) {
        throw new ExecutionError("OPERATION_IN_PROGRESS", 409, "Retry sandbox action was not acquired.");
      }
      retryInput.leaseToken = leaseToken;
      database.close();
      databaseOpen = false;
      const outcome = await dependencies.sandboxExecutor(retryInput);
      if (outcome.kind !== "completed") {
        throw new ExecutionError(outcome.code, outcome.httpStatus, "Retry sandbox execution failed.");
      }
      const receiptDatabase = openDatabase(databasePath);
      try {
        const receipt = receiptDatabase.prepare(`
          SELECT http_status AS httpStatus,response_json AS responseJson
          FROM execution_operations WHERE project_id=? AND id=? AND status='completed'
        `).get(retryInput.projectId, input.operationId) as
          | { httpStatus: number; responseJson: string }
          | undefined;
        if (!receipt) {
          throw new ExecutionError(
            "MERGE_INVARIANT_FAILED",
            500,
            "Completed retry sandbox has no completed receipt.",
          );
        }
        return {
          body: executionControlResponseSchema.parse(JSON.parse(receipt.responseJson)),
          status: receipt.httpStatus,
        };
      } finally {
        receiptDatabase.close();
      }
    }
    return result!;
  } catch (error) {
    if (
      error instanceof ExecutionError
      && error.code !== "OPERATION_CONFLICT"
      && error.code !== "OPERATION_IN_PROGRESS"
    ) {
      try {
        persistFailureReceipt(databasePath, executionId, input, requestHash, error);
      } catch (receiptError) {
        if (
          receiptError instanceof ExecutionError
          && receiptError.code === error.code
        ) {
          throw error;
        }
        throw receiptError;
      }
    }
    throw error;
  } finally {
    if (databaseOpen) database.close();
  }
}
