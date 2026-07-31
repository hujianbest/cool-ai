import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type CollectionRoute = {
  GET: () => Promise<Response>;
  POST: (request: Request) => Promise<Response>;
};

type VerifyRoute = {
  POST: (request: Request) => Promise<Response>;
};

type ItemRoute = {
  PATCH: (
    request: Request,
    context: { params: Promise<{ providerId: string }> },
  ) => Promise<Response>;
};

const collectionRoutes = import.meta.glob<CollectionRoute>(
  "../app/api/providers/route.ts",
);
const verifyRoutes = import.meta.glob<VerifyRoute>(
  "../app/api/providers/verify/route.ts",
);
const itemRoutes = import.meta.glob<ItemRoute>(
  "../app/api/providers/[providerId]/route.ts",
);

const MASTER_KEY = Buffer.alloc(32, 13).toString("base64url");
const API_KEY = "api-provider-secret-DO-NOT-LEAK-ABCD";
let directory: string;
let databasePath: string;

async function loadRoutes() {
  const loadCollection = collectionRoutes["../app/api/providers/route.ts"];
  const loadVerify = verifyRoutes["../app/api/providers/verify/route.ts"];
  const loadItem = itemRoutes["../app/api/providers/[providerId]/route.ts"];
  expect(loadCollection, "provider collection routes must exist").toBeTypeOf("function");
  expect(loadVerify, "provider verification route must exist").toBeTypeOf("function");
  expect(loadItem, "provider item route must exist").toBeTypeOf("function");
  return {
    collection: await loadCollection(),
    item: await loadItem(),
    verify: await loadVerify(),
  };
}

function request(url: string, body: unknown, method = "POST"): Request {
  return new Request(url, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method,
  });
}

function createDraft() {
  return {
    allowInsecureHttp: false,
    apiKey: API_KEY,
    baseUrl: "https://example.test/v1",
    defaultModel: "model-a",
    mode: "create",
    name: "Primary",
  } as const;
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cockpit-providers-api-"));
  databasePath = join(directory, "cockpit.sqlite");
  process.env.COCKPIT_DB_PATH = databasePath;
  process.env.COCKPIT_MASTER_KEY = MASTER_KEY;
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(() =>
      Promise.resolve(Response.json({ data: [{ id: "model-a" }, { id: "model-b" }] })),
    ),
  );
});

afterEach(() => {
  delete process.env.COCKPIT_DB_PATH;
  delete process.env.COCKPIT_MASTER_KEY;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  rmSync(directory, { force: true, recursive: true });
});

