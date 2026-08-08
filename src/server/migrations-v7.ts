import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

import { timelinePayloadSchemas } from "@/src/shared/collaboration-contracts";
import { mergeDescriptorFactsAreValid } from "@/src/server/migrations-v5";
import { validateV6RetainedData } from "@/src/server/migrations-v6";

export const V7_TABLE_SQL = new Map<string, string>([
  ["collaboration_threads", `CREATE TABLE collaboration_threads(
 id TEXT PRIMARY KEY,project_id TEXT NOT NULL,title TEXT NOT NULL CHECK(length(title)>=1 AND title=trim(title)),
 active_policy_revision_id TEXT NOT NULL,policy_version INTEGER NOT NULL CHECK(policy_version>=1),
 next_fact_sequence INTEGER NOT NULL CHECK(next_fact_sequence>=1),last_activity_sequence INTEGER NOT NULL CHECK(last_activity_sequence>=1),
 version INTEGER NOT NULL CHECK(version>=1),
 created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z'),
 updated_at TEXT NOT NULL CHECK(updated_at GLOB '????-??-??T??:??:??.???Z'),
 UNIQUE(project_id,id),UNIQUE(project_id,last_activity_sequence),
 FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
 FOREIGN KEY(project_id,id,active_policy_revision_id)
  REFERENCES collaboration_thread_policy_revisions(project_id,thread_id,id)
  ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED
);`],
  ["collaboration_project_thread_sequences", `CREATE TABLE collaboration_project_thread_sequences(
 project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
 next_activity_sequence INTEGER NOT NULL CHECK(next_activity_sequence>=1)
);`],
  ["collaboration_runs", `CREATE TABLE collaboration_runs(
 id TEXT PRIMARY KEY,project_id TEXT NOT NULL,thread_id TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN('running','waiting_owner','paused','failed','planned','stopped')),
 current_agent_id TEXT NOT NULL,round_count INTEGER NOT NULL DEFAULT 0 CHECK(round_count>=0),
 next_event_sequence INTEGER NOT NULL DEFAULT 1 CHECK(next_event_sequence>=1),
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),execution_epoch INTEGER NOT NULL DEFAULT 1 CHECK(execution_epoch>=1),
 pause_reason TEXT,pause_category TEXT,
 created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z'),
 updated_at TEXT NOT NULL CHECK(updated_at GLOB '????-??-??T??:??:??.???Z'),
 UNIQUE(project_id,id),UNIQUE(project_id,thread_id,id),
 FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
 FOREIGN KEY(project_id,thread_id) REFERENCES collaboration_threads(project_id,id) ON DELETE CASCADE,
 FOREIGN KEY(current_agent_id) REFERENCES agents(id) ON DELETE NO ACTION
);`],
  ["collaboration_operations", `CREATE TABLE collaboration_operations(
 id TEXT NOT NULL,project_id TEXT NOT NULL,thread_id TEXT NOT NULL,run_id TEXT,
 kind TEXT NOT NULL CHECK(kind IN('thread_create','policy_update','start','message','control','answer_decision','advance','recover')),
 request_hash TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN('pending','completed')),
 http_status INTEGER,response_json TEXT,response_schema_version INTEGER,
 created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z'),
 updated_at TEXT NOT NULL CHECK(updated_at GLOB '????-??-??T??:??:??.???Z'),
 PRIMARY KEY(project_id,id),UNIQUE(project_id,thread_id,id),UNIQUE(project_id,thread_id,run_id,id),
 CHECK(
  (status='pending' AND http_status IS NULL AND response_json IS NULL AND response_schema_version IS NULL) OR
  (status='completed' AND http_status BETWEEN 100 AND 599 AND json_valid(response_json)
   AND length(CAST(response_json AS BLOB))<=262144 AND response_schema_version=7)
 ),
 FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
 FOREIGN KEY(project_id,thread_id) REFERENCES collaboration_threads(project_id,id)
  ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(project_id,thread_id,run_id) REFERENCES collaboration_runs(project_id,thread_id,id) ON DELETE CASCADE
);`],
  ["collaboration_thread_policy_revisions", `CREATE TABLE collaboration_thread_policy_revisions(
 id TEXT PRIMARY KEY,project_id TEXT NOT NULL,thread_id TEXT NOT NULL,version INTEGER NOT NULL CHECK(version>=1),
 created_operation_id TEXT NOT NULL,
 created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z'),
 UNIQUE(project_id,thread_id,id),UNIQUE(project_id,thread_id,version),
 FOREIGN KEY(project_id,thread_id) REFERENCES collaboration_threads(project_id,id) ON DELETE CASCADE,
 FOREIGN KEY(project_id,thread_id,created_operation_id) REFERENCES collaboration_operations(project_id,thread_id,id)
  ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED
);`],
  ["collaboration_thread_policy_members", `CREATE TABLE collaboration_thread_policy_members(
 project_id TEXT NOT NULL,thread_id TEXT NOT NULL,revision_id TEXT NOT NULL,position INTEGER NOT NULL CHECK(position>=0),
 agent_id TEXT NOT NULL,agent_display_name TEXT NOT NULL CHECK(length(agent_display_name)>=1),
 PRIMARY KEY(project_id,thread_id,revision_id,agent_id),UNIQUE(project_id,thread_id,revision_id,position),
 FOREIGN KEY(project_id,thread_id,revision_id) REFERENCES collaboration_thread_policy_revisions(project_id,thread_id,id) ON DELETE CASCADE
);`],
  ["collaboration_project_sequences", `CREATE TABLE collaboration_project_sequences(
 project_id TEXT NOT NULL,thread_id TEXT NOT NULL,next_message_sequence INTEGER NOT NULL DEFAULT 1 CHECK(next_message_sequence>=1),
 PRIMARY KEY(project_id,thread_id),
 FOREIGN KEY(project_id,thread_id) REFERENCES collaboration_threads(project_id,id) ON DELETE CASCADE
);`],
  ["collaboration_messages", `CREATE TABLE collaboration_messages(
 id TEXT PRIMARY KEY,project_id TEXT NOT NULL,thread_id TEXT NOT NULL,run_id TEXT,
 author_type TEXT NOT NULL CHECK(author_type IN('owner','agent')),author_agent_id TEXT,
 author_display_name TEXT NOT NULL CHECK(length(author_display_name)>=1),content TEXT NOT NULL CHECK(length(content)>=1),
 mention_agent_id TEXT,mention_display_name TEXT,sequence INTEGER NOT NULL CHECK(sequence>=1),
 consumed_at TEXT CHECK(consumed_at IS NULL OR consumed_at GLOB '????-??-??T??:??:??.???Z'),
 created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z'),
 UNIQUE(project_id,thread_id,id),UNIQUE(project_id,thread_id,run_id,id),UNIQUE(project_id,thread_id,sequence),
 CHECK((author_type='owner' AND author_agent_id IS NULL) OR (author_type='agent' AND author_agent_id IS NOT NULL)),
 CHECK((mention_agent_id IS NULL AND mention_display_name IS NULL) OR
       (mention_agent_id IS NOT NULL AND mention_display_name IS NOT NULL)),
 FOREIGN KEY(project_id,thread_id) REFERENCES collaboration_threads(project_id,id) ON DELETE CASCADE,
 FOREIGN KEY(project_id,thread_id,run_id) REFERENCES collaboration_runs(project_id,thread_id,id) ON DELETE NO ACTION,
 FOREIGN KEY(author_agent_id) REFERENCES agents(id) ON DELETE NO ACTION,
 FOREIGN KEY(mention_agent_id) REFERENCES agents(id) ON DELETE NO ACTION
);`],
  ["collaboration_attempts", `CREATE TABLE collaboration_attempts(
 id TEXT PRIMARY KEY,project_id TEXT NOT NULL,thread_id TEXT NOT NULL,run_id TEXT NOT NULL,agent_id TEXT NOT NULL,
 operation_id TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN('calling','committed','failed','interrupted','discarded')),
 lease_token TEXT NOT NULL,lease_expires_at TEXT NOT NULL CHECK(lease_expires_at GLOB '????-??-??T??:??:??.???Z'),
 prompt_hash TEXT NOT NULL,acquire_execution_epoch INTEGER NOT NULL CHECK(acquire_execution_epoch>=1),
 acquire_context_hash TEXT NOT NULL,included_message_sequence INTEGER NOT NULL CHECK(included_message_sequence>=0),
 error_category TEXT,failure_provider_id TEXT,
 failure_provider_version INTEGER CHECK(failure_provider_version IS NULL OR failure_provider_version>=1),
 failure_credential_version INTEGER CHECK(failure_credential_version IS NULL OR failure_credential_version>=1),
 failure_credential_generation INTEGER CHECK(failure_credential_generation IS NULL OR failure_credential_generation>=1),
 failure_verified_at TEXT CHECK(failure_verified_at IS NULL OR failure_verified_at GLOB '????-??-??T??:??:??.???Z'),
 started_at TEXT NOT NULL CHECK(started_at GLOB '????-??-??T??:??:??.???Z'),
 finished_at TEXT CHECK(finished_at IS NULL OR finished_at GLOB '????-??-??T??:??:??.???Z'),
 UNIQUE(project_id,thread_id,id),UNIQUE(project_id,thread_id,run_id,id),
 UNIQUE(project_id,thread_id,run_id,operation_id),
 CHECK((status='calling' AND finished_at IS NULL) OR (status<>'calling' AND finished_at IS NOT NULL)),
 FOREIGN KEY(project_id,thread_id) REFERENCES collaboration_threads(project_id,id) ON DELETE CASCADE,
 FOREIGN KEY(project_id,thread_id,run_id) REFERENCES collaboration_runs(project_id,thread_id,id) ON DELETE CASCADE,
 FOREIGN KEY(project_id,thread_id,run_id,operation_id)
  REFERENCES collaboration_operations(project_id,thread_id,run_id,id) ON DELETE NO ACTION,
 FOREIGN KEY(agent_id) REFERENCES agents(id) ON DELETE NO ACTION
);`],
  ["collaboration_model_calls", `CREATE TABLE collaboration_model_calls(
 id TEXT PRIMARY KEY,attempt_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN('primary','repair')),
 call_index INTEGER NOT NULL CHECK(call_index IN(1,2)),
 status TEXT NOT NULL CHECK(status IN('succeeded','provider_failed','response_invalid','usage_invalid')),
 prompt_tokens INTEGER CHECK(prompt_tokens IS NULL OR prompt_tokens>=0),
 completion_tokens INTEGER CHECK(completion_tokens IS NULL OR completion_tokens>=0),
 total_tokens INTEGER CHECK(total_tokens IS NULL OR total_tokens>=0),error_category TEXT,
 created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z'),
 UNIQUE(attempt_id,call_index),
 CHECK((prompt_tokens IS NULL AND completion_tokens IS NULL AND total_tokens IS NULL) OR
       (prompt_tokens IS NOT NULL AND completion_tokens IS NOT NULL AND total_tokens=prompt_tokens+completion_tokens)),
 FOREIGN KEY(attempt_id) REFERENCES collaboration_attempts(id) ON DELETE CASCADE
);`],
  ["collaboration_turns", `CREATE TABLE collaboration_turns(
 id TEXT PRIMARY KEY,project_id TEXT NOT NULL,thread_id TEXT NOT NULL,attempt_id TEXT NOT NULL,
 run_id TEXT NOT NULL,agent_id TEXT NOT NULL,round_number INTEGER NOT NULL CHECK(round_number>=1),
 message_id TEXT NOT NULL,disposition TEXT NOT NULL CHECK(disposition IN('handoff','decision_request','plan_ready')),
 created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z'),
 UNIQUE(project_id,thread_id,id),UNIQUE(project_id,thread_id,run_id,id),
 UNIQUE(attempt_id),UNIQUE(message_id),UNIQUE(run_id,round_number),
 FOREIGN KEY(project_id,thread_id,run_id,attempt_id)
  REFERENCES collaboration_attempts(project_id,thread_id,run_id,id) ON DELETE NO ACTION,
 FOREIGN KEY(project_id,thread_id,run_id) REFERENCES collaboration_runs(project_id,thread_id,id) ON DELETE CASCADE,
 FOREIGN KEY(project_id,thread_id,run_id,message_id)
  REFERENCES collaboration_messages(project_id,thread_id,run_id,id) ON DELETE NO ACTION,
 FOREIGN KEY(agent_id) REFERENCES agents(id) ON DELETE NO ACTION
);`],
  ["decision_requests", `CREATE TABLE decision_requests(
 id TEXT PRIMARY KEY,project_id TEXT NOT NULL,thread_id TEXT NOT NULL,run_id TEXT NOT NULL,turn_id TEXT NOT NULL,
 requesting_agent_id TEXT NOT NULL,question TEXT NOT NULL CHECK(length(question)>=1),
 options_json TEXT NOT NULL CHECK(json_valid(options_json) AND json_type(options_json)='array' AND json_array_length(options_json) BETWEEN 2 AND 8),
 status TEXT NOT NULL CHECK(status IN('open','answered')),answer TEXT,answer_message_id TEXT,
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
 created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z'),
 answered_at TEXT CHECK(answered_at IS NULL OR answered_at GLOB '????-??-??T??:??:??.???Z'),
 UNIQUE(project_id,thread_id,run_id,id),UNIQUE(turn_id),
 CHECK((status='open' AND answer IS NULL AND answer_message_id IS NULL AND answered_at IS NULL) OR
       (status='answered' AND length(answer)>=1 AND answer_message_id IS NOT NULL AND answered_at IS NOT NULL)),
 FOREIGN KEY(project_id,thread_id,run_id) REFERENCES collaboration_runs(project_id,thread_id,id) ON DELETE CASCADE,
 FOREIGN KEY(project_id,thread_id,run_id,turn_id)
  REFERENCES collaboration_turns(project_id,thread_id,run_id,id) ON DELETE NO ACTION,
 FOREIGN KEY(project_id,thread_id,run_id,answer_message_id)
  REFERENCES collaboration_messages(project_id,thread_id,run_id,id) ON DELETE NO ACTION,
 FOREIGN KEY(requesting_agent_id) REFERENCES agents(id) ON DELETE NO ACTION
);`],
  ["collaboration_events", `CREATE TABLE collaboration_events(
 id TEXT PRIMARY KEY,project_id TEXT NOT NULL,thread_id TEXT NOT NULL,run_id TEXT NOT NULL,
 sequence INTEGER NOT NULL CHECK(sequence>=1),
 type TEXT NOT NULL CHECK(type IN('run_started','owner_message','agent_message','model_call_started','model_call_succeeded','model_call_failed','usage_recorded','tasks_created','task_claimed','handoff','decision_requested','decision_answered','boundary_paused','run_paused','run_resumed','run_retried','run_planned','run_stopped','attempt_interrupted','action_rejected','context_changed')),
 actor_type TEXT NOT NULL CHECK(actor_type IN('owner','agent','system')),actor_id TEXT,
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json) AND length(CAST(payload_json AS BLOB))<=65536),
 created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z'),
 UNIQUE(project_id,thread_id,run_id,id),UNIQUE(run_id,sequence),
 FOREIGN KEY(project_id,thread_id,run_id) REFERENCES collaboration_runs(project_id,thread_id,id) ON DELETE CASCADE
);`],
  ["collaboration_thread_facts", `CREATE TABLE collaboration_thread_facts(
 id TEXT PRIMARY KEY,project_id TEXT NOT NULL,thread_id TEXT NOT NULL,sequence INTEGER NOT NULL CHECK(sequence>=1),
 activity_sequence INTEGER NOT NULL CHECK(activity_sequence>=1),
 type TEXT NOT NULL CHECK(type IN('thread_created','policy_changed','owner_message','agent_message','run_linked','run_event')),
 actor_type TEXT NOT NULL CHECK(actor_type IN('owner','agent','system')),actor_id TEXT,
 run_id TEXT,message_id TEXT,run_event_id TEXT,policy_revision_id TEXT,
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json) AND length(CAST(payload_json AS BLOB))<=65536),
 created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z'),
 UNIQUE(project_id,thread_id,id),UNIQUE(project_id,thread_id,sequence),UNIQUE(project_id,activity_sequence),
 FOREIGN KEY(project_id,thread_id) REFERENCES collaboration_threads(project_id,id) ON DELETE CASCADE,
 FOREIGN KEY(project_id,thread_id,run_id) REFERENCES collaboration_runs(project_id,thread_id,id) ON DELETE NO ACTION,
 FOREIGN KEY(project_id,thread_id,message_id) REFERENCES collaboration_messages(project_id,thread_id,id) ON DELETE NO ACTION,
 FOREIGN KEY(project_id,thread_id,run_id,message_id) REFERENCES collaboration_messages(project_id,thread_id,run_id,id) ON DELETE NO ACTION,
 FOREIGN KEY(project_id,thread_id,run_id,run_event_id) REFERENCES collaboration_events(project_id,thread_id,run_id,id) ON DELETE NO ACTION,
 FOREIGN KEY(project_id,thread_id,policy_revision_id) REFERENCES collaboration_thread_policy_revisions(project_id,thread_id,id) ON DELETE NO ACTION,
 CHECK(
  (type='thread_created' AND run_id IS NULL AND message_id IS NULL AND run_event_id IS NULL AND policy_revision_id IS NULL) OR
  (type='policy_changed' AND run_id IS NULL AND message_id IS NULL AND run_event_id IS NULL AND policy_revision_id IS NOT NULL) OR
  (type IN('owner_message','agent_message') AND message_id IS NOT NULL AND run_event_id IS NULL AND policy_revision_id IS NULL) OR
  (type='run_linked' AND run_id IS NOT NULL AND message_id IS NULL AND run_event_id IS NULL AND policy_revision_id IS NULL) OR
  (type='run_event' AND run_id IS NOT NULL AND message_id IS NULL AND run_event_id IS NOT NULL AND policy_revision_id IS NULL)
 )
);`],
]);

