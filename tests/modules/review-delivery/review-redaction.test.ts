import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ModelCallResult } from "@/src/shared/collaboration-contracts";

type ReviewSchemaModule = typeof import("../../../src/adapters/outbound/sqlite/review-delivery/review-schema");
type ReviewOrchestratorModule = typeof import("../../../src/adapters/outbound/sqlite/review-delivery/review-orchestrator");

const schemaModules = import.meta.glob<ReviewSchemaModule>(
  "../../../src/adapters/outbound/sqlite/review-delivery/review-schema.ts",
);
const orchestratorModules = import.meta.glob<ReviewOrchestratorModule>(
  "../../../src/adapters/outbound/sqlite/review-delivery/review-orchestrator.ts",
);
const databases: DatabaseSync[] = [];
const NOW = new Date("2026-08-01T06:00:00.000Z");
const HASH = "a".repeat(64);

function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec(`
    CREATE TABLE review_operations(
      id TEXT NOT NULL,project_id TEXT NOT NULL,kind TEXT NOT NULL,parent_id TEXT NOT NULL,
      request_hash TEXT NOT NULL,status TEXT NOT NULL,http_status INTEGER,response_json TEXT,
      created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(project_id,id)
    );
    CREATE TABLE review_attempts(
      id TEXT PRIMARY KEY,project_id TEXT NOT NULL,mission_id TEXT NOT NULL,
      work_item_id TEXT NOT NULL,result_id TEXT NOT NULL,reviewer_agent_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,status TEXT NOT NULL,lease_token TEXT NOT NULL,
      lease_expires_at TEXT NOT NULL,frozen_material_json TEXT NOT NULL,
      frozen_material_hash TEXT NOT NULL,prompt_hash TEXT NOT NULL,provider_id TEXT NOT NULL,
      provider_version INTEGER NOT NULL,credential_generation INTEGER NOT NULL,
      verified_at TEXT NOT NULL,model TEXT NOT NULL,parsed_output_json TEXT,
      parsed_output_hash TEXT,output_checkpointed_at TEXT,finalize_error_code TEXT,
      error_category TEXT,started_at TEXT NOT NULL,finished_at TEXT
    );
    CREATE TABLE review_model_calls(
      id TEXT PRIMARY KEY,attempt_id TEXT NOT NULL,kind TEXT NOT NULL,call_index INTEGER NOT NULL,
      status TEXT NOT NULL,prompt_hash TEXT NOT NULL,prompt_tokens INTEGER,
      completion_tokens INTEGER,total_tokens INTEGER,error_category TEXT,
      started_at TEXT NOT NULL,finished_at TEXT,UNIQUE(attempt_id,call_index)
    );
    CREATE TABLE review_decisions(id TEXT PRIMARY KEY);
  `);
  return db;
}

function operationInput() {
  return {
    attemptId: "attempt-redaction",
    credentialGeneration: 1,
    frozenMaterialHash: HASH,
    frozenMaterialJson: JSON.stringify({ sourceRefs: [] }),
    maxTokens: 100,
    missionId: "mission-1",
    model: "review-model",
    operationId: "00000000-0000-4000-8000-000000000017",
    parentId: "work-1",
    projectId: "project-1",
    promptHash: HASH,
    providerId: "provider-reviewer",
    providerRequest: {
      apiKey: "reviewer-private-api-key",
      baseUrl: "https://reviewer.example/v1",
      messages: [{ role: "user" as const, content: "review public material" }],
      model: "review-model",
    },
    providerVersion: 1,
    request: { expectedHeadVersion: 1, reviewerAgentId: "reviewer-1" },
    resultId: "result-1",
    reviewerAgentId: "reviewer-1",
    trustedTokens: 0,
    validationContext: {
      candidateActor: { agentId: "reviewer-1", type: "agent" as const },
      secretValues: ["reviewer-private-api-key"],
      sources: [],
    },
    verifiedAt: NOW.toISOString(),
    workItemId: "work-1",
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) db.close();
});

