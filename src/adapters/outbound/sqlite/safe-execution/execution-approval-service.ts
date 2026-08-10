import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { canonicalRequestHash } from "@/src/adapters/outbound/sqlite/public-collaboration/operation-receipts";
import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { appendExecutionAuditOutboxRow } from "@/src/adapters/outbound/sqlite/safe-execution/audit-event-outbox";
import {
  consumeApprovedApprovalById,
  expireApprovedApprovalById,
  expireOpenApprovalById,
  insertStagedMergeApprovalRequest,
  recordApprovalVerdict,
} from "@/src/adapters/outbound/sqlite/governance/approval-store";
import { ExecutionError } from "@/src/modules/safe-execution";
import {
  executionDtoFromDatabase,
} from "@/src/adapters/outbound/sqlite/safe-execution/execution-service";
import {
  executionApprovalDtoSchema,
  executionApprovalInputSchema,
  executionApprovalResponseSchema,
  type ExecutionApprovalDto,
  type ExecutionApprovalInput,
  type ExecutionApprovalResponse,
} from "@/src/shared/execution-contracts";

type ApprovalRow = {
  attemptId: string;
  commandJson: string | null;
  consumedAt: string | null;
  contextHash: string;
  createdAt: string;
  currentAttemptId: string | null;
  currentAttemptNo: number;
  decidedAt: string | null;
  executionId: string;
  executionStatus: string;
  executionVersion: number;
  inputHash: string;
  kind: "command" | "staged_merge";
  manualRecoveryRequired: number;
  projectId: string;
  publicRequestJson: string;
  requestHash: string;
  sandboxManifestHash: string | null;
  stagedHash: string | null;
  status: ExecutionApprovalDto["status"];
  toolCallId: string | null;
  toolInputHash: string | null;
  toolRequestHash: string | null;
  toolRequestJson: string | null;
  toolStatus: string | null;
};

type StoredOperation = {
  httpStatus: number | null;
  kind: string;
  requestHash: string;
  responseJson: string | null;
  status: string;
};

type DecisionResult = { body: ExecutionApprovalResponse; status: number };

const operationKind = {
  approve: "approve",
  reject: "reject",
  replace: "replace_request",
  revoke: "revoke",
} as const;

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
      // Preserve the stable execution error.
    }
    throw error;
  }
}

function errorBody(error: ExecutionError) {
  return { error: { code: error.code, message: error.message } };
}

function loadApproval(
  database: DatabaseSync,
  executionId: string,
  approvalId: string,
): ApprovalRow {
  const row = database.prepare(`
    SELECT approval.execution_id AS executionId,approval.project_id AS projectId,
           approval.attempt_id AS attemptId,approval.tool_call_id AS toolCallId,
           approval.kind,approval.status,approval.request_hash AS requestHash,
           approval.input_hash AS inputHash,approval.staged_hash AS stagedHash,
           approval.public_request_json AS publicRequestJson,
           approval.created_at AS createdAt,approval.decided_at AS decidedAt,
           approval.consumed_at AS consumedAt,
           execution.status AS executionStatus,execution.version AS executionVersion,
           execution.current_attempt_no AS currentAttemptNo,
           execution.manual_recovery_required AS manualRecoveryRequired,
           current_attempt.id AS currentAttemptId,
           current_attempt.frozen_context_hash AS contextHash,
           current_attempt.sandbox_manifest_hash AS sandboxManifestHash,
           tool.request_hash AS toolRequestHash,tool.public_request_json AS toolRequestJson,
           tool.before_sandbox_hash AS toolInputHash,
           tool.status AS toolStatus,tool.public_request_json AS commandJson
    FROM execution_approvals approval
    JOIN executions execution
      ON execution.project_id=approval.project_id AND execution.id=approval.execution_id
    LEFT JOIN execution_attempts current_attempt
      ON current_attempt.project_id=execution.project_id
     AND current_attempt.execution_id=execution.id
     AND current_attempt.attempt_no=execution.current_attempt_no
    LEFT JOIN execution_tool_calls tool
      ON tool.project_id=approval.project_id AND tool.id=approval.tool_call_id
    WHERE approval.id=? AND approval.execution_id=?
  `).get(approvalId, executionId) as ApprovalRow | undefined;
  if (!row) throw new ExecutionError("APPROVAL_NOT_FOUND", 404, "Approval was not found.");
  return row;
}

