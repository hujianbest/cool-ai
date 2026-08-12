import type { TransactionContext } from "@/src/application/transaction-context";
import type { WorkItem } from "@/src/shared/project-context-contracts";

import type {
  AttachmentRemoveResponse,
  AttachmentUploadResponse,
  ControlResponse,
  DecisionAnswerResponse,
  InputHistoryClearResponse,
  ProjectMessageResponse,
  RunStartResponse,
  StartCollaborationResponse,
  ThreadDeleteResponse,
  ThreadPurgeResponse,
  ThreadDraftClearResponse,
  ThreadDraftSaveResponse,
  ThreadFavoriteSetResponse,
  ThreadQueueCancelResponse,
  ThreadQueueEnqueueResponse,
  ThreadQueueReorderResponse,
  ThreadQueueSteerResponse,
  ThreadRestoreResponse,
  ThreadTagAssignmentResponse,
  ThreadTagBatchResponse,
  ThreadTagCreateResponse,
  ThreadTagDeleteResponse,
} from "./dto";

export type TransitionReceipt =
  | { ok: true; workItem: WorkItem }
  | {
      error: {
        blockers?: Array<{ code: string; workItemId: string | null }>;
        code: string;
        currentVersion?: number;
        message: string;
        status: number;
      };
      ok: false;
    };

export type ControlOperationPrior = {
  kind: string;
  requestHash: string;
  responseJson: string;
  status: string;
};

/**
 * T-06 预建的 public-collaboration 公开面（T-10 波次落地完整 Module）：
 * mission 控制类 operation receipt 的注册/重放能力。当前具体实现为
 * src/adapters/outbound/sqlite/public-collaboration/mission-control-receipts.ts 的
 * DatabaseSync 自由函数（adapter→adapter 过渡边，T-13/T-14 收编为事务协调 Port 形态）。
 */
export interface MissionControlReceiptCommands {
  insertTransitionReceipt(
    transaction: TransactionContext,
    input: {
      operationId: string;
      projectId: string;
      requestHash: string;
      receipt: TransitionReceipt;
    },
  ): void;
  readControlOperationPrior(
    transaction: TransactionContext,
    projectId: string,
    operationId: string,
  ): ControlOperationPrior | undefined;
}

/** 命令级 envelope（当前实现以 { body, status } 承载，T-14 入站收编后由 route 仅依赖本面）。 */
export type PublicCollaborationCommandResult<Body> = {
  body: Body;
  status: number;
};

/**
 * public-collaboration 公开命令面（DTO 级声明，不要求具体实现 implements）。
 * 当前具体实现为 src/adapters/outbound/sqlite/public-collaboration/ 下的 DatabaseSync
 * 自由函数，由 app/api route 与留原地的 *-api 传输层直接调用（A-103 过渡形态，
 * T-13/T-14 收编为 Workflow/事务协调 Port）。
 * 说明：
 * - rawInput 为传输层未知输入，由实现侧 parse*Input 严格校验；
 * - ThreadCreateResponse/PolicyUpdateResponse/ThreadMessageResponse/RecoverRunResponse/
 *   AdvanceExecutionResponse 等精确 DTO 尚未沉淀进 src/shared 契约，先以
 *   Record<string, unknown> 登记 seam，随契约沉淀收窄（同 safe-execution 先例）；
 * - 实现签名的测试 hooks（ThreadControlHooks 等）为测试接缝，不在本面声明。
 */
export interface PublicCollaborationCommands {
  createThread(
    databasePath: string,
    projectId: string,
    rawInput: unknown,
  ): PublicCollaborationCommandResult<Record<string, unknown>>;
  updateThreadPolicy(
    databasePath: string,
    projectId: string,
    threadId: string,
    rawInput: unknown,
  ): PublicCollaborationCommandResult<Record<string, unknown>>;
  writeOwnerThreadMessage(
    databasePath: string,
    projectId: string,
    threadId: string,
    rawInput: unknown,
  ): PublicCollaborationCommandResult<Record<string, unknown>>;
  enqueueThreadMessage(
    databasePath: string,
    projectId: string,
    threadId: string,
    rawInput: unknown,
  ): PublicCollaborationCommandResult<ThreadQueueEnqueueResponse>;
  cancelQueuedMessage(
    databasePath: string,
    projectId: string,
    threadId: string,
    queueItemId: string,
    rawInput: unknown,
  ): PublicCollaborationCommandResult<ThreadQueueCancelResponse>;
  reorderQueuedMessage(
    databasePath: string,
    projectId: string,
    threadId: string,
    queueItemId: string,
    rawInput: unknown,
  ): PublicCollaborationCommandResult<ThreadQueueReorderResponse>;
  steerQueuedMessage(
    databasePath: string,
    projectId: string,
    threadId: string,
    queueItemId: string,
    rawInput: unknown,
  ): PublicCollaborationCommandResult<ThreadQueueSteerResponse>;

