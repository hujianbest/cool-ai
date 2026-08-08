import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import * as migrationsV7 from "@/src/server/migrations-v7";

type Validation = "SCHEMA_DRIFT" | "SCHEMA_DATA_INVALID" | null;
type V7Module = {
  EXPECTED_V7_SQL?: ReadonlyMap<string, string>;
  V7_INDEX_TRIGGER_SQL?: ReadonlyMap<string, string>;
  V7_OBJECT_SQL?: readonly string[];
  V7_TABLE_SQL?: ReadonlyMap<string, string>;
  renderV7?: (prefix: "" | "v7_") => readonly string[];
  validateV7?: (database: DatabaseSync) => Validation;
};

const v7 = migrationsV7 as V7Module;
const expectedNames = [
  "collaboration_threads",
  "collaboration_project_thread_sequences",
  "collaboration_runs",
  "collaboration_operations",
  "collaboration_thread_policy_revisions",
  "collaboration_thread_policy_members",
  "collaboration_project_sequences",
  "collaboration_messages",
  "collaboration_attempts",
  "collaboration_model_calls",
  "collaboration_turns",
  "decision_requests",
  "collaboration_events",
  "collaboration_thread_facts",
  "collaboration_one_active_project",
  "collaboration_one_calling_attempt",
  "collaboration_one_open_decision",
  "thread_fact_one_created",
  "thread_fact_one_policy",
  "thread_fact_one_message",
  "thread_fact_one_run_link",
  "thread_fact_one_run_event",
  "collaboration_threads_activity_page",
  "collaboration_facts_page",
  "collaboration_runs_thread_page",
  "thread_policy_revision_no_update",
  "thread_policy_revision_no_delete",
  "thread_policy_member_no_update",
  "thread_policy_member_no_delete",
  "thread_fact_no_update",
  "thread_fact_no_delete",
  "thread_identity_no_update",
] as const;

const normalize = (sql: string): string =>
  sql.replace(/;\s*$/u, "").replace(/\s+/gu, " ").trim().toLowerCase();

function schemaDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE projects(id TEXT PRIMARY KEY);
    CREATE TABLE agents(id TEXT PRIMARY KEY);
  `);
  for (const sql of v7.renderV7?.("") ?? []) database.exec(sql);
  return database;
}

describe("v7 authoritative schema manifest", () => {
  it("renders every authoritative table, index, trigger, FK and deferred clause verbatim", () => {
    expect([...v7.V7_TABLE_SQL?.keys() ?? []]).toEqual(expectedNames.slice(0, 14));
    expect([...v7.V7_INDEX_TRIGGER_SQL?.keys() ?? []]).toEqual(expectedNames.slice(14));
    expect(v7.V7_OBJECT_SQL).toEqual([
      ...v7.V7_TABLE_SQL?.values() ?? [],
      ...v7.V7_INDEX_TRIGGER_SQL?.values() ?? [],
    ]);
    expect(v7.renderV7?.("")).toEqual(v7.V7_OBJECT_SQL);

    const expected = v7.EXPECTED_V7_SQL ?? new Map<string, string>();
    expect([...expected.keys()]).toEqual(expectedNames);
    for (const [name, sql] of [
      ...v7.V7_TABLE_SQL?.entries() ?? [],
      ...v7.V7_INDEX_TRIGGER_SQL?.entries() ?? [],
    ] as Array<[string, string]>) {
      expect(expected.get(name)).toBe(normalize(sql));
    }

    expect(normalize(v7.V7_TABLE_SQL?.get("collaboration_threads") ?? "")).toContain(
      "foreign key(project_id,id,active_policy_revision_id) references collaboration_thread_policy_revisions(project_id,thread_id,id) on delete no action deferrable initially deferred",
    );
    expect(normalize(v7.V7_TABLE_SQL?.get("collaboration_operations") ?? "")).toContain(
      "foreign key(project_id,thread_id) references collaboration_threads(project_id,id) on delete cascade deferrable initially deferred",
    );
    expect(normalize(v7.V7_TABLE_SQL?.get("collaboration_thread_policy_revisions") ?? "")).toContain(
      "foreign key(project_id,thread_id,created_operation_id) references collaboration_operations(project_id,thread_id,id) on delete no action deferrable initially deferred",
    );

    const database = schemaDatabase();
    const actual = database.prepare(
      `SELECT type,name,sql FROM sqlite_master
       WHERE name IN (${expectedNames.map(() => "?").join(",")})
       ORDER BY name`,
    ).all(...expectedNames) as Array<{ name: string; sql: string; type: string }>;
    expect(actual).toHaveLength(expectedNames.length);
    for (const row of actual) expect(normalize(row.sql)).toBe(expected.get(row.name));
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    database.close();
  });

  it("prefixes only known object identifiers for shadow rendering", () => {
    const finalSql = v7.renderV7?.("") ?? [];
    const shadowSql = v7.renderV7?.("v7_") ?? [];
    expect(shadowSql).toHaveLength(expectedNames.length);
    expect(shadowSql).toHaveLength(finalSql.length);
    for (const [index, sql] of shadowSql.entries()) {
      const names = new Set<string>(expectedNames);
      const expected = finalSql[index]!.replace(
        /\b[A-Za-z_][A-Za-z0-9_]*\b/gu,
        (identifier) => names.has(identifier) ? `v7_${identifier}` : identifier,
      );
      expect(sql).toBe(expected);
      expect(sql).toContain("v7_");
      expect(sql).not.toContain("'v7_");
    }
  });

  it("validates without mutating and rejects normalized SQL drift", () => {
    const database = schemaDatabase();
    expect(v7.validateV7, "validateV7 must be exported").toBeTypeOf("function");
    const before = database.prepare(
      "SELECT type,name,sql FROM sqlite_master ORDER BY type,name",
    ).all();
    expect(v7.validateV7?.(database)).toBeNull();
    expect(database.prepare(
      "SELECT type,name,sql FROM sqlite_master ORDER BY type,name",
    ).all()).toEqual(before);

    database.exec("CREATE INDEX collaboration_unexpected ON collaboration_runs(id)");
    expect(v7.validateV7?.(database)).toBe("SCHEMA_DRIFT");
    database.exec("DROP INDEX collaboration_unexpected");

    database.exec("DROP INDEX collaboration_runs_thread_page");
    database.exec(
      "CREATE INDEX collaboration_runs_thread_page ON collaboration_runs(project_id,created_at,id)",
    );
    expect(v7.validateV7?.(database)).toBe("SCHEMA_DRIFT");
    database.close();
  });
});
