import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { listMemoriesInDatabase } from "@/src/adapters/outbound/sqlite/knowledge-provenance/memory-service";
import {
  finalizeCheckpointedReview,
  type ReviewFinalizeStep,
} from "@/src/adapters/outbound/sqlite/review-delivery/review-finalizer";

const NOW = "2026-08-01T10:00:00.000Z";
let directory: string;
let databasePath: string;
let database: DatabaseSync;

type Candidate = {
  content: string;
  source: { id: string; type: "result"; version: string };
  supersedesMemoryId: string | null;
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

function hashTuple(
  type: string,
  content: string,
  sourceId: string,
  sourceVersion: string | null,
): string {
  return createHash("sha256").update(JSON.stringify([
    type,
    content,
    "result",
    sourceId,
    sourceVersion,
  ]), "utf8").digest("hex");
}

function seedBase(): void {
  database.exec("PRAGMA foreign_keys=OFF");
  database.exec(`
    INSERT INTO projects(id,name,created_at,version) VALUES
      ('project','Supersedes','${NOW}',1),
      ('other-project','Other','${NOW}',1);
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
    INSERT INTO project_memberships(project_id,agent_id,joined_at) VALUES
      ('project','executor','${NOW}'),
      ('project','reviewer','${NOW}');
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

function seedOwnerMemory(input: {
  id: string;
  projectId?: string;
  type?: "decision" | "fact";
  content?: string;
  chainId?: string;
  version?: number;
  supersedesId?: string | null;
  sourceId?: string;
  sourceVersion?: string | null;
}): void {
  const projectId = input.projectId ?? "project";
  const type = input.type ?? "fact";
  const content = input.content ?? input.id;
  const version = input.version ?? 1;
  database.prepare(`
    INSERT INTO memory_entries(
      id,project_id,chain_id,version,type,content,dedupe_hash,source_type,
      source_id,source_version,proposer_actor_type,proposer_actor_id,
      confirming_review_attempt_id,persistence_actor,supersedes_id,created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'owner', NULL,
      NULL, 'platform', ?, ?)
  `).run(
    input.id,
    projectId,
    input.chainId ?? input.id,
    version,
    type,
    content,
    hashTuple(type, content, input.sourceId ?? input.id, input.sourceVersion ?? null),
    input.sourceVersion === undefined ? "owner_input" : "result",
    input.sourceId ?? input.id,
    input.sourceVersion ?? null,
    input.supersedesId ?? null,
    NOW,
  );
}

function seedAttempt(index: number, candidate: Candidate): string {
  const workItemId = `work-${index}`;
  const resultId = `result-${index}`;
  const attemptId = `attempt-${index}`;
  const operationId = `operation-${index}`;
  const outputJson = JSON.stringify(canonicalize({
    decision: { choice: "pass" },
    evidenceRefs: [],
    findings: [],
    limitations: [],
    memoryCandidates: [candidate],
    publicSummary: `Approved ${index}`,
  }));
  const checkpointHash = createHash("sha256")
    .update(outputJson, "utf8")
    .digest("hex");
  const frozenMaterial = JSON.stringify({
    sourceRefs: [{ id: resultId, type: "result", version: "1" }],
  });

  database.exec("PRAGMA foreign_keys=OFF");
  database.prepare(`
    INSERT INTO work_items(
      id,mission_id,title,description,status,assignee_agent_id,version,created_at,updated_at
    ) VALUES (?, 'mission', ?, '', 'in_progress', 'executor', 1, ?, ?)
  `).run(workItemId, workItemId, NOW, NOW);
  database.prepare(`
    INSERT INTO work_item_result_versions(
      id,project_id,mission_id,work_item_id,version,execution_id,staged_result_id,
      merge_journal_id,supersedes_result_id,executor_agent_id,created_at
    ) VALUES (?, 'project', 'mission', ?, 1, ?, ?, ?, NULL, 'executor', ?)
  `).run(
    resultId,
    workItemId,
    `execution-${index}`,
    `staged-${index}`,
    `journal-${index}`,
    NOW,
  );
  database.prepare(`
    INSERT INTO review_operations(
      id,project_id,kind,parent_id,request_hash,status,http_status,response_json,
      created_at,updated_at
    ) VALUES (?, 'project', 'start_review', ?, ?, 'pending', NULL, NULL, ?, ?)
  `).run(operationId, workItemId, "a".repeat(64), NOW, NOW);
  database.prepare(`
    INSERT INTO review_attempts(
      id,project_id,mission_id,work_item_id,result_id,reviewer_agent_id,
      operation_id,status,lease_token,lease_expires_at,frozen_material_json,
      frozen_material_hash,prompt_hash,provider_id,provider_version,
      credential_generation,verified_at,model,parsed_output_json,
      parsed_output_hash,output_checkpointed_at,finalize_error_code,error_category,
      started_at,finished_at
    ) VALUES (?, 'project', 'mission', ?, ?, 'reviewer', ?, 'finalizing', 'lease',
      '2026-08-01T10:02:00.000Z', ?, ?, ?, 'provider', 1, 1, ?, 'model',
      ?, ?, ?, NULL, NULL, ?, NULL)
  `).run(
    attemptId,
    workItemId,
    resultId,
    operationId,
    frozenMaterial,
    "b".repeat(64),
    "c".repeat(64),
    NOW,
    outputJson,
    checkpointHash,
    NOW,
    NOW,
  );
  database.prepare(`
    INSERT INTO work_item_review_heads(
      work_item_id,project_id,mission_id,current_result_id,current_attempt_id,
      state,version,updated_at
    ) VALUES (?, 'project', 'mission', ?, ?, 'reviewing', 1, ?)
  `).run(workItemId, resultId, attemptId, NOW);
  database.exec("PRAGMA foreign_keys=ON");
  return checkpointHash;
}

function candidate(
  index: number,
  content: string,
  supersedesMemoryId: string | null,
  type: "decision" | "fact" = "fact",
): Candidate {
  return {
    content,
    source: { id: `result-${index}`, type: "result", version: "1" },
    supersedesMemoryId,
    type,
  };
}

function finalize(
  index: number,
  hash: string,
  connection = database,
  beforeStep?: (step: ReviewFinalizeStep) => void,
): void {
  let sequence = 0;
  finalizeCheckpointedReview(connection, {
    attemptId: `attempt-${index}`,
    checkpointHash: hash,
  }, {
    beforeStep,
    clock: () => new Date(NOW),
    randomUUID: () => `generated-${index}-${++sequence}`,
  });
}

function expectCode(action: () => void, code: string): void {
  try {
    action();
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "review-memory-supersedes-"));
  databasePath = join(directory, "cockpit.sqlite");
  database = openDatabase(databasePath);
  seedBase();
});

afterEach(() => {
  if (database.isOpen) database.close();
  rmSync(directory, { force: true, recursive: true });
});

describe("review memory immutable supersedes chains", () => {
  it("requires an explicit same-project same-type unique active predecessor", () => {
    seedOwnerMemory({ id: "old", content: "Old fact" });
    seedOwnerMemory({ id: "other-type", type: "decision" });
    seedOwnerMemory({ id: "other-project", projectId: "other-project" });
    seedOwnerMemory({ id: "historical", content: "Historical" });
    seedOwnerMemory({
      id: "historical-child",
      chainId: "historical",
      content: "Current",
      supersedesId: "historical",
      version: 2,
    });

    finalize(1, seedAttempt(1, candidate(1, "Supplement", null)));
    expect(database.prepare(
      "SELECT supersedes_id AS supersedesId,version FROM memory_entries WHERE id='generated-1-3'",
    ).get()).toEqual({ supersedesId: null, version: 1 });

    expectCode(
      () => finalize(2, seedAttempt(2, candidate(2, "Wrong type", "other-type"))),
      "MEMORY_TYPE_MISMATCH",
    );
    expectCode(
      () => finalize(3, seedAttempt(3, candidate(3, "Wrong project", "other-project"))),
      "MEMORY_SUPERSEDES_INVALID",
    );
    expectCode(
      () => finalize(4, seedAttempt(4, candidate(4, "Too late", "historical"))),
      "MEMORY_NOT_ACTIVE",
    );

    seedOwnerMemory({
      content: "Self tuple",
      id: "self",
      sourceId: "result-5",
      sourceVersion: "1",
    });
    const sameTuple = candidate(5, "Self tuple", "self");
    expectCode(
      () => finalize(5, seedAttempt(5, sameTuple)),
      "MEMORY_SUPERSEDES_INVALID",
    );
  });

  it("creates an immutable continuous chain and preserves versioned navigation after restart", () => {
    seedOwnerMemory({ id: "old", content: "Old fact" });
    finalize(1, seedAttempt(1, candidate(1, "Corrected fact", "old")));

    const rows = database.prepare(`
      SELECT id,chain_id AS chainId,version,content,supersedes_id AS supersedesId,
        CASE WHEN EXISTS(
          SELECT 1 FROM memory_entries child WHERE child.supersedes_id=entry.id
        ) THEN 0 ELSE 1 END AS active
      FROM memory_entries entry WHERE chain_id='old' ORDER BY version
    `).all();
    expect(rows).toEqual([
      {
        active: 0,
        chainId: "old",
        content: "Old fact",
        id: "old",
        supersedesId: null,
        version: 1,
      },
      {
        active: 1,
        chainId: "old",
        content: "Corrected fact",
        id: "generated-1-3",
        supersedesId: "old",
        version: 2,
      },
    ]);
    expect(() => database.prepare(
      "UPDATE memory_entries SET content='mutated' WHERE id='old'",
    ).run()).toThrow(/IMMUTABLE_MEMORY_ENTRY/u);
    expect(database.prepare(`
      SELECT outcome,memory_id AS memoryId FROM review_memory_associations
    `).get()).toEqual({ memoryId: "generated-1-3", outcome: "superseded" });
    expect(database.prepare(`
      SELECT type,payload_json AS payload FROM review_events
      WHERE type='memory_superseded'
    `).get()).toMatchObject({ type: "memory_superseded" });

    database.close();
    const restarted = new DatabaseSync(databasePath);
    restarted.exec("PRAGMA foreign_keys=ON");
    const afterRestart = listMemoriesInDatabase(restarted, "project", true)
      .filter(({ chainId }) => chainId === "old")
      .sort((left, right) => left.version - right.version);
    expect(afterRestart.map((entry) => ({
      active: entry.active,
      chainId: entry.chainId,
      href: entry.source.href,
      id: entry.id,
      supersedesId: entry.supersedesId,
      version: entry.version,
    }))).toEqual([
      {
        active: false,
        chainId: "old",
        href: null,
        id: "old",
        supersedesId: null,
        version: 1,
      },
      {
        active: true,
        chainId: "old",
        href: "/projects/project/tasks/work-1/results/result-1?version=1",
        id: "generated-1-3",
        supersedesId: "old",
        version: 2,
      },
    ]);
    restarted.close();
    database = new DatabaseSync(databasePath);
  });

  it("allows exactly one concurrent supersede winner without a fork", async () => {
    seedOwnerMemory({ id: "old", content: "Old fact" });
    const firstHash = seedAttempt(1, candidate(1, "Correction A", "old"));
    const secondHash = seedAttempt(2, candidate(2, "Correction B", "old"));
    const first = new DatabaseSync(databasePath);
    const second = new DatabaseSync(databasePath);
    first.exec("PRAGMA foreign_keys=ON");
    second.exec("PRAGMA foreign_keys=ON");
    try {
      const results = await Promise.allSettled([
        Promise.resolve().then(() => finalize(1, firstHash, first)),
        Promise.resolve().then(() => finalize(2, secondHash, second)),
      ]);
      expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
      expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
      expect(database.prepare(
        "SELECT COUNT(*) AS count FROM memory_entries WHERE supersedes_id='old'",
      ).get()).toEqual({ count: 1 });
      expect(database.prepare(`
        SELECT COUNT(*) AS count FROM memory_entries
        WHERE chain_id='old' AND version=2
      `).get()).toEqual({ count: 1 });
    } finally {
      first.close();
      second.close();
    }
  });

  it("rolls back the whole pass when a fault follows supersede writes", () => {
    seedOwnerMemory({ id: "old", content: "Old fact" });
    const hash = seedAttempt(1, candidate(1, "Corrected fact", "old"));

    expect(() => finalize(1, hash, database, (step) => {
      if (step === "head") throw new Error("fault after memory");
    })).toThrow("fault after memory");

    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM memory_entries WHERE supersedes_id='old'",
    ).get()).toEqual({ count: 0 });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM review_memory_candidates",
    ).get()).toEqual({ count: 0 });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM review_memory_associations",
    ).get()).toEqual({ count: 0 });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM review_decisions",
    ).get()).toEqual({ count: 0 });
    expect(database.prepare(
      "SELECT status FROM review_attempts WHERE id='attempt-1'",
    ).get()).toEqual({ status: "finalizing" });
    expect(database.prepare(`
      SELECT state,current_attempt_id AS attemptId
      FROM work_item_review_heads WHERE work_item_id='work-1'
    `).get()).toEqual({ attemptId: "attempt-1", state: "reviewing" });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM review_events WHERE sequence>1",
    ).get()).toEqual({ count: 0 });
  });
});
