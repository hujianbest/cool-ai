import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase } from "@/src/server/db";
import { finalizeCheckpointedReview } from "@/src/server/review/review-finalizer";

const NOW = "2026-08-01T10:00:00.000Z";
let directory: string;
let path: string;
let database: DatabaseSync;

type Candidate = {
  content: string;
  source: {
    id: string;
    type: "artifact" | "result" | "task";
    version: string;
  };
  supersedesMemoryId: null;
  type: "decision" | "fact";
};

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

function seedBase(): void {
  database.exec("PRAGMA foreign_keys=OFF");
  database.exec(`
    INSERT INTO projects(id,name,created_at,version)
    VALUES ('project','Memory dedupe','${NOW}',1);
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

function seedAttempt(index: number, candidate: Candidate): string {
  const mission = "mission";
  const work = `work-${index}`;
  const result = `result-${index}`;
  const attempt = `attempt-${index}`;
  const operation = `operation-${index}`;
  const json = JSON.stringify(canonicalize({
    decision: { choice: "pass" },
    evidenceRefs: [],
    findings: [],
    limitations: [],
    memoryCandidates: [candidate],
    publicSummary: `Approved ${index}`,
  }));
  const hash = createHash("sha256").update(json, "utf8").digest("hex");

  database.exec("PRAGMA foreign_keys=OFF");
  database.prepare(`
    INSERT INTO work_items(
      id,mission_id,title,description,status,assignee_agent_id,version,created_at,updated_at
    ) VALUES (?, ?, ?, '', 'in_progress', 'executor', 1, ?, ?)
  `).run(work, mission, work, NOW, NOW);
  database.prepare(`
    INSERT INTO work_item_result_versions(
      id,project_id,mission_id,work_item_id,version,execution_id,staged_result_id,
      merge_journal_id,supersedes_result_id,executor_agent_id,created_at
    ) VALUES (?, 'project', ?, ?, 1, ?, ?, ?, NULL, 'executor', ?)
  `).run(result, mission, work, `execution-${index}`, `staged-${index}`, `journal-${index}`, NOW);
  database.prepare(`
    INSERT INTO review_operations(
      id,project_id,kind,parent_id,request_hash,status,http_status,response_json,
      created_at,updated_at
    ) VALUES (?, 'project', 'start_review', ?, ?, 'pending', NULL, NULL, ?, ?)
  `).run(operation, work, "a".repeat(64), NOW, NOW);
  database.prepare(`
    INSERT INTO review_attempts(
      id,project_id,mission_id,work_item_id,result_id,reviewer_agent_id,
      operation_id,status,lease_token,lease_expires_at,frozen_material_json,
      frozen_material_hash,prompt_hash,provider_id,provider_version,
      credential_generation,verified_at,model,parsed_output_json,
      parsed_output_hash,output_checkpointed_at,finalize_error_code,error_category,
      started_at,finished_at
    ) VALUES (?, 'project', ?, ?, ?, 'reviewer', ?, 'finalizing', 'lease',
      '2026-08-01T10:02:00.000Z', '{"sourceRefs":[]}', ?, ?, 'provider', 1, 1,
      ?, 'model', ?, ?, ?, NULL, NULL, ?, NULL)
  `).run(
    attempt,
    mission,
    work,
    result,
    operation,
    "b".repeat(64),
    "c".repeat(64),
    NOW,
    json,
    hash,
    NOW,
    NOW,
  );
  database.prepare(`
    INSERT INTO work_item_review_heads(
      work_item_id,project_id,mission_id,current_result_id,current_attempt_id,
      state,version,updated_at
    ) VALUES (?, 'project', ?, ?, ?, 'reviewing', 1, ?)
  `).run(work, mission, result, attempt, NOW);
  database.exec("PRAGMA foreign_keys=ON");
  return hash;
}

function candidate(
  content: string,
  overrides: Partial<Candidate> = {},
): Candidate {
  return {
    content,
    source: { id: "shared-result", type: "result", version: "1" },
    supersedesMemoryId: null,
    type: "fact",
    ...overrides,
  };
}

function finalize(index: number, hash: string, connection = database): void {
  let sequence = 0;
  finalizeCheckpointedReview(connection, {
    attemptId: `attempt-${index}`,
    checkpointHash: hash,
  }, {
    clock: () => new Date(NOW),
    randomUUID: () => `generated-${index}-${++sequence}`,
  });
}

function activeDuplicateGroups(): number {
  return (database.prepare(`
    SELECT COUNT(*) AS count FROM (
      SELECT e.type,e.content,e.source_type,e.source_id,e.source_version
      FROM memory_entries e
      WHERE e.project_id='project'
        AND NOT EXISTS (
          SELECT 1 FROM memory_entries child WHERE child.supersedes_id=e.id
        )
      GROUP BY e.type,e.content,e.source_type,e.source_id,e.source_version
      HAVING COUNT(*)>1
    )
  `).get() as { count: number }).count;
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "review-memory-dedup-"));
  path = join(directory, "cockpit.sqlite");
  database = openDatabase(path);
  seedBase();
});

afterEach(() => {
  database.close();
  rmSync(directory, { force: true, recursive: true });
});

describe("review memory deterministic dedupe", () => {
  it("reuses the exact active tuple after trim and associates every decision", () => {
    const firstHash = seedAttempt(1, candidate("  Exact knowledge  "));
    const secondHash = seedAttempt(2, candidate("\tExact knowledge\r\n"));

    finalize(1, firstHash);
    const replay = finalizeCheckpointedReview(database, {
      attemptId: "attempt-1",
      checkpointHash: firstHash,
    });
    finalize(2, secondHash);

    expect(replay.state).toBe("passed");
    expect(database.prepare(`
      SELECT id,content,type,source_type AS sourceType,source_id AS sourceId,
             source_version AS sourceVersion
      FROM memory_entries
    `).all()).toEqual([{
      content: "Exact knowledge",
      id: "generated-1-3",
      sourceId: "shared-result",
      sourceType: "result",
      sourceVersion: "1",
      type: "fact",
    }]);
    expect(database.prepare(`
      SELECT association.outcome,association.memory_id AS memoryId,
             decision.attempt_id AS attemptId
      FROM review_memory_associations association
      JOIN review_decisions decision ON decision.id=association.decision_id
      ORDER BY decision.attempt_id
    `).all()).toEqual([
      { attemptId: "attempt-1", memoryId: "generated-1-3", outcome: "created" },
      { attemptId: "attempt-2", memoryId: "generated-1-3", outcome: "reused" },
    ]);
  });

  it("preserves internal code points and source identity while keeping supplements separate", () => {
    const variants = [
      candidate("Knowledge"),
      candidate("Know  ledge"),
      candidate("knowledge"),
      candidate("\u00e9"),
      candidate("e\u0301"),
      candidate("Knowledge", {
        source: { id: "shared-result", type: "result", version: "2" },
      }),
      candidate("Knowledge", {
        source: { id: "other-result", type: "result", version: "1" },
      }),
      candidate("Knowledge", {
        source: { id: "shared-result", type: "task", version: "1" },
      }),
      candidate("Knowledge supplement"),
      candidate("Knowledge", { type: "decision" }),
    ];
    variants.forEach((value, offset) => {
      const index = offset + 1;
      finalize(index, seedAttempt(index, value));
    });

    expect(database.prepare("SELECT COUNT(*) AS count FROM memory_entries").get())
      .toEqual({ count: variants.length });
    expect(database.prepare(
      "SELECT content FROM memory_entries WHERE content IN ('é','é') ORDER BY length(content)",
    ).all()).toEqual([{ content: "\u00e9" }, { content: "e\u0301" }]);
    expect(activeDuplicateGroups()).toBe(0);
  });

  it("does not reuse a matching historical entry", () => {
    const tupleHash = createHash("sha256").update(JSON.stringify([
      "fact", "Historical", "result", "shared-result", "1",
    ]), "utf8").digest("hex");
    const childHash = createHash("sha256").update(JSON.stringify([
      "fact", "Corrected", "result", "shared-result", "2",
    ]), "utf8").digest("hex");
    database.exec("PRAGMA foreign_keys=OFF");
    database.prepare(`
      INSERT INTO memory_entries(
        id,project_id,chain_id,version,type,content,dedupe_hash,source_type,
        source_id,source_version,proposer_actor_type,proposer_actor_id,
        confirming_review_attempt_id,persistence_actor,supersedes_id,created_at
      ) VALUES
        ('historical','project','chain',1,'fact','Historical',?,'result',
         'shared-result','1','owner',NULL,NULL,'platform',NULL,?),
        ('active-child','project','chain',2,'fact','Corrected',?,'result',
         'shared-result','2','owner',NULL,NULL,'platform','historical',?)
    `).run(tupleHash, NOW, childHash, NOW);
    database.exec("PRAGMA foreign_keys=ON");

    finalize(1, seedAttempt(1, candidate("Historical")));

    expect(database.prepare(`
      SELECT association.outcome,association.memory_id AS memoryId
      FROM review_memory_associations association
    `).get()).toEqual({ memoryId: "generated-1-3", outcome: "created" });
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM memory_entries e
      WHERE e.content='Historical' AND NOT EXISTS (
        SELECT 1 FROM memory_entries child WHERE child.supersedes_id=e.id
      )
    `).get()).toEqual({ count: 1 });
    expect(activeDuplicateGroups()).toBe(0);
  });

  it("serializes two pass finalizers onto one active memory with separate associations", async () => {
    const firstHash = seedAttempt(1, candidate("Concurrent knowledge"));
    const secondHash = seedAttempt(2, candidate("Concurrent knowledge"));
    const firstConnection = new DatabaseSync(path);
    const secondConnection = new DatabaseSync(path);
    firstConnection.exec("PRAGMA foreign_keys=ON");
    secondConnection.exec("PRAGMA foreign_keys=ON");
    try {
      const results = await Promise.allSettled([
        Promise.resolve().then(() => finalize(1, firstHash, firstConnection)),
        Promise.resolve().then(() => finalize(2, secondHash, secondConnection)),
      ]);

      expect(results.every(({ status }) => status === "fulfilled")).toBe(true);
      expect(database.prepare("SELECT COUNT(*) AS count FROM memory_entries").get())
        .toEqual({ count: 1 });
      expect(database.prepare(
        "SELECT COUNT(*) AS count FROM review_memory_associations",
      ).get()).toEqual({ count: 2 });
      expect(activeDuplicateGroups()).toBe(0);
    } finally {
      firstConnection.close();
      secondConnection.close();
    }
  });
});
