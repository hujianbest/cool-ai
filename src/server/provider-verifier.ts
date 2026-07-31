import { randomUUID } from "node:crypto";

type ProviderErrorCode =
  | "INSECURE_HTTP_CONFIRMATION_REQUIRED"
  | "INTERNAL_ERROR"
  | "INVALID_INPUT"
  | "PROVIDER_INCOMPATIBLE"
  | "PROVIDER_RATE_LIMITED"
  | "PROVIDER_REDIRECTED"
  | "PROVIDER_REJECTED"
  | "PROVIDER_RESPONSE_TOO_LARGE"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_UNAUTHORIZED"
  | "PROVIDER_UNREACHABLE"
  | "PROVIDER_UPSTREAM_ERROR";

type ProviderErrorCategory =
  | "authentication"
  | "compatibility"
  | "input"
  | "internal"
  | "network"
  | "rate_limit"
  | "redirect"
  | "response_limit"
  | "timeout"
  | "upstream";

export type ProviderConnectionToVerify = {
  allowInsecureHttp: boolean;
  apiKey: string;
  baseUrl: string;
  model: string;
};

export type ProviderVerificationContext = {
  correlationId?: string;
  providerId?: string;
};

export class ProviderVerificationError extends Error {
  constructor(
    public readonly code: ProviderErrorCode,
    public readonly httpStatus: number,
    public readonly correlationId: string,
    public readonly category: ProviderErrorCategory,
    message: string,
  ) {
    super(message);
    this.name = "ProviderVerificationError";
  }
}

const RESPONSE_LIMIT_BYTES = 1024 * 1024;
const MODEL_LIMIT = 10_000;
const TIMEOUT_MILLISECONDS = 10_000;

function providerError(
  code: ProviderErrorCode,
  httpStatus: number,
  correlationId: string,
  category: ProviderErrorCategory,
  message: string,
): ProviderVerificationError {
  return new ProviderVerificationError(code, httpStatus, correlationId, category, message);
}

