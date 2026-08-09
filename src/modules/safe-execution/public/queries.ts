import type {
  ExecutionApprovalDto,
  ExecutionDto,
  RecoveryFileDto,
} from "./dto";

/** 读模型分页查询（execution-read-api `readQuery` 的对应物）。 */
export type SafeExecutionReadQuery = {
  after?: string;
  limit?: string;
  offset?: string;
};

/** 游标分页 envelope（execution-read-service `CursorPage` 的对应物）。 */
export type SafeExecutionPage<Item> = {
  items: Item[];
  nextCursor: string | null;
};

/**
 * safe-execution 公开查询面（DTO 级声明）。
 * 当前具体实现为 src/adapters/outbound/sqlite/safe-execution/execution-read-service.ts；
 * 事件/产物/staged/validation 等读模型的精确 DTO 尚未沉淀进 src/shared 契约，
 * 先以 `Record<string, unknown>` 登记读 seam，随契约沉淀收窄。
 */
export interface SafeExecutionQueries {
  listProjectExecutions(
    databasePath: string,
    projectId: string,
    query: SafeExecutionReadQuery,
  ): Promise<SafeExecutionPage<ExecutionDto>>;
  readExecutionDetail(
    databasePath: string,
    executionId: string,
  ): Promise<Record<string, unknown>>;
  listExecutionEvents(
    databasePath: string,
    executionId: string,
    query: SafeExecutionReadQuery,
  ): Promise<SafeExecutionPage<Record<string, unknown>>>;
  listExecutionArtifacts(
    databasePath: string,
    executionId: string,
    query: SafeExecutionReadQuery,
  ): Promise<SafeExecutionPage<Record<string, unknown>>>;
  listArtifactChunks(
    databasePath: string,
    executionId: string,
    artifactId: string,
    query: SafeExecutionReadQuery,
  ): Promise<SafeExecutionPage<Record<string, unknown>>>;
  listStagedObservations(
    databasePath: string,
    executionId: string,
    stagedId: string,
    query: SafeExecutionReadQuery,
  ): Promise<SafeExecutionPage<Record<string, unknown>>>;
  listStagedBlockers(
    databasePath: string,
    executionId: string,
    stagedId: string,
    query: SafeExecutionReadQuery,
  ): Promise<SafeExecutionPage<Record<string, unknown>>>;
  readObservationDiff(
    databasePath: string,
    executionId: string,
    stagedId: string,
    observationId: string,
  ): Promise<Record<string, unknown>>;
  listExecutionApprovals(
    databasePath: string,
    executionId: string,
    query: SafeExecutionReadQuery,
  ): Promise<SafeExecutionPage<ExecutionApprovalDto>>;
  listExecutionValidations(
    databasePath: string,
    executionId: string,
    query: SafeExecutionReadQuery,
  ): Promise<SafeExecutionPage<Record<string, unknown>>>;
  listValidationChunks(
    databasePath: string,
    executionId: string,
    validationId: string,
    stream: string,
    query: SafeExecutionReadQuery,
  ): Promise<SafeExecutionPage<Record<string, unknown>>>;
  listRecoveryFiles(
    databasePath: string,
    executionId: string,
    query: SafeExecutionReadQuery,
  ): Promise<SafeExecutionPage<RecoveryFileDto>>;
}
