/**
 * Approval 写路径的稳定错误码词汇。T-08 仅提取 execution_approvals 写 SQL；
 * 抛出这些错误的 ExecutionError 实现仍属 safe-execution（src/server/execution/），
 * 随 T-09 波次收编；此处只登记 governance 对外承诺的错误码集合。
 */
export type ApprovalDecisionErrorCode =
  | "APPROVAL_NOT_FOUND"
  | "APPROVAL_STATE_CONFLICT"
  | "APPROVAL_STALE"
  | "EXECUTION_NOT_FOUND"
  | "EXECUTION_STATE_CONFLICT"
  | "MANUAL_RECOVERY_REQUIRED"
  | "OPERATION_CONFLICT"
  | "OPERATION_IN_PROGRESS";
