import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import { openDatabase } from "@/src/server/db";
import { compareCanonicalPathStates } from "@/src/server/execution/execution-conflicts";
import {
  executeMergeCommit,
  executeMergePrepare,
  type MergeFaultPoint,
  recoverIncompleteMergeJournals,
  resolveManualRecovery,
} from "@/src/server/execution/merge-journal-service";

vi.mock("server-only", () => ({}));

const roots: string[] = [];
const NOW = "2026-07-30T12:00:00.000Z";
const HASH = "a".repeat(64);
const STAGED_HASH = "9".repeat(64);
const PROJECT_ID = "fault-project";
const EXECUTION_ID = "fault-execution";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function operationId(index: number): string {
  return `31000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

type Fixture = {
  database: DatabaseSync;
  databasePath: string;
  input: {
    database: DatabaseSync;
    executionId: string;
    expectedVersion: number;
    journalBaseRoot: string;
    operationId: string;
    projectId: string;
    stagedHash: string;
    workspaceRoot: string;
  };
  root: string;
  workspaceRoot: string;
};

async function fixture(index: number): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), `cool-ai-t31-merge-${index}-`));
  roots.push(root);
  const workspaceRoot = join(root, "workspace");
  const sandboxRoot = join(root, "execution", "attempt", "sandbox");
  const journalBaseRoot = join(root, "execution", "attempt", "merge");
  await mkdir(join(workspaceRoot, "src"), { recursive: true });
  await mkdir(join(sandboxRoot, "src"), { recursive: true });
  writeFileSync(join(workspaceRoot, "src", "a.txt"), "old-a");
  writeFileSync(join(sandboxRoot, "src", "a.txt"), "new-a");
  const databasePath = join(root, "cockpit.sqlite");
  const database = openDatabase(databasePath);
  seed(database, workspaceRoot, sandboxRoot);
  return {
    database,
    databasePath,
    input: {
      database,
      executionId: EXECUTION_ID,
      expectedVersion: 7,
      journalBaseRoot,
      operationId: operationId(index),
      projectId: PROJECT_ID,
      stagedHash: STAGED_HASH,
      workspaceRoot,
    },
    root,
    workspaceRoot,
  };
}

function seed(database: DatabaseSync, workspaceRoot: string, sandboxRoot: string): void {
  const workspace = workspaceRoot.replaceAll("'", "''");
  const sandbox = sandboxRoot.replaceAll("'", "''");
  database.exec(`
    INSERT INTO projects (id,name,created_at,workspace_path,workspace_key,version)
    VALUES ('${PROJECT_ID}','Faults','${NOW}','${workspace}','${workspace.toLowerCase()}',1);
    INSERT INTO providers (
      id,name,base_url,default_model,api_key_cipher,api_key_iv,api_key_tag,
      credential_version,credential_generation,key_id,api_key_mask,verified_at,
      version,created_at,updated_at
    ) VALUES ('provider','Provider','http://127.0.0.1','model','cipher-marker','iv','tag',
      1,1,'master-key-marker','***','${NOW}',1,'${NOW}','${NOW}');
    INSERT INTO agents (
      id,name,role,system_prompt,provider_id,model,avatar_text,accent_token,
      can_read,can_write,can_execute,max_tokens,max_handoffs,version,created_at,updated_at
    ) VALUES ('agent','Agent','Builder','hidden-chain-of-thought','provider','model','A','sage',
      1,1,1,1000,5,1,'${NOW}','${NOW}');
    INSERT INTO project_memberships (project_id,agent_id,joined_at)
    VALUES ('${PROJECT_ID}','agent','${NOW}');
    INSERT INTO missions (id,project_id,title,goal,version,created_at,updated_at)
    VALUES ('mission','${PROJECT_ID}','Mission','Goal',1,'${NOW}','${NOW}');
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
      '2026-07-30T12:15:00.000Z','${NOW}','${NOW}',NULL);
    INSERT INTO execution_attempts (
      id,project_id,execution_id,attempt_no,status,sandbox_root,
      baseline_manifest_path,baseline_manifest_hash,sandbox_manifest_hash,
      frozen_public_json,frozen_private_json,frozen_context_hash,
      frozen_policy_revision_id,frozen_policy_version,frozen_policy_hash,
      started_at,finished_at
    ) VALUES ('attempt','${PROJECT_ID}','${EXECUTION_ID}',1,'ready','${sandbox}',
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
    ) VALUES ('stage-action','${PROJECT_ID}','${EXECUTION_ID}','attempt','stage-op',0,
      'stage_compute','succeeded','${HASH}','2026-07-30T12:15:00.000Z','{}',
      '${NOW}','${NOW}','${NOW}');
    INSERT INTO execution_staged_results (
      id,project_id,execution_id,attempt_id,action_id,baseline_manifest_hash,
      sandbox_manifest_hash,context_hash,policy_hash,staged_hash,observed_path_count,
      observed_final_bytes,merge_file_count,merge_final_bytes,blocker_count,
      classification,block_reasons_json,created_at
    ) VALUES ('staged','${PROJECT_ID}','${EXECUTION_ID}','attempt','stage-action',
      '${"b".repeat(64)}','${"e".repeat(64)}','${"c".repeat(64)}','${"d".repeat(64)}',
      '${STAGED_HASH}',1,5,1,5,0,'auto_eligible','[]','${NOW}');
    INSERT INTO execution_staged_observations (
      id,staged_result_id,position,path,path_key,kind,baseline_hash,observed_hash,
      final_size,diff_text,diff_bytes,diff_truncated
    ) VALUES ('observation','staged',0,'src/a.txt','src/a.txt','modified',
      '${sha256("old-a")}','${sha256("new-a")}',5,NULL,0,0);
    INSERT INTO execution_staged_files (
      id,staged_result_id,observation_id,position,path,path_key,kind,
      baseline_hash,staged_hash,size
    ) VALUES ('file','staged','observation',0,'src/a.txt','src/a.txt','modified',
      '${sha256("old-a")}','${sha256("new-a")}',5);
  `);
}

function databaseSecurityScan(database: DatabaseSync): string {
  const tables = database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type='table' AND name LIKE 'execution_%'
    ORDER BY name
  `).all() as Array<{ name: string }>;
  return JSON.stringify(Object.fromEntries(tables.map(({ name }) => [
    name,
    database.prepare(`SELECT * FROM "${name}"`).all(),
  ])));
}

