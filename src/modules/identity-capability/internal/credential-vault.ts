import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import type {
  CredentialEnvelope,
  ExistingProviderTokenDraft,
  ProviderTokenDraft,
} from "@/src/modules/identity-capability/public/dto";
import {
  CredentialVaultError,
  type CredentialVaultErrorCode,
} from "@/src/modules/identity-capability/public/errors";

type VaultErrorCode = CredentialVaultErrorCode;

export type {
  CredentialEnvelope,
  ExistingProviderTokenDraft,
  ProviderTokenDraft,
} from "@/src/modules/identity-capability/public/dto";
export { CredentialVaultError } from "@/src/modules/identity-capability/public/errors";

type CreateTokenPayload = {
  aud: "provider-save";
  draftHash: string;
  exp: number;
  iat: number;
  mode: "create";
  v: 1;
};

type ExistingTokenPayload = {
  aud: "provider-save";
  credentialGeneration: number;
  draftHash: string;
  exp: number;
  iat: number;
  mode: "retain" | "replace";
  providerId: string;
  providerVersion: number;
  v: 1;
};

type TokenPayload = CreateTokenPayload | ExistingTokenPayload;

const TOKEN_AUDIENCE = "provider-save";
const TOKEN_LIFETIME_SECONDS = 5 * 60;
const TOKEN_MAX_LENGTH = 4_096;
const HKDF_SALT = Buffer.from("collaboration-cockpit:v1", "utf8");
const ENCRYPTION_INFO = Buffer.from("credential-encryption:v1", "utf8");
const TOKEN_INFO = Buffer.from("provider-validation-token:v1", "utf8");
const FINGERPRINT_INFO = Buffer.from("provider-key-fingerprint:v1", "utf8");

function fail(code: VaultErrorCode, message: string): never {
  throw new CredentialVaultError(code, message);
}

function decodeBase64url(value: unknown, expectedLength?: number): Buffer {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw new Error("Invalid base64url.");
  }
  const decoded = Buffer.from(value, "base64url");
  if (
    decoded.toString("base64url") !== value ||
    (expectedLength !== undefined && decoded.length !== expectedLength)
  ) {
    throw new Error("Invalid base64url.");
  }
  return decoded;
}

function deriveKey(masterKey: Buffer, info: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", masterKey, HKDF_SALT, info, 32));
}

function aad(providerId: string): Buffer {
  return Buffer.from(`provider-api-key:v1\u0000${providerId}`, "utf8");
}

function canonicalDraft(
  baseUrl: string,
  model: string,
  keyFingerprint: string,
): string {
  return JSON.stringify({ baseUrl, model, keyFingerprint });
}

function canonicalCreatePayload(payload: CreateTokenPayload): string {
  return JSON.stringify({
    aud: TOKEN_AUDIENCE,
    draftHash: payload.draftHash,
    exp: payload.exp,
    iat: payload.iat,
    mode: "create",
    v: 1,
  });
}

