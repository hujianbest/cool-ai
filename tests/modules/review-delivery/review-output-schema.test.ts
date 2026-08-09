import { describe, expect, it } from "vitest";

import { reviewOutputSchema } from "@/src/shared/review-contracts";

type ReviewSchemaModule = {
  validateReviewOutput: (
    output: unknown,
    context: {
      candidateActor: { agentId: string; type: "agent" };
      sources: Array<{
        complete: boolean;
        hasVerifiedContent: boolean;
        ref: { id: string; type: string; version: string };
      }>;
    },
  ) => {
    success: boolean;
    output: Record<string, unknown> | null;
    reason: string | null;
  };
};

const reviewSchemaModules = import.meta.glob<ReviewSchemaModule>(
  "../../../src/adapters/outbound/sqlite/review-delivery/review-schema.ts",
);

const resultRef = { id: "result-1", type: "result", version: "2" };
const reviewRef = { id: "attempt-1", type: "review", version: "1" };
const artifactRef = { id: "artifact-1", type: "artifact", version: "a".repeat(64) };
const validationContext = {
  candidateActor: { agentId: "reviewer-1", type: "agent" as const },
  sources: [
    { complete: true, hasVerifiedContent: true, ref: resultRef },
    { complete: true, hasVerifiedContent: true, ref: reviewRef },
    { complete: true, hasVerifiedContent: true, ref: artifactRef },
  ],
};

const base = {
  publicSummary: "公开复核结论",
  findings: [{
    title: "证据充分",
    detail: "结果与验证材料一致。",
    evidenceRefs: [resultRef],
  }],
  evidenceRefs: [resultRef],
  limitations: [],
  memoryCandidates: [],
};

async function loadReviewSchema(): Promise<ReviewSchemaModule> {
  const load = reviewSchemaModules["../../../src/adapters/outbound/sqlite/review-delivery/review-schema.ts"];
  expect(load, "the strict review schema module must exist").toBeTypeOf("function");
  return load();
}

describe("strict review output schema", () => {
  it.each([
    {
      name: "reject",
      decision: { choice: "reject", reworkRequirements: ["补充失败路径测试"] },
    },
    {
      name: "escalate",
      decision: {
        choice: "escalate",
        question: "应采用哪个兼容策略？",
        options: ["保持旧行为", "启用新行为"],
      },
    },
    { name: "pass with zero candidates", decision: { choice: "pass" } },
  ])("accepts exactly one $name decision", ({ decision }) => {
    expect(reviewOutputSchema.safeParse({ ...base, decision }).success).toBe(true);
  });

  it("requires reject rework reasons and enforces the 2..8 escalation option boundary", () => {
    expect(reviewOutputSchema.safeParse({
      ...base,
      decision: { choice: "reject", reworkRequirements: [] },
    }).success).toBe(false);
    expect(reviewOutputSchema.safeParse({
      ...base,
      decision: { choice: "escalate", question: "选择？", options: ["only"] },
    }).success).toBe(false);
    expect(reviewOutputSchema.safeParse({
      ...base,
      decision: {
        choice: "escalate",
        question: "选择？",
        options: Array.from({ length: 9 }, (_, index) => `选项 ${index}`),
      },
    }).success).toBe(false);
    expect(reviewOutputSchema.safeParse({
      ...base,
      decision: {
        choice: "escalate",
        question: "选择？",
        options: Array.from({ length: 8 }, (_, index) => `选项 ${index}`),
      },
    }).success).toBe(true);
  });

  it.each([
    ["missing", undefined],
    ["unknown", { choice: "later" }],
    ["multiple", {
      choice: "reject",
      reworkRequirements: ["返工"],
      question: "同时升级？",
      options: ["A", "B"],
    }],
  ])("rejects a %s decision", (_name, decision) => {
    expect(reviewOutputSchema.safeParse({ ...base, decision }).success).toBe(false);
  });

  it("strictly rejects unknown candidate actor fields and accepts a versioned source", () => {
    const candidate = {
      type: "fact",
      content: "已验证事实",
      source: reviewRef,
      supersedesMemoryId: null,
    };
    expect(reviewOutputSchema.safeParse({
      ...base,
      decision: { choice: "pass" },
      memoryCandidates: [candidate],
    }).success).toBe(true);
    expect(reviewOutputSchema.safeParse({
      ...base,
      decision: { choice: "pass" },
      memoryCandidates: [{
        ...candidate,
        actor: { type: "agent", agentId: "foreign-reviewer" },
      }],
    }).success).toBe(false);
    expect(reviewOutputSchema.safeParse({
      ...base,
      decision: { choice: "pass" },
      memoryCandidates: [{
        ...candidate,
        source: { ...reviewRef, version: "" },
      }],
    }).success).toBe(false);
  });
});

describe("review evidence and candidate source validation", () => {
  it("accepts exact frozen refs and binds candidate authorship to the selected reviewer", async () => {
    const { validateReviewOutput } = await loadReviewSchema();
    const validated = validateReviewOutput({
      ...base,
      decision: { choice: "pass" },
      memoryCandidates: [{
        type: "artifact",
        content: "构建产物",
        source: artifactRef,
        supersedesMemoryId: null,
      }],
    }, validationContext);

    expect(validated).toMatchObject({
      success: true,
      output: {
        memoryCandidates: [{
          actor: { agentId: "reviewer-1", type: "agent" },
          source: artifactRef,
        }],
      },
      reason: null,
    });
  });

  it.each([
    ["foreign id", { ...resultRef, id: "foreign-result" }],
    ["foreign type", { ...resultRef, type: "artifact" }],
    ["stale version", { ...resultRef, version: "1" }],
    ["wrong artifact hash", { ...artifactRef, version: "b".repeat(64) }],
  ])("rejects %s evidence and candidate sources", async (_name, foreignRef) => {
    const { validateReviewOutput } = await loadReviewSchema();
    const output = {
      ...base,
      decision: { choice: "pass" },
      evidenceRefs: [foreignRef],
      memoryCandidates: [{
        type: "fact",
        content: "不可信候选",
        source: foreignRef,
        supersedesMemoryId: null,
      }],
    };

    expect(validateReviewOutput(output, validationContext)).toEqual({
      success: false,
      output: null,
      reason: "invalid_source_reference",
    });
  });

  it("rejects header-only pass evidence but permits it for a reject finding", async () => {
    const { validateReviewOutput } = await loadReviewSchema();
    const context = {
      ...validationContext,
      sources: validationContext.sources.map((source) => source.ref.id === resultRef.id
        ? { ...source, hasVerifiedContent: false }
        : source),
    };
    expect(validateReviewOutput({
      ...base,
      decision: { choice: "pass" },
    }, context)).toEqual({
      success: false,
      output: null,
      reason: "review_content_incomplete",
    });
    expect(validateReviewOutput({
      ...base,
      decision: { choice: "reject", reworkRequirements: ["补齐正文"] },
    }, context).success).toBe(true);
  });
});
