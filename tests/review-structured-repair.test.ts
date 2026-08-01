import { beforeEach, describe, expect, it, vi } from "vitest";

import { callOpenAiChat } from "@/src/server/collaboration/openai-chat-client";
import type {
  ModelCallResult,
  OpenAiChatMessage,
} from "@/src/shared/collaboration-contracts";

vi.mock("@/src/server/collaboration/openai-chat-client", () => ({
  callOpenAiChat: vi.fn(),
}));

type StructuredReviewModule = {
  executeStructuredReviewOutput: (
    request: {
      apiKey: string;
      baseUrl: string;
      messages: OpenAiChatMessage[];
      model: string;
    },
    callContext: { attemptId: string; correlationId: string; runId: string },
    validationContext: {
      candidateActor: { agentId: string; type: "agent" };
      secretValues?: string[];
      sources: Array<{
        complete: boolean;
        hasVerifiedContent: boolean;
        ref: { id: string; type: string; version: string };
      }>;
    },
  ) => Promise<{
    status: "completed" | "invalid" | "provider_failed";
    output: Record<string, unknown> | null;
    failureCategory:
      | "structured_output_invalid"
      | "output_security_invalid"
      | "invalid_source_reference"
      | "review_content_incomplete"
      | string
      | null;
    calls: Array<{
      callIndex: 1 | 2;
      kind: "primary" | "repair";
      status: string;
      usage: ModelCallResult["usage"];
      usageReported: boolean;
    }>;
  }>;
};

const structuredModules = import.meta.glob<StructuredReviewModule>(
  "../src/server/review/review-structured-repair.ts",
);
const mockedCall = vi.mocked(callOpenAiChat);
const resultRef = { id: "result-1", type: "result", version: "2" };
const reviewRef = { id: "attempt-1", type: "review", version: "1" };
const request = {
  apiKey: "provider-secret",
  baseUrl: "https://provider.example/v1",
  messages: [
    { role: "system" as const, content: "PRIVATE REVIEW MATERIAL" },
    { role: "user" as const, content: "Review the result." },
  ],
  model: "review-model",
};
const callContext = {
  attemptId: "attempt-1",
  correlationId: "correlation-1",
  runId: "mission-1",
};
const validationContext = {
  candidateActor: { agentId: "reviewer-1", type: "agent" as const },
  secretValues: ["provider-secret"],
  sources: [
    { complete: true, hasVerifiedContent: true, ref: resultRef },
    { complete: true, hasVerifiedContent: true, ref: reviewRef },
  ],
};
const validOutput = JSON.stringify({
  publicSummary: "公开结论",
  findings: [{
    title: "通过",
    detail: "证据支持结果。",
    evidenceRefs: [resultRef],
  }],
  evidenceRefs: [resultRef],
  limitations: [],
  memoryCandidates: [{
    type: "fact",
    content: "结果已通过复核",
    source: reviewRef,
    supersedesMemoryId: null,
  }],
  decision: { choice: "pass" },
});

function success(content: string, totalTokens: number): ModelCallResult {
  return {
    content,
    error: null,
    httpStatus: 200,
    status: "succeeded",
    usage: {
      promptTokens: totalTokens - 1,
      completionTokens: 1,
      totalTokens,
    },
    usageReported: true,
  };
}

async function loadStructuredReview(): Promise<StructuredReviewModule> {
  const load = structuredModules["../src/server/review/review-structured-repair.ts"];
  expect(load, "the one-repair review executor must exist").toBeTypeOf("function");
  return load();
}

beforeEach(() => {
  mockedCall.mockReset();
});

