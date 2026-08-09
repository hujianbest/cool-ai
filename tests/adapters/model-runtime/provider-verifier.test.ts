import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

type ProviderConnection = {
  allowInsecureHttp: boolean;
  apiKey: string;
  baseUrl: string;
  model: string;
};

type VerificationContext = {
  correlationId: string;
  providerId?: string;
};

type VerifierModule = {
  normalizeProviderBaseUrl: (baseUrl: string, allowInsecureHttp: boolean) => string;
  verifyProviderConnection: (
    connection: ProviderConnection,
    context: VerificationContext,
  ) => Promise<{ normalizedBaseUrl: string; verifiedModel: string }>;
};

const verifierModules = import.meta.glob<VerifierModule>(
  "../../../src/adapters/outbound/model-runtime/provider-verifier.ts",
);
const API_KEY = "provider-key-DO-NOT-LEAK-ABCD";
const TOKEN = "validation-token-DO-NOT-LEAK";

let server: Server;
let targetServer: Server;
let baseUrl: string;
let redirectTargetUrl: string;
let redirectTargetRequests = 0;
const capturedRequests: Array<{
  accept?: string;
  authorization?: string;
  method?: string;
  url?: string;
}> = [];

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

async function loadVerifier(): Promise<VerifierModule> {
  const load = verifierModules["../../../src/adapters/outbound/model-runtime/provider-verifier.ts"];
  expect(load, "the provider network verifier must exist").toBeTypeOf("function");
  return load();
}

async function expectFailure(
  promise: Promise<unknown>,
  code: string,
  httpStatus: number,
): Promise<void> {
  await expect(promise).rejects.toMatchObject({
    category: expect.any(String),
    code,
    correlationId: "correlation-1",
    httpStatus,
  });
}

beforeAll(async () => {
  targetServer = createServer((_request, response) => {
    redirectTargetRequests += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "model-a" }] }));
  });
  redirectTargetUrl = await listen(targetServer);

  server = createServer((request, response) => {
    capturedRequests.push({
      accept: request.headers.accept,
      authorization: request.headers.authorization,
      method: request.method,
      url: request.url,
    });
    const path = request.url ?? "";
    if (path === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "model-a" }, { id: "model-b" }] }));
      return;
    }
    if (path === "/redirect/models") {
      response.writeHead(302, { location: `${redirectTargetUrl}/models` });
      response.end();
      return;
    }
    if (path.startsWith("/status/")) {
      response.writeHead(Number(path.split("/")[2]), { "content-type": "application/json" });
      response.end(JSON.stringify({ error: `sensitive-body-${TOKEN}` }));
      return;
    }
    if (path === "/non-json/models") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end(`not json ${TOKEN}`);
      return;
    }
    if (path === "/invalid-shape/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ name: "model-a" }] }));
      return;
    }
    if (path === "/missing-model/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "model-b" }] }));
      return;
    }
    if (path === "/too-many/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          data: Array.from({ length: 10_001 }, (_, index) => ({ id: `model-${index}` })),
        }),
      );
      return;
    }
    if (path === "/exact-limit/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          data: [
            ...Array.from({ length: 9_999 }, (_, index) => ({ id: `other-${index}` })),
            { id: "model-a" },
          ],
        }),
      );
      return;
    }
    if (path === "/too-large/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [], padding: "x".repeat(1024 * 1024) }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  baseUrl = await listen(server);
});

afterAll(async () => {
  await Promise.all([close(server), close(targetServer)]);
});