export const V7_EXECUTIONS_SQL = `CREATE TABLE executions(
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
 source_collaboration_thread_id TEXT NOT NULL, source_collaboration_run_id TEXT NOT NULL,
 mission_id TEXT NOT NULL, work_item_id TEXT NOT NULL,
 agent_id TEXT NOT NULL, current_policy_revision_id TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('queued','running','waiting_approval','paused','staged','stale','conflicted','failed','stopped','merged')),
 resume_target TEXT CHECK(resume_target IS NULL OR resume_target IN ('queued','running','waiting_approval')),
 reason_code TEXT,
 manual_recovery_required INTEGER NOT NULL DEFAULT 0 CHECK(manual_recovery_required IN (0,1)),
 recovery_resolution TEXT CHECK(recovery_resolution IS NULL OR recovery_resolution IN ('recovered_old','recovered_new','abandoned')),
 current_attempt_no INTEGER NOT NULL CHECK(current_attempt_no>=1),
 business_round_count INTEGER NOT NULL DEFAULT 0 CHECK(business_round_count>=0),
 tool_call_count INTEGER NOT NULL DEFAULT 0 CHECK(tool_call_count>=0),
 next_event_sequence INTEGER NOT NULL DEFAULT 1 CHECK(next_event_sequence>=1),
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
 created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z'),
 business_deadline_at TEXT CHECK(business_deadline_at IS NULL OR business_deadline_at GLOB '????-??-??T??:??:??.???Z'),
 first_running_at TEXT CHECK(first_running_at IS NULL OR first_running_at GLOB '????-??-??T??:??:??.???Z'),
 updated_at TEXT NOT NULL CHECK(updated_at GLOB '????-??-??T??:??:??.???Z'),
 merged_at TEXT CHECK(merged_at IS NULL OR merged_at GLOB '????-??-??T??:??:??.???Z'),
 UNIQUE(project_id,id), UNIQUE(project_id,mission_id,work_item_id,id),
 FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
 FOREIGN KEY(project_id,source_collaboration_thread_id,source_collaboration_run_id)
  REFERENCES collaboration_runs(project_id,thread_id,id),
 FOREIGN KEY(project_id,mission_id) REFERENCES missions(project_id,id),
 FOREIGN KEY(mission_id,work_item_id) REFERENCES work_items(mission_id,id),
 FOREIGN KEY(project_id,agent_id) REFERENCES project_memberships(project_id,agent_id),
 FOREIGN KEY(project_id,current_policy_revision_id) REFERENCES project_validation_policy_revisions(project_id,id),
 CHECK((manual_recovery_required=1 AND status='conflicted' AND recovery_resolution IS NULL) OR manual_recovery_required=0),
 CHECK((status='merged') = (merged_at IS NOT NULL)),
 CHECK((first_running_at IS NULL AND business_deadline_at IS NULL) OR (first_running_at IS NOT NULL AND business_deadline_at IS NOT NULL))
);`;

