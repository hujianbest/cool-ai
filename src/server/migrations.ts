import type { DatabaseSync } from "node:sqlite";

import { createV5, hasAnyV5Object, validateV5 } from "@/src/server/migrations-v5";
import {
  createV6,
  hasAnyV6Object,
  validateV6,
} from "@/src/server/migrations-v6";

type SchemaErrorCode =
  | "SCHEMA_DATA_INVALID"
  | "SCHEMA_DRIFT"
  | "SCHEMA_TOO_NEW"
  | "STORAGE_UNAVAILABLE";

type TableInfo = {
  dflt_value: string | null;
  name: string;
  notnull: number;
  pk: number;
  type: string;
};

type ForeignKeyInfo = {
  id: number;
  from: string;
  on_delete: string;
  seq: number;
  table: string;
  to: string;
};

type IndexInfo = {
  name: string;
  unique: number;
};

export class SchemaMigrationError extends Error {
  constructor(public readonly code: SchemaErrorCode, message: string) {
    super(message);
    this.name = "SchemaMigrationError";
  }
}

const S1_TABLES = ["projects", "task_runs", "task_events"] as const;
const S2_TABLES = ["providers", "skills", "agents", "agent_skills"] as const;

const REQUIRED_COLUMNS: Record<string, readonly string[]> = {
  projects: ["id", "name", "created_at"],
  task_runs: [
    "id",
    "project_id",
    "goal",
    "status",
    "result",
    "error",
    "created_at",
    "updated_at",
  ],
  task_events: ["id", "task_id", "sequence", "status", "message", "created_at"],
  providers: [
    "id",
    "name",
    "base_url",
    "default_model",
    "api_key_cipher",
    "api_key_iv",
    "api_key_tag",
    "credential_version",
    "credential_generation",
    "key_id",
    "api_key_mask",
    "verified_at",
    "version",
    "created_at",
    "updated_at",
  ],
  skills: ["id", "name", "description", "instructions", "version", "created_at", "updated_at"],
  agents: [
    "id",
    "name",
    "role",
    "system_prompt",
    "provider_id",
    "model",
    "avatar_text",
    "accent_token",
    "can_read",
    "can_write",
    "can_execute",
    "max_tokens",
    "max_handoffs",
    "version",
    "created_at",
    "updated_at",
  ],
  agent_skills: ["agent_id", "skill_id", "position"],
  project_memberships: ["project_id", "agent_id", "joined_at"],
  missions: [
    "id",
    "project_id",
    "title",
    "goal",
    "version",
    "created_at",
    "updated_at",
  ],
  work_items: [
    "id",
    "mission_id",
    "title",
    "description",
    "status",
    "assignee_agent_id",
    "version",
    "created_at",
    "updated_at",
  ],
  work_item_dependencies: ["work_item_id", "depends_on_id"],
  memory_entries: [
    "id",
    "project_id",
    "type",
    "content",
    "source_type",
    "source_ref",
    "created_by",
    "supersedes_id",
    "created_at",
  ],
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

const INTEGER_COLUMNS = new Set([
  "projects.version",
  "task_events.sequence",
  "providers.credential_version",
  "providers.credential_generation",
  "providers.version",
  "skills.version",
  "agents.can_read",
  "agents.can_write",
  "agents.can_execute",
  "agents.review_capable",
  "agents.max_tokens",
  "agents.max_handoffs",
  "agents.version",
  "agent_skills.position",
  "missions.version",
  "work_items.version",
  "collaboration_runs.round_count",
  "collaboration_runs.next_event_sequence",
  "collaboration_runs.version",
  "collaboration_runs.execution_epoch",
  "collaboration_operations.http_status",
  "collaboration_project_sequences.next_message_sequence",
  "collaboration_messages.sequence",
  "collaboration_attempts.acquire_execution_epoch",
  "collaboration_attempts.included_message_sequence",
  "collaboration_attempts.failure_provider_version",
  "collaboration_attempts.failure_credential_version",
  "collaboration_attempts.failure_credential_generation",
  "collaboration_model_calls.call_index",
  "collaboration_model_calls.prompt_tokens",
  "collaboration_model_calls.completion_tokens",
  "collaboration_model_calls.total_tokens",
  "collaboration_turns.round_number",
  "decision_requests.version",
  "collaboration_events.sequence",
]);

const NULLABLE_COLUMNS = new Set([
  "projects.workspace_path",
  "projects.workspace_key",
  "task_runs.result",
  "task_runs.error",
  "work_items.assignee_agent_id",
  "memory_entries.supersedes_id",
  "collaboration_runs.pause_reason",
  "collaboration_runs.pause_category",
  "collaboration_operations.run_id",
  "collaboration_operations.http_status",
  "collaboration_operations.response_json",
  "collaboration_messages.run_id",
  "collaboration_messages.author_agent_id",
  "collaboration_messages.mention_agent_id",
  "collaboration_messages.mention_display_name",
  "collaboration_messages.consumed_at",
  "collaboration_attempts.error_category",
  "collaboration_attempts.failure_provider_id",
  "collaboration_attempts.failure_provider_version",
  "collaboration_attempts.failure_credential_version",
  "collaboration_attempts.failure_credential_generation",
  "collaboration_attempts.failure_verified_at",
  "collaboration_attempts.finished_at",
  "collaboration_model_calls.prompt_tokens",
  "collaboration_model_calls.completion_tokens",
  "collaboration_model_calls.total_tokens",
  "collaboration_model_calls.error_category",
  "decision_requests.answer",
  "decision_requests.answer_message_id",
  "decision_requests.answered_at",
  "collaboration_events.actor_id",
]);

const EXPLICIT_NOT_NULL_PRIMARY_KEYS = new Set([
  "agent_skills.agent_id",
  "agent_skills.skill_id",
  "project_memberships.project_id",
  "project_memberships.agent_id",
  "work_item_dependencies.work_item_id",
  "work_item_dependencies.depends_on_id",
  "collaboration_operations.id",
  "collaboration_operations.project_id",
]);

const CREATE_S1 = `
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

const CREATE_S2 = `
  CREATE TABLE IF NOT EXISTS providers (
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
  CREATE TABLE IF NOT EXISTS skills (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    instructions TEXT NOT NULL,
    version INTEGER NOT NULL CHECK(version >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS agents (
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
  CREATE TABLE IF NOT EXISTS agent_skills (
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    skill_id TEXT NOT NULL REFERENCES skills(id),
    position INTEGER NOT NULL,
    PRIMARY KEY(agent_id, skill_id),
    UNIQUE(agent_id, position)
  );
  CREATE INDEX agents_provider_id_idx ON agents(provider_id);
  CREATE INDEX agent_skills_skill_id_idx ON agent_skills(skill_id);
`;

const CREATE_WORKSPACE_BINDING = `
  ALTER TABLE projects ADD COLUMN workspace_path TEXT;
  ALTER TABLE projects ADD COLUMN workspace_key TEXT;
  ALTER TABLE projects ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
  CREATE UNIQUE INDEX projects_workspace_key_unique
    ON projects(workspace_key) WHERE workspace_key IS NOT NULL;
  CREATE TABLE IF NOT EXISTS project_memberships (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL REFERENCES agents(id),
    joined_at TEXT NOT NULL,
    PRIMARY KEY(project_id, agent_id)
  );
  CREATE TABLE IF NOT EXISTS missions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    goal TEXT NOT NULL,
    version INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS work_items (
    id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('todo','in_progress','blocked','done')),
    assignee_agent_id TEXT REFERENCES agents(id),
    version INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS work_item_dependencies (
    work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
    depends_on_id TEXT NOT NULL REFERENCES work_items(id),
    PRIMARY KEY(work_item_id, depends_on_id),
    CHECK(work_item_id <> depends_on_id)
  );
  CREATE TABLE IF NOT EXISTS memory_entries (
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
`;

const CREATE_PROJECT_MEMBERSHIPS = `
  CREATE TABLE project_memberships (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL REFERENCES agents(id),
    joined_at TEXT NOT NULL,
    PRIMARY KEY(project_id, agent_id)
  );
`;

const CREATE_MISSION_CRUD = `
  CREATE TABLE missions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    goal TEXT NOT NULL,
    version INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE work_items (
    id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('todo','in_progress','blocked','done')),
    assignee_agent_id TEXT REFERENCES agents(id),
    version INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

const CREATE_WORK_ITEM_DEPENDENCIES = `
  CREATE TABLE work_item_dependencies (
    work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
    depends_on_id TEXT NOT NULL REFERENCES work_items(id),
    PRIMARY KEY(work_item_id, depends_on_id),
    CHECK(work_item_id <> depends_on_id)
  );
`;

const CREATE_MEMORY_ENTRIES = `
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
`;

const CREATE_COLLABORATION_V4 = `
  CREATE TABLE collaboration_runs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK(status IN
      ('running','waiting_owner','paused','failed','planned','stopped')),
    current_agent_id TEXT NOT NULL REFERENCES agents(id),
    round_count INTEGER NOT NULL DEFAULT 0,
    next_event_sequence INTEGER NOT NULL DEFAULT 1,
    version INTEGER NOT NULL DEFAULT 1,
    execution_epoch INTEGER NOT NULL DEFAULT 1,
    pause_reason TEXT,
    pause_category TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX collaboration_one_active_project
    ON collaboration_runs(project_id)
    WHERE status IN ('running','waiting_owner','paused','failed');

  CREATE TABLE collaboration_operations (
    id TEXT NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    run_id TEXT REFERENCES collaboration_runs(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','completed')),
    http_status INTEGER,
    response_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(project_id,id)
  );

  CREATE TABLE collaboration_project_sequences (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    next_message_sequence INTEGER NOT NULL DEFAULT 1
  );

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
    created_at TEXT NOT NULL,
    UNIQUE(project_id,sequence)
  );

  CREATE TABLE collaboration_attempts (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL REFERENCES collaboration_runs(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL REFERENCES agents(id),
    operation_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN
      ('calling','committed','failed','interrupted','discarded')),
    lease_token TEXT NOT NULL,
    lease_expires_at TEXT NOT NULL,
    prompt_hash TEXT NOT NULL,
    acquire_execution_epoch INTEGER NOT NULL,
    acquire_context_hash TEXT NOT NULL,
    included_message_sequence INTEGER NOT NULL,
    error_category TEXT,
    failure_provider_id TEXT,
    failure_provider_version INTEGER,
    failure_credential_version INTEGER,
    failure_credential_generation INTEGER,
    failure_verified_at TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    UNIQUE(run_id,operation_id),
    FOREIGN KEY(project_id,operation_id)
      REFERENCES collaboration_operations(project_id,id)
  );
  CREATE UNIQUE INDEX collaboration_one_calling_attempt
    ON collaboration_attempts(run_id) WHERE status='calling';

  CREATE TABLE collaboration_model_calls (
    id TEXT PRIMARY KEY,
    attempt_id TEXT NOT NULL REFERENCES collaboration_attempts(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN ('primary','repair')),
    call_index INTEGER NOT NULL CHECK(call_index IN (1,2)),
    status TEXT NOT NULL CHECK(status IN
      ('succeeded','provider_failed','response_invalid','usage_invalid')),
    prompt_tokens INTEGER,
    completion_tokens INTEGER,
    total_tokens INTEGER,
    error_category TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(attempt_id,call_index)
  );

  CREATE TABLE collaboration_turns (
    id TEXT PRIMARY KEY,
    attempt_id TEXT NOT NULL UNIQUE REFERENCES collaboration_attempts(id),
    run_id TEXT NOT NULL REFERENCES collaboration_runs(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL REFERENCES agents(id),
    round_number INTEGER NOT NULL,
    message_id TEXT NOT NULL UNIQUE REFERENCES collaboration_messages(id),
    disposition TEXT NOT NULL CHECK(disposition IN
      ('handoff','decision_request','plan_ready')),
    created_at TEXT NOT NULL,
    UNIQUE(run_id,round_number)
  );

  CREATE TABLE decision_requests (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES collaboration_runs(id) ON DELETE CASCADE,
    turn_id TEXT NOT NULL UNIQUE REFERENCES collaboration_turns(id),
    requesting_agent_id TEXT NOT NULL REFERENCES agents(id),
    question TEXT NOT NULL,
    options_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('open','answered')),
    answer TEXT,
    answer_message_id TEXT REFERENCES collaboration_messages(id),
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    answered_at TEXT
  );
  CREATE UNIQUE INDEX collaboration_one_open_decision
    ON decision_requests(run_id) WHERE status='open';

  CREATE TABLE collaboration_events (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES collaboration_runs(id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL,
    type TEXT NOT NULL,
    actor_type TEXT NOT NULL CHECK(actor_type IN ('owner','agent','system')),
    actor_id TEXT,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(run_id,sequence)
  );
`;

function tableNames(database: DatabaseSync): Set<string> {
  const rows = database
    .prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    `)
    .all() as Array<{ name: string }>;
  return new Set(rows.map(({ name }) => name));
}

function hasUserSchemaObjects(database: DatabaseSync): boolean {
  const row = database
    .prepare(`
      SELECT 1 AS present
      FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%'
      LIMIT 1
    `)
    .get() as { present: number } | undefined;
  return row?.present === 1;
}

function tableInfo(database: DatabaseSync, table: string): TableInfo[] {
  return database.prepare(`PRAGMA table_info("${table}")`).all() as TableInfo[];
}

function hasExactColumns(
  database: DatabaseSync,
  table: string,
  expected: readonly string[] = REQUIRED_COLUMNS[table],
): boolean {
  const columns = tableInfo(database, table).map(({ name }) => name);
  const accepted = table === "agents" && columns.includes("review_capable")
    ? [...expected, "review_capable"]
    : expected;
  if (
    columns.length === accepted.length &&
    columns.every((column, index) => column === accepted[index])
  ) {
    return tableInfo(database, table).every(({ name, notnull, pk, type }) => {
      const key = `${table}.${name}`;
      const expectedType = INTEGER_COLUMNS.has(key) ? "INTEGER" : "TEXT";
      const expectedNotNull =
        (pk > 0 && !EXPLICIT_NOT_NULL_PRIMARY_KEYS.has(key)) || NULLABLE_COLUMNS.has(key)
          ? 0
          : 1;
      return type.toUpperCase() === expectedType && notnull === expectedNotNull;
    });
  }
  return false;
}

function hasPrimaryKey(database: DatabaseSync, table: string, columns: readonly string[]): boolean {
  const primaryKey = tableInfo(database, table)
    .filter(({ pk }) => pk > 0)
    .sort((left, right) => left.pk - right.pk)
    .map(({ name }) => name);
  return (
    primaryKey.length === columns.length &&
    primaryKey.every((name, index) => name === columns[index])
  );
}

function hasForeignKey(
  database: DatabaseSync,
  table: string,
  from: string,
  targetTable: string,
  to: string,
  onDelete = "NO ACTION",
): boolean {
  const keys = database.prepare(`PRAGMA foreign_key_list("${table}")`).all() as ForeignKeyInfo[];
  return keys.some(
    (key) =>
      key.from === from &&
      key.table === targetTable &&
      key.to === to &&
      key.on_delete === onDelete,
  );
}

function hasCompositeForeignKey(
  database: DatabaseSync,
  table: string,
  from: readonly string[],
  targetTable: string,
  to: readonly string[],
  onDelete = "NO ACTION",
): boolean {
  const groups = new Map<number, ForeignKeyInfo[]>();
  for (const key of database.prepare(`PRAGMA foreign_key_list("${table}")`).all() as ForeignKeyInfo[]) {
    groups.set(key.id, [...(groups.get(key.id) ?? []), key]);
  }
  return [...groups.values()].some((keys) => {
    const ordered = keys.sort((left, right) => left.seq - right.seq);
    return (
      ordered.length === from.length &&
      ordered.every(
        (key, index) =>
          key.from === from[index] &&
          key.table === targetTable &&
          key.to === to[index] &&
          key.on_delete === onDelete,
      )
    );
  });
}

function hasUniqueIndex(
  database: DatabaseSync,
  table: string,
  columns: readonly string[],
): boolean {
  const indexes = database.prepare(`PRAGMA index_list("${table}")`).all() as IndexInfo[];
  return indexes.some((index) => {
    if (index.unique !== 1) return false;
    const indexedColumns = (
      database.prepare(`PRAGMA index_info("${index.name}")`).all() as Array<{
        name: string;
        seqno: number;
      }>
    )
      .sort((left, right) => left.seqno - right.seqno)
      .map(({ name }) => name);
    return (
      indexedColumns.length === columns.length &&
      indexedColumns.every((name, position) => name === columns[position])
    );
  });
}

function hasIndex(
  database: DatabaseSync,
  table: string,
  columns: readonly string[],
  unique: boolean,
): boolean {
  const indexes = database.prepare(`PRAGMA index_list("${table}")`).all() as IndexInfo[];
  return indexes.some((index) => {
    if ((index.unique === 1) !== unique) return false;
    const indexedColumns = (
      database.prepare(`PRAGMA index_info("${index.name}")`).all() as Array<{
        name: string;
        seqno: number;
      }>
    )
      .sort((left, right) => left.seqno - right.seqno)
      .map(({ name }) => name);
    return (
      indexedColumns.length === columns.length &&
      indexedColumns.every((name, position) => name === columns[position])
    );
  });
}

function hasPartialWorkspaceIndex(database: DatabaseSync): boolean {
  const row = database
    .prepare(
      `SELECT sql
       FROM sqlite_master
       WHERE type = 'index' AND name = 'projects_workspace_key_unique'`,
    )
    .get() as { sql: string | null } | undefined;
  const sql = row?.sql?.replace(/\s+/g, " ").trim().toLowerCase() ?? "";
  return (
    hasUniqueIndex(database, "projects", ["workspace_key"]) &&
    sql.includes("where workspace_key is not null")
  );
}

function hasNamedPartialUniqueIndex(
  database: DatabaseSync,
  table: string,
  name: string,
  columns: readonly string[],
  predicate: string,
): boolean {
  const row = database
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
    .get(name) as { sql: string | null } | undefined;
  const sql = row?.sql?.replace(/\s+/g, " ").trim().toLowerCase() ?? "";
  const index = (
    database.prepare(`PRAGMA index_list("${table}")`).all() as IndexInfo[]
  ).find(({ name: indexName }) => indexName === name);
  const indexedColumns = (
    database.prepare(`PRAGMA index_info("${name}")`).all() as Array<{
      name: string;
      seqno: number;
    }>
  )
    .sort((left, right) => left.seqno - right.seqno)
    .map(({ name: column }) => column);
  return (
    index?.unique === 1 &&
    indexedColumns.length === columns.length &&
    indexedColumns.every((column, position) => column === columns[position]) &&
    sql.includes(`where ${predicate.toLowerCase()}`)
  );
}

function tableSqlContains(database: DatabaseSync, table: string, fragments: string[]): boolean {
  const row = database
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { sql: string | null } | undefined;
  const sql = row?.sql?.replace(/\s+/g, " ").toLowerCase() ?? "";
  return fragments.every((fragment) => sql.includes(fragment));
}

function validS1(database: DatabaseSync, projectsVersion3 = false): boolean {
  const names = tableNames(database);
  const expectedProjects = projectsVersion3
    ? ["id", "name", "created_at", "workspace_path", "workspace_key", "version"]
    : REQUIRED_COLUMNS.projects;
  return (
    S1_TABLES.every(
      (table) =>
        names.has(table) &&
        hasExactColumns(database, table, table === "projects" ? expectedProjects : undefined),
    ) &&
    hasPrimaryKey(database, "projects", ["id"]) &&
    hasPrimaryKey(database, "task_runs", ["id"]) &&
    hasPrimaryKey(database, "task_events", ["id"]) &&
    hasForeignKey(database, "task_runs", "project_id", "projects", "id") &&
    hasForeignKey(database, "task_events", "task_id", "task_runs", "id") &&
    hasUniqueIndex(database, "task_events", ["task_id", "sequence"])
  );
}

function validS2(database: DatabaseSync): boolean {
  const names = tableNames(database);
  return (
    S2_TABLES.every((table) => names.has(table) && hasExactColumns(database, table)) &&
    hasPrimaryKey(database, "providers", ["id"]) &&
    hasPrimaryKey(database, "skills", ["id"]) &&
    hasPrimaryKey(database, "agents", ["id"]) &&
    hasPrimaryKey(database, "agent_skills", ["agent_id", "skill_id"]) &&
    hasForeignKey(database, "agents", "provider_id", "providers", "id") &&
    hasForeignKey(database, "agent_skills", "agent_id", "agents", "id", "CASCADE") &&
    hasForeignKey(database, "agent_skills", "skill_id", "skills", "id") &&
    hasUniqueIndex(database, "agent_skills", ["agent_id", "position"]) &&
    hasIndex(database, "agents", ["provider_id"], false) &&
    hasIndex(database, "agent_skills", ["skill_id"], false) &&
    tableSqlContains(database, "providers", [
      "check(credential_version = 1)",
      "check(credential_generation >= 1)",
      "check(version >= 1)",
    ]) &&
    tableSqlContains(database, "skills", ["check(version >= 1)"]) &&
    tableSqlContains(database, "agents", [
      "check(can_read in (0,1))",
      "check(can_write in (0,1))",
      "check(can_execute in (0,1))",
      "check(version >= 1)",
    ])
  );
}

function validV3(database: DatabaseSync): boolean {
  const projectColumns = tableInfo(database, "projects");
  return (
    validS1(database, true) &&
    validS2(database) &&
    projectColumns.some(
      ({ dflt_value, name, notnull, type }) =>
        name === "version" &&
        type.toUpperCase() === "INTEGER" &&
        notnull === 1 &&
        dflt_value === "1",
    ) &&
    hasPartialWorkspaceIndex(database)
  );
}

function validProjectMemberships(database: DatabaseSync): boolean {
  return (
    tableNames(database).has("project_memberships") &&
    hasExactColumns(database, "project_memberships") &&
    hasPrimaryKey(database, "project_memberships", ["project_id", "agent_id"]) &&
    hasForeignKey(
      database,
      "project_memberships",
      "project_id",
      "projects",
      "id",
      "CASCADE",
    ) &&
    hasForeignKey(database, "project_memberships", "agent_id", "agents", "id")
  );
}

function validMissionCrud(database: DatabaseSync): boolean {
  const names = tableNames(database);
  return (
    names.has("missions") &&
    names.has("work_items") &&
    hasExactColumns(database, "missions") &&
    hasExactColumns(database, "work_items") &&
    hasPrimaryKey(database, "missions", ["id"]) &&
    hasPrimaryKey(database, "work_items", ["id"]) &&
    hasUniqueIndex(database, "missions", ["project_id"]) &&
    hasForeignKey(database, "missions", "project_id", "projects", "id", "CASCADE") &&
    hasForeignKey(database, "work_items", "mission_id", "missions", "id", "CASCADE") &&
    hasForeignKey(database, "work_items", "assignee_agent_id", "agents", "id") &&
    tableSqlContains(database, "work_items", [
      "check(status in ('todo','in_progress','blocked','done'))",
    ])
  );
}

function validWorkItemDependencies(database: DatabaseSync): boolean {
  return (
    tableNames(database).has("work_item_dependencies") &&
    hasExactColumns(database, "work_item_dependencies") &&
    hasPrimaryKey(database, "work_item_dependencies", [
      "work_item_id",
      "depends_on_id",
    ]) &&
    hasForeignKey(
      database,
      "work_item_dependencies",
      "work_item_id",
      "work_items",
      "id",
      "CASCADE",
    ) &&
    hasForeignKey(
      database,
      "work_item_dependencies",
      "depends_on_id",
      "work_items",
      "id",
    ) &&
    tableSqlContains(database, "work_item_dependencies", [
      "check(work_item_id <> depends_on_id)",
    ])
  );
}

function validMemoryEntries(database: DatabaseSync): boolean {
  const columns = tableInfo(database, "memory_entries").map(({ name }) => name);
  if (columns.includes("chain_id")) return true;
  return (
    tableNames(database).has("memory_entries") &&
    hasExactColumns(database, "memory_entries") &&
    hasPrimaryKey(database, "memory_entries", ["id"]) &&
    hasUniqueIndex(database, "memory_entries", ["supersedes_id"]) &&
    hasForeignKey(
      database,
      "memory_entries",
      "project_id",
      "projects",
      "id",
      "CASCADE",
    ) &&
    hasForeignKey(
      database,
      "memory_entries",
      "supersedes_id",
      "memory_entries",
      "id",
    ) &&
    tableSqlContains(database, "memory_entries", [
      "check(type in ('goal','decision','fact','artifact'))",
      "check(source_type in ('owner_input','work_item','artifact_path'))",
      "check(created_by = 'owner')",
    ])
  );
}

function validCompleteV3(database: DatabaseSync): boolean {
  return (
    validV3(database) &&
    validProjectMemberships(database) &&
    validMissionCrud(database) &&
    validWorkItemDependencies(database) &&
    validMemoryEntries(database)
  );
}

function validCollaborationV4(database: DatabaseSync): boolean {
  const names = tableNames(database);
  const tables = [
    "collaboration_runs",
    "collaboration_operations",
    "collaboration_project_sequences",
    "collaboration_messages",
    "collaboration_attempts",
    "collaboration_model_calls",
    "collaboration_turns",
    "decision_requests",
    "collaboration_events",
  ] as const;
  return (
    tables.every((table) => names.has(table) && hasExactColumns(database, table)) &&
    hasPrimaryKey(database, "collaboration_runs", ["id"]) &&
    hasPrimaryKey(database, "collaboration_operations", ["project_id", "id"]) &&
    hasPrimaryKey(database, "collaboration_project_sequences", ["project_id"]) &&
    hasPrimaryKey(database, "collaboration_messages", ["id"]) &&
    hasPrimaryKey(database, "collaboration_attempts", ["id"]) &&
    hasPrimaryKey(database, "collaboration_model_calls", ["id"]) &&
    hasPrimaryKey(database, "collaboration_turns", ["id"]) &&
    hasPrimaryKey(database, "decision_requests", ["id"]) &&
    hasPrimaryKey(database, "collaboration_events", ["id"]) &&
    hasForeignKey(database, "collaboration_runs", "project_id", "projects", "id", "CASCADE") &&
    hasForeignKey(database, "collaboration_runs", "current_agent_id", "agents", "id") &&
    hasForeignKey(
      database,
      "collaboration_operations",
      "project_id",
      "projects",
      "id",
      "CASCADE",
    ) &&
    hasForeignKey(
      database,
      "collaboration_operations",
      "run_id",
      "collaboration_runs",
      "id",
      "CASCADE",
    ) &&
    hasForeignKey(
      database,
      "collaboration_project_sequences",
      "project_id",
      "projects",
      "id",
      "CASCADE",
    ) &&
    hasForeignKey(
      database,
      "collaboration_messages",
      "project_id",
      "projects",
      "id",
      "CASCADE",
    ) &&
    hasForeignKey(
      database,
      "collaboration_messages",
      "run_id",
      "collaboration_runs",
      "id",
      "SET NULL",
    ) &&
    hasForeignKey(database, "collaboration_messages", "author_agent_id", "agents", "id") &&
    hasForeignKey(database, "collaboration_messages", "mention_agent_id", "agents", "id") &&
    hasForeignKey(
      database,
      "collaboration_attempts",
      "project_id",
      "projects",
      "id",
      "CASCADE",
    ) &&
    hasForeignKey(
      database,
      "collaboration_attempts",
      "run_id",
      "collaboration_runs",
      "id",
      "CASCADE",
    ) &&
    hasForeignKey(database, "collaboration_attempts", "agent_id", "agents", "id") &&
    hasCompositeForeignKey(
      database,
      "collaboration_attempts",
      ["project_id", "operation_id"],
      "collaboration_operations",
      ["project_id", "id"],
    ) &&
    hasForeignKey(
      database,
      "collaboration_model_calls",
      "attempt_id",
      "collaboration_attempts",
      "id",
      "CASCADE",
    ) &&
    hasForeignKey(
      database,
      "collaboration_turns",
      "attempt_id",
      "collaboration_attempts",
      "id",
    ) &&
    hasForeignKey(
      database,
      "collaboration_turns",
      "run_id",
      "collaboration_runs",
      "id",
      "CASCADE",
    ) &&
    hasForeignKey(database, "collaboration_turns", "agent_id", "agents", "id") &&
    hasForeignKey(
      database,
      "collaboration_turns",
      "message_id",
      "collaboration_messages",
      "id",
    ) &&
    hasForeignKey(
      database,
      "decision_requests",
      "run_id",
      "collaboration_runs",
      "id",
      "CASCADE",
    ) &&
    hasForeignKey(
      database,
      "decision_requests",
      "turn_id",
      "collaboration_turns",
      "id",
    ) &&
    hasForeignKey(database, "decision_requests", "requesting_agent_id", "agents", "id") &&
    hasForeignKey(
      database,
      "decision_requests",
      "answer_message_id",
      "collaboration_messages",
      "id",
    ) &&
    hasForeignKey(
      database,
      "collaboration_events",
      "run_id",
      "collaboration_runs",
      "id",
      "CASCADE",
    ) &&
    hasUniqueIndex(database, "collaboration_messages", ["project_id", "sequence"]) &&
    hasUniqueIndex(database, "collaboration_attempts", ["run_id", "operation_id"]) &&
    hasUniqueIndex(database, "collaboration_model_calls", ["attempt_id", "call_index"]) &&
    hasUniqueIndex(database, "collaboration_turns", ["attempt_id"]) &&
    hasUniqueIndex(database, "collaboration_turns", ["message_id"]) &&
    hasUniqueIndex(database, "collaboration_turns", ["run_id", "round_number"]) &&
    hasUniqueIndex(database, "decision_requests", ["turn_id"]) &&
    hasUniqueIndex(database, "collaboration_events", ["run_id", "sequence"]) &&
    hasNamedPartialUniqueIndex(
      database,
      "collaboration_runs",
      "collaboration_one_active_project",
      ["project_id"],
      "status in ('running','waiting_owner','paused','failed')",
    ) &&
    hasNamedPartialUniqueIndex(
      database,
      "collaboration_attempts",
      "collaboration_one_calling_attempt",
      ["run_id"],
      "status='calling'",
    ) &&
    hasNamedPartialUniqueIndex(
      database,
      "decision_requests",
      "collaboration_one_open_decision",
      ["run_id"],
      "status='open'",
    ) &&
    tableSqlContains(database, "collaboration_runs", [
      "check(status in ('running','waiting_owner','paused','failed','planned','stopped'))",
    ]) &&
    tableSqlContains(database, "collaboration_operations", [
      "check(status in ('pending','completed'))",
    ]) &&
    tableSqlContains(database, "collaboration_messages", [
      "check(author_type in ('owner','agent'))",
    ]) &&
    tableSqlContains(database, "collaboration_attempts", [
      "check(status in ('calling','committed','failed','interrupted','discarded'))",
    ]) &&
    tableSqlContains(database, "collaboration_model_calls", [
      "check(kind in ('primary','repair'))",
      "check(call_index in (1,2))",
      "check(status in ('succeeded','provider_failed','response_invalid','usage_invalid'))",
    ]) &&
    tableSqlContains(database, "collaboration_turns", [
      "check(disposition in ('handoff','decision_request','plan_ready'))",
    ]) &&
    tableSqlContains(database, "decision_requests", [
      "check(status in ('open','answered'))",
    ]) &&
    tableSqlContains(database, "collaboration_events", [
      "check(actor_type in ('owner','agent','system'))",
    ])
  );
}

function inTransaction(database: DatabaseSync, operation: () => void): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    operation();
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the migration failure; the caller closes this connection.
    }
    throw error;
  }
}

function version(database: DatabaseSync): number {
  return (database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
}

export function migrateDatabase(database: DatabaseSync): void {
  let currentVersion = version(database);
  if (currentVersion > 6) {
    throw new SchemaMigrationError("SCHEMA_TOO_NEW", "Database schema is newer than supported.");
  }

  if (currentVersion === 0) {
    if (!hasUserSchemaObjects(database)) {
      inTransaction(database, () => {
        database.exec(CREATE_S1);
        database.exec("PRAGMA user_version = 1");
      });
    } else {
      if (!validS1(database)) {
        throw new SchemaMigrationError("SCHEMA_DRIFT", "Database schema does not match version 1.");
      }
      inTransaction(database, () => {
        database.exec("PRAGMA user_version = 1");
      });
    }
    currentVersion = 1;
  }

  if (currentVersion === 1) {
    if (!validS1(database)) {
      throw new SchemaMigrationError("SCHEMA_DRIFT", "Database schema does not match version 1.");
    }
    inTransaction(database, () => {
      database.exec(CREATE_S2);
      database.exec("PRAGMA user_version = 2");
    });
    currentVersion = 2;
  }

  if (currentVersion === 2 && (!validS1(database) || !validS2(database))) {
    throw new SchemaMigrationError("SCHEMA_DRIFT", "Database schema does not match version 2.");
  }

  if (currentVersion === 2) {
    inTransaction(database, () => {
      database.exec(CREATE_WORKSPACE_BINDING);
      database.exec("PRAGMA user_version = 3");
    });
    currentVersion = 3;
  }

  if (currentVersion === 3 && !validCompleteV3(database)) {
    throw new SchemaMigrationError("SCHEMA_DRIFT", "Database schema does not match version 3.");
  }

  if (currentVersion === 3) {
    inTransaction(database, () => {
      database.exec(CREATE_COLLABORATION_V4);
      if (!validCollaborationV4(database)) {
        throw new SchemaMigrationError(
          "SCHEMA_DRIFT",
          "Database collaboration schema is invalid.",
        );
      }
      database.exec("PRAGMA user_version = 4");
    });
    currentVersion = 4;
  }

  if (
    (currentVersion === 4 || currentVersion === 5 || currentVersion === 6)
    && (!validCompleteV3(database) || !validCollaborationV4(database))
  ) {
    throw new SchemaMigrationError("SCHEMA_DRIFT", "Database collaboration schema is invalid.");
  }

  if (currentVersion === 4) {
    if (hasAnyV5Object(database)) {
      throw new SchemaMigrationError("SCHEMA_DRIFT", "Database version 5 schema is partial.");
    }
    inTransaction(database, () => {
      createV5(database);
      const validation = validateV5(database);
      if (validation) {
        throw new SchemaMigrationError(validation, "Database version 5 schema is invalid.");
      }
      database.exec("PRAGMA user_version = 5");
    });
    currentVersion = 5;
  }

  if (currentVersion === 5) {
    const validation = validateV5(database);
    if (validation) {
      throw new SchemaMigrationError(validation, "Database version 5 schema is invalid.");
    }
    if (hasAnyV6Object(database)) {
      throw new SchemaMigrationError("SCHEMA_DRIFT", "Database version 6 schema is partial.");
    }
    inTransaction(database, () => {
      createV6(database);
      const validation = validateV6(database);
      if (validation) {
        throw new SchemaMigrationError(validation, "Database version 6 schema is invalid.");
      }
      database.exec("PRAGMA user_version = 6");
    });
    currentVersion = 6;
  }

  if (currentVersion === 6) {
    const validation = validateV6(database);
    if (validation) {
      throw new SchemaMigrationError(
        validation,
        "Database version 6 schema is invalid.",
      );
    }
  }
}