function parseObject(json: string): Record<string, unknown> {
  try {
    const value = JSON.parse(json) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // Treat malformed durable facts as stale instead of trusting them.
  }
  throw new ExecutionError("APPROVAL_STALE", 409, "Approval facts changed.");
}

function commandFactsMatch(row: ApprovalRow): boolean {
  if (
    row.kind !== "command"
    || !row.toolCallId
    || !row.toolRequestJson
    || row.toolRequestHash !== row.requestHash
    || row.toolInputHash !== row.sandboxManifestHash
    || row.toolStatus !== "waiting_approval"
  ) return false;
  const approval = parseObject(row.publicRequestJson);
  const tool = parseObject(row.toolRequestJson);
  const exactKeys = [
    "agentPermission",
    "args",
    "attemptId",
    "attemptNo",
    "classifierVersion",
    "contextHash",
    "executable",
    "executableIdentity",
    "expectedEffect",
    "inputHash",
    "policySource",
    "riskReasons",
    "type",
    "workdir",
  ];
  return approval.requestHash === row.requestHash
    && approval.inputHash === row.inputHash
    && approval.contextHash === row.contextHash
    && approval.attemptId === row.attemptId
    && exactKeys.every((key) => JSON.stringify(approval[key]) === JSON.stringify(tool[key]));
}

function stagedFactsMatch(database: DatabaseSync, row: ApprovalRow): boolean {
  if (row.kind !== "staged_merge" || !row.stagedHash) return false;
  const staged = database.prepare(`
    SELECT project_id AS projectId,execution_id AS executionId,
           staged_hash AS stagedHash,context_hash AS contextHash,
           sandbox_manifest_hash AS sandboxHash,classification
    FROM execution_staged_results
    WHERE attempt_id=?
  `).get(row.attemptId) as {
    classification: string;
    contextHash: string;
    executionId: string;
    projectId: string;
    sandboxHash: string;
    stagedHash: string;
  } | undefined;
  const request = parseObject(row.publicRequestJson);
  return Boolean(
    staged
    && staged.projectId === row.projectId
    && staged.executionId === row.executionId
    && staged.classification === "approval_required"
    && staged.stagedHash === row.stagedHash
    && staged.contextHash === row.contextHash
    && staged.sandboxHash === row.inputHash
    && request.kind === "staged_merge"
    && request.attemptId === row.attemptId
    && request.contextHash === row.contextHash
    && request.inputHash === row.inputHash
    && request.stagedHash === row.stagedHash
    && request.requestHash === row.requestHash,
  );
}

function approvalIsCurrent(database: DatabaseSync, row: ApprovalRow): boolean {
  if (row.attemptId !== row.currentAttemptId) return false;
  if (row.kind === "command") return commandFactsMatch(row);
  return stagedFactsMatch(database, row);
}

function approvalDto(row: ApprovalRow): ExecutionApprovalDto {
  const request = parseObject(row.publicRequestJson);
  const command = row.kind === "command"
    ? {
        args: Array.isArray(request.args) ? request.args : [],
        executable: request.executable,
        expectedEffect: request.expectedEffect,
        permission: request.agentPermission,
        riskReasons: Array.isArray(request.riskReasons) ? request.riskReasons : [],
        workdir: request.workdir,
      }
    : null;
  return executionApprovalDtoSchema.parse({
    command,
    consumedAt: row.consumedAt,
    createdAt: row.createdAt,
    decidedAt: row.decidedAt,
    id: request.approvalId ?? undefined,
    inputHash: row.inputHash,
    kind: row.kind,
    requestHash: row.requestHash,
    stagedHash: row.stagedHash,
    status: row.status,
  });
}