export const V7_EXECUTION_INDEX_SQL = new Map<string, string>([
  ["execution_one_active_task", "CREATE UNIQUE INDEX execution_one_active_task ON executions(work_item_id) WHERE status IN ('queued','running','waiting_approval','paused','staged');"],
  ["execution_one_active_agent", "CREATE UNIQUE INDEX execution_one_active_agent ON executions(agent_id) WHERE status IN ('queued','running','waiting_approval','paused','staged');"],
  ["executions_project_status", "CREATE INDEX executions_project_status ON executions(project_id,status,created_at,id);"],
]);

export const V7_INDEX_TRIGGER_SQL = new Map<string, string>([
  ["collaboration_one_active_project", "CREATE UNIQUE INDEX collaboration_one_active_project ON collaboration_runs(project_id) WHERE status IN('running','waiting_owner','paused','failed');"],
  ["collaboration_one_calling_attempt", "CREATE UNIQUE INDEX collaboration_one_calling_attempt ON collaboration_attempts(run_id) WHERE status='calling';"],
  ["collaboration_one_open_decision", "CREATE UNIQUE INDEX collaboration_one_open_decision ON decision_requests(run_id) WHERE status='open';"],
  ["thread_fact_one_created", "CREATE UNIQUE INDEX thread_fact_one_created ON collaboration_thread_facts(project_id,thread_id) WHERE type='thread_created';"],
  ["thread_fact_one_policy", "CREATE UNIQUE INDEX thread_fact_one_policy ON collaboration_thread_facts(project_id,thread_id,policy_revision_id) WHERE type='policy_changed';"],
  ["thread_fact_one_message", "CREATE UNIQUE INDEX thread_fact_one_message ON collaboration_thread_facts(project_id,thread_id,message_id) WHERE type IN('owner_message','agent_message');"],
  ["thread_fact_one_run_link", "CREATE UNIQUE INDEX thread_fact_one_run_link ON collaboration_thread_facts(project_id,thread_id,run_id) WHERE type='run_linked';"],
  ["thread_fact_one_run_event", "CREATE UNIQUE INDEX thread_fact_one_run_event ON collaboration_thread_facts(project_id,thread_id,run_event_id) WHERE type='run_event';"],
  ["collaboration_threads_activity_page", "CREATE INDEX collaboration_threads_activity_page ON collaboration_threads(project_id,last_activity_sequence DESC,id);"],
  ["collaboration_facts_page", "CREATE INDEX collaboration_facts_page ON collaboration_thread_facts(project_id,thread_id,sequence,id);"],
  ["collaboration_runs_thread_page", "CREATE INDEX collaboration_runs_thread_page ON collaboration_runs(project_id,thread_id,created_at,id);"],
  ["thread_policy_revision_no_update", `CREATE TRIGGER thread_policy_revision_no_update BEFORE UPDATE ON collaboration_thread_policy_revisions
 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_THREAD_POLICY_REVISION'); END;`],
  ["thread_policy_revision_no_delete", `CREATE TRIGGER thread_policy_revision_no_delete BEFORE DELETE ON collaboration_thread_policy_revisions
 WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id)
 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_THREAD_POLICY_REVISION'); END;`],
  ["thread_policy_member_no_update", `CREATE TRIGGER thread_policy_member_no_update BEFORE UPDATE ON collaboration_thread_policy_members
 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_THREAD_POLICY_MEMBER'); END;`],
  ["thread_policy_member_no_delete", `CREATE TRIGGER thread_policy_member_no_delete BEFORE DELETE ON collaboration_thread_policy_members
 WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id)
 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_THREAD_POLICY_MEMBER'); END;`],
  ["thread_fact_no_update", `CREATE TRIGGER thread_fact_no_update BEFORE UPDATE ON collaboration_thread_facts
 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_THREAD_FACT'); END;`],
  ["thread_fact_no_delete", `CREATE TRIGGER thread_fact_no_delete BEFORE DELETE ON collaboration_thread_facts
 WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id)
 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_THREAD_FACT'); END;`],
  ["thread_identity_no_update", `CREATE TRIGGER thread_identity_no_update BEFORE UPDATE OF id,project_id,created_at ON collaboration_threads
 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_THREAD_IDENTITY'); END;`],
]);

export const V7_OBJECT_SQL = [
  ...V7_TABLE_SQL.values(),
  ...V7_INDEX_TRIGGER_SQL.values(),
] as const;

function normalizeSql(sql: string): string {
  return sql.replace(/;\s*$/u, "").replace(/\s+/gu, " ").trim().toLowerCase();
}

export const EXPECTED_V7_SQL = new Map<string, string>([
  ...V7_TABLE_SQL,
  ...V7_INDEX_TRIGGER_SQL,
].map(([name, sql]) => [name, normalizeSql(sql)]));
const EXPECTED_V7_EXECUTION_SQL = normalizeSql(V7_EXECUTIONS_SQL);
const EXPECTED_V7_EXECUTION_INDEX_SQL = new Map(
  [...V7_EXECUTION_INDEX_SQL].map(([name, sql]) => [name, normalizeSql(sql)]),
);

const V7_OBJECT_NAMES = new Set(EXPECTED_V7_SQL.keys());

function prefixIdentifiers(sql: string, prefix: "v7_"): string {
  return sql.replace(
    /\b[A-Za-z_][A-Za-z0-9_]*\b/gu,
    (identifier) => V7_OBJECT_NAMES.has(identifier) ? `${prefix}${identifier}` : identifier,
  );
}

export function renderV7(prefix: "" | "v7_"): readonly string[] {
  return prefix === "" ? V7_OBJECT_SQL : V7_OBJECT_SQL.map((sql) => prefixIdentifiers(sql, prefix));
}

export const V7_DATA_INVARIANTS = [
  `SELECT p.id FROM projects p LEFT JOIN collaboration_project_thread_sequences s ON s.project_id=p.id
 WHERE EXISTS(SELECT 1 FROM collaboration_threads t WHERE t.project_id=p.id) AND s.project_id IS NULL;`,
  `SELECT t.id FROM collaboration_threads t LEFT JOIN collaboration_thread_policy_revisions r
 ON (r.project_id,r.thread_id,r.id)=(t.project_id,t.id,t.active_policy_revision_id)
 WHERE r.id IS NULL OR r.version<>t.policy_version OR r.version<>(SELECT max(x.version) FROM collaboration_thread_policy_revisions x WHERE (x.project_id,x.thread_id)=(t.project_id,t.id));`,
  "SELECT revision_id FROM (SELECT revision_id,position,row_number() OVER(PARTITION BY project_id,thread_id,revision_id ORDER BY position)-1 expected FROM collaboration_thread_policy_members) WHERE position<>expected;",
  `SELECT id FROM (SELECT id,sequence,row_number() OVER(PARTITION BY project_id,thread_id ORDER BY sequence)-1+1 expected FROM collaboration_messages) WHERE sequence<>expected
 UNION ALL SELECT id FROM (SELECT id,sequence,row_number() OVER(PARTITION BY run_id ORDER BY sequence) expected FROM collaboration_events) WHERE sequence<>expected
 UNION ALL SELECT id FROM (SELECT id,sequence,row_number() OVER(PARTITION BY project_id,thread_id ORDER BY sequence) expected FROM collaboration_thread_facts) WHERE sequence<>expected;`,
  `SELECT t.id FROM collaboration_threads t WHERE t.next_fact_sequence<>1+(SELECT count(*) FROM collaboration_thread_facts f WHERE (f.project_id,f.thread_id)=(t.project_id,t.id))
 OR t.last_activity_sequence<>(SELECT max(f.activity_sequence) FROM collaboration_thread_facts f WHERE (f.project_id,f.thread_id)=(t.project_id,t.id));`,
  "SELECT s.project_id FROM collaboration_project_thread_sequences s WHERE s.next_activity_sequence<>1+coalesce((SELECT max(f.activity_sequence) FROM collaboration_thread_facts f WHERE f.project_id=s.project_id),0);",
  `SELECT t.id FROM collaboration_threads t WHERE (SELECT count(*) FROM collaboration_thread_facts f WHERE (f.project_id,f.thread_id,f.type)=(t.project_id,t.id,'thread_created'))<>1
 OR EXISTS(SELECT 1 FROM collaboration_thread_policy_revisions r WHERE (r.project_id,r.thread_id)=(t.project_id,t.id) AND (SELECT count(*) FROM collaboration_thread_facts f WHERE f.policy_revision_id=r.id AND f.type='policy_changed')<>1);`,
  `SELECT m.id FROM collaboration_messages m WHERE (SELECT count(*) FROM collaboration_thread_facts f WHERE f.message_id=m.id AND f.type=CASE m.author_type WHEN 'owner' THEN 'owner_message' ELSE 'agent_message' END)<>1
 UNION ALL SELECT r.id FROM collaboration_runs r WHERE (SELECT count(*) FROM collaboration_thread_facts f WHERE f.run_id=r.id AND f.type='run_linked')<>1
 UNION ALL SELECT e.id FROM collaboration_events e WHERE (SELECT count(*) FROM collaboration_thread_facts f WHERE f.run_event_id=e.id AND f.type='run_event')<>CASE e.type WHEN 'owner_message' THEN 0 WHEN 'agent_message' THEN 0 ELSE 1 END;`,
  `SELECT id FROM collaboration_operations WHERE (status='pending')<>(http_status IS NULL AND response_json IS NULL AND response_schema_version IS NULL)
 OR (status='completed')<>(http_status BETWEEN 100 AND 599 AND json_valid(response_json) AND response_schema_version=7);`,
  `SELECT o.id FROM collaboration_operations o
 WHERE o.status='pending' AND (
  o.kind<>'advance' OR
  (SELECT count(*) FROM collaboration_attempts a
    WHERE (a.project_id,a.thread_id,a.run_id,a.operation_id)=(o.project_id,o.thread_id,o.run_id,o.id)
      AND a.status='calling')<>1 OR
  EXISTS(SELECT 1 FROM collaboration_attempts a
    WHERE (a.project_id,a.thread_id,a.run_id,a.operation_id)=(o.project_id,o.thread_id,o.run_id,o.id)
      AND (a.status<>'calling' OR EXISTS(SELECT 1 FROM collaboration_model_calls c WHERE c.attempt_id=a.id)
       OR EXISTS(SELECT 1 FROM collaboration_turns t WHERE t.attempt_id=a.id)))
 );`,
  "SELECT project_id FROM collaboration_runs WHERE status IN('running','waiting_owner','paused','failed') GROUP BY project_id HAVING count(*)>1;",
] as const;

