import { z } from "zod";

const segmenter = new Intl.Segmenter("zh-CN", { granularity: "grapheme" });

function publicText(maximum: number) {
  return z.string()
    .transform((value) => value.trim())
    .refine((value) => {
      const length = Array.from(segmenter.segment(value)).length;
      return length >= 1 && length <= maximum;
    });
}

export const reviewEvidenceRefSchema = z.object({
  id: z.string().min(1),
  type: z.enum(["task", "result", "review", "validation", "artifact"]),
  version: z.string().min(1),
}).strict();

const reviewMemoryCandidateSchema = z.object({
  type: z.enum(["decision", "fact", "artifact", "experience"]),
  content: publicText(20_000),
  source: reviewEvidenceRefSchema,
  supersedesMemoryId: z.string().min(1).nullable(),
}).strict();

const escalationOptionsSchema = z.array(publicText(500))
  .min(2)
  .max(8)
  .refine((options) => new Set(options).size === options.length);

export const reviewOutputSchema = z.object({
  decision: z.discriminatedUnion("choice", [
    z.object({
      choice: z.literal("reject"),
      reworkRequirements: z.array(publicText(5_000)).min(1),
    }).strict(),
    z.object({
      choice: z.literal("escalate"),
      question: publicText(1_000),
      options: escalationOptionsSchema,
    }).strict(),
    z.object({ choice: z.literal("pass") }).strict(),
  ]),
  evidenceRefs: z.array(reviewEvidenceRefSchema),
  findings: z.array(z.object({
    detail: publicText(5_000),
    evidenceRefs: z.array(reviewEvidenceRefSchema),
    title: publicText(5_000),
  }).strict()),
  limitations: z.array(publicText(5_000)),
  memoryCandidates: z.array(reviewMemoryCandidateSchema),
  publicSummary: publicText(20_000),
}).strict();

export type ReviewOutput = z.infer<typeof reviewOutputSchema>;

const localFinalizeRetrySchema = z.object({
  attemptId: z.string().min(1),
  checkpointHash: z.string().regex(/^[0-9a-f]{64}$/u),
  kind: z.literal("local-finalize-only"),
  providerCallRequired: z.literal(false),
}).strict();

const newProviderAttemptRetrySchema = z.object({
  attemptId: z.string().min(1),
  kind: z.literal("new-provider-attempt"),
  providerCallRequired: z.literal(true),
}).strict();

const noRetrySchema = z.object({
  kind: z.literal("none"),
  providerCallRequired: z.literal(false),
}).strict();

export const reviewOperationResponseSchema = z.discriminatedUnion("state", [
  z.object({
    attemptId: z.string().min(1),
    checkpointHash: z.string().regex(/^[0-9a-f]{64}$/u),
    retry: localFinalizeRetrySchema,
    state: z.literal("finalizing"),
  }).strict(),
  z.object({
    attemptId: z.string().min(1),
    errorCategory: z.string().min(1),
    retry: newProviderAttemptRetrySchema,
    state: z.literal("failed"),
  }).strict(),
  z.object({
    attemptId: z.string().min(1),
    checkpointHash: z.string().regex(/^[0-9a-f]{64}$/u),
    decisionId: z.string().min(1),
    retry: noRetrySchema,
    state: z.literal("rejected"),
  }).strict(),
  z.object({
    attemptId: z.string().min(1),
    checkpointHash: z.string().regex(/^[0-9a-f]{64}$/u),
    decisionId: z.string().min(1),
    escalationId: z.string().min(1),
    retry: noRetrySchema,
    state: z.literal("escalated"),
  }).strict(),
  z.object({
    attemptId: z.string().min(1),
    checkpointHash: z.string().regex(/^[0-9a-f]{64}$/u),
    decisionId: z.string().min(1),
    retry: noRetrySchema,
    state: z.literal("passed"),
  }).strict(),
]);

export type ReviewOperationResponse = z.infer<typeof reviewOperationResponseSchema>;

export const startReviewInputSchema = z.object({
  expectedHeadVersion: z.number().int().min(1),
  operationId: z.string().uuid(),
  resultId: z.string().min(1),
  reviewerAgentId: z.string().min(1),
}).strict();