function approvalDtoById(
  database: DatabaseSync,
  executionId: string,
  approvalId: string,
): ExecutionApprovalDto {
  const row = loadApproval(database, executionId, approvalId);
  const request = parseObject(row.publicRequestJson);
  request.approvalId = approvalId;
  row.publicRequestJson = JSON.stringify(request);
  return approvalDto(row);
}

function appendDecisionEvent(
  database: DatabaseSync,
  row: ApprovalRow,
  approvalId: string,
  action: ExecutionApprovalInput["action"],
  status: ExecutionApprovalDto["status"],
): void {
  const execution = database.prepare(`
    SELECT next_event_sequence AS sequence,current_attempt_no AS attemptNo
    FROM executions WHERE id=?
  `).get(row.executionId) as { attemptNo: number; sequence: number };
  const eventId = randomUUID();
  const payload = {
    action,
    approvalId,
    authorizationSource: "one_shot",
    kind: row.kind,
    status,
  };
  database.prepare(`
    INSERT INTO execution_events (
      id,project_id,execution_id,sequence,attempt_no,type,actor_type,actor_id,
      payload_json,created_at
    ) VALUES (?, ?, ?, ?, ?, 'approval_decided', 'owner', NULL, ?,
      strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  `).run(
    eventId,
    row.projectId,
    row.executionId,
    execution.sequence,
    execution.attemptNo,
    JSON.stringify(payload),
  );
  appendExecutionAuditOutboxRow(database, {
    actorId: null,
    actorType: "owner",
    attemptNo: execution.attemptNo,
    eventId,
    eventType: "approval_decided",
    executionId: row.executionId,
    projectId: row.projectId,
    sourcePayload: payload,
  });
  database.prepare(`
    UPDATE executions SET next_event_sequence=next_event_sequence+1 WHERE id=?
  `).run(row.executionId);
}

