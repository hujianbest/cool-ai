import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "@/src/server/db";

const S1_SCHEMA = `
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE task_runs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    goal TEXT NOT NULL,
    status TEXT NOT NULL,
    result TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE task_events (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES task_runs(id),
    sequence INTEGER NOT NULL,
    status TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(task_id, sequence)
  );
`;

const S2_SCHEMA = `
  CREATE TABLE providers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    default_model TEXT NOT NULL,
    api_key_cipher TEXT NOT NULL,
    api_key_iv TEXT NOT NULL,
    api_key_tag TEXT NOT NULL,
    credential_version INTEGER NOT NULL CHECK(credential_version = 1),
    credential_generation INTEGER NOT NULL CHECK(credential_generation >= 1),
    key_id TEXT NOT NULL,
    api_key_mask TEXT NOT NULL,
    verified_at TEXT NOT NULL,
    version INTEGER NOT NULL CHECK(version >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE skills (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    instructions TEXT NOT NULL,
    version INTEGER NOT NULL CHECK(version >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    role TEXT NOT NULL,
    system_prompt TEXT NOT NULL,
    provider_id TEXT NOT NULL REFERENCES providers(id),
    model TEXT NOT NULL,
    avatar_text TEXT NOT NULL,
    accent_token TEXT NOT NULL,
    can_read INTEGER NOT NULL CHECK(can_read IN (0,1)),
    can_write INTEGER NOT NULL CHECK(can_write IN (0,1)),
    can_execute INTEGER NOT NULL CHECK(can_execute IN (0,1)),
    max_tokens INTEGER NOT NULL,
    max_handoffs INTEGER NOT NULL,
    version INTEGER NOT NULL CHECK(version >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE agent_skills (
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    skill_id TEXT NOT NULL REFERENCES skills(id),
    position INTEGER NOT NULL,
    PRIMARY KEY(agent_id, skill_id),
    UNIQUE(agent_id, position)
  );
`;

const temporaryDirectories: string[] = [];

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "cockpit-migrations-"));
  temporaryDirectories.push(directory);
  return join(directory, "cockpit.sqlite");
}

function createFixture(path: string, sql: string): void {
  const database = new DatabaseSync(path);
  database.exec(sql);
  database.close();
}

