import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  recoveryMergeFileStatusSchema,
  type RecoveryMergeFileStatus,
} from "@/src/shared/execution-contracts";

export const V5_TABLES = [
  "project_validation_policies","project_validation_policy_entries","executions",
  "execution_attempts","execution_actions","execution_operations",
  "project_validation_policy_revisions","project_validation_policy_audits",
  "execution_model_calls","execution_tool_calls","execution_approvals",
  "execution_validation_results","execution_validation_output_chunks",
  "execution_staged_results","execution_staged_observations","execution_staged_files",
  "execution_staged_blockers","execution_artifacts","execution_artifact_chunks",
  "execution_events","execution_merge_journals","execution_merge_files",
  "work_item_execution_results",
] as const;

export const V5_INDEXES = [
  "collaboration_runs_project_id_id","missions_project_id_id","work_items_mission_id_id",
  "execution_one_active_task","execution_one_active_agent","executions_project_status",
  "execution_one_acting_attempt","execution_actions_execution_status","execution_actions_expiry",
  "execution_one_running_action","execution_operation_one_running_action",
  "validation_policy_revisions_page","validation_policy_audits_page",
  "execution_one_pending_approval","execution_approvals_page","execution_validations_page",
  "staged_files_path_key","staged_observations_page","staged_blockers_page",
  "execution_artifacts_page","execution_one_project_merge","work_item_execution_results_item",
] as const;

export const V5_TRIGGERS = [
  "validation_policy_revision_no_update","validation_policy_revision_no_delete",
  "validation_policy_entry_no_update","validation_policy_entry_no_delete",
  "validation_policy_audit_no_update","validation_policy_audit_no_delete",
] as const;

