import type {
  ModelCallPublicError,
  ModelCallResult,
  ModelCallUsage,
  OpenAiChatMessage,
} from "../../shared/collaboration-contracts";

export const OPENAI_CHAT_TIMEOUT_MILLISECONDS = 90_000;
export const OPENAI_CHAT_RESPONSE_LIMIT_BYTES = 1024 * 1024;

export type OpenAiChatRequest = {
  apiKey: string;
  baseUrl: string;
  model: string;
  messages: OpenAiChatMessage[];
};

export type OpenAiChatCallContext = {
  correlationId: string;
  runId: string;
  attemptId: string;
};

type OpenAiChatClientOptions = {
  timeoutMilliseconds: number;
};

type FailureSpec = Pick<ModelCallPublicError, "code" | "category" | "httpStatus">;

const RESPONSE_INVALID: FailureSpec = {
  code: "PROVIDER_RESPONSE_INVALID",
  category: "provider_response_invalid",
  httpStatus: 502,
};

function chatCompletionsUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/chat/completions`;
  return url.toString();
}

function isUsage(value: unknown): value is {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
} {
  if (value === null || typeof value !== "object") return false;
  const usage = value as Record<string, unknown>;
  const promptTokens = usage.prompt_tokens;
  const completionTokens = usage.completion_tokens;
  const totalTokens = usage.total_tokens;
  return (
    Number.isSafeInteger(promptTokens) &&
    Number.isSafeInteger(completionTokens) &&
    Number.isSafeInteger(totalTokens) &&
    (promptTokens as number) >= 0 &&
    (completionTokens as number) >= 0 &&
    (totalTokens as number) >= 0 &&
    totalTokens === (promptTokens as number) + (completionTokens as number)
  );
}

function parseUsage(value: unknown): ModelCallUsage | null {
  if (!isUsage(value)) return null;
  return {
    promptTokens: value.prompt_tokens,
    completionTokens: value.completion_tokens,
    totalTokens: value.total_tokens,
  };
}

async function readBoundedBody(response: Response): Promise<Uint8Array | null> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const declaredLength = Number(contentLength);
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > OPENAI_CHAT_RESPONSE_LIMIT_BYTES
    ) {
      await response.body?.cancel();
      return null;
    }
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > OPENAI_CHAT_RESPONSE_LIMIT_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }

  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function parseJson(body: Uint8Array): unknown | null {
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    return null;
  }
}

function statusFailure(status: number): FailureSpec {
  if (status === 401 || status === 403) {
    return { code: "PROVIDER_AUTH", category: "provider_auth", httpStatus: 401 };
  }
  if (status === 429) {
    return { code: "RATE_LIMITED", category: "rate_limited", httpStatus: 429 };
  }
  return {
    code: "PROVIDER_UPSTREAM",
    category: "provider_upstream",
    httpStatus: 502,
  };
}

function failureResult(
  spec: FailureSpec,
  context: OpenAiChatCallContext,
  status: ModelCallResult["status"],
  upstreamStatus: number | null,
  usage: ModelCallUsage | null = null,
): ModelCallResult {
  const error: ModelCallPublicError = {
    ...spec,
    correlationId: context.correlationId,
  };
  console.error({
    attemptId: context.attemptId,
    code: error.code,
    correlationId: context.correlationId,
    runId: context.runId,
  });
  return {
    content: null,
    error,
    httpStatus: upstreamStatus,
    status,
    usage,
    usageReported: usage !== null,
  };
}

function responseContent(value: unknown): string | null {
  if (value === null || typeof value !== "object") return null;
  const choices = (value as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (first === null || typeof first !== "object") return null;
  const message = (first as Record<string, unknown>).message;
  if (message === null || typeof message !== "object") return null;
  const content = (message as Record<string, unknown>).content;
  if (typeof content !== "string" || content.length === 0) return null;
  if (new TextEncoder().encode(content).byteLength > OPENAI_CHAT_RESPONSE_LIMIT_BYTES) {
    return null;
  }
  return content;
}

export async function callOpenAiChat(
  request: OpenAiChatRequest,
  context: OpenAiChatCallContext,
  options: OpenAiChatClientOptions = {
    timeoutMilliseconds: OPENAI_CHAT_TIMEOUT_MILLISECONDS,
  },
): Promise<ModelCallResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMilliseconds);

  try {
    let response: Response;
    try {
      response = await fetch(chatCompletionsUrl(request.baseUrl), {
        body: JSON.stringify({
          model: request.model,
          messages: request.messages,
          response_format: { type: "json_object" },
        }),
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${request.apiKey}`,
          "Content-Type": "application/json",
        },
        method: "POST",
        redirect: "manual",
        signal: controller.signal,
      });
    } catch {
      return failureResult(
        controller.signal.aborted
          ? {
              code: "PROVIDER_TIMEOUT",
              category: "provider_timeout",
              httpStatus: 504,
            }
          : {
              code: "PROVIDER_UNREACHABLE",
              category: "provider_unreachable",
              httpStatus: 502,
            },
        context,
        "provider_failed",
        null,
      );
    }

    let body: Uint8Array | null;
    try {
      body = await readBoundedBody(response);
    } catch {
      return failureResult(
        controller.signal.aborted
          ? {
              code: "PROVIDER_TIMEOUT",
              category: "provider_timeout",
              httpStatus: 504,
            }
          : {
              code: "PROVIDER_UNREACHABLE",
              category: "provider_unreachable",
              httpStatus: 502,
            },
        context,
        "provider_failed",
        response.status,
      );
    }

    if (body === null) {
      return failureResult(
        response.ok ? RESPONSE_INVALID : statusFailure(response.status),
        context,
        response.ok ? "response_invalid" : "provider_failed",
        response.status,
      );
    }

    const parsed = parseJson(body);
    if (!response.ok) {
      const usage =
        parsed !== null && typeof parsed === "object"
          ? parseUsage((parsed as Record<string, unknown>).usage)
          : null;
      return failureResult(
        statusFailure(response.status),
        context,
        "provider_failed",
        response.status,
        usage,
      );
    }

    if (parsed === null) {
      return failureResult(
        RESPONSE_INVALID,
        context,
        "response_invalid",
        response.status,
      );
    }
    const content = responseContent(parsed);
    if (content === null) {
      return failureResult(
        RESPONSE_INVALID,
        context,
        "response_invalid",
        response.status,
      );
    }
    const usage =
      typeof parsed === "object"
        ? parseUsage((parsed as Record<string, unknown>).usage)
        : null;
    if (usage === null) {
      return failureResult(
        {
          code: "PROVIDER_RESPONSE_INVALID",
          category: "usage_invalid",
          httpStatus: 502,
        },
        context,
        "usage_invalid",
        response.status,
      );
    }

    return {
      content,
      error: null,
      httpStatus: response.status,
      status: "succeeded",
      usage,
      usageReported: true,
    };
  } finally {
    clearTimeout(timeout);
  }
}