function storedOperation(
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

function persistReceipt(
  database: DatabaseSync,
  input: {
    body: unknown;
    executionId: string;
    httpStatus: number;
    kind: string;
    operationId: string;
    projectId: string;
    requestHash: string;
  },
): void {
  database.prepare(`
    INSERT INTO execution_operations (
      id,project_id,execution_id,kind,request_hash,has_external_actions,
      action_count,final_action_index,status,http_status,response_json,created_at,updated_at
    ) VALUES (?, ?, ?, ?, ?, 0, 0, NULL, 'completed', ?, ?,
      strftime('%Y-%m-%dT%H:%M:%fZ','now'),
      strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  `).run(
    input.operationId,
    input.projectId,
    input.executionId,
    input.kind,
    input.requestHash,
    input.httpStatus,
    JSON.stringify(input.body),
  );
}

function replay(
  stored: StoredOperation,
  kind: string,
  requestHash: string,
): DecisionResult {
  if (stored.kind !== kind || stored.requestHash !== requestHash) {
    throw new ExecutionError(
      "OPERATION_CONFLICT",
      409,
      "Operation id was already used for different input.",
    );
  }
  if (stored.status !== "completed" || stored.httpStatus === null || !stored.responseJson) {
    throw new ExecutionError("OPERATION_IN_PROGRESS", 409, "Operation is still in progress.");
  }
  const body = JSON.parse(stored.responseJson) as unknown;
  const response = executionApprovalResponseSchema.safeParse(body);
  if (response.success) return { body: response.data, status: stored.httpStatus };
  const failure = body as { error?: { code?: unknown; message?: unknown } };
  if (typeof failure.error?.code === "string" && typeof failure.error.message === "string") {
    throw new ExecutionError(failure.error.code, stored.httpStatus, failure.error.message);
  }
  throw new ExecutionError("INTERNAL_ERROR", 500, "Stored approval receipt is invalid.");
}

export async function decideExecutionApproval(
  databasePath: string,
  executionId: string,
  approvalId: string,
  rawInput: unknown,
): Promise<DecisionResult> {
  const parsed = executionApprovalInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new ExecutionError("INVALID_INPUT", 400, "Approval input is invalid.");
  }
  const input = parsed.data;
  const kind = operationKind[input.action];
  const requestHash = canonicalRequestHash({
    action: input.action,
    approvalId,
    executionId,
    expectedVersion: input.expectedVersion,
    kind: "execution_approval",
  });
  const database = openDatabase(databasePath);
  let deferredFailure: ExecutionError | null = null;
  try {
    const result = transaction(database, () => {
      const identity = database.prepare(`
        SELECT project_id AS projectId FROM executions WHERE id=?
      `).get(executionId) as { projectId: string } | undefined;
      if (!identity) {
        throw new ExecutionError("EXECUTION_NOT_FOUND", 404, "Execution was not found.");
      }
      const existing = storedOperation(database, identity.projectId, input.operationId);
      if (existing) return replay(existing, kind, requestHash);
      let row: ApprovalRow;
      try {
        row = loadApproval(database, executionId, approvalId);
      } catch (error) {
        if (!(error instanceof ExecutionError) || error.code !== "APPROVAL_NOT_FOUND") throw error;
        persistReceipt(database, {
          body: errorBody(error),
          executionId,
          httpStatus: error.httpStatus,
          kind,
          operationId: input.operationId,
          projectId: identity.projectId,
          requestHash,
        });
        deferredFailure = error;
        return { body: null as never, status: error.httpStatus };
      }
      const fail = (error: ExecutionError, expire = false): DecisionResult => {
        if (expire && ["pending", "approved"].includes(row.status)) {
          expireOpenApprovalById(database, approvalId);
        }
        persistReceipt(database, {
          body: errorBody(error),
          executionId,
          httpStatus: error.httpStatus,
          kind,
          operationId: input.operationId,
          projectId: row.projectId,
          requestHash,
        });
        deferredFailure = error;
        return { body: null as never, status: error.httpStatus };
      };
      if (row.manualRecoveryRequired === 1) {
        return fail(new ExecutionError(
          "MANUAL_RECOVERY_REQUIRED",
          409,
          "Only an exact manual recovery resolution is allowed.",
        ));
      }
      if (["stopped", "merged", "failed", "stale", "conflicted"].includes(row.executionStatus)) {
        return fail(new ExecutionError(
          "EXECUTION_STATE_CONFLICT",
          409,
          "Execution cannot accept approval decisions.",
        ), true);
      }
      if (row.executionVersion !== input.expectedVersion) {
        return fail(new ExecutionError(
          "EXECUTION_STATE_CONFLICT",
          409,
          "Execution version is stale.",
        ));
      }
      if (!approvalIsCurrent(database, row)) {
        return fail(new ExecutionError("APPROVAL_STALE", 409, "Approval facts changed."), true);
      }
      const expectedStatus = input.action === "revoke" ? "approved" : "pending";
      if (row.status !== expectedStatus) {
        return fail(new ExecutionError(
          "APPROVAL_STATE_CONFLICT",
          409,
          "Approval cannot perform this transition.",
        ));
      }
      if (
        row.kind === "command"
        && row.executionStatus !== "waiting_approval"
      ) {
        return fail(new ExecutionError(
          "EXECUTION_STATE_CONFLICT",
          409,
          "Command approval is not waiting.",
        ), true);
      }
      if (row.kind === "staged_merge" && row.executionStatus !== "staged") {
        return fail(new ExecutionError(
          "EXECUTION_STATE_CONFLICT",
          409,
          "Staged approval is not current.",
        ), true);
      }

      const nextStatus = input.action === "approve"
        ? "approved"
        : input.action === "replace"
          ? "replaced"
          : input.action === "revoke"
            ? "revoked"
            : "rejected";
      const updated = recordApprovalVerdict(database, {
        approvalId,
        expectedStatus,
        nextStatus,
      });
      if (updated.changes !== 1) {
        return fail(new ExecutionError(
          "APPROVAL_STATE_CONFLICT",
          409,
          "Approval changed concurrently.",
        ));
      }
      if (row.kind === "command" && nextStatus !== "approved") {
        const reasonCode = `COMMAND_APPROVAL_${nextStatus === "replaced"
          ? "REPLACED"
          : nextStatus === "revoked"
            ? "REVOKED"
            : "REJECTED"}`;
        database.prepare(`
          UPDATE execution_tool_calls SET status='rejected',public_result_json=?,
            finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id=? AND status='waiting_approval'
        `).run(JSON.stringify({ code: reasonCode, status: "rejected" }), row.toolCallId);
        database.prepare(`
          UPDATE executions SET status='paused',resume_target='running',reason_code=?,
            version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id=? AND version=? AND status='waiting_approval'
        `).run(reasonCode, executionId, input.expectedVersion);
      } else {
        database.prepare(`
          UPDATE executions SET version=version+1,
            updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id=? AND version=?
        `).run(executionId, input.expectedVersion);
      }
      appendDecisionEvent(database, row, approvalId, input.action, nextStatus);
      const body = executionApprovalResponseSchema.parse({
        approval: approvalDtoById(database, executionId, approvalId),
        execution: executionDtoFromDatabase(database, executionId),
      });
      persistReceipt(database, {
        body,
        executionId,
        httpStatus: 200,
        kind,
        operationId: input.operationId,
        projectId: row.projectId,
        requestHash,
      });
      return { body, status: 200 };
    });
    if (deferredFailure) throw deferredFailure;
    return result;
  } finally {
    database.close();
  }
}

