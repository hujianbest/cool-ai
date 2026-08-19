import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createCredentialVault } from "@/src/modules/identity-capability/internal/credential-vault";
import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { appendRuntimeAuditOutboxRow } from "@/src/adapters/outbound/sqlite/runtime/audit-event-outbox";
import { runReviewOperation } from "@/src/adapters/outbound/sqlite/review-delivery/review-orchestrator";
import type { ModelCallResult } from "@/src/shared/collaboration-contracts";
import { memoryDatabasePath } from "@/tests/fixtures/sqlite/memory-database";

const NOW = "2026-08-15T01:00:00.000Z";
const MASTER_KEY = Buffer.alloc(32, 41).toString("base64url");
const PROJECT_ID = "runtime-audit-project";
const PROVIDER_ID = "runtime-audit-provider";
const API_KEY = "runtime-audit-secret-key";
const HASH = "a".repeat(64);

type OutboxRow = {
  eventType: string;
  payloadJson: string;
  seq: number;
  source: string;
};

let databasePath: string;
let database: DatabaseSync;

function seedPublicTextClassifier(): void {
  database.prepare(`
    INSERT INTO projects(id,name,created_at,version)
    VALUES (?,'Runtime audit',?,1)
  `).run(PROJECT_ID, NOW);
  const encrypted = createCredentialVault().encrypt(PROVIDER_ID, API_KEY);
  database.prepare(`
    INSERT INTO providers(
      id,name,base_url,default_model,api_key_cipher,api_key_iv,api_key_tag,
      credential_version,credential_generation,key_id,api_key_mask,verified_at,
      version,created_at,updated_at
    ) VALUES (?,'Runtime provider','https://provider.invalid/v1','runtime-model',
      ?,?,?,1,1,?,'****',?,1,?,?)
  `).run(
    PROVIDER_ID,
    encrypted.apiKeyCipher,
    encrypted.apiKeyIv,
    encrypted.apiKeyTag,
    encrypted.keyId,
    NOW,
    NOW,
    NOW,
  );
}

function runtimeRowsFrom(reader: DatabaseSync): OutboxRow[] {
  return reader.prepare(`
    SELECT source,event_type AS eventType,payload_json AS payloadJson,outbox_seq AS seq
    FROM audit_event_outbox WHERE source='runtime' ORDER BY outbox_seq
  `).all() as OutboxRow[];
}

function runtimeRows(path = databasePath): OutboxRow[] {
  const reader = openDatabase(path);
  try {
    return runtimeRowsFrom(reader);
  } finally {
    reader.close();
  }
}

function append(input: {
  eventType: "runtime_call_succeeded" | "runtime_call_failed";
  sourcePayload: Record<string, unknown>;
}): void {
  appendRuntimeAuditOutboxRow(database, {
    eventType: input.eventType,
    occurredAt: NOW,
    projectId: PROJECT_ID,
    sourcePayload: input.sourcePayload,
  });
}

beforeEach(() => {
  process.env.COCKPIT_MASTER_KEY = MASTER_KEY;
  databasePath = memoryDatabasePath();
  database = openDatabase(databasePath);
  seedPublicTextClassifier();
});

afterEach(() => {
  try {
    database.close();
  } catch {
    // Reopen tests may already have replaced the connection.
  }
  delete process.env.COCKPIT_MASTER_KEY;
});

describe("runtime audit outbox schema", () => {
  it("bootstraps identity 25 and accepts only the canonical runtime source", () => {
    expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 26 });
    database.prepare(`
      INSERT INTO audit_event_outbox(
        id,project_id,source,event_type,payload_json,occurred_at,outbox_seq
      ) VALUES ('runtime-schema',?,'runtime','runtime_call_succeeded','{}',?,1)
    `).run(PROJECT_ID, NOW);
    expect(database.prepare(
      "SELECT source FROM audit_event_outbox WHERE id='runtime-schema'",
    ).get()).toEqual({ source: "runtime" });
    expect(() => database.prepare(`
      INSERT INTO audit_event_outbox(
        id,project_id,source,event_type,payload_json,occurred_at,outbox_seq
      ) VALUES ('runtime-schema-invalid',?,'Runtime','runtime_call_succeeded','{}',?,2)
    `).run(PROJECT_ID, NOW)).toThrow();
  });
});

