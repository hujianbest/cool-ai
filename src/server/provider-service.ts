import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ZodIssue } from "zod";

import {
  createCredentialVault,
  CredentialVaultError,
  type CredentialEnvelope,
} from "@/src/server/credential-vault";
import { isProviderInActiveCollaboration } from "@/src/server/collaboration/active-run-guards";
import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import {
  normalizeProviderBaseUrl,
  verifyProviderConnection,
} from "@/src/server/provider-verifier";
import type {
  CreateProviderDraft,
  Provider,
  ProviderDraft,
  ReplaceProviderDraft,
  RetainProviderDraft,
} from "@/src/shared/team-contracts";
import { providerDraftSchema } from "@/src/shared/team-schemas";

type ProviderRow = {
  id: string;
  name: string;
  baseUrl: string;
  defaultModel: string;
  apiKeyCipher: string;
  apiKeyIv: string;
  apiKeyTag: string;
  credentialVersion: number;
  credentialGeneration: number;
  keyId: string;
  apiKeyMask: string;
  verifiedAt: string;
  version: number;
  createdAt: string;
  updatedAt: string;
};

type Vault = ReturnType<typeof createCredentialVault>;

export class ProviderServiceError extends Error {
  constructor(
    public readonly code: string,
    public readonly httpStatus: number,
    message: string,
    public readonly fields?: Array<{ field: string; code: string }>,
  ) {
    super(message);
    this.name = "ProviderServiceError";
  }
}

function serviceError(code: string, httpStatus: number, message: string): ProviderServiceError {
  return new ProviderServiceError(code, httpStatus, message);
}

function fieldCode(issue: ZodIssue): string {
  if (issue.code === "too_big") return "too_long";
  if (issue.code === "invalid_type") return "invalid_format";
  return "required";
}

function parseDraft(input: unknown): ProviderDraft {
  const parsed = providerDraftSchema.safeParse(input);
  if (!parsed.success) {
    throw new ProviderServiceError(
      "INVALID_INPUT",
      400,
      "Provider input is invalid.",
      parsed.error.issues.map((issue) => ({
        code: fieldCode(issue),
        field: issue.path.join(".") || "mode",
      })),
    );
  }
  return parsed.data;
}

function envelope(row: ProviderRow): CredentialEnvelope {
  return {
    apiKeyCipher: row.apiKeyCipher,
    apiKeyIv: row.apiKeyIv,
    apiKeyMask: row.apiKeyMask,
    apiKeyTag: row.apiKeyTag,
    credentialVersion: row.credentialVersion as 1,
    keyId: row.keyId,
  };
}

function mapVaultError(error: CredentialVaultError): ProviderServiceError {
  const status = error.code === "MASTER_KEY_UNAVAILABLE" ? 503 : 409;
  return serviceError(error.code, status, error.message);
}

function vaultOrThrow(): Vault {
  try {
    return createCredentialVault();
  } catch (error) {
    if (error instanceof CredentialVaultError) throw mapVaultError(error);
    throw error;
  }
}

function getProviderRow(database: DatabaseSync, providerId: string): ProviderRow | undefined {
  return database
    .prepare(`
      SELECT
        id,
        name,
        base_url AS baseUrl,
        default_model AS defaultModel,
        api_key_cipher AS apiKeyCipher,
        api_key_iv AS apiKeyIv,
        api_key_tag AS apiKeyTag,
        credential_version AS credentialVersion,
        credential_generation AS credentialGeneration,
        key_id AS keyId,
        api_key_mask AS apiKeyMask,
        verified_at AS verifiedAt,
        version,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM providers
      WHERE id = ?
    `)
    .get(providerId) as ProviderRow | undefined;
}

function providerStatus(row: ProviderRow, vault: Vault | undefined): Provider["status"] {
  if (!vault) return "key_unavailable";
  try {
    vault.decrypt(row.id, envelope(row));
    return row.verifiedAt ? "verified" : "key_corrupt";
  } catch (error) {
    if (error instanceof CredentialVaultError) {
      return error.code === "PROVIDER_KEY_UNAVAILABLE" ? "key_unavailable" : "key_corrupt";
    }
    return "key_corrupt";
  }
}

function toProvider(row: ProviderRow, vault: Vault | undefined): Provider {
  return {
    apiKeyMask: row.apiKeyMask,
    baseUrl: row.baseUrl,
    createdAt: row.createdAt,
    defaultModel: row.defaultModel,
    id: row.id,
    name: row.name,
    status: providerStatus(row, vault),
    updatedAt: row.updatedAt,
    verifiedAt: row.verifiedAt,
    version: row.version,
  };
}

function withTransaction<T>(database: DatabaseSync, operation: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the domain failure.
    }
    throw error;
  }
}

