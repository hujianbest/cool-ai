import type {
  AdvanceExecutionResponse,
  ExecutionApprovalResponse,
  ExecutionControlInput,
  ExecutionControlResponse,
  MergeExecutionInput,
  MergeExecutionResponse,
  SandboxExecutor,
  StartExecutionRejection,
  StartExecutionResponse,
} from "./dto";

/**
 * 命令级 envelope（当前实现以 { body, status } 承载，T-14 入站收编后由 route 仅依赖本面）。
 */
export type SafeExecutionCommandResult<Body> = {
  body: Body;
  status: number;
};

/**
 * safe-execution 公开命令面（DTO 级声明，不要求具体实现 implements）。
 * 当前具体实现为 src/adapters/outbound/sqlite/safe-execution/ 下的 DatabaseSync 自由函数，
 * 由 app/api route 直接调用（A-103 过渡形态，T-13/T-14 收编为 Workflow/事务协调 Port）。
 */
export interface SafeExecutionCommands {
  startExecution(
    databasePath: string,
    projectId: string,
    rawInput: unknown,
    executor: SandboxExecutor,
    executionRoot: string,
  ): Promise<SafeExecutionCommandResult<StartExecutionRejection | StartExecutionResponse>>;
  advanceExecution(
    databasePath: string,
    executionId: string,
    input: { expectedVersion: number; operationId: string },
  ): Promise<SafeExecutionCommandResult<AdvanceExecutionResponse>>;
  controlExecution(
    databasePath: string,
    executionId: string,
    input: ExecutionControlInput,
  ): Promise<SafeExecutionCommandResult<ExecutionControlResponse>>;
  decideExecutionApproval(
    databasePath: string,
    executionId: string,
    approvalId: string,
    rawInput: unknown,
  ): Promise<SafeExecutionCommandResult<ExecutionApprovalResponse>>;
  mergeExecution(
    databasePath: string,
    executionId: string,
    input: MergeExecutionInput,
  ): Promise<SafeExecutionCommandResult<MergeExecutionResponse>>;
}
