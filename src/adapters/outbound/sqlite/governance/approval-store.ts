import type { DatabaseSync } from "node:sqlite";

import { appendGovernanceAuditOutboxRow } from "@/src/adapters/outbound/sqlite/governance/audit-event-outbox";
import type {
  ApprovalWriteResult,
  ConsumeStagedMergeApprovalInput,
  InsertCommandApprovalRequestInput,
  InsertStagedMergeApprovalRequestInput,
  RecordApprovalVerdictInput,
} from "@/src/modules/governance";

/**
 * governance owner 的 execution_approvals 写能力（T-08 提取自 src/server/execution/）。
 * SQL 文本、参数绑定顺序与调用处并发语义与原实现逐字一致；读路径仍在
 * safe-execution 服务内，属 T-09/T-13 收编的过渡形态。
 */
export function insertCommandApprovalRequest(
  database: DatabaseSync,
  input: InsertCommandApprovalRequestInput,
): void {
  database.prepare(`
    INSERT INTO execution_approvals (
      id,project_id,execution_id,attempt_id,tool_call_id,kind,status,
      request_hash,input_hash,staged_hash,public_request_json,
      decided_at,consumed_at,created_at
    ) VALUES (?, ?, ?, ?, ?, 'command', 'pending', ?, ?, NULL, ?, NULL, NULL,
      strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  `).run(
    input.approvalId,
    input.projectId,
    input.executionId,
    input.attemptId,
    input.toolCallId,
    input.requestHash,
    input.inputHash,
    input.publicRequestJson,
  );
  appendGovernanceAuditOutboxRow(database, {
    eventType: "approval_requested",
    projectId: input.projectId,
    sourcePayload: {
      approvalId: input.approvalId,
      executionId: input.executionId,
      kind: "command",
    },
  });
}

export function insertStagedMergeApprovalRequest(
  database: DatabaseSync,
  input: InsertStagedMergeApprovalRequestInput,
): void {
  database.prepare(`
    INSERT INTO execution_approvals (
      id,project_id,execution_id,attempt_id,tool_call_id,kind,status,
      request_hash,input_hash,staged_hash,public_request_json,
      decided_at,consumed_at,created_at
    ) VALUES (?, ?, ?, ?, NULL, 'staged_merge', 'pending', ?, ?, ?, ?, NULL, NULL,
      strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  `).run(
    input.approvalId,
    input.projectId,
    input.executionId,
    input.attemptId,
    input.requestHash,
    input.inputHash,
    input.stagedHash,
    input.publicRequestJson,
  );
  appendGovernanceAuditOutboxRow(database, {
    eventType: "approval_requested",
    projectId: input.projectId,
    sourcePayload: {
      approvalId: input.approvalId,
      executionId: input.executionId,
      kind: "staged_merge",
    },
  });
}

export function recordApprovalVerdict(
  database: DatabaseSync,
  input: RecordApprovalVerdictInput,
): ApprovalWriteResult {
  const approval = database.prepare(`
    SELECT project_id AS projectId, execution_id AS executionId, kind
    FROM execution_approvals WHERE id=?
  `).get(input.approvalId) as
    | { executionId: string; kind: string; projectId: string }
    | undefined;
  const result = database.prepare(`
    UPDATE execution_approvals SET status=?,
      decided_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id=? AND status=?
  `).run(input.nextStatus, input.approvalId, input.expectedStatus);
  if (
    approval !== undefined
    && Number(result.changes) > 0
    && (input.nextStatus === "approved" || input.nextStatus === "rejected")
  ) {
    appendGovernanceAuditOutboxRow(database, {
      eventType: input.nextStatus === "approved" ? "approval_approved" : "approval_rejected",
      projectId: approval.projectId,
      sourcePayload: {
        approvalId: input.approvalId,
        decision: input.nextStatus,
        executionId: approval.executionId,
        kind: approval.kind,
      },
    });
  }
  return result;
}

type ApprovalAuditFacts = {
  approvalId: string;
  executionId: string;
  kind: string;
  projectId: string;
};

function selectApprovalAuditFacts(
  database: DatabaseSync,
  whereSql: string,
  ...params: string[]
): ApprovalAuditFacts | undefined {
  return database.prepare(`
    SELECT id AS approvalId, project_id AS projectId, execution_id AS executionId, kind
    FROM execution_approvals ${whereSql}
  `).get(...params) as ApprovalAuditFacts | undefined;
}

function appendApprovalExpiredAuditRow(
  database: DatabaseSync,
  facts: ApprovalAuditFacts | undefined,
  changes: number | bigint,
  scope: "execution" | "project" | "single",
  occurredAt?: string,
): void {
  if (facts === undefined || Number(changes) === 0) return;
  appendGovernanceAuditOutboxRow(database, {
    eventType: "approval_expired",
    occurredAt,
    projectId: facts.projectId,
    sourcePayload: {
      approvalId: facts.approvalId,
      executionId: facts.executionId,
      kind: facts.kind,
      scope,
    },
  });
}

