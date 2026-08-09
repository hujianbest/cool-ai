import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openDatabase } from "@/src/server/db";
import {
  createWindowsVerifiedMergeAdapter,
  type MergeVerifiedAdapter,
} from "@/src/server/execution/merge-verified-adapter";
import {
  execV7Fixture,
  validateFixtureDatabase,
} from "@/tests/fixtures/execution/current-graph";
import { refreshExecutionFrozenFixture } from "@/tests/fixtures/execution/frozen-input";

vi.mock("server-only", () => ({}));

type MergePoint =
  | "before_prepare"
  | "after_old_read"
  | "after_backup"
  | "after_durable_new"
  | "after_journal_persist"
  | "before_apply_file"
  | "after_temp_write"
  | "before_replace"
  | "after_replace"
  | "after_file_mark"
  | "after_all_files";

type MergeModule = {
  executeMergePrepare(input: {
    database: DatabaseSync;
    executionId: string;
    expectedVersion: number;
    fs?: MergeVerifiedAdapter;
    hooks?: {
      point(input: { path: string | null; point: MergePoint }): void | Promise<void>;
    };
    journalBaseRoot: string;
    operationId: string;
    projectId: string;
    stagedHash: string;
    workspaceRoot: string;
  }): Promise<{
    actionId: string;
    journalId: string;
    oldManifestHash: string;
    postManifestHash: string;
  }>;
};

const NOW = "2026-07-30T06:00:00.000Z";
const PROJECT_ID = "merge-project";
const EXECUTION_ID = "merge-execution";
const ATTEMPT_ID = "merge-attempt";
const STAGED_ID = "merge-staged";
const STAGED_HASH = "9".repeat(64);
const HASH = "a".repeat(64);
const directories: string[] = [];
let mergeModule: MergeModule;

const sha256 = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