const identifierSchema = z.string().min(1);
const hashSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const timestampSchema = z.string().datetime({ offset: true });
const nonnegativeIntegerSchema = z.number().int().nonnegative();

export const reviewCandidateDtoSchema = z.object({
  agent: z.object({
    accentToken: identifierSchema,
    avatarText: z.string(),
    id: identifierSchema,
    name: identifierSchema,
    role: identifierSchema,
  }).strict(),
  provider: z.object({
    id: identifierSchema,
    model: identifierSchema,
    name: identifierSchema,
  }).strict(),
  qualification: z.tuple([
    z.literal("current_member"),
    z.literal("review_capable"),
    z.literal("not_executor"),
  ]),
}).strict();

export type ReviewCandidateDto = z.infer<typeof reviewCandidateDtoSchema>;

const reportedUsageSchema = z.discriminatedUnion("reported", [
  z.object({
    completionTokens: nonnegativeIntegerSchema,
    promptTokens: nonnegativeIntegerSchema,
    reported: z.literal(true),
    totalTokens: nonnegativeIntegerSchema,
  }).strict().refine(
    ({ completionTokens, promptTokens, totalTokens }) =>
      promptTokens + completionTokens === totalTokens,
  ),
  z.object({
    completionTokens: z.null(),
    promptTokens: z.null(),
    reported: z.literal(false),
    totalTokens: z.null(),
  }).strict(),
]);

const reviewCallFailureSchema = z.object({
  apiErrorCode: z.enum([
    "PROVIDER_AUTH",
    "RATE_LIMITED",
    "PROVIDER_UPSTREAM",
    "PROVIDER_UNREACHABLE",
    "PROVIDER_RESPONSE_INVALID",
    "PROVIDER_TIMEOUT",
    "STRUCTURED_OUTPUT_INVALID",
    "REVIEW_OUTPUT_REDACTED",
  ]).nullable(),
  category: z.enum([
    "auth",
    "rate_limit",
    "upstream",
    "network",
    "timeout",
    "schema",
    "usage",
    "redaction",
    "interrupted",
    "stale",
  ]),
}).strict();

const callBaseShape = {
  callIndex: z.union([z.literal(1), z.literal(2)]),
  id: identifierSchema,
  kind: z.enum(["primary", "repair"]),
  startedAt: timestampSchema,
  usage: reportedUsageSchema,
};

export const reviewModelCallDtoSchema = z.discriminatedUnion("status", [
  z.object({
    ...callBaseShape,
    failure: z.null(),
    finishedAt: z.null(),
    status: z.literal("calling"),
  }).strict(),
  z.object({
    ...callBaseShape,
    failure: z.null(),
    finishedAt: timestampSchema,
    status: z.literal("succeeded"),
  }).strict(),
  ...([
    "provider_failed",
    "response_invalid",
    "usage_invalid",
    "interrupted",
    "discarded",
  ] as const).map((status) => z.object({
    ...callBaseShape,
    failure: reviewCallFailureSchema,
    finishedAt: timestampSchema,
    status: z.literal(status),
  }).strict()),
]);

export const reviewCheckpointDtoSchema = z.object({
  checkpointedAt: timestampSchema,
  publicOutputHash: hashSchema,
}).strict();

const localFinalizeSchema = z.object({
  checkpoint: reviewCheckpointDtoSchema,
  lastErrorCode: z.enum(["REVIEW_FINALIZE_FAILED", "STORAGE_UNAVAILABLE"]).nullable(),
  mode: z.literal("local-finalize-only"),
  retryRequiresProvider: z.literal(false),
}).strict();
const newProviderAttemptSchema = z.object({
  checkpoint: z.null(),
  lastErrorCode: z.string().nullable(),
  mode: z.literal("new-provider-attempt"),
  retryRequiresProvider: z.literal(true),
}).strict();
const noRetryWithoutCheckpointSchema = z.object({
  checkpoint: z.null(),
  lastErrorCode: z.string().nullable(),
  mode: z.literal("none"),
  retryRequiresProvider: z.literal(false),
}).strict();
const noRetryWithCheckpointSchema = z.object({
  checkpoint: reviewCheckpointDtoSchema,
  lastErrorCode: z.string().nullable(),
  mode: z.literal("none"),
  retryRequiresProvider: z.literal(false),
}).strict();

