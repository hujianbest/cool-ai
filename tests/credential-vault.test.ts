import {
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
} from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

type CredentialEnvelope = {
  apiKeyCipher: string;
  apiKeyIv: string;
  apiKeyMask: string;
  apiKeyTag: string;
  credentialVersion: 1;
  keyId: string;
};

type ProviderDraft = {
  apiKey: string;
  baseUrl: string;
  model: string;
};

type ExistingTokenDraft = ProviderDraft & {
  credentialGeneration: number;
  mode: "retain" | "replace";
  providerId: string;
  providerVersion: number;
};

type CredentialVault = {
  decrypt: (providerId: string, envelope: CredentialEnvelope) => string;
  encrypt: (providerId: string, apiKey: string) => CredentialEnvelope;
  fingerprint: (apiKey: string) => string;
  issueCreateToken: (draft: ProviderDraft) => string;
  issueExistingToken: (draft: ExistingTokenDraft) => string;
  keyId: string;
  mask: (apiKey: string) => string;
  verifyCreateToken: (token: string, draft: ProviderDraft) => unknown;
  verifyExistingToken: (token: string, draft: ExistingTokenDraft) => unknown;
};

type VaultModule = {
  createCredentialVault: () => CredentialVault;
};

const vaultModules = import.meta.glob<VaultModule>("../src/server/credential-vault.ts");
const MASTER_KEY = Buffer.alloc(32, 7);
const MASTER_KEY_TEXT = MASTER_KEY.toString("base64url");
const SECRET = "vault-secret-DO-NOT-LEAK-9f31ABCD";
const SALT = Buffer.from("collaboration-cockpit:v1");

function expectCode(operation: () => unknown, code: string): void {
  expect(operation).toThrowError(expect.objectContaining({ code }));
}

function decodeTokenPayload(token: string): { json: string; payload: Record<string, unknown> } {
  const [, encodedPayload] = token.split(".");
  const json = Buffer.from(encodedPayload, "base64url").toString("utf8");
  return { json, payload: JSON.parse(json) as Record<string, unknown> };
}

function flipLastCharacter(value: string): string {
  return `${value.slice(0, -1)}${value.endsWith("A") ? "B" : "A"}`;
}

async function loadVaultModule(): Promise<VaultModule> {
  const loadVault = vaultModules["../src/server/credential-vault.ts"];
  expect(loadVault, "the versioned credential vault must exist").toBeTypeOf("function");
  return loadVault();
}