beforeEach(async () => {
  try {
    mergeModule = await import("@/src/server/execution/merge-journal-service") as MergeModule;
  } catch {
    expect.fail("The T-21 merge journal prepare service is unavailable.");
  }
});

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("merge journal prepare and conditional apply", () => {
  it("fails capability before journal creation or canonical writes", async () => {
    const fixture = await createFixture();
    try {
      await expect(mergeModule.executeMergePrepare({
        ...fixture.input,
        fs: {
          ...createWindowsVerifiedMergeAdapter(),
          async assertCapability() {
            throw Object.assign(new Error("native capability unavailable"), {
              code: "SANDBOX_UNVERIFIABLE",
            });
          },
        },
      })).rejects.toMatchObject({ code: "SANDBOX_UNVERIFIABLE" });

      expect(readFileSync(join(fixture.workspaceRoot, "src/a.txt"), "utf8")).toBe("old-a");
      expect(existsSync(join(fixture.workspaceRoot, "src/z.txt"))).toBe(false);
      expect(fixture.database.prepare(
        "SELECT count(*) AS count FROM execution_merge_journals",
      ).get()).toEqual({ count: 0 });
      expect(fixture.database.prepare(
        "SELECT count(*) AS count FROM execution_operations WHERE kind='merge'",
      ).get()).toEqual({ count: 0 });
    } finally {
      fixture.database.close();
    }
  });

  it("turns a post-journal native uncertainty into a zero-result manual barrier", async () => {
    const fixture = await createFixture("native-uncertain");
    const native = createWindowsVerifiedMergeAdapter();
    try {
      await expect(mergeModule.executeMergePrepare({
        ...fixture.input,
        fs: {
          ...native,
          conditionalReplacePrepared() {
            return { kind: "mutation-uncertain", phase: "rename" };
          },
        },
      })).rejects.toMatchObject({ code: "MANUAL_RECOVERY_REQUIRED" });

      expect(readFileSync(join(fixture.workspaceRoot, "src/a.txt"), "utf8")).toBe("old-a");
      expect(existsSync(join(fixture.workspaceRoot, "src/z.txt"))).toBe(false);
      expect(fixture.database.prepare(`
        SELECT status,error_code AS errorCode FROM execution_merge_journals
      `).get()).toEqual({
        errorCode: "MANUAL_RECOVERY_REQUIRED",
        status: "manual_recovery",
      });
      expect(fixture.database.prepare(
        "SELECT count(*) AS count FROM work_item_result_versions",
      ).get()).toEqual({ count: 0 });
    } finally {
      fixture.database.close();
    }
  });

  it("durably prepares full manifests and applies modified/added paths in stable order", async () => {
    const fixture = await createFixture();
    const points: string[] = [];
    try {
      const result = await mergeModule.executeMergePrepare({
        ...fixture.input,
        hooks: {
          point({ path, point }) {
            points.push(`${point}:${path ?? "-"}`);
          },
        },
      });

      expect(readFileSync(join(fixture.workspaceRoot, "src/a.txt"), "utf8")).toBe("new-a");
      expect(readFileSync(join(fixture.workspaceRoot, "src/z.txt"), "utf8")).toBe("new-z");
      expect(points.filter((value) => value.startsWith("before_apply_file:"))).toEqual([
        "before_apply_file:src/a.txt",
        "before_apply_file:src/z.txt",
      ]);
      const journal = fixture.database.prepare(`
        SELECT status,old_manifest_hash AS oldManifestHash,
               post_manifest_hash AS postManifestHash,journal_root AS journalRoot
        FROM execution_merge_journals WHERE id=?
      `).get(result.journalId) as Record<string, string>;
      expect(journal).toMatchObject({
        oldManifestHash: result.oldManifestHash,
        postManifestHash: result.postManifestHash,
        status: "applying",
      });
      expect(resolve(journal.journalRoot).startsWith(resolve(fixture.workspaceRoot))).toBe(false);

      const files = fixture.database.prepare(`
        SELECT position,path,old_target_ref_json AS oldTargetJson,
               post_target_ref_json AS postTargetJson,backup_ref_json AS backupRefJson,
               durable_new_ref_json AS durableNewRefJson,
               canonical_temp_ref_json AS canonicalTempRefJson,status
        FROM execution_merge_files WHERE journal_id=? ORDER BY position
      `).all(result.journalId) as Array<Record<string, string | number | null>>;
      expect(files.map(({ path, position, status }) => ({ path, position, status }))).toEqual([
        { path: "src/a.txt", position: 0, status: "applied" },
        { path: "src/z.txt", position: 1, status: "applied" },
      ]);
      for (const file of files) {
        const oldTarget = JSON.parse(String(file.oldTargetJson)) as Record<string, unknown>;
        const postTarget = JSON.parse(String(file.postTargetJson)) as Record<string, unknown>;
        const durableNew = JSON.parse(String(file.durableNewRefJson)) as Record<string, unknown>;
        const canonicalTemp = JSON.parse(String(file.canonicalTempRefJson)) as Record<string, unknown>;
        expect(oldTarget).toMatchObject({
          rootKind: "canonical",
          relativePath: String(file.path).split("/"),
        });
        expect(postTarget).toMatchObject({
          exists: true,
          rootKind: "canonical",
          relativePath: String(file.path).split("/"),
        });
        expect(durableNew).toMatchObject({
          rootKind: "journal",
          relativePath: expect.any(Array),
          ownerId: result.actionId,
        });
        expect(canonicalTemp).toMatchObject({
          rootKind: "canonical",
          relativePath: expect.any(Array),
          ownerId: result.actionId,
        });
      }
      expect(JSON.parse(String(files[0].oldTargetJson))).toMatchObject({
        exists: true,
        sha256: sha256("old-a"),
      });
      expect(JSON.parse(String(files[0].postTargetJson))).toMatchObject({
        sha256: sha256("new-a"),
      });
      expect(JSON.parse(String(files[0].backupRefJson))).toMatchObject({
        rootKind: "journal",
        ownerId: result.actionId,
        sha256: sha256("old-a"),
      });
      expect(JSON.parse(String(files[1].oldTargetJson))).toMatchObject({
        exists: false,
        sha256: null,
      });
      expect(files[1].backupRefJson).toBeNull();

      expect(fixture.database.prepare(`
        SELECT o.status AS operationStatus,o.final_action_index AS finalActionIndex,
               a.kind,a.status AS actionStatus
        FROM execution_operations o JOIN execution_actions a
          ON a.project_id=o.project_id AND a.operation_id=o.id
        WHERE o.project_id=? AND o.id=?
      `).get(PROJECT_ID, fixture.input.operationId)).toEqual({
        actionStatus: "running",
        finalActionIndex: null,
        kind: "merge_apply",
        operationStatus: "pending",
      });
      expect(fixture.database.prepare(
        "SELECT status,consumed_at IS NOT NULL AS consumed FROM execution_approvals",
      ).get()).toEqual({ consumed: 1, status: "consumed" });
      expect(validateFixtureDatabase(fixture.database)).toBeNull();
      fixture.database.prepare(`
        UPDATE execution_merge_files
        SET durable_new_ref_json=json_set(durable_new_ref_json,'$.ownerId','wrong-owner')
        WHERE journal_id=? AND position=0
      `).run(result.journalId);
      expect(validateFixtureDatabase(fixture.database)).toBe("SCHEMA_DATA_INVALID");
    } finally {
      fixture.database.close();
    }
  });

  it("conditionally rolls every prepare/apply fault back to all-old", async () => {
    const points: MergePoint[] = [
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
    for (const point of points) {
      const fixture = await createFixture(point);
      try {
        await expect(mergeModule.executeMergePrepare({
          ...fixture.input,
          hooks: {
            point(event) {
              if (event.point === point) throw new Error(`fault:${point}`);
            },
          },
        })).rejects.toThrow(`fault:${point}`);
        expect(readFileSync(join(fixture.workspaceRoot, "src/a.txt"), "utf8")).toBe("old-a");
        expect(existsSync(join(fixture.workspaceRoot, "src/z.txt"))).toBe(false);
      } finally {
        fixture.database.close();
      }
    }
  }, 20_000);

  it("never overwrites an external mismatch during conditional rollback", async () => {
    const fixture = await createFixture();
    try {
      await expect(mergeModule.executeMergePrepare({
        ...fixture.input,
        hooks: {
          async point({ path, point }) {
            if (point === "after_replace" && path === "src/a.txt") {
              await writeFile(join(fixture.workspaceRoot, path), "external-writer", "utf8");
              throw new Error("fault after external replacement");
            }
          },
        },
      })).rejects.toMatchObject({ code: "MANUAL_RECOVERY_REQUIRED" });
      expect(await readFile(join(fixture.workspaceRoot, "src/a.txt"), "utf8"))
        .toBe("external-writer");
      expect(existsSync(join(fixture.workspaceRoot, "src/z.txt"))).toBe(false);
      expect(fixture.database.prepare(
        "SELECT status,error_code AS errorCode FROM execution_merge_journals",
      ).get()).toEqual({ errorCode: "MANUAL_RECOVERY_REQUIRED", status: "manual_recovery" });
    } finally {
      fixture.database.close();
    }
  });

  it("rechecks staged eligibility and holds one unresolved merge lock per project", async () => {
    const fixture = await createFixture();
    try {
      await mergeModule.executeMergePrepare(fixture.input);
      await expect(mergeModule.executeMergePrepare({
        ...fixture.input,
        operationId: "00000000-0000-4000-8000-000000000099",
      })).rejects.toMatchObject({ code: "MERGE_RECOVERY_REQUIRED" });
      expect(fixture.database.prepare(
        "SELECT count(*) AS count FROM execution_merge_journals WHERE project_id=?",
      ).get(PROJECT_ID)).toEqual({ count: 1 });
    } finally {
      fixture.database.close();
    }

    const ineligible = await createFixture("ineligible");
    try {
      ineligible.database.prepare(`
        UPDATE execution_staged_results
        SET merge_file_count=0,merge_final_bytes=0,blocker_count=1,classification='blocked'
        WHERE id=?
      `).run(STAGED_ID);
      await expect(mergeModule.executeMergePrepare(ineligible.input))
        .rejects.toMatchObject({ code: "STAGED_NOT_ELIGIBLE" });
      expect(ineligible.database.prepare(
        "SELECT count(*) AS count FROM execution_operations WHERE kind='merge'",
      ).get()).toEqual({ count: 0 });
      expect(readFileSync(join(ineligible.workspaceRoot, "src/a.txt"), "utf8")).toBe("old-a");
    } finally {
      ineligible.database.close();
    }
  });
});

async function createFixture(label = "happy") {
  const root = mkdtempSync(join(tmpdir(), `cool-ai-merge-${label}-`));
  directories.push(root);
  const workspaceRoot = join(root, "workspace");
  const sandboxRoot = join(root, "execution", "attempt", "sandbox");
  const journalBaseRoot = join(root, "execution", "attempt", "merge");
  await mkdir(join(workspaceRoot, "src"), { recursive: true });
  await mkdir(join(sandboxRoot, "src"), { recursive: true });
  writeFileSync(join(workspaceRoot, "src/a.txt"), "old-a");
  writeFileSync(join(sandboxRoot, "src/a.txt"), "new-a");
  writeFileSync(join(sandboxRoot, "src/z.txt"), "new-z");

  const databasePath = join(root, "cockpit.sqlite");
  const database = openDatabase(databasePath);
  try {
    seedDatabase(databasePath, database, { sandboxRoot, workspaceRoot });
  } catch (error) {
    database.close();
    throw error;
  }
  return {
    database,
    input: {
      database,
      executionId: EXECUTION_ID,
      expectedVersion: 7,
      journalBaseRoot,
      operationId: `00000000-0000-4000-8000-${sha256(label).slice(0, 12)}`,
      projectId: PROJECT_ID,
      stagedHash: STAGED_HASH,
      workspaceRoot,
    },
    journalBaseRoot,
    sandboxRoot,
    workspaceRoot,
  };
}

function seedDatabase(
  databasePath: string,
  database: DatabaseSync,
  paths: { sandboxRoot: string; workspaceRoot: string },
): void {
  const escapedWorkspace = paths.workspaceRoot.replaceAll("'", "''");
  const escapedSandbox = paths.sandboxRoot.replaceAll("'", "''");
  execV7Fixture(databasePath, database, `
    INSERT INTO projects (id,name,created_at,workspace_path,workspace_key,version)
    VALUES ('${PROJECT_ID}','Merge','${NOW}','${escapedWorkspace}','${escapedWorkspace.toLowerCase()}',1);
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
      'mission_review_initialized','system',NULL,'{}','${NOW}');
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
    ) VALUES ('${ATTEMPT_ID}','${PROJECT_ID}','${EXECUTION_ID}',1,'ready','${escapedSandbox}',
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
      '${STAGED_HASH}',2,10,2,10,0,'approval_required','[]','${NOW}');
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
    INSERT INTO execution_approvals (
      id,project_id,execution_id,attempt_id,tool_call_id,kind,status,request_hash,
      input_hash,staged_hash,public_request_json,decided_at,consumed_at,created_at
    ) VALUES ('merge-approval','${PROJECT_ID}','${EXECUTION_ID}','${ATTEMPT_ID}',NULL,
      'staged_merge','approved','${HASH}','${HASH}','${STAGED_HASH}','{}','${NOW}',NULL,'${NOW}');
  `);
  refreshExecutionFrozenFixture(database, EXECUTION_ID);
}