const reviewDecisionDtoSchema = z.object({
  choice: z.enum(["reject", "escalate", "pass"]),
  evidenceRefs: z.array(reviewEvidenceRefSchema),
  findings: z.array(z.unknown()),
  id: identifierSchema,
  publicSummary: z.string(),
}).strict();

const attemptBaseShape = {
  calls: z.array(reviewModelCallDtoSchema).max(2).superRefine((calls, context) => {
    const indexes = calls.map(({ callIndex }) => callIndex);
    if (new Set(indexes).size !== indexes.length) {
      context.addIssue({ code: "custom", message: "Duplicate call index." });
    }
    for (const call of calls) {
      if (
        (call.callIndex === 1 && call.kind !== "primary")
        || (call.callIndex === 2 && call.kind !== "repair")
      ) {
        context.addIssue({ code: "custom", message: "Call kind/index mismatch." });
      }
    }
  }),
  errorCategory: z.string().nullable(),
  id: identifierSchema,
  material: z.object({
    hash: hashSchema,
    resultVersion: z.number().int().positive(),
    sourceCount: nonnegativeIntegerSchema,
  }).strict(),
  provider: z.object({
    id: identifierSchema,
    model: identifierSchema,
    name: identifierSchema,
    version: z.number().int().positive(),
  }).strict(),
  result: z.object({ id: identifierSchema, version: z.number().int().positive() }).strict(),
  reviewer: z.object({
    accentToken: identifierSchema,
    avatarText: z.string(),
    id: identifierSchema,
    name: identifierSchema,
  }).strict(),
  startedAt: timestampSchema,
  usageTotal: z.object({
    completionTokens: nonnegativeIntegerSchema,
    promptTokens: nonnegativeIntegerSchema,
    repairCalls: z.number().int().min(0).max(1),
    reportedCalls: z.number().int().min(0).max(2),
    totalTokens: nonnegativeIntegerSchema,
    unreportedCalls: z.number().int().min(0).max(2),
  }).strict().refine(
    ({ completionTokens, promptTokens, reportedCalls, totalTokens, unreportedCalls }) =>
      promptTokens + completionTokens === totalTokens
      && reportedCalls + unreportedCalls <= 2,
  ),
};

export const reviewAttemptDtoSchema = z.discriminatedUnion("status", [
  z.object({
    ...attemptBaseShape,
    decision: z.null(),
    finalize: z.union([
      localFinalizeSchema,
      noRetryWithoutCheckpointSchema.extend({
        lastErrorCode: z.null(),
      }),
    ]),
    finishedAt: z.null(),
    status: z.literal("calling"),
  }).strict(),
  z.object({
    ...attemptBaseShape,
    decision: z.null(),
    finalize: localFinalizeSchema,
    finishedAt: z.string().datetime({ offset: true }).nullable(),
    status: z.literal("finalizing"),
  }).strict(),
  z.object({
    ...attemptBaseShape,
    decision: z.null(),
    finalize: z.union([
      newProviderAttemptSchema,
      localFinalizeSchema,
      noRetryWithCheckpointSchema,
    ]),
    finishedAt: timestampSchema,
    status: z.literal("failed"),
  }).strict(),
  z.object({
    ...attemptBaseShape,
    decision: z.null(),
    finalize: newProviderAttemptSchema,
    finishedAt: timestampSchema,
    status: z.literal("interrupted"),
  }).strict(),
  z.object({
    ...attemptBaseShape,
    decision: z.null(),
    finalize: z.union([noRetryWithoutCheckpointSchema, noRetryWithCheckpointSchema]),
    finishedAt: timestampSchema,
    status: z.literal("discarded"),
  }).strict(),
  ...(["rejected", "escalated", "passed"] as const).map((status) => z.object({
    ...attemptBaseShape,
    decision: reviewDecisionDtoSchema,
    finalize: noRetryWithCheckpointSchema.extend({ lastErrorCode: z.null() }),
    finishedAt: timestampSchema,
    status: z.literal(status),
  }).strict()),
]);

