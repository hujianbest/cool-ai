import type { TransactionContext } from "@/src/application/transaction-context";
import type { ApprovalCenterItemDto, ExecutionApprovalDto } from "./dto";

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

/**
 * 统一审批中心聚合读（特性 029 T-01）：跨 execution 与 inline_decision 两域，
 * 列表语义 = 待决 + 失效可辨识（approved/consumed/rejected/resolved 等落定事实
 * 不属于"在等 owner 拍板"，不入列）。排序 createdAt DESC、approvalId 决胜。
 * 独立 databasePath 读路径（不共享调用方事务），与 auditProjectionQueries 同风格；
 * project tuple 不存在时失败关闭（PROJECT_NOT_FOUND）。
 */
export interface GovernanceApprovalCenterQueries {
  listPendingApprovals(
    databasePath: string,
    projectId: string,
  ): ApprovalCenterItemDto[];
}