export const CREATE_V5 = `
CREATE TABLE project_validation_policies(
 project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
 active_revision_id TEXT NOT NULL,
 version INTEGER NOT NULL CHECK(version>=1),
 updated_at TEXT NOT NULL CHECK(updated_at GLOB '????-??-??T??:??:??.???Z'),
 FOREIGN KEY(project_id,active_revision_id) REFERENCES project_validation_policy_revisions(project_id,id)
);
CREATE TABLE project_validation_policy_entries(
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL, revision_id TEXT NOT NULL,
 position INTEGER NOT NULL CHECK(position BETWEEN 0 AND 49),
 executable TEXT NOT NULL CHECK(length(CAST(executable AS BLOB)) BETWEEN 1 AND 4096),
 executable_identity TEXT NOT NULL CHECK(length(executable_identity)=64 AND executable_identity NOT GLOB '*[^0-9a-f]*'),
 args_json TEXT NOT NULL CHECK(json_valid(args_json) AND length(CAST(args_json AS BLOB))<=32768),
 workdir TEXT NOT NULL CHECK(length(CAST(workdir AS BLOB)) BETWEEN 1 AND 4096),
 required INTEGER NOT NULL CHECK(required IN (0,1)),
 tuple_hash TEXT NOT NULL CHECK(length(tuple_hash)=64 AND tuple_hash NOT GLOB '*[^0-9a-f]*'),
 UNIQUE(project_id,revision_id,position), UNIQUE(project_id,revision_id,id),
 FOREIGN KEY(project_id,revision_id) REFERENCES project_validation_policy_revisions(project_id,id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX collaboration_runs_project_id_id ON collaboration_runs(project_id,id);
CREATE UNIQUE INDEX missions_project_id_id ON missions(project_id,id);
CREATE UNIQUE INDEX work_items_mission_id_id ON work_items(mission_id,id);
CREATE TABLE executions(
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 source_collaboration_run_id TEXT NOT NULL, mission_id TEXT NOT NULL, work_item_id TEXT NOT NULL,
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
 FOREIGN KEY(project_id,source_collaboration_run_id) REFERENCES collaboration_runs(project_id,id),
 FOREIGN KEY(project_id,mission_id) REFERENCES missions(project_id,id),
 FOREIGN KEY(mission_id,work_item_id) REFERENCES work_items(mission_id,id),
 FOREIGN KEY(project_id,agent_id) REFERENCES project_memberships(project_id,agent_id),
 FOREIGN KEY(project_id,current_policy_revision_id) REFERENCES project_validation_policy_revisions(project_id,id),
 CHECK((manual_recovery_required=1 AND status='conflicted' AND recovery_resolution IS NULL) OR manual_recovery_required=0),
 CHECK((status='merged') = (merged_at IS NOT NULL)),
 CHECK((first_running_at IS NULL AND business_deadline_at IS NULL) OR (first_running_at IS NOT NULL AND business_deadline_at IS NOT NULL))
);
CREATE UNIQUE INDEX execution_one_active_task ON executions(work_item_id) WHERE status IN ('queued','running','waiting_approval','paused','staged');
CREATE UNIQUE INDEX execution_one_active_agent ON executions(agent_id) WHERE status IN ('queued','running','waiting_approval','paused','staged');
CREATE INDEX executions_project_status ON executions(project_id,status,created_at,id);
CREATE TABLE execution_attempts(
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL, execution_id TEXT NOT NULL,
 attempt_no INTEGER NOT NULL CHECK(attempt_no>=1),
 status TEXT NOT NULL CHECK(status IN ('preparing','ready','acting','interrupted','failed','superseded','completed')),
 sandbox_root TEXT NOT NULL CHECK(length(CAST(sandbox_root AS BLOB)) BETWEEN 1 AND 32767),
 baseline_manifest_path TEXT,
 sandbox_manifest_path TEXT,
 baseline_manifest_hash TEXT CHECK(baseline_manifest_hash IS NULL OR (length(baseline_manifest_hash)=64 AND baseline_manifest_hash NOT GLOB '*[^0-9a-f]*')),
 sandbox_manifest_hash TEXT CHECK(sandbox_manifest_hash IS NULL OR (length(sandbox_manifest_hash)=64 AND sandbox_manifest_hash NOT GLOB '*[^0-9a-f]*')),
 frozen_public_json TEXT NOT NULL CHECK(json_valid(frozen_public_json) AND length(CAST(frozen_public_json AS BLOB))<=2097152),
 frozen_private_json TEXT NOT NULL CHECK(json_valid(frozen_private_json) AND length(CAST(frozen_private_json AS BLOB))<=2097152),
 frozen_context_hash TEXT NOT NULL CHECK(length(frozen_context_hash)=64 AND frozen_context_hash NOT GLOB '*[^0-9a-f]*'),
 frozen_policy_revision_id TEXT NOT NULL, frozen_policy_version INTEGER NOT NULL CHECK(frozen_policy_version>=1),
 frozen_policy_hash TEXT NOT NULL CHECK(length(frozen_policy_hash)=64 AND frozen_policy_hash NOT GLOB '*[^0-9a-f]*'),
 started_at TEXT NOT NULL CHECK(started_at GLOB '????-??-??T??:??:??.???Z'),
 finished_at TEXT CHECK(finished_at IS NULL OR finished_at GLOB '????-??-??T??:??:??.???Z'),
 UNIQUE(execution_id,attempt_no), UNIQUE(project_id,execution_id,id),
 FOREIGN KEY(project_id,execution_id) REFERENCES executions(project_id,id) ON DELETE CASCADE,
 FOREIGN KEY(project_id,frozen_policy_revision_id) REFERENCES project_validation_policy_revisions(project_id,id)
);
CREATE UNIQUE INDEX execution_one_acting_attempt ON execution_attempts(execution_id) WHERE status='acting';
CREATE TABLE execution_actions(
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL, execution_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
 operation_id TEXT NOT NULL, action_index INTEGER NOT NULL CHECK(action_index BETWEEN 0 AND 15),
 kind TEXT NOT NULL CHECK(kind IN ('sandbox_build','model','file_list','file_read','file_write','command','stage_compute','merge_apply','merge_recover','manual_resolution')),
 status TEXT NOT NULL CHECK(status IN ('pending','running','succeeded','failed','interrupted','discarded')),
 request_hash TEXT NOT NULL CHECK(length(request_hash)=64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
 lease_token TEXT UNIQUE, lease_expires_at TEXT,
 overall_deadline_at TEXT NOT NULL CHECK(overall_deadline_at GLOB '????-??-??T??:??:??.???Z'),
 last_heartbeat_at TEXT,
 result_json TEXT CHECK(result_json IS NULL OR (json_valid(result_json) AND length(CAST(result_json AS BLOB))<=262144)),
 error_code TEXT, created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z'),
 started_at TEXT CHECK(started_at IS NULL OR started_at GLOB '????-??-??T??:??:??.???Z'),
 finished_at TEXT CHECK(finished_at IS NULL OR finished_at GLOB '????-??-??T??:??:??.???Z'),
 UNIQUE(project_id,id), UNIQUE(project_id,execution_id,id), UNIQUE(project_id,execution_id,attempt_id,id),
 UNIQUE(project_id,operation_id,id), UNIQUE(project_id,operation_id,action_index),
 FOREIGN KEY(project_id,execution_id,attempt_id) REFERENCES execution_attempts(project_id,execution_id,id) ON DELETE CASCADE,
 FOREIGN KEY(project_id,operation_id,execution_id) REFERENCES execution_operations(project_id,id,execution_id) ON DELETE CASCADE,
 CHECK((status='running' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL) OR (status<>'running' AND lease_token IS NULL AND lease_expires_at IS NULL)),
 CHECK(lease_expires_at IS NULL OR lease_expires_at GLOB '????-??-??T??:??:??.???Z'),
 CHECK(last_heartbeat_at IS NULL OR last_heartbeat_at GLOB '????-??-??T??:??:??.???Z')
);
CREATE INDEX execution_actions_execution_status ON execution_actions(execution_id,status,created_at,id);
CREATE INDEX execution_actions_expiry ON execution_actions(project_id,status,lease_expires_at,id);
CREATE UNIQUE INDEX execution_one_running_action ON execution_actions(execution_id) WHERE status='running';
CREATE UNIQUE INDEX execution_operation_one_running_action ON execution_actions(project_id,operation_id) WHERE status='running';
CREATE TABLE execution_operations(
 id TEXT NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, execution_id TEXT,
 kind TEXT NOT NULL CHECK(kind IN ('start','start_resume','advance','approve','reject','revoke','replace_request','pause','continue','retry','stop','stage','merge','resolve_manual','policy_update','recover')),
 request_hash TEXT NOT NULL CHECK(length(request_hash)=64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
 has_external_actions INTEGER NOT NULL CHECK(has_external_actions IN (0,1)),
 action_count INTEGER NOT NULL DEFAULT 0 CHECK(action_count BETWEEN 0 AND 16),
 final_action_index INTEGER CHECK(final_action_index IS NULL OR final_action_index BETWEEN 0 AND 15),
 status TEXT NOT NULL CHECK(status IN ('pending','completed')), http_status INTEGER,
 response_json TEXT CHECK(response_json IS NULL OR (json_valid(response_json) AND length(CAST(response_json AS BLOB))<=262144)),
 created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z'),
 updated_at TEXT NOT NULL CHECK(updated_at GLOB '????-??-??T??:??:??.???Z'),
 PRIMARY KEY(project_id,id), UNIQUE(project_id,id,execution_id),
 FOREIGN KEY(project_id,execution_id) REFERENCES executions(project_id,id) ON DELETE CASCADE,
 CHECK((status='pending' AND http_status IS NULL AND response_json IS NULL) OR (status='completed' AND http_status BETWEEN 100 AND 599 AND response_json IS NOT NULL)),
 CHECK((has_external_actions=0 AND action_count=0 AND final_action_index IS NULL) OR (has_external_actions=1 AND action_count>=1)),
 CHECK(status<>'completed' OR has_external_actions=0 OR final_action_index=action_count-1)
);
CREATE TABLE project_validation_policy_revisions(
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 created_operation_id TEXT, created_actor_type TEXT NOT NULL CHECK(created_actor_type IN ('system','owner')),
 revision_no INTEGER NOT NULL CHECK(revision_no>=1),
 policy_hash TEXT NOT NULL CHECK(length(policy_hash)=64 AND policy_hash NOT GLOB '*[^0-9a-f]*'),
 classifier_version INTEGER NOT NULL CHECK(classifier_version>=1),
 warning_accepted INTEGER NOT NULL CHECK(warning_accepted IN (0,1)),
 canonical_bytes INTEGER NOT NULL CHECK(canonical_bytes BETWEEN 2 AND 65536),
 entry_count INTEGER NOT NULL CHECK(entry_count BETWEEN 0 AND 50),
 created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z'),
 UNIQUE(project_id,id), UNIQUE(project_id,revision_no), UNIQUE(project_id,policy_hash,revision_no),
 FOREIGN KEY(project_id,created_operation_id) REFERENCES execution_operations(project_id,id),
 CHECK((created_actor_type='system' AND revision_no=1 AND created_operation_id IS NULL AND warning_accepted=0) OR (created_actor_type='owner' AND created_operation_id IS NOT NULL AND warning_accepted=1))
);
CREATE INDEX validation_policy_revisions_page ON project_validation_policy_revisions(project_id,revision_no,id);
CREATE TABLE project_validation_policy_audits(
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 operation_id TEXT NOT NULL, sequence INTEGER NOT NULL CHECK(sequence>=1),
 actor_type TEXT NOT NULL CHECK(actor_type='owner'), outcome TEXT NOT NULL CHECK(outcome IN ('saved','rejected')),
 before_revision_id TEXT NOT NULL, after_revision_id TEXT,
 before_policy_hash TEXT NOT NULL CHECK(length(before_policy_hash)=64 AND before_policy_hash NOT GLOB '*[^0-9a-f]*'),
 after_policy_hash TEXT CHECK(after_policy_hash IS NULL OR (length(after_policy_hash)=64 AND after_policy_hash NOT GLOB '*[^0-9a-f]*')),
 public_change_json TEXT NOT NULL CHECK(json_valid(public_change_json) AND length(CAST(public_change_json AS BLOB))<=65536),
 warning_accepted INTEGER NOT NULL CHECK(warning_accepted IN (0,1)),
 created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z'),
 UNIQUE(project_id,sequence),
 FOREIGN KEY(project_id,operation_id) REFERENCES execution_operations(project_id,id),
 FOREIGN KEY(project_id,before_revision_id) REFERENCES project_validation_policy_revisions(project_id,id),
 FOREIGN KEY(project_id,after_revision_id) REFERENCES project_validation_policy_revisions(project_id,id),
 CHECK((outcome='saved' AND after_revision_id IS NOT NULL AND after_policy_hash IS NOT NULL AND warning_accepted=1) OR (outcome='rejected' AND after_policy_hash IS NULL AND after_revision_id IS NULL))
);
CREATE INDEX validation_policy_audits_page ON project_validation_policy_audits(project_id,sequence,id);
CREATE TRIGGER validation_policy_revision_no_update BEFORE UPDATE ON project_validation_policy_revisions BEGIN SELECT RAISE(ABORT,'IMMUTABLE_POLICY_REVISION'); END;
CREATE TRIGGER validation_policy_revision_no_delete BEFORE DELETE ON project_validation_policy_revisions WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id) BEGIN SELECT RAISE(ABORT,'IMMUTABLE_POLICY_REVISION'); END;
CREATE TRIGGER validation_policy_entry_no_update BEFORE UPDATE ON project_validation_policy_entries BEGIN SELECT RAISE(ABORT,'IMMUTABLE_POLICY_ENTRY'); END;
CREATE TRIGGER validation_policy_entry_no_delete BEFORE DELETE ON project_validation_policy_entries WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id) BEGIN SELECT RAISE(ABORT,'IMMUTABLE_POLICY_ENTRY'); END;
CREATE TRIGGER validation_policy_audit_no_update BEFORE UPDATE ON project_validation_policy_audits BEGIN SELECT RAISE(ABORT,'IMMUTABLE_POLICY_AUDIT'); END;
CREATE TRIGGER validation_policy_audit_no_delete BEFORE DELETE ON project_validation_policy_audits WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id) BEGIN SELECT RAISE(ABORT,'IMMUTABLE_POLICY_AUDIT'); END;
CREATE TABLE execution_model_calls(
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL, execution_id TEXT NOT NULL, attempt_id TEXT NOT NULL, action_id TEXT NOT NULL,
 business_round INTEGER NOT NULL CHECK(business_round>=1), kind TEXT NOT NULL CHECK(kind IN ('primary','repair')),
 call_index INTEGER NOT NULL CHECK(call_index IN (1,2)),
 status TEXT NOT NULL CHECK(status IN ('calling','succeeded','provider_failed','response_invalid','usage_invalid','interrupted','discarded')),
 prompt_hash TEXT NOT NULL CHECK(length(prompt_hash)=64 AND prompt_hash NOT GLOB '*[^0-9a-f]*'),
 prompt_tokens INTEGER CHECK(prompt_tokens IS NULL OR prompt_tokens>=0), completion_tokens INTEGER CHECK(completion_tokens IS NULL OR completion_tokens>=0),
 total_tokens INTEGER CHECK(total_tokens IS NULL OR total_tokens>=0), error_category TEXT,
 call_started_at TEXT NOT NULL CHECK(call_started_at GLOB '????-??-??T??:??:??.???Z'),
 call_deadline_at TEXT NOT NULL CHECK(call_deadline_at GLOB '????-??-??T??:??:??.???Z'),
 finished_at TEXT CHECK(finished_at IS NULL OR finished_at GLOB '????-??-??T??:??:??.???Z'),
 created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z'),
 UNIQUE(action_id,call_index), UNIQUE(attempt_id,business_round,call_index),
 FOREIGN KEY(project_id,execution_id,attempt_id,action_id) REFERENCES execution_actions(project_id,execution_id,attempt_id,id) ON DELETE CASCADE,
 CHECK(total_tokens IS NULL OR total_tokens=prompt_tokens+completion_tokens),
 CHECK((status='calling' AND finished_at IS NULL) OR (status<>'calling' AND finished_at IS NOT NULL))
);
CREATE TABLE execution_tool_calls(
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL, execution_id TEXT NOT NULL, attempt_id TEXT NOT NULL, action_id TEXT UNIQUE,
 business_round INTEGER NOT NULL CHECK(business_round>=1), type TEXT NOT NULL CHECK(type IN ('list','read','write','command')),
 request_hash TEXT NOT NULL CHECK(length(request_hash)=64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
 status TEXT NOT NULL CHECK(status IN ('requested','waiting_approval','succeeded','rejected','failed','interrupted','discarded')),
 error_code TEXT,
 public_request_json TEXT NOT NULL CHECK(json_valid(public_request_json) AND length(CAST(public_request_json AS BLOB))<=131072),
 public_result_json TEXT CHECK(public_result_json IS NULL OR (json_valid(public_result_json) AND length(CAST(public_result_json AS BLOB))<=2097152)),
 before_sandbox_hash TEXT CHECK(before_sandbox_hash IS NULL OR (length(before_sandbox_hash)=64 AND before_sandbox_hash NOT GLOB '*[^0-9a-f]*')),
 after_sandbox_hash TEXT CHECK(after_sandbox_hash IS NULL OR (length(after_sandbox_hash)=64 AND after_sandbox_hash NOT GLOB '*[^0-9a-f]*')),
 started_at TEXT NOT NULL CHECK(started_at GLOB '????-??-??T??:??:??.???Z'),
 finished_at TEXT CHECK(finished_at IS NULL OR finished_at GLOB '????-??-??T??:??:??.???Z'),
 UNIQUE(attempt_id,business_round), UNIQUE(project_id,execution_id,attempt_id,id),
 FOREIGN KEY(project_id,execution_id,attempt_id) REFERENCES execution_attempts(project_id,execution_id,id) ON DELETE CASCADE,
 FOREIGN KEY(project_id,execution_id,attempt_id,action_id) REFERENCES execution_actions(project_id,execution_id,attempt_id,id),
 CHECK((type='command' AND action_id IS NULL) OR action_id IS NOT NULL)
);
CREATE TABLE execution_approvals(
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL, execution_id TEXT NOT NULL, attempt_id TEXT NOT NULL, tool_call_id TEXT,
 kind TEXT NOT NULL CHECK(kind IN ('command','staged_merge')),
 status TEXT NOT NULL CHECK(status IN ('pending','approved','consumed','rejected','revoked','replaced','expired')),
 request_hash TEXT NOT NULL CHECK(length(request_hash)=64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
 input_hash TEXT NOT NULL CHECK(length(input_hash)=64 AND input_hash NOT GLOB '*[^0-9a-f]*'),
 staged_hash TEXT CHECK(staged_hash IS NULL OR (length(staged_hash)=64 AND staged_hash NOT GLOB '*[^0-9a-f]*')),
 public_request_json TEXT NOT NULL CHECK(json_valid(public_request_json) AND length(CAST(public_request_json AS BLOB))<=131072),
 decided_at TEXT CHECK(decided_at IS NULL OR decided_at GLOB '????-??-??T??:??:??.???Z'),
 consumed_at TEXT CHECK(consumed_at IS NULL OR consumed_at GLOB '????-??-??T??:??:??.???Z'),
 created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z'),
 FOREIGN KEY(project_id,execution_id,attempt_id) REFERENCES execution_attempts(project_id,execution_id,id) ON DELETE CASCADE,
 FOREIGN KEY(project_id,execution_id,attempt_id,tool_call_id) REFERENCES execution_tool_calls(project_id,execution_id,attempt_id,id),
 CHECK((kind='command')=(tool_call_id IS NOT NULL)), CHECK((kind='staged_merge')=(staged_hash IS NOT NULL))
);
CREATE UNIQUE INDEX execution_one_pending_approval ON execution_approvals(execution_id) WHERE status IN ('pending','approved');
CREATE INDEX execution_approvals_page ON execution_approvals(execution_id,created_at,id);
CREATE TABLE execution_validation_results(
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL, execution_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
 policy_revision_id TEXT NOT NULL, policy_entry_id TEXT NOT NULL, tool_call_id TEXT NOT NULL UNIQUE,
 sandbox_manifest_hash TEXT NOT NULL CHECK(length(sandbox_manifest_hash)=64 AND sandbox_manifest_hash NOT GLOB '*[^0-9a-f]*'),
 required INTEGER NOT NULL CHECK(required IN (0,1)), exit_code INTEGER NOT NULL, succeeded INTEGER NOT NULL CHECK(succeeded IN (0,1)),
 stdout_bytes INTEGER NOT NULL CHECK(stdout_bytes BETWEEN 0 AND 1048576), stderr_bytes INTEGER NOT NULL CHECK(stderr_bytes BETWEEN 0 AND 1048576),
 stdout_sha256 TEXT NOT NULL CHECK(length(stdout_sha256)=64 AND stdout_sha256 NOT GLOB '*[^0-9a-f]*'),
 stderr_sha256 TEXT NOT NULL CHECK(length(stderr_sha256)=64 AND stderr_sha256 NOT GLOB '*[^0-9a-f]*'),
 stdout_truncated INTEGER NOT NULL CHECK(stdout_truncated IN (0,1)), stderr_truncated INTEGER NOT NULL CHECK(stderr_truncated IN (0,1)),
 finished_at TEXT NOT NULL CHECK(finished_at GLOB '????-??-??T??:??:??.???Z'),
 UNIQUE(execution_id,policy_entry_id,sandbox_manifest_hash),
 FOREIGN KEY(project_id,execution_id,attempt_id) REFERENCES execution_attempts(project_id,execution_id,id) ON DELETE CASCADE,
 FOREIGN KEY(project_id,execution_id,attempt_id,tool_call_id) REFERENCES execution_tool_calls(project_id,execution_id,attempt_id,id),
 FOREIGN KEY(project_id,policy_revision_id,policy_entry_id) REFERENCES project_validation_policy_entries(project_id,revision_id,id)
);
CREATE INDEX execution_validations_page ON execution_validation_results(execution_id,finished_at,id);
CREATE TABLE execution_validation_output_chunks(
 validation_id TEXT NOT NULL REFERENCES execution_validation_results(id) ON DELETE CASCADE,
 stream TEXT NOT NULL CHECK(stream IN ('stdout','stderr')), chunk_index INTEGER NOT NULL CHECK(chunk_index BETWEEN 0 AND 16),
 byte_offset INTEGER NOT NULL CHECK(byte_offset BETWEEN 0 AND 1048575), byte_length INTEGER NOT NULL CHECK(byte_length BETWEEN 1 AND 65536),
 text TEXT NOT NULL CHECK(length(CAST(text AS BLOB))=byte_length),
 sha256 TEXT NOT NULL CHECK(length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
 PRIMARY KEY(validation_id,stream,chunk_index), UNIQUE(validation_id,stream,byte_offset)
);
CREATE TABLE execution_staged_results(
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL, execution_id TEXT NOT NULL, attempt_id TEXT NOT NULL UNIQUE, action_id TEXT NOT NULL UNIQUE,
 baseline_manifest_hash TEXT NOT NULL CHECK(length(baseline_manifest_hash)=64 AND baseline_manifest_hash NOT GLOB '*[^0-9a-f]*'),
 sandbox_manifest_hash TEXT NOT NULL CHECK(length(sandbox_manifest_hash)=64 AND sandbox_manifest_hash NOT GLOB '*[^0-9a-f]*'),
 context_hash TEXT NOT NULL CHECK(length(context_hash)=64 AND context_hash NOT GLOB '*[^0-9a-f]*'),
 policy_hash TEXT NOT NULL CHECK(length(policy_hash)=64 AND policy_hash NOT GLOB '*[^0-9a-f]*'),
 staged_hash TEXT NOT NULL UNIQUE CHECK(length(staged_hash)=64 AND staged_hash NOT GLOB '*[^0-9a-f]*'),
 observed_path_count INTEGER NOT NULL CHECK(observed_path_count BETWEEN 1 AND 100000),
 observed_final_bytes INTEGER NOT NULL CHECK(observed_final_bytes BETWEEN 0 AND 9007199254740991),
 merge_file_count INTEGER NOT NULL CHECK(merge_file_count BETWEEN 0 AND 100),
 merge_final_bytes INTEGER NOT NULL CHECK(merge_final_bytes BETWEEN 0 AND 10485760),
 blocker_count INTEGER NOT NULL CHECK(blocker_count BETWEEN 0 AND 100000),
 classification TEXT NOT NULL CHECK(classification IN ('auto_eligible','approval_required','blocked')),
 block_reasons_json TEXT NOT NULL CHECK(json_valid(block_reasons_json) AND length(CAST(block_reasons_json AS BLOB))<=65536),
 created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z'),
 UNIQUE(project_id,execution_id,id), UNIQUE(project_id,execution_id,attempt_id,id),
 FOREIGN KEY(project_id,execution_id,attempt_id,action_id) REFERENCES execution_actions(project_id,execution_id,attempt_id,id) ON DELETE CASCADE
);
CREATE TABLE execution_staged_observations(
 id TEXT PRIMARY KEY, staged_result_id TEXT NOT NULL REFERENCES execution_staged_results(id) ON DELETE CASCADE,
 position INTEGER NOT NULL CHECK(position BETWEEN 0 AND 99999),
 path TEXT NOT NULL CHECK(length(CAST(path AS BLOB)) BETWEEN 1 AND 4096),
 path_key TEXT NOT NULL CHECK(length(CAST(path_key AS BLOB)) BETWEEN 1 AND 4096),
 kind TEXT NOT NULL CHECK(kind IN ('added','modified','deleted','renamed','binary','permission','special')),
 baseline_hash TEXT CHECK(baseline_hash IS NULL OR (length(baseline_hash)=64 AND baseline_hash NOT GLOB '*[^0-9a-f]*')),
 observed_hash TEXT CHECK(observed_hash IS NULL OR (length(observed_hash)=64 AND observed_hash NOT GLOB '*[^0-9a-f]*')),
 final_size INTEGER NOT NULL CHECK(final_size BETWEEN 0 AND 9007199254740991),
 diff_text TEXT CHECK(diff_text IS NULL OR length(CAST(diff_text AS BLOB))<=262144),
 diff_bytes INTEGER NOT NULL CHECK(diff_bytes BETWEEN 0 AND 262144), diff_truncated INTEGER NOT NULL CHECK(diff_truncated IN (0,1)),
 UNIQUE(staged_result_id,position), UNIQUE(staged_result_id,path_key), UNIQUE(staged_result_id,id),
 CHECK((diff_text IS NULL AND diff_bytes=0) OR (diff_text IS NOT NULL AND length(CAST(diff_text AS BLOB))=diff_bytes))
);
CREATE TABLE execution_staged_files(
 id TEXT PRIMARY KEY, staged_result_id TEXT NOT NULL REFERENCES execution_staged_results(id) ON DELETE CASCADE,
 observation_id TEXT NOT NULL, position INTEGER NOT NULL CHECK(position BETWEEN 0 AND 99),
 path TEXT NOT NULL, path_key TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('added','modified')),
 baseline_hash TEXT CHECK(baseline_hash IS NULL OR (length(baseline_hash)=64 AND baseline_hash NOT GLOB '*[^0-9a-f]*')),
 staged_hash TEXT NOT NULL CHECK(length(staged_hash)=64 AND staged_hash NOT GLOB '*[^0-9a-f]*'),
 size INTEGER NOT NULL CHECK(size BETWEEN 0 AND 1048576),
 UNIQUE(staged_result_id,position), UNIQUE(staged_result_id,path_key), UNIQUE(staged_result_id,observation_id),
 FOREIGN KEY(staged_result_id,observation_id) REFERENCES execution_staged_observations(staged_result_id,id)
);
CREATE INDEX staged_files_path_key ON execution_staged_files(path_key,staged_result_id);
CREATE TABLE execution_staged_blockers(
 staged_result_id TEXT NOT NULL REFERENCES execution_staged_results(id) ON DELETE CASCADE, observation_id TEXT NOT NULL,
 position INTEGER NOT NULL CHECK(position BETWEEN 0 AND 99999),
 path TEXT NOT NULL CHECK(length(CAST(path AS BLOB)) BETWEEN 1 AND 4096),
 kind TEXT NOT NULL CHECK(kind IN ('deleted','renamed','binary','permission','special','file_size_limit','file_count_limit','byte_limit')),
 detail_json TEXT NOT NULL CHECK(json_valid(detail_json) AND length(CAST(detail_json AS BLOB))<=4096),
 PRIMARY KEY(staged_result_id,position), UNIQUE(staged_result_id,observation_id),
 FOREIGN KEY(staged_result_id,observation_id) REFERENCES execution_staged_observations(staged_result_id,id)
);
CREATE INDEX staged_observations_page ON execution_staged_observations(staged_result_id,position,id);
CREATE INDEX staged_blockers_page ON execution_staged_blockers(staged_result_id,position,observation_id);
CREATE TABLE execution_artifacts(
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL, execution_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
 name TEXT NOT NULL CHECK(length(CAST(name AS BLOB)) BETWEEN 1 AND 255),
 path TEXT NOT NULL CHECK(length(CAST(path AS BLOB)) BETWEEN 1 AND 4096),
 content_bytes INTEGER NOT NULL CHECK(content_bytes BETWEEN 0 AND 1048576),
 sha256 TEXT NOT NULL CHECK(length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
 truncated INTEGER NOT NULL CHECK(truncated IN (0,1)),
 created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z'),
 FOREIGN KEY(project_id,execution_id,attempt_id) REFERENCES execution_attempts(project_id,execution_id,id) ON DELETE CASCADE
);
CREATE INDEX execution_artifacts_page ON execution_artifacts(execution_id,created_at,id);
CREATE TABLE execution_artifact_chunks(
 artifact_id TEXT NOT NULL REFERENCES execution_artifacts(id) ON DELETE CASCADE,
 chunk_index INTEGER NOT NULL CHECK(chunk_index BETWEEN 0 AND 16),
 byte_offset INTEGER NOT NULL CHECK(byte_offset BETWEEN 0 AND 1048575),
 byte_length INTEGER NOT NULL CHECK(byte_length BETWEEN 1 AND 65536),
 text TEXT NOT NULL CHECK(length(CAST(text AS BLOB))=byte_length),
 sha256 TEXT NOT NULL CHECK(length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
 PRIMARY KEY(artifact_id,chunk_index), UNIQUE(artifact_id,byte_offset)
);
CREATE TABLE execution_events(
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL, execution_id TEXT NOT NULL,
 sequence INTEGER NOT NULL CHECK(sequence>=1), attempt_no INTEGER NOT NULL CHECK(attempt_no>=1),
 type TEXT NOT NULL, actor_type TEXT NOT NULL CHECK(actor_type IN ('owner','agent','system')), actor_id TEXT,
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json) AND length(CAST(payload_json AS BLOB))<=65536),
 created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z'),
 UNIQUE(execution_id,sequence),
 FOREIGN KEY(project_id,execution_id) REFERENCES executions(project_id,id) ON DELETE CASCADE
);
CREATE TABLE execution_merge_journals(
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL, execution_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
 staged_result_id TEXT NOT NULL UNIQUE, merge_action_id TEXT NOT NULL UNIQUE, operation_id TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('prepared','applying','db_committed','rolling_back','rolling_forward','manual_recovery','completed','resolved_old','resolved_new','abandoned')),
 next_file_position INTEGER NOT NULL DEFAULT 0 CHECK(next_file_position>=0),
 old_manifest_hash TEXT NOT NULL CHECK(length(old_manifest_hash)=64 AND old_manifest_hash NOT GLOB '*[^0-9a-f]*'),
 post_manifest_hash TEXT NOT NULL CHECK(length(post_manifest_hash)=64 AND post_manifest_hash NOT GLOB '*[^0-9a-f]*'),
 observed_manifest_hash TEXT CHECK(observed_manifest_hash IS NULL OR (length(observed_manifest_hash)=64 AND observed_manifest_hash NOT GLOB '*[^0-9a-f]*')),
 mismatch_phase TEXT, mismatch_path_key TEXT,
 journal_root TEXT NOT NULL CHECK(length(CAST(journal_root AS BLOB)) BETWEEN 1 AND 32767), error_code TEXT,
 created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z'),
 updated_at TEXT NOT NULL CHECK(updated_at GLOB '????-??-??T??:??:??.???Z'),
 UNIQUE(project_id,id),
 FOREIGN KEY(project_id,execution_id,attempt_id,staged_result_id) REFERENCES execution_staged_results(project_id,execution_id,attempt_id,id),
 FOREIGN KEY(project_id,execution_id,attempt_id,merge_action_id) REFERENCES execution_actions(project_id,execution_id,attempt_id,id),
 FOREIGN KEY(project_id,operation_id) REFERENCES execution_operations(project_id,id),
 FOREIGN KEY(project_id,operation_id,merge_action_id) REFERENCES execution_actions(project_id,operation_id,id),
 CHECK(status<>'manual_recovery' OR observed_manifest_hash IS NOT NULL)
);
CREATE UNIQUE INDEX execution_one_project_merge ON execution_merge_journals(project_id) WHERE status IN ('prepared','applying','db_committed','rolling_back','rolling_forward','manual_recovery');
CREATE TABLE execution_merge_files(
 journal_id TEXT NOT NULL REFERENCES execution_merge_journals(id) ON DELETE CASCADE,
 position INTEGER NOT NULL CHECK(position>=0),
 path TEXT NOT NULL CHECK(length(CAST(path AS BLOB)) BETWEEN 1 AND 4096),
 path_key TEXT NOT NULL CHECK(length(CAST(path_key AS BLOB)) BETWEEN 1 AND 4096),
 old_target_ref_json TEXT NOT NULL CHECK(json_valid(old_target_ref_json) AND length(CAST(old_target_ref_json AS BLOB))<=16384),
 post_target_ref_json TEXT CHECK(post_target_ref_json IS NULL OR (json_valid(post_target_ref_json) AND length(CAST(post_target_ref_json AS BLOB))<=16384)),
 backup_ref_json TEXT CHECK(backup_ref_json IS NULL OR (json_valid(backup_ref_json) AND length(CAST(backup_ref_json AS BLOB))<=16384)),
 durable_new_ref_json TEXT NOT NULL CHECK(json_valid(durable_new_ref_json) AND length(CAST(durable_new_ref_json AS BLOB))<=16384),
 canonical_temp_locator_json TEXT NOT NULL CHECK(json_valid(canonical_temp_locator_json) AND length(CAST(canonical_temp_locator_json AS BLOB))<=8192),
 canonical_temp_ref_json TEXT CHECK(canonical_temp_ref_json IS NULL OR (json_valid(canonical_temp_ref_json) AND length(CAST(canonical_temp_ref_json AS BLOB))<=16384)),
 status TEXT NOT NULL CHECK(status IN ('pending','temp_ready','applied','rolled_back','rolled_forward','verified')),
 PRIMARY KEY(journal_id,position), UNIQUE(journal_id,path_key),
 CHECK((status='pending' AND canonical_temp_ref_json IS NULL AND post_target_ref_json IS NULL)
    OR (status<>'pending' AND canonical_temp_ref_json IS NOT NULL AND post_target_ref_json IS NOT NULL))
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
`;

