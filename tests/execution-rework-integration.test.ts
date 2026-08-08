import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "@/src/server/db";
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

type ReworkModule = {
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
};

const rework = reviewSlice as ReworkModule;
const NOW = "2026-08-01T04:00:00.000Z";

function resultInput(version: number): ResultInput {
  return {
    executionId: `execution-${version}`,
    executorAgentId: "executor",
    mergeJournalId: `journal-${version}`,
    missionId: "mission",
    projectId: "project",
    resultId: `result-${version}`,
    stagedResultId: `staged-${version}`,
    workItemId: "work",
  };
}

function seed(database: DatabaseSync): void {
  database.exec("PRAGMA foreign_keys=OFF");
  database.exec(`
    INSERT INTO projects(id,name,created_at,version)
    VALUES ('project','Rework integration','${NOW}',1);
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
      ('reviewer','Reviewer','Reviewer','Review','provider','model','R','slate',
       1,0,0,1000,2,1,'${NOW}','${NOW}',1);
    INSERT INTO project_memberships(project_id,agent_id,joined_at) VALUES
      ('project','executor','${NOW}'),('project','reviewer','${NOW}');
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
  `);
  for (const version of [1, 2]) {
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
      INSERT INTO execution_staged_results(
        id,project_id,execution_id,attempt_id,action_id,baseline_manifest_hash,
        sandbox_manifest_hash,context_hash,policy_hash,staged_hash,observed_path_count,
        observed_final_bytes,merge_file_count,merge_final_bytes,blocker_count,
        classification,block_reasons_json,created_at
      ) VALUES ('staged-${version}','project','execution-${version}','execution-attempt-${version}',
        'action-${version}','${"a".repeat(64)}','${"b".repeat(64)}','${"c".repeat(64)}',
        '${"d".repeat(64)}','${String(version).repeat(64)}',1,0,0,0,0,'auto_eligible','[]','${NOW}');
      INSERT INTO execution_merge_journals(
        id,project_id,execution_id,attempt_id,operation_id,merge_action_id,staged_result_id,
        old_manifest_hash,post_manifest_hash,status,journal_root,created_at,updated_at
      ) VALUES ('journal-${version}','project','execution-${version}',
        'execution-attempt-${version}','merge-operation-${version}','action-${version}',
        'staged-${version}','${"a".repeat(64)}','${"b".repeat(64)}',
        'completed','journal-${version}','${NOW}','${NOW}');
    `);
  }
  database.exec("PRAGMA foreign_keys=ON");
}

describe("execution rework result integration", () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("keeps merged executions terminal while moving only the result head", () => {
    expect(rework.initializeFirstResultHeadTx).toBeTypeOf("function");
    expect(rework.requestResultReworkTx).toBeTypeOf("function");
    expect(rework.advanceResultHeadTx).toBeTypeOf("function");
    const directory = mkdtempSync(join(tmpdir(), "execution-rework-"));
    directories.push(directory);
    const database = openDatabase(join(directory, "cockpit.sqlite"));
    seed(database);

    database.exec("BEGIN IMMEDIATE");
    rework.initializeFirstResultHeadTx!(database, resultInput(1));
    database.prepare(
      "UPDATE work_item_review_heads SET state='waiting_owner' WHERE work_item_id='work'",
    ).run();
    rework.requestResultReworkTx!(database, {
      expectedAttemptId: null,
      expectedHeadVersion: 1,
      expectedResultId: "result-1",
      workItemId: "work",
    });
    rework.advanceResultHeadTx!(database, {
      ...resultInput(2),
      expectedHeadVersion: 2,
      expectedResultId: "result-1",
    });
    database.exec("COMMIT");

    expect(database.prepare(
      "SELECT id,status,merged_at AS mergedAt FROM executions ORDER BY id",
    ).all()).toEqual([
      { id: "execution-1", mergedAt: NOW, status: "merged" },
      { id: "execution-2", mergedAt: NOW, status: "merged" },
    ]);
    expect(database.prepare(`
      SELECT h.state,h.current_result_id AS resultId,h.current_attempt_id AS attemptId,
             h.version AS headVersion,r.version AS resultVersion
      FROM work_item_review_heads h
      JOIN work_item_result_versions r ON r.id=h.current_result_id
      WHERE h.work_item_id='work'
    `).get()).toEqual({
      attemptId: null,
      headVersion: 3,
      resultId: "result-2",
      resultVersion: 2,
      state: "pending_review",
    });
    database.close();
  });

  it("does not let a late old-attempt rework overwrite a newer result", () => {
    expect(rework.initializeFirstResultHeadTx).toBeTypeOf("function");
    expect(rework.requestResultReworkTx).toBeTypeOf("function");
    expect(rework.advanceResultHeadTx).toBeTypeOf("function");
    const directory = mkdtempSync(join(tmpdir(), "execution-late-review-"));
    directories.push(directory);
    const database = openDatabase(join(directory, "cockpit.sqlite"));
    seed(database);

    database.exec("BEGIN IMMEDIATE");
    rework.initializeFirstResultHeadTx!(database, resultInput(1));
    database.prepare(
      "UPDATE work_item_review_heads SET state='waiting_owner' WHERE work_item_id='work'",
    ).run();
    rework.requestResultReworkTx!(database, {
      expectedAttemptId: null,
      expectedHeadVersion: 1,
      expectedResultId: "result-1",
      workItemId: "work",
    });
    rework.advanceResultHeadTx!(database, {
      ...resultInput(2),
      expectedHeadVersion: 2,
      expectedResultId: "result-1",
    });
    database.exec("COMMIT");

    expect(() => rework.requestResultReworkTx!(database, {
      expectedAttemptId: "old-attempt",
      expectedHeadVersion: 1,
      expectedResultId: "result-1",
      workItemId: "work",
    })).toThrowError(expect.objectContaining({ code: "REVIEW_STATE_CONFLICT" }));
    expect(database.prepare(`
      SELECT current_result_id AS resultId,state,version
      FROM work_item_review_heads WHERE work_item_id='work'
    `).get()).toEqual({ resultId: "result-2", state: "pending_review", version: 3 });
    database.close();
  });
});
