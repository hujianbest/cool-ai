import type { DatabaseSync } from "node:sqlite";

import { CollaborationError } from "@/src/modules/public-collaboration";
import { createCredentialVault } from "@/src/modules/identity-capability/internal/credential-vault";
import { type CredentialEnvelope } from "@/src/modules/identity-capability";
import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import {
  classifyPublicText,
  type PublicTextCredentialCategory,
} from "@/src/modules/public-collaboration/internal/public-text-credential-classifier";

export {
  classifyPublicText,
} from "@/src/modules/public-collaboration/internal/public-text-credential-classifier";
export type {
  PublicTextCredentialCategory,
} from "@/src/modules/public-collaboration/internal/public-text-credential-classifier";

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
