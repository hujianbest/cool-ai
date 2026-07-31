import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdir, rename, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase } from "@/src/server/db";

type MergePoint =
  | "before_apply_file"
  | "after_temp_write"
  | "before_replace"
  | "after_replace"
  | "after_all_files"
  | "before_precommit_check"
  | "after_precommit_check"
  | "before_db_commit"
  | "after_db_commit"
  | "after_postcommit_check";

type ResolutionAction = "recovered_old" | "recovered_new" | "abandon";

type MergeModule = {
  executeMergeCommit(input: {
    database: DatabaseSync;
    hooks?: { point(input: { path: string | null; point: MergePoint }): void | Promise<void> };
    journalId: string;
  }): Promise<{ body: unknown; status: number }>;
  executeMergePrepare(input: MergeInput): Promise<{
    actionId: string;
    journalId: string;
    oldManifestHash: string;
    postManifestHash: string;
  }>;
  recoverIncompleteMergeJournals(input: {
    database: DatabaseSync;
    projectId: string;
  }): Promise<Array<{ body: unknown; status: number }>>;
  resolveManualRecovery(input: {
    action: ResolutionAction;
    database: DatabaseSync;
    executionId: string;
    expectedVersion: number;
    observedManifestHash: string;
    operationId: string;
    projectId: string;
  }): Promise<{ body: Record<string, unknown>; status: number }>;
};

type MergeInput = {
  database: DatabaseSync;
  executionId: string;
  expectedVersion: number;
  hooks?: { point(input: { path: string | null; point: MergePoint }): void | Promise<void> };
  journalBaseRoot: string;
  operationId: string;
  projectId: string;
  stagedHash: string;
  workspaceRoot: string;
};

const NOW = "2026-07-30T06:00:00.000Z";
const PROJECT_ID = "writer-project";
const EXECUTION_ID = "writer-execution";
const ATTEMPT_ID = "writer-attempt";
const STAGED_ID = "writer-staged";
const STAGED_HASH = "9".repeat(64);
const HASH = "a".repeat(64);
const roots: string[] = [];
let mergeModule: MergeModule;

const sha256 = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