export function expireOpenApprovalById(
  database: DatabaseSync,
  approvalId: string,
): void {
  const facts = selectApprovalAuditFacts(database, "WHERE id=?", approvalId);
  const result = database.prepare(`
    UPDATE execution_approvals
    SET status='expired',
        decided_at=coalesce(decided_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    WHERE id=? AND status IN ('pending','approved')
  `).run(approvalId);
  appendApprovalExpiredAuditRow(database, facts, result.changes, "single");
}

export function expireApprovedApprovalById(
  database: DatabaseSync,
  approvalId: string,
): void {
  const facts = selectApprovalAuditFacts(database, "WHERE id=?", approvalId);
  const result = database.prepare(`
    UPDATE execution_approvals SET status='expired',
      decided_at=coalesce(decided_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    WHERE id=? AND status='approved'
  `).run(approvalId);
  appendApprovalExpiredAuditRow(database, facts, result.changes, "single");
}

export function expireOpenApprovalsForExecution(
  database: DatabaseSync,
  executionId: string,
): void {
  const facts = selectApprovalAuditFacts(
    database,
    "WHERE execution_id=? AND status IN ('pending','approved')",
    executionId,
  );
  const result = database.prepare(`
    UPDATE execution_approvals
    SET status='expired',decided_at=coalesce(decided_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    WHERE execution_id=? AND status IN ('pending','approved')
  `).run(executionId);
  appendApprovalExpiredAuditRow(database, facts, result.changes, "execution");
}

export function expireOpenApprovalsForExecutionAt(
  database: DatabaseSync,
  executionId: string,
  decidedAt: string,
): void {
  const facts = selectApprovalAuditFacts(
    database,
    "WHERE execution_id=? AND status IN ('pending','approved')",
    executionId,
  );
  const result = database.prepare(`
    UPDATE execution_approvals
    SET status='expired',decided_at=coalesce(decided_at,?)
    WHERE execution_id=? AND status IN ('pending','approved')
  `).run(decidedAt, executionId);
  appendApprovalExpiredAuditRow(database, facts, result.changes, "execution", decidedAt);
}

export function expireOpenApprovalsForProjectExecution(
  database: DatabaseSync,
  projectId: string,
  executionId: string,
): void {
  const facts = selectApprovalAuditFacts(
    database,
    "WHERE project_id=? AND execution_id=? AND status IN ('pending','approved')",
    projectId,
    executionId,
  );
  const result = database.prepare(`
    UPDATE execution_approvals SET status='expired',
      decided_at=coalesce(decided_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    WHERE project_id=? AND execution_id=? AND status IN ('pending','approved')
  `).run(projectId, executionId);
  appendApprovalExpiredAuditRow(database, facts, result.changes, "project");
}

export function consumeApprovedApprovalById(
  database: DatabaseSync,
  approvalId: string,
): ApprovalWriteResult {
  const facts = selectApprovalAuditFacts(database, "WHERE id=?", approvalId);
  const result = database.prepare(`
    UPDATE execution_approvals SET status='consumed',
      consumed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id=? AND status='approved'
  `).run(approvalId);
  if (facts !== undefined && Number(result.changes) > 0) {
    appendGovernanceAuditOutboxRow(database, {
      eventType: "approval_consumed",
      projectId: facts.projectId,
      sourcePayload: {
        approvalId: facts.approvalId,
        executionId: facts.executionId,
        kind: facts.kind,
      },
    });
  }
  return result;
}

export function consumeStagedMergeApproval(
  database: DatabaseSync,
  input: ConsumeStagedMergeApprovalInput,
): ApprovalWriteResult {
  const facts = selectApprovalAuditFacts(
    database,
    `WHERE project_id=? AND execution_id=? AND attempt_id=? AND kind='staged_merge'
       AND status='approved' AND staged_hash=?`,
    input.projectId,
    input.executionId,
    input.attemptId,
    input.stagedHash,
  );
  const result = database.prepare(`
    UPDATE execution_approvals
    SET status='consumed',consumed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE project_id=? AND execution_id=? AND attempt_id=? AND kind='staged_merge'
      AND status='approved' AND staged_hash=?
  `).run(input.projectId, input.executionId, input.attemptId, input.stagedHash);
  if (facts !== undefined && Number(result.changes) > 0) {
    appendGovernanceAuditOutboxRow(database, {
      eventType: "approval_consumed",
      projectId: facts.projectId,
      sourcePayload: {
        approvalId: facts.approvalId,
        executionId: facts.executionId,
        kind: facts.kind,
      },
    });
  }
  return result;
}