describe("review primary and one structured repair", () => {
  it("returns one valid primary output with a single terminal call", async () => {
    mockedCall.mockResolvedValueOnce(success(validOutput, 7));
    const { executeStructuredReviewOutput } = await loadStructuredReview();

    await expect(executeStructuredReviewOutput(
      request,
      callContext,
      validationContext,
    )).resolves.toMatchObject({
      status: "completed",
      output: {
        decision: { choice: "pass" },
        memoryCandidates: [{
          actor: { agentId: "reviewer-1", type: "agent" },
        }],
      },
      failureCategory: null,
      calls: [{
        callIndex: 1,
        kind: "primary",
        status: "succeeded",
        usage: { totalTokens: 7 },
        usageReported: true,
      }],
    });
    expect(mockedCall).toHaveBeenCalledTimes(1);
  });

  it("uses the same provider/model for exactly one schema-only repair", async () => {
    const invalid = '{"publicSummary":"RAW_INVALID_SENTINEL","decision":{"choice":"unknown"}}';
    mockedCall
      .mockResolvedValueOnce(success(invalid, 5))
      .mockResolvedValueOnce(success(validOutput, 11));
    const { executeStructuredReviewOutput } = await loadStructuredReview();

    const result = await executeStructuredReviewOutput(request, callContext, validationContext);

    expect(result).toMatchObject({
      status: "completed",
      failureCategory: null,
      calls: [
        { callIndex: 1, kind: "primary", status: "response_invalid" },
        { callIndex: 2, kind: "repair", status: "succeeded" },
      ],
    });
    expect(mockedCall).toHaveBeenCalledTimes(2);
    const repair = mockedCall.mock.calls[1]?.[0];
    expect(repair).toMatchObject({
      apiKey: request.apiKey,
      baseUrl: request.baseUrl,
      model: request.model,
    });
    expect(repair.messages).toHaveLength(2);
    const repairPrompt = JSON.stringify(repair.messages);
    expect(repair.messages.some(({ content }) => content.includes(invalid))).toBe(true);
    expect(repairPrompt).toMatch(/strict|schema|JSON/i);
    expect(repairPrompt).toMatch(/reject|escalate|pass/);
    expect(repairPrompt).not.toContain("PRIVATE REVIEW MATERIAL");
    expect(repairPrompt).not.toContain("Review the result.");
    expect(JSON.stringify(result)).not.toContain("RAW_INVALID_SENTINEL");
    expect(JSON.stringify(result)).not.toContain("provider-secret");
  });

  it("stops after primary and repair are both invalid with one unique terminal result", async () => {
    mockedCall
      .mockResolvedValueOnce(success('{"raw":"PRIMARY_RAW_SENTINEL"}', 3))
      .mockResolvedValueOnce(success('{"raw":"REPAIR_RAW_SENTINEL"}', 4));
    const { executeStructuredReviewOutput } = await loadStructuredReview();

    const result = await executeStructuredReviewOutput(request, callContext, validationContext);

    expect(result).toEqual({
      status: "invalid",
      output: null,
      failureCategory: "structured_output_invalid",
      calls: [
        {
          callIndex: 1,
          kind: "primary",
          status: "response_invalid",
          usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3 },
          usageReported: true,
        },
        {
          callIndex: 2,
          kind: "repair",
          status: "response_invalid",
          usage: { promptTokens: 3, completionTokens: 1, totalTokens: 4 },
          usageReported: true,
        },
      ],
    });
    expect(mockedCall).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result)).not.toMatch(/PRIMARY_RAW_SENTINEL|REPAIR_RAW_SENTINEL/u);
  });

  it("does not repair a structurally valid output with a foreign source", async () => {
    const foreign = JSON.stringify({
      ...JSON.parse(validOutput),
      evidenceRefs: [{ ...resultRef, version: "1" }],
    });
    mockedCall.mockResolvedValueOnce(success(foreign, 6));
    const { executeStructuredReviewOutput } = await loadStructuredReview();

    await expect(executeStructuredReviewOutput(
      request,
      callContext,
      validationContext,
    )).resolves.toMatchObject({
      status: "invalid",
      output: null,
      failureCategory: "invalid_source_reference",
      calls: [{ callIndex: 1, kind: "primary", status: "succeeded" }],
    });
    expect(mockedCall).toHaveBeenCalledTimes(1);
  });

  it("rejects public CoT or secret text without returning or repairing it", async () => {
    const unsafe = JSON.stringify({
      ...JSON.parse(validOutput),
      publicSummary: "My chain of thought is provider-secret",
    });
    mockedCall.mockResolvedValueOnce(success(unsafe, 6));
    const { executeStructuredReviewOutput } = await loadStructuredReview();

    const result = await executeStructuredReviewOutput(request, callContext, validationContext);

    expect(result).toMatchObject({
      status: "invalid",
      output: null,
      failureCategory: "output_security_invalid",
      calls: [{ callIndex: 1, kind: "primary", status: "succeeded" }],
    });
    expect(mockedCall).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toMatch(/chain of thought|provider-secret/iu);
  });

  it("sanitizes provider failure into metadata and never exposes a raw provider body", async () => {
    const providerFailure: ModelCallResult = {
      content: null,
      error: {
        category: "provider_upstream",
        code: "PROVIDER_UPSTREAM",
        correlationId: "correlation-1",
        httpStatus: 502,
      },
      httpStatus: 502,
      status: "provider_failed",
      usage: null,
      usageReported: false,
    };
    mockedCall.mockResolvedValueOnce(providerFailure);
    const { executeStructuredReviewOutput } = await loadStructuredReview();

    const result = await executeStructuredReviewOutput(request, callContext, validationContext);

    expect(result).toEqual({
      status: "provider_failed",
      output: null,
      failureCategory: "provider_upstream",
      calls: [{
        callIndex: 1,
        kind: "primary",
        status: "provider_failed",
        usage: null,
        usageReported: false,
      }],
    });
    expect(mockedCall).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain("RAW_PROVIDER_BODY");
  });
});
