import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { ExecutionError } from "@/src/modules/safe-execution";
import {
  createWindowsVerifiedMergeAdapter,
  type MergeVerifiedAdapter,
} from "@/src/adapters/outbound/workspace/merge-verified-adapter";
import { execV7Fixture } from "@/tests/fixtures/execution/current-graph";
import { refreshExecutionFrozenFixture } from "@/tests/fixtures/execution/frozen-input";

vi.mock("server-only", () => ({}));

type CommitPoint =
  | "before_precommit_check"
  | "after_precommit_check"
  | "before_db_commit"
  | "after_db_commit"
  | "after_postcommit_check"
  | "before_cleanup"
  | "after_cleanup"
  | "before_finalize";

type MergeModule = {
  assertNoMergeBarrier(database: DatabaseSync, projectId: string): void;
  executeMergeCommit(input: {
    database: DatabaseSync;
    hooks?: { point(input: { path: string | null; point: CommitPoint }): void | Promise<void> };
    journalId: string;
  }): Promise<{ body: unknown; status: number }>;
  executeMergePrepare(input: MergeInput): Promise<{ actionId: string; journalId: string }>;
  recoverIncompleteMergeJournals(input: {
    database: DatabaseSync;
    fs?: MergeVerifiedAdapter;
    projectId: string;
  }): Promise<Array<{ body: unknown; status: number }>>;
};

type MergeInput = {
  database: DatabaseSync;
  executionId: string;
  expectedVersion: number;
  journalBaseRoot: string;
  operationId: string;
  projectId: string;
  stagedHash: string;
  workspaceRoot: string;
};

const NOW = "2026-07-30T06:00:00.000Z";
const PROJECT_ID = "merge-project";
const EXECUTION_ID = "merge-execution";
const ATTEMPT_ID = "merge-attempt";
const STAGED_ID = "merge-staged";
const STAGED_HASH = "9".repeat(64);
const HASH = "a".repeat(64);
const roots: string[] = [];
let mergeModule: MergeModule;

const sha256 = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

