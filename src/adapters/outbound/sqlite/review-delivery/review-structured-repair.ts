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
  parseReviewOutputContent,
  REVIEW_OUTPUT_SCHEMA_INSTRUCTIONS,
  reviewOutputContainsSensitiveText,
  validateReviewOutput,
  type ReviewOutputValidationContext,
  type ValidatedReviewOutput,
} from "./review-schema";

type ReviewCallStatus =
  | "succeeded"
  | "response_invalid"
  | "provider_failed";

export type StructuredReviewCall = {
  callIndex: 1 | 2;
  kind: "primary" | "repair";
  status: ReviewCallStatus;
  usage: ModelCallUsage | null;
  usageReported: boolean;
};

export type StructuredReviewResult =
  | {
      status: "completed";
      output: ValidatedReviewOutput;
      failureCategory: null;
      calls: StructuredReviewCall[];
    }
  | {
      status: "invalid";
      output: null;
      failureCategory:
        | "structured_output_invalid"
        | "output_security_invalid"
        | "invalid_source_reference"
        | "review_content_incomplete";
      calls: StructuredReviewCall[];
    }
  | {
      status: "provider_failed";
      output: null;
      failureCategory: string;
      calls: StructuredReviewCall[];
    };

function repairRequest(
  request: OpenAiChatRequest,
  invalidContent: string,
): OpenAiChatRequest {
  return {
    apiKey: request.apiKey,
    baseUrl: request.baseUrl,
    model: request.model,
    messages: [
      { role: "system", content: REVIEW_OUTPUT_SCHEMA_INSTRUCTIONS },
      {
        role: "user",
        content: [
          "The following response was invalid.",
          "Rewrite only this content to satisfy the strict JSON schema exactly:",
          invalidContent,
        ].join("\n"),
      },
    ],
  };
}

function callMetadata(
  result: ModelCallResult,
  kind: StructuredReviewCall["kind"],
  callIndex: StructuredReviewCall["callIndex"],
  status: ReviewCallStatus,
): StructuredReviewCall {
  return {
    callIndex,
    kind,
    status,
    usage: result.usage,
    usageReported: result.usageReported,
  };
}

function providerFailure(
  result: ModelCallResult,
  kind: StructuredReviewCall["kind"],
  callIndex: StructuredReviewCall["callIndex"],
  priorCalls: StructuredReviewCall[],
): StructuredReviewResult {
  return {
    status: "provider_failed",
    output: null,
    failureCategory: result.error?.category ?? "provider_response_invalid",
    calls: [
      ...priorCalls,
      callMetadata(result, kind, callIndex, "provider_failed"),
    ],
  };
}

function validatePublicOutput(
  content: string,
  context: ReviewOutputValidationContext,
  calls: StructuredReviewCall[],
): StructuredReviewResult {
  const parsed = parseReviewOutputContent(content);
  if (!parsed) {
    return {
      status: "invalid",
      output: null,
      failureCategory: "structured_output_invalid",
      calls,
    };
  }
  if (reviewOutputContainsSensitiveText(parsed, context.secretValues)) {
    return {
      status: "invalid",
      output: null,
      failureCategory: "output_security_invalid",
      calls,
    };
  }
  const validated = validateReviewOutput(parsed, context);
  if (!validated.success) {
    return {
      status: "invalid",
      output: null,
      failureCategory: validated.reason,
      calls,
    };
  }
  return {
    status: "completed",
    output: validated.output,
    failureCategory: null,
    calls,
  };
}

export async function executeStructuredReviewOutput(
  request: OpenAiChatRequest,
  callContext: OpenAiChatCallContext,
  validationContext: ReviewOutputValidationContext,
): Promise<StructuredReviewResult> {
  const primary = await callOpenAiChat(request, callContext);
  if (primary.status !== "succeeded" || primary.content === null) {
    return providerFailure(primary, "primary", 1, []);
  }
  const primaryOutput = parseReviewOutputContent(primary.content);
  if (primaryOutput) {
    return validatePublicOutput(primary.content, validationContext, [
      callMetadata(primary, "primary", 1, "succeeded"),
    ]);
  }

  const primaryCall = callMetadata(primary, "primary", 1, "response_invalid");
  const repair = await callOpenAiChat(
    repairRequest(request, primary.content),
    callContext,
  );
  if (repair.status !== "succeeded" || repair.content === null) {
    return providerFailure(repair, "repair", 2, [primaryCall]);
  }
  const repairOutput = parseReviewOutputContent(repair.content);
  if (!repairOutput) {
    return {
      status: "invalid",
      output: null,
      failureCategory: "structured_output_invalid",
      calls: [
        primaryCall,
        callMetadata(repair, "repair", 2, "response_invalid"),
      ],
    };
  }
  return validatePublicOutput(repair.content, validationContext, [
    primaryCall,
    callMetadata(repair, "repair", 2, "succeeded"),
  ]);
}
