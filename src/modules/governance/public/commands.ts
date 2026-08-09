import type { TransactionContext } from "@/src/application/transaction-context";
import type {
  ApprovalWriteResult,
  ConsumeStagedMergeApprovalInput,
  InsertCommandApprovalRequestInput,
  InsertStagedMergeApprovalRequestInput,
  RecordApprovalVerdictInput,
} from "./dto";

/**
 * T-08 落地的 governance 公开面（Approval 事实写能力）：
 * execution_approvals 的全部写入口。当前具体实现为
 * src/adapters/outbound/sqlite/governance/approval-store.ts 的 DatabaseSync 自由函数，
 * 由 src/server/execution/ 的 safe-execution 服务直接调用
 * （adapter→adapter 过渡边，T-13/T-14 收编为事务协调 Port 形态）。
 */
export interface GovernanceApprovalCommands {
  insertCommandApprovalRequest(
    transaction: TransactionContext,
    input: InsertCommandApprovalRequestInput,
  ): void;
  insertStagedMergeApprovalRequest(
    transaction: TransactionContext,
    input: InsertStagedMergeApprovalRequestInput,
  ): void;
  recordApprovalVerdict(
    transaction: TransactionContext,
    input: RecordApprovalVerdictInput,
  ): ApprovalWriteResult;
  expireOpenApprovalById(
    transaction: TransactionContext,
    approvalId: string,
  ): void;
  expireApprovedApprovalById(
    transaction: TransactionContext,
    approvalId: string,
  ): void;
  expireOpenApprovalsForExecution(
    transaction: TransactionContext,
    executionId: string,
  ): void;
  expireOpenApprovalsForExecutionAt(
    transaction: TransactionContext,
    executionId: string,
    decidedAt: string,
  ): void;
  expireOpenApprovalsForProjectExecution(
    transaction: TransactionContext,
    projectId: string,
    executionId: string,
  ): void;
  consumeApprovedApprovalById(
    transaction: TransactionContext,
    approvalId: string,
  ): ApprovalWriteResult;
  consumeStagedMergeApproval(
    transaction: TransactionContext,
    input: ConsumeStagedMergeApprovalInput,
  ): ApprovalWriteResult;
}