export type StrictReviewAttemptDto = z.infer<typeof reviewAttemptDtoSchema>;
export type ReviewAttemptDto = {
  calls: Array<{
    callIndex?: 1 | 2;
    failure?: null | { apiErrorCode: string | null; category: string };
    finishedAt?: string | null;
    id: string;
    kind?: "primary" | "repair";
    startedAt?: string;
    status: string;
    usage: {
      completionTokens: number | null;
      promptTokens: number | null;
      reported: boolean;
      totalTokens: number | null;
    };
  }>;
  decision: null | {
    choice: "reject" | "escalate" | "pass";
    evidenceRefs?: Array<z.infer<typeof reviewEvidenceRefSchema>>;
    findings?: unknown[];
    id: string;
    publicSummary: string;
  };
  errorCategory?: string | null;
  finalize?: z.infer<typeof localFinalizeSchema>
    | z.infer<typeof newProviderAttemptSchema>
    | z.infer<typeof noRetryWithoutCheckpointSchema>
    | z.infer<typeof noRetryWithCheckpointSchema>;
  finishedAt?: string | null;
  id: string;
  material: { hash: string; resultVersion?: number; sourceCount: number };
  provider: { id: string; model: string; name: string; version?: number };
  result?: { id: string; version: number };
  reviewer: { accentToken: string; avatarText: string; id: string; name: string };
  startedAt?: string;
  status: "calling" | "finalizing" | "rejected" | "escalated" | "passed"
    | "failed" | "interrupted" | "discarded";
  usageTotal: {
    completionTokens: number;
    promptTokens: number;
    repairCalls?: number;
    reportedCalls: number;
    totalTokens: number;
    unreportedCalls?: number;
  };
};
export const reviewAttemptHistoryItemDtoSchema = reviewAttemptDtoSchema;
export const reviewAttemptDetailDtoSchema = z.object({
  candidateAssociations: z.array(z.unknown()),
  escalation: z.unknown().nullable(),
  frozenMaterial: z.unknown(),
}).passthrough().superRefine((value, context) => {
  const attemptKeys = [
    ...Object.keys(attemptBaseShape),
    "decision",
    "finalize",
    "finishedAt",
    "status",
  ];
  const parsed = reviewAttemptDtoSchema.safeParse(
    Object.fromEntries(attemptKeys.map((key) => [key, value[key]])),
  );
  if (!parsed.success) {
    parsed.error.issues.forEach((issue) => context.addIssue({
      code: "custom",
      message: issue.message,
      path: issue.path,
    }));
  }
  const allowed = new Set([
    ...Object.keys(attemptBaseShape),
    "candidateAssociations",
    "decision",
    "escalation",
    "finalize",
    "finishedAt",
    "frozenMaterial",
    "status",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) context.addIssue({ code: "custom", message: `Unknown key: ${key}` });
  }
});

export const reviewWorkspaceDtoSchema = z.object({
  blockers: z.array(z.object({ code: identifierSchema, refId: identifierSchema.nullable() }).strict()),
  candidates: z.array(reviewCandidateDtoSchema),
  currentAttempt: reviewAttemptDtoSchema.nullable(),
  effectiveStatus: z.enum([
    "executing",
    "pending_review",
    "reviewing",
    "rework",
    "waiting_owner",
    "passed",
  ]),
  escalation: z.object({
    answer: z.object({
      action: identifierSchema,
      answer: z.string(),
      createdAt: timestampSchema,
      id: identifierSchema,
    }).strict().nullable(),
    id: identifierSchema,
    options: z.array(z.string()),
    question: z.string(),
  }).strict().nullable(),
  headVersion: z.number().int().positive(),
  historyCount: nonnegativeIntegerSchema,
  result: z.object({
    createdAt: timestampSchema,
    executorAgentId: identifierSchema,
    id: identifierSchema,
    version: z.number().int().positive(),
  }).strict().nullable(),
  workItem: z.object({
    boardStatus: identifierSchema,
    id: identifierSchema,
    title: identifierSchema,
    version: z.number().int().positive(),
  }).strict(),
}).strict();

