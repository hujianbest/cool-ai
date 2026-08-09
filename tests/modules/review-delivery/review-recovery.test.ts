import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ModelCallResult } from "@/src/shared/collaboration-contracts";

type OrchestratorModule = typeof import("../../../src/adapters/outbound/sqlite/review-delivery/review-orchestrator");
const modules = import.meta.glob<OrchestratorModule>(
  "../../../src/adapters/outbound/sqlite/review-delivery/review-orchestrator.ts",
);
const directories: string[] = [];
const NOW = new Date("2026-08-01T06:00:00.000Z");
const HASH = "b".repeat(64);

function openFixture(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS review_operations(
      id TEXT NOT NULL, project_id TEXT NOT NULL, kind TEXT NOT NULL,
      parent_id TEXT NOT NULL, request_hash TEXT NOT NULL, status TEXT NOT NULL,
      http_status INTEGER, response_json TEXT, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, PRIMARY KEY(project_id,id)
    );
    CREATE TABLE IF NOT EXISTS review_attempts(
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
    CREATE TABLE IF NOT EXISTS review_model_calls(
      id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL, kind TEXT NOT NULL,
      call_index INTEGER NOT NULL, status TEXT NOT NULL, prompt_hash TEXT NOT NULL,
      prompt_tokens INTEGER, completion_tokens INTEGER, total_tokens INTEGER,
      error_category TEXT, started_at TEXT NOT NULL, finished_at TEXT,
      UNIQUE(attempt_id,call_index)
    );
  `);
  return db;
}

function operationInput(
  operationId = "00000000-0000-4000-8000-000000000001",
  attemptId = "attempt-1",
  retryOfAttemptId: string | null = null,
) {
  return {
    attemptId,
    credentialGeneration: 1,
    frozenMaterialHash: HASH,
    frozenMaterialJson: JSON.stringify({ sourceRefs: [] }),
    maxTokens: 100,
    missionId: "mission-1",
    model: "review-model",
    operationId,
    parentId: "work-1",
    projectId: "project-1",
    promptHash: HASH,
    providerId: "provider-1",
    providerRequest: {
      apiKey: "top-secret",
      baseUrl: "https://provider.example/v1",
      messages: [{ role: "user" as const, content: "review" }],
      model: "review-model",
    },
    providerVersion: 1,
    request: { expectedHeadVersion: 1, resultId: "result-1", reviewerAgentId: "reviewer-1" },
    resultId: "result-1",
    retryOfAttemptId,
    reviewerAgentId: "reviewer-1",
    trustedTokens: 0,
    validationContext: {
      candidateActor: { agentId: "reviewer-1", type: "agent" as const },
      secretValues: ["top-secret"],
      sources: [],
    },
    verifiedAt: NOW.toISOString(),
    workItemId: "work-1",
  };
}

const publicOutput = JSON.stringify({
  decision: { choice: "pass" },
  evidenceRefs: [],
  findings: [],
  limitations: [],
  memoryCandidates: [],
  publicSummary: "仅公开结论",
});

function result(content: string, totalTokens = 5): ModelCallResult {
  return {
    content,
    error: null,
    httpStatus: 200,
    status: "succeeded",
    usage: {
      completionTokens: 2,
      promptTokens: totalTokens - 2,
      totalTokens,
    },
    usageReported: true,
  };
}

async function load(): Promise<OrchestratorModule> {
  const loader = modules["../../../src/adapters/outbound/sqlite/review-delivery/review-orchestrator.ts"];
  expect(loader, "T-8 recovery orchestrator must exist").toBeTypeOf("function");
  return loader();
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("durable review output recovery", () => {
  it("stores only canonical public output after strict parse/redaction", async () => {
    const directory = mkdtempSync(join(tmpdir(), "review-recovery-"));
    directories.push(directory);
    const db = openFixture(join(directory, "review.db"));
    const raw = '{"raw":"RAW_COT_SENTINEL chain-of-thought top-secret"}';
    const callProvider = vi.fn()
      .mockResolvedValueOnce(result(raw))
      .mockResolvedValueOnce(result(publicOutput, 7));
    const { runReviewOperation } = await load();

    await runReviewOperation(db, operationInput(), {
      callProvider,
      clock: () => NOW,
      randomUUID: (() => {
        let value = 0;
        return () => `id-${++value}`;
      })(),
    });

    const durable = JSON.stringify(db.prepare(`
      SELECT a.status,a.parsed_output_json AS output,a.parsed_output_hash AS hash,
             c.kind,c.status AS callStatus,c.error_category AS errorCategory
      FROM review_attempts a JOIN review_model_calls c ON c.attempt_id=a.id
      ORDER BY c.call_index
    `).all());
    expect(durable).not.toMatch(/RAW_COT_SENTINEL|chain-of-thought|top-secret/iu);
    const attempt = db.prepare(`
      SELECT status,parsed_output_json AS output,parsed_output_hash AS hash
      FROM review_attempts
    `).get() as { hash: string; output: string; status: string };
    expect(attempt.status).toBe("finalizing");
    expect(JSON.parse(attempt.output)).toMatchObject({
      decision: { choice: "pass" },
      publicSummary: "仅公开结论",
    });
    expect(attempt.hash).toMatch(/^[0-9a-f]{64}$/u);
    db.close();
  });

  it("restarts after a post-checkpoint SQLite finalize fault and replays only local finalize", async () => {
    const directory = mkdtempSync(join(tmpdir(), "review-restart-"));
    directories.push(directory);
    const path = join(directory, "review.db");
    let db = openFixture(path);
    const callProvider = vi.fn().mockResolvedValue(result(publicOutput));
    const localFinalize = vi.fn()
      .mockImplementationOnce(() => {
        throw new Error("SQLITE_BUSY_AFTER_CHECKPOINT");
      })
      .mockImplementationOnce(() => undefined);
    const { runReviewOperation } = await load();

    const first = await runReviewOperation(db, operationInput(), {
      callProvider,
      clock: () => NOW,
      localFinalize,
      randomUUID: () => "call-1",
    });
    expect(first).toMatchObject({
      state: "finalizing",
      retry: { kind: "local-finalize-only", providerCallRequired: false },
    });
    db.close();

    db = openFixture(path);
    const replay = await runReviewOperation(db, operationInput(), {
      callProvider,
      clock: () => NOW,
      localFinalize,
      randomUUID: () => "must-not-be-used",
    });
    expect(replay).toEqual(first);
    expect(callProvider).toHaveBeenCalledTimes(1);
    expect(localFinalize).toHaveBeenCalledTimes(2);
    expect(db.prepare("SELECT COUNT(*) AS count FROM review_model_calls").get())
      .toEqual({ count: 1 });
    db.close();
  });

  it("requires an explicit new operation and attempt before another provider call", async () => {
    const db = openFixture(":memory:");
    const providerFailure: ModelCallResult = {
      content: null,
      error: {
        category: "provider_unreachable",
        code: "PROVIDER_UNREACHABLE",
        correlationId: "correlation",
        httpStatus: 502,
      },
      httpStatus: null,
      status: "provider_failed",
      usage: null,
      usageReported: false,
    };
    const callProvider = vi.fn()
      .mockResolvedValueOnce(providerFailure)
      .mockResolvedValueOnce(result(publicOutput));
    const { runReviewOperation } = await load();
    const dependencies = {
      callProvider,
      clock: () => NOW,
      randomUUID: (() => {
        let value = 0;
        return () => `id-${++value}`;
      })(),
    };

    const failed = await runReviewOperation(db, operationInput(), dependencies);
    await runReviewOperation(db, operationInput(), dependencies);
    expect(callProvider).toHaveBeenCalledTimes(1);
    expect(failed).toMatchObject({
      retry: { kind: "new-provider-attempt", providerCallRequired: true },
    });

    await runReviewOperation(
      db,
      operationInput(
        "00000000-0000-4000-8000-000000000002",
        "attempt-2",
        "attempt-1",
      ),
      dependencies,
    );
    expect(callProvider).toHaveBeenCalledTimes(2);
    expect(db.prepare("SELECT status FROM review_attempts ORDER BY started_at,id").all())
      .toEqual([{ status: "failed" }, { status: "finalizing" }]);
    db.close();
  });
});