describe("provider API", () => {
  it("verifies, creates and lists a provider without returning the API key", async () => {
    const routes = await loadRoutes();
    const draft = createDraft();
    const verified = await routes.verify.POST(
      request("http://localhost/api/providers/verify", draft),
    );
    expect(verified.status).toBe(200);
    const verification = await verified.json();
    expect(verification).toMatchObject({
      expiresAt: expect.any(String),
      validationToken: expect.any(String),
      verifiedModel: "model-a",
    });
    expect(JSON.stringify(verification)).not.toContain(API_KEY);

    const created = await routes.collection.POST(
      request("http://localhost/api/providers", {
        draft,
        validationToken: verification.validationToken,
      }),
    );
    expect(created.status).toBe(201);
    const { provider } = await created.json();
    expect(provider).toMatchObject({
      apiKeyMask: "••••ABCD",
      status: "verified",
      version: 1,
    });
    expect(JSON.stringify(provider)).not.toContain(API_KEY);

    const listed = await routes.collection.GET();
    expect(listed.status).toBe(200);
    await expect(listed.json()).resolves.toEqual({ providers: [provider] });
    expect(readFileSync(databasePath).includes(Buffer.from(API_KEY))).toBe(false);
  });

  it("supports token-free name-only PATCH and rejects path-id mismatch", async () => {
    const routes = await loadRoutes();
    const draft = createDraft();
    const verification = await (
      await routes.verify.POST(request("http://localhost/api/providers/verify", draft))
    ).json();
    const { provider } = await (
      await routes.collection.POST(
        request("http://localhost/api/providers", {
          draft,
          validationToken: verification.validationToken,
        }),
      )
    ).json();
    const retain = {
      allowInsecureHttp: false,
      baseUrl: provider.baseUrl,
      defaultModel: provider.defaultModel,
      expectedVersion: 1,
      mode: "retain",
      name: "Renamed",
      providerId: provider.id,
    };

    const patched = await routes.item.PATCH(
      request(`http://localhost/api/providers/${provider.id}`, { draft: retain }, "PATCH"),
      { params: Promise.resolve({ providerId: provider.id }) },
    );
    expect(patched.status).toBe(200);
    await expect(patched.json()).resolves.toMatchObject({
      provider: { name: "Renamed", version: 2 },
    });

    const mismatch = await routes.item.PATCH(
      request("http://localhost/api/providers/other", { draft: { ...retain, expectedVersion: 2 } }, "PATCH"),
      { params: Promise.resolve({ providerId: "other" }) },
    );
    expect(mismatch.status).toBe(400);
    await expect(mismatch.json()).resolves.toMatchObject({
      error: { code: "INVALID_INPUT" },
    });
  });

  it("returns stable errors for illegal unions, missing tokens and stale concurrency state", async () => {
    const routes = await loadRoutes();
    const draft = createDraft();
    const illegalCreate = await routes.collection.POST(
      request("http://localhost/api/providers", {
        draft: {
          ...draft,
          expectedVersion: 1,
          mode: "retain",
          providerId: "provider-1",
        },
        validationToken: "token",
      }),
    );
    expect(illegalCreate.status).toBe(400);
    await expect(illegalCreate.json()).resolves.toMatchObject({
      error: { code: "INVALID_INPUT" },
    });

    const missingToken = await routes.collection.POST(
      request("http://localhost/api/providers", { draft }),
    );
    expect(missingToken.status).toBe(409);
    await expect(missingToken.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_REQUIRED" },
    });

    const verification = await (
      await routes.verify.POST(request("http://localhost/api/providers/verify", draft))
    ).json();
    const { provider } = await (
      await routes.collection.POST(
        request("http://localhost/api/providers", {
          draft,
          validationToken: verification.validationToken,
        }),
      )
    ).json();
    const replace = {
      ...draft,
      apiKey: "new-api-key-WXYZ",
      expectedVersion: 1,
      mode: "replace",
      providerId: provider.id,
    };
    const replaceVerification = await (
      await routes.verify.POST(request("http://localhost/api/providers/verify", replace))
    ).json();
    const nameOnly = {
      allowInsecureHttp: false,
      baseUrl: provider.baseUrl,
      defaultModel: provider.defaultModel,
      expectedVersion: 1,
      mode: "retain",
      name: "Concurrent",
      providerId: provider.id,
    };
    await routes.item.PATCH(
      request(`http://localhost/api/providers/${provider.id}`, { draft: nameOnly }, "PATCH"),
      { params: Promise.resolve({ providerId: provider.id }) },
    );
    const stale = await routes.item.PATCH(
      request(
        `http://localhost/api/providers/${provider.id}`,
        { draft: replace, validationToken: replaceVerification.validationToken },
        "PATCH",
      ),
      { params: Promise.resolve({ providerId: provider.id }) },
    );
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({
      error: { code: "PROVIDER_CONFLICT" },
    });
  });

  it("sanitizes verifier failures and logs without URL, key, token, body or raw Error", async () => {
    const routes = await loadRoutes();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockRejectedValue(
          new Error(`raw ${API_KEY} validation-token-sensitive https://example.test/v1 body`),
        ),
    );

    const response = await routes.verify.POST(
      request("http://localhost/api/providers/verify", createDraft()),
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "PROVIDER_UNREACHABLE",
        correlationId: expect.any(String),
      },
    });
    const logs = JSON.stringify(errorSpy.mock.calls);
    for (const sensitive of [
      API_KEY,
      "validation-token-sensitive",
      "https://example.test/v1",
      "body",
      "Error",
    ]) {
      expect(logs).not.toContain(sensitive);
    }
  });
});
