export type {
  AdvanceExecutionInput,
  AdvanceExecutionResponse,
  ExecutionApprovalDto,
  ExecutionApprovalInput,
  ExecutionApprovalResponse,
  ExecutionControlInput,
  ExecutionControlResponse,
  ExecutionDto,
  ExecutionEventType,
  ExecutionListResponse,
  MergeExecutionInput,
  MergeExecutionResponse,
  RecoveryFileDto,
  RecoveryMergeFileStatus,
  StartExecutionInput,
  StartExecutionRejection,
  StartExecutionResponse,
  TaskRejection,
} from "@/src/shared/execution-contracts";

/**
 * 沙箱执行接缝的公开输入/输出（T-09 自 sandbox-executor 提取）：
 * startExecution/controlExecution 命令以本类型注入执行能力，workspace Adapter
 * （sandbox-executor）提供具体实现。
 */
export type SandboxExecutionInput = {
  actionId: string;
  attemptId: string;
  canonicalRoot: string;
  databasePath: string;
  executionId: string;
  leaseToken: string;
  operationId: string;
  overallDeadlineAt: string;
  projectId: string;
  sandboxRoot: string;
};

export type SandboxExecutionOutcome =
  | { kind: "completed" }
  | { code: string; httpStatus: number; kind: "failed" };

export type SandboxExecutor = (
  input: SandboxExecutionInput,
) => Promise<SandboxExecutionOutcome>;
