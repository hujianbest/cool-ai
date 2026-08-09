import type { DatabaseSync } from "node:sqlite";

import { CollaborationError } from "@/src/server/collaboration/collaboration-errors";
import {
  createCredentialVault,
  type CredentialEnvelope,
} from "@/src/server/credential-vault";
import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";

export type PublicTextCredentialCategory =
  | "configured_provider_key"
  | "private_key"
  | "authorization_header"
  | "credential_field";

const PLACEHOLDER = /^(?:\*{3}|<redacted>|\$\{[A-Za-z_][A-Za-z0-9_]*\})$/i;
const PRIVATE_KEY_BLOCK =
  /-----BEGIN (?:(?:RSA|EC|DSA|OPENSSH) )?PRIVATE KEY-----[\s\S]*?-----END (?:(?:RSA|EC|DSA|OPENSSH) )?PRIVATE KEY-----/i;
const AUTHORIZATION_LINE =
  /^[\t ]*authorization[\t ]*:[\t ]*(?:basic|bearer)[\t ]+([^\r\n]+?)[\t ]*$/gim;
const CREDENTIAL_FIELD =
  /(?:^|[\s{[,;])["']?(?:api-key|api_key|apikey|token|secret|password)["']?[\t ]*(?::|=)[\t ]*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|(\$\{[A-Za-z_][A-Za-z0-9_]*\}|[^\s,;}\]\r\n]+))/gim;

function isPlaceholder(value: string): boolean {
  const trimmed = value.trim();
  const unquoted =
    trimmed.length >= 2
    && ((trimmed.startsWith("\"") && trimmed.endsWith("\""))
      || (trimmed.startsWith("'") && trimmed.endsWith("'")))
      ? trimmed.slice(1, -1).trim()
      : trimmed;
  return PLACEHOLDER.test(unquoted);
}

type ProviderCredentialRow = {
  id: string;
  apiKeyCipher: string;
  apiKeyIv: string;
  apiKeyMask: string;
  apiKeyTag: string;
  credentialVersion: number;
  keyId: string;
};

function providerRows(database: DatabaseSync): ProviderCredentialRow[] {
  return database.prepare(
    `SELECT id,api_key_cipher AS apiKeyCipher,api_key_iv AS apiKeyIv,
            api_key_mask AS apiKeyMask,api_key_tag AS apiKeyTag,
            credential_version AS credentialVersion,key_id AS keyId
     FROM providers`,
  ).all() as ProviderCredentialRow[];
}

function unavailable(): never {
  throw new CollaborationError(
    "CREDENTIAL_UNAVAILABLE",
    503,
    "Provider credentials are unavailable.",
    { category: "credential_unavailable" },
  );
}

function configuredProviderKeys(databasePath: string): string[] {
  const database = openDatabase(databasePath);
  try {
    const rows = providerRows(database);
    if (rows.length === 0) return [];
    let vault: ReturnType<typeof createCredentialVault>;
    try {
      vault = createCredentialVault();
    } catch {
      return unavailable();
    }
    return rows.map((row) => {
      const envelope: CredentialEnvelope = {
        apiKeyCipher: row.apiKeyCipher,
        apiKeyIv: row.apiKeyIv,
        apiKeyMask: row.apiKeyMask,
        apiKeyTag: row.apiKeyTag,
        credentialVersion: row.credentialVersion as 1,
        keyId: row.keyId,
      };
      try {
        return vault.decrypt(row.id, envelope);
      } catch {
        return unavailable();
      }
    });
  } finally {
    database.close();
  }
}

export function classifyPublicText(
  text: string,
  configuredKeys: readonly string[],
): PublicTextCredentialCategory | null {
  if (configuredKeys.some((key) => key.length > 0 && text.includes(key))) {
    return "configured_provider_key";
  }
  if (PRIVATE_KEY_BLOCK.test(text)) return "private_key";
  AUTHORIZATION_LINE.lastIndex = 0;
  for (const match of text.matchAll(AUTHORIZATION_LINE)) {
    const value = match[1].trim();
    if (value && !isPlaceholder(value)) return "authorization_header";
  }
  CREDENTIAL_FIELD.lastIndex = 0;
  for (const match of text.matchAll(CREDENTIAL_FIELD)) {
    const value = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (value && !isPlaceholder(value)) return "credential_field";
  }
  return null;
}

export function assertPublicTextHasNoCredentials(databasePath: string, text: string): void {
  const category = classifyPublicTextFromDatabase(databasePath, text);
  if (!category) return;
  throw new CollaborationError(
    "CREDENTIAL_CONTENT_REJECTED",
    422,
    "Public text contains credential-like content.",
    { category },
  );
}

export function classifyPublicTextFromDatabase(
  databasePath: string,
  text: string,
): PublicTextCredentialCategory | null {
  return classifyPublicText(text, configuredProviderKeys(databasePath));
}

export function classifyPublicTextFromDatabaseConnection(
  database: DatabaseSync,
  text: string,
): PublicTextCredentialCategory | null {
  let rows: ProviderCredentialRow[];
  try {
    rows = providerRows(database);
  } catch {
    return classifyPublicText(text, []);
  }
  if (rows.length === 0) return classifyPublicText(text, []);
  let vault: ReturnType<typeof createCredentialVault>;
  try {
    vault = createCredentialVault();
  } catch {
    return unavailable();
  }
  const keys = rows.map((row) => {
    try {
      return vault.decrypt(row.id, {
        apiKeyCipher: row.apiKeyCipher,
        apiKeyIv: row.apiKeyIv,
        apiKeyMask: row.apiKeyMask,
        apiKeyTag: row.apiKeyTag,
        credentialVersion: row.credentialVersion as 1,
        keyId: row.keyId,
      });
    } catch {
      return unavailable();
    }
  });
  return classifyPublicText(text, keys);
}
