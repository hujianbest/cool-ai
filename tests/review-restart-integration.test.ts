import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { createMission } from "@/src/server/mission-service";
import { createProject } from "@/src/server/projects";
import { invalidateMissionContextTx } from "@/src/server/review/delivery-service";

type RecoveryModule = {
  assertReviewPersistenceInvariants?: (database: DatabaseSync) => void;
  reconcileReviewPersistence?: (
    database: DatabaseSync,
    dependencies?: { clock?: () => Date; randomUUID?: () => string },
  ) => { interruptedAttemptIds: string[] };
};

const recoveryModules = import.meta.glob<RecoveryModule>(
  "../src/server/review/review-persistence-recovery.ts",
);
const NOW = "2026-08-01T11:00:00.000Z";
const HASH = "b".repeat(64);
const roots: string[] = [];
const databases: DatabaseSync[] = [];

function pathFor(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `review-restart-${label}-`));
  roots.push(root);
  return join(root, "cockpit.sqlite");
}

function track(database: DatabaseSync): DatabaseSync {
  databases.push(database);
  return database;
}

function createHardcodedProject(path: string): DatabaseSync {
  const database = track(openDatabase(path));
  database.prepare(`
    INSERT INTO projects(id,name,created_at,version) VALUES ('project','Recovery',?,1)
  `).run(NOW);
  return database;
}

function close(database: DatabaseSync): void {
  database.close();
  databases.splice(databases.indexOf(database), 1);
}

async function recovery() {
  const loader = recoveryModules["../src/server/review/review-persistence-recovery.ts"];
  expect(loader, "T-18 persistence recovery module must exist").toBeTypeOf("function");
  const module = await loader!();
  expect(module.assertReviewPersistenceInvariants).toBeTypeOf("function");
  expect(module.reconcileReviewPersistence).toBeTypeOf("function");
  return {
    assertInvariants: module.assertReviewPersistenceInvariants!,
    reconcile: module.reconcileReviewPersistence!,
  };
}