function normalizeSql(sql: string): string {
  return sql.replace(/;\s*$/, "").replace(/\s+/g, " ").trim().toLowerCase();
}

const expectedSql = new Map<string, string>();
for (const statement of CREATE_V5.split(/;\s*(?=CREATE|$)/i).map((sql) => sql.trim()).filter(Boolean)) {
  const match = statement.match(/^CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX|TRIGGER)\s+([^\s(]+)/i);
  if (match) expectedSql.set(match[1], normalizeSql(statement));
}

function objectRows(database: DatabaseSync): Array<{ name: string; sql: string | null; type: string }> {
  return database
    .prepare(`SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'`)
    .all() as Array<{ name: string; sql: string | null; type: string }>;
}

export function hasAnyV5Object(database: DatabaseSync): boolean {
  const wanted = new Set<string>([...V5_TABLES, ...V5_INDEXES, ...V5_TRIGGERS]);
  return objectRows(database).some(({ name }) => wanted.has(name));
}

export function createV5(database: DatabaseSync): void {
  database.exec(CREATE_V5);
  const hash = createHash("sha256").update("[]").digest("hex");
  const projects = database.prepare("SELECT id FROM projects ORDER BY id").all() as Array<{ id: string }>;
  const insertRevision = database.prepare(`
    INSERT INTO project_validation_policy_revisions(
      id,project_id,created_operation_id,created_actor_type,revision_no,policy_hash,
      classifier_version,warning_accepted,canonical_bytes,entry_count,created_at
    ) VALUES (?,?,NULL,'system',1,?,1,0,2,0,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  `);
  const insertPointer = database.prepare(`
    INSERT INTO project_validation_policies(project_id,active_revision_id,version,updated_at)
    VALUES (?,?,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  `);
  for (const { id } of projects) {
    const revisionId = `system-empty-policy:${id}`;
    insertRevision.run(revisionId, id, hash);
    insertPointer.run(id, revisionId);
  }
}