export function validateV7(
  database: DatabaseSync,
): "SCHEMA_DRIFT" | "SCHEMA_DATA_INVALID" | null {
  const rows = database.prepare(
    "SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
  ).all() as Array<{ name: string; sql: string | null; type: string }>;
  const actual = rows.filter(({ name }) =>
    V7_OBJECT_NAMES.has(name)
    || name.startsWith("collaboration_")
    || name.startsWith("thread_")
    || name === "decision_requests");
  if (
    actual.length !== EXPECTED_V7_SQL.size
    || actual.some(({ name, sql, type }) => {
      const expectedType = V7_TABLE_SQL.has(name)
        ? "table"
        : V7_INDEX_TRIGGER_SQL.get(name)?.startsWith("CREATE TRIGGER")
          ? "trigger"
          : "index";
      return type !== expectedType || sql === null || normalizeSql(sql) !== EXPECTED_V7_SQL.get(name);
    })
  ) return "SCHEMA_DRIFT";
  if ((database.prepare("PRAGMA foreign_key_check").all() as unknown[]).length > 0) {
    return "SCHEMA_DRIFT";
  }
  const hasRetainedSchema = database.prepare(
    `SELECT 1 FROM sqlite_master
     WHERE type='table' AND name='project_validation_policies'`,
  ).get() !== undefined;
  if (hasRetainedSchema) {
    const retainedValidation = validateV6RetainedData(database);
    if (retainedValidation) return retainedValidation;
  }
  if (
    database.prepare(
      `SELECT 1 FROM sqlite_master
       WHERE type='table' AND name='execution_merge_files'`,
    ).get() !== undefined
    && !mergeDescriptorFactsAreValid(database)
  ) {
    return "SCHEMA_DATA_INVALID";
  }
  const hasExecutions = database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='executions'",
  ).get() !== undefined;
  if (hasExecutions) {
    const executionObject = database.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='executions'",
    ).get() as { sql: string | null } | undefined;
    const executionIndexes = database.prepare(
      `SELECT name,sql FROM sqlite_master
       WHERE type='index' AND name IN (
         'execution_one_active_task','execution_one_active_agent','executions_project_status'
       )`,
    ).all() as Array<{ name: string; sql: string | null }>;
    if (
      !executionObject?.sql
      || normalizeSql(executionObject.sql) !== EXPECTED_V7_EXECUTION_SQL
      || executionIndexes.length !== EXPECTED_V7_EXECUTION_INDEX_SQL.size
      || executionIndexes.some(({ name, sql }) =>
        !sql || normalizeSql(sql) !== EXPECTED_V7_EXECUTION_INDEX_SQL.get(name)
      )
    ) {
      return "SCHEMA_DRIFT";
    }
    if (database.prepare(`
      SELECT e.id FROM executions e
      LEFT JOIN collaboration_runs r
        ON r.project_id=e.project_id
       AND r.thread_id=e.source_collaboration_thread_id
       AND r.id=e.source_collaboration_run_id
      WHERE e.source_collaboration_thread_id IS NULL OR r.id IS NULL
      LIMIT 1
    `).get() !== undefined) {
      return "SCHEMA_DATA_INVALID";
    }
  }
  for (const invariant of V7_DATA_INVARIANTS) {
    if ((database.prepare(invariant).get() as unknown) !== undefined) {
      return "SCHEMA_DATA_INVALID";
    }
  }
  return null;
}

type MigrationStepHook = (step: string, database: DatabaseSync) => void;

type LegacyProject = {
  createdAt: string;
  id: string;
};

type LegacyOperation = {
  createdAt: string;
  httpStatus: number | null;
  id: string;
  kind: string;
  projectId: string;
  requestHash: string;
  responseJson: string | null;
  runId: string | null;
  status: string;
  updatedAt: string;
};

type LegacyPendingAttempt = {
  id: string;
  runId: string;
  status: string;
};

type LegacyEventRow = {
  actorId: string | null;
  actorType: "owner" | "agent" | "system";
  id: string;
  nextEventSequence: number;
  payloadJson: string;
  projectId: string;
  runId: string;
  sequence: number;
  type: string;
};

type FactSeed = {
  actorId: string | null;
  actorType: string;
  createdAt: string;
  id: string;
  messageId: string | null;
  payload: unknown;
  policyRevisionId: string | null;
  rank: number;
  runEventId: string | null;
  runId: string | null;
  sourceSequence: number;
  type: string;
};

const LEGACY_TABLES_CHILD_FIRST = [
  "decision_requests",
  "collaboration_turns",
  "collaboration_model_calls",
  "collaboration_attempts",
  "collaboration_events",
  "collaboration_messages",
  "collaboration_operations",
  "collaboration_project_sequences",
  "collaboration_runs",
] as const;

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareUtf8(left, right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function legacyThreadId(projectId: string): string {
  return `legacy-thread-${hash(projectId)}`;
}

function syntheticOperationId(projectId: string): string {
  return `migration-thread-${hash(projectId)}`;
}

function policyRevisionId(projectId: string): string {
  return `migration-policy-${hash(projectId)}`;
}

function factId(kind: string, sourceId: string): string {
  return `migration-fact-${hash(canonicalJson([kind, sourceId]))}`;
}

function prefixInvariant(sql: string): string {
  return sql.replace(
    /\b[A-Za-z_][A-Za-z0-9_]*\b/gu,
    (identifier) => V7_OBJECT_NAMES.has(identifier) ? `v7_${identifier}` : identifier,
  );
}

function firstCollaborationTime(database: DatabaseSync, project: LegacyProject): string {
  const row = database.prepare(`
    SELECT MIN(created_at) AS createdAt FROM (
      SELECT created_at FROM collaboration_runs WHERE project_id=?
      UNION ALL SELECT created_at FROM collaboration_messages WHERE project_id=?
      UNION ALL SELECT created_at FROM collaboration_operations WHERE project_id=?
    )
  `).get(project.id, project.id, project.id) as { createdAt: string | null };
  return row.createdAt ?? project.createdAt;
}

const legacyId = z.string().min(1);
const legacyVersion = z.number().int().safe().min(1);
const legacySequence = z.number().int().safe().nonnegative();
const legacyRunSchema = z.object({
  id: legacyId,
  projectId: legacyId,
  status: z.enum(["running", "waiting_owner", "paused", "failed", "planned", "stopped"]),
  currentAgentId: legacyId,
  roundCount: legacySequence,
  pauseCategory: z.string().nullable(),
  version: legacyVersion,
  createdAt: z.string(),
  updatedAt: z.string(),
}).strict();
const legacyMessageSchema = z.object({
  id: legacyId,
  sequence: legacySequence,
  runId: legacyId.nullable(),
  authorType: z.enum(["owner", "agent"]),
  authorAgentId: legacyId.nullable(),
  authorDisplayName: z.string().min(1),
  content: z.string().min(1),
  mentionAgentId: legacyId.nullable(),
  mentionDisplayName: z.string().min(1).nullable(),
  mentionMemberStatus: z.enum(["current", "left"]).nullable(),
  createdAt: z.string(),
}).strict();
const legacyDecisionSchema = z.object({
  id: legacyId,
  runId: legacyId,
  turnId: legacyId,
  requestingAgentId: legacyId,
  question: z.string().min(1),
  options: z.array(z.string().min(1)).min(2).max(8),
  status: z.enum(["open", "answered"]),
  answer: z.string().min(1).nullable(),
  answerMessageId: legacyId.nullable(),
  version: legacyVersion,
  createdAt: z.string(),
  answeredAt: z.string().nullable(),
}).strict();
const legacyEventSchema = z.object({
  id: legacyId,
  runId: legacyId,
  sequence: legacySequence,
  type: z.string(),
  actorType: z.enum(["owner", "agent", "system"]),
  actorId: legacyId.nullable(),
  payload: z.unknown(),
  createdAt: z.string(),
}).strict();
const legacyErrorSchema = z.object({
  error: z.object({
    code: z.enum([
      "INVALID_JSON", "INVALID_INPUT", "STRUCTURED_OUTPUT_INVALID", "ACTION_INVALID",
      "PROJECT_NOT_FOUND", "RUN_NOT_FOUND", "DECISION_NOT_FOUND", "AGENT_NOT_FOUND",
      "CONTEXT_NOT_READY", "COLLABORATION_ACTIVE", "AGENT_NOT_MEMBER", "TURN_IN_PROGRESS",
      "RUN_STATE_CONFLICT", "DECISION_ALREADY_ANSWERED", "OPERATION_CONFLICT",
      "OPERATION_IN_PROGRESS", "ACTION_CONFLICT", "BOUNDARY_REACHED", "PROVIDER_AUTH",
      "RATE_LIMITED", "PROVIDER_UPSTREAM", "PROVIDER_UNREACHABLE",
      "PROVIDER_RESPONSE_INVALID", "PROVIDER_TIMEOUT", "CREDENTIAL_UNAVAILABLE",
      "STORAGE_UNAVAILABLE", "INTERNAL_ERROR",
    ]),
    message: z.string(),
    fields: z.record(z.string(), z.string()).optional(),
    currentVersion: legacyVersion.optional(),
    category: z.enum([
      "credential_unavailable", "provider_auth", "rate_limited", "provider_upstream",
      "provider_unreachable", "provider_response_invalid", "provider_timeout",
      "structured_output_invalid", "usage_invalid", "action_invalid", "action_conflict",
      "boundary_reached", "context_changed", "interrupted", "internal_failure",
    ]).optional(),
    correlationId: z.string().optional(),
  }).strict(),
}).strict();
const legacyStartReceiptSchema = z.object({
  created: z.boolean(),
  run: legacyRunSchema,
  message: legacyMessageSchema,
}).strict();
const legacyMessageReceiptSchema = z.object({
  message: legacyMessageSchema,
  run: legacyRunSchema.nullable(),
}).strict();
const legacyControlReceiptSchema = z.object({ run: legacyRunSchema }).strict();
const legacyDecisionReceiptSchema = z.object({
  decision: legacyDecisionSchema,
  run: legacyRunSchema,
}).strict();
const legacyAdvanceResultSchema = z.object({
  attemptStatus: z.enum(["committed", "discarded"]),
  attempt: z.object({
    id: legacyId,
    status: z.enum(["committed", "discarded"]),
  }).strict(),
  events: z.array(z.unknown()),
  run: legacyRunSchema,
}).strict();
const legacyInterruptedAdvanceSchema = z.object({
  attemptStatus: z.literal("interrupted"),
  run: legacyRunSchema,
}).strict();
const legacyPausedAdvanceSchema = z.object({
  kind: z.literal("paused"),
  boundary: z.enum(["rounds", "tokens", "handoffs"]),
  run: legacyRunSchema,
}).strict();
const legacyRecoverReceiptSchema = z.object({
  attempt: z.object({
    id: legacyId,
    status: z.enum(["calling", "committed", "failed", "interrupted", "discarded"]),
    leaseExpiresAt: z.string(),
  }).strict().nullable(),
  run: legacyRunSchema,
}).strict();

type LegacyRunDto = z.infer<typeof legacyRunSchema>;
type LegacyMessageDto = z.infer<typeof legacyMessageSchema>;
type LegacyEventDto = z.infer<typeof legacyEventSchema>;

function parseStrict<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error("SCHEMA_DATA_INVALID");
  return result.data;
}

