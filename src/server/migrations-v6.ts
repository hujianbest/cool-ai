import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  validateV5Retained,
  validateV5RetainedData,
} from "@/src/server/migrations-v5";

export const V6_TABLES = [
  "work_item_result_versions",
  "work_item_review_heads",
  "review_operations",
  "review_attempts",
  "review_model_calls",
  "review_decisions",
  "review_memory_candidates",
  "review_memory_associations",
  "review_escalations",
  "review_escalation_answers",
  "mission_deliveries",
  "mission_delivery_heads",
  "review_events",
] as const;

export const V6_INDEXES = [
  "work_item_result_versions_item",
  "review_one_active_result",
  "review_attempts_item",
  "memory_v6_dedupe",
  "review_events_page",
] as const;

const IMMUTABLE = [
  ["work_item_result_versions", "review_result", "IMMUTABLE_RESULT"],
  ["review_decisions", "review_decision", "IMMUTABLE_REVIEW_DECISION"],
  ["review_memory_candidates", "review_memory_candidate", "IMMUTABLE_MEMORY_CANDIDATE"],
  ["review_memory_associations", "review_memory_association", "IMMUTABLE_MEMORY_ASSOCIATION"],
  ["review_escalations", "review_escalation", "IMMUTABLE_REVIEW_ESCALATION"],
  ["review_escalation_answers", "review_escalation_answer", "IMMUTABLE_ESCALATION_ANSWER"],
  ["memory_entries", "memory_entry_v6", "IMMUTABLE_MEMORY_ENTRY"],
  ["mission_deliveries", "mission_delivery", "IMMUTABLE_MISSION_DELIVERY"],
  ["review_events", "review_event", "IMMUTABLE_REVIEW_EVENT"],
] as const;

export const V6_TRIGGERS = IMMUTABLE.flatMap(([, prefix]) => [
  `${prefix}_no_update`,
  `${prefix}_no_delete`,
]);

