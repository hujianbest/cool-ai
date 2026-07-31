import type {
  ModelCallResult,
  ModelCallUsage,
} from "../../shared/collaboration-contracts";
import {
  callOpenAiChat,
  type OpenAiChatCallContext,
  type OpenAiChatRequest,
} from "./openai-chat-client";
import {
  AGENT_TURN_SCHEMA_INSTRUCTIONS,
  type AgentTurn,
  parseAgentTurnContent,
} from "./agent-turn-schema";

export type StructuredModelCall = {
  kind: "primary" | "repair";
  result: ModelCallResult;
};

export type StructuredCallUsage = {
  kind: "primary" | "repair";
  usage: ModelCallUsage | null;
  usageReported: boolean;
};

export type StructuredTurnResult = {
  status: "completed" | "paused" | "provider_failed";
  turn: AgentTurn | null;
  pauseCategory: "structured_output_invalid" | null;
  calls: StructuredModelCall[];
  usage: StructuredCallUsage[];
};

function usageFor(call: StructuredModelCall): StructuredCallUsage {
  return {
    kind: call.kind,
    usage: call.result.usage,
    usageReported: call.result.usageReported,
  };
}

function result(
  status: StructuredTurnResult["status"],
  turn: AgentTurn | null,
  pauseCategory: StructuredTurnResult["pauseCategory"],
  calls: StructuredModelCall[],
): StructuredTurnResult {
  return {
    status,
    turn,
    pauseCategory,
    calls,
    usage: calls.map(usageFor),
  };
}

function repairRequest(
  primaryRequest: OpenAiChatRequest,
  invalidContent: string,
): OpenAiChatRequest {
  return {
    apiKey: primaryRequest.apiKey,
    baseUrl: primaryRequest.baseUrl,
    model: primaryRequest.model,
    messages: [
      {
        role: "system",
        content: AGENT_TURN_SCHEMA_INSTRUCTIONS,
      },
      {
        role: "user",
        content: [
          "The following response was invalid.",
          "Rewrite only this content to satisfy the schema exactly:",
          invalidContent,
        ].join("\n"),
      },
    ],
  };
}

export async function executeStructuredTurn(
  primaryRequest: OpenAiChatRequest,
  context: OpenAiChatCallContext,
): Promise<StructuredTurnResult> {
  const primaryResult = await callOpenAiChat(primaryRequest, context);
  const primaryCall: StructuredModelCall = {
    kind: "primary",
    result: primaryResult,
  };
  if (primaryResult.status !== "succeeded" || primaryResult.content === null) {
    return result("provider_failed", null, null, [primaryCall]);
  }

  const primaryTurn = parseAgentTurnContent(primaryResult.content);
  if (primaryTurn.success) {
    return result("completed", primaryTurn.turn, null, [primaryCall]);
  }

  const repairResult = await callOpenAiChat(
    repairRequest(primaryRequest, primaryResult.content),
    context,
  );
  const repairCall: StructuredModelCall = {
    kind: "repair",
    result: repairResult,
  };
  const calls = [primaryCall, repairCall];
  if (repairResult.status !== "succeeded" || repairResult.content === null) {
    return result("provider_failed", null, null, calls);
  }

  const repairedTurn = parseAgentTurnContent(repairResult.content);
  return repairedTurn.success
    ? result("completed", repairedTurn.turn, null, calls)
    : result("paused", null, "structured_output_invalid", calls);
}
