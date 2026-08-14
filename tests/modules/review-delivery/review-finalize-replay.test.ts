import { createHash } from "node:crypto";

import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import type { ModelCallResult } from "@/src/shared/collaboration-contracts";
import { memoryDatabasePath } from "@/tests/fixtures/sqlite/memory-database";

type FinalizeStep =
  | "decision"
  | "memory-candidates"
  | "head"
  | "board"
  | "events"
  | "attempt"
  | "receipt";

type OrchestratorModule = typeof import("../../../src/adapters/outbound/sqlite/review-delivery/review-orchestrator");
const modules = import.meta.glob<OrchestratorModule>(
  "../../../src/adapters/outbound/sqlite/review-delivery/review-orchestrator.ts",
);
const databases: DatabaseSync[] = [];
const NOW = new Date("2026-08-01T08:00:00.000Z");
const HASH = "d".repeat(64);

function databasePath(): string {
  return memoryDatabasePath();
}

function seed(path: string): DatabaseSync {
  const database = openDatabase(path);
  databases.push(database);
  database.exec("PRAGMA foreign_keys=OFF");
  database.exec(`
    INSERT INTO projects(id,name,created_at,version)
    VALUES ('project','Finalize replay','${NOW.toISOString()}',1);
    INSERT INTO providers(
      id,name,base_url,default_model,api_key_cipher,api_key_iv,api_key_tag,
      credential_version,credential_generation,key_id,api_key_mask,verified_at,
      version,created_at,updated_at
    ) VALUES ('provider','Provider','https://provider.invalid/v1','model',
      'cipher','iv','tag',1,1,'key','mask','${NOW.toISOString()}',1,
      '${NOW.toISOString()}','${NOW.toISOString()}');
    INSERT INTO agents(
      id,name,role,system_prompt,provider_id,model,avatar_text,accent_token,
      can_read,can_write,can_execute,max_tokens,max_handoffs,version,
      created_at,updated_at,review_capable
    ) VALUES
      ('executor','Executor','Builder','Build','provider','model','E','sage',
       1,1,1,1000,2,1,'${NOW.toISOString()}','${NOW.toISOString()}',0),
      ('reviewer','Reviewer','Review','Review','provider','model','R','slate',
       1,0,0,1000,2,1,'${NOW.toISOString()}','${NOW.toISOString()}',1);
    INSERT INTO project_memberships(project_id,agent_id,joined_at)
    VALUES ('project','executor','${NOW.toISOString()}'),
           ('project','reviewer','${NOW.toISOString()}');
    INSERT INTO missions(id,project_id,title,goal,version,created_at,updated_at)
    VALUES ('mission','project','Mission','Goal',1,'${NOW.toISOString()}','${NOW.toISOString()}');
    INSERT INTO work_items(
      id,mission_id,title,description,status,assignee_agent_id,version,created_at,updated_at,
      lease_token,lease_expires_at,last_heartbeat_at
    ) VALUES ('work','mission','Work','','in_progress','executor',1,
      '${NOW.toISOString()}','${NOW.toISOString()}','work-lease','2099-01-01T00:00:00.000Z','${NOW.toISOString()}');
    INSERT INTO work_item_result_versions(
      id,project_id,mission_id,work_item_id,version,execution_id,staged_result_id,
      merge_journal_id,supersedes_result_id,executor_agent_id,created_at
    ) VALUES ('result','project','mission','work',1,'execution','staged','journal',
      NULL,'executor','${NOW.toISOString()}');
    INSERT INTO work_item_review_heads(
      work_item_id,project_id,mission_id,current_result_id,current_attempt_id,
      state,version,updated_at
    ) VALUES ('work','project','mission','result','attempt','reviewing',1,'${NOW.toISOString()}');
    INSERT INTO mission_delivery_heads(
      mission_id,project_id,context_version,state,current_delivery_id,current_operation_id,
      generation_lease_token,generation_lease_expires_at,last_error_code,
      next_event_sequence,version,updated_at
    ) VALUES ('mission','project',1,'ongoing',NULL,NULL,NULL,NULL,NULL,2,1,'${NOW.toISOString()}');
    INSERT INTO review_events(
      id,project_id,mission_id,sequence,type,actor_type,actor_id,payload_json,created_at
    ) VALUES ('initial','project','mission',1,'mission_review_initialized',
      'system',NULL,'{}','${NOW.toISOString()}');
  `);
  database.exec("PRAGMA foreign_keys=ON");
  return database;
}

function input() {
  return {
    attemptId: "attempt",
    credentialGeneration: 1,
    frozenMaterialHash: HASH,
    frozenMaterialJson: JSON.stringify({ sourceRefs: [] }),
    maxTokens: 100,
    missionId: "mission",
    model: "model",
    operationId: "00000000-0000-4000-8000-000000000009",
    parentId: "work",
    projectId: "project",
    promptHash: HASH,
    providerId: "provider",
    providerRequest: {
      apiKey: "secret",
      baseUrl: "https://provider.invalid/v1",
      messages: [{ content: "review", role: "user" as const }],
      model: "model",
    },
    providerVersion: 1,
    request: { expectedHeadVersion: 1, resultId: "result", reviewerAgentId: "reviewer" },
    resultId: "result",
    reviewerAgentId: "reviewer",
    trustedTokens: 0,
    validationContext: {
      candidateActor: { agentId: "reviewer", type: "agent" as const },
      secretValues: ["secret"],
      sources: [{
        complete: true,
        hasVerifiedContent: true,
        ref: { id: "result", type: "result", version: "1" },
      }],
    },
    verifiedAt: NOW.toISOString(),
    workItemId: "work",
  };
}