const CREATE_TABLES = `
CREATE TABLE work_item_result_versions(
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL, mission_id TEXT NOT NULL,
 work_item_id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version>=1),
 execution_id TEXT NOT NULL UNIQUE, staged_result_id TEXT NOT NULL UNIQUE,
 merge_journal_id TEXT NOT NULL UNIQUE, supersedes_result_id TEXT,
 executor_agent_id TEXT NOT NULL, created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z'),
 UNIQUE(work_item_id,version), UNIQUE(work_item_id,id),
 FOREIGN KEY(project_id,mission_id,work_item_id,execution_id) REFERENCES executions(project_id,mission_id,work_item_id,id),
 FOREIGN KEY(work_item_id,supersedes_result_id) REFERENCES work_item_result_versions(work_item_id,id),
 FOREIGN KEY(project_id,executor_agent_id) REFERENCES project_memberships(project_id,agent_id)
);
CREATE INDEX work_item_result_versions_item ON work_item_result_versions(work_item_id,version,id);

CREATE TABLE work_item_review_heads(
 work_item_id TEXT PRIMARY KEY REFERENCES work_items(id) ON DELETE CASCADE,
 project_id TEXT NOT NULL, mission_id TEXT NOT NULL, current_result_id TEXT,
 current_attempt_id TEXT,
 state TEXT NOT NULL CHECK(state IN ('executing','pending_review','reviewing','rework','waiting_owner','passed')),
 version INTEGER NOT NULL CHECK(version>=1),
 updated_at TEXT NOT NULL CHECK(updated_at GLOB '????-??-??T??:??:??.???Z'),
 FOREIGN KEY(project_id,mission_id) REFERENCES missions(project_id,id),
 FOREIGN KEY(mission_id,work_item_id) REFERENCES work_items(mission_id,id) ON DELETE CASCADE,
 FOREIGN KEY(work_item_id,current_result_id) REFERENCES work_item_result_versions(work_item_id,id)
);

CREATE TABLE review_operations(
 id TEXT NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('start_review','answer_escalation','generate_delivery','terminate_mission')),
 parent_id TEXT NOT NULL, request_hash TEXT NOT NULL CHECK(length(request_hash)=64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
 status TEXT NOT NULL CHECK(status IN ('pending','completed')), http_status INTEGER,
 response_json TEXT CHECK(response_json IS NULL OR json_valid(response_json)),
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 PRIMARY KEY(project_id,id),
 CHECK((status='pending' AND http_status IS NULL AND response_json IS NULL)
    OR (status='completed' AND http_status BETWEEN 100 AND 599 AND response_json IS NOT NULL))
);

CREATE TABLE review_attempts(
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL, mission_id TEXT NOT NULL,
 work_item_id TEXT NOT NULL, result_id TEXT NOT NULL, reviewer_agent_id TEXT NOT NULL,
 operation_id TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN
   ('calling','finalizing','rejected','escalated','passed','failed','interrupted','discarded')),
 lease_token TEXT NOT NULL, lease_expires_at TEXT NOT NULL CHECK(lease_expires_at GLOB '????-??-??T??:??:??.???Z'),
 frozen_material_json TEXT NOT NULL CHECK(json_valid(frozen_material_json)),
 frozen_material_hash TEXT NOT NULL CHECK(length(frozen_material_hash)=64 AND frozen_material_hash NOT GLOB '*[^0-9a-f]*'),
 prompt_hash TEXT NOT NULL CHECK(length(prompt_hash)=64 AND prompt_hash NOT GLOB '*[^0-9a-f]*'),
 provider_id TEXT NOT NULL, provider_version INTEGER NOT NULL CHECK(provider_version>=1),
 credential_generation INTEGER NOT NULL CHECK(credential_generation>=1),
 verified_at TEXT NOT NULL CHECK(verified_at GLOB '????-??-??T??:??:??.???Z'),
 model TEXT NOT NULL, parsed_output_json TEXT CHECK(parsed_output_json IS NULL OR json_valid(parsed_output_json)),
 parsed_output_hash TEXT, output_checkpointed_at TEXT, finalize_error_code TEXT, error_category TEXT,
 started_at TEXT NOT NULL CHECK(started_at GLOB '????-??-??T??:??:??.???Z'), finished_at TEXT,
 UNIQUE(project_id,operation_id),
 FOREIGN KEY(project_id,operation_id) REFERENCES review_operations(project_id,id),
 FOREIGN KEY(project_id,mission_id) REFERENCES missions(project_id,id),
 FOREIGN KEY(mission_id,work_item_id) REFERENCES work_items(mission_id,id),
 FOREIGN KEY(work_item_id,result_id) REFERENCES work_item_result_versions(work_item_id,id),
 FOREIGN KEY(project_id,reviewer_agent_id) REFERENCES project_memberships(project_id,agent_id),
 FOREIGN KEY(provider_id) REFERENCES providers(id),
 CHECK((parsed_output_json IS NULL AND parsed_output_hash IS NULL AND output_checkpointed_at IS NULL)
    OR (parsed_output_json IS NOT NULL AND parsed_output_hash IS NOT NULL AND output_checkpointed_at IS NOT NULL)),
 CHECK(status<>'finalizing' OR parsed_output_json IS NOT NULL)
);
CREATE UNIQUE INDEX review_one_active_result ON review_attempts(result_id)
 WHERE status IN ('calling','finalizing');
CREATE INDEX review_attempts_item ON review_attempts(work_item_id,started_at,id);

CREATE TABLE review_model_calls(
 id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL REFERENCES review_attempts(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('primary','repair')), call_index INTEGER NOT NULL CHECK(call_index IN (1,2)),
 status TEXT NOT NULL CHECK(status IN ('calling','succeeded','provider_failed','response_invalid','usage_invalid','interrupted','discarded')),
 prompt_hash TEXT NOT NULL CHECK(length(prompt_hash)=64 AND prompt_hash NOT GLOB '*[^0-9a-f]*'),
 prompt_tokens INTEGER CHECK(prompt_tokens IS NULL OR prompt_tokens>=0),
 completion_tokens INTEGER CHECK(completion_tokens IS NULL OR completion_tokens>=0),
 total_tokens INTEGER CHECK(total_tokens IS NULL OR total_tokens>=0), error_category TEXT,
 started_at TEXT NOT NULL CHECK(started_at GLOB '????-??-??T??:??:??.???Z'), finished_at TEXT,
 UNIQUE(attempt_id,call_index), CHECK(total_tokens IS NULL OR total_tokens=prompt_tokens+completion_tokens),
 CHECK((status='calling' AND finished_at IS NULL) OR (status<>'calling' AND finished_at IS NOT NULL))
);

CREATE TABLE review_decisions(
 id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL UNIQUE REFERENCES review_attempts(id),
 result_id TEXT NOT NULL, reviewer_agent_id TEXT NOT NULL,
 choice TEXT NOT NULL CHECK(choice IN ('reject','escalate','pass')), public_summary TEXT NOT NULL,
 findings_json TEXT NOT NULL CHECK(json_valid(findings_json)),
 evidence_refs_json TEXT NOT NULL CHECK(json_valid(evidence_refs_json)),
 limitations_json TEXT NOT NULL CHECK(json_valid(limitations_json)),
 created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z'),
 FOREIGN KEY(result_id) REFERENCES work_item_result_versions(id),
 FOREIGN KEY(reviewer_agent_id) REFERENCES agents(id)
);

CREATE TABLE memory_entries(
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 chain_id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version>=1),
 type TEXT NOT NULL CHECK(type IN ('goal','decision','fact','artifact','experience')),
 content TEXT NOT NULL, dedupe_hash TEXT NOT NULL CHECK(length(dedupe_hash)=64 AND dedupe_hash NOT GLOB '*[^0-9a-f]*'),
 source_type TEXT NOT NULL CHECK(source_type IN ('owner_input','work_item','artifact_path','task','result','review','validation','artifact')),
 source_id TEXT NOT NULL, source_version TEXT,
 proposer_actor_type TEXT NOT NULL CHECK(proposer_actor_type IN ('owner','agent')),
 proposer_actor_id TEXT, confirming_review_attempt_id TEXT,
 persistence_actor TEXT NOT NULL CHECK(persistence_actor='platform'), supersedes_id TEXT,
 created_at TEXT NOT NULL,
 UNIQUE(project_id,id), UNIQUE(chain_id,version), UNIQUE(project_id,supersedes_id),
 FOREIGN KEY(project_id,supersedes_id) REFERENCES memory_entries(project_id,id),
 FOREIGN KEY(confirming_review_attempt_id) REFERENCES review_attempts(id),
 CHECK((proposer_actor_type='owner' AND proposer_actor_id IS NULL AND confirming_review_attempt_id IS NULL)
    OR (proposer_actor_type='agent' AND proposer_actor_id IS NOT NULL
      AND confirming_review_attempt_id IS NOT NULL AND source_version IS NOT NULL))
);
CREATE INDEX memory_v6_dedupe ON memory_entries(project_id,type,dedupe_hash);

CREATE TABLE review_memory_candidates(
 id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL REFERENCES review_attempts(id),
 position INTEGER NOT NULL CHECK(position>=0), type TEXT NOT NULL CHECK(type IN ('decision','fact','artifact','experience')),
 content TEXT NOT NULL, source_type TEXT NOT NULL CHECK(source_type IN ('task','result','review','validation','artifact')),
 source_id TEXT NOT NULL, source_version TEXT NOT NULL, supersedes_memory_id TEXT,
 created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z'), UNIQUE(attempt_id,position)
);
CREATE TABLE review_memory_associations(
 candidate_id TEXT PRIMARY KEY REFERENCES review_memory_candidates(id),
 decision_id TEXT NOT NULL REFERENCES review_decisions(id), memory_id TEXT NOT NULL REFERENCES memory_entries(id),
 outcome TEXT NOT NULL CHECK(outcome IN ('reused','created','superseded')),
 created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z')
);
CREATE TABLE review_escalations(
 id TEXT PRIMARY KEY, decision_id TEXT NOT NULL UNIQUE REFERENCES review_decisions(id),
 work_item_id TEXT NOT NULL REFERENCES work_items(id), result_id TEXT NOT NULL REFERENCES work_item_result_versions(id),
 question TEXT NOT NULL, options_json TEXT NOT NULL CHECK(json_valid(options_json)),
 evidence_refs_json TEXT NOT NULL CHECK(json_valid(evidence_refs_json)),
 created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z')
);
CREATE TABLE review_escalation_answers(
 id TEXT PRIMARY KEY, escalation_id TEXT NOT NULL UNIQUE REFERENCES review_escalations(id),
 operation_id TEXT NOT NULL, answer TEXT NOT NULL,
 action TEXT NOT NULL CHECK(action IN ('continue_review','rework','terminate_mission')),
 created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z')
);

CREATE TABLE mission_deliveries(
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL, mission_id TEXT NOT NULL,
 version INTEGER NOT NULL CHECK(version>=1), input_fingerprint TEXT NOT NULL,
 summary_json TEXT NOT NULL CHECK(json_valid(summary_json)),
 evidence_manifest_json TEXT NOT NULL CHECK(json_valid(evidence_manifest_json)),
 supersedes_delivery_id TEXT, created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z'),
 UNIQUE(mission_id,version), UNIQUE(mission_id,id), UNIQUE(mission_id,input_fingerprint),
 FOREIGN KEY(mission_id,supersedes_delivery_id) REFERENCES mission_deliveries(mission_id,id),
 FOREIGN KEY(project_id,mission_id) REFERENCES missions(project_id,id)
);
CREATE TABLE mission_delivery_heads(
 mission_id TEXT PRIMARY KEY REFERENCES missions(id) ON DELETE CASCADE, project_id TEXT NOT NULL,
 context_version INTEGER NOT NULL CHECK(context_version>=1),
 state TEXT NOT NULL CHECK(state IN ('ongoing','generating','completed','owner_terminated')),
 current_delivery_id TEXT, current_operation_id TEXT, generation_lease_token TEXT,
 generation_lease_expires_at TEXT, last_error_code TEXT,
 next_event_sequence INTEGER NOT NULL CHECK(next_event_sequence>=1), version INTEGER NOT NULL CHECK(version>=1),
 updated_at TEXT NOT NULL,
 FOREIGN KEY(project_id,mission_id) REFERENCES missions(project_id,id),
 FOREIGN KEY(mission_id,current_delivery_id) REFERENCES mission_deliveries(mission_id,id),
 CHECK((state='generating' AND current_operation_id IS NOT NULL AND generation_lease_token IS NOT NULL
    AND generation_lease_expires_at IS NOT NULL)
   OR (state<>'generating' AND current_operation_id IS NULL AND generation_lease_token IS NULL
    AND generation_lease_expires_at IS NULL)),
 CHECK((state='completed')=(current_delivery_id IS NOT NULL))
);
CREATE TABLE review_events(
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
 sequence INTEGER NOT NULL CHECK(sequence>=1), type TEXT NOT NULL,
 actor_type TEXT NOT NULL CHECK(actor_type IN ('owner','agent','system')), actor_id TEXT,
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
 created_at TEXT NOT NULL, UNIQUE(mission_id,sequence),
 FOREIGN KEY(project_id,mission_id) REFERENCES missions(project_id,id)
);
CREATE INDEX review_events_page ON review_events(mission_id,sequence,id);
`;