beforeEach(async () => {
  const candidate = await import("@/src/server/execution/merge-journal-service") as Partial<MergeModule>;
  expect(candidate.resolveManualRecovery, "T-23 resolution service must exist").toBeTypeOf("function");
  mergeModule = candidate as MergeModule;
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("external-writer merge recovery", () => {
  it("preserves an external replacement and enters durable manual recovery", async () => {
    const fixture = await createFixture("apply-replace");
    let externalWrites = 0;
    await expect(mergeModule.executeMergePrepare({
      ...fixture.input,
      hooks: {
        async point({ path, point }) {
          if (point === "after_replace" && path === "src/a.txt") {
            await writeFile(join(fixture.workspaceRoot, path), "external-bytes");
            externalWrites += 1;
            throw new Error("external writer raced apply");
          }
        },
      },
    })).rejects.toMatchObject({ code: "MANUAL_RECOVERY_REQUIRED" });

    expect(readFileSync(join(fixture.workspaceRoot, "src/a.txt"), "utf8")).toBe("external-bytes");
    expect(externalWrites).toBe(1);
    expect(manualState(fixture.database)).toMatchObject({
      actionError: "MANUAL_RECOVERY_REQUIRED",
      actionStatus: "failed",
      executionStatus: "conflicted",
      journalStatus: "manual_recovery",
      manualRecoveryRequired: 1,
      operationStatus: "completed",
    });
    expect(manualState(fixture.database).observedManifestHash).toMatch(/^[0-9a-f]{64}$/u);
    fixture.database.close();
  });

  it("requires the exact observed whole-manifest hash and refreshes a mismatch", async () => {
    const fixture = await createManualFixture("refresh");
    const initial = manualState(fixture.database);
    writeFileSync(join(fixture.workspaceRoot, "src/a.txt"), "changed-again");

    const mismatch = await mergeModule.resolveManualRecovery({
      action: "abandon",
      database: fixture.database,
      executionId: EXECUTION_ID,
      expectedVersion: initial.version,
      observedManifestHash: initial.observedManifestHash!,
      operationId: "00000000-0000-4000-8000-000000000101",
      projectId: PROJECT_ID,
    });
    expect(mismatch.status).toBe(409);
    expect(mismatch.body).toMatchObject({
      error: { code: "RECOVERY_MANIFEST_MISMATCH" },
    });
    expect((mismatch.body.recovery as { observedManifestHash: string }).observedManifestHash)
      .not.toBe(initial.observedManifestHash);
    expect(manualState(fixture.database).journalStatus).toBe("manual_recovery");
    fixture.database.close();
  });

  it("resolves exact old/new manifests and replays each operation exactly", async () => {
    for (const action of ["recovered_old", "recovered_new"] as const) {
      const fixture = await createManualFixture(action);
      if (action === "recovered_old") {
        const oldPath = join(fixture.workspaceRoot, "src/a.txt");
        const originalPath = join(fixture.root, "original-a.txt");
        writeFileSync(originalPath, "old-a");
        const oldIdentity = identity(originalPath);
        fixture.database.prepare(
          "UPDATE execution_merge_files SET old_identity=? WHERE path_key='src/a.txt'",
        ).run(oldIdentity);
        await unlink(oldPath);
        await rename(originalPath, oldPath);
        refreshStoredManifest(fixture.database, "old");
      } else {
        // The raced path is recreated from the still-owned merge temp identity.
        const file = fixture.database.prepare(`
          SELECT durable_new_path AS durableNewPath FROM execution_merge_files
          WHERE path_key='src/a.txt'
        `).get() as { durableNewPath: string };
        const target = join(fixture.workspaceRoot, "src/a.txt");
        await unlink(target);
        await rename(file.durableNewPath, target);
        fixture.database.prepare(
          "UPDATE execution_merge_files SET post_identity=? WHERE path_key='src/a.txt'",
        ).run(identity(target));
        refreshStoredManifest(fixture.database, "post");
      }
      const targetManifest = fixture.database.prepare(`
        SELECT old_manifest_hash AS oldHash,post_manifest_hash AS postHash
        FROM execution_merge_journals
      `).get() as { oldHash: string; postHash: string };
      const state = manualState(fixture.database);
      const operationId = action === "recovered_old"
        ? "00000000-0000-4000-8000-000000000201"
        : "00000000-0000-4000-8000-000000000202";
      const input = {
        action,
        database: fixture.database,
        executionId: EXECUTION_ID,
        expectedVersion: state.version,
        observedManifestHash: action === "recovered_old"
          ? targetManifest.oldHash
          : targetManifest.postHash,
        operationId,
        projectId: PROJECT_ID,
      };
      const first = await mergeModule.resolveManualRecovery(input);
      const replay = await mergeModule.resolveManualRecovery(input);
      expect(replay).toEqual(first);
      expect(first.status).toBe(200);
      expect(manualState(fixture.database)).toMatchObject(action === "recovered_old"
        ? { executionStatus: "conflicted", journalStatus: "resolved_old", manualRecoveryRequired: 0 }
        : { executionStatus: "merged", journalStatus: "resolved_new", manualRecoveryRequired: 0 });
      expect(fixture.database.prepare(
        "SELECT count(*) AS count FROM work_item_execution_results",
      ).get()).toEqual({ count: action === "recovered_new" ? 1 : 0 });
      fixture.database.close();
    }
  });

  it("abandons without touching canonical bytes and only conditionally cleans owned files", async () => {
    const fixture = await createManualFixture("abandon");
    const owned = fixture.database.prepare(`
      SELECT backup_path AS backupPath,durable_new_path AS durableNewPath
      FROM execution_merge_files WHERE path_key='src/a.txt'
    `).get() as { backupPath: string; durableNewPath: string };
    writeFileSync(owned.backupPath, "external-owned-path");
    const before = readFileSync(join(fixture.workspaceRoot, "src/a.txt"));
    const state = manualState(fixture.database);
    const input = {
      action: "abandon" as const,
      database: fixture.database,
      executionId: EXECUTION_ID,
      expectedVersion: state.version,
      observedManifestHash: state.observedManifestHash!,
      operationId: "00000000-0000-4000-8000-000000000301",
      projectId: PROJECT_ID,
    };
    const first = await mergeModule.resolveManualRecovery(input);
    expect(await mergeModule.resolveManualRecovery(input)).toEqual(first);
    expect(first.body).toMatchObject({ uncleanedOwnedPathCount: 1 });
    expect(readFileSync(join(fixture.workspaceRoot, "src/a.txt"))).toEqual(before);
    expect(readFileSync(owned.backupPath, "utf8")).toBe("external-owned-path");
    expect(existsSync(owned.durableNewPath)).toBe(false);
    expect(manualState(fixture.database)).toMatchObject({
      executionStatus: "stopped",
      journalStatus: "abandoned",
      manualRecoveryRequired: 0,
    });
    fixture.database.close();
  });

  it("treats replace/delete/recreate/new-identity/symlink apply and rollback races as non-overwritable", async () => {
    for (const point of ["before_replace", "after_replace"] as const) {
      for (const mutation of ["replace", "delete", "new-identity", "symlink"] as const) {
        const fixture = await createFixture(`${point}-${mutation}`);
        const target = join(fixture.workspaceRoot, "src/a.txt");
        await expect(mergeModule.executeMergePrepare({
          ...fixture.input,
          hooks: {
            async point(event) {
              if (event.point !== point || event.path !== "src/a.txt") return;
              await mutateCanonical(fixture.root, target, mutation);
              if (point === "after_replace") throw new Error(`rollback-race:${mutation}`);
            },
          },
        })).rejects.toMatchObject({ code: "MANUAL_RECOVERY_REQUIRED" });
        assertExternalState(target, mutation);
        expect(manualState(fixture.database).journalStatus).toBe("manual_recovery");
        fixture.database.close();
      }
    }
  });

  it("detects every postcheck-to-receipt window without overwriting external bytes", async () => {
    const points = [
      "before_precommit_check",
      "after_precommit_check",
      "before_db_commit",
      "after_db_commit",
      "after_postcommit_check",
    ] as const;
    for (const point of points) {
      for (const mutation of ["replace", "delete", "new-identity", "symlink"] as const) {
        const fixture = await createFixture(`${point}-${mutation}`);
        const prepared = await mergeModule.executeMergePrepare(fixture.input);
        const target = join(fixture.workspaceRoot, "src/a.txt");
        await expect(mergeModule.executeMergeCommit({
          database: fixture.database,
          journalId: prepared.journalId,
          hooks: {
            async point(event) {
              if (event.point === point) {
                await mutateCanonical(fixture.root, target, mutation);
              }
            },
          },
        })).rejects.toMatchObject({ code: "MANUAL_RECOVERY_REQUIRED" });
        assertExternalState(target, mutation);
        expect(fixture.database.prepare(
          "SELECT count(*) AS count FROM work_item_execution_results",
        ).get()).toEqual({ count: 0 });
        fixture.database.close();
      }
    }
  }, 30_000);

  it("detects restart roll-forward races for every external path shape", async () => {
    for (const mutation of ["replace", "delete", "new-identity", "symlink"] as const) {
      const fixture = await createFixture(`restart-${mutation}`);
      const prepared = await mergeModule.executeMergePrepare(fixture.input);
      await expect(mergeModule.executeMergeCommit({
        database: fixture.database,
        journalId: prepared.journalId,
        hooks: {
          point({ point }) {
            if (point === "after_db_commit") throw new Error("crash after private commit");
          },
        },
      })).rejects.toThrow("crash after private commit");
      const target = join(fixture.workspaceRoot, "src/a.txt");
      await mutateCanonical(fixture.root, target, mutation);
      fixture.restart();
      await expect(mergeModule.recoverIncompleteMergeJournals({
        database: fixture.database,
        projectId: PROJECT_ID,
      })).rejects.toMatchObject({ code: "MANUAL_RECOVERY_REQUIRED" });
      assertExternalState(target, mutation);
      expect(fixture.database.prepare(
        "SELECT count(*) AS count FROM work_item_execution_results",
      ).get()).toEqual({ count: 0 });
      fixture.database.close();
    }
  });
});

type Mutation = "replace" | "delete" | "new-identity" | "symlink";

async function mutateCanonical(root: string, target: string, mutation: Mutation): Promise<void> {
  await unlink(target).catch(() => undefined);
  if (mutation === "delete") return;
  if (mutation === "replace") {
    await writeFile(target, "external-bytes");
    return;
  }
  if (mutation === "new-identity") {
    await writeFile(target, "new-a");
    return;
  }
  const external = join(root, "external-link.txt");
  writeFileSync(external, "external-link-bytes");
  await symlink(external, target, "file");
}

function assertExternalState(target: string, mutation: Mutation): void {
  if (mutation === "delete") {
    expect(existsSync(target)).toBe(false);
    return;
  }
  expect(readFileSync(target, "utf8")).toBe(
    mutation === "replace"
      ? "external-bytes"
      : mutation === "new-identity"
        ? "new-a"
        : "external-link-bytes",
  );
}

function identity(path: string): string {
  const facts = requireStat(path);
  return `${facts.dev}:${facts.ino}`;
}

function requireStat(path: string) {
  return statSync(path, { bigint: false });
}

import { statSync } from "node:fs";

function manualState(database: DatabaseSync) {
  return database.prepare(`
    SELECT e.status AS executionStatus,e.version,
           e.manual_recovery_required AS manualRecoveryRequired,
           j.status AS journalStatus,j.observed_manifest_hash AS observedManifestHash,
           a.status AS actionStatus,a.error_code AS actionError,
           o.status AS operationStatus
    FROM executions e
    JOIN execution_merge_journals j ON j.execution_id=e.id
    JOIN execution_actions a ON a.id=j.merge_action_id
    JOIN execution_operations o ON o.project_id=j.project_id AND o.id=j.operation_id
    WHERE e.id=?
  `).get(EXECUTION_ID) as {
    actionError: string | null;
    actionStatus: string;
    executionStatus: string;
    journalStatus: string;
    manualRecoveryRequired: number;
    observedManifestHash: string | null;
    operationStatus: string;
    version: number;
  };
}

async function createManualFixture(label: string) {
  const fixture = await createFixture(label);
  await expect(mergeModule.executeMergePrepare({
    ...fixture.input,
    hooks: {
      async point({ path, point }) {
        if (point === "after_replace" && path === "src/a.txt") {
          await writeFile(join(fixture.workspaceRoot, path), `external-${label}`);
          throw new Error("manual");
        }
      },
    },
  })).rejects.toMatchObject({ code: "MANUAL_RECOVERY_REQUIRED" });
  return fixture;
}

function refreshStoredManifest(database: DatabaseSync, target: "old" | "post"): void {
  const rows = database.prepare(`
    SELECT path,path_key AS pathKey,old_exists AS oldExists,old_identity AS oldIdentity,
           old_hash AS oldHash,post_identity AS postIdentity,new_hash AS newHash
    FROM execution_merge_files ORDER BY position
  `).all() as Array<{
    newHash: string;
    oldExists: number;
    oldHash: string | null;
    oldIdentity: string | null;
    path: string;
    pathKey: string;
    postIdentity: string;
  }>;
  const manifest = rows.map((row) => target === "old"
    ? { exists: row.oldExists === 1, hash: row.oldHash, identity: row.oldIdentity, path: row.path, pathKey: row.pathKey }
    : { exists: true, hash: row.newHash, identity: row.postIdentity, path: row.path, pathKey: row.pathKey });
  database.prepare(`UPDATE execution_merge_journals SET ${target === "old"
    ? "old_manifest_hash"
    : "post_manifest_hash"}=?`).run(sha256(JSON.stringify(manifest)));
}

async function createFixture(label: string) {
  const root = mkdtempSync(join(tmpdir(), `cool-ai-writer-${label}-`));
  roots.push(root);
  const workspaceRoot = join(root, "workspace");
  const sandboxRoot = join(root, "execution", "attempt", "sandbox");
  const journalBaseRoot = join(root, "execution", "attempt", "merge");
  await mkdir(join(workspaceRoot, "src"), { recursive: true });
  await mkdir(join(sandboxRoot, "src"), { recursive: true });
  writeFileSync(join(workspaceRoot, "src/a.txt"), "old-a");
  writeFileSync(join(sandboxRoot, "src/a.txt"), "new-a");
  const databasePath = join(root, "cockpit.sqlite");
  let database = openDatabase(databasePath);
  seedDatabase(database, { sandboxRoot, workspaceRoot });
  const fixture = {
    get database() { return database; },
    input: {
      database,
      executionId: EXECUTION_ID,
      expectedVersion: 7,
      journalBaseRoot,
      operationId: `00000000-0000-4000-8000-${sha256(label).slice(0, 12)}`,
      projectId: PROJECT_ID,
      stagedHash: STAGED_HASH,
      workspaceRoot,
    } satisfies MergeInput,
    restart() {
      database.close();
      database = openDatabase(databasePath);
      fixture.input.database = database;
    },
    root,
    workspaceRoot,
  };
  return fixture;
}

function seedDatabase(
  database: DatabaseSync,
  paths: { sandboxRoot: string; workspaceRoot: string },
): void {
  const workspace = paths.workspaceRoot.replaceAll("'", "''");
  const sandbox = paths.sandboxRoot.replaceAll("'", "''");
  database.exec(`
    INSERT INTO projects (id,name,created_at,workspace_path,workspace_key,version)
    VALUES ('${PROJECT_ID}','Writer','${NOW}','${workspace}','${workspace.toLowerCase()}',1);
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
      '${STAGED_HASH}',1,5,1,5,0,'auto_eligible','[]','${NOW}');
    INSERT INTO execution_staged_observations (
      id,staged_result_id,position,path,path_key,kind,baseline_hash,observed_hash,
      final_size,diff_text,diff_bytes,diff_truncated
    ) VALUES ('obs-a','${STAGED_ID}',0,'src/a.txt','src/a.txt','modified',
      '${sha256("old-a")}','${sha256("new-a")}',5,NULL,0,0);
    INSERT INTO execution_staged_files (
      id,staged_result_id,observation_id,position,path,path_key,kind,
      baseline_hash,staged_hash,size
    ) VALUES ('file-a','${STAGED_ID}','obs-a',0,'src/a.txt','src/a.txt','modified',
      '${sha256("old-a")}','${sha256("new-a")}',5);
  `);
}