export type StrictReviewWorkspaceDto = z.infer<typeof reviewWorkspaceDtoSchema>;
export type ReviewWorkspaceDto = {
  blockers: Array<{ code: string; refId?: string | null }>;
  candidates: ReviewCandidateDto[];
  currentAttempt: ReviewAttemptDto | null;
  effectiveStatus: "executing" | "pending_review" | "reviewing" | "rework"
    | "waiting_owner" | "passed";
  escalation?: StrictReviewWorkspaceDto["escalation"];
  headVersion: number;
  historyCount?: number;
  result: {
    createdAt?: string;
    executorAgentId: string;
    id: string;
    version: number;
  };
  workItem: { boardStatus?: string; id: string; title: string; version?: number };
};

export const reviewEventTypeSchema = z.enum([
  "review_candidates_evaluated",
  "review_started",
  "review_model_call_started",
  "review_model_call_succeeded",
  "review_model_call_failed",
  "review_usage_recorded",
  "review_output_checkpointed",
  "review_finalize_failed",
  "review_attempt_failed",
  "review_attempt_interrupted",
  "review_attempt_discarded",
  "review_decided",
  "rework_requested",
  "escalation_opened",
  "escalation_answered",
  "result_version_created",
  "memory_reused",
  "memory_created",
  "memory_superseded",
  "work_item_passed",
  "work_item_invalidated",
  "completion_write_rejected",
  "delivery_generation_started",
  "delivery_generation_failed",
  "delivery_completed",
  "delivery_invalidated",
  "mission_review_initialized",
  "mission_context_changed",
  "mission_terminated",
  "operation_replayed",
]);

const eventEnvelope = {
  actorId: identifierSchema.nullable(),
  actorType: z.enum(["owner", "agent", "system"]),
  createdAt: timestampSchema,
  id: identifierSchema,
  sequence: z.number().int().positive(),
};
function eventVariant(type: z.infer<typeof reviewEventTypeSchema>, payload: z.ZodType) {
  return z.object({ ...eventEnvelope, payload, type: z.literal(type) }).strict();
}
const modelCallEvent = z.object({
  attemptId: identifierSchema,
  kind: z.enum(["primary", "repair"]),
  modelCallId: identifierSchema,
}).strict();
const memoryEvent = z.object({
  candidateId: identifierSchema,
  decisionId: identifierSchema,
  memoryId: identifierSchema,
  memoryVersion: z.number().int().positive(),
}).strict();
const workEvent = z.object({
  decisionId: identifierSchema,
  reasonCode: z.string().nullable(),
  resultId: identifierSchema,
  workItemId: identifierSchema,
}).strict();
const deliveryGenerationEvent = z.object({
  category: z.string().nullable(),
  inputFingerprint: hashSchema,
  operationId: identifierSchema,
}).strict();