  saveThreadDraft(
    databasePath: string,
    projectId: string,
    threadId: string,
    rawInput: unknown,
  ): PublicCollaborationCommandResult<ThreadDraftSaveResponse>;
  uploadAttachment(
    databasePath: string,
    attachmentsRoot: string,
    projectId: string,
    threadId: string,
    rawInput: { bytes: Uint8Array; fileName: unknown },
  ): PublicCollaborationCommandResult<AttachmentUploadResponse>;
  removeAttachment(
    databasePath: string,
    attachmentsRoot: string,
    projectId: string,
    threadId: string,
    attachmentId: string,
  ): PublicCollaborationCommandResult<AttachmentRemoveResponse>;
  clearThreadDraft(
    databasePath: string,
    projectId: string,
    threadId: string,
  ): PublicCollaborationCommandResult<ThreadDraftClearResponse>;
  setThreadFavorite(
    databasePath: string,
    projectId: string,
    threadId: string,
    rawInput: unknown,
  ): PublicCollaborationCommandResult<ThreadFavoriteSetResponse>;
  deleteThread(
    databasePath: string,
    projectId: string,
    threadId: string,
  ): PublicCollaborationCommandResult<ThreadDeleteResponse>;
  restoreThread(
    databasePath: string,
    projectId: string,
    threadId: string,
  ): PublicCollaborationCommandResult<ThreadRestoreResponse>;
  purgeThread(
    databasePath: string,
    attachmentsRoot: string,
    projectId: string,
    threadId: string,
  ): PublicCollaborationCommandResult<ThreadPurgeResponse>;
  createThreadTag(
    databasePath: string,
    projectId: string,
    rawInput: unknown,
  ): PublicCollaborationCommandResult<ThreadTagCreateResponse>;
  deleteThreadTag(
    databasePath: string,
    projectId: string,
    tagId: string,
  ): PublicCollaborationCommandResult<ThreadTagDeleteResponse>;
  setThreadTagAssignment(
    databasePath: string,
    projectId: string,
    threadId: string,
    rawInput: unknown,
  ): PublicCollaborationCommandResult<ThreadTagAssignmentResponse>;
  applyThreadTagBatch(
    databasePath: string,
    projectId: string,
    rawInput: unknown,
  ): PublicCollaborationCommandResult<ThreadTagBatchResponse>;
  clearInputHistory(
    databasePath: string,
    projectId: string,
  ): PublicCollaborationCommandResult<InputHistoryClearResponse>;

  startThreadRun(
    databasePath: string,
    projectId: string,
    threadId: string,
    rawInput: unknown,
  ): PublicCollaborationCommandResult<RunStartResponse>;
  controlThreadRun(
    databasePath: string,
    projectId: string,
    threadId: string,
    runId: string,
    rawInput: unknown,
  ): PublicCollaborationCommandResult<ControlResponse>;
  answerThreadDecision(
    databasePath: string,
    projectId: string,
    threadId: string,
    runId: string,
    decisionId: string,
    rawInput: unknown,
  ): PublicCollaborationCommandResult<DecisionAnswerResponse>;
  recoverRun(
    databasePath: string,
    tuple: { projectId: string; threadId: string; runId: string },
    rawInput: unknown,
  ): PublicCollaborationCommandResult<Record<string, unknown>>;
  executeAdvance(
    databasePath: string,
    tuple: { projectId: string; threadId: string; runId: string },
    rawInput: unknown,
  ): Promise<Record<string, unknown>>;

  createOrAppendRun(
    databasePath: string,
    projectId: string,
    rawInput: unknown,
  ): PublicCollaborationCommandResult<StartCollaborationResponse>;
  appendProjectMessage(
    databasePath: string,
    projectId: string,
    rawInput: unknown,
  ): PublicCollaborationCommandResult<ProjectMessageResponse>;

  appendStructuredMessage(
    databasePath: string,
    input: {
      actor: { displayName: string; id: string | null; type: "owner" | "agent" };
      blocksRaw: string | Uint8Array;
      content: string;
      factId: string;
      messageId: string;
      projectId: string;
      runId: string | null;
      threadId: string;
      timestamp: string;
    },
  ): void;
  decideInline(
    databasePath: string,
    tuple: {
      blockId: string;
      messageId: string;
      projectId: string;
      runId: string;
      threadId: string;
    },
    raw: string | Uint8Array,
  ): PublicCollaborationCommandResult<unknown>;
}