describe("runtime audit outbox payload discipline", () => {
  it("writes success and failure envelopes with only public navigation facts", () => {
    append({
      eventType: "runtime_call_succeeded",
      sourcePayload: {
        apiKey: API_KEY,
        baseUrl: "https://private-provider.invalid/v1",
        content: "raw provider response",
        executionId: "execution-1",
        messages: [{ role: "user", content: "private prompt" }],
        model: "runtime-model",
        rawProviderJson: { secret: true },
        surface: "execution",
        tokenCounts: { total: 7 },
      },
    });
    append({
      eventType: "runtime_call_failed",
      sourcePayload: {
        errorCategory: "provider_timeout",
        model: "runtime-model",
        reviewAttemptId: "review-attempt-1",
        surface: "review",
      },
    });

    const rows = runtimeRows();
    expect(rows.map((row) => row.eventType)).toEqual([
      "runtime_call_succeeded",
      "runtime_call_failed",
    ]);
    expect(rows.map((row) => row.seq)).toEqual([1, 2]);
    expect(JSON.parse(rows[0]!.payloadJson)).toEqual({
      actorId: null,
      actorType: "owner",
      executionId: "execution-1",
      model: "runtime-model",
      occurredAt: NOW,
      surface: "execution",
      type: "runtime_call_succeeded",
    });
    expect(JSON.parse(rows[1]!.payloadJson)).toEqual({
      actorId: null,
      actorType: "owner",
      errorCategory: "provider_timeout",
      model: "runtime-model",
      occurredAt: NOW,
      reviewAttemptId: "review-attempt-1",
      surface: "review",
      type: "runtime_call_failed",
    });
    expect(rows.map((row) => row.payloadJson).join("\n")).not.toMatch(
      /secret-key|private-provider|private prompt|raw provider response|tokenCounts/iu,
    );
  });

  it("drops invalid navigation ids and ignores invalid surfaces and event types", () => {
    append({
      eventType: "runtime_call_succeeded",
      sourcePayload: {
        executionId: "../execution",
        model: "runtime-model",
        runId: "run valid space",
        surface: "collaboration",
        threadId: "",
      },
    });
    append({
      eventType: "runtime_call_succeeded",
      sourcePayload: { model: "runtime-model", surface: "unknown" },
    });
    appendRuntimeAuditOutboxRow(database, {
      eventType: "runtime_call_retried",
      occurredAt: NOW,
      projectId: PROJECT_ID,
      sourcePayload: { model: "runtime-model", surface: "review" },
    });

    expect(runtimeRows().map((row) => JSON.parse(row.payloadJson))).toEqual([{
      actorId: null,
      actorType: "owner",
      model: "runtime-model",
      occurredAt: NOW,
      surface: "collaboration",
      type: "runtime_call_succeeded",
    }]);
  });

  it("truncates model names at 200 graphemes and redacts credential-like names", () => {
    append({
      eventType: "runtime_call_succeeded",
      sourcePayload: { model: "x".repeat(250), surface: "collaboration" },
    });
    append({
      eventType: "runtime_call_failed",
      sourcePayload: {
        errorCategory: "provider_auth",
        model: `model-${API_KEY}`,
        surface: "review",
      },
    });
    append({
      eventType: "runtime_call_succeeded",
      sourcePayload: {
        model: `${"prefix-".repeat(32)}${API_KEY}`,
        surface: "execution",
      },
    });

    const payloads = runtimeRows().map((row) => JSON.parse(row.payloadJson) as {
      model: string;
    });
    expect(payloads[0]!.model).toBe(`${"x".repeat(200)}…`);
    expect(Array.from(payloads[0]!.model)).toHaveLength(201);
    expect(payloads[1]!.model).toBe("[redacted]");
    expect(payloads[2]!.model).toBe("[redacted]");
    expect(payloads[2]!.model).not.toContain("prefix-");
  });
});

describe("runtime audit outbox transaction and sequence discipline", () => {
  it("shares a monotonic sequence while other sources remain filterable", () => {
    database.prepare(`
      INSERT INTO audit_event_outbox(
        id,project_id,source,event_type,payload_json,occurred_at,outbox_seq
      ) VALUES ('execution-source',?,'safe_execution','execution_started','{}',?,1)
    `).run(PROJECT_ID, NOW);
    append({
      eventType: "runtime_call_succeeded",
      sourcePayload: {
        model: "runtime-model",
        runId: "run-1",
        surface: "collaboration",
        threadId: "thread-1",
      },
    });

    expect(runtimeRows().map((row) => row.seq)).toEqual([2]);
    expect(database.prepare(`
      SELECT source,COUNT(*) AS count FROM audit_event_outbox GROUP BY source ORDER BY source
    `).all()).toEqual([
      { count: 1, source: "runtime" },
      { count: 1, source: "safe_execution" },
    ]);
  });

  it("reopens idempotently and continues the shared sequence", () => {
    append({
      eventType: "runtime_call_succeeded",
      sourcePayload: { model: "runtime-model", surface: "review" },
    });
    const before = runtimeRows();
    database.close();
    database = openDatabase(databasePath);
    append({
      eventType: "runtime_call_failed",
      sourcePayload: {
        errorCategory: "provider_unreachable",
        model: "runtime-model",
        surface: "review",
      },
    });

    expect(runtimeRows().map((row) => row.seq)).toEqual([
      before[0]!.seq,
      before[0]!.seq + 1,
    ]);
  });

  it("rolls the runtime row back with its surrounding domain transaction", () => {
    database.exec("BEGIN IMMEDIATE");
    append({
      eventType: "runtime_call_succeeded",
      sourcePayload: { model: "runtime-model", surface: "execution" },
    });
    database.exec("ROLLBACK");
    expect(runtimeRows()).toHaveLength(0);

    database.exec("BEGIN IMMEDIATE");
    append({
      eventType: "runtime_call_succeeded",
      sourcePayload: { model: "runtime-model", surface: "execution" },
    });
    database.exec("COMMIT");
    expect(runtimeRows()).toHaveLength(1);
  });
});