function immutableSql(): string {
  const immutableRows = IMMUTABLE.map(([table, prefix, error]) => `
CREATE TRIGGER ${prefix}_no_update BEFORE UPDATE ON ${table}
BEGIN SELECT RAISE(ABORT,'${error}'); END;
CREATE TRIGGER ${prefix}_no_delete BEFORE DELETE ON ${table}
WHEN ${["memory_entries", "work_item_result_versions", "mission_deliveries", "review_events"]
    .includes(table)
    ? "EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id)"
    : table === "review_decisions"
    ? "EXISTS(SELECT 1 FROM review_attempts WHERE id=OLD.attempt_id)"
    : table === "review_memory_candidates"
    ? "EXISTS(SELECT 1 FROM review_attempts WHERE id=OLD.attempt_id)"
    : table === "review_memory_associations"
    ? "EXISTS(SELECT 1 FROM review_memory_candidates WHERE id=OLD.candidate_id)"
    : table === "review_escalations"
    ? "EXISTS(SELECT 1 FROM review_decisions WHERE id=OLD.decision_id)"
    : table === "review_escalation_answers"
    ? "EXISTS(SELECT 1 FROM review_escalations WHERE id=OLD.escalation_id)"
    : "1"}
BEGIN SELECT RAISE(ABORT,'${error}'); END;`).join("\n");
  return `${immutableRows}
CREATE TRIGGER review_attempt_terminal_no_update
BEFORE UPDATE ON review_attempts
WHEN OLD.status IN ('rejected','escalated','passed','failed','interrupted','discarded')
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_REVIEW_ATTEMPT'); END;
CREATE TRIGGER review_attempt_terminal_no_delete
BEFORE DELETE ON review_attempts
WHEN OLD.status IN ('rejected','escalated','passed','failed','interrupted','discarded')
 AND EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id)
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_REVIEW_ATTEMPT'); END;`;
}