afterEach(() => {
  capturedRequests.length = 0;
  redirectTargetRequests = 0;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("provider verifier", () => {
  it("normalizes approved WHATWG URLs and rejects unsafe URL components", async () => {
    const { normalizeProviderBaseUrl } = await loadVerifier();

    expect(
      normalizeProviderBaseUrl("HTTPS://例子.测试:443/a/../v1/", false),
    ).toBe("https://xn--fsqu00a.xn--0zwm56d/v1");
    expect(normalizeProviderBaseUrl("https://EXAMPLE.test/", false)).toBe(
      "https://example.test",
    );
    expect(normalizeProviderBaseUrl("http://localhost:8080/v1/", true)).toBe(
      "http://localhost:8080/v1",
    );

    for (const invalid of [
      ["ftp://example.test/v1", true],
      ["https://user:pass@example.test/v1", false],
      ["https://example.test/v1?key=value", false],
      ["https://example.test/v1#fragment", false],
      ["not a URL", false],
    ] as const) {
      expect(() => normalizeProviderBaseUrl(invalid[0], invalid[1])).toThrowError(
        expect.objectContaining({ code: "INVALID_INPUT", httpStatus: 400 }),
      );
    }
    expect(() => normalizeProviderBaseUrl("http://example.test/v1", false)).toThrowError(
      expect.objectContaining({
        code: "INSECURE_HTTP_CONFIRMATION_REQUIRED",
        httpStatus: 400,
      }),
    );
  });

  it("constructs /models safely and sends the credential-bearing GET", async () => {
    const { verifyProviderConnection } = await loadVerifier();

    await expect(
      verifyProviderConnection(
        {
          allowInsecureHttp: true,
          apiKey: API_KEY,
          baseUrl: `${baseUrl}/root/../v1/`,
          model: "model-a",
        },
        { correlationId: "correlation-1", providerId: "provider-1" },
      ),
    ).resolves.toEqual({ normalizedBaseUrl: `${baseUrl}/v1`, verifiedModel: "model-a" });
    expect(capturedRequests).toEqual([
      {
        accept: "application/json",
        authorization: `Bearer ${API_KEY}`,
        method: "GET",
        url: "/v1/models",
      },
    ]);
  });

  it("does not follow redirects or send credentials to the redirect target", async () => {
    const { verifyProviderConnection } = await loadVerifier();

    await expectFailure(
      verifyProviderConnection(
        {
          allowInsecureHttp: true,
          apiKey: API_KEY,
          baseUrl: `${baseUrl}/redirect`,
          model: "model-a",
        },
        { correlationId: "correlation-1", providerId: "provider-1" },
      ),
      "PROVIDER_REDIRECTED",
      502,
    );
    expect(redirectTargetRequests).toBe(0);
  });

  it.each([
    [401, "PROVIDER_UNAUTHORIZED", 401],
    [403, "PROVIDER_UNAUTHORIZED", 401],
    [404, "PROVIDER_INCOMPATIBLE", 502],
    [418, "PROVIDER_REJECTED", 502],
    [429, "PROVIDER_RATE_LIMITED", 429],
    [500, "PROVIDER_UPSTREAM_ERROR", 502],
    [503, "PROVIDER_UPSTREAM_ERROR", 502],
  ])("maps upstream status %i to %s", async (status, code, httpStatus) => {
    const { verifyProviderConnection } = await loadVerifier();

    await expectFailure(
      verifyProviderConnection(
        {
          allowInsecureHttp: true,
          apiKey: API_KEY,
          baseUrl: `${baseUrl}/status/${status}`,
          model: "model-a",
        },
        { correlationId: "correlation-1" },
      ),
      code,
      httpStatus,
    );
  });

  it("bounds and validates the model catalog while allowing exactly 10000 entries", async () => {
    const { verifyProviderConnection } = await loadVerifier();
    const verifyPath = (path: string, model = "model-a") =>
      verifyProviderConnection(
        {
          allowInsecureHttp: true,
          apiKey: API_KEY,
          baseUrl: `${baseUrl}/${path}`,
          model,
        },
        { correlationId: "correlation-1" },
      );

    await expectFailure(verifyPath("non-json"), "PROVIDER_INCOMPATIBLE", 502);
    await expectFailure(verifyPath("invalid-shape"), "PROVIDER_INCOMPATIBLE", 502);
    await expectFailure(verifyPath("missing-model"), "PROVIDER_INCOMPATIBLE", 502);
    await expectFailure(verifyPath("too-many"), "PROVIDER_RESPONSE_TOO_LARGE", 502);
    await expectFailure(verifyPath("too-large"), "PROVIDER_RESPONSE_TOO_LARGE", 502);
    await expect(verifyPath("exact-limit")).resolves.toMatchObject({
      verifiedModel: "model-a",
    });
  });

  it("aborts after ten seconds and maps connection failures", async () => {
    const { verifyProviderConnection } = await loadVerifier();
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(Object.assign(new Error(`raw timeout ${API_KEY} ${TOKEN}`), { name: "AbortError" }));
          });
        });
      }),
    );
    const timeout = expectFailure(
      verifyProviderConnection(
        {
          allowInsecureHttp: true,
          apiKey: API_KEY,
          baseUrl: "http://127.0.0.1:1/v1",
          model: "model-a",
        },
        { correlationId: "correlation-1" },
      ),
      "PROVIDER_TIMEOUT",
      504,
    );

    await vi.advanceTimersByTimeAsync(9_999);
    expect(vi.mocked(fetch)).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await timeout;

    vi.useRealTimers();
    vi.unstubAllGlobals();
    await expectFailure(
      verifyProviderConnection(
        {
          allowInsecureHttp: true,
          apiKey: API_KEY,
          baseUrl: "http://127.0.0.1:1/v1",
          model: "model-a",
        },
        { correlationId: "correlation-1" },
      ),
      "PROVIDER_UNREACHABLE",
      502,
    );
    await expectFailure(
      verifyProviderConnection(
        {
          allowInsecureHttp: false,
          apiKey: API_KEY,
          baseUrl: baseUrl.replace("http://", "https://"),
          model: "model-a",
        },
        { correlationId: "correlation-1" },
      ),
      "PROVIDER_UNREACHABLE",
      502,
    );
  });

  it("logs only the approved typed whitelist without sensitive values or raw errors", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { verifyProviderConnection } = await loadVerifier();

    await expectFailure(
      verifyProviderConnection(
        {
          allowInsecureHttp: true,
          apiKey: API_KEY,
          baseUrl: `${baseUrl}/status/499`,
          model: "model-a",
        },
        { correlationId: "correlation-1", providerId: "provider-1" },
      ),
      "PROVIDER_REJECTED",
      502,
    );

    expect(errorSpy).toHaveBeenCalledWith({
      code: "PROVIDER_REJECTED",
      correlationId: "correlation-1",
      providerId: "provider-1",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error(`raw ${baseUrl} ${API_KEY} ${TOKEN}`)),
    );
    await expectFailure(
      verifyProviderConnection(
        {
          allowInsecureHttp: true,
          apiKey: API_KEY,
          baseUrl: `${baseUrl}/v1`,
          model: "model-a",
        },
        { correlationId: "correlation-1", providerId: "provider-1" },
      ),
      "PROVIDER_UNREACHABLE",
      502,
    );
    const logs = JSON.stringify(errorSpy.mock.calls);
    for (const sensitive of [baseUrl, API_KEY, TOKEN, "sensitive-body", "Error"]) {
      expect(logs).not.toContain(sensitive);
    }
  });
});