describe("runtime audit outbox model-call integration", () => {
  it("mirrors injected review provider success and failure beside their model-call rows", async () => {
    database.exec("PRAGMA foreign_keys=OFF");
    let sequence = 0;
    const randomUUID = () => `runtime-review-${++sequence}`;
    const input = (suffix: string) => ({
      attemptId: `attempt-${suffix}`,
      credentialGeneration: 1,
      frozenMaterialHash: HASH,
      frozenMaterialJson: JSON.stringify({ sourceRefs: [] }),
      maxTokens: 100,
      missionId: "mission-runtime",
      model: "runtime-model",
      operationId: `00000000-0000-4000-8000-0000000000${suffix}`,
      parentId: "work-runtime",
      projectId: PROJECT_ID,
      promptHash: HASH,
      providerId: PROVIDER_ID,
      providerRequest: {
        apiKey: API_KEY,
        baseUrl: "https://provider.invalid/v1",
        messages: [{ content: "private review prompt", role: "user" as const }],
        model: "runtime-model",
      },
      providerVersion: 1,
      request: { expectedHeadVersion: 1, resultId: `result-${suffix}` },
      resultId: `result-${suffix}`,
      reviewerAgentId: "reviewer-runtime",
      trustedTokens: 0,
      validationContext: {
        candidateActor: { agentId: "reviewer-runtime", type: "agent" as const },
        secretValues: [API_KEY],
        sources: [],
      },
      verifiedAt: NOW,
      workItemId: "work-runtime",
    });
    const succeeded: ModelCallResult = {
      content: JSON.stringify({
        decision: { choice: "pass" },
        evidenceRefs: [],
        findings: [],
        limitations: [],
        memoryCandidates: [],
        publicSummary: "Public review",
      }),
      error: null,
      httpStatus: 200,
      status: "succeeded",
      usage: { completionTokens: 2, promptTokens: 3, totalTokens: 5 },
      usageReported: true,
    };
    const failed: ModelCallResult = {
      content: null,
      error: {
        category: "provider_timeout",
        code: "PROVIDER_TIMEOUT",
        correlationId: "runtime-correlation",
        httpStatus: 504,
      },
      httpStatus: null,
      status: "provider_failed",
      usage: null,
      usageReported: false,
    };

    await runReviewOperation(database, input("01"), {
      callProvider: async () => succeeded,
      clock: () => new Date(NOW),
      localFinalize: () => undefined,
      randomUUID,
    });
    await runReviewOperation(database, input("02"), {
      callProvider: async () => failed,
      clock: () => new Date(NOW),
      randomUUID,
    });

    expect(database.prepare(`
      SELECT status,error_category AS errorCategory
      FROM review_model_calls ORDER BY started_at,id
    `).all()).toEqual([
      { errorCategory: null, status: "succeeded" },
      { errorCategory: "provider_timeout", status: "provider_failed" },
    ]);
    expect(runtimeRowsFrom(database).map((row) => ({
      eventType: row.eventType,
      payload: JSON.parse(row.payloadJson),
    }))).toEqual([
      {
        eventType: "runtime_call_succeeded",
        payload: {
          actorId: null,
          actorType: "owner",
          model: "runtime-model",
          occurredAt: NOW,
          reviewAttemptId: "attempt-01",
          surface: "review",
          type: "runtime_call_succeeded",
        },
      },
      {
        eventType: "runtime_call_failed",
        payload: {
          actorId: null,
          actorType: "owner",
          errorCategory: "provider_timeout",
          model: "runtime-model",
          occurredAt: NOW,
          reviewAttemptId: "attempt-02",
          surface: "review",
          type: "runtime_call_failed",
        },
      },
    ]);
  });
});