const CREATE_V6_SCHEMA = `${CREATE_TABLES}\n${immutableSql()}`;

export const V6_MIGRATION_STEPS = [
  "agents-capability",
  "rename-results",
  "rename-memory",
  "create-schema",
  "backfill-results",
  "backfill-review-heads",
  "backfill-memory",
  "backfill-delivery-heads",
  "backfill-events",
  "legacy-done",
  "drop-legacy-results",
  "drop-legacy-memory",
] as const;

type StepHook = (step: string) => void;
const notify = (hook: StepHook | undefined, step: string) => hook?.(step);

export function createV6(database: DatabaseSync, afterStep?: StepHook): void {
  database.exec(`ALTER TABLE agents ADD COLUMN review_capable INTEGER NOT NULL DEFAULT 0
    CHECK(review_capable IN (0,1))`);
  notify(afterStep, "agents-capability");
  database.exec("ALTER TABLE work_item_execution_results RENAME TO migration_v5_results");
  notify(afterStep, "rename-results");
  database.exec("ALTER TABLE memory_entries RENAME TO migration_v5_memory");
  notify(afterStep, "rename-memory");
  database.exec(CREATE_V6_SCHEMA);
  notify(afterStep, "create-schema");
  database.exec(`
    INSERT INTO work_item_result_versions(
      id,project_id,mission_id,work_item_id,version,execution_id,staged_result_id,
      merge_journal_id,supersedes_result_id,executor_agent_id,created_at
    )
    SELECT r.id,r.project_id,r.mission_id,r.work_item_id,
      ROW_NUMBER() OVER(PARTITION BY r.work_item_id ORDER BY r.created_at,r.id),
      r.execution_id,r.staged_result_id,r.merge_journal_id,
      LAG(r.id) OVER(PARTITION BY r.work_item_id ORDER BY r.created_at,r.id),
      e.agent_id,r.created_at
    FROM migration_v5_results r JOIN executions e ON e.id=r.execution_id`);
  notify(afterStep, "backfill-results");
  database.exec(`
    INSERT INTO work_item_review_heads(
      work_item_id,project_id,mission_id,current_result_id,current_attempt_id,state,version,updated_at
    )
    SELECT r.work_item_id,r.project_id,r.mission_id,r.id,NULL,'pending_review',1,r.created_at
    FROM work_item_result_versions r
    WHERE r.version=(SELECT MAX(x.version) FROM work_item_result_versions x WHERE x.work_item_id=r.work_item_id)`);
  notify(afterStep, "backfill-review-heads");
  const legacyMemory = database.prepare(`
    WITH RECURSIVE chains(id,project_id,type,content,source_type,source_ref,supersedes_id,created_at,chain_id,version) AS (
      SELECT m.id,m.project_id,m.type,m.content,m.source_type,m.source_ref,m.supersedes_id,m.created_at,m.id,1
      FROM migration_v5_memory m WHERE m.supersedes_id IS NULL
      UNION ALL
      SELECT child.id,child.project_id,child.type,child.content,child.source_type,child.source_ref,
             child.supersedes_id,child.created_at,chains.chain_id,chains.version+1
      FROM migration_v5_memory child JOIN chains ON child.supersedes_id=chains.id
    ) SELECT * FROM chains ORDER BY chain_id,version
  `).all() as Array<{
    chain_id: string; content: string; created_at: string; id: string; project_id: string;
    source_ref: string; source_type: string; supersedes_id: string | null; type: string; version: number;
  }>;
  const insertMemory = database.prepare(`
    INSERT INTO memory_entries(
      id,project_id,chain_id,version,type,content,dedupe_hash,source_type,source_id,
      source_version,proposer_actor_type,proposer_actor_id,confirming_review_attempt_id,
      persistence_actor,supersedes_id,created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,NULL,'owner',NULL,NULL,'platform',?,?)
  `);
  for (const memory of legacyMemory) {
    const hash = createHash("sha256").update(JSON.stringify([
      memory.type, memory.content, memory.source_type, memory.source_ref, null,
    ])).digest("hex");
    insertMemory.run(
      memory.id, memory.project_id, memory.chain_id, memory.version, memory.type,
      memory.content, hash, memory.source_type, memory.source_ref,
      memory.supersedes_id, memory.created_at,
    );
  }
  notify(afterStep, "backfill-memory");
  database.exec(`
    INSERT INTO mission_delivery_heads(
      mission_id,project_id,context_version,state,current_delivery_id,current_operation_id,
      generation_lease_token,generation_lease_expires_at,last_error_code,
      next_event_sequence,version,updated_at
    )
    SELECT id,project_id,1,'ongoing',NULL,NULL,NULL,NULL,NULL,2,1,updated_at FROM missions`);
  notify(afterStep, "backfill-delivery-heads");
  database.exec(`
    INSERT INTO review_events(
      id,project_id,mission_id,sequence,type,actor_type,actor_id,payload_json,created_at
    )
    SELECT 'mission-review-initialized:'||id,project_id,id,1,'mission_review_initialized','system',NULL,
      json_object('contextVersion',1,'headVersion',1,'missionId',id),updated_at FROM missions`);
  notify(afterStep, "backfill-events");
  database.exec("UPDATE work_items SET status='in_progress',version=version+1 WHERE status='done'");
  notify(afterStep, "legacy-done");
  database.exec("DROP TABLE migration_v5_results");
  notify(afterStep, "drop-legacy-results");
  database.exec("DROP TABLE migration_v5_memory");
  notify(afterStep, "drop-legacy-memory");
}