function normalizeDraftConnection(draft: ProviderDraft): {
  baseUrl: string;
  model: string;
} {
  return {
    baseUrl: normalizeProviderBaseUrl(draft.baseUrl, draft.allowInsecureHttp),
    model: draft.defaultModel,
  };
}

function expiresAt(): string {
  const expires = (Math.floor(Date.now() / 1_000) + 5 * 60) * 1_000;
  return new Date(expires).toISOString();
}

export async function verifyProviderDraft(
  input: unknown,
  databasePath: string,
): Promise<{ expiresAt: string; validationToken: string; verifiedModel: string }> {
  const draft = parseDraft(input);
  const vault = vaultOrThrow();

  if (draft.mode === "create") {
    const verified = await verifyProviderConnection({
      allowInsecureHttp: draft.allowInsecureHttp,
      apiKey: draft.apiKey,
      baseUrl: draft.baseUrl,
      model: draft.defaultModel,
    });
    const validationToken = vault.issueCreateToken({
      apiKey: draft.apiKey,
      baseUrl: verified.normalizedBaseUrl,
      model: draft.defaultModel,
    });
    return { expiresAt: expiresAt(), validationToken, verifiedModel: verified.verifiedModel };
  }

  const database = openDatabase(databasePath);
  let row: ProviderRow;
  try {
    const found = getProviderRow(database, draft.providerId);
    if (!found) throw serviceError("PROVIDER_NOT_FOUND", 404, "Provider was not found.");
    if (found.version !== draft.expectedVersion) {
      throw serviceError("PROVIDER_CONFLICT", 409, "Provider version is stale.");
    }
    row = found;
  } finally {
    database.close();
  }

  let apiKey: string;
  if (draft.mode === "replace") {
    apiKey = draft.apiKey;
  } else {
    try {
      apiKey = vault.decrypt(row.id, envelope(row));
    } catch (error) {
      if (error instanceof CredentialVaultError) throw mapVaultError(error);
      throw error;
    }
  }
  const verified = await verifyProviderConnection(
    {
      allowInsecureHttp: draft.allowInsecureHttp,
      apiKey,
      baseUrl: draft.baseUrl,
      model: draft.defaultModel,
    },
    { providerId: row.id },
  );
  const validationToken = vault.issueExistingToken({
    apiKey,
    baseUrl: verified.normalizedBaseUrl,
    credentialGeneration: row.credentialGeneration,
    mode: draft.mode,
    model: draft.defaultModel,
    providerId: row.id,
    providerVersion: row.version,
  });
  return { expiresAt: expiresAt(), validationToken, verifiedModel: verified.verifiedModel };
}

export function createProvider(
  input: unknown,
  validationToken: string | undefined,
  databasePath: string,
): Provider {
  const parsed = parseDraft(input);
  if (parsed.mode !== "create") {
    throw serviceError("INVALID_INPUT", 400, "POST requires a create draft.");
  }
  if (!validationToken) {
    throw serviceError("VALIDATION_REQUIRED", 409, "Provider verification is required.");
  }
  const draft: CreateProviderDraft = parsed;
  const vault = vaultOrThrow();
  const normalized = normalizeDraftConnection(draft);
  try {
    vault.verifyCreateToken(validationToken, {
      apiKey: draft.apiKey,
      baseUrl: normalized.baseUrl,
      model: normalized.model,
    });
  } catch (error) {
    if (error instanceof CredentialVaultError) throw mapVaultError(error);
    throw error;
  }

  const id = randomUUID();
  const credential = vault.encrypt(id, draft.apiKey);
  const timestamp = new Date().toISOString();
  const database = openDatabase(databasePath);
  try {
    withTransaction(database, () => {
      database
        .prepare(`
          INSERT INTO providers (
            id, name, base_url, default_model,
            api_key_cipher, api_key_iv, api_key_tag, credential_version,
            credential_generation, key_id, api_key_mask, verified_at,
            version, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 1, ?, ?)
        `)
        .run(
          id,
          draft.name,
          normalized.baseUrl,
          normalized.model,
          credential.apiKeyCipher,
          credential.apiKeyIv,
          credential.apiKeyTag,
          credential.credentialVersion,
          credential.keyId,
          credential.apiKeyMask,
          timestamp,
          timestamp,
          timestamp,
        );
    });
    return toProvider(getProviderRow(database, id)!, vault);
  } finally {
    database.close();
  }
}