function schemaIsExact(database: DatabaseSync, retained = false): boolean {
  const expectedNames = new Set<string>([...V5_TABLES, ...V5_INDEXES, ...V5_TRIGGERS]);
  if (retained) {
    expectedNames.delete("work_item_execution_results");
    expectedNames.delete("work_item_execution_results_item");
  }
  const rows = objectRows(database).filter(({ name }) => expectedNames.has(name));
  if (rows.length !== expectedNames.size) return false;
  return rows.every(({ name, sql }) => sql !== null && normalizeSql(sql) === expectedSql.get(name));
}

function scalar(database: DatabaseSync, sql: string): number {
  return (database.prepare(sql).get() as { count: number }).count;
}

function validChunkSet(
  headerBytes: number,
  headerHash: string,
  chunks: Array<{
    byteLength: number;
    byteOffset: number;
    chunkIndex: number;
    sha256: string;
    text: string;
  }>,
): boolean {
  if (chunks.length > 17) return false;
  if (headerBytes === 0 && chunks.length === 0) return true;
  let offset = 0;
  let text = "";
  for (const [index, chunk] of chunks.entries()) {
    const bytes = Buffer.byteLength(chunk.text, "utf8");
    if (
      chunk.chunkIndex !== index
      || chunk.byteOffset !== offset
      || chunk.byteLength !== bytes
      || bytes < 1
      || bytes > 65_536
      || createHash("sha256").update(chunk.text, "utf8").digest("hex") !== chunk.sha256
    ) return false;
    offset += bytes;
    text += chunk.text;
  }
  return offset === headerBytes
    && headerBytes > 0
    && chunks.length > 0
    && createHash("sha256").update(text, "utf8").digest("hex") === headerHash;
}

