import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

type ClientModule = {
  callOpenAiChat: (
    request: {
      apiKey: string;
      baseUrl: string;
      messages: Array<{ role: string; content: string }>;
      model: string;
    },
    context: { attemptId: string; correlationId: string; runId: string },
    options?: { timeoutMilliseconds: number },
  ) => Promise<Record<string, unknown>>;
  OPENAI_CHAT_RESPONSE_LIMIT_BYTES: number;
  OPENAI_CHAT_TIMEOUT_MILLISECONDS: number;
};

const clientModules = import.meta.glob<ClientModule>(
  "../src/server/collaboration/openai-chat-client.ts",
);

const API_KEY = "chat-key-DO-NOT-LEAK";
const SECRET_BODY = "raw-provider-body-DO-NOT-LEAK";
const MODEL = "local-model";

type CapturedRequest = {
  authorization?: string;
  body: unknown;
  method?: string;
  url?: string;
};

let server: Server;
let redirectTarget: Server;
let baseUrl: string;
let redirectTargetRequests = 0;
const captured: CapturedRequest[] = [];

async function loadClient(): Promise<ClientModule> {
  const load = clientModules["../src/server/collaboration/openai-chat-client.ts"];
  expect(load, "the OpenAI chat client must exist").toBeTypeOf("function");
  return load();
}