export function createStagedMergeApproval(input: {
  attemptId: string;
  contextHash: string;
  database: DatabaseSync;
  executionId: string;
  inputHash: string;
  projectId: string;
  stagedHash: string;
}): { approvalId: string } {
  const approvalId = randomUUID();
  const request = {
    attemptId: input.attemptId,
    contextHash: input.contextHash,
    inputHash: input.inputHash,
    kind: "staged_merge",
    stagedHash: input.stagedHash,
  };
  const requestHash = canonicalRequestHash(request);
  insertStagedMergeApprovalRequest(input.database, {
    approvalId,
    attemptId: input.attemptId,
    executionId: input.executionId,
    inputHash: input.inputHash,
    projectId: input.projectId,
    publicRequestJson: JSON.stringify({ ...request, approvalId, requestHash }),
    requestHash,
    stagedHash: input.stagedHash,
  });
  return { approvalId };
}

export function consumeApprovedCommand(input: {
  database: DatabaseSync;
  executionId: string;
  expectedVersion: number;
  operationId: string;
  operationRequestHash: string;
}): {
  actionId: string;
  approvalId: string;
  attemptId: string;
  projectId: string;
  requestHash: string;
} {
  const outcome = transaction(input.database, () => {
    const currentApproval = input.database.prepare(`
      SELECT id FROM execution_approvals
      WHERE execution_id=? AND kind='command' AND status='approved'
    `).get(input.executionId) as { id: string } | undefined;
    if (!currentApproval) {
      throw new ExecutionError(
        "APPROVAL_STATE_CONFLICT",
        409,
        "Approved command is unavailable.",
      );
    }
    const current = loadApproval(input.database, input.executionId, currentApproval.id);
    if (!approvalIsCurrent(input.database, current)) {
      expireApprovedApprovalById(input.database, currentApproval.id);
      return { stale: true as const };
    }
    const approval = input.database.prepare(`
      SELECT approval.id AS approvalId,approval.project_id AS projectId,
             approval.attempt_id AS attemptId,approval.tool_call_id AS toolCallId,
             approval.request_hash AS requestHash,approval.input_hash AS inputHash,
             tool.before_sandbox_hash AS toolInputHash,
             attempt.sandbox_manifest_hash AS sandboxManifestHash,
             execution.business_deadline_at AS deadline
      FROM execution_approvals approval
      JOIN executions execution
        ON execution.project_id=approval.project_id AND execution.id=approval.execution_id
       AND execution.current_attempt_no=(
         SELECT attempt_no FROM execution_attempts WHERE id=approval.attempt_id
       )
      JOIN execution_tool_calls tool
        ON tool.project_id=approval.project_id AND tool.id=approval.tool_call_id
       AND tool.attempt_id=approval.attempt_id AND tool.request_hash=approval.request_hash
       AND tool.status='waiting_approval' AND tool.action_id IS NULL
      JOIN execution_attempts attempt
        ON attempt.project_id=approval.project_id AND attempt.execution_id=approval.execution_id
       AND attempt.id=approval.attempt_id
      WHERE approval.execution_id=? AND approval.kind='command'
        AND approval.status='approved'
        AND approval.input_hash=tool.before_sandbox_hash
        AND approval.input_hash=attempt.sandbox_manifest_hash
        AND execution.status='waiting_approval' AND execution.version=?
    `).get(input.executionId, input.expectedVersion) as {
      approvalId: string;
      attemptId: string;
      deadline: string | null;
      inputHash: string;
      projectId: string;
      requestHash: string;
      sandboxManifestHash: string;
      toolCallId: string;
      toolInputHash: string;
    } | undefined;
    if (!approval) {
      throw new ExecutionError(
        "APPROVAL_STATE_CONFLICT",
        409,
        "Approved command is unavailable.",
      );
    }
    if (input.database.prepare(`
      SELECT 1 FROM execution_actions
      WHERE execution_id=? AND status IN ('pending','running')
    `).get(input.executionId)) {
      throw new ExecutionError("OPERATION_IN_PROGRESS", 409, "Execution already has an action.");
    }
    const actionId = randomUUID();
    input.database.prepare(`
      INSERT INTO execution_operations (
        id,project_id,execution_id,kind,request_hash,has_external_actions,
        action_count,final_action_index,status,http_status,response_json,created_at,updated_at
      ) VALUES (?, ?, ?, 'advance', ?, 1, 1, NULL, 'pending', NULL, NULL,
        strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    `).run(
      input.operationId,
      approval.projectId,
      input.executionId,
      input.operationRequestHash,
    );
    input.database.prepare(`
      INSERT INTO execution_actions (
        id,project_id,execution_id,attempt_id,operation_id,action_index,kind,status,
        request_hash,overall_deadline_at,created_at
      ) VALUES (?, ?, ?, ?, ?, 0, 'command', 'pending', ?,
        min(strftime('%Y-%m-%dT%H:%M:%fZ','now','+120 seconds'),?),
        strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    `).run(
      actionId,
      approval.projectId,
      input.executionId,
      approval.attemptId,
      input.operationId,
      approval.requestHash,
      approval.deadline ?? "9999-12-31T23:59:59.999Z",
    );
    const consumed = consumeApprovedApprovalById(input.database, approval.approvalId);
    const linked = input.database.prepare(`
      UPDATE execution_tool_calls SET action_id=?,status='requested'
      WHERE id=? AND action_id IS NULL AND status='waiting_approval'
    `).run(actionId, approval.toolCallId);
    const running = input.database.prepare(`
      UPDATE executions SET status='running',resume_target=NULL,reason_code=NULL,
        version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id=? AND version=? AND status='waiting_approval'
    `).run(input.executionId, input.expectedVersion);
    if (consumed.changes !== 1 || linked.changes !== 1 || running.changes !== 1) {
      throw new ExecutionError(
        "APPROVAL_STATE_CONFLICT",
        409,
        "Approved command changed during consumption.",
      );
    }
    return {
      actionId,
      approvalId: approval.approvalId,
      attemptId: approval.attemptId,
      projectId: approval.projectId,
      requestHash: approval.requestHash,
      stale: false as const,
    };
  });
  if (outcome.stale) {
    throw new ExecutionError("APPROVAL_STALE", 409, "Approval facts changed.");
  }
  const { stale: _stale, ...consumed } = outcome;
  return consumed;
}
