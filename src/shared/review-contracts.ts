import { z } from "zod";

const evidenceRefSchema = z.object({
  id: z.string().min(1),
  type: z.enum(["task", "result", "review", "validation", "artifact"]),
  version: z.string().min(1),
}).strict();

export const reviewOutputSchema = z.object({
  decision: z.discriminatedUnion("choice", [
    z.object({ choice: z.literal("reject"), reworkRequirements: z.array(z.string().trim().min(1)).min(1) }).strict(),
    z.object({ choice: z.literal("escalate"), question: z.string().trim().min(1), options: z.array(z.string().trim().min(1)).min(2) }).strict(),
    z.object({ choice: z.literal("pass") }).strict(),
  ]),
  evidenceRefs: z.array(evidenceRefSchema),
  findings: z.array(z.object({
    detail: z.string().trim().min(1),
    evidenceRefs: z.array(evidenceRefSchema),
    title: z.string().trim().min(1),
  }).strict()),
  limitations: z.array(z.string().trim().min(1)),
  memoryCandidates: z.array(z.never()),
  publicSummary: z.string().trim().min(1),
}).strict();

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