function listen(serverToStart: Server): Promise<string> {
  return new Promise((resolve) => {
    serverToStart.listen(0, "127.0.0.1", () => {
      const address = serverToStart.address() as AddressInfo;
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(serverToClose: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    serverToClose.close((error) => (error ? reject(error) : resolve()));
  });
}

async function readRequest(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function validBody(
  content = '{"message":"ok"}',
  usage: unknown = { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
): unknown {
  return {
    choices: [{ message: { content } }],
    usage,
  };
}

async function invoke(path: string, timeoutMilliseconds?: number) {
  const { callOpenAiChat } = await loadClient();
  return callOpenAiChat(
    {
      apiKey: API_KEY,
      baseUrl: `${baseUrl}/${path}`,
      messages: [{ role: "user", content: "public prompt" }],
      model: MODEL,
    },
    {
      attemptId: "attempt-1",
      correlationId: "correlation-1",
      runId: "run-1",
    },
    timeoutMilliseconds === undefined ? undefined : { timeoutMilliseconds },
  );
}

beforeAll(async () => {
  redirectTarget = createServer((_request, response) => {
    redirectTargetRequests += 1;
    json(response, 200, validBody());
  });
  const redirectTargetUrl = await listen(redirectTarget);

  server = createServer(async (request, response) => {
    const body = await readRequest(request);
    captured.push({
      authorization: request.headers.authorization,
      body,
      method: request.method,
      url: request.url,
    });
    const path = request.url ?? "";

    if (path === "/valid/chat/completions") return json(response, 200, validBody());
    if (path === "/invalid-json/chat/completions") {
      response.writeHead(200, { "content-type": "application/json" });
      return response.end(`{${SECRET_BODY}`);
    }
    if (path === "/invalid-content/chat/completions") {
      return json(response, 200, {
        choices: [{ message: { content: "" } }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      });
    }
    if (path === "/missing-usage/chat/completions") {
      return json(response, 200, { choices: [{ message: { content: "ok" } }] });
    }
    if (path === "/invalid-usage/chat/completions") {
      return json(response, 200, validBody("ok", {
        prompt_tokens: 3,
        completion_tokens: -1,
        total_tokens: 2,
      }));
    }
    if (path.startsWith("/oversized-status/")) {
      const status = Number(path.split("/")[2]);
      response.writeHead(status, { "content-type": "application/json" });
      response.write(
        `{"error":"${SECRET_BODY}","usage":{"prompt_tokens":7,"completion_tokens":4,"total_tokens":11},"padding":"`,
      );
      const chunk = "x".repeat(64 * 1024);
      for (let index = 0; index < 17; index += 1) response.write(chunk);
      return response.end('"}');
    }
    if (path.startsWith("/status/")) {
      const [, , statusText, usageKind] = path.split("/");
      const usage =
        usageKind === "valid"
          ? { prompt_tokens: 7, completion_tokens: 4, total_tokens: 11 }
          : usageKind === "invalid"
            ? { prompt_tokens: 7, completion_tokens: 4, total_tokens: 99 }
            : undefined;
      return json(response, Number(statusText), { error: SECRET_BODY, usage });
    }
    if (path === "/redirect/chat/completions") {
      response.writeHead(307, { location: `${redirectTargetUrl}/chat/completions` });
      return response.end();
    }
    if (path === "/delayed/chat/completions") {
      return setTimeout(() => json(response, 200, validBody()), 100);
    }
    if (path === "/streamed-large/chat/completions") {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"choices":[{"message":{"content":"');
      const chunk = "x".repeat(64 * 1024);
      for (let index = 0; index < 17; index += 1) response.write(chunk);
      return response.end('"}}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}');
    }

    response.writeHead(404);
    response.end();
  });
  baseUrl = await listen(server);
});

afterAll(async () => {
  await Promise.all([close(server), close(redirectTarget)]);
});

afterEach(() => {
  captured.length = 0;
  redirectTargetRequests = 0;
  vi.restoreAllMocks();
});

describe("OpenAI chat client", () => {
  it("posts the bearer credential, model, messages, and JSON response format", async () => {
    const {
      OPENAI_CHAT_RESPONSE_LIMIT_BYTES,
      OPENAI_CHAT_TIMEOUT_MILLISECONDS,
    } = await loadClient();
    await expect(invoke("valid")).resolves.toEqual({
      content: '{"message":"ok"}',
      error: null,
      httpStatus: 200,
      status: "succeeded",
      usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
      usageReported: true,
    });
    expect(captured).toEqual([{
      authorization: `Bearer ${API_KEY}`,
      body: {
        model: MODEL,
        messages: [{ role: "user", content: "public prompt" }],
        response_format: { type: "json_object" },
      },
      method: "POST",
      url: "/valid/chat/completions",
    }]);
    expect(OPENAI_CHAT_TIMEOUT_MILLISECONDS).toBe(90_000);
    expect(OPENAI_CHAT_RESPONSE_LIMIT_BYTES).toBe(1024 * 1024);
  });

  it.each([
    ["invalid-json", "response_invalid"],
    ["invalid-content", "response_invalid"],
    ["missing-usage", "usage_invalid"],
    ["invalid-usage", "usage_invalid"],
  ] as const)("returns one sanitized %s persistence result", async (path, status) => {
    const result = await invoke(path);
    expect(result).toMatchObject({
      content: null,
      error: expect.objectContaining({
        code: "PROVIDER_RESPONSE_INVALID",
        correlationId: "correlation-1",
      }),
      httpStatus: 200,
      status,
    });
    expect(JSON.stringify(result)).not.toContain(SECRET_BODY);
  });

  it.each([
    [401, "PROVIDER_AUTH", "provider_auth", 401],
    [403, "PROVIDER_AUTH", "provider_auth", 401],
    [429, "RATE_LIMITED", "rate_limited", 429],
    [500, "PROVIDER_UPSTREAM", "provider_upstream", 502],
    [503, "PROVIDER_UPSTREAM", "provider_upstream", 502],
  ] as const)("maps HTTP %i while retaining valid usage", async (status, code, category, publicStatus) => {
    await expect(invoke(`status/${status}/valid`)).resolves.toMatchObject({
      content: null,
      error: { category, code, correlationId: "correlation-1", httpStatus: publicStatus },
      httpStatus: status,
      status: "provider_failed",
      usage: { promptTokens: 7, completionTokens: 4, totalTokens: 11 },
      usageReported: true,
    });
  });

  it.each([
    [401, "missing", "provider_auth"],
    [401, "invalid", "provider_auth"],
    [403, "missing", "provider_auth"],
    [403, "invalid", "provider_auth"],
    [429, "missing", "rate_limited"],
    [429, "invalid", "rate_limited"],
    [500, "missing", "provider_upstream"],
    [500, "invalid", "provider_upstream"],
    [503, "missing", "provider_upstream"],
    [503, "invalid", "provider_upstream"],
  ] as const)("does not let HTTP %i %s usage replace its category", async (status, kind, category) => {
    const result = await invoke(`status/${status}/${kind}`);
    expect(result).toMatchObject({
      error: { category },
      status: "provider_failed",
      usage: null,
      usageReported: false,
    });
  });

  it("uses manual redirects and never forwards the credential", async () => {
    const result = await invoke("redirect");
    expect(result).toMatchObject({
      error: { category: "provider_upstream", code: "PROVIDER_UPSTREAM" },
      httpStatus: 307,
      status: "provider_failed",
    });
    expect(redirectTargetRequests).toBe(0);
  });

  it("times out a real local request and reports network failures once", async () => {
    await expect(invoke("delayed", 20)).resolves.toMatchObject({
      error: { category: "provider_timeout", code: "PROVIDER_TIMEOUT", httpStatus: 504 },
      httpStatus: null,
      status: "provider_failed",
      usage: null,
      usageReported: false,
    });

    const { callOpenAiChat } = await loadClient();
    await expect(callOpenAiChat(
      {
        apiKey: API_KEY,
        baseUrl: "http://127.0.0.1:1/v1",
        messages: [{ role: "user", content: "network" }],
        model: MODEL,
      },
      { attemptId: "attempt-1", correlationId: "correlation-1", runId: "run-1" },
    )).resolves.toMatchObject({
      error: { category: "provider_unreachable", code: "PROVIDER_UNREACHABLE", httpStatus: 502 },
      httpStatus: null,
      status: "provider_failed",
      usage: null,
      usageReported: false,
    });
  });

  it("aborts a streamed body once it exceeds one MiB", async () => {
    const result = await invoke("streamed-large");
    expect(result).toMatchObject({
      content: null,
      error: {
        category: "provider_response_invalid",
        code: "PROVIDER_RESPONSE_INVALID",
        correlationId: "correlation-1",
        httpStatus: 502,
      },
      httpStatus: 200,
      status: "response_invalid",
      usage: null,
      usageReported: false,
    });
  });

  it.each([
    [401, "PROVIDER_AUTH", "provider_auth", 401],
    [403, "PROVIDER_AUTH", "provider_auth", 401],
    [429, "RATE_LIMITED", "rate_limited", 429],
    [500, "PROVIDER_UPSTREAM", "provider_upstream", 502],
  ] as const)(
    "keeps HTTP %i classification while discarding an oversized error body and usage",
    async (status, code, category, publicStatus) => {
      const result = await invoke(`oversized-status/${status}`);

      expect(result).toMatchObject({
        content: null,
        error: { category, code, httpStatus: publicStatus },
        httpStatus: status,
        status: "provider_failed",
        usage: null,
        usageReported: false,
      });
      expect(JSON.stringify(result)).not.toContain(SECRET_BODY);
    },
  );

  it("logs only correlationId/code/runId/attemptId and no key, URL, or raw body", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await invoke("status/500/invalid");

    expect(result.error).not.toBeNull();
    expect(errorSpy).toHaveBeenCalledWith({
      attemptId: "attempt-1",
      code: "PROVIDER_UPSTREAM",
      correlationId: "correlation-1",
      runId: "run-1",
    });
    const serialized = JSON.stringify(errorSpy.mock.calls);
    for (const secret of [API_KEY, baseUrl, SECRET_BODY, "/status/", "Error"]) {
      expect(serialized).not.toContain(secret);
    }
  });
});
