import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/server/providerService", () => ({
  getProviders: vi.fn(),
  createProvider: vi.fn(),
  getProviderFull: vi.fn(),
  ValidationError: class ValidationError extends Error {},
}));

import { GET as listGET, POST } from "../app/api/providers/route";
import { GET as modelsGET } from "../app/api/providers/[id]/models/route";
import {
  getProviders,
  createProvider,
  getProviderFull,
  ValidationError,
} from "../src/server/providerService";

const mockedGetProviders = vi.mocked(getProviders);
const mockedCreateProvider = vi.mocked(createProvider);
const mockedGetProviderFull = vi.mocked(getProviderFull);

describe("POST /api/providers", () => {
  beforeEach(() => vi.resetAllMocks());

  it("creates and returns 201 WITHOUT apiKey", async () => {
    mockedCreateProvider.mockResolvedValue({
      id: 1, name: "P", baseUrl: "https://x/v4", createdAt: new Date(), agentCount: 0,
    });

    const req = new Request("http://localhost/api/providers", {
      method: "POST",
      body: JSON.stringify({ name: "P", baseUrl: "https://x/v4", apiKey: "secret" }),
    });
    const res = await POST(req);

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.config.name).toBe("P");
    expect(body.config).not.toHaveProperty("apiKey");
  });

  it("returns 400 when name empty", async () => {
    mockedCreateProvider.mockRejectedValue(new ValidationError("name 必填"));

    const req = new Request("http://localhost/api/providers", {
      method: "POST",
      body: JSON.stringify({ name: "" }),
    });
    const res = await POST(req);

    expect(res.status).toBe(400);
  });
});

describe("GET /api/providers (index)", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns 200 without apiKey", async () => {
    mockedGetProviders.mockResolvedValue([
      { id: 1, name: "P", baseUrl: "https://x/v4", createdAt: new Date(), agentCount: 0 },
    ]);

    const res = await listGET();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.configs[0]).not.toHaveProperty("apiKey");
  });
});

describe("GET /api/providers/:id/models", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns 200 with model ids from upstream", async () => {
    mockedGetProviderFull.mockResolvedValue({
      id: 1, name: "P", baseUrl: "https://x/v4", apiKey: "k", createdAt: new Date(),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: [{ id: "glm-4-plus" }, { id: "glm-4-plus-lite" }] }),
      })
    );

    const res = await modelsGET(new Request("http://localhost/api/providers/1/models"), {
      params: Promise.resolve({ id: "1" }),
    });

    expect(res.status).toBe(200);
    expect((await res.json()).models).toEqual(["glm-4-plus", "glm-4-plus-lite"]);
  });

  it("returns 404 when config not found", async () => {
    mockedGetProviderFull.mockRejectedValue(new Error("provider config not found"));

    const res = await modelsGET(new Request("http://localhost/api/providers/999/models"), {
      params: Promise.resolve({ id: "999" }),
    });

    expect(res.status).toBe(404);
  });

  it("returns 502 when upstream fails", async () => {
    mockedGetProviderFull.mockResolvedValue({
      id: 1, name: "P", baseUrl: "https://x/v4", apiKey: "k", createdAt: new Date(),
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));

    const res = await modelsGET(new Request("http://localhost/api/providers/1/models"), {
      params: Promise.resolve({ id: "1" }),
    });

    expect(res.status).toBe(502);
  });
});
