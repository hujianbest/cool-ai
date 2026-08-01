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
]);

export type ReviewOperationResponse = z.infer<typeof reviewOperationResponseSchema>;

export const startReviewInputSchema = z.object({
  expectedHeadVersion: z.number().int().min(1),
  operationId: z.string().uuid(),
  resultId: z.string().min(1),
  reviewerAgentId: z.string().min(1),
}).strict();

export type ReviewCandidateDto = {
  agent: {
    accentToken: string;
    avatarText: string;
    id: string;
    name: string;
    role: string;
  };
  provider: { id: string; model: string; name: string };
  qualification: ["current_member", "review_capable", "not_executor"];
};

export type ReviewAttemptDto = {
  calls: Array<{
    id: string;
    status: "succeeded" | "failed";
    usage: {
      completionTokens: number | null;
      promptTokens: number | null;
      reported: boolean;
      totalTokens: number | null;
    };
  }>;
  decision: null | {
    choice: "reject" | "escalate" | "pass";
    id: string;
    publicSummary: string;
  };
  id: string;
  material: { hash: string; sourceCount: number };
  provider: { id: string; model: string; name: string };
  reviewer: { accentToken: string; avatarText: string; id: string; name: string };
  status: "calling" | "passed" | "failed";
  usageTotal: {
    completionTokens: number;
    promptTokens: number;
    reportedCalls: number;
    totalTokens: number;
  };
};

export type ReviewWorkspaceDto = {
  blockers: Array<{ code: string }>;
  candidates: ReviewCandidateDto[];
  currentAttempt: ReviewAttemptDto | null;
  effectiveStatus: "pending_review" | "reviewing" | "passed";
  headVersion: number;
  result: {
    executorAgentId: string;
    id: string;
    version: number;
  };
  workItem: { id: string; title: string };
};