function withTuple<T extends Record<string, unknown>>(
  value: T,
  projectId: string,
  threadId: string,
): T & { projectId: string; threadId: string } {
  if (Object.hasOwn(value, "projectId") && value.projectId !== projectId) {
    throw new Error("SCHEMA_DATA_INVALID");
  }
  return { ...value, projectId, threadId };
}

function requireRunIdentity(
  operation: LegacyOperation,
  run: LegacyRunDto,
): asserts operation is LegacyOperation & { runId: string } {
  if (operation.runId === null || run.id !== operation.runId) {
    throw new Error("SCHEMA_DATA_INVALID");
  }
}

function convertEvent(
  value: unknown,
  projectId: string,
  threadId: string,
): Record<string, unknown> {
  const parsed = parseStrict(legacyEventSchema, value);
  const payloadSchema = timelinePayloadSchemas[
    parsed.type as keyof typeof timelinePayloadSchemas
  ];
  if (!payloadSchema || !payloadSchema.safeParse(parsed.payload).success) {
    throw new Error("SCHEMA_DATA_INVALID");
  }
  return withTuple(parsed, projectId, threadId);
}

function publicMessage(
  database: DatabaseSync,
  projectId: string,
  threadId: string,
  messageId: string,
): Record<string, unknown> {
  const row = database.prepare(`
    SELECT id,sequence,run_id AS runId,author_type AS authorType,
           author_agent_id AS authorAgentId,author_display_name AS authorDisplayName,
           content,mention_agent_id AS mentionAgentId,
           mention_display_name AS mentionDisplayName,created_at AS createdAt
    FROM v7_collaboration_messages
    WHERE project_id=? AND thread_id=? AND id=?
  `).get(projectId, threadId, messageId) as Record<string, unknown> | undefined;
  if (!row) throw new Error("SCHEMA_DATA_INVALID");
  const mentionAgentId = row.mentionAgentId;
  const mentionMemberStatus = typeof mentionAgentId === "string"
    ? database.prepare(`
        SELECT 1 FROM project_memberships WHERE project_id=? AND agent_id=?
      `).get(projectId, mentionAgentId)
      ? "current"
      : "left"
    : null;
  return { ...row, mentionMemberStatus, projectId, threadId };
}

function publicFact(
  database: DatabaseSync,
  projectId: string,
  threadId: string,
  selector: { messageId: string } | { runEventId: string },
): Record<string, unknown> {
  const byMessage = "messageId" in selector;
  const row = database.prepare(`
    SELECT id,sequence,activity_sequence AS activitySequence,type,
           actor_type AS actorType,actor_id AS actorId,run_id AS runId,
           message_id AS messageId,run_event_id AS runEventId,
           policy_revision_id AS policyRevisionId,payload_json AS payloadJson,
           created_at AS createdAt
    FROM v7_collaboration_thread_facts
    WHERE project_id=? AND thread_id=? AND ${byMessage ? "message_id" : "run_event_id"}=?
  `).get(
    projectId,
    threadId,
    byMessage ? selector.messageId : selector.runEventId,
  ) as (Record<string, unknown> & { payloadJson: string }) | undefined;
  if (!row) throw new Error("SCHEMA_DATA_INVALID");
  const { payloadJson, ...fact } = row;
  return {
    ...fact,
    message: typeof row.messageId === "string"
      ? publicMessage(database, projectId, threadId, row.messageId)
      : null,
    payload: JSON.parse(payloadJson) as unknown,
    projectId,
    threadId,
  };
}

function oneEventId(
  database: DatabaseSync,
  sql: string,
  ...parameters: Array<string>
): string {
  const rows = database.prepare(sql).all(...parameters) as Array<{ id: string }>;
  if (rows.length !== 1) throw new Error("SCHEMA_DATA_INVALID");
  return rows[0]!.id;
}

function requireLegacyRow<T extends Record<string, unknown>>(
  database: DatabaseSync,
  sql: string,
  ...parameters: Array<string>
): T {
  const row = database.prepare(sql).get(...parameters) as T | undefined;
  if (!row) throw new Error("SCHEMA_DATA_INVALID");
  return row;
}

function validateLegacyEvents(database: DatabaseSync): void {
  const events = database.prepare(`
    SELECT event.id,event.run_id AS runId,event.sequence,event.type,
           event.actor_type AS actorType,event.actor_id AS actorId,
           event.payload_json AS payloadJson,run.project_id AS projectId,
           run.next_event_sequence AS nextEventSequence
    FROM collaboration_events event
    JOIN collaboration_runs run ON run.id=event.run_id
    ORDER BY event.run_id,event.sequence,event.id
  `).all() as LegacyEventRow[];
  const eventsByRun = new Map<string, LegacyEventRow[]>();
  for (const event of events) {
    const runEvents = eventsByRun.get(event.runId) ?? [];
    runEvents.push(event);
    eventsByRun.set(event.runId, runEvents);
  }
  const runs = database.prepare(`
    SELECT id,next_event_sequence AS nextEventSequence FROM collaboration_runs
  `).all() as Array<{ id: string; nextEventSequence: number }>;
  for (const run of runs) {
    const runEvents = eventsByRun.get(run.id) ?? [];
    if (
      runEvents.some((event, index) => event.sequence !== index + 1)
      || run.nextEventSequence !== runEvents.length + 1
    ) throw new Error("SCHEMA_DATA_INVALID");
  }

  const messageEventCounts = new Map<string, number>();
  const ownerTypes = new Set([
    "run_started",
    "owner_message",
    "decision_answered",
    "run_resumed",
    "run_retried",
    "run_stopped",
  ]);
  const agentTypes = new Set([
    "agent_message",
    "model_call_started",
    "model_call_succeeded",
    "model_call_failed",
    "usage_recorded",
    "tasks_created",
    "task_claimed",
    "handoff",
    "decision_requested",
    "run_planned",
  ]);
  const systemTypes = new Set([
    "boundary_paused",
    "attempt_interrupted",
    "action_rejected",
    "context_changed",
  ]);
  const attemptTypes = new Set([
    "model_call_started",
    "model_call_succeeded",
    "model_call_failed",
    "usage_recorded",
    "attempt_interrupted",
    "action_rejected",
    "context_changed",
  ]);
  const turnTypes = new Set([
    "tasks_created",
    "task_claimed",
    "handoff",
    "decision_requested",
    "run_planned",
  ]);

  for (const event of events) {
    const payloadSchema = timelinePayloadSchemas[
      event.type as keyof typeof timelinePayloadSchemas
    ];
    let rawPayload: unknown;
    try {
      rawPayload = JSON.parse(event.payloadJson);
    } catch {
      throw new Error("SCHEMA_DATA_INVALID");
    }
    if (!payloadSchema) throw new Error("SCHEMA_DATA_INVALID");
    const payload = parseStrict(
      payloadSchema as z.ZodType<Record<string, unknown>>,
      rawPayload,
    );

    const runPausedByOwner = event.type === "run_paused"
      && payload.category === "manual";
    const runPausedBySystem = event.type === "run_paused"
      && payload.category !== "manual";
    const actorIsValid =
      (ownerTypes.has(event.type) || runPausedByOwner)
        ? event.actorType === "owner" && event.actorId === null
        : agentTypes.has(event.type)
          ? event.actorType === "agent" && event.actorId !== null
          : (systemTypes.has(event.type) || runPausedBySystem)
            && event.actorType === "system" && event.actorId === null;
    if (!actorIsValid) throw new Error("SCHEMA_DATA_INVALID");

    if (event.type === "owner_message" || event.type === "agent_message") {
      const message = requireLegacyRow<{
        authorAgentId: string | null;
        authorDisplayName: string;
        authorType: string;
        mentionAgentId: string | null;
        mentionDisplayName: string | null;
        projectId: string;
        runId: string | null;
        sequence: number;
      }>(database, `
        SELECT project_id AS projectId,run_id AS runId,sequence,
               author_type AS authorType,author_agent_id AS authorAgentId,
               author_display_name AS authorDisplayName,
               mention_agent_id AS mentionAgentId,
               mention_display_name AS mentionDisplayName
        FROM collaboration_messages WHERE id=?
      `, String(payload.messageId));
      if (
        message.projectId !== event.projectId
        || message.runId !== event.runId
        || message.sequence !== payload.messageSequence
        || message.authorType !== (event.type === "owner_message" ? "owner" : "agent")
        || message.authorAgentId !== event.actorId
      ) throw new Error("SCHEMA_DATA_INVALID");
      if (
        event.type === "owner_message"
        && (
          message.mentionAgentId !== payload.mentionAgentId
          || message.mentionDisplayName !== payload.mentionDisplayName
        )
      ) throw new Error("SCHEMA_DATA_INVALID");
      if (
        event.type === "agent_message"
        && (
          message.authorAgentId !== payload.agentId
          || message.authorDisplayName !== payload.agentDisplayName
        )
      ) throw new Error("SCHEMA_DATA_INVALID");
      const messageId = String(payload.messageId);
      messageEventCounts.set(messageId, (messageEventCounts.get(messageId) ?? 0) + 1);
    }

    if (event.type === "run_started") {
      const message = requireLegacyRow<{
        projectId: string;
        sequence: number;
      }>(database, `
        SELECT project_id AS projectId,sequence
        FROM collaboration_messages WHERE id=?
      `, String(payload.messageId));
      if (
        message.projectId !== event.projectId
        || message.sequence !== payload.messageSequence
      ) throw new Error("SCHEMA_DATA_INVALID");
    }

    if (attemptTypes.has(event.type)) {
      const attempt = requireLegacyRow<{
        agentId: string;
        projectId: string;
        runId: string;
      }>(database, `
        SELECT project_id AS projectId,run_id AS runId,agent_id AS agentId
        FROM collaboration_attempts WHERE id=?
      `, String(payload.attemptId));
      if (
        attempt.projectId !== event.projectId
        || attempt.runId !== event.runId
        || (event.actorType === "agent"
          && (event.actorId !== attempt.agentId
            || ("agentId" in payload && payload.agentId !== attempt.agentId)))
      ) throw new Error("SCHEMA_DATA_INVALID");
    }

    if (turnTypes.has(event.type) || event.type === "agent_message") {
      const turn = requireLegacyRow<{
        agentId: string;
        attemptProjectId: string;
        attemptRunId: string;
        attemptStatus: string;
        messageId: string;
        runId: string;
      }>(database, `
        SELECT turn.run_id AS runId,turn.agent_id AS agentId,
               turn.message_id AS messageId,attempt.project_id AS attemptProjectId,
               attempt.run_id AS attemptRunId,attempt.status AS attemptStatus
        FROM collaboration_turns turn
        JOIN collaboration_attempts attempt ON attempt.id=turn.attempt_id
        WHERE turn.id=?
      `, String(payload.turnId));
      if (
        turn.runId !== event.runId
        || turn.attemptProjectId !== event.projectId
        || turn.attemptRunId !== event.runId
        || turn.agentId !== event.actorId
        || (event.type === "agent_message"
          && (turn.messageId !== payload.messageId
            || turn.attemptStatus !== "committed"))
      ) throw new Error("SCHEMA_DATA_INVALID");
    }

    if (event.type === "task_claimed" && payload.agentId !== event.actorId) {
      throw new Error("SCHEMA_DATA_INVALID");
    }
    if (event.type === "handoff" && payload.fromAgentId !== event.actorId) {
      throw new Error("SCHEMA_DATA_INVALID");
    }

    if (event.type === "decision_requested") {
      const decision = requireLegacyRow<{
        optionsJson: string;
        projectId: string;
        question: string;
        requestingAgentId: string;
        runId: string;
        turnId: string;
      }>(database, `
        SELECT run.project_id AS projectId,decision.run_id AS runId,
               decision.turn_id AS turnId,
               decision.requesting_agent_id AS requestingAgentId,
               decision.question,decision.options_json AS optionsJson
        FROM decision_requests decision
        JOIN collaboration_runs run ON run.id=decision.run_id
        WHERE decision.id=?
      `, String(payload.decisionId));
      if (
        decision.projectId !== event.projectId
        || decision.runId !== event.runId
        || decision.turnId !== payload.turnId
        || decision.requestingAgentId !== event.actorId
        || payload.agentId !== event.actorId
        || decision.question !== payload.question
        || canonicalJson(JSON.parse(decision.optionsJson)) !== canonicalJson(payload.options)
      ) throw new Error("SCHEMA_DATA_INVALID");
    }

    if (event.type === "decision_answered") {
      const decision = requireLegacyRow<{
        answer: string | null;
        answerMessageId: string | null;
        messageProjectId: string | null;
        messageRunId: string | null;
        messageSequence: number | null;
        projectId: string;
        runId: string;
      }>(database, `
        SELECT run.project_id AS projectId,decision.run_id AS runId,
               decision.answer,decision.answer_message_id AS answerMessageId,
               message.project_id AS messageProjectId,message.run_id AS messageRunId,
               message.sequence AS messageSequence
        FROM decision_requests decision
        JOIN collaboration_runs run ON run.id=decision.run_id
        LEFT JOIN collaboration_messages message ON message.id=decision.answer_message_id
        WHERE decision.id=?
      `, String(payload.decisionId));
      if (
        decision.projectId !== event.projectId
        || decision.runId !== event.runId
        || decision.answer !== payload.answer
        || decision.answerMessageId !== payload.messageId
        || decision.messageProjectId !== event.projectId
        || decision.messageRunId !== event.runId
        || decision.messageSequence !== payload.messageSequence
      ) throw new Error("SCHEMA_DATA_INVALID");
    }
  }

  const runMessages = database.prepare(`
    SELECT id FROM collaboration_messages WHERE run_id IS NOT NULL
  `).all() as Array<{ id: string }>;
  if (runMessages.some(({ id }) => messageEventCounts.get(id) !== 1)) {
    throw new Error("SCHEMA_DATA_INVALID");
  }
}