describe("merge fault injection integration", () => {
  it("recovers every pre-commit fault to all-old with no result or late completion", async () => {
    const points: MergeFaultPoint[] = [
      "before_prepare",
      "after_old_read",
      "after_backup",
      "after_durable_new",
      "after_journal_persist",
      "before_apply_file",
      "after_temp_write",
      "before_replace",
      "after_replace",
      "after_file_mark",
      "after_all_files",
    ];
    for (const [index, target] of points.entries()) {
      const item = await fixture(index + 1);
      await expect(executeMergePrepare({
        ...item.input,
        hooks: {
          point({ point }) {
            if (point === target) throw new Error(`fault:${target}`);
          },
        },
      })).rejects.toThrow();
      await recoverIncompleteMergeJournals({
        database: item.database,
        projectId: PROJECT_ID,
      }).catch(() => undefined);
      expect(readFileSync(join(item.workspaceRoot, "src", "a.txt"), "utf8"), target)
        .toBe("old-a");
      expect(item.database.prepare(
        "SELECT COUNT(*) AS count FROM work_item_execution_results",
      ).get()).toEqual({ count: 0 });
      item.database.close();
    }
  }, 30_000);

  it("reopens and recovers every commit-to-finalize fault to one coherent result", async () => {
    const points: MergeFaultPoint[] = [
      "before_precommit_check",
      "after_precommit_check",
      "before_db_commit",
      "after_db_commit",
      "after_postcommit_check",
      "before_cleanup",
      "after_cleanup",
      "before_finalize",
    ];
    for (const [index, target] of points.entries()) {
      const item = await fixture(index + 100);
      const prepared = await executeMergePrepare(item.input);
      await expect(executeMergeCommit({
        database: item.database,
        hooks: {
          point({ point }) {
            if (point === target) throw new Error(`fault:${target}`);
          },
        },
        journalId: prepared.journalId,
      })).rejects.toThrow();
      item.database.close();
      item.database = openDatabase(item.databasePath);
      item.input.database = item.database;
      await recoverIncompleteMergeJournals({
        database: item.database,
        projectId: PROJECT_ID,
      });
      const canonical = readFileSync(join(item.workspaceRoot, "src", "a.txt"), "utf8");
      const result = item.database.prepare(
        "SELECT COUNT(*) AS count FROM work_item_execution_results",
      ).get() as { count: number };
      expect(
        (canonical === "old-a" && result.count === 0)
        || (canonical === "new-a" && result.count === 1),
        target,
      ).toBe(true);
      expect(item.database.prepare(
        "SELECT COUNT(*) AS count FROM execution_actions WHERE status='running'",
      ).get()).toEqual({ count: 0 });
      item.database.close();
    }
  }, 30_000);

  it("preserves an external writer, requires manual resolution, and replays abandon exactly", async () => {
    const item = await fixture(300);
    await expect(executeMergePrepare({
      ...item.input,
      hooks: {
        async point({ path, point }) {
          if (point === "after_replace" && path === "src/a.txt") {
            await writeFile(join(item.workspaceRoot, path), "external-writer");
            throw new Error("external writer");
          }
        },
      },
    })).rejects.toMatchObject({ code: "MANUAL_RECOVERY_REQUIRED" });
    expect(readFileSync(join(item.workspaceRoot, "src", "a.txt"), "utf8"))
      .toBe("external-writer");
    const state = item.database.prepare(`
      SELECT e.version,j.observed_manifest_hash AS observedManifestHash
      FROM executions e JOIN execution_merge_journals j ON j.execution_id=e.id
      WHERE e.id=?
    `).get(EXECUTION_ID) as { observedManifestHash: string; version: number };
    const resolution = {
      action: "abandon" as const,
      database: item.database,
      executionId: EXECUTION_ID,
      expectedVersion: state.version,
      observedManifestHash: state.observedManifestHash,
      operationId: operationId(301),
      projectId: PROJECT_ID,
    };
    const first = await resolveManualRecovery(resolution);
    expect(await resolveManualRecovery(resolution)).toEqual(first);
    expect(first.status).toBe(200);
    expect(readFileSync(join(item.workspaceRoot, "src", "a.txt"), "utf8"))
      .toBe("external-writer");
    expect(item.database.prepare(`
      SELECT status,manual_recovery_required AS manualRecoveryRequired,recovery_resolution AS resolution
      FROM executions WHERE id=?
    `).get(EXECUTION_ID)).toEqual({
      manualRecoveryRequired: 0,
      resolution: "abandoned",
      status: "stopped",
    });
    expect(databaseSecurityScan(item.database)).not.toMatch(
      /master-key-marker|cipher-marker|hidden-chain-of-thought|Authorization|raw-environment-marker/i,
    );
    item.database.close();
  });

  it("treats same relevant paths as stale while non-overlap remains current", () => {
    const frozen = [{
      exists: true,
      identity: "identity-a",
      path: "src/a.txt",
      sha256: HASH,
    }];
    const changed = [{
      exists: true,
      identity: "identity-b",
      path: "src/a.txt",
      sha256: "b".repeat(64),
    }];
    expect(compareCanonicalPathStates({
      current: changed,
      frozen,
      relevantPaths: ["src/a.txt"],
    }).disposition).toBe("stale");
    expect(compareCanonicalPathStates({
      current: changed,
      frozen,
      relevantPaths: ["src/b.txt"],
    }).disposition).toBe("current");
    expect(existsSync(join(roots[0] ?? "", "not-created"))).toBe(false);
  });
});
