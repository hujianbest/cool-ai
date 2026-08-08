import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { openDatabaseAtV6 as openDatabase } from "@/tests/v6-fixture-db";
import { V5_INDEXES, V5_TABLES } from "@/src/server/migrations-v5";
import { V6_TRIGGERS } from "@/src/server/migrations-v6";

const V4_TABLES = [
  "collaboration_attempts",
  "collaboration_events",
  "collaboration_messages",
  "collaboration_model_calls",
  "collaboration_operations",
  "collaboration_project_sequences",
  "collaboration_runs",
  "collaboration_turns",
  "decision_requests",
] as const;

const V4_COLUMNS: Record<(typeof V4_TABLES)[number], string[]> = {
  collaboration_runs: [
    "id",
    "project_id",
    "status",
    "current_agent_id",
    "round_count",
    "next_event_sequence",
    "version",
    "execution_epoch",
    "pause_reason",
    "pause_category",
    "created_at",
    "updated_at",
  ],
  collaboration_operations: [
    "id",
    "project_id",
    "run_id",
    "kind",
    "request_hash",
    "status",
    "http_status",
    "response_json",
    "created_at",
    "updated_at",
  ],
  collaboration_project_sequences: ["project_id", "next_message_sequence"],
  collaboration_messages: [
    "id",
    "project_id",
    "run_id",
    "author_type",
    "author_agent_id",
    "author_display_name",
    "content",
    "mention_agent_id",
    "mention_display_name",
    "sequence",
    "consumed_at",
    "created_at",
  ],
  collaboration_attempts: [
    "id",
    "project_id",
    "run_id",
    "agent_id",
    "operation_id",
    "status",
    "lease_token",
    "lease_expires_at",
    "prompt_hash",
    "acquire_execution_epoch",
    "acquire_context_hash",
    "included_message_sequence",
    "error_category",
    "failure_provider_id",
    "failure_provider_version",
    "failure_credential_version",
    "failure_credential_generation",
    "failure_verified_at",
    "started_at",
    "finished_at",
  ],
  collaboration_model_calls: [
    "id",
    "attempt_id",
    "kind",
    "call_index",
    "status",
    "prompt_tokens",
    "completion_tokens",
    "total_tokens",
    "error_category",
    "created_at",
  ],
  collaboration_turns: [
    "id",
    "attempt_id",
    "run_id",
    "agent_id",
    "round_number",
    "message_id",
    "disposition",
    "created_at",
  ],
  decision_requests: [
    "id",
    "run_id",
    "turn_id",
    "requesting_agent_id",
    "question",
    "options_json",
    "status",
    "answer",
    "answer_message_id",
    "version",
    "created_at",
    "answered_at",
  ],
  collaboration_events: [
    "id",
    "run_id",
    "sequence",
    "type",
    "actor_type",
    "actor_id",
    "payload_json",
    "created_at",
  ],
};

const temporaryDirectories: string[] = [];

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "cockpit-v4-migration-"));
  temporaryDirectories.push(directory);
  return join(directory, "cockpit.sqlite");
}

