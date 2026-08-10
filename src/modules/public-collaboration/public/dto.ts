/**
 * public-collaboration 公开 DTO 面（T-10）：
 * - 传输/读模型 DTO 复用 src/shared/collaboration-contracts 的冻结契约；
 * - 纯领域类型（agent turn/结构化块/structured turn 结果/公开文本凭据类别）
 *   自 internal 纯逻辑文件 re-export，供消费方经模块公开面访问；
 * - 命令输入在实现侧仍以 rawInput: unknown 由传输层解析（thread-service/run-service
 *   的 parse*Input），精确的公开 Input 类型随 T-14 入站收编沉淀。
 */
export type {
  AnswerDecisionResponse,
  AttachmentRemoveResponse,
  AttachmentUploadResponse,
  CollaborationApiError,
  CollaborationErrorCode,
  CollaborationReadResponse,
  CollaborationRun,
  ControlResponse,
  CursorPage,
  DecisionAnswerResponse,
  DecisionRequest,
  DispatchReadiness,
  FactPageResponse,
  MemberPolicyDto,
  MessageAttachmentDto,
  MessageAttachmentMimeType,
  MessagePageResponse,
  ModelCallPublicError,
  ModelCallResult,
  ModelCallStatus,
  ModelCallUsage,
  OpenAiChatMessage,
  PolicyAvailability,
  ProjectMessage,
  ProjectMessageResponse,
  PublicStructuredBlockEnvelope,
  RunErrorCategory,
  RunStartResponse,
  StartCollaborationResponse,
  ThreadDecisionDto,
  ThreadDispatchReadiness,
  ThreadDraftAttachmentDto,
  ThreadDraftClearResponse,
  ThreadDraftDto,
  ThreadDraftReadResponse,
  ThreadDraftSaveResponse,
  InputHistoryClearResponse,
  InputHistoryEntryDto,
  InputHistorySearchResponse,
  ThreadFactBase,
  ThreadFactDto,
  ThreadFavoriteSetResponse,
  ThreadListItemDto,
  ThreadListResponseDto,
  ThreadMessageAttachmentRefDto,
  ThreadMessageDto,
  ThreadMessageReplySnapshot,
  ThreadRunDto,
  TimelineEvent,
  TimelineEventType,
  TimelinePayload,
  TimelinePayloadByType,
  UsageTotals,
} from "@/src/shared/collaboration-contracts";

export type {
  AgentTurn,
  AgentTurnParseResult,
  ProposedTask,
} from "../internal/agent-turn-schema";
export type {
  AgentStructuredBlock,
  StructuredBlock,
} from "../internal/structured-message-schema";
export type {
  StructuredCallUsage,
  StructuredModelCall,
  StructuredTurnResult,
} from "../internal/structured-repair";
export type { PublicTextCredentialCategory } from "../internal/public-text-credential-classifier";

/**
 * 时间线/消息读模型的游标形状（实现侧 ReadCursor/TimelineCursor 的 DTO 级对应物，
 * 结构一致；精确的命名类型随 T-14 契约沉淀收敛）。
 */
export type PublicCollaborationPageCursor = {
  after: number;
  limit: number;
};

/**
 * 待决内联决策 proposal 的跨域只读投影（特性 029 T-01 公开查询缝）。
 * 只承载公开白名单字段：proposal payload 的 title/body 与定位 id；
 * 状态语义由查询保证（仅 head 状态为 pending 的 proposal 入列）。
 */
export type PendingProposalDto = {
  blockId: string;
  body: string;
  createdAt: string;
  messageId: string;
  runId: string | null;
  threadId: string;
  title: string;
};