function normalizeBaseUrl(
  baseUrl: string,
  allowInsecureHttp: boolean,
  correlationId: string,
): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw providerError("INVALID_INPUT", 400, correlationId, "input", "Provider URL is invalid.");
  }

  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw providerError("INVALID_INPUT", 400, correlationId, "input", "Provider URL is invalid.");
  }
  if (url.protocol === "http:" && !allowInsecureHttp) {
    throw providerError(
      "INSECURE_HTTP_CONFIRMATION_REQUIRED",
      400,
      correlationId,
      "input",
      "HTTP provider confirmation is required.",
    );
  }

  const pathname = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${pathname === "/" ? "" : pathname}`;
}

export function normalizeProviderBaseUrl(
  baseUrl: string,
  allowInsecureHttp: boolean,
): string {
  return normalizeBaseUrl(baseUrl, allowInsecureHttp, randomUUID());
}

function modelsUrl(normalizedBaseUrl: string): string {
  const url = new URL(normalizedBaseUrl);
  const pathname = url.pathname === "/" ? "" : url.pathname;
  url.pathname = `${pathname}/models`;
  return url.toString();
}

function statusError(responseStatus: number, correlationId: string): ProviderVerificationError {
  if (responseStatus >= 300 && responseStatus <= 399) {
    return providerError(
      "PROVIDER_REDIRECTED",
      502,
      correlationId,
      "redirect",
      "Provider redirected the request.",
    );
  }
  if (responseStatus === 401 || responseStatus === 403) {
    return providerError(
      "PROVIDER_UNAUTHORIZED",
      401,
      correlationId,
      "authentication",
      "Provider rejected the credential.",
    );
  }
  if (responseStatus === 404) {
    return providerError(
      "PROVIDER_INCOMPATIBLE",
      502,
      correlationId,
      "compatibility",
      "Provider model catalog is unavailable.",
    );
  }
  if (responseStatus === 429) {
    return providerError(
      "PROVIDER_RATE_LIMITED",
      429,
      correlationId,
      "rate_limit",
      "Provider rate limited the request.",
    );
  }
  if (responseStatus >= 400 && responseStatus <= 499) {
    return providerError(
      "PROVIDER_REJECTED",
      502,
      correlationId,
      "upstream",
      "Provider rejected the request.",
    );
  }
  return providerError(
    "PROVIDER_UPSTREAM_ERROR",
    502,
    correlationId,
    "upstream",
    "Provider failed the request.",
  );
}

async function readBoundedBody(
  response: Response,
  correlationId: string,
): Promise<Buffer> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const declaredLength = Number(contentLength);
    if (Number.isFinite(declaredLength) && declaredLength > RESPONSE_LIMIT_BYTES) {
      throw providerError(
        "PROVIDER_RESPONSE_TOO_LARGE",
        502,
        correlationId,
        "response_limit",
        "Provider response is too large.",
      );
    }
  }
  if (!response.body) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > RESPONSE_LIMIT_BYTES) {
      await reader.cancel();
      throw providerError(
        "PROVIDER_RESPONSE_TOO_LARGE",
        502,
        correlationId,
        "response_limit",
        "Provider response is too large.",
      );
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, size);
}

function logProviderFailure(
  error: ProviderVerificationError,
  providerId: string | undefined,
): void {
  console.error({
    correlationId: error.correlationId,
    code: error.code,
    ...(providerId ? { providerId } : {}),
  });
}

export async function verifyProviderConnection(
  connection: ProviderConnectionToVerify,
  context: ProviderVerificationContext = {},
): Promise<{ normalizedBaseUrl: string; verifiedModel: string }> {
  const correlationId = context.correlationId ?? randomUUID();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MILLISECONDS);

  try {
    const normalizedBaseUrl = normalizeBaseUrl(
      connection.baseUrl,
      connection.allowInsecureHttp,
      correlationId,
    );
    let response: Response;
    try {
      response = await fetch(modelsUrl(normalizedBaseUrl), {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${connection.apiKey}`,
        },
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
      });
    } catch (error) {
      if (
        controller.signal.aborted ||
        (error && typeof error === "object" && "name" in error && error.name === "AbortError")
      ) {
        throw providerError(
          "PROVIDER_TIMEOUT",
          504,
          correlationId,
          "timeout",
          "Provider request timed out.",
        );
      }
      throw providerError(
        "PROVIDER_UNREACHABLE",
        502,
        correlationId,
        "network",
        "Provider is unreachable.",
      );
    }

    if (!response.ok) throw statusError(response.status, correlationId);

    let body: Buffer;
    try {
      body = await readBoundedBody(response, correlationId);
    } catch (error) {
      if (error instanceof ProviderVerificationError) throw error;
      if (controller.signal.aborted) {
        throw providerError(
          "PROVIDER_TIMEOUT",
          504,
          correlationId,
          "timeout",
          "Provider request timed out.",
        );
      }
      throw providerError(
        "PROVIDER_UNREACHABLE",
        502,
        correlationId,
        "network",
        "Provider response was interrupted.",
      );
    }

    let catalog: unknown;
    try {
      catalog = JSON.parse(body.toString("utf8"));
    } catch {
      throw providerError(
        "PROVIDER_INCOMPATIBLE",
        502,
        correlationId,
        "compatibility",
        "Provider returned an invalid model catalog.",
      );
    }
    const data =
      catalog && typeof catalog === "object" && "data" in catalog
        ? (catalog as { data: unknown }).data
        : undefined;
    if (!Array.isArray(data)) {
      throw providerError(
        "PROVIDER_INCOMPATIBLE",
        502,
        correlationId,
        "compatibility",
        "Provider returned an invalid model catalog.",
      );
    }
    if (data.length > MODEL_LIMIT) {
      throw providerError(
        "PROVIDER_RESPONSE_TOO_LARGE",
        502,
        correlationId,
        "response_limit",
        "Provider model catalog has too many entries.",
      );
    }
    if (
      !data.every(
        (entry) =>
          entry !== null &&
          typeof entry === "object" &&
          "id" in entry &&
          typeof (entry as { id: unknown }).id === "string",
      ) ||
      !data.some((entry) => (entry as { id: string }).id === connection.model)
    ) {
      throw providerError(
        "PROVIDER_INCOMPATIBLE",
        502,
        correlationId,
        "compatibility",
        "Provider does not expose the requested model.",
      );
    }

    return { normalizedBaseUrl, verifiedModel: connection.model };
  } catch (error) {
    const typedError =
      error instanceof ProviderVerificationError
        ? error
        : providerError(
            "INTERNAL_ERROR",
            500,
            correlationId,
            "internal",
            "Provider verification failed.",
          );
    logProviderFailure(typedError, context.providerId);
    throw typedError;
  } finally {
    clearTimeout(timeout);
  }
}