function userVersion(database: DatabaseSync): number {
  return (database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
}

function tableNames(database: DatabaseSync): string[] {
  return (
    database
      .prepare(`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name
      `)
      .all() as Array<{ name: string }>
  ).map(({ name }) => name);
}

function expectSchemaError(path: string, code: string): void {
  expect(() => openDatabase(path)).toThrowError(
    expect.objectContaining({ code, message: expect.not.stringContaining(path) }),
  );
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("database migrations", () => {
  it("migrates an empty v0 database through v1-v3 to the complete v4 schema", () => {
    const database = openDatabase(databasePath());

    expect(userVersion(database)).toBe(7);
    expect(tableNames(database)).toEqual(expect.arrayContaining([
      "agent_skills",
      "agents",
      "collaboration_attempts",
      "collaboration_events",
      "collaboration_messages",
      "collaboration_model_calls",
      "collaboration_operations",
      "collaboration_project_sequences",
      "collaboration_runs",
      "collaboration_turns",
      "decision_requests",
      "memory_entries",
      "missions",
      "project_memberships",
      "projects",
      "providers",
      "skills",
      "task_events",
      "task_runs",
      "work_item_dependencies",
      "work_items",
    ]));
    expect(database.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    database.close();
  });

  it("adopts a real S-1 legacy v0 database and preserves its data and foreign keys", () => {
    const path = databasePath();
    createFixture(
      path,
      `${S1_SCHEMA}
       INSERT INTO projects VALUES ('project-1', 'Existing', '2026-07-29T00:00:00.000Z');
       INSERT INTO task_runs VALUES (
         'task-1', 'project-1', 'Keep me', 'queued', NULL, NULL,
         '2026-07-29T00:00:00.000Z', '2026-07-29T00:00:00.000Z'
       );
       INSERT INTO task_events VALUES (
         'event-1', 'task-1', 1, 'queued', 'Created', '2026-07-29T00:00:00.000Z'
       );`,
    );

    const database = openDatabase(path);

    expect(userVersion(database)).toBe(7);
    expect(database.prepare("SELECT name FROM projects").all()).toEqual([{ name: "Existing" }]);
    expect(database.prepare("SELECT goal FROM task_runs").all()).toEqual([{ goal: "Keep me" }]);
    expect(database.prepare("SELECT message FROM task_events").all()).toEqual([
      { message: "Created" },
    ]);
    expect(() =>
      database
        .prepare(`
          INSERT INTO task_runs (
            id, project_id, goal, status, result, error, created_at, updated_at
          ) VALUES ('orphan', 'missing', 'No owner', 'queued', NULL, NULL, 'now', 'now')
        `)
        .run(),
    ).toThrow();
    database.close();
  });

  it("upgrades a valid v1 database to v4", () => {
    const v1Path = databasePath();
    createFixture(v1Path, `${S1_SCHEMA} PRAGMA user_version = 1;`);

    const upgraded = openDatabase(v1Path);
    expect(userVersion(upgraded)).toBe(7);
    expect(tableNames(upgraded)).toContain("agent_skills");
    upgraded.close();
  });

  it("reopens a migrated database idempotently without changing persisted rows", () => {
    const path = databasePath();
    const first = openDatabase(path);
    first
      .prepare(`
        INSERT INTO skills (
          id, name, description, instructions, version, created_at, updated_at
        ) VALUES ('skill-1', 'Persisted', '', 'Keep this', 1, 'now', 'now')
      `)
      .run();
    first.close();

    const second = openDatabase(path);
    expect(userVersion(second)).toBe(7);
    expect(second.prepare("SELECT name FROM skills").all()).toEqual([{ name: "Persisted" }]);
    second.close();
  });

  it("rejects incomplete and drifted legacy v0 schemas without repairing them", () => {
    const incompletePath = databasePath();
    createFixture(
      incompletePath,
      `
        CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE task_runs (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id),
          goal TEXT NOT NULL,
          status TEXT NOT NULL,
          result TEXT,
          error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `,
    );
    expectSchemaError(incompletePath, "SCHEMA_DRIFT");

    const driftedPath = databasePath();
    createFixture(
      driftedPath,
      `
        CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE task_runs (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          goal TEXT NOT NULL,
          status TEXT NOT NULL,
          result TEXT,
          error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE task_events (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES task_runs(id),
          sequence INTEGER NOT NULL,
          status TEXT NOT NULL,
          message TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
      `,
    );
    expectSchemaError(driftedPath, "SCHEMA_DRIFT");

    const database = new DatabaseSync(driftedPath);
    expect(userVersion(database)).toBe(0);
    expect(tableNames(database)).not.toContain("skills");
    database.close();
  });

  it("rejects schemas newer than the application", () => {
    const path = databasePath();
    createFixture(path, `${S1_SCHEMA} ${S2_SCHEMA} PRAGMA user_version = 8;`);

    expectSchemaError(path, "SCHEMA_TOO_NEW");
  });

  it("rejects a drifted v1 before mutation and preserves its version, tables and data", () => {
    const path = databasePath();
    createFixture(
      path,
      `
        CREATE TABLE projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE task_runs (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          goal TEXT NOT NULL,
          status TEXT NOT NULL,
          result TEXT,
          error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE task_events (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES task_runs(id),
          sequence INTEGER NOT NULL,
          status TEXT NOT NULL,
          message TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE(task_id, sequence)
        );
        INSERT INTO projects VALUES ('keep-project', 'Keep this data', 'now');
        PRAGMA user_version = 1;
      `,
    );
    const before = new DatabaseSync(path);
    const beforeTables = tableNames(before);
    const beforeProject = before.prepare("SELECT * FROM projects").get();
    before.close();

    expectSchemaError(path, "SCHEMA_DRIFT");

    const after = new DatabaseSync(path);
    expect(userVersion(after)).toBe(1);
    expect(tableNames(after)).toEqual(beforeTables);
    expect(tableNames(after)).not.toContain("providers");
    expect(after.prepare("SELECT * FROM projects").get()).toEqual(beforeProject);
    after.close();
  });

  it("rolls back a failed v1 to v2 migration and closes the failed connection", () => {
    const path = databasePath();
    createFixture(
      path,
      `${S1_SCHEMA}
       PRAGMA user_version = 1;
       CREATE VIEW agents_provider_id_idx AS SELECT id FROM projects;`,
    );

    expectSchemaError(path, "STORAGE_UNAVAILABLE");

    const database = new DatabaseSync(path);
    expect(userVersion(database)).toBe(1);
    expect(tableNames(database)).toEqual(["projects", "task_events", "task_runs"]);
    database.close();

    expect(() => rmSync(path)).not.toThrow();
  });
});
