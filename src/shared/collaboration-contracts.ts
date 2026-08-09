import { z } from "zod";

export type PolicyAvailability = "ready" | "repair_required";

export type DispatchReadiness =
  | "ready"
  | "project_context_not_ready"
  | "policy_repair_required"
  | "selected_member_provider_unavailable"
  | "project_run_active";

export type MemberPolicyDto = {
  revisionId: string;
  version: number;
  availability: PolicyAvailability;
  members: Array<{
    agentId: string;
    displayNameSnapshot: string;
    position: number;
    live: "current" | "removed";
  }>;
  unavailableMemberIds: string[];
  createdAt: string;
};

export type ThreadDispatchReadiness = {
  dispatch: DispatchReadiness;
  missingProjectFacts: string[];
  selectedMemberId: string | null;
};

export type CollaborationRun = {
  id: string;
  projectId: string;
  status: "running" | "waiting_owner" | "paused" | "failed" | "planned" | "stopped";
  currentAgentId: string;
  roundCount: number;
  pauseCategory: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type ProjectMessage = {
  id: string;
  sequence: number;
  runId: string | null;
  authorType: "owner" | "agent";
  authorAgentId: string | null;
  authorDisplayName: string;
  content: string;
  mentionAgentId: string | null;
  mentionDisplayName: string | null;
  mentionMemberStatus: "current" | "left" | null;
  createdAt: string;
};

export type DecisionRequest = {
  id: string;
  runId: string;
  turnId: string;
  requestingAgentId: string;
  question: string;
  options: string[];
  status: "open" | "answered";
  answer: string | null;
  answerMessageId: string | null;
  version: number;
  createdAt: string;
  answeredAt: string | null;
};

const id = z.string().min(1);
const sequence = z.number().int().nonnegative();
const tokenCount = z.number().int().nonnegative();
const modelCallKind = z.enum(["primary", "repair"]);
const runErrorCategory = z.enum([
  "credential_content_rejected",
  "credential_unavailable",
  "provider_auth",
  "rate_limited",
  "provider_upstream",
  "provider_unreachable",
  "provider_response_invalid",
  "provider_timeout",
  "structured_output_invalid",
  "usage_invalid",
  "action_invalid",
  "action_conflict",
  "boundary_reached",
  "context_changed",
  "interrupted",
  "internal_failure",
]);

export const timelinePayloadSchemas = {
  run_started: z.object({
    messageId: id,
    messageSequence: sequence,
    currentAgentId: id,
  }).strict(),
  owner_message: z.object({
    messageId: id,
    messageSequence: sequence,
    mentionAgentId: id.nullable(),
    mentionDisplayName: z.string().min(1).nullable(),
  }).strict(),
  agent_message: z.object({
    messageId: id,
    messageSequence: sequence,
    agentId: id,
    agentDisplayName: z.string().min(1),
    turnId: id,
  }).strict(),
  model_call_started: z.object({
    attemptId: id,
    agentId: id,
    kind: modelCallKind,
  }).strict(),
  model_call_succeeded: z.object({
    attemptId: id,
    kind: modelCallKind,
  }).strict(),
  model_call_failed: z.object({
    attemptId: id,
    kind: modelCallKind,
    category: runErrorCategory,
  }).strict(),
  usage_recorded: z.object({
    attemptId: id,
    kind: modelCallKind,
    promptTokens: tokenCount,
    completionTokens: tokenCount,
    totalTokens: tokenCount,
    reported: z.boolean(),
  }).strict().refine(
    ({ completionTokens, promptTokens, reported, totalTokens }) =>
      !reported || totalTokens === promptTokens + completionTokens,
  ),
  tasks_created: z.object({
    turnId: id,
    items: z.array(z.object({
      id,
      title: z.string().min(1),
      dependsOnIds: z.array(id),
    }).strict()).max(20),
  }).strict(),
  task_claimed: z.object({
    turnId: id,
    workItemId: id,
    agentId: id,
  }).strict(),
  handoff: z.object({
    turnId: id,
    fromAgentId: id,
    toAgentId: id,
    summary: z.string().min(1),
    reason: z.string().min(1),
    overriddenByMention: z.boolean(),
  }).strict(),
  decision_requested: z.object({
    decisionId: id,
    turnId: id,
    agentId: id,
    question: z.string().min(1),
    options: z.array(z.string().min(1)).min(2).max(8),
  }).strict(),
  decision_answered: z.object({
    decisionId: id,
    messageId: id,
    messageSequence: sequence,
    answer: z.string().min(1),
    nextAgentId: id,
  }).strict(),
  boundary_paused: z.object({
    boundary: z.enum(["tokens", "handoffs", "rounds"]),
    agentId: id,
    value: tokenCount,
    limit: tokenCount,
  }).strict(),
  run_paused: z.object({
    category: z.union([runErrorCategory, z.literal("manual")]),
  }).strict(),
  run_resumed: z.object({ currentAgentId: id }).strict(),
  run_retried: z.object({ currentAgentId: id }).strict(),
  run_planned: z.object({ turnId: id }).strict(),
  run_stopped: z.object({}).strict(),
  attempt_interrupted: z.object({ attemptId: id }).strict(),
  action_rejected: z.object({
    attemptId: id,
    category: z.literal("action_invalid"),
    missing: z.array(z.enum(["participants", "tasks", "claim"])),
  }).strict(),
  context_changed: z.object({ attemptId: id }).strict(),
} as const;

export type TimelineEventType = keyof typeof timelinePayloadSchemas;
export type TimelinePayloadByType = {
  [Type in TimelineEventType]: z.infer<(typeof timelinePayloadSchemas)[Type]>;
};
export type TimelinePayload = TimelinePayloadByType[TimelineEventType];
export type TimelineEvent = {
  [Type in TimelineEventType]: {
    id: string;
    runId: string;
    sequence: number;
    type: Type;
    actorType: "owner" | "agent" | "system";
    actorId: string | null;
    payload: TimelinePayloadByType[Type];
    createdAt: string;
  };
}[TimelineEventType];

export type CursorPage<T> = {
  items: T[];
  nextAfter: number | null;
};

export type PublicStructuredBlockEnvelope = {
  actor: {
    displayName: string;
    id: string | null;
    type: "owner" | "agent";
  };
  blockRevision: number;
  blockSchemaVersion: number;
  blockType: string;
  id: string;
  kind: "known" | "unknown-schema";
  logicalBlockId: string;
  position: number;
  source: {
    entityVersion: string | null;
    id: string;
    kind: string;
    messageId: string;
    projectId: string;
    runId: string | null;
    threadId: string;
  };
  stateVersion?: number;
  payload?: Record<string, unknown>;
  state?: Record<string, unknown> & { stateVersion: number };
};

export type ThreadMessageReplySnapshot = {
  messageId: string;
  sequence: number;
  authorDisplayName: string;
  excerpt: string;
};

export type ThreadMessageDto = {
  id: string;
  projectId: string;
  threadId: string;
  sequence: number;
  runId: string | null;
  authorType: "owner" | "agent";
  authorAgentId: string | null;
  authorDisplayName: string;
  content: string;
  mentionAgentId: string | null;
  mentionDisplayName: string | null;
  mentionMemberStatus: "current" | "left" | null;
  replyTo: ThreadMessageReplySnapshot | null;
  createdAt: string;
  blocks?: PublicStructuredBlockEnvelope[];
};

export type ThreadFactBase = {
  id: string;
  projectId: string;
  threadId: string;
  sequence: number;
  activitySequence: number;
  actorType: "owner" | "agent" | "system";
  actorId: string | null;
  createdAt: string;
};

export type ThreadFactDto =
  | (ThreadFactBase & {
      type: "thread_created";
      runId: null;
      messageId: null;
      runEventId: null;
      policyRevisionId: null;
      payload: { title: string };
      message: null;
    })
  | (ThreadFactBase & {
      type: "policy_changed";
      runId: null;
      messageId: null;
      runEventId: null;
      policyRevisionId: string;
      payload: { policyVersion: number };
      message: null;
    })
  | (ThreadFactBase & {
      type: "owner_message" | "agent_message";
      runId: string | null;
      messageId: string;
      runEventId: null;
      policyRevisionId: null;
      payload: { messageId: string };
      message: ThreadMessageDto;
    })
  | (ThreadFactBase & {
      type: "run_linked";
      runId: string;
      messageId: null;
      runEventId: null;
      policyRevisionId: null;
      payload: { runId: string };
      message: null;
    })
  | (ThreadFactBase & {
      type: "run_event";
      runId: string;
      messageId: null;
      runEventId: string;
      policyRevisionId: null;
      payload: { eventType: TimelineEventType };
      message: null;
    })
  | (ThreadFactBase & {
      type: "inline_decision";
      runId: string;
      messageId: null;
      runEventId: null;
      policyRevisionId: null;
      payload: {
        action: "accept" | "reject" | "check_item" | "uncheck_item";
        blockId: string;
        blockRevision: number;
        decisionId: string;
        fromStateVersion: number;
        operationId: string;
        receiptId: string;
        toStateVersion: number;
      };
      message: null;
    });

export type MessagePageResponse = CursorPage<ThreadMessageDto>;
export type FactPageResponse = CursorPage<ThreadFactDto>;

export type ThreadDraftAttachmentDto = {
  name: string;
  size: number;
};

export type ThreadDraftDto = {
  projectId: string;
  threadId: string;
  content: string;
  attachments: ThreadDraftAttachmentDto[];
  replyToMessageId: string | null;
  version: number;
  updatedAt: string;
};

export type ThreadDraftReadResponse = {
  draft: ThreadDraftDto | null;
};

export type ThreadDraftSaveResponse = {
  contentSaved: boolean;
  draft: ThreadDraftDto;
};

export type ThreadDraftClearResponse = {
  cleared: true;
};

export type InputHistoryEntryDto = {
  id: string;
  threadId: string;
  content: string;
  createdAt: string;
};

export type InputHistorySearchResponse = {
  entries: InputHistoryEntryDto[];
  lastClearedAt: string | null;
};

export type InputHistoryClearResponse = {
  cleared: true;
  clearedAt: string;
};

export type ThreadRunDto = CollaborationRun & {
  threadId: string;
};

export type RunStartResponse = {
  created: true;
  run: ThreadRunDto;
  message: ThreadMessageDto;
  facts: [
    Extract<ThreadFactDto, { type: "run_linked" }>,
    Extract<ThreadFactDto, { messageId: string }> & { type: "owner_message" },
    Extract<ThreadFactDto, { type: "run_event" }>,
  ];
};

export type ControlResponse = {
  run: ThreadRunDto;
  fact: Extract<ThreadFactDto, { type: "run_event" }>;
};

export type ThreadDecisionDto = DecisionRequest & {
  projectId: string;
  threadId: string;
};

export type DecisionAnswerResponse = {
  decision: ThreadDecisionDto;
  run: ThreadRunDto;
  message: ThreadMessageDto;
  facts: [
    Extract<ThreadFactDto, { messageId: string }>,
    Extract<ThreadFactDto, { type: "run_event" }>,
  ];
};

export type CollaborationReadResponse = {
  run: CollaborationRun | null;
  projectMessagesPage: CursorPage<ProjectMessage>;
  timelinePage: CursorPage<TimelineEvent>;
  pendingDecision: DecisionRequest | null;
  usage: UsageTotals;
  readiness: {
    ready: boolean;
    missing: string[];
  };
};

export type UsageTotals = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  repairCalls: number;
  unreportedCalls: number;
  byAgent: Array<{
    agentId: string;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    handoffs: number;
  }>;
};

