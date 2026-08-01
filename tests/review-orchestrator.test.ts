import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ModelCallResult } from "@/src/shared/collaboration-contracts";

type OrchestratorModule = typeof import("../src/server/review/review-orchestrator");

const modules = import.meta.glob<OrchestratorModule>(
  "../src/server/review/review-orchestrator.ts",
);
const databases: DatabaseSync[] = [];
const NOW = new Date("2026-08-01T05:00:00.000Z");
const HASH = "a".repeat(64);

function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec(`
    CREATE TABLE review_operations(
      id TEXT NOT NULL, project_id TEXT NOT NULL, kind TEXT NOT NULL,
      parent_id TEXT NOT NULL, request_hash TEXT NOT NULL, status TEXT NOT NULL,
      http_status INTEGER, response_json TEXT, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, PRIMARY KEY(project_id,id)
    );
    CREATE TABLE review_attempts(
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, mission_id TEXT NOT NULL,
      work_item_id TEXT NOT NULL, result_id TEXT NOT NULL,
      reviewer_agent_id TEXT NOT NULL, operation_id TEXT NOT NULL,
      status TEXT NOT NULL, lease_token TEXT NOT NULL,
      lease_expires_at TEXT NOT NULL, frozen_material_json TEXT NOT NULL,
      frozen_material_hash TEXT NOT NULL, prompt_hash TEXT NOT NULL,
      provider_id TEXT NOT NULL, provider_version INTEGER NOT NULL,
      credential_generation INTEGER NOT NULL, verified_at TEXT NOT NULL,
      model TEXT NOT NULL, parsed_output_json TEXT, parsed_output_hash TEXT,
      output_checkpointed_at TEXT, finalize_error_code TEXT,
      error_category TEXT, started_at TEXT NOT NULL, finished_at TEXT
    );
    CREATE TABLE review_model_calls(
      id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL, kind TEXT NOT NULL,
      call_index INTEGER NOT NULL, status TEXT NOT NULL, prompt_hash TEXT NOT NULL,
      prompt_tokens INTEGER, completion_tokens INTEGER, total_tokens INTEGER,
      error_category TEXT, started_at TEXT NOT NULL, finished_at TEXT,
      UNIQUE(attempt_id,call_index)
    );
  `);
  return db;
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    attemptId: "attempt-1",
    credentialGeneration: 1,
    frozenMaterialHash: HASH,
    frozenMaterialJson: JSON.stringify({ sourceRefs: [] }),
    maxTokens: 100,
    missionId: "mission-1",
    model: "review-model",
    operationId: "00000000-0000-4000-8000-000000000001",
    parentId: "work-1",
    projectId: "project-1",
    promptHash: HASH,
    providerId: "provider-1",
    providerRequest: {
      apiKey: "secret",
      baseUrl: "https://provider.example/v1",
      messages: [{ role: "user" as const, content: "review" }],
      model: "review-model",
    },
    providerVersion: 1,
    request: { expectedHeadVersion: 1, resultId: "result-1", reviewerAgentId: "reviewer-1" },
    resultId: "result-1",
    reviewerAgentId: "reviewer-1",
    trustedTokens: 0,
    validationContext: {
      candidateActor: { agentId: "reviewer-1", type: "agent" as const },
      secretValues: ["secret"],
      sources: [],
    },
    verifiedAt: NOW.toISOString(),
    workItemId: "work-1",
    ...overrides,
  };
}

const validOutput = JSON.stringify({
  decision: { choice: "pass" },
  evidenceRefs: [],
  findings: [],
  limitations: [],
  memoryCandidates: [],
  publicSummary: "公开结论",
});

function success(
  content = validOutput,
  usage: ModelCallResult["usage"] = {
    completionTokens: 2,
    promptTokens: 3,
    totalTokens: 5,
  },
): ModelCallResult {
  return {
    content,
    error: null,
    httpStatus: 200,
    status: "succeeded",
    usage,
    usageReported: usage !== null,
  };
}