function chunkFactsAreValid(database: DatabaseSync): boolean {
  const artifacts = database.prepare(`
    SELECT id,content_bytes AS bytes,sha256 FROM execution_artifacts
  `).all() as Array<{ bytes: number; id: string; sha256: string }>;
  const artifactChunks = database.prepare(`
    SELECT chunk_index AS chunkIndex,byte_offset AS byteOffset,
           byte_length AS byteLength,text,sha256
    FROM execution_artifact_chunks WHERE artifact_id=? ORDER BY chunk_index
  `);
  for (const artifact of artifacts) {
    if (!validChunkSet(
      artifact.bytes,
      artifact.sha256,
      artifactChunks.all(artifact.id) as Parameters<typeof validChunkSet>[2],
    )) return false;
  }

  const validations = database.prepare(`
    SELECT id,stdout_bytes AS stdoutBytes,stdout_sha256 AS stdoutHash,
           stderr_bytes AS stderrBytes,stderr_sha256 AS stderrHash
    FROM execution_validation_results
  `).all() as Array<{
    id: string;
    stderrBytes: number;
    stderrHash: string;
    stdoutBytes: number;
    stdoutHash: string;
  }>;
  const validationChunks = database.prepare(`
    SELECT chunk_index AS chunkIndex,byte_offset AS byteOffset,
           byte_length AS byteLength,text,sha256
    FROM execution_validation_output_chunks
    WHERE validation_id=? AND stream=? ORDER BY chunk_index
  `);
  for (const validation of validations) {
    if (
      !validChunkSet(
        validation.stdoutBytes,
        validation.stdoutHash,
        validationChunks.all(validation.id, "stdout") as Parameters<typeof validChunkSet>[2],
      )
      || !validChunkSet(
        validation.stderrBytes,
        validation.stderrHash,
        validationChunks.all(validation.id, "stderr") as Parameters<typeof validChunkSet>[2],
      )
    ) return false;
  }
  return true;
}

