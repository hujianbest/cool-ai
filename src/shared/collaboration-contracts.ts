import { z } from "zod";

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
  | "STRUCTURED_OUTPUT_INVALID"
  | "ACTION_INVALID"
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
  | "ACTION_CONFLICT"
  | "BOUNDARY_REACHED"
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
    | "PROVIDER_AUTH"
    | "RATE_LIMITED"
    | "PROVIDER_UPSTREAM"
    | "PROVIDER_UNREACHABLE"
    | "PROVIDER_RESPONSE_INVALID"
    | "PROVIDER_TIMEOUT";
  category:
    | "provider_auth"
    | "rate_limited"
    | "provider_upstream"
    | "provider_unreachable"
    | "provider_response_invalid"
    | "provider_timeout"
    | "usage_invalid";
  correlationId: string;
  httpStatus: 401 | 429 | 502 | 504;
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
  };
};
