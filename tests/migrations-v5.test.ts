import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "@/src/server/db";
import { createV5 } from "@/src/server/migrations-v5";

const V5_TABLES = [
  "project_validation_policies",
  "project_validation_policy_entries",
  "executions",
  "execution_attempts",
  "execution_actions",
  "execution_operations",
  "project_validation_policy_revisions",
  "project_validation_policy_audits",
  "execution_model_calls",
  "execution_tool_calls",
  "execution_approvals",
  "execution_validation_results",
  "execution_validation_output_chunks",
  "execution_staged_results",
  "execution_staged_observations",
  "execution_staged_files",
  "execution_staged_blockers",
  "execution_artifacts",
  "execution_artifact_chunks",
  "execution_events",
  "execution_merge_journals",
  "execution_merge_files",
  "work_item_execution_results",
] as const;

const V5_INDEXES = [
  "collaboration_runs_project_id_id",
  "missions_project_id_id",
  "work_items_mission_id_id",
  "execution_one_active_task",
  "execution_one_active_agent",
  "executions_project_status",
  "execution_one_acting_attempt",
  "execution_actions_execution_status",
  "execution_actions_expiry",
  "execution_one_running_action",
  "execution_operation_one_running_action",
  "validation_policy_revisions_page",
  "validation_policy_audits_page",
  "execution_one_pending_approval",
  "execution_approvals_page",
  "execution_validations_page",
  "staged_files_path_key",
  "staged_observations_page",
  "staged_blockers_page",
  "execution_artifacts_page",
  "execution_one_project_merge",
  "work_item_execution_results_item",
] as const;

const V5_TRIGGERS = [
  "validation_policy_revision_no_update",
  "validation_policy_revision_no_delete",
  "validation_policy_entry_no_update",
  "validation_policy_entry_no_delete",
  "validation_policy_audit_no_update",
  "validation_policy_audit_no_delete",
] as const;

const DROP_V5_TABLES = [
  "work_item_execution_results",
  "execution_merge_files",
  "execution_merge_journals",
  "execution_events",
  "execution_artifact_chunks",
  "execution_artifacts",
  "execution_staged_blockers",
  "execution_staged_files",
  "execution_staged_observations",
  "execution_staged_results",
  "execution_validation_output_chunks",
  "execution_validation_results",
  "execution_approvals",
  "execution_tool_calls",
  "execution_model_calls",
  "project_validation_policy_audits",
  "execution_actions",
  "execution_attempts",
  "execution_operations",
  "executions",
  "project_validation_policies",
  "project_validation_policy_entries",
  "project_validation_policy_revisions",
] as const;

const temporaryDirectories: string[] = [];

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "cockpit-v5-migration-"));
  temporaryDirectories.push(directory);
  return join(directory, "cockpit.sqlite");
}