export function mergeDescriptorFactsAreValid(database: DatabaseSync): boolean {
  const rows = database.prepare(`
    SELECT f.path,f.old_target_ref_json AS oldTargetJson,
           f.post_target_ref_json AS postTargetJson,f.backup_ref_json AS backupRefJson,
           f.durable_new_ref_json AS durableNewRefJson,
           f.canonical_temp_locator_json AS tempLocatorJson,
           f.canonical_temp_ref_json AS tempRefJson,f.status,
           j.merge_action_id AS actionId
    FROM execution_merge_files f
    JOIN execution_merge_journals j ON j.id=f.journal_id
    ORDER BY f.journal_id,f.position
  `).all() as Array<{
    actionId: string;
    backupRefJson: string | null;
    durableNewRefJson: string;
    oldTargetJson: string;
    path: string;
    postTargetJson: string | null;
    status: RecoveryMergeFileStatus;
    tempLocatorJson: string;
    tempRefJson: string | null;
  }>;
  const hash = /^[0-9a-f]{64}$/u;
  const validSegments = (value: unknown): value is string[] =>
    Array.isArray(value)
    && value.length > 0
    && value.every((segment) =>
      typeof segment === "string"
      && segment.length > 0
      && segment !== "."
      && segment !== ".."
      && !/[\\/\0]/u.test(segment));
  const parse = (value: string): Record<string, unknown> | null => {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null;
    } catch {
      return null;
    }
  };
  const validRef = (value: Record<string, unknown> | null): boolean =>
    value !== null
    && ["journal", "canonical"].includes(String(value.rootKind))
    && validSegments(value.relativePath)
    && typeof value.ownerId === "string"
    && value.ownerId.length > 0
    && typeof value.parentIdentity === "string"
    && value.parentIdentity.length > 0
    && typeof value.fileIdentity === "string"
    && value.fileIdentity.length > 0
    && typeof value.finalPath === "string"
    && value.finalPath.length > 0
    && typeof value.sha256 === "string"
    && hash.test(value.sha256)
    && Number.isInteger(value.size)
    && Number(value.size) >= 0;
  const validTarget = (value: Record<string, unknown> | null): boolean => {
    if (
      value === null
      || value.rootKind !== "canonical"
      || !validSegments(value.relativePath)
      || typeof value.exists !== "boolean"
      || typeof value.parentIdentity !== "string"
      || value.parentIdentity.length === 0
    ) return false;
    return value.exists
      ? typeof value.fileIdentity === "string"
        && value.fileIdentity.length > 0
        && typeof value.sha256 === "string"
        && hash.test(value.sha256)
        && Number.isInteger(value.size)
        && Number(value.size) >= 0
      : value.fileIdentity === null && value.sha256 === null && value.size === null;
  };
  for (const row of rows) {
    const oldTarget = parse(row.oldTargetJson);
    const postTarget = row.postTargetJson ? parse(row.postTargetJson) : null;
    const backupRef = row.backupRefJson ? parse(row.backupRefJson) : null;
    const durableNewRef = parse(row.durableNewRefJson);
    const tempLocator = parse(row.tempLocatorJson);
    const tempRef = row.tempRefJson ? parse(row.tempRefJson) : null;
    const expectedSegments = row.path.split("/");
    if (
      !recoveryMergeFileStatusSchema.safeParse(row.status).success
      ||
      !validTarget(oldTarget)
      || !validRef(durableNewRef)
      || (backupRef !== null && !validRef(backupRef))
      || tempLocator === null
      || tempLocator.rootKind !== "canonical"
      || !validSegments(tempLocator.relativePath)
      || tempLocator.ownerId !== row.actionId
      || JSON.stringify(oldTarget!.relativePath) !== JSON.stringify(expectedSegments)
      || durableNewRef!.rootKind !== "journal"
      || durableNewRef!.ownerId !== row.actionId
      || (backupRef !== null && (
        backupRef.rootKind !== "journal"
        || backupRef.ownerId !== row.actionId
      ))
      || (oldTarget!.exists !== (backupRef !== null))
      || (backupRef !== null && (
        backupRef.sha256 !== oldTarget!.sha256
        || backupRef.size !== oldTarget!.size
      ))
      || JSON.stringify((tempLocator.relativePath as string[]).slice(0, -1))
        !== JSON.stringify(expectedSegments.slice(0, -1))
    ) return false;
    if (row.status === "pending") {
      if (postTarget !== null || tempRef !== null) return false;
      continue;
    }
    if (
      !validTarget(postTarget)
      || !postTarget!.exists
      || !validRef(tempRef)
      || JSON.stringify(postTarget!.relativePath) !== JSON.stringify(expectedSegments)
      || oldTarget!.parentIdentity !== postTarget!.parentIdentity
      || tempRef!.rootKind !== "canonical"
      || tempRef!.ownerId !== row.actionId
      || durableNewRef!.sha256 !== postTarget!.sha256
      || durableNewRef!.size !== postTarget!.size
      || tempRef!.sha256 !== postTarget!.sha256
      || tempRef!.size !== postTarget!.size
      || tempRef!.parentIdentity !== postTarget!.parentIdentity
      || tempRef!.fileIdentity !== postTarget!.fileIdentity
      || JSON.stringify(tempRef!.relativePath) !== JSON.stringify(tempLocator.relativePath)
    ) return false;
  }
  return true;
}

