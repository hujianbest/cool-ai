import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";

type FinalizerModule = {
  finalizeCheckpointedReview?: (
    database: DatabaseSync,
    input: { attemptId: string; checkpointHash: string },
    dependencies?: {
      clock?: () => Date;
      randomUUID?: () => string;
    },
  ) => {
    attemptId: string;
    checkpointHash: string;
    decisionId: string;
    retry: { kind: "none"; providerCallRequired: false };
    state: "rejected" | "passed";
  };
};

const modules = import.meta.glob<FinalizerModule>(
  "../../../src/adapters/outbound/sqlite/review-delivery/review-finalizer.ts",
);
const NOW = "2026-08-01T07:00:00.000Z";
let directory: string;
let database: DatabaseSync;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

function checkpoint(output: Record<string, unknown>): string {
  const json = JSON.stringify(canonicalize(output));
  const hash = createHash("sha256").update(json, "utf8").digest("hex");
  database.prepare(`
    UPDATE review_attempts
    SET status='finalizing',parsed_output_json=?,parsed_output_hash=?,output_checkpointed_at=?
    WHERE id='attempt'
  `).run(json, hash, NOW);
  return hash;
}

function seed(): void {
  database.exec("PRAGMA foreign_keys=OFF");
  database.exec(`
    INSERT INTO projects(id,name,created_at,version)
    VALUES ('project','Review decisions','${NOW}',1);
    INSERT INTO providers(
      id,name,base_url,default_model,api_key_cipher,api_key_iv,api_key_tag,
      credential_version,credential_generation,key_id,api_key_mask,verified_at,
      version,created_at,updated_at
    ) VALUES ('provider','Provider','https://provider.invalid/v1','model',
      'cipher','iv','tag',1,1,'key','mask','${NOW}',1,'${NOW}','${NOW}');
    INSERT INTO agents(
      id,name,role,system_prompt,provider_id,model,avatar_text,accent_token,
      can_read,can_write,can_execute,max_tokens,max_handoffs,version,
      created_at,updated_at,review_capable
    ) VALUES
      ('executor','Executor','Builder','Build','provider','model','E','sage',
       1,1,1,1000,2,1,'${NOW}','${NOW}',0),
      ('reviewer','Reviewer','Review','Review','provider','model','R','slate',
       1,0,0,1000,2,1,'${NOW}','${NOW}',1);
    INSERT INTO project_memberships(project_id,agent_id,joined_at)
    VALUES ('project','executor','${NOW}'),('project','reviewer','${NOW}');
    INSERT INTO missions(id,project_id,title,goal,version,created_at,updated_at)
    VALUES ('mission','project','Mission','Goal',1,'${NOW}','${NOW}');
    INSERT INTO work_items(
      id,mission_id,title,description,status,assignee_agent_id,version,created_at,updated_at
    ) VALUES ('work','mission','Work','','in_progress','executor',4,'${NOW}','${NOW}');
    INSERT INTO work_item_result_versions(
      id,project_id,mission_id,work_item_id,version,execution_id,staged_result_id,
      merge_journal_id,supersedes_result_id,executor_agent_id,created_at
    ) VALUES ('result','project','mission','work',1,'execution','staged','journal',
      NULL,'executor','${NOW}');
    INSERT INTO review_operations(
      id,project_id,kind,parent_id,request_hash,status,http_status,response_json,
      created_at,updated_at
    ) VALUES ('operation','project','start_review','work','${"a".repeat(64)}',
      'pending',NULL,NULL,'${NOW}','${NOW}');
    INSERT INTO review_attempts(
      id,project_id,mission_id,work_item_id,result_id,reviewer_agent_id,
      operation_id,status,lease_token,lease_expires_at,frozen_material_json,
      frozen_material_hash,prompt_hash,provider_id,provider_version,
      credential_generation,verified_at,model,parsed_output_json,
      parsed_output_hash,output_checkpointed_at,finalize_error_code,error_category,
      started_at,finished_at
    ) VALUES ('attempt','project','mission','work','result','reviewer','operation',
      'calling','lease','2026-08-01T07:02:00.000Z','{"sourceRefs":[]}',
      '${"b".repeat(64)}','${"c".repeat(64)}','provider',1,1,'${NOW}','model',
      NULL,NULL,NULL,NULL,NULL,'${NOW}',NULL);
    INSERT INTO review_model_calls(
      id,attempt_id,kind,call_index,status,prompt_hash,prompt_tokens,
      completion_tokens,total_tokens,error_category,started_at,finished_at
    ) VALUES ('call','attempt','primary',1,'succeeded','${"c".repeat(64)}',
      3,2,5,NULL,'${NOW}','${NOW}');
    INSERT INTO work_item_review_heads(
      work_item_id,project_id,mission_id,current_result_id,current_attempt_id,
      state,version,updated_at
    ) VALUES ('work','project','mission','result','attempt','reviewing',7,'${NOW}');
    INSERT INTO mission_delivery_heads(
      mission_id,project_id,context_version,state,current_delivery_id,current_operation_id,
      generation_lease_token,generation_lease_expires_at,last_error_code,
      next_event_sequence,version,updated_at
    ) VALUES ('mission','project',1,'ongoing',NULL,NULL,NULL,NULL,NULL,2,1,'${NOW}');
    INSERT INTO review_events(
      id,project_id,mission_id,sequence,type,actor_type,actor_id,payload_json,created_at
    ) VALUES ('initial','project','mission',1,'mission_review_initialized',
      'system',NULL,'{}','${NOW}');
  `);
  database.exec("PRAGMA foreign_keys=ON");
}

