import { randomUUID } from "node:crypto";

import {
  CollaborationError,
} from "@/src/modules/public-collaboration";
import {
  acquireAdvance,
  finalizeAdvance,
  type ProjectThreadRunTuple,
} from "@/src/adapters/outbound/sqlite/public-collaboration/turn-orchestrator";
import {
  executeStructuredTurn,
  type StructuredTurnResult,
} from "@/src/modules/public-collaboration/internal/structured-repair";
import { classifyPublicTextFromDatabase } from "@/src/adapters/outbound/sqlite/public-collaboration/public-text-credential-classifier";
import { createCredentialVault } from "@/src/modules/identity-capability/internal/credential-vault";
import {
  CredentialVaultError,
  type CredentialEnvelope,
} from "@/src/modules/identity-capability";
import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";

type ProviderConnectionRow = {
  agentId: string;
  apiKeyCipher: string;
  apiKeyIv: string;
  apiKeyMask: string;
  apiKeyTag: string;
  baseUrl: string;
  credentialVersion: number;
  keyId: string;
  model: string;
  providerId: string;
  verifiedAt: string | null;
};

export type AdvanceExecutionResponse = {
  body: unknown;
  status: number;
};

const noCallFailure: StructuredTurnResult = {
  calls: [],
  pauseCategory: null,
  status: "provider_failed",
  turn: null,
  usage: [],
};

function providerConnection(
  databasePath: string,
  agentId: string,
): { apiKey: string; baseUrl: string; model: string } {
  const database = openDatabase(databasePath);
  let row: ProviderConnectionRow | undefined;
  try {
    row = database
      .prepare(
        `SELECT agents.id AS agentId, agents.model,
                providers.id AS providerId, providers.base_url AS baseUrl,
                providers.api_key_cipher AS apiKeyCipher,
                providers.api_key_iv AS apiKeyIv,
                providers.api_key_tag AS apiKeyTag,
                providers.credential_version AS credentialVersion,
                providers.key_id AS keyId,
                providers.api_key_mask AS apiKeyMask,
                providers.verified_at AS verifiedAt
         FROM agents
         JOIN providers ON providers.id = agents.provider_id
         WHERE agents.id = ?`,
      )
      .get(agentId) as ProviderConnectionRow | undefined;
  } finally {
    database.close();
  }
  if (!row) {
    throw new CollaborationError("AGENT_NOT_FOUND", 404, "Current Agent was not found.");
  }
  if (!row.verifiedAt) {
    throw new CollaborationError(
      "CREDENTIAL_UNAVAILABLE",
      503,
      "Provider credential is unavailable.",
      { category: "credential_unavailable" },
    );
  }
  const envelope: CredentialEnvelope = {
    apiKeyCipher: row.apiKeyCipher,
    apiKeyIv: row.apiKeyIv,
    apiKeyMask: row.apiKeyMask,
    apiKeyTag: row.apiKeyTag,
    credentialVersion: row.credentialVersion as 1,
    keyId: row.keyId,
  };
  try {
    return {
      apiKey: createCredentialVault().decrypt(row.providerId, envelope),
      baseUrl: row.baseUrl,
      model: row.model,
    };
  } catch (error) {
    if (error instanceof CredentialVaultError) {
      throw new CollaborationError(
        "CREDENTIAL_UNAVAILABLE",
        503,
        "Provider credential is unavailable.",
        { category: "credential_unavailable" },
      );
    }
    throw error;
  }
}

function sanitizedInternalError(correlationId: string): CollaborationError {
  console.error({
    code: "INTERNAL_ERROR",
    correlationId,
    route: "POST /api/projects/:projectId/threads/:threadId/runs/:runId/advance",
  });
  return new CollaborationError(
    "INTERNAL_ERROR",
    500,
    "An unexpected error occurred.",
    { category: "internal_failure" },
  );
}

export async function executeAdvance(
  databasePath: string,
  tuple: ProjectThreadRunTuple,
  input: unknown,
): Promise<AdvanceExecutionResponse> {
  const dependencies = {
    clock: () => new Date(),
    randomUUID,
  };
  const acquired = acquireAdvance(databasePath, tuple, input, dependencies);
  if (acquired.kind === "replayed") {
    return { body: acquired.body, status: acquired.status };
  }
  if (acquired.kind === "paused") {
    return { body: acquired, status: 200 };
  }

  const correlationId = randomUUID();
  let result: StructuredTurnResult;
  let preflightError: CollaborationError | undefined;
  try {
    const connection = providerConnection(databasePath, acquired.prompt.agentId);
    result = await executeStructuredTurn(
      {
        ...connection,
        messages: acquired.prompt.messages,
      },
      {
        attemptId: acquired.attempt.id,
        correlationId,
        runId: tuple.runId,
      },
      (content) => classifyPublicTextFromDatabase(databasePath, content),
    );
  } catch (error) {
    result = noCallFailure;
    preflightError =
      error instanceof CollaborationError ? error : sanitizedInternalError(correlationId);
  }

  const finalized = finalizeAdvance(
    databasePath,
    tuple,
    {
      attemptId: acquired.attempt.id,
      leaseToken: acquired.attempt.leaseToken,
      preflightError,
      result,
    },
    dependencies,
  );
  return { body: finalized.body, status: finalized.status };
}