function convertReceipt(
  database: DatabaseSync,
  operation: LegacyOperation,
  threadId: string,
): string | null {
  if (operation.status === "pending") return null;
  if (operation.responseJson === null || operation.httpStatus === null) {
    throw new Error("SCHEMA_DATA_INVALID");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(operation.responseJson);
  } catch {
    throw new Error("SCHEMA_DATA_INVALID");
  }
  const error = legacyErrorSchema.safeParse(parsed);
  if (error.success) return canonicalJson(error.data);
  if (
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
    && Object.hasOwn(parsed, "error")
  ) throw new Error("SCHEMA_DATA_INVALID");

  const projectId = operation.projectId;
  let converted: unknown;
  if (operation.kind === "start") {
    const body = parseStrict(legacyStartReceiptSchema, parsed);
    requireRunIdentity(operation, body.run);
    if (body.message.runId !== body.run.id) throw new Error("SCHEMA_DATA_INVALID");
    converted = {
      created: body.created,
      message: withTuple(body.message, projectId, threadId),
      run: withTuple(body.run, projectId, threadId),
    };
  } else if (operation.kind === "message") {
    const body = parseStrict(legacyMessageReceiptSchema, parsed);
    if (
      body.message.runId !== operation.runId
      || (body.run === null) !== (operation.runId === null)
    ) throw new Error("SCHEMA_DATA_INVALID");
    if (body.run) requireRunIdentity(operation, body.run);
    converted = {
      fact: publicFact(database, projectId, threadId, { messageId: body.message.id }),
      message: withTuple(body.message, projectId, threadId),
      run: body.run ? withTuple(body.run, projectId, threadId) : null,
    };
  } else if (operation.kind === "control") {
    const body = parseStrict(legacyControlReceiptSchema, parsed);
    requireRunIdentity(operation, body.run);
    const eventId = oneEventId(database, `
      SELECT id FROM v7_collaboration_events
      WHERE project_id=? AND thread_id=? AND run_id=? AND created_at=?
        AND type IN ('run_paused','run_resumed','run_retried','run_stopped')
    `, projectId, threadId, operation.runId, operation.updatedAt);
    converted = {
      fact: publicFact(database, projectId, threadId, { runEventId: eventId }),
      run: withTuple(body.run, projectId, threadId),
    };
  } else if (operation.kind === "answer_decision") {
    const body = parseStrict(legacyDecisionReceiptSchema, parsed);
    requireRunIdentity(operation, body.run);
    if (
      body.decision.status !== "answered"
      || !body.decision.answerMessageId
      || !body.decision.answeredAt
      || body.decision.runId !== operation.runId
    ) throw new Error("SCHEMA_DATA_INVALID");
    const eventId = oneEventId(database, `
      SELECT id FROM v7_collaboration_events
      WHERE project_id=? AND thread_id=? AND run_id=? AND type='decision_answered'
        AND json_extract(payload_json,'$.decisionId')=?
    `, projectId, threadId, body.decision.runId, body.decision.id);
    const messageFact = publicFact(database, projectId, threadId, {
      messageId: body.decision.answerMessageId,
    });
    converted = {
      decision: withTuple(body.decision, projectId, threadId),
      facts: [
        messageFact,
        publicFact(database, projectId, threadId, { runEventId: eventId }),
      ],
      message: messageFact.message,
      run: withTuple(body.run, projectId, threadId),
    };
  } else if (operation.kind === "advance") {
    const committed = legacyAdvanceResultSchema.safeParse(parsed);
    const interrupted = legacyInterruptedAdvanceSchema.safeParse(parsed);
    const paused = legacyPausedAdvanceSchema.safeParse(parsed);
    if (committed.success) {
      requireRunIdentity(operation, committed.data.run);
      if (committed.data.attemptStatus !== committed.data.attempt.status) {
        throw new Error("SCHEMA_DATA_INVALID");
      }
      converted = {
        ...committed.data,
        events: committed.data.events.map((item) => {
          const convertedEvent = convertEvent(item, projectId, threadId);
          if (convertedEvent.runId !== operation.runId) {
            throw new Error("SCHEMA_DATA_INVALID");
          }
          return convertedEvent;
        }),
        run: withTuple(committed.data.run, projectId, threadId),
      };
    } else if (interrupted.success) {
      requireRunIdentity(operation, interrupted.data.run);
      converted = {
        ...interrupted.data,
        run: withTuple(interrupted.data.run, projectId, threadId),
      };
    } else if (paused.success) {
      requireRunIdentity(operation, paused.data.run);
      converted = {
        ...paused.data,
        run: withTuple(paused.data.run, projectId, threadId),
      };
    } else {
      throw new Error("SCHEMA_DATA_INVALID");
    }
  } else if (operation.kind === "recover") {
    const body = parseStrict(legacyRecoverReceiptSchema, parsed);
    requireRunIdentity(operation, body.run);
    converted = {
      attempt: body.attempt,
      fact: null,
      run: withTuple(body.run, projectId, threadId),
    };
  } else {
    throw new Error("SCHEMA_DATA_INVALID");
  }
  return canonicalJson(converted);
}

function validatePendingOperation(
  database: DatabaseSync,
  operation: LegacyOperation,
): void {
  if (
    operation.kind !== "advance"
    || operation.runId === null
    || operation.httpStatus !== null
    || operation.responseJson !== null
    || !database.prepare(
      "SELECT 1 FROM collaboration_runs WHERE id=? AND project_id=?",
    ).get(operation.runId, operation.projectId)
  ) {
    throw new Error("SCHEMA_DATA_INVALID");
  }
  const operationAttempts = database.prepare(`
    SELECT id,run_id AS runId,status
    FROM collaboration_attempts
    WHERE project_id=? AND operation_id=?
  `).all(operation.projectId, operation.id) as LegacyPendingAttempt[];
  if (
    operationAttempts.length !== 1
    || operationAttempts[0]!.runId !== operation.runId
    || operationAttempts[0]!.status !== "calling"
  ) {
    throw new Error("SCHEMA_DATA_INVALID");
  }
  const attemptId = operationAttempts[0]!.id;
  if (
    database.prepare(
      "SELECT 1 FROM collaboration_model_calls WHERE attempt_id=? LIMIT 1",
    ).get(attemptId)
    || database.prepare(
      "SELECT 1 FROM collaboration_turns WHERE attempt_id=? LIMIT 1",
    ).get(attemptId)
  ) {
    throw new Error("SCHEMA_DATA_INVALID");
  }
}

