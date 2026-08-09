import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type CreateDraft = {
  allowInsecureHttp: boolean;
  apiKey: string;
  baseUrl: string;
  defaultModel: string;
  mode: "create";
  name: string;
};

type RetainDraft = {
  allowInsecureHttp: boolean;
  baseUrl: string;
  defaultModel: string;
  expectedVersion: number;
  mode: "retain";
  name: string;
  providerId: string;
};

type ReplaceDraft = Omit<RetainDraft, "mode"> & {
  apiKey: string;
  mode: "replace";
};

type Provider = {
  apiKeyMask: string;
  baseUrl: string;
  createdAt: string;
  defaultModel: string;
  id: string;
  name: string;
  status: "verified" | "key_unavailable" | "key_corrupt";
  updatedAt: string;
  verifiedAt: string;
  version: number;
};

type ProviderServiceModule = {
  createProvider: (
    draft: unknown,
    validationToken: string | undefined,
    databasePath: string,
  ) => Provider;
  listProviders: (databasePath: string) => Provider[];
  updateProvider: (
    providerId: string,
    draft: unknown,
    validationToken: string | undefined,
    databasePath: string,
  ) => Provider;
  verifyProviderDraft: (
    draft: unknown,
    databasePath: string,
  ) => Promise<{ expiresAt: string; validationToken: string; verifiedModel: string }>;
};

const serviceModules = import.meta.glob<ProviderServiceModule>(
  "../../../src/adapters/outbound/sqlite/identity-capability/provider-service.ts",
);
const MASTER_KEY = Buffer.alloc(32, 11).toString("base64url");
const REPLACEMENT_MASTER_KEY = Buffer.alloc(32, 12).toString("base64url");
const API_KEY = "provider-secret-DO-NOT-LEAK-ABCD";
const NEW_API_KEY = "replacement-secret-DO-NOT-LEAK-WXYZ";

let directory: string;
let databasePath: string;

async function loadService(): Promise<ProviderServiceModule> {
  const load = serviceModules["../../../src/adapters/outbound/sqlite/identity-capability/provider-service.ts"];
  expect(load, "the provider persistence service must exist").toBeTypeOf("function");
  return load();
}

function createDraft(): CreateDraft {
  return {
    allowInsecureHttp: false,
    apiKey: API_KEY,
    baseUrl: "https://EXAMPLE.test:443/v1/",
    defaultModel: "model-a",
    mode: "create",
    name: "Primary",
  };
}

function expectCode(operation: () => unknown, code: string): void {
  expect(operation).toThrowError(expect.objectContaining({ code }));
}

function fetchSuccess() {
  return vi.fn().mockImplementation(() =>
    Promise.resolve(Response.json({ data: [{ id: "model-a" }, { id: "model-b" }] })),
  );
}

function persistenceRow(): Record<string, unknown> {
  const database = new DatabaseSync(databasePath);
  const row = database.prepare("SELECT * FROM providers").get() as Record<string, unknown>;
  database.close();
  return row;
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cockpit-providers-service-"));
  databasePath = join(directory, "cockpit.sqlite");
  process.env.COCKPIT_MASTER_KEY = MASTER_KEY;
  vi.stubGlobal("fetch", fetchSuccess());
});

afterEach(() => {
  delete process.env.COCKPIT_MASTER_KEY;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  rmSync(directory, { force: true, recursive: true });
});