export function initializeMissionDeliveryTx(
  database: DatabaseSync,
  mission: { id: string; projectId: string; updatedAt: string },
): void {
  database.prepare(`
    INSERT INTO mission_delivery_heads(
      mission_id,project_id,context_version,state,current_delivery_id,current_operation_id,
      generation_lease_token,generation_lease_expires_at,last_error_code,
      next_event_sequence,version,updated_at
    ) VALUES (?, ?, 1, 'ongoing', NULL, NULL, NULL, NULL, NULL, 1, 1, ?)
  `).run(mission.id, mission.projectId, mission.updatedAt);
  database.prepare(`
    INSERT INTO review_events(
      id,project_id,mission_id,sequence,type,actor_type,actor_id,payload_json,created_at
    ) VALUES (?, ?, ?, 1, 'mission_review_initialized', 'system', NULL, ?, ?)
  `).run(
    randomUUID(),
    mission.projectId,
    mission.id,
    JSON.stringify({ contextVersion: 1, headVersion: 1, missionId: mission.id }),
    mission.updatedAt,
  );
  const advanced = database.prepare(`
    UPDATE mission_delivery_heads SET next_event_sequence=2
    WHERE mission_id=? AND next_event_sequence=1
  `).run(mission.id);
  if (advanced.changes !== 1) throw new Error("MISSION_INITIALIZATION_CONFLICT");
}

