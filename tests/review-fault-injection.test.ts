import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import { openDatabase } from "@/src/server/db";
import type { ReviewFaultPoint } from "@/src/server/review/review-orchestrator";
import { runReviewOperation } from "@/src/server/review/review-orchestrator";
import type { ModelCallResult } from "@/src/shared/collaboration-contracts";

const NOW = new Date("2026-08-01T10:00:00.000Z");
const HASH = "a".repeat(64);
const roots: string[] = [];
const databases: DatabaseSync[] = [];

function fixturePath(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `review-fault-${label}-`));
  roots.push(root);
  return join(root, "cockpit.sqlite");
}

function seed(path: string): DatabaseSync {
  const database = openDatabase(path);
  databases.push(database);
  database.exec("PRAGMA foreign_keys=OFF");
  database.exec(`
    INSERT INTO projects(id,name,created_at,version)
    VALUES ('project','Fault matrix','${NOW.toISOString()}',1);
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
      id,mission_id,title,description,status,assignee_agent_id,version,created_at,updated_at
    ) VALUES ('work','mission','Work','','in_progress','executor',1,
      '${NOW.toISOString()}','${NOW.toISOString()}');
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
    operationId: "18000000-0000-4000-8000-000000000001",
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
        ref: { id: "result", type: "result" as const, version: "1" },
      }],
    },
    verifiedAt: NOW.toISOString(),
    workItemId: "work",
  };
}

function output(choice: "reject" | "escalate" | "pass"): string {
  return JSON.stringify({
    decision: choice === "reject"
      ? { choice, reworkRequirements: ["Fix it"] }
      : choice === "escalate"
      ? { choice, options: ["A", "B"], question: "Choose" }
      : { choice },
    evidenceRefs: [{ id: "result", type: "result", version: "1" }],
    findings: [],
    limitations: [],
    memoryCandidates: choice === "pass" ? [{
      content: "Remembered fact",
      source: { id: "result", type: "result", version: "1" },
      supersedesMemoryId: null,
      type: "fact",
    }] : [],
    publicSummary: `Outcome ${choice}`,
  });
}

function providerResult(choice: "reject" | "escalate" | "pass" = "pass"): ModelCallResult {
  return {
    content: output(choice),
    error: null,
    httpStatus: 200,
    status: "succeeded",
    usage: { completionTokens: 2, promptTokens: 3, totalTokens: 5 },
    usageReported: true,
  };
}

function close(database: DatabaseSync): void {
  database.close();
  databases.splice(databases.indexOf(database), 1);
}

function reopen(path: string): DatabaseSync {
  const database = new DatabaseSync(path);
  database.exec("PRAGMA foreign_keys=ON");
  databases.push(database);
  return database;
}

afterEach(() => {
  for (const database of databases.splice(0)) {
    try {
      database.close();
    } catch {
      // A crash simulation may already have closed the connection.
    }
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, maxRetries: 3, recursive: true, retryDelay: 20 });
  }
});

describe("review crash and transaction fault matrix", () => {
  it.each<ReviewFaultPoint>([
    "after_provider_response",
    "before_output_checkpoint",
  ])("fails before checkpoint at %s and restart never invents a recoverable output", async (point) => {
    const path = fixturePath(point);
    let database = seed(path);
    const callProvider = vi.fn().mockResolvedValue(providerResult());

    await expect(runReviewOperation(database, input(), {
      callProvider,
      clock: () => NOW,
      fault: (current) => {
        if (current === point) throw new Error(`crash:${point}`);
      },
      randomUUID: (() => {
        let value = 0;
        return () => `pre-${++value}`;
      })(),
    })).rejects.toThrow(`crash:${point}`);
    expect(callProvider).toHaveBeenCalledTimes(1);
    expect(database.prepare(`
      SELECT status,parsed_output_json AS output FROM review_attempts WHERE id='attempt'
    `).get()).toEqual({ output: null, status: "calling" });
    close(database);

    database = reopen(path);
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM review_decisions WHERE attempt_id='attempt'",
    ).get()).toEqual({ count: 0 });
    expect(callProvider).toHaveBeenCalledTimes(1);
  });

  it.each<ReviewFaultPoint>([
    "after_output_checkpoint",
    "before_business_finalize",
  ])("restarts at %s and replays only the checkpointed local transaction", async (point) => {
    const path = fixturePath(point);
    let database = seed(path);
    const callProvider = vi.fn().mockResolvedValue(providerResult());
    let crashed = false;
    const dependencies = {
      callProvider,
      clock: () => NOW,
      fault: (current: ReviewFaultPoint) => {
        if (!crashed && current === point) {
          crashed = true;
          throw new Error(`crash:${point}`);
        }
      },
      randomUUID: (() => {
        let value = 0;
        return () => `post-${++value}`;
      })(),
    };

    await expect(runReviewOperation(database, input(), dependencies))
      .rejects.toThrow(`crash:${point}`);
    expect(database.prepare(`
      SELECT status,parsed_output_json IS NOT NULL AS checkpointed
      FROM review_attempts WHERE id='attempt'
    `).get()).toEqual({ checkpointed: 1, status: "finalizing" });
    close(database);

    database = reopen(path);
    const replay = await runReviewOperation(database, input(), {
      ...dependencies,
      fault: undefined,
    });
    expect(replay.state).toBe("passed");
    expect(callProvider).toHaveBeenCalledTimes(1);
    expect(database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM review_model_calls) AS calls,
        (SELECT COUNT(*) FROM review_decisions) AS decisions,
        (SELECT COUNT(*) FROM memory_entries WHERE proposer_actor_type='agent') AS memories,
        (SELECT status FROM work_items WHERE id='work') AS board
    `).get()).toEqual({ board: "done", calls: 1, decisions: 1, memories: 1 });
  });

  it.each(["reject", "escalate", "pass"] as const)(
    "rolls back every business row for %s faults and closes/reopens to one coherent outcome",
    async (choice) => {
      const path = fixturePath(choice);
      let database = seed(path);
      const callProvider = vi.fn().mockResolvedValue(providerResult(choice));
      const first = await runReviewOperation(database, input(), {
        beforeFinalizeStep: (step) => {
          if (step === "events") throw new Error(`fault:${choice}`);
        },
        callProvider,
        clock: () => NOW,
        randomUUID: (() => {
          let value = 0;
          return () => `${choice}-${++value}`;
        })(),
      });
      expect(first.state).toBe("finalizing");
      expect(database.prepare(`
        SELECT
          (SELECT COUNT(*) FROM review_decisions) AS decisions,
          (SELECT COUNT(*) FROM review_memory_candidates) AS candidates,
          (SELECT COUNT(*) FROM review_escalations) AS escalations
      `).get()).toEqual({ candidates: 0, decisions: 0, escalations: 0 });
      close(database);

      database = reopen(path);
      const replay = await runReviewOperation(database, input(), {
        callProvider,
        clock: () => NOW,
        randomUUID: (() => {
          let value = 100;
          return () => `${choice}-${++value}`;
        })(),
      });
      expect(replay.state).toBe(
        choice === "reject" ? "rejected" : choice === "escalate" ? "escalated" : "passed",
      );
      expect(callProvider).toHaveBeenCalledTimes(1);
      expect(database.prepare(
        "SELECT COUNT(*) AS count FROM review_decisions WHERE attempt_id='attempt'",
      ).get()).toEqual({ count: 1 });
    },
  );

  it("uses a stable canonical checkpoint hash across process restart", async () => {
    const path = fixturePath("hash");
    let database = seed(path);
    const callProvider = vi.fn().mockResolvedValue(providerResult());
    const response = await runReviewOperation(database, input(), {
      callProvider,
      clock: () => NOW,
      localFinalize: () => undefined,
      randomUUID: () => "hash-call",
    });
    expect(response.state).toBe("finalizing");
    const row = database.prepare(`
      SELECT parsed_output_json AS output,parsed_output_hash AS hash
      FROM review_attempts WHERE id='attempt'
    `).get() as { hash: string; output: string };
    expect(createHash("sha256").update(row.output, "utf8").digest("hex")).toBe(row.hash);
    close(database);
    database = reopen(path);
    expect(database.prepare(`
      SELECT parsed_output_json AS output,parsed_output_hash AS hash
      FROM review_attempts WHERE id='attempt'
    `).get()).toEqual(row);
  });
});