describe("provider service", () => {
  it("verifies, creates and lists a normalized provider without exposing plaintext", async () => {
    const service = await loadService();
    const draft = createDraft();
    const verification = await service.verifyProviderDraft(draft, databasePath);
    const provider = service.createProvider(draft, verification.validationToken, databasePath);

    expect(verification).toMatchObject({
      expiresAt: expect.any(String),
      verifiedModel: "model-a",
    });
    expect(provider).toMatchObject({
      apiKeyMask: "••••ABCD",
      baseUrl: "https://example.test/v1",
      defaultModel: "model-a",
      name: "Primary",
      status: "verified",
      version: 1,
    });
    expect(service.listProviders(databasePath)).toEqual([provider]);
    expect(JSON.stringify({ provider, providers: service.listProviders(databasePath) })).not.toContain(
      API_KEY,
    );
    expect(provider).not.toHaveProperty("apiKeyCipher");
    expect(provider).not.toHaveProperty("keyId");

    const row = persistenceRow();
    expect(row.credential_generation).toBe(1);
    expect(row.api_key_mask).toBe("••••ABCD");
    expect(JSON.stringify(row)).not.toContain(API_KEY);
    expect(readFileSync(databasePath).includes(Buffer.from(API_KEY))).toBe(false);
  });

  it("enforces create union legality and requires a matching create token", async () => {
    const service = await loadService();
    const draft = createDraft();
    const verification = await service.verifyProviderDraft(draft, databasePath);

    expectCode(() => service.createProvider(draft, undefined, databasePath), "VALIDATION_REQUIRED");
    expectCode(
      () =>
        service.createProvider(
          { ...draft, mode: "retain", providerId: "provider-1", expectedVersion: 1 },
          verification.validationToken,
          databasePath,
        ),
      "INVALID_INPUT",
    );
    expectCode(
      () =>
        service.createProvider(
          { ...draft, defaultModel: "model-b" },
          verification.validationToken,
          databasePath,
        ),
      "VALIDATION_MISMATCH",
    );
    expect(service.listProviders(databasePath)).toEqual([]);
  });

  it("allows retain name-only updates without a token and preserves credential generation", async () => {
    const service = await loadService();
    const draft = createDraft();
    const verification = await service.verifyProviderDraft(draft, databasePath);
    const created = service.createProvider(draft, verification.validationToken, databasePath);
    vi.mocked(fetch).mockClear();
    const retained: RetainDraft = {
      allowInsecureHttp: false,
      baseUrl: created.baseUrl,
      defaultModel: created.defaultModel,
      expectedVersion: created.version,
      mode: "retain",
      name: "Renamed",
      providerId: created.id,
    };

    const updated = service.updateProvider(created.id, retained, undefined, databasePath);

    expect(updated).toMatchObject({ name: "Renamed", version: 2 });
    expect(fetch).not.toHaveBeenCalled();
    expect(persistenceRow().credential_generation).toBe(1);
  });

  it("requires verification for retain connection changes and rejects stale versions and tokens", async () => {
    const service = await loadService();
    const initial = createDraft();
    const created = service.createProvider(
      initial,
      (await service.verifyProviderDraft(initial, databasePath)).validationToken,
      databasePath,
    );
    const changed: RetainDraft = {
      allowInsecureHttp: false,
      baseUrl: "https://example.test/v2/",
      defaultModel: "model-b",
      expectedVersion: 1,
      mode: "retain",
      name: created.name,
      providerId: created.id,
    };

    expectCode(
      () => service.updateProvider(created.id, changed, undefined, databasePath),
      "VALIDATION_REQUIRED",
    );
    const verification = await service.verifyProviderDraft(changed, databasePath);
    const renamed = service.updateProvider(
      created.id,
      { ...changed, baseUrl: created.baseUrl, defaultModel: created.defaultModel, name: "Concurrent" },
      undefined,
      databasePath,
    );
    expect(renamed.version).toBe(2);
    expectCode(
      () => service.updateProvider(created.id, changed, verification.validationToken, databasePath),
      "PROVIDER_CONFLICT",
    );

    const currentChange = { ...changed, expectedVersion: 2 };
    expectCode(
      () =>
        service.updateProvider(
          created.id,
          currentChange,
          verification.validationToken,
          databasePath,
        ),
      "VALIDATION_MISMATCH",
    );
    const currentVerification = await service.verifyProviderDraft(currentChange, databasePath);
    const updated = service.updateProvider(
      created.id,
      currentChange,
      currentVerification.validationToken,
      databasePath,
    );
    expect(updated).toMatchObject({
      baseUrl: "https://example.test/v2",
      defaultModel: "model-b",
      version: 3,
    });
    expect(persistenceRow().credential_generation).toBe(1);
  });

  it("replaces credentials atomically and invalidates stale tokens", async () => {
    const service = await loadService();
    const initial = createDraft();
    const created = service.createProvider(
      initial,
      (await service.verifyProviderDraft(initial, databasePath)).validationToken,
      databasePath,
    );
    const replace: ReplaceDraft = {
      allowInsecureHttp: false,
      apiKey: NEW_API_KEY,
      baseUrl: created.baseUrl,
      defaultModel: created.defaultModel,
      expectedVersion: 1,
      mode: "replace",
      name: created.name,
      providerId: created.id,
    };
    expectCode(
      () => service.updateProvider(created.id, replace, undefined, databasePath),
      "VALIDATION_REQUIRED",
    );
    expectCode(
      () => service.updateProvider(created.id, { ...replace, mode: "retain" }, undefined, databasePath),
      "INVALID_INPUT",
    );
    const { apiKey: _omitted, ...replaceWithoutKey } = replace;
    expectCode(
      () => service.updateProvider(created.id, replaceWithoutKey, undefined, databasePath),
      "INVALID_INPUT",
    );
    expectCode(
      () => service.updateProvider(created.id, initial, undefined, databasePath),
      "INVALID_INPUT",
    );
    const verification = await service.verifyProviderDraft(replace, databasePath);
    const updated = service.updateProvider(
      created.id,
      replace,
      verification.validationToken,
      databasePath,
    );

    expect(updated).toMatchObject({ apiKeyMask: "••••WXYZ", version: 2 });
    expect(persistenceRow().credential_generation).toBe(2);
    expect(readFileSync(databasePath).includes(Buffer.from(API_KEY))).toBe(false);
    expect(readFileSync(databasePath).includes(Buffer.from(NEW_API_KEY))).toBe(false);
    expectCode(
      () => service.updateProvider(created.id, replace, verification.validationToken, databasePath),
      "PROVIDER_CONFLICT",
    );
  });

  it("reports unavailable/corrupt keys and permits expected-version replace recovery", async () => {
    const service = await loadService();
    const initial = createDraft();
    const created = service.createProvider(
      initial,
      (await service.verifyProviderDraft(initial, databasePath)).validationToken,
      databasePath,
    );

    process.env.COCKPIT_MASTER_KEY = REPLACEMENT_MASTER_KEY;
    expect(service.listProviders(databasePath)[0].status).toBe("key_unavailable");
    const retain: RetainDraft = {
      allowInsecureHttp: false,
      baseUrl: created.baseUrl,
      defaultModel: created.defaultModel,
      expectedVersion: 1,
      mode: "retain",
      name: created.name,
      providerId: created.id,
    };
    await expect(service.verifyProviderDraft(retain, databasePath)).rejects.toMatchObject({
      code: "PROVIDER_KEY_UNAVAILABLE",
    });

    const replace: ReplaceDraft = {
      ...retain,
      apiKey: NEW_API_KEY,
      mode: "replace",
    };
    const recovery = await service.verifyProviderDraft(replace, databasePath);
    expect(
      service.updateProvider(created.id, replace, recovery.validationToken, databasePath),
    ).toMatchObject({ apiKeyMask: "••••WXYZ", status: "verified", version: 2 });

    const database = new DatabaseSync(databasePath);
    database
      .prepare("UPDATE providers SET api_key_tag = 'invalid+' WHERE id = ?")
      .run(created.id);
    database.close();
    expect(service.listProviders(databasePath)[0].status).toBe("key_corrupt");
    await expect(
      service.verifyProviderDraft({ ...retain, expectedVersion: 2 }, databasePath),
    ).rejects.toMatchObject({ code: "PROVIDER_KEY_CORRUPT" });
  });
});
