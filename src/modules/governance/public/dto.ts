export type { ExecutionApprovalDto } from "@/src/shared/execution-contracts";

import type { ExecutionApprovalDto } from "@/src/shared/execution-contracts";

export type ApprovalStatus = ExecutionApprovalDto["status"];

export type InsertCommandApprovalRequestInput = {
  approvalId: string;
  attemptId: string;
  executionId: string;
  inputHash: string;
  projectId: string;
  publicRequestJson: string;
  requestHash: string;
  toolCallId: string;
};

export type InsertStagedMergeApprovalRequestInput = {
  approvalId: string;
  attemptId: string;
  executionId: string;
  inputHash: string;
  projectId: string;
  publicRequestJson: string;
  requestHash: string;
  stagedHash: string;
};

export type RecordApprovalVerdictInput = {
  approvalId: string;
  expectedStatus: ApprovalStatus;
  nextStatus: ApprovalStatus;
};

export type ConsumeStagedMergeApprovalInput = {
  attemptId: string;
  executionId: string;
  projectId: string;
  stagedHash: string;
};

/** 写能力的变更计数结果（调用方据 changes===1 判定并发冲突）。 */
export type ApprovalWriteResult = {
  changes: number | bigint;
};
