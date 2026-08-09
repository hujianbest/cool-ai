import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import * as reviewSlice from "@/src/server/review/review-slice-service";

type ResultInput = {
  executionId: string;
  executorAgentId: string;
  mergeJournalId: string;
  missionId: string;
  projectId: string;
  resultId: string;
  stagedResultId: string;
  workItemId: string;
};

type ResultVersionModule = {
  advanceResultHeadTx?: (
    database: DatabaseSync,
    input: ResultInput & { expectedHeadVersion: number; expectedResultId: string },
  ) => { resultId: string; version: number };
  initializeFirstResultHeadTx?: (
    database: DatabaseSync,
    input: ResultInput,
  ) => { resultId: string; version: number };
  requestResultReworkTx?: (
    database: DatabaseSync,
    input: {
      expectedAttemptId: string | null;
      expectedHeadVersion: number;
      expectedResultId: string;
      workItemId: string;
    },
  ) => void;
  readReviewWorkspaceTx?: (
    database: DatabaseSync,
    workItemId: string,
  ) => {
    result: {
      source: {
        contextHash: string;
        projectId: string;
        runId: string;
        threadId: string;
      };
    };
  };
};

const resultVersions = reviewSlice as ResultVersionModule;
const NOW = "2026-08-01T04:00:00.000Z";
let directory: string;
let database: DatabaseSync;
let databasePath: string;

function seed(): void {
  database.exec("PRAGMA foreign_keys=OFF");
  database.exec(`
    INSERT INTO projects(id,name,created_at,version)
    VALUES ('project','Result versions','${NOW}',1);
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
    ) VALUES ('executor','Executor','Builder','Build','provider','model','E','sage',
      1,1,1,1000,2,1,'${NOW}','${NOW}',0);
    INSERT INTO project_memberships(project_id,agent_id,joined_at)
    VALUES ('project','executor','${NOW}');
    INSERT INTO missions(id,project_id,title,goal,version,created_at,updated_at)
    VALUES ('mission','project','Mission','Goal',1,'${NOW}','${NOW}');
    INSERT INTO work_items(
      id,mission_id,title,description,status,assignee_agent_id,version,created_at,updated_at
    ) VALUES ('work','mission','Work','','in_progress','executor',1,'${NOW}','${NOW}');
    INSERT INTO mission_delivery_heads(
      mission_id,project_id,context_version,state,current_delivery_id,current_operation_id,
      generation_lease_token,generation_lease_expires_at,last_error_code,
      next_event_sequence,version,updated_at
    ) VALUES ('mission','project',1,'ongoing',NULL,NULL,NULL,NULL,NULL,2,1,'${NOW}');
    INSERT INTO review_events(
      id,project_id,mission_id,sequence,type,actor_type,actor_id,payload_json,created_at
    ) VALUES ('event-1','project','mission',1,'mission_review_initialized','system',NULL,'{}','${NOW}');
    INSERT INTO collaboration_runs(
      id,project_id,thread_id,status,current_agent_id,round_count,next_event_sequence,
      version,execution_epoch,pause_reason,pause_category,created_at,updated_at
    ) VALUES ('run','project','thread','stopped','executor',0,1,1,1,NULL,NULL,'${NOW}','${NOW}');
  `);
  for (const version of [1, 2, 3]) {
    database.exec(`
      INSERT INTO executions(
        id,project_id,source_collaboration_thread_id,source_collaboration_run_id,
        mission_id,work_item_id,agent_id,
        current_policy_revision_id,status,resume_target,reason_code,
        manual_recovery_required,recovery_resolution,current_attempt_no,
        business_round_count,tool_call_count,next_event_sequence,version,created_at,
        business_deadline_at,first_running_at,updated_at,merged_at
      ) VALUES ('execution-${version}','project','thread','run','mission','work','executor','policy',
        'merged',NULL,NULL,0,NULL,1,0,0,1,2,'${NOW}',
        '2026-08-01T04:15:00.000Z','${NOW}','${NOW}','${NOW}');
      INSERT INTO execution_attempts(
        id,project_id,execution_id,attempt_no,status,sandbox_root,
        baseline_manifest_path,sandbox_manifest_path,baseline_manifest_hash,
        sandbox_manifest_hash,frozen_public_json,frozen_private_json,
        frozen_context_hash,frozen_policy_revision_id,frozen_policy_version,
        frozen_policy_hash,started_at,finished_at
      ) VALUES (
        'attempt-${version}','project','execution-${version}',1,'completed','sandbox',
        NULL,NULL,NULL,NULL,'{"facts":{"sourceCollaborationRunId":"run"}}','{}',
        '${"c".repeat(64)}','policy',1,
        '${"d".repeat(64)}','${NOW}','${NOW}'
      );
      INSERT INTO execution_staged_results(
        id,project_id,execution_id,attempt_id,action_id,baseline_manifest_hash,
        sandbox_manifest_hash,context_hash,policy_hash,staged_hash,observed_path_count,
        observed_final_bytes,merge_file_count,merge_final_bytes,blocker_count,
        classification,block_reasons_json,created_at
      ) VALUES ('staged-${version}','project','execution-${version}','attempt-${version}',
        'action-${version}','${"a".repeat(64)}','${"b".repeat(64)}','${"c".repeat(64)}',
        '${"d".repeat(64)}','${String(version).repeat(64)}',1,0,0,0,0,'auto_eligible','[]','${NOW}');
      INSERT INTO execution_merge_journals(
        id,project_id,execution_id,attempt_id,operation_id,merge_action_id,staged_result_id,
        old_manifest_hash,post_manifest_hash,status,journal_root,created_at,updated_at
      ) VALUES ('journal-${version}','project','execution-${version}','attempt-${version}',
        'operation-${version}','action-${version}','staged-${version}',
        '${"a".repeat(64)}','${"b".repeat(64)}','completed','journal-${version}','${NOW}','${NOW}');
    `);
  }
  database.exec("PRAGMA foreign_keys=ON");
}