async function load(): Promise<OrchestratorModule> {
  const loader = modules["../src/server/review/review-orchestrator.ts"];
  expect(loader, "T-8 review orchestrator must exist").toBeTypeOf("function");
  return loader();
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe("review operation orchestration", () => {
  it("uses 90s calls, 30s heartbeats, and 120s leases with idempotent operation replay", async () => {
    const db = database();
    const callProvider = vi.fn().mockResolvedValue(success());
    const heartbeat = vi.fn();
    const scheduleHeartbeat = vi.fn((callback: () => void, milliseconds: number) => {
      heartbeat.mockImplementation(callback);
      return () => undefined;
    });
    const localFinalize = vi.fn().mockReturnValue(undefined);
    const { runReviewOperation } = await load();

    const first = await runReviewOperation(db, input(), {
      callProvider,
      clock: () => NOW,
      localFinalize,
      randomUUID: () => `id-${Math.random()}`,
      scheduleHeartbeat,
    });
    const replay = await runReviewOperation(db, input(), {
      callProvider,
      clock: () => NOW,
      localFinalize,
      randomUUID: () => `id-${Math.random()}`,
      scheduleHeartbeat,
    });

    expect(first).toMatchObject({
      state: "finalizing",
      retry: { kind: "local-finalize-only", providerCallRequired: false },
    });
    expect(replay).toEqual(first);
    expect(callProvider).toHaveBeenCalledTimes(1);
    expect(callProvider.mock.calls[0]?.[2]).toEqual({ timeoutMilliseconds: 90_000 });
    expect(scheduleHeartbeat).toHaveBeenCalledWith(expect.any(Function), 30_000);
    expect(db.prepare("SELECT lease_expires_at AS value FROM review_attempts").get())
      .toEqual({ value: "2026-08-01T05:02:00.000Z" });

    await expect(runReviewOperation(db, input({
      request: { expectedHeadVersion: 2, resultId: "result-1", reviewerAgentId: "reviewer-1" },
    }), {
      callProvider,
      clock: () => NOW,
      localFinalize,
      randomUUID: () => "unused",
      scheduleHeartbeat,
    })).rejects.toMatchObject({ code: "OPERATION_CONFLICT", status: 409 });
  });

  it("persists primary/repair calling and terminal rows with nullable reported usage", async () => {
    const db = database();
    const callProvider = vi.fn()
      .mockResolvedValueOnce(success('{"raw":"invalid"}'))
      .mockResolvedValueOnce(success());
    const { runReviewOperation } = await load();

    await runReviewOperation(db, input(), {
      callProvider,
      clock: () => NOW,
      randomUUID: (() => {
        let value = 0;
        return () => `id-${++value}`;
      })(),
    });

    expect(db.prepare(`
      SELECT kind,call_index AS callIndex,status,prompt_tokens AS promptTokens,
             completion_tokens AS completionTokens,total_tokens AS totalTokens
      FROM review_model_calls ORDER BY call_index
    `).all()).toEqual([
      {
        callIndex: 1,
        completionTokens: 2,
        kind: "primary",
        promptTokens: 3,
        status: "response_invalid",
        totalTokens: 5,
      },
      {
        callIndex: 2,
        completionTokens: 2,
        kind: "repair",
        promptTokens: 3,
        status: "succeeded",
        totalTokens: 5,
      },
    ]);
  });

  it("fails closed at token and provider boundaries and requires a new provider attempt", async () => {
    const { runReviewOperation } = await load();
    const blockedDb = database();
    const callProvider = vi.fn();

    await expect(runReviewOperation(blockedDb, input({ trustedTokens: 100 }), {
      callProvider,
      clock: () => NOW,
      randomUUID: () => "unused",
    })).rejects.toMatchObject({ code: "REVIEW_TOKEN_BOUNDARY", status: 409 });
    expect(callProvider).not.toHaveBeenCalled();

    const failedDb = database();
    callProvider.mockResolvedValueOnce({
      content: null,
      error: {
        category: "provider_timeout",
        code: "PROVIDER_TIMEOUT",
        correlationId: "correlation",
        httpStatus: 504,
      },
      httpStatus: null,
      status: "provider_failed",
      usage: null,
      usageReported: false,
    } satisfies ModelCallResult);
    const failed = await runReviewOperation(failedDb, input(), {
      callProvider,
      clock: () => NOW,
      randomUUID: () => "call-1",
    });

    expect(failed).toMatchObject({
      state: "failed",
      retry: { kind: "new-provider-attempt", providerCallRequired: true },
    });
    expect(failedDb.prepare(`
      SELECT status,prompt_tokens AS promptTokens,total_tokens AS totalTokens,error_category AS errorCategory
      FROM review_model_calls
    `).get()).toEqual({
      errorCategory: "provider_timeout",
      promptTokens: null,
      status: "provider_failed",
      totalTokens: null,
    });
  });
});
