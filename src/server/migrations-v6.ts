import type { DatabaseSync } from "node:sqlite";

const CREATE_T1_V6 = `
ALTER TABLE agents ADD COLUMN review_capable INTEGER NOT NULL DEFAULT 0
  CHECK(review_capable IN (0,1));

CREATE TABLE work_item_review_heads(
  work_item_id TEXT PRIMARY KEY REFERENCES work_items(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  current_result_id TEXT NOT NULL UNIQUE
    REFERENCES work_item_execution_results(id),
  current_attempt_id TEXT,
  state TEXT NOT NULL CHECK(state IN ('pending_review','reviewing','passed')),
  version INTEGER NOT NULL CHECK(version>=1),
  updated_at TEXT NOT NULL
);

CREATE TABLE review_attempts(
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  result_id TEXT NOT NULL REFERENCES work_item_execution_results(id),
  reviewer_agent_id TEXT NOT NULL REFERENCES agents(id),
  status TEXT NOT NULL CHECK(status IN ('calling','passed','failed')),
  frozen_material_json TEXT NOT NULL CHECK(json_valid(frozen_material_json)),
  frozen_material_hash TEXT NOT NULL,
  provider_id TEXT NOT NULL REFERENCES providers(id),
  model TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE UNIQUE INDEX review_one_active_result
  ON review_attempts(result_id) WHERE status='calling';

CREATE TABLE review_model_calls(
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL UNIQUE REFERENCES review_attempts(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('succeeded','failed')),
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  total_tokens INTEGER,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  CHECK(total_tokens IS NULL OR total_tokens=prompt_tokens+completion_tokens)
);

CREATE TABLE review_decisions(
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL UNIQUE REFERENCES review_attempts(id),
  result_id TEXT NOT NULL UNIQUE REFERENCES work_item_execution_results(id),
  reviewer_agent_id TEXT NOT NULL REFERENCES agents(id),
  choice TEXT NOT NULL CHECK(choice IN ('reject','escalate','pass')),
  public_summary TEXT NOT NULL,
  findings_json TEXT NOT NULL CHECK(json_valid(findings_json)),
  evidence_refs_json TEXT NOT NULL CHECK(json_valid(evidence_refs_json)),
  limitations_json TEXT NOT NULL CHECK(json_valid(limitations_json)),
  created_at TEXT NOT NULL
);
`;

export function createV6T1(database: DatabaseSync): void {
  database.exec(CREATE_T1_V6);
}

export function hasAnyV6T1Object(database: DatabaseSync): boolean {
  const names = database.prepare(`
    SELECT name FROM sqlite_master
    WHERE name IN (
      'work_item_review_heads','review_attempts','review_model_calls',
      'review_decisions','review_one_active_result'
    )
  `).all() as Array<{ name: string }>;
  const agentColumns = database.prepare("PRAGMA table_info(agents)").all() as Array<{
    name: string;
  }>;
  return names.length > 0 || agentColumns.some(({ name }) => name === "review_capable");
}

export function validateV6T1(database: DatabaseSync): boolean {
  const required = new Set([
    "work_item_review_heads",
    "review_attempts",
    "review_model_calls",
    "review_decisions",
  ]);
  const rows = database.prepare(`
    SELECT name FROM sqlite_master WHERE type='table'
  `).all() as Array<{ name: string }>;
  const columns = database.prepare("PRAGMA table_info(agents)").all() as Array<{
    name: string;
  }>;
  return [...required].every((name) => rows.some((row) => row.name === name))
    && columns.some(({ name }) => name === "review_capable");
}