export const reviewEventDtoSchema = z.discriminatedUnion("type", [
  eventVariant("review_candidates_evaluated", z.object({
    blockerCode: z.string().nullable(),
    candidateAgentIds: z.array(identifierSchema),
    resultId: identifierSchema,
    workItemId: identifierSchema,
  }).strict()),
  eventVariant("review_started", z.object({
    attemptId: identifierSchema,
    materialHash: hashSchema,
    resultId: identifierSchema,
    resultVersion: z.number().int().positive(),
    reviewerAgentId: identifierSchema,
    workItemId: identifierSchema,
  }).strict()),
  eventVariant("review_model_call_started", modelCallEvent),
  eventVariant("review_model_call_succeeded", modelCallEvent),
  eventVariant("review_model_call_failed", modelCallEvent.extend({ category: identifierSchema })),
  eventVariant("review_usage_recorded", z.object({
    attemptId: identifierSchema,
    completionTokens: nonnegativeIntegerSchema.nullable(),
    modelCallId: identifierSchema,
    promptTokens: nonnegativeIntegerSchema.nullable(),
    reported: z.boolean(),
    totalTokens: nonnegativeIntegerSchema.nullable(),
  }).strict().superRefine((usage, context) => {
    const values = [usage.promptTokens, usage.completionTokens, usage.totalTokens];
    if (
      (usage.reported && (
        values.some((value) => value === null)
        || usage.promptTokens! + usage.completionTokens! !== usage.totalTokens
      ))
      || (!usage.reported && values.some((value) => value !== null))
    ) {
      context.addIssue({ code: "custom", message: "Invalid reported usage." });
    }
  })),
  eventVariant("review_output_checkpointed", z.object({
    attemptId: identifierSchema,
    modelCallId: identifierSchema,
    publicOutputHash: hashSchema,
  }).strict()),
  eventVariant("review_finalize_failed", z.object({
    attemptId: identifierSchema,
    code: identifierSchema,
    publicOutputHash: hashSchema,
  }).strict()),
  ...(["review_attempt_failed", "review_attempt_interrupted", "review_attempt_discarded"] as const)
    .map((type) => eventVariant(type, z.object({
      attemptId: identifierSchema,
      category: identifierSchema,
    }).strict())),
  eventVariant("review_decided", z.object({
    attemptId: identifierSchema,
    choice: z.enum(["reject", "escalate", "pass"]),
    decisionId: identifierSchema,
    resultId: identifierSchema,
  }).strict()),
  eventVariant("rework_requested", z.object({
    decisionId: identifierSchema,
    resultId: identifierSchema,
    workItemId: identifierSchema,
  }).strict()),
  eventVariant("escalation_opened", z.object({
    decisionId: identifierSchema,
    escalationId: identifierSchema,
    resultId: identifierSchema,
    workItemId: identifierSchema,
  }).strict()),
  eventVariant("escalation_answered", z.object({
    action: z.enum(["continue_review", "rework", "terminate_mission"]),
    answerId: identifierSchema,
    escalationId: identifierSchema,
  }).strict()),
  eventVariant("result_version_created", z.object({
    executionId: identifierSchema,
    resultId: identifierSchema,
    resultVersion: z.number().int().positive(),
    supersedesResultId: identifierSchema.nullable(),
    workItemId: identifierSchema,
  }).strict()),
  eventVariant("memory_reused", memoryEvent),
  eventVariant("memory_created", memoryEvent),
  eventVariant("memory_superseded", memoryEvent),
  eventVariant("work_item_passed", workEvent),
  eventVariant("work_item_invalidated", workEvent),
  eventVariant("completion_write_rejected", z.object({
    blockerCodes: z.array(identifierSchema),
    entryPoint: identifierSchema,
    workItemId: identifierSchema,
  }).strict()),
  eventVariant("delivery_generation_started", deliveryGenerationEvent),
  eventVariant("delivery_generation_failed", deliveryGenerationEvent),
  eventVariant("delivery_completed", z.object({
    deliveryId: identifierSchema,
    deliveryVersion: z.number().int().positive(),
    inputFingerprint: hashSchema,
  }).strict()),
  eventVariant("delivery_invalidated", z.object({
    deliveryId: identifierSchema,
    reasonCode: identifierSchema,
    workItemIds: z.array(identifierSchema),
  }).strict()),
  eventVariant("mission_review_initialized", z.object({
    contextVersion: z.number().int().positive(),
    headVersion: z.number().int().positive(),
    missionId: identifierSchema,
  }).strict()),
  eventVariant("mission_context_changed", z.object({
    contextVersion: z.number().int().positive(),
    missionId: identifierSchema,
    missionVersion: z.number().int().positive(),
    reasonCode: identifierSchema,
  }).strict()),
  eventVariant("mission_terminated", z.object({ reason: z.string().min(1) }).strict()),
  eventVariant("operation_replayed", z.object({
    kind: z.enum(["start_review", "answer_escalation", "generate_delivery", "terminate_mission"]),
    operationId: identifierSchema,
  }).strict()),
]);
