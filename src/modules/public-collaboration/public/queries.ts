import type {
  CollaborationReadResponse,
  CursorPage,
  FactPageResponse,
  InputHistorySearchResponse,
  MessageAttachmentMimeType,
  MessagePageResponse,
  PendingProposalDto,
  PublicCollaborationPageCursor,
  RecycleBinListResponseDto,
  ThreadDraftReadResponse,
  ThreadListResponseDto,
  ThreadQueueListResponseDto,
  ThreadTagListResponseDto,
  TimelineEvent,
} from "./dto";

import type { PublicCollaborationCommandResult } from "./commands";

/**
 * public-collaboration 公开查询面（DTO 级声明，不要求具体实现 implements）。
 * 当前具体实现为 src/adapters/outbound/sqlite/public-collaboration/ 下的
 * thread-service/run-service/run-timeline-service/structured-message-store/
 * inline-decision-service 的 DatabaseSync 自由函数。
 * ThreadDetailResponse/ThreadOperationLookupResponse 等精确 DTO
 * 尚未沉淀进 src/shared 契约，先以 Record<string, unknown> 登记读 seam，
 * 随契约沉淀收窄（同 safe-execution 先例）。
 */
export interface PublicCollaborationQueries {
  listThreads(
    databasePath: string,
    projectId: string,
    rawInput?: unknown,
  ): PublicCollaborationCommandResult<ThreadListResponseDto>;
  /**
   * 回收站只读缝（特性 033 T-03）：仅列 `deleted_at IS NOT NULL` 的线程，
   * `deleted_at DESC, id ASC` 决胜 + 游标分页；活跃线程永不入列，
   * 跨项目由 tuple 谓词机械隔离。
   */
  listDeletedThreads(
    databasePath: string,
    projectId: string,
    rawInput?: unknown,
  ): PublicCollaborationCommandResult<RecycleBinListResponseDto>;
  listProjectTags(
    databasePath: string,
    projectId: string,
    rawInput?: unknown,
  ): PublicCollaborationCommandResult<ThreadTagListResponseDto>;
  listThreadQueue(
    databasePath: string,
    projectId: string,
    threadId: string,
  ): PublicCollaborationCommandResult<ThreadQueueListResponseDto>;
  readThreadDetail(
    databasePath: string,
    projectId: string,
    threadId: string,
    selectedRunId: string | null,
  ): PublicCollaborationCommandResult<Record<string, unknown>>;
  readThreadMessages(
    databasePath: string,
    projectId: string,
    threadId: string,
    rawInput?: unknown,
  ): PublicCollaborationCommandResult<MessagePageResponse>;
  readThreadFacts(
    databasePath: string,
    projectId: string,
    threadId: string,
    rawInput?: unknown,
  ): PublicCollaborationCommandResult<FactPageResponse>;
  readThreadOperation(
    databasePath: string,
    projectId: string,
    threadId: string,
    operationId: string,
  ): PublicCollaborationCommandResult<Record<string, unknown>>;
  readThreadDraft(
    databasePath: string,
    projectId: string,
    threadId: string,
  ): PublicCollaborationCommandResult<ThreadDraftReadResponse>;
  searchInputHistory(
    databasePath: string,
    projectId: string,
    query: string,
  ): PublicCollaborationCommandResult<InputHistorySearchResponse>;

  getCollaboration(
    databasePath: string,
    projectId: string,
    options?: {
      events?: PublicCollaborationPageCursor;
      messages?: PublicCollaborationPageCursor;
    },
  ): CollaborationReadResponse;
  getRunTimeline(
    databasePath: string,
    runId: string,
    cursor: PublicCollaborationPageCursor,
  ): CursorPage<TimelineEvent>;
  readRunTimeline(
    databasePath: string,
    projectId: string,
    threadId: string,
    runId: string,
    cursor: PublicCollaborationPageCursor,
  ): PublicCollaborationCommandResult<CursorPage<TimelineEvent>>;

  readStructuredMessage(
    databasePath: string,
    tuple: { messageId: string; projectId: string; threadId: string },
  ): unknown;
  readAttachmentContent(
    databasePath: string,
    attachmentsRoot: string,
    projectId: string,
    threadId: string,
    attachmentId: string,
  ): { bytes: Uint8Array; mimeType: MessageAttachmentMimeType };
  readInlineOperation(
    databasePath: string,
    tuple: { projectId: string; runId: string; threadId: string },
    operationId: string,
  ): PublicCollaborationCommandResult<unknown>;

  /**
   * 项目级待决 proposal 只读列表（特性 029 T-01）：仅 head 状态为 pending 的
   * proposal 块入列；VERSION_CONFLICT 是裁决时结果而非持久状态，不改变块状态。
   * 供 governance 审批中心等跨域聚合经本公开缝取数，避免直读本域表。
   */
  listPendingProposals(
    databasePath: string,
    projectId: string,
  ): PendingProposalDto[];
}
