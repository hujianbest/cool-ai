import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "@/src/server/db";
import * as migrationsV6 from "@/src/server/migrations-v6";

type V6Module = {
  createV6?: (database: DatabaseSync, afterStep?: (step: string) => void) => void;
  hasAnyV6Object?: (database: DatabaseSync) => boolean;
  V6_INDEXES?: readonly string[];
  V6_MIGRATION_STEPS?: readonly string[];
  V6_TABLES?: readonly string[];
  V6_TRIGGERS?: readonly string[];
  validateV6?: (database: DatabaseSync) => "SCHEMA_DRIFT" | "SCHEMA_DATA_INVALID" | null;
};
const v6 = migrationsV6 as V6Module;
const V6_INDEXES = v6.V6_INDEXES ?? [];
const V6_TABLES = v6.V6_TABLES ?? [];
const V6_TRIGGERS = v6.V6_TRIGGERS ?? [];

const directories: string[] = [];
const NOW = "2026-08-01T04:00:00.000Z";

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "cockpit-v6-migration-"));
  directories.push(directory);
  return join(directory, "cockpit.sqlite");
}

function version(database: DatabaseSync): number {
  return (database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
}

function names(database: DatabaseSync, type: "table" | "index" | "trigger"): string[] {
  return (database.prepare(
    "SELECT name FROM sqlite_master WHERE type=? AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all(type) as Array<{ name: string }>).map(({ name }) => name);
}

function expectOpenError(path: string, code: string): void {
  expect(() => openDatabase(path)).toThrowError(expect.objectContaining({ code }));
}

function validateV6(database: DatabaseSync) {
  expect(v6.validateV6, "complete validateV6 must be exported").toBeTypeOf("function");
  return v6.validateV6!(database);
}

function hasAnyV6Object(database: DatabaseSync): boolean {
  expect(v6.hasAnyV6Object, "complete hasAnyV6Object must be exported").toBeTypeOf("function");
  return v6.hasAnyV6Object!(database);
}

function makeV5(path: string): DatabaseSync {
  const current = openDatabase(path);
  current.exec("PRAGMA foreign_keys=OFF");
  for (const trigger of V6_TRIGGERS) current.exec(`DROP TRIGGER IF EXISTS "${trigger}"`);
  for (const table of [
    "review_memory_associations", "review_memory_candidates", "review_escalation_answers",
    "review_escalations", "review_decisions", "review_model_calls", "review_attempts",
    "review_operations", "work_item_review_heads", "work_item_result_versions",
    "mission_delivery_heads", "mission_deliveries", "review_events", "memory_entries",
  ]) current.exec(`DROP TABLE IF EXISTS "${table}"`);
  current.exec(`
    CREATE TABLE memory_entries (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK(type IN ('goal','decision','fact','artifact')),
      content TEXT NOT NULL,
      source_type TEXT NOT NULL CHECK(source_type IN ('owner_input','work_item','artifact_path')),
      source_ref TEXT NOT NULL,
      created_by TEXT NOT NULL CHECK(created_by = 'owner'),
      supersedes_id TEXT UNIQUE REFERENCES memory_entries(id),
      created_at TEXT NOT NULL
    );
    CREATE TABLE work_item_execution_results(
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, mission_id TEXT NOT NULL, work_item_id TEXT NOT NULL,
      execution_id TEXT NOT NULL UNIQUE, staged_result_id TEXT NOT NULL UNIQUE, merge_journal_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK(status='awaiting_review'),
      created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z'),
      FOREIGN KEY(project_id,mission_id,work_item_id,execution_id) REFERENCES executions(project_id,mission_id,work_item_id,id),
      FOREIGN KEY(project_id,execution_id,staged_result_id) REFERENCES execution_staged_results(project_id,execution_id,id),
      FOREIGN KEY(project_id,merge_journal_id) REFERENCES execution_merge_journals(project_id,id)
    );
    CREATE INDEX work_item_execution_results_item ON work_item_execution_results(work_item_id,created_at,id);
  `);
  current.exec("ALTER TABLE agents DROP COLUMN review_capable");
  current.exec("PRAGMA user_version=5");
  current.close();
  const database = new DatabaseSync(path);
  database.exec("PRAGMA foreign_keys=ON");
  return database;
}

function seedLegacyFacts(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO projects(id,name,created_at,workspace_path,workspace_key,version)
      VALUES ('p','Legacy','${NOW}',NULL,NULL,1);
    INSERT INTO missions(id,project_id,title,goal,version,created_at,updated_at)
      VALUES ('m','p','Mission','Goal',1,'${NOW}','${NOW}');
    INSERT INTO work_items(id,mission_id,title,description,status,assignee_agent_id,version,created_at,updated_at)
      VALUES ('w','m','Work','','done',NULL,1,'${NOW}','${NOW}');
    INSERT INTO memory_entries(id,project_id,type,content,source_type,source_ref,created_by,supersedes_id,created_at)
      VALUES ('mem-1','p','fact','first','owner_input','brief','owner',NULL,'${NOW}'),
             ('mem-2','p','fact','second','owner_input','brief','owner','mem-1','${NOW}');
  `);
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("SQLite v6 strict atomic migration", () => {
  it("creates the complete v6 tables, indexes, triggers, checks and foreign keys", () => {
    const database = openDatabase(databasePath());
    expect(version(database)).toBe(6);
    expect(names(database, "table")).toEqual(expect.arrayContaining([...V6_TABLES]));
    expect(names(database, "index")).toEqual(expect.arrayContaining([...V6_INDEXES]));
    expect(names(database, "trigger")).toEqual(expect.arrayContaining([...V6_TRIGGERS]));
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(validateV6(database)).toBeNull();

    const resultSql = (database.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='work_item_result_versions'",
    ).get() as { sql: string }).sql.replace(/\s+/g, " ").toLowerCase();
    expect(resultSql).toContain("unique(work_item_id,version)");
    expect(resultSql).toContain("foreign key(work_item_id,supersedes_result_id)");
    const headSql = (database.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='mission_delivery_heads'",
    ).get() as { sql: string }).sql.replace(/\s+/g, " ").toLowerCase();
    expect(headSql).toContain("next_event_sequence integer not null check(next_event_sequence>=1)");
    expect(headSql).toContain("state text not null check(state in ('ongoing','generating','completed','owner_terminated'))");
    database.close();
  });

  it("migrates complete v5 owner memory and legacy done fail-closed", () => {
    const path = databasePath();
    const v5 = makeV5(path);
    seedLegacyFacts(v5);
    v5.close();

    const migrated = openDatabase(path);
    expect(version(migrated)).toBe(6);
    expect(migrated.prepare("SELECT status FROM work_items WHERE id='w'").get())
      .toEqual({ status: "in_progress" });
    expect(migrated.prepare(
      `SELECT id,chain_id AS chainId,version,source_version AS sourceVersion,
              proposer_actor_type AS actor,persistence_actor AS persistence
       FROM memory_entries ORDER BY version`,
    ).all()).toEqual([
      { actor: "owner", chainId: "mem-1", id: "mem-1", persistence: "platform", sourceVersion: null, version: 1 },
      { actor: "owner", chainId: "mem-1", id: "mem-2", persistence: "platform", sourceVersion: null, version: 2 },
    ]);
    expect(migrated.prepare(
      "SELECT state,context_version AS contextVersion,next_event_sequence AS nextSequence,version FROM mission_delivery_heads",
    ).get()).toEqual({ contextVersion: 1, nextSequence: 2, state: "ongoing", version: 1 });
    expect(validateV6(migrated)).toBeNull();
    migrated.close();
  });

  it("rejects partial v6 and drifted v5 before mutation", () => {
    const partialPath = databasePath();
    const partial = makeV5(partialPath);
    partial.exec("CREATE TABLE review_events(id TEXT PRIMARY KEY)");
    partial.close();
    expectOpenError(partialPath, "SCHEMA_DRIFT");
    const unchangedPartial = new DatabaseSync(partialPath);
    expect(version(unchangedPartial)).toBe(5);
    expect(hasAnyV6Object(unchangedPartial)).toBe(true);
    expect(names(unchangedPartial, "table")).not.toContain("mission_delivery_heads");
    unchangedPartial.close();

    const driftPath = databasePath();
    const drift = makeV5(driftPath);
    drift.exec("DROP INDEX work_item_execution_results_item");
    drift.close();
    expectOpenError(driftPath, "SCHEMA_DRIFT");
    const unchangedDrift = new DatabaseSync(driftPath);
    expect(version(unchangedDrift)).toBe(5);
    expect(hasAnyV6Object(unchangedDrift)).toBe(false);
    unchangedDrift.close();
  });

  it("rolls back every injected v6 migration step without orphan objects", () => {
    expect(v6.createV6, "complete createV6 must be exported").toBeTypeOf("function");
    const steps = [...(v6.V6_MIGRATION_STEPS ?? [])];
    expect(steps.length).toBeGreaterThan(8);

    for (const faultStep of steps) {
      const path = databasePath();
      const database = makeV5(path);
      seedLegacyFacts(database);
      database.exec("BEGIN IMMEDIATE");
      expect(() => v6.createV6!(database, (step) => {
        if (step === faultStep) throw new Error(`fault:${step}`);
      })).toThrow(`fault:${faultStep}`);
      database.exec("ROLLBACK");
      expect(version(database)).toBe(5);
      expect(hasAnyV6Object(database)).toBe(false);
      expect(database.prepare("SELECT status FROM work_items WHERE id='w'").get())
        .toEqual({ status: "done" });
      expect(database.prepare("SELECT COUNT(*) AS count FROM memory_entries").get())
        .toEqual({ count: 2 });
      database.close();
    }
  }, 30_000);

  it("is idempotent, enforces immutable history and rejects schema/data drift", () => {
    const path = databasePath();
    const first = openDatabase(path);
    const before = first.prepare(
      `SELECT type,name,sql FROM sqlite_master
       WHERE name IN (${[...V6_TABLES, ...V6_INDEXES, ...V6_TRIGGERS].map(() => "?").join(",")})
       ORDER BY type,name`,
    ).all(...V6_TABLES, ...V6_INDEXES, ...V6_TRIGGERS);
    first.close();
    const reopened = openDatabase(path);
    expect(reopened.prepare(
      `SELECT type,name,sql FROM sqlite_master
       WHERE name IN (${[...V6_TABLES, ...V6_INDEXES, ...V6_TRIGGERS].map(() => "?").join(",")})
       ORDER BY type,name`,
    ).all(...V6_TABLES, ...V6_INDEXES, ...V6_TRIGGERS)).toEqual(before);
    reopened.close();

    const drift = new DatabaseSync(path);
    drift.exec("DROP TRIGGER review_event_no_update");
    drift.close();
    expectOpenError(path, "SCHEMA_DRIFT");

    const orphanPath = databasePath();
    const valid = openDatabase(orphanPath);
    valid.close();
    const orphan = new DatabaseSync(orphanPath);
    orphan.exec("PRAGMA foreign_keys=OFF");
    orphan.exec(`INSERT INTO review_events(
      id,project_id,mission_id,sequence,type,actor_type,actor_id,payload_json,created_at
    ) VALUES ('e','missing','missing',1,'x','system',NULL,'{}','${NOW}')`);
    orphan.close();
    expectOpenError(orphanPath, "SCHEMA_DRIFT");
  });
});
