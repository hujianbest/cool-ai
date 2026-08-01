import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "@/src/server/db";
import { V5_INDEXES, V5_TABLES } from "@/src/server/migrations-v5";
import { V6_TRIGGERS } from "@/src/server/migrations-v6";

const temporaryDirectories: string[] = [];

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "cockpit-context-migration-"));
  temporaryDirectories.push(directory);
  return join(directory, "cockpit.sqlite");
}

function userVersion(database: DatabaseSync): number {
  return (database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
}

function projectColumns(database: DatabaseSync): string[] {
  return (
    database.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>
  ).map(({ name }) => name);
}

function createPopulatedV2(path: string): void {
  const database = openDatabase(path);
  database.exec(`
    INSERT INTO projects (id, name, created_at)
      VALUES ('project-1', 'Existing project', '2026-07-29T00:00:00.000Z');
    INSERT INTO task_runs (
      id, project_id, goal, status, result, error, created_at, updated_at
    ) VALUES (
      'task-1', 'project-1', 'Keep task', 'done', 'Kept result', NULL,
      '2026-07-29T00:00:00.000Z', '2026-07-29T00:00:00.000Z'
    );
    INSERT INTO task_events (id, task_id, sequence, status, message, created_at)
      VALUES ('event-1', 'task-1', 1, 'done', 'Keep event', '2026-07-29T00:00:00.000Z');
    INSERT INTO providers (
      id, name, base_url, default_model, api_key_cipher, api_key_iv, api_key_tag,
      credential_version, credential_generation, key_id, api_key_mask, verified_at,
      version, created_at, updated_at
    ) VALUES (
      'provider-1', 'Provider', 'https://example.invalid', 'model', 'cipher', 'iv', 'tag',
      1, 1, 'key-1', '****', '2026-07-29T00:00:00.000Z',
      1, '2026-07-29T00:00:00.000Z', '2026-07-29T00:00:00.000Z'
    );
    INSERT INTO skills (id, name, description, instructions, version, created_at, updated_at)
      VALUES ('skill-1', 'Skill', 'Description', 'Keep instructions', 1, 'now', 'now');
    INSERT INTO agents (
      id, name, role, system_prompt, provider_id, model, avatar_text, accent_token,
      can_read, can_write, can_execute, max_tokens, max_handoffs, version, created_at, updated_at
    ) VALUES (
      'agent-1', 'Agent', 'Role', 'Keep prompt', 'provider-1', 'model', 'A', 'sage',
      1, 0, 0, 2048, 2, 1, 'now', 'now'
    );
    INSERT INTO agent_skills (agent_id, skill_id, position)
      VALUES ('agent-1', 'skill-1', 0);
  `);
  database.close();

  const v2 = new DatabaseSync(path);
  v2.exec("PRAGMA foreign_keys=OFF");
  for (const trigger of V6_TRIGGERS) v2.exec(`DROP TRIGGER IF EXISTS "${trigger}"`);
  for (const table of [
    "review_memory_associations", "review_memory_candidates", "review_escalation_answers",
    "review_escalations", "review_decisions", "review_model_calls", "review_attempts",
    "review_operations", "work_item_review_heads", "work_item_result_versions",
    "mission_delivery_heads", "mission_deliveries", "review_events", "memory_entries",
  ]) v2.exec(`DROP TABLE IF EXISTS "${table}"`);
  v2.exec(`
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
    v2.exec(`DROP TABLE IF EXISTS "${table}"`);
  }
  for (const index of V5_INDEXES) {
    v2.exec(`DROP INDEX IF EXISTS "${index}"`);
  }
  v2.exec(`
    DROP TABLE decision_requests;
    DROP TABLE collaboration_turns;
    DROP TABLE collaboration_model_calls;
    DROP TABLE collaboration_attempts;
    DROP TABLE collaboration_events;
    DROP TABLE collaboration_messages;
    DROP TABLE collaboration_project_sequences;
    DROP TABLE collaboration_operations;
    DROP TABLE collaboration_runs;
    DROP INDEX projects_workspace_key_unique;
    ALTER TABLE projects DROP COLUMN workspace_key;
    ALTER TABLE projects DROP COLUMN workspace_path;
    ALTER TABLE projects DROP COLUMN version;
    PRAGMA user_version = 2;
  `);
  v2.close();
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("version 3 context migration", () => {
  it("validates v2, migrates atomically, and preserves S-1 and S-2 rows", () => {
    const path = databasePath();
    createPopulatedV2(path);

    const migrated = openDatabase(path);

    expect(userVersion(migrated)).toBe(6);
    expect(projectColumns(migrated)).toEqual([
      "id",
      "name",
      "created_at",
      "workspace_path",
      "workspace_key",
      "version",
    ]);
    expect(migrated.prepare("SELECT name FROM projects").get()).toEqual({
      name: "Existing project",
    });
    expect(migrated.prepare("SELECT goal, result FROM task_runs").get()).toEqual({
      goal: "Keep task",
      result: "Kept result",
    });
    expect(migrated.prepare("SELECT message FROM task_events").get()).toEqual({
      message: "Keep event",
    });
    expect(migrated.prepare("SELECT name FROM providers").get()).toEqual({ name: "Provider" });
    expect(migrated.prepare("SELECT instructions FROM skills").get()).toEqual({
      instructions: "Keep instructions",
    });
    expect(migrated.prepare("SELECT system_prompt AS systemPrompt FROM agents").get()).toEqual({
      systemPrompt: "Keep prompt",
    });
    expect(migrated.prepare("SELECT * FROM agent_skills").get()).toEqual({
      agent_id: "agent-1",
      skill_id: "skill-1",
      position: 0,
    });
    expect(
      migrated
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
        .get("projects_workspace_key_unique"),
    ).toEqual(
      expect.objectContaining({
        sql: expect.stringContaining("WHERE workspace_key IS NOT NULL"),
      }),
    );
    expect(() =>
      migrated
        .prepare(
          "INSERT INTO task_runs VALUES ('orphan', 'missing', 'x', 'queued', NULL, NULL, 'now', 'now')",
        )
        .run(),
    ).toThrow();
    migrated.close();

    const reopened = openDatabase(path);
    expect(userVersion(reopened)).toBe(6);
    expect(reopened.prepare("SELECT COUNT(*) AS count FROM projects").get()).toEqual({ count: 1 });
    reopened.close();
  });

  it("rejects drifted v2 before mutation and leaves its schema untouched", () => {
    const path = databasePath();
    createPopulatedV2(path);
    const drifted = new DatabaseSync(path);
    drifted.exec("ALTER TABLE projects ADD COLUMN unexpected TEXT");
    drifted.close();

    let migrationError: unknown;
    try {
      openDatabase(path).close();
    } catch (error) {
      migrationError = error;
    }
    expect(migrationError).toEqual(
      expect.objectContaining({ code: "SCHEMA_DRIFT", message: expect.not.stringContaining(path) }),
    );

    const unchanged = new DatabaseSync(path);
    expect(userVersion(unchanged)).toBe(2);
    expect(projectColumns(unchanged)).toEqual(["id", "name", "created_at", "unexpected"]);
    expect(unchanged.prepare("SELECT name FROM projects").get()).toEqual({
      name: "Existing project",
    });
    unchanged.close();
  });

  it("rolls back every v3 mutation after a DDL fault and closes the failed connection", () => {
    const path = databasePath();
    createPopulatedV2(path);
    const faulted = new DatabaseSync(path);
    faulted.exec(
      "CREATE VIEW projects_workspace_key_unique AS SELECT id FROM projects",
    );
    faulted.close();

    expect(() => openDatabase(path)).toThrowError(
      expect.objectContaining({
        code: "STORAGE_UNAVAILABLE",
        message: expect.not.stringContaining(path),
      }),
    );

    const rolledBack = new DatabaseSync(path);
    expect(userVersion(rolledBack)).toBe(2);
    expect(projectColumns(rolledBack)).toEqual(["id", "name", "created_at"]);
    expect(rolledBack.prepare("SELECT name FROM projects").get()).toEqual({
      name: "Existing project",
    });
    rolledBack.close();
    expect(() => rmSync(path)).not.toThrow();
  });
});
