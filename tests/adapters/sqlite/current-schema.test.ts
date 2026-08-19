import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { setCurrentSchemaBootstrapHookForTests } from "@/src/adapters/outbound/sqlite/bootstrap-current-schema";
import {
  CURRENT_SCHEMA,
  orderedCurrentSchemaObjects,
} from "@/src/adapters/outbound/sqlite/current-schema";
import { setCurrentSchemaSnapshotHookForTests } from "@/src/adapters/outbound/sqlite/validate-current-schema";

const temporaryDirectories: string[] = [];

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "cool-ai-current-schema-"));
  temporaryDirectories.push(directory);
  return join(directory, "cockpit.sqlite");
}

afterEach(() => {
  setCurrentSchemaBootstrapHookForTests(undefined);
  setCurrentSchemaSnapshotHookForTests(undefined);
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, maxRetries: 3, recursive: true, retryDelay: 20 });
  }
});

function schemaRows(database: DatabaseSync): unknown[] {
  return database.prepare(`
    SELECT type,name,tbl_name,sql
    FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%' AND type IN ('table','index','trigger')
    ORDER BY type,name
  `).all();
}

function expectSchemaError(path: string, code: string): void {
  expect(() => {
    const database = openDatabase(path);
    database.close();
  }).toThrowError(expect.objectContaining({ code }));
}