beforeEach(async () => {
  const candidate = await import("@/src/adapters/outbound/sqlite/safe-execution/merge-journal-service") as Partial<MergeModule>;
  expect(candidate.executeMergeCommit, "T-22 commit service must exist").toBeTypeOf("function");
  expect(candidate.recoverIncompleteMergeJournals, "T-22 recovery service must exist").toBeTypeOf("function");
  expect(candidate.assertNoMergeBarrier, "T-22 public read barrier must exist").toBeTypeOf("function");
  mergeModule = candidate as MergeModule;
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("merge DB commit and restart recovery", () => {
  it("publishes execution, immutable result, links, events, action and exact receipt atomically", async () => {
    const fixture = await createFixture("commit");
    try {
      const prepared = await mergeModule.executeMergePrepare(fixture.input);
      let cleanupObserved = false;
      const committed = await mergeModule.executeMergeCommit({
        database: fixture.database,
        journalId: prepared.journalId,
        hooks: {
          point({ point }) {
            if (point === "before_finalize") {
              expect(existsSync(fixture.journalRoot(prepared.actionId))).toBe(false);
              expect(operationState(fixture.database)).toMatchObject({
                actionStatus: "running",
                operationStatus: "pending",
              });
              cleanupObserved = true;
            }
          },
        },
      });

      expect(cleanupObserved).toBe(true);
      expect(canonicalState(fixture)).toEqual(["new-a", "new-z"]);
      expect(fixture.database.prepare(`
        SELECT e.status,e.merged_at AS mergedAt,w.status AS workItemStatus,
               r.execution_id AS resultExecutionId,r.staged_result_id AS stagedResultId,
               r.merge_journal_id AS journalId,'awaiting_review' AS resultStatus,
               j.status AS journalStatus
        FROM executions e
        JOIN work_items w ON w.id=e.work_item_id
        JOIN work_item_result_versions r ON r.execution_id=e.id
        JOIN execution_merge_journals j ON j.id=r.merge_journal_id
        WHERE e.id=?
      `).get(EXECUTION_ID)).toMatchObject({
        journalId: prepared.journalId,
        journalStatus: "completed",
        resultExecutionId: EXECUTION_ID,
        resultStatus: "awaiting_review",
        stagedResultId: STAGED_ID,
        status: "merged",
        workItemStatus: "in_progress",
      });
      expect(operationState(fixture.database)).toMatchObject({
        actionStatus: "succeeded",
        finalActionIndex: 0,
        operationStatus: "completed",
      });
      expect(JSON.parse(operationState(fixture.database).responseJson!)).toEqual(committed.body);
      expect(fixture.database.prepare(
        "SELECT type FROM execution_events WHERE execution_id=? ORDER BY sequence",
      ).all(EXECUTION_ID)).toEqual([
        { type: "status_changed" },
        { type: "merged" },
        { type: "action_finished" },
      ]);
      mergeModule.assertNoMergeBarrier(fixture.database, PROJECT_ID);

      const replay = await mergeModule.executeMergeCommit({
        database: fixture.database,
        journalId: prepared.journalId,
      });
      expect(replay).toEqual(committed);
      expect(fixture.database.prepare(
        "SELECT count(*) AS count FROM work_item_result_versions",
      ).get()).toEqual({ count: 1 });
      expect(fixture.database.prepare(
        "SELECT count(*) AS count FROM execution_events",
      ).get()).toEqual({ count: 3 });
    } finally {
      fixture.database.close();
    }
  });

  it.each([
    "before_precommit_check",
    "after_precommit_check",
    "before_db_commit",
  ] satisfies CommitPoint[])("recovers crash at %s to all-old and exact pre-state", async (point) => {
    const fixture = await createFixture(`pre-${point}`);
    const prepared = await mergeModule.executeMergePrepare(fixture.input);
    await expect(mergeModule.executeMergeCommit({
      database: fixture.database,
      journalId: prepared.journalId,
      hooks: { point: ({ point: current }) => {
        if (current === point) throw new Error(`crash:${point}`);
      } },
    })).rejects.toThrow(`crash:${point}`);
    fixture.restart();
    expect(() => mergeModule.assertNoMergeBarrier(fixture.database, PROJECT_ID))
      .toThrowError(expect.objectContaining({ code: "MERGE_RECOVERY_REQUIRED" }));

    await mergeModule.recoverIncompleteMergeJournals({
      database: fixture.database,
      projectId: PROJECT_ID,
    });
    expect(canonicalState(fixture)).toEqual(["old-a", null]);
    expect(fixture.database.prepare(
      "SELECT status,merged_at AS mergedAt FROM executions WHERE id=?",
    ).get(EXECUTION_ID)).toEqual({ mergedAt: null, status: "staged" });
    expect(fixture.database.prepare(
      "SELECT count(*) AS count FROM work_item_result_versions",
    ).get()).toEqual({ count: 0 });
    expect(operationState(fixture.database)).toMatchObject({
      actionStatus: "interrupted",
      operationStatus: "completed",
    });
    mergeModule.assertNoMergeBarrier(fixture.database, PROJECT_ID);
    await mergeModule.recoverIncompleteMergeJournals({
      database: fixture.database,
      projectId: PROJECT_ID,
    });
    expect(canonicalState(fixture)).toEqual(["old-a", null]);
    fixture.database.close();
  });

  it.each([
    "after_db_commit",
    "after_postcommit_check",
    "before_cleanup",
    "after_cleanup",
    "before_finalize",
  ] satisfies CommitPoint[])("recovers crash at %s by rolling forward all-new", async (point) => {
    const fixture = await createFixture(`post-${point}`);
    const prepared = await mergeModule.executeMergePrepare(fixture.input);
    await expect(mergeModule.executeMergeCommit({
      database: fixture.database,
      journalId: prepared.journalId,
      hooks: { point: ({ point: current }) => {
        if (current === point) throw new Error(`crash:${point}`);
      } },
    })).rejects.toThrow(`crash:${point}`);
    fixture.restart();

    const recovered = await mergeModule.recoverIncompleteMergeJournals({
      database: fixture.database,
      projectId: PROJECT_ID,
    });
    expect(recovered).toHaveLength(1);
    expect(canonicalState(fixture)).toEqual(["new-a", "new-z"]);
    const result = fixture.database.prepare(`
      SELECT e.status,e.merged_at AS mergedAt,r.id AS resultId,
             r.staged_result_id AS stagedResultId,j.status AS journalStatus
      FROM executions e
      JOIN work_item_result_versions r ON r.execution_id=e.id
      JOIN execution_merge_journals j ON j.id=r.merge_journal_id
      WHERE e.id=?
    `).get(EXECUTION_ID) as Record<string, unknown>;
    expect(result).toMatchObject({
      journalStatus: "completed",
      stagedResultId: STAGED_ID,
      status: "merged",
    });
    expect(result.mergedAt).toEqual(expect.any(String));
    expect(result.resultId).toEqual(expect.any(String));
    const operation = operationState(fixture.database);
    expect(operation).toMatchObject({
      actionStatus: "succeeded",
      operationStatus: "completed",
    });
    expect(JSON.parse(operation.responseJson!)).toEqual(recovered[0].body);
    expect(existsSync(fixture.journalRoot(prepared.actionId))).toBe(false);

    const late = await mergeModule.executeMergeCommit({
      database: fixture.database,
      journalId: prepared.journalId,
    });
    expect(late).toEqual(recovered[0]);
    expect(fixture.database.prepare(
      "SELECT count(*) AS count FROM execution_events",
    ).get()).toEqual({ count: 3 });
    fixture.database.close();
  });

  it("makes restart capability failure durably manual before returning", async () => {
    const fixture = await createFixture("capability-manual");
    const prepared = await mergeModule.executeMergePrepare(fixture.input);
    await expect(mergeModule.executeMergeCommit({
      database: fixture.database,
      journalId: prepared.journalId,
      hooks: {
        point({ point }) {
          if (point === "before_precommit_check") throw new Error("restart");
        },
      },
    })).rejects.toThrow("restart");
    fixture.restart();
    const base = createWindowsVerifiedMergeAdapter();
    await expect(mergeModule.recoverIncompleteMergeJournals({
      database: fixture.database,
      fs: {
        ...base,
        async assertCapability() {
          throw new ExecutionError(
            "SANDBOX_UNVERIFIABLE",
            422,
            "Injected restart capability failure.",
          );
        },
      },
      projectId: PROJECT_ID,
    })).rejects.toMatchObject({ code: "MANUAL_RECOVERY_REQUIRED" });
    expect(fixture.database.prepare(`
      SELECT e.manual_recovery_required AS manualRecoveryRequired,
             j.status,j.mismatch_path_key AS mismatchPathKey,
             a.status AS actionStatus,o.status AS operationStatus,o.http_status AS httpStatus
      FROM execution_merge_journals j
      JOIN executions e ON e.id=j.execution_id
      JOIN execution_actions a ON a.id=j.merge_action_id
      JOIN execution_operations o ON o.project_id=j.project_id AND o.id=j.operation_id
      WHERE j.id=?
    `).get(prepared.journalId)).toEqual({
      actionStatus: "failed",
      httpStatus: 409,
      manualRecoveryRequired: 1,
      mismatchPathKey: null,
      operationStatus: "completed",
      status: "manual_recovery",
    });
    fixture.database.close();
  });
});

function canonicalState(fixture: Fixture): [string, string | null] {
  const added = join(fixture.workspaceRoot, "src/z.txt");
  return [
    readFileSync(join(fixture.workspaceRoot, "src/a.txt"), "utf8"),
    existsSync(added) ? readFileSync(added, "utf8") : null,
  ];
}

function operationState(database: DatabaseSync) {
  return database.prepare(`
    SELECT o.status AS operationStatus,o.final_action_index AS finalActionIndex,
           o.response_json AS responseJson,a.status AS actionStatus
    FROM execution_operations o
    JOIN execution_actions a ON a.project_id=o.project_id AND a.operation_id=o.id
    WHERE o.project_id=? AND o.kind='merge'
  `).get(PROJECT_ID) as {
    actionStatus: string;
    finalActionIndex: number | null;
    operationStatus: string;
    responseJson: string | null;
  };
}

type Fixture = Awaited<ReturnType<typeof createFixture>>;

async function createFixture(label: string) {
  const root = mkdtempSync(join(tmpdir(), `cool-ai-recovery-${label}-`));
  roots.push(root);
  const databasePath = join(root, "cockpit.sqlite");
  const workspaceRoot = join(root, "workspace");
  const sandboxRoot = join(root, "execution", "attempt", "sandbox");
  const journalBaseRoot = join(root, "execution", "attempt", "merge");
  await mkdir(join(workspaceRoot, "src"), { recursive: true });
  await mkdir(join(sandboxRoot, "src"), { recursive: true });
  writeFileSync(join(workspaceRoot, "src/a.txt"), "old-a");
  writeFileSync(join(sandboxRoot, "src/a.txt"), "new-a");
  writeFileSync(join(sandboxRoot, "src/z.txt"), "new-z");
  let database = openDatabase(databasePath);
  seedDatabase(databasePath, database, { sandboxRoot, workspaceRoot });
  const operationId = `00000000-0000-4000-8000-${sha256(label).slice(0, 12)}`;
  const fixture = {
    get database() { return database; },
    input: {} as MergeInput,
    journalRoot: (actionId: string) => join(journalBaseRoot, actionId),
    restart() {
      database.close();
      database = openDatabase(databasePath);
      fixture.input.database = database;
    },
    workspaceRoot,
  };
  fixture.input = {
    database,
    executionId: EXECUTION_ID,
    expectedVersion: 7,
    journalBaseRoot,
    operationId,
    projectId: PROJECT_ID,
    stagedHash: STAGED_HASH,
    workspaceRoot,
  };
  return fixture;
}

function seedDatabase(
  databasePath: string,
  database: DatabaseSync,
  paths: { sandboxRoot: string; workspaceRoot: string },
): void {
  const workspace = paths.workspaceRoot.replaceAll("'", "''");
  const sandbox = paths.sandboxRoot.replaceAll("'", "''");
  execV7Fixture(databasePath, database, `
    INSERT INTO projects (id,name,created_at,workspace_path,workspace_key,version)
    VALUES ('${PROJECT_ID}','Merge','${NOW}','${workspace}','${workspace.toLowerCase()}',1);
    INSERT INTO providers (
      id,name,base_url,default_model,api_key_cipher,api_key_iv,api_key_tag,
      credential_version,credential_generation,key_id,api_key_mask,verified_at,
      version,created_at,updated_at
    ) VALUES ('provider','Provider','http://127.0.0.1','model','c','i','t',1,1,'k','***',
      '${NOW}',1,'${NOW}','${NOW}');
    INSERT INTO agents (
      id,name,role,system_prompt,provider_id,model,avatar_text,accent_token,
      can_read,can_write,can_execute,max_tokens,max_handoffs,version,created_at,updated_at
    ) VALUES ('agent','Agent','Builder','private','provider','model','A','sage',
      1,1,1,1000,5,1,'${NOW}','${NOW}');
    INSERT INTO project_memberships (project_id,agent_id,joined_at)
    VALUES ('${PROJECT_ID}','agent','${NOW}');
    INSERT INTO missions (id,project_id,title,goal,version,created_at,updated_at)
    VALUES ('mission','${PROJECT_ID}','Mission','Goal',1,'${NOW}','${NOW}');
    INSERT INTO mission_delivery_heads(
      mission_id,project_id,context_version,state,current_delivery_id,current_operation_id,
      generation_lease_token,generation_lease_expires_at,last_error_code,
      next_event_sequence,version,updated_at
    ) VALUES ('mission','${PROJECT_ID}',1,'ongoing',NULL,NULL,NULL,NULL,NULL,2,1,'${NOW}');
    INSERT INTO review_events(
      id,project_id,mission_id,sequence,type,actor_type,actor_id,payload_json,created_at
    ) VALUES ('merge-review-init','${PROJECT_ID}','mission',1,
      'mission_review_initialized','system',NULL,
      '{"contextVersion":1,"headVersion":1,"missionId":"mission"}','${NOW}');
    INSERT INTO work_items (
      id,mission_id,title,description,status,assignee_agent_id,version,created_at,updated_at
    ) VALUES ('work','mission','Work','','in_progress','agent',1,'${NOW}','${NOW}');
    INSERT INTO collaboration_runs (
      id,project_id,status,current_agent_id,round_count,next_event_sequence,
      version,execution_epoch,pause_reason,pause_category,created_at,updated_at
    ) VALUES ('run','${PROJECT_ID}','planned','agent',1,1,1,1,NULL,NULL,'${NOW}','${NOW}');
    INSERT INTO project_validation_policy_revisions (
      id,project_id,created_operation_id,created_actor_type,revision_no,policy_hash,
      classifier_version,warning_accepted,canonical_bytes,entry_count,created_at
    ) VALUES ('policy','${PROJECT_ID}',NULL,'system',1,
      '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
      1,0,2,0,'${NOW}');
    INSERT INTO project_validation_policies(project_id,active_revision_id,version,updated_at)
    VALUES ('${PROJECT_ID}','policy',1,'${NOW}');
    INSERT INTO executions (
      id,project_id,source_collaboration_run_id,mission_id,work_item_id,agent_id,
      current_policy_revision_id,status,resume_target,reason_code,
      manual_recovery_required,recovery_resolution,current_attempt_no,
      business_round_count,tool_call_count,next_event_sequence,version,created_at,
      business_deadline_at,first_running_at,updated_at,merged_at
    ) VALUES ('${EXECUTION_ID}','${PROJECT_ID}','run','mission','work','agent','policy',
      'staged',NULL,NULL,0,NULL,1,0,0,1,7,'${NOW}',
      '2026-07-30T06:15:00.000Z','${NOW}','${NOW}',NULL);
    INSERT INTO execution_attempts (
      id,project_id,execution_id,attempt_no,status,sandbox_root,
      baseline_manifest_path,baseline_manifest_hash,sandbox_manifest_hash,
      frozen_public_json,frozen_private_json,frozen_context_hash,
      frozen_policy_revision_id,frozen_policy_version,frozen_policy_hash,
      started_at,finished_at
    ) VALUES ('${ATTEMPT_ID}','${PROJECT_ID}','${EXECUTION_ID}',1,'ready','${sandbox}',
      NULL,'${"b".repeat(64)}','${"e".repeat(64)}','{}','{}','${"c".repeat(64)}',
      'policy',1,'${"d".repeat(64)}','${NOW}',NULL);
    INSERT INTO execution_operations (
      id,project_id,execution_id,kind,request_hash,has_external_actions,action_count,
      final_action_index,status,http_status,response_json,created_at,updated_at
    ) VALUES ('stage-op','${PROJECT_ID}','${EXECUTION_ID}','stage','${HASH}',1,1,0,
      'completed',200,'{}','${NOW}','${NOW}');
    INSERT INTO execution_actions (
      id,project_id,execution_id,attempt_id,operation_id,action_index,kind,status,
      request_hash,overall_deadline_at,result_json,created_at,started_at,finished_at
    ) VALUES ('stage-action','${PROJECT_ID}','${EXECUTION_ID}','${ATTEMPT_ID}','stage-op',0,
      'stage_compute','succeeded','${HASH}','2026-07-30T06:15:00.000Z','{}',
      '${NOW}','${NOW}','${NOW}');
    INSERT INTO execution_staged_results (
      id,project_id,execution_id,attempt_id,action_id,baseline_manifest_hash,
      sandbox_manifest_hash,context_hash,policy_hash,staged_hash,observed_path_count,
      observed_final_bytes,merge_file_count,merge_final_bytes,blocker_count,
      classification,block_reasons_json,created_at
    ) VALUES ('${STAGED_ID}','${PROJECT_ID}','${EXECUTION_ID}','${ATTEMPT_ID}','stage-action',
      '${"b".repeat(64)}','${"e".repeat(64)}','${"c".repeat(64)}','${"d".repeat(64)}',
      '${STAGED_HASH}',2,10,2,10,0,'auto_eligible','[]','${NOW}');
    INSERT INTO execution_staged_observations (
      id,staged_result_id,position,path,path_key,kind,baseline_hash,observed_hash,
      final_size,diff_text,diff_bytes,diff_truncated
    ) VALUES
      ('obs-a','${STAGED_ID}',0,'src/a.txt','src/a.txt','modified','${sha256("old-a")}',
       '${sha256("new-a")}',5,NULL,0,0),
      ('obs-z','${STAGED_ID}',1,'src/z.txt','src/z.txt','added',NULL,
       '${sha256("new-z")}',5,NULL,0,0);
    INSERT INTO execution_staged_files (
      id,staged_result_id,observation_id,position,path,path_key,kind,
      baseline_hash,staged_hash,size
    ) VALUES
      ('file-a','${STAGED_ID}','obs-a',0,'src/a.txt','src/a.txt','modified',
       '${sha256("old-a")}','${sha256("new-a")}',5),
      ('file-z','${STAGED_ID}','obs-z',1,'src/z.txt','src/z.txt','added',
       NULL,'${sha256("new-z")}',5);
  `);
  refreshExecutionFrozenFixture(database, EXECUTION_ID);
}
