import type { DatabaseSync } from "node:sqlite";

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
}

export function recordApprovalVerdict(
  database: DatabaseSync,
  input: RecordApprovalVerdictInput,
): ApprovalWriteResult {
  return database.prepare(`
    UPDATE execution_approvals SET status=?,
      decided_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id=? AND status=?
  `).run(input.nextStatus, input.approvalId, input.expectedStatus);
}

export function expireOpenApprovalById(
  database: DatabaseSync,
  approvalId: string,
): void {
  database.prepare(`
    UPDATE execution_approvals
    SET status='expired',
        decided_at=coalesce(decided_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    WHERE id=? AND status IN ('pending','approved')
  `).run(approvalId);
}

export function expireApprovedApprovalById(
  database: DatabaseSync,
  approvalId: string,
): void {
  database.prepare(`
    UPDATE execution_approvals SET status='expired',
      decided_at=coalesce(decided_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    WHERE id=? AND status='approved'
  `).run(approvalId);
}

export function expireOpenApprovalsForExecution(
  database: DatabaseSync,
  executionId: string,
): void {
  database.prepare(`
    UPDATE execution_approvals
    SET status='expired',decided_at=coalesce(decided_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    WHERE execution_id=? AND status IN ('pending','approved')
  `).run(executionId);
}

export function expireOpenApprovalsForExecutionAt(
  database: DatabaseSync,
  executionId: string,
  decidedAt: string,
): void {
  database.prepare(`
    UPDATE execution_approvals
    SET status='expired',decided_at=coalesce(decided_at,?)
    WHERE execution_id=? AND status IN ('pending','approved')
  `).run(decidedAt, executionId);
}

export function expireOpenApprovalsForProjectExecution(
  database: DatabaseSync,
  projectId: string,
  executionId: string,
): void {
  database.prepare(`
    UPDATE execution_approvals SET status='expired',
      decided_at=coalesce(decided_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    WHERE project_id=? AND execution_id=? AND status IN ('pending','approved')
  `).run(projectId, executionId);
}

export function consumeApprovedApprovalById(
  database: DatabaseSync,
  approvalId: string,
): ApprovalWriteResult {
  return database.prepare(`
    UPDATE execution_approvals SET status='consumed',
      consumed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id=? AND status='approved'
  `).run(approvalId);
}

export function consumeStagedMergeApproval(
  database: DatabaseSync,
  input: ConsumeStagedMergeApprovalInput,
): ApprovalWriteResult {
  return database.prepare(`
    UPDATE execution_approvals
    SET status='consumed',consumed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE project_id=? AND execution_id=? AND attempt_id=? AND kind='staged_merge'
      AND status='approved' AND staged_hash=?
  `).run(input.projectId, input.executionId, input.attemptId, input.stagedHash);
}