function userVersion(database: DatabaseSync): number {
  return (database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
}

function names(
  database: DatabaseSync,
  type: "table" | "index" | "trigger" | "view",
): string[] {
  return (
    database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type=? AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all(type) as Array<{ name: string }>
  ).map(({ name }) => name);
}

function makeV4(path: string): void {
  const current = openDatabase(path);
  current.close();
  const database = new DatabaseSync(path);
  database.exec("PRAGMA foreign_keys=OFF");
  for (const table of DROP_V5_TABLES) {
    database.exec(`DROP TABLE IF EXISTS "${table}"`);
  }
  for (const index of V5_INDEXES) {
    database.exec(`DROP INDEX IF EXISTS "${index}"`);
  }
  database.exec("PRAGMA user_version=4");
  database.close();
}

function expectOpenError(path: string, code: string): void {
  let error: unknown;
  try {
    openDatabase(path).close();
  } catch (caught) {
    error = caught;
  }
  expect(error).toEqual(
    expect.objectContaining({ code, message: expect.not.stringContaining(path) }),
  );
}

function seedS4Facts(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO projects (id,name,created_at,workspace_path,workspace_key,version)
      VALUES ('p1','Persisted','2026-07-30T00:00:00.000Z',NULL,NULL,4);
    INSERT INTO providers (
      id,name,base_url,default_model,api_key_cipher,api_key_iv,api_key_tag,
      credential_version,credential_generation,key_id,api_key_mask,verified_at,
      version,created_at,updated_at
    ) VALUES (
      'provider1','Provider','https://example.invalid','model','cipher','iv','tag',
      1,1,'key','****','2026-07-30T00:00:00.000Z',1,
      '2026-07-30T00:00:00.000Z','2026-07-30T00:00:00.000Z'
    );
    INSERT INTO agents (
      id,name,role,system_prompt,provider_id,model,avatar_text,accent_token,
      can_read,can_write,can_execute,max_tokens,max_handoffs,version,created_at,updated_at
    ) VALUES (
      'agent1','Agent','Role','Prompt','provider1','model','A','sage',
      1,1,1,4096,2,1,'2026-07-30T00:00:00.000Z','2026-07-30T00:00:00.000Z'
    );
    INSERT INTO project_memberships VALUES
      ('p1','agent1','2026-07-30T00:00:00.000Z');
    INSERT INTO missions VALUES (
      'mission1','p1','Mission','Goal',2,
      '2026-07-30T00:00:00.000Z','2026-07-30T00:00:00.000Z'
    );
    INSERT INTO work_items VALUES (
      'work1','mission1','Work','Description','in_progress','agent1',3,
      '2026-07-30T00:00:00.000Z','2026-07-30T00:00:00.000Z'
    );
    INSERT INTO collaboration_runs VALUES (
      'run1','p1','planned','agent1',1,2,3,1,NULL,NULL,
      '2026-07-30T00:00:00.000Z','2026-07-30T00:00:00.000Z'
    );
  `);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("SQLite v5 strict atomic migration", () => {
  it("migrates complete v4 with exactly 23 tables, 22 indexes, and 6 immutable triggers", () => {
    const path = databasePath();
    makeV4(path);
    const database = new DatabaseSync(path);
    seedS4Facts(database);
    database.close();

    const migrated = openDatabase(path);
    expect(userVersion(migrated)).toBe(5);
    expect(names(migrated, "table")).toEqual(expect.arrayContaining([...V5_TABLES]));
    expect(V5_TABLES).toHaveLength(23);
    expect(names(migrated, "index")).toEqual(expect.arrayContaining([...V5_INDEXES]));
    expect(V5_INDEXES).toHaveLength(22);
    expect(names(migrated, "trigger")).toEqual(expect.arrayContaining([...V5_TRIGGERS]));
    expect(V5_TRIGGERS).toHaveLength(6);
    expect(migrated.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

    expect(migrated.prepare("SELECT name,version FROM projects").get()).toEqual({
      name: "Persisted",
      version: 4,
    });
    expect(migrated.prepare("SELECT status FROM collaboration_runs").get()).toEqual({
      status: "planned",
    });
    expect(migrated.prepare("SELECT title,status FROM work_items").get()).toEqual({
      title: "Work",
      status: "in_progress",
    });

    const revision = migrated
      .prepare(
        `SELECT r.project_id,r.revision_no,r.policy_hash,r.classifier_version,
                r.warning_accepted,r.canonical_bytes,r.entry_count,p.version
         FROM project_validation_policy_revisions r
         JOIN project_validation_policies p
           ON p.project_id=r.project_id AND p.active_revision_id=r.id`,
      )
      .get() as Record<string, unknown>;
    expect(revision).toEqual({
      project_id: "p1",
      revision_no: 1,
      policy_hash: createHash("sha256").update("[]").digest("hex"),
      classifier_version: 1,
      warning_accepted: 0,
      canonical_bytes: 2,
      entry_count: 0,
      version: 1,
    });
    migrated.close();
  });

  it("creates exact ordered columns, types, nullability, defaults, checks, uniques, and composite FKs", () => {
    const database = openDatabase(databasePath());
    const executionColumns = database.prepare("PRAGMA table_info(executions)").all();
    expect(executionColumns).toEqual([
      expect.objectContaining({ name: "id", type: "TEXT", notnull: 0, pk: 1, dflt_value: null }),
      expect.objectContaining({ name: "project_id", type: "TEXT", notnull: 1 }),
      expect.objectContaining({ name: "source_collaboration_run_id", type: "TEXT", notnull: 1 }),
      expect.objectContaining({ name: "mission_id", type: "TEXT", notnull: 1 }),
      expect.objectContaining({ name: "work_item_id", type: "TEXT", notnull: 1 }),
      expect.objectContaining({ name: "agent_id", type: "TEXT", notnull: 1 }),
      expect.objectContaining({ name: "current_policy_revision_id", type: "TEXT", notnull: 1 }),
      expect.objectContaining({ name: "status", type: "TEXT", notnull: 1 }),
      expect.objectContaining({ name: "resume_target", type: "TEXT", notnull: 0 }),
      expect.objectContaining({ name: "reason_code", type: "TEXT", notnull: 0 }),
      expect.objectContaining({ name: "manual_recovery_required", type: "INTEGER", notnull: 1, dflt_value: "0" }),
      expect.objectContaining({ name: "recovery_resolution", type: "TEXT", notnull: 0 }),
      expect.objectContaining({ name: "current_attempt_no", type: "INTEGER", notnull: 1 }),
      expect.objectContaining({ name: "business_round_count", type: "INTEGER", notnull: 1, dflt_value: "0" }),
      expect.objectContaining({ name: "tool_call_count", type: "INTEGER", notnull: 1, dflt_value: "0" }),
      expect.objectContaining({ name: "next_event_sequence", type: "INTEGER", notnull: 1, dflt_value: "1" }),
      expect.objectContaining({ name: "version", type: "INTEGER", notnull: 1, dflt_value: "1" }),
      expect.objectContaining({ name: "created_at", type: "TEXT", notnull: 1 }),
      expect.objectContaining({ name: "business_deadline_at", type: "TEXT", notnull: 0 }),
      expect.objectContaining({ name: "first_running_at", type: "TEXT", notnull: 0 }),
      expect.objectContaining({ name: "updated_at", type: "TEXT", notnull: 1 }),
      expect.objectContaining({ name: "merged_at", type: "TEXT", notnull: 0 }),
    ]);
    const executionSql = (
      database
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='executions'")
        .get() as { sql: string }
    ).sql.replace(/\s+/g, " ").toLowerCase();
    for (const fragment of [
      "unique(project_id,mission_id,work_item_id,id)",
      "foreign key(project_id,source_collaboration_run_id) references collaboration_runs(project_id,id)",
      "foreign key(project_id,mission_id) references missions(project_id,id)",
      "foreign key(mission_id,work_item_id) references work_items(mission_id,id)",
      "foreign key(project_id,agent_id) references project_memberships(project_id,agent_id)",
      "check((status='merged') = (merged_at is not null))",
    ]) {
      expect(executionSql).toContain(fragment);
    }
    expect(() =>
      database.prepare(
        `INSERT INTO executions (
          id,project_id,source_collaboration_run_id,mission_id,work_item_id,agent_id,
          current_policy_revision_id,status,current_attempt_no,created_at,updated_at
        ) VALUES ('bad','missing','run','mission','work','agent','revision','queued',1,
          'bad-time','bad-time')`,
      ).run(),
    ).toThrow();
    database.close();
  });

  it("rejects drift of every v5 table, index, and trigger instead of repairing it", () => {
    for (const [type, objects] of [
      ["table", V5_TABLES],
      ["index", V5_INDEXES],
      ["trigger", V5_TRIGGERS],
    ] as const) {
      for (const object of objects) {
        const path = databasePath();
        const database = openDatabase(path);
        database.exec("PRAGMA foreign_keys=OFF");
        database.exec(`DROP ${type.toUpperCase()} "${object}"`);
        database.close();
        expectOpenError(path, "SCHEMA_DRIFT");
        const unchanged = new DatabaseSync(path);
        expect(userVersion(unchanged)).toBe(5);
        unchanged.close();
      }
    }
  }, 30_000);

  it("rejects partial v5 schemas before writing and atomically rolls back injected DDL faults", () => {
    const partialPath = databasePath();
    makeV4(partialPath);
    const partial = new DatabaseSync(partialPath);
    partial.exec("CREATE TABLE executions(id TEXT PRIMARY KEY)");
    partial.close();
    expectOpenError(partialPath, "SCHEMA_DRIFT");
    const unchangedPartial = new DatabaseSync(partialPath);
    expect(userVersion(unchangedPartial)).toBe(4);
    expect(names(unchangedPartial, "table")).toContain("executions");
    expect(names(unchangedPartial, "table")).not.toContain("execution_attempts");
    unchangedPartial.close();

    const faultPath = databasePath();
    makeV4(faultPath);
    const rolledBack = new DatabaseSync(faultPath);
    seedS4Facts(rolledBack);
    rolledBack.exec("BEGIN IMMEDIATE");
    expect(() => {
      createV5(rolledBack);
      throw new Error("injected migration fault");
    }).toThrow("injected migration fault");
    rolledBack.exec("ROLLBACK");
    expect(userVersion(rolledBack)).toBe(4);
    expect(names(rolledBack, "table")).not.toEqual(expect.arrayContaining([...V5_TABLES]));
    expect(rolledBack.prepare("SELECT name FROM projects").get()).toEqual({ name: "Persisted" });
    rolledBack.close();
  });

  it("rejects foreign-key and policy data invariant corruption on reopen", () => {
    const foreignKeyPath = databasePath();
    const valid = openDatabase(foreignKeyPath);
    valid.close();
    const orphaned = new DatabaseSync(foreignKeyPath);
    orphaned.exec("PRAGMA foreign_keys=OFF");
    orphaned.prepare(
      `INSERT INTO execution_events
        (id,project_id,execution_id,sequence,attempt_no,type,actor_type,actor_id,payload_json,created_at)
       VALUES ('event','missing-project','missing-execution',1,1,'x','system',NULL,'{}',
               '2026-07-30T00:00:00.000Z')`,
    ).run();
    orphaned.close();
    expectOpenError(foreignKeyPath, "SCHEMA_DRIFT");

    const policyPath = databasePath();
    makeV4(policyPath);
    const policyV4 = new DatabaseSync(policyPath);
    seedS4Facts(policyV4);
    policyV4.close();
    const policy = openDatabase(policyPath);
    policy.close();
    const corrupt = new DatabaseSync(policyPath);
    corrupt.exec("DROP TRIGGER validation_policy_revision_no_update");
    corrupt.exec(
      `UPDATE project_validation_policy_revisions SET policy_hash='${"0".repeat(64)}'`,
    );
    corrupt.exec(`
      CREATE TRIGGER validation_policy_revision_no_update
      BEFORE UPDATE ON project_validation_policy_revisions
      BEGIN SELECT RAISE(ABORT,'IMMUTABLE_POLICY_REVISION'); END
    `);
    corrupt.close();
    expectOpenError(policyPath, "SCHEMA_DATA_INVALID");
  });

  it("enforces immutable policy history while allowing project cascade deletion", () => {
    const path = databasePath();
    makeV4(path);
    const v4 = new DatabaseSync(path);
    seedS4Facts(v4);
    v4.close();
    const database = openDatabase(path);
    const revision = database
      .prepare("SELECT id FROM project_validation_policy_revisions WHERE project_id='p1'")
      .get() as { id: string };
    expect(() =>
      database.prepare("UPDATE project_validation_policy_revisions SET classifier_version=2").run(),
    ).toThrow(/IMMUTABLE_POLICY_REVISION/);
    expect(() =>
      database.prepare("DELETE FROM project_validation_policy_revisions WHERE id=?").run(revision.id),
    ).toThrow(/IMMUTABLE_POLICY_REVISION/);
    database.prepare("DELETE FROM projects WHERE id='p1'").run();
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM project_validation_policy_revisions").get(),
    ).toEqual({ count: 0 });
    database.close();
  });

  it("reopens idempotently and rejects versions newer than v5", () => {
    const path = databasePath();
    const first = openDatabase(path);
    const before = first
      .prepare(
        `SELECT type,name,sql FROM sqlite_master
         WHERE name IN (${[...V5_TABLES, ...V5_INDEXES, ...V5_TRIGGERS].map(() => "?").join(",")})
         ORDER BY type,name`,
      )
      .all(...V5_TABLES, ...V5_INDEXES, ...V5_TRIGGERS);
    first.close();
    const reopened = openDatabase(path);
    expect(userVersion(reopened)).toBe(5);
    expect(
      reopened
        .prepare(
          `SELECT type,name,sql FROM sqlite_master
           WHERE name IN (${[...V5_TABLES, ...V5_INDEXES, ...V5_TRIGGERS].map(() => "?").join(",")})
           ORDER BY type,name`,
        )
        .all(...V5_TABLES, ...V5_INDEXES, ...V5_TRIGGERS),
    ).toEqual(before);
    reopened.close();

    const tooNewPath = databasePath();
    const tooNew = new DatabaseSync(tooNewPath);
    tooNew.exec("PRAGMA user_version=6");
    tooNew.close();
    expectOpenError(tooNewPath, "SCHEMA_TOO_NEW");
  });
});