const input = (version: number): ResultInput => ({
  executionId: `execution-${version}`,
  executorAgentId: "executor",
  mergeJournalId: `journal-${version}`,
  missionId: "mission",
  projectId: "project",
  resultId: `result-${version}`,
  stagedResultId: `staged-${version}`,
  workItemId: "work",
});

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "result-version-rework-"));
  databasePath = join(directory, "cockpit.sqlite");
  database = openDatabase(databasePath);
  seed();
});

afterEach(() => {
  database.close();
  rmSync(directory, { force: true, recursive: true });
});

describe("immutable result version chain", () => {
  it("reads a migrated v6 frozen package from the execution tuple without choosing a later run", () => {
    expect(resultVersions.initializeFirstResultHeadTx).toBeTypeOf("function");
    expect(resultVersions.readReviewWorkspaceTx).toBeTypeOf("function");
    database.exec("BEGIN IMMEDIATE");
    resultVersions.initializeFirstResultHeadTx!(database, input(1));
    database.exec("COMMIT");

    expect(resultVersions.readReviewWorkspaceTx!(database, "work").result.source)
      .toEqual({
        contextHash: "c".repeat(64),
        projectId: "project",
        runId: "run",
        threadId: "thread",
      });
  });

  it("rejects a migrated v6 frozen package whose legacy run conflicts with the execution tuple", () => {
    expect(resultVersions.initializeFirstResultHeadTx).toBeTypeOf("function");
    expect(resultVersions.readReviewWorkspaceTx).toBeTypeOf("function");
    database.exec("BEGIN IMMEDIATE");
    resultVersions.initializeFirstResultHeadTx!(database, input(1));
    database.exec("COMMIT");
    database.prepare(`
      UPDATE execution_attempts
      SET frozen_public_json='{"facts":{"sourceCollaborationRunId":"other-run"}}'
      WHERE id='attempt-1'
    `).run();

    expect(() => resultVersions.readReviewWorkspaceTx!(database, "work"))
      .toThrow(expect.objectContaining({ code: "RESULT_NOT_FOUND" }));
  });

  it("atomically initializes result v1, review head and the next mission event", () => {
    expect(resultVersions.initializeFirstResultHeadTx).toBeTypeOf("function");
    database.exec("BEGIN IMMEDIATE");
    const created = resultVersions.initializeFirstResultHeadTx!(database, input(1));
    database.exec("COMMIT");

    expect(created).toEqual({ resultId: "result-1", version: 1 });
    expect(database.prepare(`
      SELECT r.version,r.supersedes_result_id AS supersedesResultId,
             h.current_result_id AS currentResultId,h.state,h.version AS headVersion
      FROM work_item_result_versions r
      JOIN work_item_review_heads h ON h.work_item_id=r.work_item_id
      WHERE r.id='result-1'
    `).get()).toEqual({
      currentResultId: "result-1",
      headVersion: 1,
      state: "pending_review",
      supersedesResultId: null,
      version: 1,
    });
    expect(database.prepare(
      "SELECT sequence,type,payload_json AS payload FROM review_events WHERE sequence=2",
    ).get()).toMatchObject({
      sequence: 2,
      type: "result_version_created",
    });
    expect(() => database.prepare(
      "UPDATE work_item_result_versions SET version=9 WHERE id='result-1'",
    ).run()).toThrow(/IMMUTABLE_RESULT/u);
    expect(() => database.prepare(
      "DELETE FROM work_item_result_versions WHERE id='result-1'",
    ).run()).toThrow(/IMMUTABLE_RESULT/u);
  });

  it("allows exactly one concurrent first-result winner", async () => {
    expect(resultVersions.initializeFirstResultHeadTx).toBeTypeOf("function");
    const path = join(directory, "cockpit.sqlite");
    const attempts = await Promise.allSettled([1, 2].map(async (version) => {
      const contender = new DatabaseSync(path);
      try {
        contender.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
        const created = resultVersions.initializeFirstResultHeadTx!(
          contender,
          input(version),
        );
        contender.exec("COMMIT");
        return created;
      } catch (error) {
        try { contender.exec("ROLLBACK"); } catch { /* preserve conflict */ }
        throw error;
      } finally {
        contender.close();
      }
    }));

    expect(attempts.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect(database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM work_item_result_versions) AS results,
        (SELECT COUNT(*) FROM work_item_review_heads) AS heads,
        (SELECT COUNT(*) FROM review_events WHERE type='result_version_created') AS events
    `).get()).toEqual({ events: 1, heads: 1, results: 1 });
  });

  it("rolls back result and head when the first-result event cannot commit", () => {
    expect(resultVersions.initializeFirstResultHeadTx).toBeTypeOf("function");
    database.exec(`
      CREATE TRIGGER inject_result_event_failure
      BEFORE INSERT ON review_events
      WHEN NEW.type='result_version_created'
      BEGIN SELECT RAISE(ABORT,'injected result event failure'); END
    `);
    database.exec("BEGIN IMMEDIATE");
    expect(() => resultVersions.initializeFirstResultHeadTx!(database, input(1)))
      .toThrow(/injected result event failure/u);
    database.exec("ROLLBACK");
    expect(database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM work_item_result_versions) AS results,
        (SELECT COUNT(*) FROM work_item_review_heads) AS heads,
        (SELECT COUNT(*) FROM review_events) AS events
    `).get()).toEqual({ events: 1, heads: 0, results: 0 });
  });

  it("advances only a current rework head to consecutive immutable versions", () => {
    expect(resultVersions.initializeFirstResultHeadTx).toBeTypeOf("function");
    expect(resultVersions.requestResultReworkTx).toBeTypeOf("function");
    expect(resultVersions.advanceResultHeadTx).toBeTypeOf("function");
    database.exec("BEGIN IMMEDIATE");
    resultVersions.initializeFirstResultHeadTx!(database, input(1));
    database.prepare(
      "UPDATE work_item_review_heads SET state='waiting_owner' WHERE work_item_id='work'",
    ).run();
    resultVersions.requestResultReworkTx!(database, {
      expectedAttemptId: null,
      expectedHeadVersion: 1,
      expectedResultId: "result-1",
      workItemId: "work",
    });
    const second = resultVersions.advanceResultHeadTx!(database, {
      ...input(2),
      expectedHeadVersion: 2,
      expectedResultId: "result-1",
    });
    database.exec("COMMIT");

    expect(second).toEqual({ resultId: "result-2", version: 2 });
    expect(database.prepare(`
      SELECT id,version,supersedes_result_id AS prior FROM work_item_result_versions
      ORDER BY version
    `).all()).toEqual([
      { id: "result-1", prior: null, version: 1 },
      { id: "result-2", prior: "result-1", version: 2 },
    ]);
    expect(() => resultVersions.requestResultReworkTx!(database, {
      expectedAttemptId: null,
      expectedHeadVersion: 1,
      expectedResultId: "result-1",
      workItemId: "work",
    })).toThrowError(expect.objectContaining({ code: "REVIEW_STATE_CONFLICT" }));
  });

  it("allows one concurrent next-version winner and leaves no branch", async () => {
    expect(resultVersions.initializeFirstResultHeadTx).toBeTypeOf("function");
    expect(resultVersions.requestResultReworkTx).toBeTypeOf("function");
    expect(resultVersions.advanceResultHeadTx).toBeTypeOf("function");
    database.exec("BEGIN IMMEDIATE");
    resultVersions.initializeFirstResultHeadTx!(database, input(1));
    database.prepare(
      "UPDATE work_item_review_heads SET state='waiting_owner' WHERE work_item_id='work'",
    ).run();
    resultVersions.requestResultReworkTx!(database, {
      expectedAttemptId: null,
      expectedHeadVersion: 1,
      expectedResultId: "result-1",
      workItemId: "work",
    });
    database.exec("COMMIT");

    const path = join(directory, "cockpit.sqlite");
    const attempts = await Promise.allSettled([2, 3].map(async (version) => {
      const contender = new DatabaseSync(path);
      try {
        contender.exec("PRAGMA foreign_keys=ON");
        contender.exec("BEGIN IMMEDIATE");
        const created = resultVersions.advanceResultHeadTx!(contender, {
          ...input(version),
          expectedHeadVersion: 2,
          expectedResultId: "result-1",
        });
        contender.exec("COMMIT");
        return created;
      } catch (error) {
        try { contender.exec("ROLLBACK"); } catch { /* preserve conflict */ }
        throw error;
      } finally {
        contender.close();
      }
    }));

    const outcomes = attempts.map((attempt) => attempt.status === "fulfilled"
      ? { status: attempt.status, value: attempt.value }
      : {
          code: (attempt.reason as { code?: string }).code,
          message: String(attempt.reason),
          status: attempt.status,
        });
    expect(outcomes).toContainEqual({
      status: "fulfilled",
      value: expect.objectContaining({ version: 2 }),
    });
    expect(outcomes.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM work_item_result_versions",
    ).get()).toEqual({ count: 2 });
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM work_item_result_versions
      WHERE supersedes_result_id='result-1'
    `).get()).toEqual({ count: 1 });
  });
});
