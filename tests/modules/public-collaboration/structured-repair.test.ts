import { beforeEach, describe, expect, it, vi } from "vitest";

import { callOpenAiChat } from "../../../src/adapters/outbound/model-runtime/openai-chat-client";
import type {
  ModelCallResult,
  OpenAiChatMessage,
} from "../../../src/shared/collaboration-contracts";

vi.mock("../../../src/adapters/outbound/model-runtime/openai-chat-client", () => ({
  callOpenAiChat: vi.fn(),
}));

type RepairModule = {
  executeStructuredTurn: (
    request: {
      apiKey: string;
      baseUrl: string;
      messages: OpenAiChatMessage[];
      model: string;
    },
    context: { attemptId: string; correlationId: string; runId: string },
  ) => Promise<{
    status: "completed" | "paused" | "provider_failed";
    turn: Record<string, unknown> | null;
    pauseCategory: "structured_output_invalid" | null;
    calls: Array<{ kind: "primary" | "repair"; result: ModelCallResult }>;
    usage: Array<{
      kind: "primary" | "repair";
      usage: ModelCallResult["usage"];
      usageReported: boolean;
    }>;
  }>;
};

const repairModules = import.meta.glob<RepairModule>(
  "../../../src/modules/public-collaboration/internal/structured-repair.ts",
);
const mockedCall = vi.mocked(callOpenAiChat);

const request = {
  apiKey: "provider-secret",
  baseUrl: "https://provider.example/v1",
  messages: [
    { role: "system" as const, content: "FULL PROJECT CONTEXT PRIVATE MARKER" },
    { role: "user" as const, content: "public mission" },
  ],
  model: "test-model",
};
const context = {
  attemptId: "attempt-1",
  correlationId: "correlation-1",
  runId: "run-1",
};

const validTurn = JSON.stringify({
  message: "Done.",
  tasks: [],
  claim: null,
  disposition: { type: "plan_ready" },
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

async function loadRepair(): Promise<RepairModule> {
  const load = repairModules["../../../src/modules/public-collaboration/internal/structured-repair.ts"];
  expect(load, "the one-repair executor must exist").toBeTypeOf("function");
  return load();
}

beforeEach(() => {
  mockedCall.mockReset();
});

describe("structured output repair", () => {
  it("returns a valid primary turn without making a repair call", async () => {
    const primary = success(validTurn, 5);
    mockedCall.mockResolvedValueOnce(primary);
    const { executeStructuredTurn } = await loadRepair();

    await expect(executeStructuredTurn(request, context)).resolves.toMatchObject({
      status: "completed",
      turn: { message: "Done.", disposition: { type: "plan_ready" } },
      pauseCategory: null,
      calls: [{ kind: "primary", result: primary }],
      usage: [{ kind: "primary", usage: primary.usage, usageReported: true }],
    });
    expect(mockedCall).toHaveBeenCalledTimes(1);
    expect(mockedCall).toHaveBeenCalledWith(request, context);
  });

  it("makes exactly one repair after an invalid primary and exposes both results and usage", async () => {
    const invalidContent = '{"message":"invalid primary","projectLeak":"no"}';
    const primary = success(invalidContent, 7);
    const repair = success(validTurn, 11);
    mockedCall.mockResolvedValueOnce(primary).mockResolvedValueOnce(repair);
    const { executeStructuredTurn } = await loadRepair();

    const result = await executeStructuredTurn(request, context);

    expect(result).toMatchObject({
      status: "completed",
      turn: { message: "Done.", disposition: { type: "plan_ready" } },
      pauseCategory: null,
      calls: [
        { kind: "primary", result: primary },
        { kind: "repair", result: repair },
      ],
      usage: [
        { kind: "primary", usage: primary.usage, usageReported: true },
        { kind: "repair", usage: repair.usage, usageReported: true },
      ],
    });
    expect(mockedCall).toHaveBeenCalledTimes(2);
    const repairRequest = mockedCall.mock.calls[1][0];
    expect(repairRequest).toMatchObject({
      apiKey: request.apiKey,
      baseUrl: request.baseUrl,
      model: request.model,
    });
    expect(repairRequest.messages).toHaveLength(2);
    const serializedRepairPrompt = JSON.stringify(repairRequest.messages);
    expect(repairRequest.messages.some(({ content }) => content.includes(invalidContent))).toBe(true);
    expect(serializedRepairPrompt).toMatch(/strict|schema|JSON/i);
    expect(serializedRepairPrompt).toMatch(/message/);
    expect(serializedRepairPrompt).toMatch(/disposition/);
    expect(serializedRepairPrompt).not.toContain("FULL PROJECT CONTEXT PRIVATE MARKER");
    expect(serializedRepairPrompt).not.toContain("public mission");
  });

  it("pauses after two invalid responses and produces no business turn", async () => {
    const primary = success('{"message":"still missing fields"}', 3);
    const repair = success('{"message":"still invalid","tasks":[]}', 4);
    mockedCall.mockResolvedValueOnce(primary).mockResolvedValueOnce(repair);
    const { executeStructuredTurn } = await loadRepair();

    const result = await executeStructuredTurn(request, context);

    expect(result).toEqual({
      status: "paused",
      turn: null,
      pauseCategory: "structured_output_invalid",
      calls: [
        { kind: "primary", result: primary },
        { kind: "repair", result: repair },
      ],
      usage: [
        { kind: "primary", usage: primary.usage, usageReported: true },
        { kind: "repair", usage: repair.usage, usageReported: true },
      ],
    });
    expect(mockedCall).toHaveBeenCalledTimes(2);
  });

  it("does not repair provider failures or create a business turn", async () => {
    const failure: ModelCallResult = {
      content: null,
      error: {
        category: "provider_timeout",
        code: "PROVIDER_TIMEOUT",
        correlationId: "correlation-1",
        httpStatus: 504,
      },
      httpStatus: null,
      status: "provider_failed",
      usage: null,
      usageReported: false,
    };
    mockedCall.mockResolvedValueOnce(failure);
    const { executeStructuredTurn } = await loadRepair();

    await expect(executeStructuredTurn(request, context)).resolves.toEqual({
      status: "provider_failed",
      turn: null,
      pauseCategory: null,
      calls: [{ kind: "primary", result: failure }],
      usage: [{ kind: "primary", usage: null, usageReported: false }],
    });
    expect(mockedCall).toHaveBeenCalledTimes(1);
  });
});