export function listProviders(databasePath: string): Provider[] {
  let vault: Vault | undefined;
  try {
    vault = createCredentialVault();
  } catch (error) {
    if (!(error instanceof CredentialVaultError) || error.code !== "MASTER_KEY_UNAVAILABLE") {
      throw error;
    }
  }
  const database = openDatabase(databasePath);
  try {
    const rows = database
      .prepare(`
        SELECT
          id,
          name,
          base_url AS baseUrl,
          default_model AS defaultModel,
          api_key_cipher AS apiKeyCipher,
          api_key_iv AS apiKeyIv,
          api_key_tag AS apiKeyTag,
          credential_version AS credentialVersion,
          credential_generation AS credentialGeneration,
          key_id AS keyId,
          api_key_mask AS apiKeyMask,
          verified_at AS verifiedAt,
          version,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM providers
        ORDER BY created_at ASC, id ASC
      `)
      .all() as ProviderRow[];
    return rows.map((row) => toProvider(row, vault));
  } finally {
    database.close();
  }
}

export function updateProvider(
  providerId: string,
  input: unknown,
  validationToken: string | undefined,
  databasePath: string,
): Provider {
  const parsed = parseDraft(input);
  if (parsed.mode === "create" || parsed.providerId !== providerId) {
    throw serviceError("INVALID_INPUT", 400, "Provider path and draft must match.");
  }
  const draft: RetainProviderDraft | ReplaceProviderDraft = parsed;
  const vault = vaultOrThrow();
  const normalized = normalizeDraftConnection(draft);
  const database = openDatabase(databasePath);

  try {
    return withTransaction(database, () => {
      const row = getProviderRow(database, providerId);
      if (!row) throw serviceError("PROVIDER_NOT_FOUND", 404, "Provider was not found.");
      if (row.version !== draft.expectedVersion) {
        throw serviceError("PROVIDER_CONFLICT", 409, "Provider version is stale.");
      }

      const connectionChanged =
        row.baseUrl !== normalized.baseUrl || row.defaultModel !== normalized.model;
      if ((draft.mode === "replace" || connectionChanged) && !validationToken) {
        throw serviceError("VALIDATION_REQUIRED", 409, "Provider verification is required.");
      }

      if (draft.mode === "retain") {
        let apiKey: string;
        try {
          apiKey = vault.decrypt(row.id, envelope(row));
          if (connectionChanged) {
            vault.verifyExistingToken(validationToken!, {
              apiKey,
              baseUrl: normalized.baseUrl,
              credentialGeneration: row.credentialGeneration,
              mode: "retain",
              model: normalized.model,
              providerId: row.id,
              providerVersion: row.version,
            });
          }
        } catch (error) {
          if (error instanceof CredentialVaultError) throw mapVaultError(error);
          throw error;
        }
        const timestamp = new Date().toISOString();
        database
          .prepare(`
            UPDATE providers
            SET name = ?, base_url = ?, default_model = ?, verified_at = ?,
                version = version + 1, updated_at = ?
            WHERE id = ? AND version = ?
          `)
          .run(
            draft.name,
            normalized.baseUrl,
            normalized.model,
            connectionChanged ? timestamp : row.verifiedAt,
            timestamp,
            row.id,
            row.version,
          );
      } else {
        try {
          vault.verifyExistingToken(validationToken!, {
            apiKey: draft.apiKey,
            baseUrl: normalized.baseUrl,
            credentialGeneration: row.credentialGeneration,
            mode: "replace",
            model: normalized.model,
            providerId: row.id,
            providerVersion: row.version,
          });
        } catch (error) {
          if (error instanceof CredentialVaultError) throw mapVaultError(error);
          throw error;
        }
        const credential = vault.encrypt(row.id, draft.apiKey);
        const timestamp = new Date().toISOString();
        database
          .prepare(`
            UPDATE providers
            SET name = ?, base_url = ?, default_model = ?,
                api_key_cipher = ?, api_key_iv = ?, api_key_tag = ?,
                credential_version = ?, credential_generation = credential_generation + 1,
                key_id = ?, api_key_mask = ?, verified_at = ?,
                version = version + 1, updated_at = ?
            WHERE id = ? AND version = ?
          `)
          .run(
            draft.name,
            normalized.baseUrl,
            normalized.model,
            credential.apiKeyCipher,
            credential.apiKeyIv,
            credential.apiKeyTag,
            credential.credentialVersion,
            credential.keyId,
            credential.apiKeyMask,
            timestamp,
            timestamp,
            row.id,
            row.version,
          );
      }
      return toProvider(getProviderRow(database, providerId)!, vault);
    });
  } finally {
    database.close();
  }
}

export function deleteProvider(providerId: string, databasePath: string): void {
  const database = openDatabase(databasePath);
  try {
    withTransaction(database, () => {
      if (!getProviderRow(database, providerId)) {
        throw serviceError("PROVIDER_NOT_FOUND", 404, "Provider was not found.");
      }
      if (isProviderInActiveCollaboration(database, providerId)) {
        throw serviceError(
          "COLLABORATION_ACTIVE",
          409,
          "A provider used by an active collaboration cannot be deleted.",
        );
      }
      database.prepare("DELETE FROM providers WHERE id = ?").run(providerId);
    });
  } finally {
    database.close();
  }
}