const output = JSON.stringify({
  decision: { choice: "pass" },
  evidenceRefs: [{ id: "result", type: "result", version: "1" }],
  findings: [],
  limitations: [],
  memoryCandidates: [{
    content: "Approved result fact",
    source: { id: "result", type: "result", version: "1" },
    supersedesMemoryId: null,
    type: "fact",
  }],
  publicSummary: "Approved",
});

function providerResult(): ModelCallResult {
  return {
    content: output,
    error: null,
    httpStatus: 200,
    status: "succeeded",
    usage: { completionTokens: 2, promptTokens: 3, totalTokens: 5 },
    usageReported: true,
  };
}

function facts(database: DatabaseSync) {
  return database.prepare(`
    SELECT
      (SELECT status FROM review_attempts WHERE id='attempt') AS attempt,
      (SELECT COUNT(*) FROM review_decisions WHERE attempt_id='attempt') AS decisions,
      (SELECT COUNT(*) FROM review_memory_candidates WHERE attempt_id='attempt') AS candidates,
      (SELECT state FROM work_item_review_heads WHERE work_item_id='work') AS head,
      (SELECT status FROM work_items WHERE id='work') AS board,
      (SELECT COUNT(*) FROM review_events WHERE type IN
        ('review_decided','work_item_passed')) AS businessEvents,
      (SELECT status FROM review_operations WHERE id=
        '00000000-0000-4000-8000-000000000009') AS receipt
  `).get();
}

afterEach(() => {
  for (const database of databases.splice(0)) {
    try {
      database.close();
    } catch {
      // The test may already have closed this connection before a restart.
    }
  }
});

describe("checkpointed business finalize replay", () => {
  it.each<FinalizeStep>([
    "decision",
    "memory-candidates",
    "head",
    "board",
    "events",
    "attempt",
    "receipt",
  ])("keeps all pass facts absent on %s fault, then replays locally without new usage", async (step) => {
    const path = databasePath();
    let database = seed(path);
    const callProvider = vi.fn().mockResolvedValue(providerResult());
    const { runReviewOperation } = await modules["../../../src/adapters/outbound/sqlite/review-delivery/review-orchestrator.ts"]();
    let injected = false;
    const dependencies = {
      beforeFinalizeStep: (current: FinalizeStep) => {
        if (!injected && current === step) {
          injected = true;
          throw new Error(`injected ${step} fault`);
        }
      },
      callProvider,
      clock: () => NOW,
      randomUUID: (() => {
        let value = 0;
        return () => `id-${++value}`;
      })(),
    };

    const first = await runReviewOperation(database, input(), dependencies);
    expect(first).toMatchObject({
      state: "finalizing",
      retry: { kind: "local-finalize-only", providerCallRequired: false },
    });
    expect(facts(database)).toEqual({
      attempt: "finalizing",
      board: "in_progress",
      businessEvents: 0,
      candidates: 0,
      decisions: 0,
      head: "reviewing",
      receipt: "pending",
    });
    const before = database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM review_model_calls) AS calls,
        (SELECT COALESCE(SUM(total_tokens),0) FROM review_model_calls) AS usage
    `).get();
    database.close();

    database = new DatabaseSync(path);
    database.exec("PRAGMA foreign_keys=ON");
    databases.push(database);
    const replay = await runReviewOperation(database, input(), {
      ...dependencies,
      beforeFinalizeStep: undefined,
      randomUUID: (() => {
        let value = 100;
        return () => `id-${++value}`;
      })(),
    });
    expect(replay.state).toBe("passed");
    expect(callProvider).toHaveBeenCalledTimes(1);
    expect(database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM review_model_calls) AS calls,
        (SELECT COALESCE(SUM(total_tokens),0) FROM review_model_calls) AS usage
    `).get()).toEqual(before);
    expect(facts(database)).toEqual({
      attempt: "passed",
      board: "done",
      businessEvents: 2,
      candidates: 1,
      decisions: 1,
      head: "passed",
      receipt: "completed",
    });
    database.close();
  });

  it("reads the durable checkpoint on replay and never trusts a caller-supplied output", async () => {
    const path = databasePath();
    const database = seed(path);
    const callProvider = vi.fn().mockResolvedValue(providerResult());
    const { runReviewOperation } = await modules["../../../src/adapters/outbound/sqlite/review-delivery/review-orchestrator.ts"]();

    const result = await runReviewOperation(database, input(), {
      callProvider,
      clock: () => NOW,
      randomUUID: (() => {
        let value = 0;
        return () => `id-${++value}`;
      })(),
    });

    expect(result.state).toBe("passed");
    expect(database.prepare(
      "SELECT choice FROM review_decisions WHERE attempt_id='attempt'",
    ).get()).toEqual({ choice: "pass" });
    expect(callProvider).toHaveBeenCalledTimes(1);
    database.close();
  });
});