function validateV5Facts(
  database: DatabaseSync,
  retained = false,
  validateSchema = true,
): "SCHEMA_DRIFT" | "SCHEMA_DATA_INVALID" | null {
  if (validateSchema && !schemaIsExact(database, retained)) return "SCHEMA_DRIFT";
  if ((database.prepare("PRAGMA foreign_key_check").all() as unknown[]).length > 0) {
    return "SCHEMA_DRIFT";
  }
  const emptyHash = createHash("sha256").update("[]").digest("hex");
  if (
    scalar(database, `
      SELECT COUNT(*) count FROM project_validation_policies p
      JOIN project_validation_policy_revisions r
        ON r.project_id=p.project_id AND r.id=p.active_revision_id
      WHERE p.version<>r.revision_no
    `) > 0 ||
    scalar(database, `
      SELECT COUNT(*) count FROM project_validation_policy_revisions r
      WHERE r.entry_count<>(SELECT COUNT(*) FROM project_validation_policy_entries e
                            WHERE e.project_id=r.project_id AND e.revision_id=r.id)
         OR (r.entry_count=0 AND (r.canonical_bytes<>2 OR r.policy_hash<>'${emptyHash}'))
    `) > 0 ||
    scalar(database, `
      SELECT COUNT(*) count FROM project_validation_policies p
      WHERE NOT EXISTS(SELECT 1 FROM projects x WHERE x.id=p.project_id)
    `) > 0 ||
    scalar(database, `
      SELECT COUNT(*) count FROM (
        SELECT project_id,revision_no,
               ROW_NUMBER() OVER(PARTITION BY project_id ORDER BY revision_no,id) expected
        FROM project_validation_policy_revisions
      ) WHERE revision_no<>expected
    `) > 0 ||
    scalar(database, `
      SELECT COUNT(*) count FROM (
        SELECT project_id,sequence,
               ROW_NUMBER() OVER(PARTITION BY project_id ORDER BY sequence,id) expected
        FROM project_validation_policy_audits
      ) WHERE sequence<>expected
    `) > 0
  ) return "SCHEMA_DATA_INVALID";
  if (
    scalar(database, `
      SELECT COUNT(*) count FROM executions
      WHERE (first_running_at IS NULL)<>(business_deadline_at IS NULL)
         OR (first_running_at IS NOT NULL AND
             (unixepoch(business_deadline_at)-unixepoch(first_running_at))<>900)
    `) > 0 ||
    scalar(database, `
      SELECT COUNT(*) count FROM execution_operations o
      WHERE o.action_count<>(SELECT COUNT(*) FROM execution_actions a
                             WHERE a.project_id=o.project_id AND a.operation_id=o.id)
         OR EXISTS(
           SELECT 1 FROM execution_actions a
           WHERE a.project_id=o.project_id AND a.operation_id=o.id
             AND (a.action_index<0 OR a.action_index>=o.action_count)
         )
    `) > 0 ||
    scalar(database, `
      SELECT COUNT(*) count FROM executions e
      JOIN execution_attempts a
        ON a.execution_id=e.id AND a.attempt_no=e.current_attempt_no
      WHERE e.current_policy_revision_id<>a.frozen_policy_revision_id
    `) > 0 ||
    scalar(database, `
      SELECT COUNT(*) count FROM execution_validation_results v
      JOIN execution_attempts a
        ON a.project_id=v.project_id AND a.execution_id=v.execution_id AND a.id=v.attempt_id
      JOIN project_validation_policy_entries entry
        ON entry.project_id=v.project_id
       AND entry.revision_id=v.policy_revision_id
       AND entry.id=v.policy_entry_id
      WHERE v.policy_revision_id<>a.frozen_policy_revision_id
         OR v.required<>entry.required
    `) > 0
  ) return "SCHEMA_DATA_INVALID";
  if (!chunkFactsAreValid(database)) return "SCHEMA_DATA_INVALID";
  if (!mergeDescriptorFactsAreValid(database)) return "SCHEMA_DATA_INVALID";
  if (
    scalar(database, `
      SELECT COUNT(*) count FROM execution_staged_results s
      WHERE s.observed_path_count<>(
              SELECT COUNT(*) FROM execution_staged_observations o
              WHERE o.staged_result_id=s.id
            )
         OR s.observed_final_bytes<>(
              SELECT COALESCE(SUM(o.final_size),0) FROM execution_staged_observations o
              WHERE o.staged_result_id=s.id
            )
         OR s.blocker_count<>(
              SELECT COUNT(*) FROM execution_staged_blockers b
              WHERE b.staged_result_id=s.id
            )
         OR s.merge_file_count<>(
              SELECT COUNT(*) FROM execution_staged_files f
              WHERE f.staged_result_id=s.id
            )
         OR s.merge_final_bytes<>(
              SELECT COALESCE(SUM(f.size),0) FROM execution_staged_files f
              WHERE f.staged_result_id=s.id
            )
         OR (s.classification='blocked' AND
             (s.merge_file_count<>0 OR s.merge_final_bytes<>0))
         OR (s.classification<>'blocked' AND
             (s.blocker_count<>0 OR s.merge_file_count<>s.observed_path_count))
    `) > 0
  ) return "SCHEMA_DATA_INVALID";
  return null;
}

export function validateV5(database: DatabaseSync): "SCHEMA_DRIFT" | "SCHEMA_DATA_INVALID" | null {
  return validateV5Facts(database);
}

export function validateV5Retained(
  database: DatabaseSync,
): "SCHEMA_DRIFT" | "SCHEMA_DATA_INVALID" | null {
  return validateV5Facts(database, true);
}

export function validateV5RetainedData(
  database: DatabaseSync,
): "SCHEMA_DRIFT" | "SCHEMA_DATA_INVALID" | null {
  return validateV5Facts(database, true, false);
}