function seedReview(database: DatabaseSync, status: "calling" | "finalizing" = "calling"): void {
  const output = JSON.stringify({
    decision: { choice: "pass" },
    evidenceRefs: [],
    findings: [],
    limitations: [],
    memoryCandidates: [],
    publicSummary: "Approved",
  });
  const outputHash = createHash("sha256").update(output, "utf8").digest("hex");
  database.exec("PRAGMA foreign_keys=OFF");
  database.exec(`
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
    INSERT INTO work_items(
      id,mission_id,title,description,status,assignee_agent_id,version,created_at,updated_at
    ) VALUES ('work','mission','Work','','in_progress','executor',1,'${NOW}','${NOW}');
    INSERT INTO work_item_result_versions(
      id,project_id,mission_id,work_item_id,version,execution_id,staged_result_id,
      merge_journal_id,supersedes_result_id,executor_agent_id,created_at
    ) VALUES ('result','project','mission','work',1,'execution','staged','journal',
      NULL,'executor','${NOW}');
    INSERT INTO review_operations(
      id,project_id,kind,parent_id,request_hash,status,http_status,response_json,
      created_at,updated_at
    ) VALUES ('operation','project','start_review','work','${HASH}',
      'pending',NULL,NULL,'${NOW}','${NOW}');
    INSERT INTO review_attempts(
      id,project_id,mission_id,work_item_id,result_id,reviewer_agent_id,
      operation_id,status,lease_token,lease_expires_at,frozen_material_json,
      frozen_material_hash,prompt_hash,provider_id,provider_version,
      credential_generation,verified_at,model,parsed_output_json,
      parsed_output_hash,output_checkpointed_at,finalize_error_code,error_category,
      started_at,finished_at
    ) VALUES ('attempt','project','mission','work','result','reviewer','operation',
      '${status}','lease','2026-08-01T11:02:00.000Z','{"sourceRefs":[]}',
      '${HASH}','${HASH}','provider',1,1,'${NOW}','model',
      ${status === "finalizing" ? `'${output.replaceAll("'", "''")}'` : "NULL"},
      ${status === "finalizing" ? `'${outputHash}'` : "NULL"},
      ${status === "finalizing" ? `'${NOW}'` : "NULL"},NULL,NULL,'${NOW}',NULL);
    INSERT INTO review_model_calls(
      id,attempt_id,kind,call_index,status,prompt_hash,prompt_tokens,
      completion_tokens,total_tokens,error_category,started_at,finished_at
    ) VALUES ('call','attempt','primary',1,
      '${status === "calling" ? "calling" : "succeeded"}','${HASH}',
      ${status === "calling" ? "NULL,NULL,NULL" : "3,2,5"},NULL,'${NOW}',
      ${status === "calling" ? "NULL" : `'${NOW}'`});
    INSERT INTO work_item_review_heads(
      work_item_id,project_id,mission_id,current_result_id,current_attempt_id,
      state,version,updated_at
    ) VALUES ('work','project','mission','result','attempt','reviewing',1,'${NOW}');
  `);
  database.exec("PRAGMA foreign_keys=ON");
}

function persistenceSnapshot(database: DatabaseSync): unknown {
  return {
    attempts: database.prepare(`
      SELECT id,status,result_id AS resultId,parsed_output_hash AS outputHash
      FROM review_attempts ORDER BY id
    `).all(),
    deliveries: database.prepare(`
      SELECT id,mission_id AS missionId,version,input_fingerprint AS fingerprint
      FROM mission_deliveries ORDER BY mission_id,version,id
    `).all(),
    events: database.prepare(`
      SELECT mission_id AS missionId,sequence,type,payload_json AS payload
      FROM review_events ORDER BY mission_id,sequence,id
    `).all(),
    heads: database.prepare(`
      SELECT work_item_id AS workItemId,current_result_id AS resultId,
             current_attempt_id AS attemptId,state,version
      FROM work_item_review_heads ORDER BY work_item_id
    `).all(),
    memories: database.prepare(`
      SELECT id,chain_id AS chainId,version,supersedes_id AS supersedesId
      FROM memory_entries ORDER BY chain_id,version,id
    `).all(),
    operations: database.prepare(`
      SELECT id,kind,status,http_status AS httpStatus,response_json AS response
      FROM review_operations ORDER BY id
    `).all(),
    results: database.prepare(`
      SELECT id,work_item_id AS workItemId,version,supersedes_result_id AS supersedesId
      FROM work_item_result_versions ORDER BY work_item_id,version,id
    `).all(),
  };
}

afterEach(() => {
  for (const database of databases.splice(0)) {
    try {
      database.close();
    } catch {
      // A restart assertion may already have closed it.
    }
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, maxRetries: 3, recursive: true, retryDelay: 20 });
  }
});

describe("review persistence restart integration", () => {
  it("creates a fresh mission head/event atomically and reopens with 100% identical refs", () => {
    const path = pathFor("fresh-mission");
    const project = createProject("Fresh review", path);
    const mission = createMission(path, project.id, {
      expectedVersion: 0,
      goal: "Goal",
      operationId: "16000000-0000-4000-8000-000000000123",
      title: "Mission",
    });
    let database = track(openDatabase(path));
    const before = {
      head: database.prepare(`
        SELECT mission_id AS missionId,project_id AS projectId,context_version AS contextVersion,
               state,next_event_sequence AS nextSequence,version
        FROM mission_delivery_heads WHERE mission_id=?
      `).get(mission.id),
      refs: database.prepare(`
        SELECT mission_id AS missionId,sequence,type FROM review_events WHERE mission_id=?
      `).all(mission.id),
    };
    close(database);
    database = track(openDatabase(path));
    expect({
      head: database.prepare(`
        SELECT mission_id AS missionId,project_id AS projectId,context_version AS contextVersion,
               state,next_event_sequence AS nextSequence,version
        FROM mission_delivery_heads WHERE mission_id=?
      `).get(mission.id),
      refs: database.prepare(`
        SELECT mission_id AS missionId,sequence,type FROM review_events WHERE mission_id=?
      `).all(mission.id),
    }).toEqual(before);
  });

  it("reconciles an expired pre-checkpoint crash after reopen without provider replay", async () => {
    const path = pathFor("expired");
    let database = createHardcodedProject(path);
    database.prepare(`
      INSERT INTO missions(id,project_id,title,goal,version,created_at,updated_at)
      VALUES ('mission','project','Mission','Goal',1,?,?)
    `).run(NOW, NOW);
    database.prepare(`
      INSERT INTO mission_delivery_heads(
        mission_id,project_id,context_version,state,current_delivery_id,current_operation_id,
        generation_lease_token,generation_lease_expires_at,last_error_code,
        next_event_sequence,version,updated_at
      ) VALUES ('mission','project',1,'ongoing',NULL,NULL,NULL,NULL,NULL,1,1,?)
    `).run(NOW);
    seedReview(database, "calling");
    close(database);

    database = track(new DatabaseSync(path));
    database.exec("PRAGMA foreign_keys=ON");
    const { reconcile } = await recovery();
    expect(reconcile(database, {
      clock: () => new Date("2026-08-01T11:03:00.000Z"),
      randomUUID: () => "interrupted-event",
    })).toEqual({ interruptedAttemptIds: ["attempt"] });
    expect(database.prepare(`
      SELECT a.status,h.state,h.current_attempt_id AS currentAttempt,
             o.status AS receiptStatus,o.http_status AS httpStatus
      FROM review_attempts a
      JOIN work_item_review_heads h ON h.work_item_id=a.work_item_id
      JOIN review_operations o ON o.id=a.operation_id AND o.project_id=a.project_id
      WHERE a.id='attempt'
    `).get()).toEqual({
      currentAttempt: null,
      httpStatus: 409,
      receiptStatus: "completed",
      state: "pending_review",
      status: "interrupted",
    });
    expect(database.prepare("SELECT COUNT(*) AS count FROM review_decisions").get())
      .toEqual({ count: 0 });
  });

  it("atomically discards calling/finalizing attempts on a concurrent mission context change", () => {
    const path = pathFor("context");
    let database = createHardcodedProject(path);
    database.prepare(`
      INSERT INTO missions(id,project_id,title,goal,version,created_at,updated_at)
      VALUES ('mission','project','Mission','Goal',1,?,?)
    `).run(NOW, NOW);
    database.prepare(`
      INSERT INTO mission_delivery_heads(
        mission_id,project_id,context_version,state,current_delivery_id,current_operation_id,
        generation_lease_token,generation_lease_expires_at,last_error_code,
        next_event_sequence,version,updated_at
      ) VALUES ('mission','project',1,'ongoing',NULL,NULL,NULL,NULL,NULL,1,1,?)
    `).run(NOW);
    seedReview(database, "finalizing");
    const before = persistenceSnapshot(database);
    expect(invalidateMissionContextTx(database, {
      missionId: "mission",
      projectId: "project",
      reason: "MISSION_CONTEXT_CHANGED",
    }).discardedAttemptIds).toEqual(["attempt"]);
    const after = persistenceSnapshot(database);
    expect(after).not.toEqual(before);
    close(database);

    database = track(new DatabaseSync(path));
    database.exec("PRAGMA foreign_keys=ON");
    expect(persistenceSnapshot(database)).toEqual(after);
    expect(database.prepare(`
      SELECT status,parsed_output_json IS NOT NULL AS checkpointPreserved
      FROM review_attempts WHERE id='attempt'
    `).get()).toEqual({ checkpointPreserved: 1, status: "discarded" });
  });

  it.each([
    {
      label: "malformed checkpoint",
      mutate(database: DatabaseSync) {
        const malformed = JSON.stringify({ decision: { choice: "pass" } });
        database.prepare(`
          UPDATE review_attempts
          SET parsed_output_json=?,parsed_output_hash=?
          WHERE id='attempt'
        `).run(malformed, createHash("sha256").update(malformed).digest("hex"));
      },
    },
    {
      label: "partial terminal rows",
      mutate(database: DatabaseSync) {
        database.prepare(`
          UPDATE review_attempts SET status='passed',finished_at=? WHERE id='attempt'
        `).run(NOW);
      },
    },
    {
      label: "head/result invariant drift",
      mutate(database: DatabaseSync) {
        database.prepare(`
          UPDATE work_item_review_heads SET state='passed' WHERE work_item_id='work'
        `).run();
      },
    },
  ])("fails closed for $label and performs no silent repair", async ({ mutate }) => {
    const path = pathFor("invariant");
    const database = createHardcodedProject(path);
    database.prepare(`
      INSERT INTO missions(id,project_id,title,goal,version,created_at,updated_at)
      VALUES ('mission','project','Mission','Goal',1,?,?)
    `).run(NOW, NOW);
    database.prepare(`
      INSERT INTO mission_delivery_heads(
        mission_id,project_id,context_version,state,current_delivery_id,current_operation_id,
        generation_lease_token,generation_lease_expires_at,last_error_code,
        next_event_sequence,version,updated_at
      ) VALUES ('mission','project',1,'ongoing',NULL,NULL,NULL,NULL,NULL,1,1,?)
    `).run(NOW);
    seedReview(database, "finalizing");
    mutate(database);
    const before = persistenceSnapshot(database);
    const { assertInvariants } = await recovery();

    expect(() => assertInvariants(database)).toThrowError(
      expect.objectContaining({ code: "REVIEW_INVARIANT_FAILED" }),
    );
    expect(persistenceSnapshot(database)).toEqual(before);
  });
});