describe("review product-domain redaction", () => {
  it("builds provider egress from only the selected reviewer private config and allowlisted public material", async () => {
    const load = schemaModules["../../../src/adapters/outbound/sqlite/review-delivery/review-schema.ts"];
    expect(load).toBeTypeOf("function");
    const module = await load();
    const build = (module as unknown as Record<string, unknown>).buildReviewProviderRequest;

    expect(build, "T-17 provider egress builder must exist").toBeTypeOf("function");
    const request = (build as (input: unknown) => unknown)({
      material: {
        schemaVersion: 1,
        task: { id: "task-1", title: "PUBLIC_MATERIAL_SENTINEL", version: 3 },
      },
      otherAgents: [{
        id: "other-agent",
        systemPrompt: "OTHER_AGENT_PRIVATE_PROMPT",
      }],
      ownerPrivatePrompt: "OWNER_PRIVATE_PROMPT",
      reviewer: {
        id: "reviewer-1",
        role: "REVIEWER_PRIVATE_ROLE",
        skills: ["REVIEWER_PRIVATE_SKILL"],
        systemPrompt: "REVIEWER_PRIVATE_PROMPT",
      },
    });
    const serialized = JSON.stringify(request);

    expect(serialized).toContain("PUBLIC_MATERIAL_SENTINEL");
    expect(serialized).toContain("REVIEWER_PRIVATE_ROLE");
    expect(serialized).toContain("REVIEWER_PRIVATE_SKILL");
    expect(serialized).toContain("REVIEWER_PRIVATE_PROMPT");
    expect(serialized).not.toMatch(/OTHER_AGENT_PRIVATE_PROMPT|OWNER_PRIVATE_PROMPT/u);
  });

  it.each([
    "api_key=KEY_SENTINEL",
    "Authorization: Bearer AUTH_SENTINEL",
    "master_key=MASTER_SENTINEL",
    "cipher=CIPHER_SENTINEL",
    "validation_token=TOKEN_SENTINEL",
    "raw provider body: RAW_BODY_SENTINEL",
    "HOME=C:\\Users\\secret-user",
    "D:\\private\\host\\database.sqlite",
    "/home/private-user/project",
    "other agent system prompt: OTHER_PROMPT_SENTINEL",
    "chain-of-thought: COT_SENTINEL",
  ])("classifies forbidden public text before persistence: %s", async (sentinel) => {
    const load = schemaModules["../../../src/adapters/outbound/sqlite/review-delivery/review-schema.ts"];
    expect(load).toBeTypeOf("function");
    const module = await load();
    const inspect = (module as unknown as Record<string, unknown>).reviewPublicValueIsSafe;

    expect(inspect, "T-17 product-domain scanner must exist").toBeTypeOf("function");
    expect((inspect as (value: unknown) => boolean)({ publicSummary: sentinel })).toBe(false);
  });

  it("fails closed on redaction failure and writes no decision", async () => {
    const db = database();
    const load = orchestratorModules["../../../src/adapters/outbound/sqlite/review-delivery/review-orchestrator.ts"];
    expect(load).toBeTypeOf("function");
    const { runReviewOperation } = await load();
    const providerResult: ModelCallResult = {
      content: JSON.stringify({
        decision: { choice: "pass" },
        evidenceRefs: [],
        findings: [],
        limitations: [],
        memoryCandidates: [],
        publicSummary: "raw provider body: RAW_BODY_SENTINEL",
      }),
      error: null,
      httpStatus: 200,
      status: "succeeded",
      usage: { completionTokens: 2, promptTokens: 3, totalTokens: 5 },
      usageReported: true,
    };
    const callProvider = vi.fn().mockResolvedValue(providerResult);

    const result = await runReviewOperation(db, operationInput(), {
      callProvider,
      clock: () => NOW,
      randomUUID: () => "redaction-id",
    });

    expect(result).toMatchObject({ errorCategory: "redaction", state: "failed" });
    expect(callProvider).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT COUNT(*) AS count FROM review_decisions").get())
      .toEqual({ count: 0 });
    expect(JSON.stringify(db.prepare("SELECT * FROM review_attempts").all()))
      .not.toMatch(/RAW_BODY_SENTINEL/u);
  });
});