function userVersion(database: DatabaseSync): number {
  return (database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
}

function objectNames(database: DatabaseSync, type: "table" | "view"): string[] {
  return (
    database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all(type) as Array<{ name: string }>
  ).map(({ name }) => name);
}

function makeCompleteV3(path: string): void {
  openDatabase(path).close();
  const database = new DatabaseSync(path);
  database.exec("PRAGMA foreign_keys=OFF");
  for (const trigger of V6_TRIGGERS) database.exec(`DROP TRIGGER IF EXISTS "${trigger}"`);
  for (const table of [
    "review_memory_associations", "review_memory_candidates", "review_escalation_answers",
    "review_escalations", "review_decisions", "review_model_calls", "review_attempts",
    "review_operations", "work_item_review_heads", "work_item_result_versions",
    "mission_delivery_heads", "mission_deliveries", "review_events", "memory_entries",
  ]) database.exec(`DROP TABLE IF EXISTS "${table}"`);
  database.exec(`
    CREATE TABLE memory_entries (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK(type IN ('goal','decision','fact','artifact')), content TEXT NOT NULL,
      source_type TEXT NOT NULL CHECK(source_type IN ('owner_input','work_item','artifact_path')),
      source_ref TEXT NOT NULL, created_by TEXT NOT NULL CHECK(created_by = 'owner'),
      supersedes_id TEXT UNIQUE REFERENCES memory_entries(id), created_at TEXT NOT NULL
    );
    ALTER TABLE agents DROP COLUMN review_capable;
  `);
  for (const table of [...V5_TABLES].reverse()) {
    database.exec(`DROP TABLE IF EXISTS "${table}"`);
  }
  for (const index of V5_INDEXES) {
    database.exec(`DROP INDEX IF EXISTS "${index}"`);
  }
  database.exec(`
    DROP TABLE decision_requests;
    DROP TABLE collaboration_turns;
    DROP TABLE collaboration_model_calls;
    DROP TABLE collaboration_attempts;
    DROP TABLE collaboration_events;
    DROP TABLE collaboration_messages;
    DROP TABLE collaboration_project_sequences;
    DROP TABLE collaboration_operations;
    DROP TABLE collaboration_runs;
    PRAGMA user_version = 3;
  `);
  database.close();
}

function expectSchemaDrift(path: string): void {
  let database: DatabaseSync | undefined;
  let error: unknown;
  try {
    database = openDatabase(path);
  } catch (caught) {
    error = caught;
  } finally {
    database?.close();
  }
  expect(error).toEqual(
    expect.objectContaining({ code: "SCHEMA_DRIFT", message: expect.not.stringContaining(path) }),
  );
}

function normalizedSql(database: DatabaseSync, type: "table" | "index", name: string): string {
  const row = database
    .prepare("SELECT sql FROM sqlite_master WHERE type = ? AND name = ?")
    .get(type, name) as { sql: string | null };
  return row.sql!.replace(/\s+/g, " ").toLowerCase();
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("SQLite v4 collaboration migration", () => {
  it("migrates only a complete v3 schema", () => {
    const completePath = databasePath();
    makeCompleteV3(completePath);
    const migrated = openDatabase(completePath);
    expect(userVersion(migrated)).toBe(6);
    expect(objectNames(migrated, "table")).toEqual(
      expect.arrayContaining([...V4_TABLES]),
    );
    migrated.close();

    const partialPath = databasePath();
    makeCompleteV3(partialPath);
    const partial = new DatabaseSync(partialPath);
    partial.exec("DROP TABLE memory_entries");
    partial.close();

    expectSchemaDrift(partialPath);
    const unchanged = new DatabaseSync(partialPath);
    expect(userVersion(unchanged)).toBe(3);
    expect(objectNames(unchanged, "table")).not.toContain("collaboration_runs");
    expect(objectNames(unchanged, "table")).not.toContain("memory_entries");
    unchanged.close();
  });

  it("rejects drifted v3 without repairing or writing DDL", () => {
    const path = databasePath();
    makeCompleteV3(path);
    const drifted = new DatabaseSync(path);
    drifted.exec("ALTER TABLE work_items ADD COLUMN unexpected TEXT");
    drifted.close();

    expectSchemaDrift(path);
    const unchanged = new DatabaseSync(path);
    expect(userVersion(unchanged)).toBe(3);
    expect(
      (unchanged.prepare("PRAGMA table_info(work_items)").all() as Array<{ name: string }>).map(
        ({ name }) => name,
      ),
    ).toContain("unexpected");
    expect(objectNames(unchanged, "table")).not.toContain("collaboration_runs");
    unchanged.close();
  });

  it("preserves existing v3 project, membership, mission, work-item, dependency, and memory rows", () => {
    const path = databasePath();
    makeCompleteV3(path);
    const existing = new DatabaseSync(path);
    existing.exec(`
      PRAGMA foreign_keys = ON;
      INSERT INTO projects (id, name, created_at, workspace_path, workspace_key, version)
        VALUES ('project-1', 'Existing', 'now', 'D:/workspace', 'workspace-1', 3);
      INSERT INTO providers (
        id, name, base_url, default_model, api_key_cipher, api_key_iv, api_key_tag,
        credential_version, credential_generation, key_id, api_key_mask, verified_at,
        version, created_at, updated_at
      ) VALUES (
        'provider-1', 'Provider', 'https://example.invalid', 'model', 'cipher', 'iv', 'tag',
        1, 1, 'key', '****', 'now', 1, 'now', 'now'
      );
      INSERT INTO agents (
        id, name, role, system_prompt, provider_id, model, avatar_text, accent_token,
        can_read, can_write, can_execute, max_tokens, max_handoffs, version, created_at, updated_at
      ) VALUES (
        'agent-1', 'Agent', 'Role', 'Prompt', 'provider-1', 'model', 'A', 'sage',
        1, 0, 0, 1000, 2, 1, 'now', 'now'
      );
      INSERT INTO project_memberships VALUES ('project-1', 'agent-1', 'now');
      INSERT INTO missions VALUES ('mission-1', 'project-1', 'Mission', 'Goal', 2, 'now', 'now');
      INSERT INTO work_items VALUES
        ('work-1', 'mission-1', 'First', '', 'done', 'agent-1', 2, 'now', 'now'),
        ('work-2', 'mission-1', 'Second', '', 'todo', NULL, 1, 'now', 'now');
      INSERT INTO work_item_dependencies VALUES ('work-2', 'work-1');
      INSERT INTO memory_entries VALUES (
        'memory-1', 'project-1', 'fact', 'Keep me', 'owner_input', 'owner', 'owner', NULL, 'now'
      );
    `);
    existing.close();

    const migrated = openDatabase(path);
    expect(migrated.prepare("SELECT name, version FROM projects").get()).toEqual({
      name: "Existing",
      version: 3,
    });
    expect(migrated.prepare("SELECT * FROM project_memberships").all()).toHaveLength(1);
    expect(migrated.prepare("SELECT title, version FROM missions").get()).toEqual({
      title: "Mission",
      version: 2,
    });
    expect(migrated.prepare("SELECT id FROM work_items ORDER BY id").all()).toEqual([
      { id: "work-1" },
      { id: "work-2" },
    ]);
    expect(migrated.prepare("SELECT * FROM work_item_dependencies").all()).toHaveLength(1);
    expect(migrated.prepare("SELECT content FROM memory_entries").get()).toEqual({
      content: "Keep me",
    });
    migrated.close();
  });

  it("rolls back all v4 DDL and user_version after an injected DDL failure", () => {
    const path = databasePath();
    makeCompleteV3(path);
    const faulted = new DatabaseSync(path);
    faulted.exec("CREATE VIEW collaboration_model_calls AS SELECT id FROM projects");
    faulted.close();

    expect(() => openDatabase(path)).toThrowError(
      expect.objectContaining({
        code: "STORAGE_UNAVAILABLE",
        message: expect.not.stringContaining(path),
      }),
    );

    const rolledBack = new DatabaseSync(path);
    expect(userVersion(rolledBack)).toBe(3);
    expect(objectNames(rolledBack, "view")).toContain("collaboration_model_calls");
    for (const table of V4_TABLES) {
      expect(objectNames(rolledBack, "table")).not.toContain(table);
    }
    rolledBack.close();
  });

  it("creates the complete v4 columns, foreign keys, checks, and unique indexes", () => {
    const database = openDatabase(databasePath());

    for (const table of V4_TABLES) {
      const columns = (
        database.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>
      ).map(({ name }) => name);
      expect(columns, table).toEqual(V4_COLUMNS[table]);
    }

    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(normalizedSql(database, "table", "collaboration_attempts")).toContain(
      "foreign key(project_id,operation_id) references collaboration_operations(project_id,id)",
    );
    expect(normalizedSql(database, "table", "collaboration_runs")).toContain(
      "check(status in ('running','waiting_owner','paused','failed','planned','stopped'))",
    );
    expect(normalizedSql(database, "table", "collaboration_operations")).toContain(
      "check(status in ('pending','completed'))",
    );
    expect(normalizedSql(database, "table", "collaboration_attempts")).toContain(
      "check(status in ('calling','committed','failed','interrupted','discarded'))",
    );
    expect(normalizedSql(database, "index", "collaboration_one_active_project")).toContain(
      "where status in ('running','waiting_owner','paused','failed')",
    );
    expect(normalizedSql(database, "index", "collaboration_one_calling_attempt")).toContain(
      "where status='calling'",
    );
    expect(normalizedSql(database, "index", "collaboration_one_open_decision")).toContain(
      "where status='open'",
    );
    const messageIndexes = database
      .prepare("PRAGMA index_list(collaboration_messages)")
      .all() as Array<{ name: string; unique: number }>;
    expect(
      messageIndexes.some(({ name, unique }) => {
        const columns = (
          database.prepare(`PRAGMA index_info("${name}")`).all() as Array<{
            name: string;
            seqno: number;
          }>
        )
          .sort((left, right) => left.seqno - right.seqno)
          .map(({ name: column }) => column);
        return unique === 1 && columns.join(",") === "project_id,sequence";
      }),
    ).toBe(true);
    database.close();
  });

  it.each([
    {
      name: "column drift",
      mutate: "ALTER TABLE collaboration_events ADD COLUMN unexpected TEXT",
    },
    {
      name: "foreign-key drift",
      mutate: `
        DROP TABLE collaboration_project_sequences;
        CREATE TABLE collaboration_project_sequences (
          project_id TEXT PRIMARY KEY,
          next_message_sequence INTEGER NOT NULL DEFAULT 1
        )
      `,
    },
    {
      name: "CHECK drift",
      mutate: `
        DROP TABLE collaboration_operations;
        CREATE TABLE collaboration_operations (
          id TEXT NOT NULL,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          run_id TEXT REFERENCES collaboration_runs(id) ON DELETE CASCADE,
          kind TEXT NOT NULL,
          request_hash TEXT NOT NULL,
          status TEXT NOT NULL,
          http_status INTEGER,
          response_json TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(project_id,id)
        )
      `,
    },
    {
      name: "active-run partial unique index drift",
      mutate: `
        DROP INDEX collaboration_one_active_project;
        CREATE UNIQUE INDEX collaboration_one_active_project
          ON collaboration_runs(project_id) WHERE status = 'running'
      `,
    },
    {
      name: "calling-attempt partial unique index drift",
      mutate: `
        DROP INDEX collaboration_one_calling_attempt;
        CREATE UNIQUE INDEX collaboration_one_calling_attempt
          ON collaboration_attempts(run_id) WHERE status = 'failed'
      `,
    },
    {
      name: "open-decision partial unique index drift",
      mutate: `
        DROP INDEX collaboration_one_open_decision;
        CREATE UNIQUE INDEX collaboration_one_open_decision
          ON decision_requests(run_id) WHERE status = 'answered'
      `,
    },
    {
      name: "project-message unique index drift",
      mutate: `
        DROP TABLE collaboration_messages;
        CREATE TABLE collaboration_messages (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          run_id TEXT REFERENCES collaboration_runs(id) ON DELETE SET NULL,
          author_type TEXT NOT NULL CHECK(author_type IN ('owner','agent')),
          author_agent_id TEXT REFERENCES agents(id),
          author_display_name TEXT NOT NULL,
          content TEXT NOT NULL,
          mention_agent_id TEXT REFERENCES agents(id),
          mention_display_name TEXT,
          sequence INTEGER NOT NULL,
          consumed_at TEXT,
          created_at TEXT NOT NULL
        )
      `,
    },
  ])("rejects $name in v4 without repair", ({ mutate }) => {
    const path = databasePath();
    openDatabase(path).close();
    const drifted = new DatabaseSync(path);
    drifted.exec(mutate);
    drifted.close();

    expectSchemaDrift(path);
    const unchanged = new DatabaseSync(path);
    expect(userVersion(unchanged)).toBe(6);
    unchanged.close();
  });

  it("reopens a valid v4 database idempotently without changing data or schema SQL", () => {
    const path = databasePath();
    const first = openDatabase(path);
    first.exec(`
      INSERT INTO projects (id, name, created_at, workspace_path, workspace_key, version)
        VALUES ('project-1', 'Persisted', 'now', NULL, NULL, 1);
      INSERT INTO collaboration_project_sequences (project_id, next_message_sequence)
        VALUES ('project-1', 7);
    `);
    const beforeSchema = first
      .prepare(
        `SELECT type, name, sql FROM sqlite_master
         WHERE name LIKE 'collaboration_%' OR name = 'decision_requests'
         ORDER BY type, name`,
      )
      .all();
    first.close();

    const second = openDatabase(path);
    expect(userVersion(second)).toBe(6);
    expect(
      second
        .prepare(
          `SELECT type, name, sql FROM sqlite_master
           WHERE name LIKE 'collaboration_%' OR name = 'decision_requests'
           ORDER BY type, name`,
        )
        .all(),
    ).toEqual(beforeSchema);
    expect(
      second.prepare("SELECT next_message_sequence FROM collaboration_project_sequences").get(),
    ).toEqual({ next_message_sequence: 7 });
    second.close();
  });
});