export type StartCollaborationResponse = {
  created: boolean;
  run: CollaborationRun;
  message: ProjectMessage;
};

export type ProjectMessageResponse = {
  message: ProjectMessage;
  run: CollaborationRun | null;
};

export type AnswerDecisionResponse = {
  decision: DecisionRequest;
  run: CollaborationRun;
};

export type CollaborationErrorCode =
  | "INVALID_JSON"
  | "INVALID_INPUT"
  | "BODY_TOO_LARGE"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "STRUCTURED_OUTPUT_INVALID"
  | "ACTION_INVALID"
  | "RESOURCE_NOT_FOUND"
  | "PROJECT_NOT_FOUND"
  | "RUN_NOT_FOUND"
  | "DECISION_NOT_FOUND"
  | "AGENT_NOT_FOUND"
  | "CONTEXT_NOT_READY"
  | "COLLABORATION_ACTIVE"
  | "AGENT_NOT_MEMBER"
  | "TURN_IN_PROGRESS"
  | "RUN_STATE_CONFLICT"
  | "DECISION_ALREADY_ANSWERED"
  | "OPERATION_CONFLICT"
  | "OPERATION_IN_PROGRESS"
  | "OPERATION_NOT_FOUND"
  | "VERSION_CONFLICT"
  | "PROJECT_RUN_ACTIVE"
  | "THREAD_POLICY_REPAIR_REQUIRED"
  | "ACTION_CONFLICT"
  | "BOUNDARY_REACHED"
  | "CREDENTIAL_CONTENT_REJECTED"
  | "PROVIDER_AUTH"
  | "RATE_LIMITED"
  | "PROVIDER_UPSTREAM"
  | "PROVIDER_UNREACHABLE"
  | "PROVIDER_RESPONSE_INVALID"
  | "PROVIDER_TIMEOUT"
  | "CREDENTIAL_UNAVAILABLE"
  | "STORAGE_UNAVAILABLE"
  | "INTERNAL_ERROR";