function validateShadowData(database: DatabaseSync): void {
  if ((database.prepare("PRAGMA foreign_key_check").all() as unknown[]).length > 0) {
    throw new Error("SCHEMA_DATA_INVALID");
  }
  for (const invariant of V7_DATA_INVARIANTS) {
    if (database.prepare(prefixInvariant(invariant)).get() !== undefined) {
      throw new Error("SCHEMA_DATA_INVALID");
    }
  }
}

function copyLegacyData(database: DatabaseSync, hook?: MigrationStepHook): void {
  const notify = (step: string) => hook?.(step, database);
  validateLegacyEvents(database);
  const projects = database.prepare(
    "SELECT id,created_at AS createdAt FROM projects ORDER BY id",
  ).all() as LegacyProject[];
  const projectTimes = new Map(projects.map((project) => [
    project.id,
    firstCollaborationTime(database, project),
  ]));
  database.exec("CREATE TEMP TABLE v7_thread_map(project_id TEXT PRIMARY KEY,thread_id TEXT NOT NULL)");
  const insertThreadMap = database.prepare(
    "INSERT INTO v7_thread_map(project_id,thread_id) VALUES (?,?)",
  );
  for (const project of projects) insertThreadMap.run(project.id, legacyThreadId(project.id));

  for (const project of projects) {
    const threadId = legacyThreadId(project.id);
    const operationId = syntheticOperationId(project.id);
    const revisionId = policyRevisionId(project.id);
    const createdAt = projectTimes.get(project.id)!;
    database.prepare(`
      INSERT INTO v7_collaboration_threads(
        id,project_id,title,active_policy_revision_id,policy_version,
        next_fact_sequence,last_activity_sequence,version,created_at,updated_at
      ) VALUES (?,?,'历史协作',?,1,1,1,1,?,?)
    `).run(threadId, project.id, revisionId, createdAt, createdAt);
    database.prepare(`
      INSERT INTO v7_collaboration_operations(
        id,project_id,thread_id,run_id,kind,request_hash,status,http_status,
        response_json,response_schema_version,created_at,updated_at
      ) VALUES (?,?,?,NULL,'thread_create',?,'completed',201,'{}',7,?,?)
    `).run(
      operationId,
      project.id,
      threadId,
      hash(canonicalJson(["v7-legacy-thread", project.id])),
      createdAt,
      createdAt,
    );
    database.prepare(`
      INSERT INTO v7_collaboration_thread_policy_revisions(
        id,project_id,thread_id,version,created_operation_id,created_at
      ) VALUES (?,?,?,1,?,?)
    `).run(revisionId, project.id, threadId, operationId, createdAt);
    const members = database.prepare(`
      SELECT membership.agent_id AS agentId,agents.name AS displayName
      FROM project_memberships membership
      JOIN agents ON agents.id=membership.agent_id
      WHERE membership.project_id=?
      ORDER BY membership.joined_at,membership.agent_id
    `).all(project.id) as Array<{ agentId: string; displayName: string }>;
    const insertMember = database.prepare(`
      INSERT INTO v7_collaboration_thread_policy_members(
        project_id,thread_id,revision_id,position,agent_id,agent_display_name
      ) VALUES (?,?,?,?,?,?)
    `);
    members.forEach((member, position) => insertMember.run(
      project.id,
      threadId,
      revisionId,
      position,
      member.agentId,
      member.displayName,
    ));
    database.prepare(`
      INSERT INTO v7_collaboration_project_sequences(project_id,thread_id,next_message_sequence)
      VALUES (?,?,COALESCE((
        SELECT next_message_sequence FROM collaboration_project_sequences WHERE project_id=?
      ),1))
    `).run(project.id, threadId, project.id);
  }
  notify("copy-thread");
  notify("copy-policy");

  database.exec(`
    INSERT INTO v7_collaboration_runs(
      id,project_id,thread_id,status,current_agent_id,round_count,next_event_sequence,
      version,execution_epoch,pause_reason,pause_category,created_at,updated_at
    )
    SELECT run.id,run.project_id,map.thread_id,run.status,
      current_agent_id,round_count,next_event_sequence,version,execution_epoch,
      pause_reason,pause_category,created_at,updated_at
    FROM collaboration_runs run JOIN v7_thread_map map ON map.project_id=run.project_id
  `);
  notify("copy-collaboration-runs");

  const operations = database.prepare(`
    SELECT id,project_id AS projectId,run_id AS runId,kind,request_hash AS requestHash,
           status,http_status AS httpStatus,response_json AS responseJson,
           created_at AS createdAt,updated_at AS updatedAt
    FROM collaboration_operations ORDER BY project_id,id
  `).all() as LegacyOperation[];
  const insertOperation = database.prepare(`
    INSERT INTO v7_collaboration_operations(
      id,project_id,thread_id,run_id,kind,request_hash,status,http_status,
      response_json,response_schema_version,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  for (const operation of operations) {
    if (![
      "start",
      "message",
      "control",
      "answer_decision",
      "advance",
      "recover",
    ].includes(operation.kind)) {
      throw new Error("SCHEMA_DATA_INVALID");
    }
    if (operation.status === "pending") validatePendingOperation(database, operation);
    const threadId = legacyThreadId(operation.projectId);
    insertOperation.run(
      operation.id,
      operation.projectId,
      threadId,
      operation.runId,
      operation.kind,
      operation.requestHash,
      operation.status,
      operation.httpStatus,
      operation.status === "completed" ? "{}" : null,
      operation.status === "completed" ? 7 : null,
      operation.createdAt,
      operation.updatedAt,
    );
  }

  database.exec(`
    INSERT INTO v7_collaboration_messages(
      id,project_id,thread_id,run_id,author_type,author_agent_id,author_display_name,
      content,mention_agent_id,mention_display_name,sequence,consumed_at,created_at
    )
    SELECT message.id,message.project_id,map.thread_id,message.run_id,
      author_type,author_agent_id,author_display_name,content,mention_agent_id,
      mention_display_name,sequence,consumed_at,created_at
    FROM collaboration_messages message
    JOIN v7_thread_map map ON map.project_id=message.project_id;
    INSERT INTO v7_collaboration_attempts(
      id,project_id,thread_id,run_id,agent_id,operation_id,status,lease_token,
      lease_expires_at,prompt_hash,acquire_execution_epoch,acquire_context_hash,
      included_message_sequence,error_category,failure_provider_id,
      failure_provider_version,failure_credential_version,failure_credential_generation,
      failure_verified_at,started_at,finished_at
    )
    SELECT attempt.id,attempt.project_id,map.thread_id,attempt.run_id,
      agent_id,operation_id,status,lease_token,lease_expires_at,prompt_hash,
      acquire_execution_epoch,acquire_context_hash,included_message_sequence,error_category,
      failure_provider_id,failure_provider_version,failure_credential_version,
      failure_credential_generation,failure_verified_at,started_at,finished_at
    FROM collaboration_attempts attempt
    JOIN v7_thread_map map ON map.project_id=attempt.project_id;
    INSERT INTO v7_collaboration_model_calls SELECT * FROM collaboration_model_calls;
    INSERT INTO v7_collaboration_turns(
      id,project_id,thread_id,attempt_id,run_id,agent_id,round_number,message_id,
      disposition,created_at
    )
    SELECT turn.id,run.project_id,map.thread_id,
      turn.attempt_id,turn.run_id,turn.agent_id,turn.round_number,turn.message_id,
      turn.disposition,turn.created_at
    FROM collaboration_turns turn JOIN collaboration_runs run ON run.id=turn.run_id
    JOIN v7_thread_map map ON map.project_id=run.project_id;
    INSERT INTO v7_decision_requests(
      id,project_id,thread_id,run_id,turn_id,requesting_agent_id,question,options_json,
      status,answer,answer_message_id,version,created_at,answered_at
    )
    SELECT decision.id,run.project_id,map.thread_id,
      decision.run_id,decision.turn_id,decision.requesting_agent_id,decision.question,
      decision.options_json,decision.status,decision.answer,decision.answer_message_id,
      decision.version,decision.created_at,decision.answered_at
    FROM decision_requests decision JOIN collaboration_runs run ON run.id=decision.run_id
    JOIN v7_thread_map map ON map.project_id=run.project_id;
    INSERT INTO v7_collaboration_events(
      id,project_id,thread_id,run_id,sequence,type,actor_type,actor_id,payload_json,created_at
    )
    SELECT event.id,run.project_id,map.thread_id,
      event.run_id,event.sequence,event.type,event.actor_type,event.actor_id,
      event.payload_json,event.created_at
    FROM collaboration_events event JOIN collaboration_runs run ON run.id=event.run_id
    JOIN v7_thread_map map ON map.project_id=run.project_id;
  `);
  for (const table of [
    "collaboration_messages",
    "collaboration_attempts",
    "collaboration_model_calls",
    "collaboration_turns",
    "decision_requests",
    "collaboration_events",
  ]) notify(`copy-${table}`);

  for (const project of projects) {
    const threadId = legacyThreadId(project.id);
    const revisionId = policyRevisionId(project.id);
    const createdAt = projectTimes.get(project.id)!;
    const facts: FactSeed[] = [
      {
        actorId: null, actorType: "system", createdAt,
        id: factId("thread_created", threadId), messageId: null,
        payload: { title: "历史协作" }, policyRevisionId: null, rank: 0,
        runEventId: null, runId: null, sourceSequence: 0, type: "thread_created",
      },
      {
        actorId: null, actorType: "system", createdAt,
        id: factId("policy_changed", revisionId), messageId: null,
        payload: { policyVersion: 1 }, policyRevisionId: revisionId, rank: 1,
        runEventId: null, runId: null, sourceSequence: 0, type: "policy_changed",
      },
    ];
    const runs = database.prepare(`
      SELECT id,created_at AS createdAt FROM collaboration_runs
      WHERE project_id=? ORDER BY created_at,id
    `).all(project.id) as Array<{ createdAt: string; id: string }>;
    for (const run of runs) facts.push({
      actorId: null, actorType: "system", createdAt: run.createdAt,
      id: factId("run_linked", run.id), messageId: null, payload: { runId: run.id },
      policyRevisionId: null, rank: 2, runEventId: null, runId: run.id,
      sourceSequence: 0, type: "run_linked",
    });
    const messages = database.prepare(`
      SELECT id,run_id AS runId,author_type AS authorType,author_agent_id AS authorAgentId,
             sequence,created_at AS createdAt
      FROM collaboration_messages WHERE project_id=? ORDER BY sequence,id
    `).all(project.id) as Array<{
      authorAgentId: string | null; authorType: "owner" | "agent"; createdAt: string;
      id: string; runId: string | null; sequence: number;
    }>;
    for (const message of messages) {
      let event: {
        actorId: string | null; actorType: string; createdAt: string; id: string;
      } | undefined;
      if (message.runId) {
        event = database.prepare(`
          SELECT id,actor_type AS actorType,actor_id AS actorId,created_at AS createdAt
          FROM collaboration_events
          WHERE run_id=? AND type=? AND json_extract(payload_json,'$.messageId')=?
        `).get(message.runId, `${message.authorType}_message`, message.id) as typeof event;
        if (!event) throw new Error("SCHEMA_DATA_INVALID");
      }
      if (message.authorType === "agent" && message.runId !== null) {
        const linkedTurn = database.prepare(`
          SELECT attempt.status FROM collaboration_turns turn
          JOIN collaboration_attempts attempt ON attempt.id=turn.attempt_id
          WHERE turn.message_id=? AND turn.run_id=? AND attempt.status='committed'
        `).get(message.id, message.runId);
        if (!linkedTurn) throw new Error("SCHEMA_DATA_INVALID");
      }
      facts.push({
        actorId: event?.actorId ?? message.authorAgentId,
        actorType: event?.actorType ?? message.authorType,
        createdAt: event?.createdAt ?? message.createdAt,
        id: factId("message", message.id),
        messageId: message.id,
        payload: { messageId: message.id },
        policyRevisionId: null,
        rank: 3,
        runEventId: null,
        runId: message.runId,
        sourceSequence: message.sequence,
        type: `${message.authorType}_message`,
      });
    }
    const events = database.prepare(`
      SELECT event.id,event.run_id AS runId,event.sequence,event.type,
             event.actor_type AS actorType,event.actor_id AS actorId,event.created_at AS createdAt
      FROM collaboration_events event JOIN collaboration_runs run ON run.id=event.run_id
      WHERE run.project_id=? AND event.type NOT IN ('owner_message','agent_message')
      ORDER BY event.created_at,event.sequence,event.id
    `).all(project.id) as Array<{
      actorId: string | null; actorType: string; createdAt: string; id: string;
      runId: string; sequence: number; type: string;
    }>;
    for (const event of events) facts.push({
      actorId: event.actorId, actorType: event.actorType, createdAt: event.createdAt,
      id: factId("run_event", event.id), messageId: null,
      payload: { eventType: event.type }, policyRevisionId: null, rank: 4,
      runEventId: event.id, runId: event.runId, sourceSequence: event.sequence,
      type: "run_event",
    });
    facts.sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt)
      || left.rank - right.rank
      || left.sourceSequence - right.sourceSequence
      || compareUtf8(left.id, right.id));
    const insertFact = database.prepare(`
      INSERT INTO v7_collaboration_thread_facts(
        id,project_id,thread_id,sequence,activity_sequence,type,actor_type,actor_id,
        run_id,message_id,run_event_id,policy_revision_id,payload_json,created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    facts.forEach((fact, index) => insertFact.run(
      fact.id, project.id, threadId, index + 1, index + 1, fact.type,
      fact.actorType, fact.actorId, fact.runId, fact.messageId, fact.runEventId,
      fact.policyRevisionId, canonicalJson(fact.payload), fact.createdAt,
    ));
    database.prepare(`
      UPDATE v7_collaboration_threads SET next_fact_sequence=?,last_activity_sequence=?,
        updated_at=? WHERE project_id=? AND id=?
    `).run(facts.length + 1, facts.length, facts.at(-1)!.createdAt, project.id, threadId);
    database.prepare(`
      INSERT INTO v7_collaboration_project_thread_sequences(project_id,next_activity_sequence)
      VALUES (?,?)
    `).run(project.id, facts.length + 1);

    const createdFact = facts.find(({ type }) => type === "thread_created")!;
    const policyAvailability = database.prepare(`
      SELECT COUNT(*) AS count FROM v7_collaboration_thread_policy_members
      WHERE project_id=? AND thread_id=?
    `).get(project.id, threadId) as { count: number };
    const availability = policyAvailability.count >= 2 ? "ready" : "repair_required";
    const threadResponse = {
      created: true,
      fact: {
        activitySequence: facts.indexOf(createdFact) + 1,
        actorId: null,
        actorType: "system",
        createdAt: createdFact.createdAt,
        id: createdFact.id,
        message: null,
        messageId: null,
        payload: { title: "历史协作" },
        policyRevisionId: null,
        projectId: project.id,
        runEventId: null,
        runId: null,
        sequence: facts.indexOf(createdFact) + 1,
        threadId,
        type: "thread_created",
      },
      thread: {
        availability,
        createdAt,
        id: threadId,
        lastActivitySequence: facts.length,
        policy: {
          availability,
          createdAt,
          members: database.prepare(`
            SELECT agent_id AS agentId,agent_display_name AS displayNameSnapshot,
                   position,'current' AS live
            FROM v7_collaboration_thread_policy_members
            WHERE project_id=? AND thread_id=? ORDER BY position
          `).all(project.id, threadId),
          revisionId,
          unavailableMemberIds: [],
          version: 1,
        },
        policyVersion: 1,
        projectId: project.id,
        title: "历史协作",
        updatedAt: facts.at(-1)!.createdAt,
        version: 1,
      },
    };
    database.prepare(`
      UPDATE v7_collaboration_operations SET response_json=?
      WHERE project_id=? AND id=?
    `).run(canonicalJson(threadResponse), project.id, syntheticOperationId(project.id));
  }
  notify("map-facts");
  const updateReceipt = database.prepare(`
    UPDATE v7_collaboration_operations SET response_json=?
    WHERE project_id=? AND id=?
  `);
  for (const operation of operations) {
    if (operation.status !== "completed") continue;
    updateReceipt.run(
      convertReceipt(database, operation, legacyThreadId(operation.projectId)),
      operation.projectId,
      operation.id,
    );
  }
  notify("convert-receipts");
}

export function migrateV6ToV7(
  database: DatabaseSync,
  afterStep?: MigrationStepHook,
): void {
  const notify = (step: string) => afterStep?.(step, database);
  const foreignKeysEnabled = (
    database.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }
  ).foreign_keys === 1;
  const legacyAlterTableEnabled = (
    database.prepare("PRAGMA legacy_alter_table").get() as {
      legacy_alter_table: number;
    }
  ).legacy_alter_table === 1;
  let failed = false;
  let failure: unknown;
  let restorationFailure: unknown;
  try {
    database.exec("PRAGMA foreign_keys=OFF");
    database.exec("BEGIN IMMEDIATE");
    database.exec("PRAGMA defer_foreign_keys=ON");
    notify("precheck");
    for (const sql of renderV7("v7_").slice(0, V7_TABLE_SQL.size)) database.exec(sql);
    notify("create");
    copyLegacyData(database, afterStep);
    validateShadowData(database);
    notify("validate-shadow");

    for (const table of LEGACY_TABLES_CHILD_FIRST) {
      database.exec(`DROP TABLE "${table}"`);
      notify(`drop-${table}`);
    }
    for (const sql of V7_TABLE_SQL.values()) database.exec(sql);
    notify("create-final");
    for (const table of V7_TABLE_SQL.keys()) {
      database.exec(`INSERT INTO "${table}" SELECT * FROM "v7_${table}"`);
      notify(`copy-final-${table}`);
    }
    database.exec("PRAGMA legacy_alter_table=ON");
    database.exec("ALTER TABLE executions RENAME TO v6_executions");
    database.exec(V7_EXECUTIONS_SQL);
    database.exec(`
      INSERT INTO executions(
        id,project_id,source_collaboration_thread_id,source_collaboration_run_id,
        mission_id,work_item_id,agent_id,current_policy_revision_id,status,
        resume_target,reason_code,manual_recovery_required,recovery_resolution,
        current_attempt_no,business_round_count,tool_call_count,next_event_sequence,
        version,created_at,business_deadline_at,first_running_at,updated_at,merged_at
      )
      SELECT e.id,e.project_id,r.thread_id,e.source_collaboration_run_id,
             e.mission_id,e.work_item_id,e.agent_id,e.current_policy_revision_id,
             e.status,e.resume_target,e.reason_code,e.manual_recovery_required,
             e.recovery_resolution,e.current_attempt_no,e.business_round_count,
             e.tool_call_count,e.next_event_sequence,e.version,e.created_at,
             e.business_deadline_at,e.first_running_at,e.updated_at,e.merged_at
      FROM v6_executions e
      JOIN collaboration_runs r
        ON r.project_id=e.project_id AND r.id=e.source_collaboration_run_id
    `);
    database.exec("DROP TABLE v6_executions");
    for (const sql of V7_EXECUTION_INDEX_SQL.values()) database.exec(sql);
    database.exec("PRAGMA legacy_alter_table=OFF");
    notify("backfill-execution-source-tuples");
    for (const table of [...V7_TABLE_SQL.keys()].reverse()) {
      database.exec(`DROP TABLE "v7_${table}"`);
      notify(`drop-shadow-${table}`);
    }
    database.exec("DROP TABLE temp.v7_thread_map");
    for (const sql of V7_INDEX_TRIGGER_SQL.values()) database.exec(sql);
    notify("index-trigger");
    const validation = validateV7(database);
    if (validation) throw new Error(validation);
    notify("validate");
    notify("version");
    database.exec("PRAGMA user_version=7");
    database.exec("COMMIT");
  } catch (error) {
    failed = true;
    failure = error;
    if (database.isTransaction) {
      try {
        database.exec("ROLLBACK");
      } catch {
        if (database.isTransaction) {
          try {
            database.exec("ROLLBACK");
          } catch {
            // Preserve the original migration error; restoration below is best effort.
          }
        }
      }
    }
  } finally {
    try {
      database.exec(
        `PRAGMA legacy_alter_table=${legacyAlterTableEnabled ? "ON" : "OFF"}`,
      );
    } catch (error) {
      restorationFailure = error;
    }
    try {
      database.exec(`PRAGMA foreign_keys=${foreignKeysEnabled ? "ON" : "OFF"}`);
    } catch (error) {
      restorationFailure ??= error;
    }
  }
  if (failed) throw failure;
  if (restorationFailure) throw restorationFailure;
}
