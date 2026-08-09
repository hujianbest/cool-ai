import type {
  ModelCallResult,
  ModelCallUsage,
} from "@/src/shared/collaboration-contracts";
import {
  callOpenAiChat,
  type OpenAiChatCallContext,
  type OpenAiChatRequest,
} from "@/src/server/collaboration/openai-chat-client";
import {
  AGENT_TURN_SCHEMA_INSTRUCTIONS,
  type AgentTurn,
  parseAgentTurnContent,
} from "./agent-turn-schema";
import type { PublicTextCredentialCategory } from "./public-text-credential-classifier";

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

type RawContentScanner = (
  content: string,
) => PublicTextCredentialCategory | null;

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

function credentialRejected(
  calls: StructuredModelCall[],
  context: OpenAiChatCallContext,
): StructuredTurnResult {
  const rejectedIndex = calls.length - 1;
  return result(
    "provider_failed",
    null,
    null,
    calls.map((call, index) =>
      index === rejectedIndex
        ? {
            ...call,
            result: {
              ...call.result,
              content: null,
              error: {
                category: "credential_content_rejected",
                code: "CREDENTIAL_CONTENT_REJECTED",
                correlationId: context.correlationId,
                httpStatus: 422,
              },
              status: "response_invalid",
            },
          }
        : call,
    ),
  );
}

function publicTurnTexts(turn: AgentTurn): string[] {
  const texts = [
    turn.message,
    ...(turn.blocks ?? []).flatMap((block) =>
      block.blockType === "proposal"
        ? [block.title, block.body]
        : block.blockType === "checklist"
          ? [block.title, ...block.items.map(({ text }) => text)]
          : block.blockType === "diff_preview"
            ? [block.title, ...block.fileReferences]
            : [block.title]),
    ...turn.tasks.flatMap((task) => [task.title, task.description]),
  ];
  if (turn.disposition.type === "handoff") {
    texts.push(turn.disposition.summary, turn.disposition.reason);
  } else if (turn.disposition.type === "decision_request") {
    texts.push(turn.disposition.question, ...turn.disposition.options);
  }
  return texts;
}

function parsedTurnContainsCredential(
  turn: AgentTurn,
  scanPublicText: RawContentScanner,
): boolean {
  return publicTurnTexts(turn).some((text) => scanPublicText(text) !== null);
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
  scanRawContent: RawContentScanner = () => null,
): Promise<StructuredTurnResult> {
  const primaryResult = await callOpenAiChat(primaryRequest, context);
  const primaryCall: StructuredModelCall = {
    kind: "primary",
    result: primaryResult,
  };
  if (primaryResult.status !== "succeeded" || primaryResult.content === null) {
    return result("provider_failed", null, null, [primaryCall]);
  }
  if (scanRawContent(primaryResult.content)) {
    return credentialRejected([primaryCall], context);
  }

  const primaryTurn = parseAgentTurnContent(primaryResult.content);
  if (primaryTurn.success) {
    if (parsedTurnContainsCredential(primaryTurn.turn, scanRawContent)) {
      return credentialRejected([primaryCall], context);
    }
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
  if (scanRawContent(repairResult.content)) {
    return credentialRejected(calls, context);
  }

  const repairedTurn = parseAgentTurnContent(repairResult.content);
  if (!repairedTurn.success) {
    return result("paused", null, "structured_output_invalid", calls);
  }
  return parsedTurnContainsCredential(repairedTurn.turn, scanRawContent)
    ? credentialRejected(calls, context)
    : result("completed", repairedTurn.turn, null, calls);
}
