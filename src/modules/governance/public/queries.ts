import type { TransactionContext } from "@/src/application/transaction-context";
import type { ExecutionApprovalDto } from "./dto";

/**
 * Approval 查询的 DTO 级签名。T-08 只提取写 SQL；读路径
 * （execution-read-service / approval 决策加载等 FROM execution_approvals）
 * 仍留在 src/server/execution/，登记为过渡形态，随 T-09/T-13 收编到本 Interface。
 */
export interface GovernanceApprovalQueries {
  listExecutionApprovals(
    transaction: TransactionContext,
    executionId: string,
  ): ExecutionApprovalDto[];
  getExecutionApproval(
    transaction: TransactionContext,
    executionId: string,
    approvalId: string,
  ): ExecutionApprovalDto | undefined;
}