afterEach(() => {
  delete process.env.COCKPIT_MASTER_KEY;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("credential vault", () => {
  it("requires a canonical unpadded base64url 32-byte environment key", async () => {
    const { createCredentialVault } = await loadVaultModule();

    for (const invalid of [
      undefined,
      "",
      Buffer.alloc(31).toString("base64url"),
      Buffer.alloc(33).toString("base64url"),
      `${MASTER_KEY_TEXT}=`,
      Buffer.alloc(32, 255).toString("base64"),
      "not_base64url!",
    ]) {
      if (invalid === undefined) delete process.env.COCKPIT_MASTER_KEY;
      else process.env.COCKPIT_MASTER_KEY = invalid;
      expectCode(() => createCredentialVault(), "MASTER_KEY_UNAVAILABLE");
    }

    process.env.COCKPIT_MASTER_KEY = MASTER_KEY_TEXT;
    const vault = createCredentialVault();
    expect(vault.keyId).toBe(
      createHash("sha256").update(MASTER_KEY).digest("base64url").slice(0, 16),
    );
  });

  it("uses the fixed HKDF keys, AES-256-GCM envelope, provider AAD, mask and fingerprint", async () => {
    const { createCredentialVault } = await loadVaultModule();
    process.env.COCKPIT_MASTER_KEY = MASTER_KEY_TEXT;
    const vault = createCredentialVault();
    const envelope = vault.encrypt("provider-1", SECRET);

    expect(envelope).toMatchObject({
      apiKeyMask: "••••ABCD",
      credentialVersion: 1,
      keyId: vault.keyId,
    });
    expect(Buffer.from(envelope.apiKeyIv, "base64url")).toHaveLength(12);
    expect(Buffer.from(envelope.apiKeyTag, "base64url")).toHaveLength(16);
    expect(JSON.stringify(envelope)).not.toContain(SECRET);

    const encryptionKey = Buffer.from(
      hkdfSync("sha256", MASTER_KEY, SALT, Buffer.from("credential-encryption:v1"), 32),
    );
    const decipher = createDecipheriv(
      "aes-256-gcm",
      encryptionKey,
      Buffer.from(envelope.apiKeyIv, "base64url"),
    );
    decipher.setAAD(Buffer.from("provider-api-key:v1\u0000provider-1"));
    decipher.setAuthTag(Buffer.from(envelope.apiKeyTag, "base64url"));
    expect(
      Buffer.concat([
        decipher.update(Buffer.from(envelope.apiKeyCipher, "base64url")),
        decipher.final(),
      ]).toString("utf8"),
    ).toBe(SECRET);
    expect(vault.decrypt("provider-1", envelope)).toBe(SECRET);

    const fingerprintKey = Buffer.from(
      hkdfSync(
        "sha256",
        MASTER_KEY,
        SALT,
        Buffer.from("provider-key-fingerprint:v1"),
        32,
      ),
    );
    expect(vault.fingerprint(SECRET)).toBe(
      createHmac("sha256", fingerprintKey).update(SECRET).digest("base64url"),
    );
  });

  it("distinguishes unavailable keys from corrupt envelopes and supports replacement recovery", async () => {
    const { createCredentialVault } = await loadVaultModule();
    process.env.COCKPIT_MASTER_KEY = MASTER_KEY_TEXT;
    const originalVault = createCredentialVault();
    const envelope = originalVault.encrypt("provider-1", SECRET);

    expectCode(() => originalVault.decrypt("provider-2", envelope), "PROVIDER_KEY_CORRUPT");
    expectCode(
      () =>
        originalVault.decrypt("provider-1", {
          ...envelope,
          apiKeyCipher: flipLastCharacter(envelope.apiKeyCipher),
        }),
      "PROVIDER_KEY_CORRUPT",
    );
    expectCode(
      () => originalVault.decrypt("provider-1", { ...envelope, credentialVersion: 2 as 1 }),
      "PROVIDER_KEY_CORRUPT",
    );
    expectCode(
      () => originalVault.decrypt("provider-1", { ...envelope, apiKeyIv: "not+base64" }),
      "PROVIDER_KEY_CORRUPT",
    );

    process.env.COCKPIT_MASTER_KEY = Buffer.alloc(32, 8).toString("base64url");
    const replacementVault = createCredentialVault();
    expectCode(
      () => replacementVault.decrypt("provider-1", envelope),
      "PROVIDER_KEY_UNAVAILABLE",
    );
    const replacement = replacementVault.encrypt("provider-1", "replacement-key-WXYZ");
    expect(replacementVault.decrypt("provider-1", replacement)).toBe("replacement-key-WXYZ");
    const replaceDraft: ExistingTokenDraft = {
      apiKey: "replacement-key-WXYZ",
      baseUrl: "https://example.test/v1",
      credentialGeneration: 4,
      mode: "replace",
      model: "model-a",
      providerId: "provider-1",
      providerVersion: 8,
    };
    const replaceToken = replacementVault.issueExistingToken(replaceDraft);
    expect(() => replacementVault.verifyExistingToken(replaceToken, replaceDraft)).not.toThrow();
  });

  it("issues and verifies canonical create tokens bound to the complete draft", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T12:00:00.000Z"));
    const { createCredentialVault } = await loadVaultModule();
    process.env.COCKPIT_MASTER_KEY = MASTER_KEY_TEXT;
    const vault = createCredentialVault();
    const draft = { apiKey: SECRET, baseUrl: "https://example.test/v1", model: "model-a" };
    const token = vault.issueCreateToken(draft);
    const { json, payload } = decodeTokenPayload(token);

    expect(token.split(".")).toHaveLength(3);
    expect(token.startsWith("v1.")).toBe(true);
    const fingerprintKey = Buffer.from(
      hkdfSync(
        "sha256",
        MASTER_KEY,
        SALT,
        Buffer.from("provider-key-fingerprint:v1"),
        32,
      ),
    );
    const expectedFingerprint = createHmac("sha256", fingerprintKey)
      .update(SECRET)
      .digest("base64url");
    const expectedDraftHash = createHmac("sha256", fingerprintKey)
      .update(
        JSON.stringify({
          baseUrl: draft.baseUrl,
          model: draft.model,
          keyFingerprint: expectedFingerprint,
        }),
      )
      .digest("base64url");
    expect(payload.draftHash).toBe(expectedDraftHash);
    expect(json).toBe(
      JSON.stringify({
        aud: "provider-save",
        draftHash: payload.draftHash,
        exp: 1_785_326_700,
        iat: 1_785_326_400,
        mode: "create",
        v: 1,
      }),
    );
    const tokenKey = Buffer.from(
      hkdfSync(
        "sha256",
        MASTER_KEY,
        SALT,
        Buffer.from("provider-validation-token:v1"),
        32,
      ),
    );
    const [version, encodedPayload, signature] = token.split(".");
    expect(signature).toBe(
      createHmac("sha256", tokenKey)
        .update(`${version}.${encodedPayload}`)
        .digest("base64url"),
    );
    expect(token).not.toContain(SECRET);
    expect(() => vault.verifyCreateToken(token, draft)).not.toThrow();
    expectCode(
      () => vault.verifyCreateToken(token, { ...draft, model: "model-b" }),
      "VALIDATION_MISMATCH",
    );
    expectCode(
      () => vault.verifyCreateToken(flipLastCharacter(token), draft),
      "VALIDATION_MISMATCH",
    );

    vi.setSystemTime(new Date("2026-07-29T12:05:00.000Z"));
    expect(() => vault.verifyCreateToken(token, draft)).not.toThrow();
    vi.setSystemTime(new Date("2026-07-29T12:05:01.000Z"));
    expectCode(() => vault.verifyCreateToken(token, draft), "VALIDATION_EXPIRED");
  });

  it("binds retain and replace tokens to provider version and credential generation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T12:00:00.000Z"));
    const { createCredentialVault } = await loadVaultModule();
    process.env.COCKPIT_MASTER_KEY = MASTER_KEY_TEXT;
    const vault = createCredentialVault();
    const draft: ExistingTokenDraft = {
      apiKey: SECRET,
      baseUrl: "https://example.test/v1",
      credentialGeneration: 3,
      mode: "retain",
      model: "model-a",
      providerId: "provider-1",
      providerVersion: 7,
    };
    const token = vault.issueExistingToken(draft);
    const { json, payload } = decodeTokenPayload(token);

    expect(json).toBe(
      JSON.stringify({
        aud: "provider-save",
        credentialGeneration: 3,
        draftHash: payload.draftHash,
        exp: 1_785_326_700,
        iat: 1_785_326_400,
        mode: "retain",
        providerId: "provider-1",
        providerVersion: 7,
        v: 1,
      }),
    );
    expect(() => vault.verifyExistingToken(token, draft)).not.toThrow();
    expectCode(
      () => vault.verifyExistingToken(token, { ...draft, providerVersion: 8 }),
      "VALIDATION_MISMATCH",
    );
    expectCode(
      () => vault.verifyExistingToken(token, { ...draft, credentialGeneration: 4 }),
      "VALIDATION_MISMATCH",
    );
    expectCode(
      () => vault.verifyExistingToken(token, { ...draft, mode: "replace" }),
      "VALIDATION_MISMATCH",
    );

    const replaceDraft = {
      ...draft,
      apiKey: "replacement-key-WXYZ",
      credentialGeneration: 4,
      mode: "replace" as const,
      providerVersion: 8,
    };
    const replaceToken = vault.issueExistingToken(replaceDraft);
    expect(() => vault.verifyExistingToken(replaceToken, replaceDraft)).not.toThrow();
  });

  it("rejects malformed and oversized tokens before accepting a signature", async () => {
    const { createCredentialVault } = await loadVaultModule();
    process.env.COCKPIT_MASTER_KEY = MASTER_KEY_TEXT;
    const vault = createCredentialVault();
    const draft = { apiKey: SECRET, baseUrl: "https://example.test/v1", model: "model-a" };

    for (const token of [
      "",
      "v2.payload.signature",
      "v1.invalid+.signature",
      `v1.${"A".repeat(20_000)}.signature`,
      "v1.payload",
    ]) {
      expectCode(() => vault.verifyCreateToken(token, draft), "VALIDATION_MISMATCH");
    }
  });

  it("does not expose plaintext in envelopes, tokens, implementation source, or logs", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { createCredentialVault } = await loadVaultModule();
    process.env.COCKPIT_MASTER_KEY = MASTER_KEY_TEXT;
    const vault = createCredentialVault();
    const envelope = vault.encrypt("provider-1", SECRET);
    const token = vault.issueCreateToken({
      apiKey: SECRET,
      baseUrl: "https://example.test/v1",
      model: "model-a",
    });
    expectCode(
      () =>
        vault.decrypt("provider-1", {
          ...envelope,
          apiKeyTag: flipLastCharacter(envelope.apiKeyTag),
        }),
      "PROVIDER_KEY_CORRUPT",
    );

    expect(JSON.stringify({ envelope, token })).not.toContain(SECRET);
    const serverSources = readdirSync(join(process.cwd(), "src", "server"))
      .filter((name) => name.endsWith(".ts"))
      .map((name) => readFileSync(join(process.cwd(), "src", "server", name), "utf8"))
      .join("\n");
    expect(serverSources).not.toContain(SECRET);
    expect(serverSources).toContain("timingSafeEqual");
    expect(JSON.stringify([...errorSpy.mock.calls, ...logSpy.mock.calls])).not.toContain(SECRET);
  });
});