describe("current canonical schema", () => {
  it("declares every table FK dependency and schedules complete table stage before dependent objects", () => {
    const tables = CURRENT_SCHEMA.objects.filter((object) => object.kind === "table");
    expect(tables.some((table) => table.dependsOn.length > 0)).toBe(true);
    expect(tables.find((table) => table.name === "task_runs")?.dependsOn).toEqual([
      "projects",
    ]);
    expect(
      tables.find((table) => table.name === "mission_deliveries")?.dependsOn,
    ).toEqual(["mission_deliveries", "missions"]);
    for (const table of tables) {
      const references = [...table.createSql.matchAll(
        /\bREFERENCES\s+([A-Za-z_][A-Za-z0-9_]*)\b/giu,
      )].map((match) => match[1]).filter((name): name is string => name !== undefined);
      expect([...table.dependsOn].sort(), table.name).toEqual([...new Set(references)].sort());
    }

    const ordered = orderedCurrentSchemaObjects();
    const firstNonTable = ordered.findIndex((object) => object.kind !== "table");
    expect(ordered.slice(0, firstNonTable).every((object) => object.kind === "table")).toBe(true);
    for (const object of ordered.slice(firstNonTable)) {
      expect(object.dependsOn.every((dependency) =>
        ordered.findIndex((candidate) => candidate.name === dependency)
          < ordered.findIndex((candidate) => candidate.name === object.name))).toBe(true);
    }
  });

  it("bootstraps a missing database directly at identity 21", () => {
    const database = openDatabase(databasePath());
    try {
      expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 26 });
    } finally {
      database.close();
    }
  });

  it("bootstraps an existing empty SQLite database to the same canonical inventory", () => {
    const missingPath = databasePath();
    const emptyPath = databasePath();
    new DatabaseSync(emptyPath).close();

    const missing = openDatabase(missingPath);
    const expected = schemaRows(missing);
    missing.close();
    const empty = openDatabase(emptyPath);
    try {
      expect(empty.prepare("PRAGMA user_version").get()).toEqual({ user_version: 26 });
      expect(schemaRows(empty)).toEqual(expected);
    } finally {
      empty.close();
    }
  });

  it("contains canonical thread queue table and pending index", () => {
    const database = openDatabase(databasePath());
    try {
      const queueTable = database.prepare(`
        SELECT sql
        FROM sqlite_master
        WHERE type='table' AND name='thread_message_queue'
      `).get() as { sql: string } | undefined;
      const pendingIndex = database.prepare(`
        SELECT sql
        FROM sqlite_master
        WHERE type='index' AND name='thread_message_queue_pending_idx'
      `).get() as { sql: string } | undefined;
      expect(queueTable?.sql).toContain(
        "status TEXT NOT NULL CHECK(status IN('pending','consumed','cancelled'))",
      );
      expect(queueTable?.sql).toContain("UNIQUE(project_id,thread_id,position)");
      expect(pendingIndex?.sql).toContain("WHERE status='pending'");
    } finally {
      database.close();
    }
  });

  it("reopens an exact current database repeatedly without changing schema or facts", () => {
    const path = databasePath();
    const database = openDatabase(path);
    database.prepare(`
      INSERT INTO projects(id,name,created_at,version)
      VALUES ('project-current','Current','2026-08-09T00:00:00.000Z',1)
    `).run();
    database.close();
    const before = readFileSync(path);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const reopened = openDatabase(path);
      try {
        expect(reopened.prepare("SELECT id,name FROM projects").all()).toEqual([
          { id: "project-current", name: "Current" },
        ]);
      } finally {
        reopened.close();
      }
    }

    expect(readFileSync(path)).toEqual(before);
  }, 20000);

  it("rejects a non-empty user_version 0 database without adopting it", () => {
    const path = databasePath();
    const partial = new DatabaseSync(path);
    partial.exec("CREATE TABLE partial_marker(id TEXT PRIMARY KEY)");
    partial.close();

    expectSchemaError(path, "SCHEMA_UNSUPPORTED");

    const unchanged = new DatabaseSync(path);
    try {
      expect(unchanged.prepare("PRAGMA user_version").get()).toEqual({ user_version: 0 });
      expect(unchanged.prepare(`
        SELECT name FROM sqlite_master WHERE type='table' AND name='partial_marker'
      `).get()).toEqual({ name: "partial_marker" });
    } finally {
      unchanged.close();
    }
  });

  it("fails closed without bootstrapping a non-empty database containing a view", () => {
    const path = databasePath();
    const database = new DatabaseSync(path);
    database.exec("CREATE VIEW unexpected_user_view AS SELECT 1 AS value");
    database.close();
    const before = readFileSync(path);

    expectSchemaError(path, "SCHEMA_UNSUPPORTED");
    expect(readFileSync(path)).toEqual(before);
  });

  it.each([
    {
      label: "foreign-key violation",
      seed: (database: DatabaseSync) => database.exec(`
        INSERT INTO task_runs(
          id,project_id,goal,status,result,error,created_at,updated_at
        ) VALUES (
          'task-invalid','missing-project','Goal','queued',NULL,NULL,
          '2026-08-09T00:00:00.000Z','2026-08-09T00:00:00.000Z'
        )
      `),
    },
    {
      label: "current data-invariant violation",
      seed: (database: DatabaseSync) => database.exec(`
        INSERT INTO projects(id,name,created_at,version)
        VALUES ('project-invalid','Invalid','2026-08-09T00:00:00.000Z',1);
        INSERT INTO missions(id,project_id,title,goal,version,created_at,updated_at)
        VALUES (
          'mission-invalid','project-invalid','Mission','Goal',1,
          '2026-08-09T00:00:00.000Z','2026-08-09T00:00:00.000Z'
        )
      `),
    },
  ])("rejects exact current objects with $label", ({ seed }) => {
    const path = databasePath();
    openDatabase(path).close();
    const invalid = new DatabaseSync(path);
    try {
      invalid.exec("PRAGMA foreign_keys=OFF");
      seed(invalid);
    } finally {
      invalid.close();
    }

    expectSchemaError(path, "SCHEMA_DATA_INVALID");
  });

  it.each([
    {
      label: "extra object",
      mutate: (database: DatabaseSync) => database.exec("CREATE TABLE unexpected_object(id TEXT)"),
    },
    {
      label: "missing object",
      mutate: (database: DatabaseSync) => database.exec("DROP INDEX agents_provider_id_idx"),
    },
    {
      label: "changed object",
      mutate: (database: DatabaseSync) => database.exec(`
        DROP INDEX agents_provider_id_idx;
        CREATE INDEX agents_provider_id_idx ON agents(model)
      `),
    },
  ])("rejects current identity with $label drift", ({ mutate }) => {
    const path = databasePath();
    openDatabase(path).close();
    const drifted = new DatabaseSync(path);
    mutate(drifted);
    drifted.close();

    expectSchemaError(path, "SCHEMA_DRIFT");
  });

  it("rolls back a failed bootstrap before the current identity is published", () => {
    const path = databasePath();
    setCurrentSchemaBootstrapHookForTests(() => {
      throw new Error("controlled bootstrap fault");
    });

    expectSchemaError(path, "STORAGE_UNAVAILABLE");

    const afterFailure = new DatabaseSync(path);
    try {
      expect(afterFailure.prepare("PRAGMA user_version").get()).toEqual({ user_version: 0 });
      expect(schemaRows(afterFailure)).toEqual([]);
    } finally {
      afterFailure.close();
    }
    const recovered = openDatabase(path);
    try {
      expect(recovered.prepare("PRAGMA user_version").get()).toEqual({ user_version: 26 });
    } finally {
      recovered.close();
    }
  });

  it("validates one reopen against a single snapshot during concurrent schema change", () => {
    const path = databasePath();
    openDatabase(path).close();
    const journal = new DatabaseSync(path);
    expect(journal.prepare("PRAGMA journal_mode=WAL").get()).toEqual({ journal_mode: "wal" });
    journal.close();

    setCurrentSchemaSnapshotHookForTests(() => {
      const writer = new DatabaseSync(path);
      try {
        writer.exec("CREATE TABLE concurrent_drift(id TEXT PRIMARY KEY)");
      } finally {
        writer.close();
      }
    });
    const snapshotReopen = openDatabase(path);
    snapshotReopen.close();

    expectSchemaError(path, "SCHEMA_DRIFT");
  }, 20000);
});