function normalizeSql(sql: string): string {
  return sql.replace(/;\s*$/u, "").replace(/\s+/gu, " ").trim().toLowerCase();
}

const expectedSql = new Map<string, string>();
for (const statement of CREATE_V6_SCHEMA.split(/;\s*(?=CREATE|$)/iu).map((sql) => sql.trim()).filter(Boolean)) {
  const match = statement.match(/^CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX|TRIGGER)\s+([^\s(]+)/iu);
  if (match) expectedSql.set(match[1]!, normalizeSql(statement));
}

export function hasAnyV6Object(database: DatabaseSync): boolean {
  const wanted = new Set<string>([...V6_TABLES, ...V6_INDEXES, ...V6_TRIGGERS]);
  const rows = database.prepare(
    "SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
  ).all() as Array<{ name: string }>;
  const columns = database.prepare("PRAGMA table_info(agents)").all() as Array<{ name: string }>;
  return rows.some(({ name }) => wanted.has(name))
    || columns.some(({ name }) => name === "review_capable");
}

function count(database: DatabaseSync, sql: string): number {
  return (database.prepare(sql).get() as { count: number }).count;
}

export function validateV6(
  database: DatabaseSync,
  validateSchema = true,
  validateV5Schema = validateSchema,
): "SCHEMA_DRIFT" | "SCHEMA_DATA_INVALID" | null {
  const retainedValidation = validateV5Schema
    ? validateV5Retained(database)
    : validateV5RetainedData(database);
  if (retainedValidation) return retainedValidation;
  const wanted = new Set<string>([...V6_TABLES, ...V6_INDEXES, ...V6_TRIGGERS]);
  const rows = database.prepare(
    "SELECT name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
  ).all() as Array<{ name: string; sql: string | null }>;
  const actual = rows.filter(({ name }) => wanted.has(name));
  if (validateSchema && (
    actual.length !== wanted.size
    || actual.some(({ name, sql }) => !sql || normalizeSql(sql) !== expectedSql.get(name))
  )) return "SCHEMA_DRIFT";
  const agentColumn = (database.prepare("PRAGMA table_info(agents)").all() as Array<{
    dflt_value: string | null; name: string; notnull: number; type: string;
  }>).find(({ name }) => name === "review_capable");
  if (!agentColumn || agentColumn.type !== "INTEGER" || agentColumn.notnull !== 1 || agentColumn.dflt_value !== "0") {
    return "SCHEMA_DRIFT";
  }
  if ((database.prepare("PRAGMA foreign_key_check").all() as unknown[]).length > 0) return "SCHEMA_DRIFT";
  if (
    count(database, `SELECT COUNT(*) count FROM missions m
      WHERE NOT EXISTS(SELECT 1 FROM mission_delivery_heads h WHERE h.mission_id=m.id AND h.project_id=m.project_id)`) > 0
    || count(database, `SELECT COUNT(*) count FROM mission_delivery_heads h
      WHERE h.next_event_sequence<>(SELECT COUNT(*)+1 FROM review_events e WHERE e.mission_id=h.mission_id)`) > 0
    || count(database, `SELECT COUNT(*) count FROM (
      SELECT mission_id,sequence,ROW_NUMBER() OVER(PARTITION BY mission_id ORDER BY sequence,id) expected
      FROM review_events) WHERE sequence<>expected`) > 0
    || count(database, `SELECT COUNT(*) count FROM work_item_result_versions r
      JOIN executions e ON e.id=r.execution_id
      WHERE r.executor_agent_id<>e.agent_id OR r.project_id<>e.project_id
         OR r.mission_id<>e.mission_id OR r.work_item_id<>e.work_item_id`) > 0
    || count(database, `SELECT COUNT(*) count FROM (
      SELECT work_item_id,id,version,supersedes_result_id,
        LAG(id) OVER(PARTITION BY work_item_id ORDER BY version) expected_id,
        ROW_NUMBER() OVER(PARTITION BY work_item_id ORDER BY version) expected_version
      FROM work_item_result_versions)
      WHERE version<>expected_version OR supersedes_result_id IS NOT expected_id`) > 0
    || count(database, `SELECT COUNT(*) count FROM work_item_result_versions r
      WHERE r.version=(SELECT MAX(x.version) FROM work_item_result_versions x WHERE x.work_item_id=r.work_item_id)
        AND NOT EXISTS(SELECT 1 FROM work_item_review_heads h
          WHERE h.work_item_id=r.work_item_id AND h.current_result_id=r.id
            AND h.project_id=r.project_id AND h.mission_id=r.mission_id)`) > 0
    || count(database, `SELECT COUNT(*) count FROM work_item_review_heads h
      LEFT JOIN review_attempts a ON a.id=h.current_attempt_id
      WHERE (h.current_result_id IS NULL AND h.state<>'executing')
         OR (h.state='reviewing' AND (a.id IS NULL OR a.status NOT IN ('calling','finalizing')))
         OR (h.state<>'reviewing' AND a.status IN ('calling','finalizing'))`) > 0
    || count(database, `SELECT COUNT(*) count FROM review_attempts a
      JOIN work_item_result_versions r ON r.id=a.result_id
      LEFT JOIN agents reviewer ON reviewer.id=a.reviewer_agent_id
      LEFT JOIN project_memberships membership
        ON membership.project_id=a.project_id AND membership.agent_id=a.reviewer_agent_id
      WHERE a.reviewer_agent_id=r.executor_agent_id OR membership.agent_id IS NULL
         OR reviewer.review_capable<>1`) > 0
    || count(database, `SELECT COUNT(*) count FROM review_attempts a
      WHERE (a.status IN ('rejected','escalated','passed')
        AND (SELECT COUNT(*) FROM review_decisions d WHERE d.attempt_id=a.id)<>1)
         OR (a.status IN ('failed','interrupted','discarded')
        AND EXISTS(SELECT 1 FROM review_decisions d WHERE d.attempt_id=a.id))`) > 0
    || count(database, `SELECT COUNT(*) count FROM review_decisions d
      JOIN review_attempts a ON a.id=d.attempt_id
      WHERE d.result_id<>a.result_id OR d.reviewer_agent_id<>a.reviewer_agent_id`) > 0
    || count(database, `SELECT COUNT(*) count FROM memory_entries m
      WHERE (m.version=1 AND m.supersedes_id IS NOT NULL)
         OR (m.version>1 AND NOT EXISTS(
           SELECT 1 FROM memory_entries p WHERE p.id=m.supersedes_id
             AND p.project_id=m.project_id AND p.chain_id=m.chain_id
             AND p.type=m.type AND p.version=m.version-1))`) > 0
    || count(database, `SELECT COUNT(*) count FROM memory_entries a
      JOIN memory_entries b ON b.project_id=a.project_id AND b.type=a.type
        AND b.dedupe_hash=a.dedupe_hash AND b.id>a.id
      WHERE NOT EXISTS(SELECT 1 FROM memory_entries child WHERE child.supersedes_id=a.id)
        AND NOT EXISTS(SELECT 1 FROM memory_entries child WHERE child.supersedes_id=b.id)`) > 0
    || count(database, `SELECT COUNT(*) count FROM work_items w
      WHERE w.status='done' AND NOT EXISTS(
        SELECT 1 FROM work_item_review_heads h WHERE h.work_item_id=w.id AND h.state='passed')`) > 0
    || count(database, `SELECT COUNT(*) count FROM work_item_review_heads h
      JOIN work_items w ON w.id=h.work_item_id
      WHERE h.state='passed' AND (w.status<>'done' OR NOT EXISTS(
        SELECT 1 FROM review_attempts a JOIN review_decisions d ON d.attempt_id=a.id
        WHERE a.id=h.current_attempt_id AND d.choice='pass' AND d.result_id=h.current_result_id))`) > 0
    || count(database, `SELECT COUNT(*) count FROM mission_delivery_heads h
      WHERE (h.state='completed')<>(h.current_delivery_id IS NOT NULL)
         OR (h.state='completed' AND NOT EXISTS(
           SELECT 1 FROM mission_deliveries d WHERE d.id=h.current_delivery_id
             AND d.mission_id=h.mission_id AND d.project_id=h.project_id))`) > 0
  ) return "SCHEMA_DATA_INVALID";
  return null;
}

// Kept as aliases while T-1 callers are migrated in the same feature task.
export const createV6T1 = createV6;
export const hasAnyV6T1Object = hasAnyV6Object;
export const validateV6T1 = (database: DatabaseSync): boolean => validateV6(database) === null;

export function validateV6RetainedData(
  database: DatabaseSync,
): "SCHEMA_DRIFT" | "SCHEMA_DATA_INVALID" | null {
  return validateV6(database, false, false);
}

export function validateV6Retained(
  database: DatabaseSync,
): "SCHEMA_DRIFT" | "SCHEMA_DATA_INVALID" | null {
  return validateV6(database, true, false);
}