function canonicalExistingPayload(payload: ExistingTokenPayload): string {
  return JSON.stringify({
    aud: TOKEN_AUDIENCE,
    credentialGeneration: payload.credentialGeneration,
    draftHash: payload.draftHash,
    exp: payload.exp,
    iat: payload.iat,
    mode: payload.mode,
    providerId: payload.providerId,
    providerVersion: payload.providerVersion,
    v: 1,
  });
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function isTokenTime(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parsePayload(json: string): TokenPayload {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return fail("VALIDATION_MISMATCH", "Validation token is invalid.");
  }
  if (!value || typeof value !== "object") {
    return fail("VALIDATION_MISMATCH", "Validation token is invalid.");
  }
  const payload = value as {
    aud?: unknown;
    credentialGeneration?: unknown;
    draftHash?: unknown;
    exp?: unknown;
    iat?: unknown;
    mode?: unknown;
    providerId?: unknown;
    providerVersion?: unknown;
    v?: unknown;
  };
  if (
    payload.aud !== TOKEN_AUDIENCE ||
    payload.v !== 1 ||
    typeof payload.draftHash !== "string" ||
    !isTokenTime(payload.iat) ||
    !isTokenTime(payload.exp) ||
    payload.exp !== payload.iat + TOKEN_LIFETIME_SECONDS
  ) {
    return fail("VALIDATION_MISMATCH", "Validation token is invalid.");
  }
  try {
    decodeBase64url(payload.draftHash, 32);
  } catch {
    return fail("VALIDATION_MISMATCH", "Validation token is invalid.");
  }

  if (payload.mode === "create") {
    const createPayload = payload as Partial<CreateTokenPayload>;
    const canonical = canonicalCreatePayload(createPayload as CreateTokenPayload);
    if (canonical !== json) {
      return fail("VALIDATION_MISMATCH", "Validation token is not canonical.");
    }
    return createPayload as CreateTokenPayload;
  }

  if (
    (payload.mode !== "retain" && payload.mode !== "replace") ||
    typeof payload.providerId !== "string" ||
    payload.providerId.length === 0 ||
    !isPositiveInteger(payload.providerVersion) ||
    !isPositiveInteger(payload.credentialGeneration)
  ) {
    return fail("VALIDATION_MISMATCH", "Validation token is invalid.");
  }
  const existingPayload = payload as ExistingTokenPayload;
  if (canonicalExistingPayload(existingPayload) !== json) {
    return fail("VALIDATION_MISMATCH", "Validation token is not canonical.");
  }
  return existingPayload;
}

function safeEqual(left: string, right: string): boolean {
  let leftBytes: Buffer;
  let rightBytes: Buffer;
  try {
    leftBytes = decodeBase64url(left);
    rightBytes = decodeBase64url(right);
  } catch {
    return false;
  }
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export function createCredentialVault() {
  let masterKey: Buffer;
  try {
    masterKey = decodeBase64url(process.env.COCKPIT_MASTER_KEY, 32);
  } catch {
    return fail("MASTER_KEY_UNAVAILABLE", "Credential master key is unavailable.");
  }

  const encryptionKey = deriveKey(masterKey, ENCRYPTION_INFO);
  const tokenKey = deriveKey(masterKey, TOKEN_INFO);
  const fingerprintKey = deriveKey(masterKey, FINGERPRINT_INFO);
  const keyId = createHash("sha256").update(masterKey).digest("base64url").slice(0, 16);

  function mask(apiKey: string): string {
    return `••••${apiKey.slice(-4)}`;
  }

  function fingerprint(apiKey: string): string {
    return createHmac("sha256", fingerprintKey).update(apiKey, "utf8").digest("base64url");
  }

  function draftHash(draft: ProviderTokenDraft): string {
    return createHmac("sha256", fingerprintKey)
      .update(canonicalDraft(draft.baseUrl, draft.model, fingerprint(draft.apiKey)), "utf8")
      .digest("base64url");
  }

  function encrypt(providerId: string, apiKey: string): CredentialEnvelope {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
    cipher.setAAD(aad(providerId));
    const encrypted = Buffer.concat([cipher.update(apiKey, "utf8"), cipher.final()]);
    return {
      apiKeyCipher: encrypted.toString("base64url"),
      apiKeyIv: iv.toString("base64url"),
      apiKeyMask: mask(apiKey),
      apiKeyTag: cipher.getAuthTag().toString("base64url"),
      credentialVersion: 1,
      keyId,
    };
  }

  function decrypt(providerId: string, envelope: CredentialEnvelope): string {
    if (!envelope || envelope.keyId !== keyId) {
      return fail("PROVIDER_KEY_UNAVAILABLE", "Provider credential key is unavailable.");
    }
    try {
      if (envelope.credentialVersion !== 1) throw new Error("Unsupported envelope.");
      const iv = decodeBase64url(envelope.apiKeyIv, 12);
      const tag = decodeBase64url(envelope.apiKeyTag, 16);
      const encrypted = decodeBase64url(envelope.apiKeyCipher);
      const decipher = createDecipheriv("aes-256-gcm", encryptionKey, iv);
      decipher.setAAD(aad(providerId));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
    } catch {
      return fail("PROVIDER_KEY_CORRUPT", "Provider credential is corrupt.");
    }
  }

  function signPayload(json: string): string {
    const encodedPayload = Buffer.from(json, "utf8").toString("base64url");
    const signedContent = `v1.${encodedPayload}`;
    const signature = createHmac("sha256", tokenKey)
      .update(signedContent, "utf8")
      .digest("base64url");
    return `${signedContent}.${signature}`;
  }

  function issueCreateToken(draft: ProviderTokenDraft): string {
    const iat = Math.floor(Date.now() / 1_000);
    return signPayload(
      canonicalCreatePayload({
        aud: TOKEN_AUDIENCE,
        draftHash: draftHash(draft),
        exp: iat + TOKEN_LIFETIME_SECONDS,
        iat,
        mode: "create",
        v: 1,
      }),
    );
  }

  function issueExistingToken(draft: ExistingProviderTokenDraft): string {
    const iat = Math.floor(Date.now() / 1_000);
    return signPayload(
      canonicalExistingPayload({
        aud: TOKEN_AUDIENCE,
        credentialGeneration: draft.credentialGeneration,
        draftHash: draftHash(draft),
        exp: iat + TOKEN_LIFETIME_SECONDS,
        iat,
        mode: draft.mode,
        providerId: draft.providerId,
        providerVersion: draft.providerVersion,
        v: 1,
      }),
    );
  }

  function verifyToken(token: string): TokenPayload {
    if (typeof token !== "string" || token.length === 0 || token.length > TOKEN_MAX_LENGTH) {
      return fail("VALIDATION_MISMATCH", "Validation token is invalid.");
    }
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== "v1") {
      return fail("VALIDATION_MISMATCH", "Validation token is invalid.");
    }

    let payloadJson: string;
    try {
      payloadJson = decodeBase64url(parts[1]).toString("utf8");
      decodeBase64url(parts[2], 32);
    } catch {
      return fail("VALIDATION_MISMATCH", "Validation token is invalid.");
    }
    const payload = parsePayload(payloadJson);
    const expectedSignature = createHmac("sha256", tokenKey)
      .update(`v1.${parts[1]}`, "utf8")
      .digest("base64url");
    if (!safeEqual(parts[2], expectedSignature)) {
      return fail("VALIDATION_MISMATCH", "Validation token signature is invalid.");
    }

    const now = Math.floor(Date.now() / 1_000);
    if (payload.iat > now) {
      return fail("VALIDATION_MISMATCH", "Validation token is not active.");
    }
    if (now > payload.exp) {
      return fail("VALIDATION_EXPIRED", "Validation token has expired.");
    }
    return payload;
  }

  function verifyCreateToken(token: string, draft: ProviderTokenDraft): CreateTokenPayload {
    const payload = verifyToken(token);
    if (payload.mode !== "create" || !safeEqual(payload.draftHash, draftHash(draft))) {
      return fail("VALIDATION_MISMATCH", "Validation token does not match the draft.");
    }
    return payload;
  }

  function verifyExistingToken(
    token: string,
    draft: ExistingProviderTokenDraft,
  ): ExistingTokenPayload {
    const payload = verifyToken(token);
    if (
      payload.mode === "create" ||
      payload.mode !== draft.mode ||
      payload.providerId !== draft.providerId ||
      payload.providerVersion !== draft.providerVersion ||
      payload.credentialGeneration !== draft.credentialGeneration ||
      !safeEqual(payload.draftHash, draftHash(draft))
    ) {
      return fail("VALIDATION_MISMATCH", "Validation token does not match the provider.");
    }
    return payload;
  }

  return {
    decrypt,
    encrypt,
    fingerprint,
    issueCreateToken,
    issueExistingToken,
    keyId,
    mask,
    verifyCreateToken,
    verifyExistingToken,
  };
}