async function finalizer() {
  const load = modules["../../../src/adapters/outbound/sqlite/review-delivery/review-finalizer.ts"];
  expect(load, "T-9 finalizer module must exist").toBeTypeOf("function");
  const module = await load();
  expect(module.finalizeCheckpointedReview).toBeTypeOf("function");
  return module.finalizeCheckpointedReview!;
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "review-decisions-"));
  database = openDatabase(join(directory, "cockpit.sqlite"));
  seed();
});

afterEach(() => {
  database.close();
  rmSync(directory, { force: true, recursive: true });
});

describe("checkpointed reject/pass decisions", () => {
  it("atomically rejects into rework with one immutable decision and completed receipt", async () => {
    const finalize = await finalizer();
    const hash = checkpoint({
      decision: { choice: "reject", reworkRequirements: ["Add a regression test"] },
      evidenceRefs: [],
      findings: [{ detail: "Missing edge case", evidenceRefs: [], title: "Coverage" }],
      limitations: [],
      memoryCandidates: [],
      publicSummary: "Needs rework",
    });

    const result = finalize(database, { attemptId: "attempt", checkpointHash: hash }, {
      clock: () => new Date(NOW),
      randomUUID: (() => {
        let value = 0;
        return () => `reject-${++value}`;
      })(),
    });

    expect(result).toMatchObject({ state: "rejected", retry: { kind: "none" } });
    expect(database.prepare(`
      SELECT a.status,d.choice,h.state,h.current_attempt_id AS currentAttempt,
             w.status AS board,o.status AS operationStatus,o.http_status AS httpStatus
      FROM review_attempts a
      JOIN review_decisions d ON d.attempt_id=a.id
      JOIN work_item_review_heads h ON h.work_item_id=a.work_item_id
      JOIN work_items w ON w.id=a.work_item_id
      JOIN review_operations o ON o.id=a.operation_id AND o.project_id=a.project_id
      WHERE a.id='attempt'
    `).get()).toEqual({
      board: "in_progress",
      choice: "reject",
      currentAttempt: null,
      httpStatus: 200,
      operationStatus: "completed",
      state: "rework",
      status: "rejected",
    });
    expect(database.prepare(
      "SELECT type FROM review_events WHERE sequence>1 ORDER BY sequence",
    ).all()).toEqual([
      { type: "review_decided" },
      { type: "rework_requested" },
    ]);
    expect(() => database.prepare(
      "UPDATE review_decisions SET choice='pass' WHERE attempt_id='attempt'",
    ).run()).toThrow(/IMMUTABLE_REVIEW_DECISION/u);
  });

  it("passes with zero candidates and duplicate/late finalizers cannot add a decision", async () => {
    const finalize = await finalizer();
    const hash = checkpoint({
      decision: { choice: "pass" },
      evidenceRefs: [],
      findings: [],
      limitations: [],
      memoryCandidates: [],
      publicSummary: "Approved",
    });
    const dependencies = {
      clock: () => new Date(NOW),
      randomUUID: (() => {
        let value = 0;
        return () => `pass-${++value}`;
      })(),
    };

    const winner = finalize(database, { attemptId: "attempt", checkpointHash: hash }, dependencies);
    const duplicate = finalize(
      database,
      { attemptId: "attempt", checkpointHash: hash },
      dependencies,
    );

    expect(duplicate).toEqual(winner);
    expect(winner.state).toBe("passed");
    expect(database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM review_decisions WHERE attempt_id='attempt') AS decisions,
        (SELECT COUNT(*) FROM review_events WHERE type='review_decided') AS decisionEvents,
        (SELECT COUNT(*) FROM review_events WHERE type='work_item_passed') AS passEvents
    `).get()).toEqual({ decisionEvents: 1, decisions: 1, passEvents: 1 });
    expect(database.prepare(`
      SELECT a.status,h.state,h.current_attempt_id AS currentAttempt,w.status AS board
      FROM review_attempts a
      JOIN work_item_review_heads h ON h.work_item_id=a.work_item_id
      JOIN work_items w ON w.id=a.work_item_id
      WHERE a.id='attempt'
    `).get()).toEqual({
      board: "done",
      currentAttempt: "attempt",
      state: "passed",
      status: "passed",
    });
    expect(() => finalize(
      database,
      { attemptId: "attempt", checkpointHash: "f".repeat(64) },
      dependencies,
    )).toThrowError(expect.objectContaining({ code: "REVIEW_CHECKPOINT_CONFLICT" }));
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM review_decisions WHERE attempt_id='attempt'",
    ).get()).toEqual({ count: 1 });
  });

  it("finalizes escalation into one waiting-owner issue", async () => {
    const finalize = await finalizer();
    const hash = checkpoint({
      decision: { choice: "escalate", options: ["A", "B"], question: "Choose" },
      evidenceRefs: [],
      findings: [],
      limitations: [],
      memoryCandidates: [],
      publicSummary: "Owner input needed",
    });

    const result = finalize(
      database,
      { attemptId: "attempt", checkpointHash: hash },
    );
    expect(result).toMatchObject({ state: "escalated", escalationId: expect.any(String) });
    expect(database.prepare(`
      SELECT a.status,d.choice,h.state,h.current_attempt_id AS currentAttempt,
             (SELECT COUNT(*) FROM review_escalations) AS issues
      FROM review_attempts a
      JOIN review_decisions d ON d.attempt_id=a.id
      JOIN work_item_review_heads h ON h.work_item_id=a.work_item_id
      WHERE a.id='attempt'
    `).get()).toEqual({
      choice: "escalate",
      currentAttempt: null,
      issues: 1,
      state: "waiting_owner",
      status: "escalated",
    });
  });
});