export type RunErrorCategory =
  | "configured_provider_key"
  | "private_key"
  | "authorization_header"
  | "credential_field"
  | "credential_content_rejected"
  | "credential_unavailable"
  | "provider_auth"
  | "rate_limited"
  | "provider_upstream"
  | "provider_unreachable"
  | "provider_response_invalid"
  | "provider_timeout"
  | "structured_output_invalid"
  | "usage_invalid"
  | "action_invalid"
  | "action_conflict"
  | "boundary_reached"
  | "context_changed"
  | "interrupted"
  | "internal_failure";

export type OpenAiChatMessage = {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content: string;
};

export type ModelCallUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

export type ModelCallStatus =
  | "succeeded"
  | "provider_failed"
  | "response_invalid"
  | "usage_invalid";

export type ModelCallPublicError = {
  code:
    | "CREDENTIAL_CONTENT_REJECTED"
    | "PROVIDER_AUTH"
    | "RATE_LIMITED"
    | "PROVIDER_UPSTREAM"
    | "PROVIDER_UNREACHABLE"
    | "PROVIDER_RESPONSE_INVALID"
    | "PROVIDER_TIMEOUT";
  category:
    | "credential_content_rejected"
    | "provider_auth"
    | "rate_limited"
    | "provider_upstream"
    | "provider_unreachable"
    | "provider_response_invalid"
    | "provider_timeout"
    | "usage_invalid";
  correlationId: string;
  httpStatus: 401 | 422 | 429 | 502 | 504;
};

export type ModelCallResult = {
  status: ModelCallStatus;
  httpStatus: number | null;
  content: string | null;
  usage: ModelCallUsage | null;
  usageReported: boolean;
  error: ModelCallPublicError | null;
};

export type CollaborationApiError = {
  error: {
    code: CollaborationErrorCode;
    message: string;
    category?: RunErrorCategory;
    fields?: Record<string, string>;
    currentVersion?: number;
    correlationId?: string;
    activeThreadId?: string;
    activeRunId?: string;
  };
};
