export type CurrentSchemaObject = {
  readonly kind: "table" | "index" | "trigger";
  readonly name: string;
  readonly createSql: string;
  readonly dependsOn: readonly string[];
};

export type CurrentSchemaManifest = {
  readonly identity: { readonly userVersion: number };
  readonly objects: readonly CurrentSchemaObject[];
};

const CURRENT_SCHEMA_DEFINITION = {
  "identity": {
    "userVersion": 20
  },
  "objects": [
    {
      "kind": "table",
      "name": "projects",
      "createSql": "CREATE TABLE projects (\n    id TEXT PRIMARY KEY,\n    name TEXT NOT NULL,\n    created_at TEXT NOT NULL\n  , workspace_path TEXT, workspace_key TEXT, version INTEGER NOT NULL DEFAULT 1)",
      "dependsOn": []
    },
    {
      "kind": "table",
      "name": "task_runs",
      "createSql": "CREATE TABLE task_runs (\n    id TEXT PRIMARY KEY,\n    project_id TEXT NOT NULL REFERENCES projects(id),\n    goal TEXT NOT NULL,\n    status TEXT NOT NULL,\n    result TEXT,\n    error TEXT,\n    created_at TEXT NOT NULL,\n    updated_at TEXT NOT NULL\n  )",
      "dependsOn": []
    },
    {
      "kind": "table",
      "name": "task_events",
      "createSql": "CREATE TABLE task_events (\n    id TEXT PRIMARY KEY,\n    task_id TEXT NOT NULL REFERENCES task_runs(id),\n    sequence INTEGER NOT NULL,\n    status TEXT NOT NULL,\n    message TEXT NOT NULL,\n    created_at TEXT NOT NULL,\n    UNIQUE(task_id, sequence)\n  )",
      "dependsOn": []
    },
    {
      "kind": "table",
      "name": "providers",
      "createSql": "CREATE TABLE providers (\n    id TEXT PRIMARY KEY,\n    name TEXT NOT NULL,\n    base_url TEXT NOT NULL,\n    default_model TEXT NOT NULL,\n    api_key_cipher TEXT NOT NULL,\n    api_key_iv TEXT NOT NULL,\n    api_key_tag TEXT NOT NULL,\n    credential_version INTEGER NOT NULL CHECK(credential_version = 1),\n    credential_generation INTEGER NOT NULL CHECK(credential_generation >= 1),\n    key_id TEXT NOT NULL,\n    api_key_mask TEXT NOT NULL,\n    verified_at TEXT NOT NULL,\n    version INTEGER NOT NULL CHECK(version >= 1),\n    created_at TEXT NOT NULL,\n    updated_at TEXT NOT NULL\n  )",
      "dependsOn": []
    },
    {
      "kind": "table",
      "name": "skills",
      "createSql": "CREATE TABLE skills (\n    id TEXT PRIMARY KEY,\n    name TEXT NOT NULL,\n    description TEXT NOT NULL,\n    instructions TEXT NOT NULL,\n    version INTEGER NOT NULL CHECK(version >= 1),\n    created_at TEXT NOT NULL,\n    updated_at TEXT NOT NULL\n  )",
      "dependsOn": []
    },
    {
      "kind": "table",
      "name": "agents",
      "createSql": "CREATE TABLE agents (\n    id TEXT PRIMARY KEY,\n    name TEXT NOT NULL,\n    role TEXT NOT NULL,\n    system_prompt TEXT NOT NULL,\n    provider_id TEXT NOT NULL REFERENCES providers(id),\n    model TEXT NOT NULL,\n    avatar_text TEXT NOT NULL,\n    accent_token TEXT NOT NULL,\n    can_read INTEGER NOT NULL CHECK(can_read IN (0,1)),\n    can_write INTEGER NOT NULL CHECK(can_write IN (0,1)),\n    can_execute INTEGER NOT NULL CHECK(can_execute IN (0,1)),\n    max_tokens INTEGER NOT NULL,\n    max_handoffs INTEGER NOT NULL,\n    version INTEGER NOT NULL CHECK(version >= 1),\n    created_at TEXT NOT NULL,\n    updated_at TEXT NOT NULL\n  , review_capable INTEGER NOT NULL DEFAULT 0\n    CHECK(review_capable IN (0,1)))",
      "dependsOn": []
    },
    {
      "kind": "table",
      "name": "agent_skills",
      "createSql": "CREATE TABLE agent_skills (\n    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,\n    skill_id TEXT NOT NULL REFERENCES skills(id),\n    position INTEGER NOT NULL,\n    PRIMARY KEY(agent_id, skill_id),\n    UNIQUE(agent_id, position)\n  )",
      "dependsOn": []
    },
    {
      "kind": "table",
      "name": "project_memberships",
      "createSql": "CREATE TABLE project_memberships (\n    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,\n    agent_id TEXT NOT NULL REFERENCES agents(id),\n    joined_at TEXT NOT NULL,\n    PRIMARY KEY(project_id, agent_id)\n  )",
      "dependsOn": []
    },
    {
      "kind": "table",
      "name": "missions",
      "createSql": "CREATE TABLE missions (\n    id TEXT PRIMARY KEY,\n    project_id TEXT NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,\n    title TEXT NOT NULL,\n    goal TEXT NOT NULL,\n    version INTEGER NOT NULL,\n    created_at TEXT NOT NULL,\n    updated_at TEXT NOT NULL\n  )",
      "dependsOn": []
    },
    {
      "kind": "table",
      "name": "work_items",
      "createSql": "CREATE TABLE work_items (\n    id TEXT PRIMARY KEY,\n    mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,\n    title TEXT NOT NULL,\n    description TEXT NOT NULL,\n    status TEXT NOT NULL CHECK(status IN ('todo','in_progress','blocked','done')),\n    assignee_agent_id TEXT REFERENCES agents(id),\n    version INTEGER NOT NULL,\n    created_at TEXT NOT NULL,\n    updated_at TEXT NOT NULL\n  )",
      "dependsOn": []
    },
    {
      "kind": "table",
      "name": "work_item_dependencies",
      "createSql": "CREATE TABLE work_item_dependencies (\n    work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,\n    depends_on_id TEXT NOT NULL REFERENCES work_items(id),\n    PRIMARY KEY(work_item_id, depends_on_id),\n    CHECK(work_item_id <> depends_on_id)\n  )",
      "dependsOn": []
    },
    {
      "kind": "table",
      "name": "project_validation_policies",
      "createSql": "CREATE TABLE project_validation_policies(\n project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,\n active_revision_id TEXT NOT NULL,\n version INTEGER NOT NULL CHECK(version>=1),\n updated_at TEXT NOT NULL CHECK(updated_at GLOB '????-??-??T??:??:??.???Z'),\n FOREIGN KEY(project_id,active_revision_id) REFERENCES project_validation_policy_revisions(project_id,id)\n)",
      "dependsOn": []
    },
    {
      "kind": "table",
      "name": "project_validation_policy_entries",
      "createSql": "CREATE TABLE project_validation_policy_entries(\n id TEXT PRIMARY KEY, project_id TEXT NOT NULL, revision_id TEXT NOT NULL,\n position INTEGER NOT NULL CHECK(position BETWEEN 0 AND 49),\n executable TEXT NOT NULL CHECK(length(CAST(executable AS BLOB)) BETWEEN 1 AND 4096),\n executable_identity TEXT NOT NULL CHECK(length(executable_identity)=64 AND executable_identity NOT GLOB '*[^0-9a-f]*'),\n args_json TEXT NOT NULL CHECK(json_valid(args_json) AND length(CAST(args_json AS BLOB))<=32768),\n workdir TEXT NOT NULL CHECK(length(CAST(workdir AS BLOB)) BETWEEN 1 AND 4096),\n required INTEGER NOT NULL CHECK(required IN (0,1)),\n tuple_hash TEXT NOT NULL CHECK(length(tuple_hash)=64 AND tuple_hash NOT GLOB '*[^0-9a-f]*'),\n UNIQUE(project_id,revision_id,position), UNIQUE(project_id,revision_id,id),\n FOREIGN KEY(project_id,revision_id) REFERENCES project_validation_policy_revisions(project_id,id) ON DELETE CASCADE\n)",
      "dependsOn": []
    },
    {
      "kind": "table",
      "name": "execution_attempts",
      "createSql": "CREATE TABLE execution_attempts(\n id TEXT PRIMARY KEY, project_id TEXT NOT NULL, execution_id TEXT NOT NULL,\n attempt_no INTEGER NOT NULL CHECK(attempt_no>=1),\n status TEXT NOT NULL CHECK(status IN ('preparing','ready','acting','interrupted','failed','superseded','completed')),\n sandbox_root TEXT NOT NULL CHECK(length(CAST(sandbox_root AS BLOB)) BETWEEN 1 AND 32767),\n baseline_manifest_path TEXT,\n sandbox_manifest_path TEXT,\n baseline_manifest_hash TEXT CHECK(baseline_manifest_hash IS NULL OR (length(baseline_manifest_hash)=64 AND baseline_manifest_hash NOT GLOB '*[^0-9a-f]*')),\n sandbox_manifest_hash TEXT CHECK(sandbox_manifest_hash IS NULL OR (length(sandbox_manifest_hash)=64 AND sandbox_manifest_hash NOT GLOB '*[^0-9a-f]*')),\n frozen_public_json TEXT NOT NULL CHECK(json_valid(frozen_public_json) AND length(CAST(frozen_public_json AS BLOB))<=2097152),\n frozen_private_json TEXT NOT NULL CHECK(json_valid(frozen_private_json) AND length(CAST(frozen_private_json AS BLOB))<=2097152),\n frozen_context_hash TEXT NOT NULL CHECK(length(frozen_context_hash)=64 AND frozen_context_hash NOT GLOB '*[^0-9a-f]*'),\n frozen_policy_revision_id TEXT NOT NULL, frozen_policy_version INTEGER NOT NULL CHECK(frozen_policy_version>=1),\n frozen_policy_hash TEXT NOT NULL CHECK(length(frozen_policy_hash)=64 AND frozen_policy_hash NOT GLOB '*[^0-9a-f]*'),\n started_at TEXT NOT NULL CHECK(started_at GLOB '????-??-??T??:??:??.???Z'),\n finished_at TEXT CHECK(finished_at IS NULL OR finished_at GLOB '????-??-??T??:??:??.???Z'),\n UNIQUE(execution_id,attempt_no), UNIQUE(project_id,execution_id,id),\n FOREIGN KEY(project_id,execution_id) REFERENCES executions(project_id,id) ON DELETE CASCADE,\n FOREIGN KEY(project_id,frozen_policy_revision_id) REFERENCES project_validation_policy_revisions(project_id,id)\n)",
      "dependsOn": []
    },
    {
      "kind": "table",
      "name": "execution_actions",
      "createSql": "CREATE TABLE execution_actions(\n id TEXT PRIMARY KEY, project_id TEXT NOT NULL, execution_id TEXT NOT NULL, attempt_id TEXT NOT NULL,\n operation_id TEXT NOT NULL, action_index INTEGER NOT NULL CHECK(action_index BETWEEN 0 AND 15),\n kind TEXT NOT NULL CHECK(kind IN ('sandbox_build','model','file_list','file_read','file_write','command','stage_compute','merge_apply','merge_recover','manual_resolution')),\n status TEXT NOT NULL CHECK(status IN ('pending','running','succeeded','failed','interrupted','discarded')),\n request_hash TEXT NOT NULL CHECK(length(request_hash)=64 AND request_hash NOT GLOB '*[^0-9a-f]*'),\n lease_token TEXT UNIQUE, lease_expires_at TEXT,\n overall_deadline_at TEXT NOT NULL CHECK(overall_deadline_at GLOB '????-??-??T??:??:??.???Z'),\n last_heartbeat_at TEXT,\n result_json TEXT CHECK(result_json IS NULL OR (json_valid(result_json) AND length(CAST(result_json AS BLOB))<=262144)),\n error_code TEXT, created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z'),\n started_at TEXT CHECK(started_at IS NULL OR started_at GLOB '????-??-??T??:??:??.???Z'),\n finished_at TEXT CHECK(finished_at IS NULL OR finished_at GLOB '????-??-??T??:??:??.???Z'),\n UNIQUE(project_id,id), UNIQUE(project_id,execution_id,id), UNIQUE(project_id,execution_id,attempt_id,id),\n UNIQUE(project_id,operation_id,id), UNIQUE(project_id,operation_id,action_index),\n FOREIGN KEY(project_id,execution_id,attempt_id) REFERENCES execution_attempts(project_id,execution_id,id) ON DELETE CASCADE,\n FOREIGN KEY(project_id,operation_id,execution_id) REFERENCES execution_operations(project_id,id,execution_id) ON DELETE CASCADE,\n CHECK((status='running' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL) OR (status<>'running' AND lease_token IS NULL AND lease_expires_at IS NULL)),\n CHECK(lease_expires_at IS NULL OR lease_expires_at GLOB '????-??-??T??:??:??.???Z'),\n CHECK(last_heartbeat_at IS NULL OR last_heartbeat_at GLOB '????-??-??T??:??:??.???Z')\n)",
      "dependsOn": []
    },
    {
      "kind": "table",
      "name": "execution_operations",
      "createSql": "CREATE TABLE execution_operations(\n id TEXT NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, execution_id TEXT,\n kind TEXT NOT NULL CHECK(kind IN ('start','start_resume','advance','approve','reject','revoke','replace_request','pause','continue','retry','stop','stage','merge','resolve_manual','policy_update','recover')),\n request_hash TEXT NOT NULL CHECK(length(request_hash)=64 AND request_hash NOT GLOB '*[^0-9a-f]*'),\n has_external_actions INTEGER NOT NULL CHECK(has_external_actions IN (0,1)),\n action_count INTEGER NOT NULL DEFAULT 0 CHECK(action_count BETWEEN 0 AND 16),\n final_action_index INTEGER CHECK(final_action_index IS NULL OR final_action_index BETWEEN 0 AND 15),\n status TEXT NOT NULL CHECK(status IN ('pending','completed')), http_status INTEGER,\n response_json TEXT CHECK(response_json IS NULL OR (json_valid(response_json) AND length(CAST(response_json AS BLOB))<=262144)),\n created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z'),\n updated_at TEXT NOT NULL CHECK(updated_at GLOB '????-??-??T??:??:??.???Z'),\n PRIMARY KEY(project_id,id), UNIQUE(project_id,id,execution_id),\n FOREIGN KEY(project_id,execution_id) REFERENCES executions(project_id,id) ON DELETE CASCADE,\n CHECK((status='pending' AND http_status IS NULL AND response_json IS NULL) OR (status='completed' AND http_status BETWEEN 100 AND 599 AND response_json IS NOT NULL)),\n CHECK((has_external_actions=0 AND action_count=0 AND final_action_index IS NULL) OR (has_external_actions=1 AND action_count>=1)),\n CHECK(status<>'completed' OR has_external_actions=0 OR final_action_index=action_count-1)\n)",
      "dependsOn": []
    },
    {
      "kind": "table",
      "name": "project_validation_policy_revisions",
      "createSql": "CREATE TABLE project_validation_policy_revisions(\n id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,\n created_operation_id TEXT, created_actor_type TEXT NOT NULL CHECK(created_actor_type IN ('system','owner')),\n revision_no INTEGER NOT NULL CHECK(revision_no>=1),\n policy_hash TEXT NOT NULL CHECK(length(policy_hash)=64 AND policy_hash NOT GLOB '*[^0-9a-f]*'),\n classifier_version INTEGER NOT NULL CHECK(classifier_version>=1),\n warning_accepted INTEGER NOT NULL CHECK(warning_accepted IN (0,1)),\n canonical_bytes INTEGER NOT NULL CHECK(canonical_bytes BETWEEN 2 AND 65536),\n entry_count INTEGER NOT NULL CHECK(entry_count BETWEEN 0 AND 50),\n created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z'),\n UNIQUE(project_id,id), UNIQUE(project_id,revision_no), UNIQUE(project_id,policy_hash,revision_no),\n FOREIGN KEY(project_id,created_operation_id) REFERENCES execution_operations(project_id,id),\n CHECK((created_actor_type='system' AND revision_no=1 AND created_operation_id IS NULL AND warning_accepted=0) OR (created_actor_type='owner' AND created_operation_id IS NOT NULL AND warning_accepted=1))\n)",
      "dependsOn": []
    },
    {
      "kind": "table",
      "name": "project_validation_policy_audits",
      "createSql": "CREATE TABLE project_validation_policy_audits(\n id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,\n operation_id TEXT NOT NULL, sequence INTEGER NOT NULL CHECK(sequence>=1),\n actor_type TEXT NOT NULL CHECK(actor_type='owner'), outcome TEXT NOT NULL CHECK(outcome IN ('saved','rejected')),\n before_revision_id TEXT NOT NULL, after_revision_id TEXT,\n before_policy_hash TEXT NOT NULL CHECK(length(before_policy_hash)=64 AND before_policy_hash NOT GLOB '*[^0-9a-f]*'),\n after_policy_hash TEXT CHECK(after_policy_hash IS NULL OR (length(after_policy_hash)=64 AND after_policy_hash NOT GLOB '*[^0-9a-f]*')),\n public_change_json TEXT NOT NULL CHECK(json_valid(public_change_json) AND length(CAST(public_change_json AS BLOB))<=65536),\n warning_accepted INTEGER NOT NULL CHECK(warning_accepted IN (0,1)),\n created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z'),\n UNIQUE(project_id,sequence),\n FOREIGN KEY(project_id,operation_id) REFERENCES execution_operations(project_id,id),\n FOREIGN KEY(project_id,before_revision_id) REFERENCES project_validation_policy_revisions(project_id,id),\n FOREIGN KEY(project_id,after_revision_id) REFERENCES project_validation_policy_revisions(project_id,id),\n CHECK((outcome='saved' AND after_revision_id IS NOT NULL AND after_policy_hash IS NOT NULL AND warning_accepted=1) OR (outcome='rejected' AND after_policy_hash IS NULL AND after_revision_id IS NULL))\n)",
      "dependsOn": []
    },
    {
      "kind": "table",
      "name": "execution_model_calls",
      "createSql": "CREATE TABLE execution_model_calls(\n id TEXT PRIMARY KEY, project_id TEXT NOT NULL, execution_id TEXT NOT NULL, attempt_id TEXT NOT NULL, action_id TEXT NOT NULL,\n business_round INTEGER NOT NULL CHECK(business_round>=1), kind TEXT NOT NULL CHECK(kind IN ('primary','repair')),\n call_index INTEGER NOT NULL CHECK(call_index IN (1,2)),\n status TEXT NOT NULL CHECK(status IN ('calling','succeeded','provider_failed','response_invalid','usage_invalid','interrupted','discarded')),\n prompt_hash TEXT NOT NULL CHECK(length(prompt_hash)=64 AND prompt_hash NOT GLOB '*[^0-9a-f]*'),\n prompt_tokens INTEGER CHECK(prompt_tokens IS NULL OR prompt_tokens>=0), completion_tokens INTEGER CHECK(completion_tokens IS NULL OR completion_tokens>=0),\n total_tokens INTEGER CHECK(total_tokens IS NULL OR total_tokens>=0), error_category TEXT,\n call_started_at TEXT NOT NULL CHECK(call_started_at GLOB '????-??-??T??:??:??.???Z'),\n call_deadline_at TEXT NOT NULL CHECK(call_deadline_at GLOB '????-??-??T??:??:??.???Z'),\n finished_at TEXT CHECK(finished_at IS NULL OR finished_at GLOB '????-??-??T??:??:??.???Z'),\n created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z'),\n UNIQUE(action_id,call_index), UNIQUE(attempt_id,business_round,call_index),\n FOREIGN KEY(project_id,execution_id,attempt_id,action_id) REFERENCES execution_actions(project_id,execution_id,attempt_id,id) ON DELETE CASCADE,\n CHECK(total_tokens IS NULL OR total_tokens=prompt_tokens+completion_tokens),\n CHECK((status='calling' AND finished_at IS NULL) OR (status<>'calling' AND finished_at IS NOT NULL))\n)",
      "dependsOn": []
    },
    {
      "kind": "table",
      "name": "execution_tool_calls",
      "createSql": "CREATE TABLE execution_tool_calls(\n id TEXT PRIMARY KEY, project_id TEXT NOT NULL, execution_id TEXT NOT NULL, attempt_id TEXT NOT NULL, action_id TEXT UNIQUE,\n business_round INTEGER NOT NULL CHECK(business_round>=1), type TEXT NOT NULL CHECK(type IN ('list','read','write','command')),\n request_hash TEXT NOT NULL CHECK(length(request_hash)=64 AND request_hash NOT GLOB '*[^0-9a-f]*'),\n status TEXT NOT NULL CHECK(status IN ('requested','waiting_approval','succeeded','rejected','failed','interrupted','discarded')),\n error_code TEXT,\n public_request_json TEXT NOT NULL CHECK(json_valid(public_request_json) AND length(CAST(public_request_json AS BLOB))<=131072),\n public_result_json TEXT CHECK(public_result_json IS NULL OR (json_valid(public_result_json) AND length(CAST(public_result_json AS BLOB))<=2097152)),\n before_sandbox_hash TEXT CHECK(before_sandbox_hash IS NULL OR (length(before_sandbox_hash)=64 AND before_sandbox_hash NOT GLOB '*[^0-9a-f]*')),\n after_sandbox_hash TEXT CHECK(after_sandbox_hash IS NULL OR (length(after_sandbox_hash)=64 AND after_sandbox_hash NOT GLOB '*[^0-9a-f]*')),\n started_at TEXT NOT NULL CHECK(started_at GLOB '????-??-??T??:??:??.???Z'),\n finished_at TEXT CHECK(finished_at IS NULL OR finished_at GLOB '????-??-??T??:??:??.???Z'),\n UNIQUE(attempt_id,business_round), UNIQUE(project_id,execution_id,attempt_id,id),\n FOREIGN KEY(project_id,execution_id,attempt_id) REFERENCES execution_attempts(project_id,execution_id,id) ON DELETE CASCADE,\n FOREIGN KEY(project_id,execution_id,attempt_id,action_id) REFERENCES execution_actions(project_id,execution_id,attempt_id,id),\n CHECK((type='command' AND action_id IS NULL) OR action_id IS NOT NULL)\n)",
      "dependsOn": []
    },
    {
      "kind": "table",
      "name": "execution_approvals",
      "createSql": "CREATE TABLE execution_approvals(\n id TEXT PRIMARY KEY, project_id TEXT NOT NULL, execution_id TEXT NOT NULL, attempt_id TEXT NOT NULL, tool_call_id TEXT,\n kind TEXT NOT NULL CHECK(kind IN ('command','staged_merge')),\n status TEXT NOT NULL CHECK(status IN ('pending','approved','consumed','rejected','revoked','replaced','expired')),\n request_hash TEXT NOT NULL CHECK(length(request_hash)=64 AND request_hash NOT GLOB '*[^0-9a-f]*'),\n input_hash TEXT NOT NULL CHECK(length(input_hash)=64 AND input_hash NOT GLOB '*[^0-9a-f]*'),\n staged_hash TEXT CHECK(staged_hash IS NULL OR (length(staged_hash)=64 AND staged_hash NOT GLOB '*[^0-9a-f]*')),\n public_request_json TEXT NOT NULL CHECK(json_valid(public_request_json) AND length(CAST(public_request_json AS BLOB))<=131072),\n decided_at TEXT CHECK(decided_at IS NULL OR decided_at GLOB '????-??-??T??:??:??.???Z'),\n consumed_at TEXT CHECK(consumed_at IS NULL OR consumed_at GLOB '????-??-??T??:??:??.???Z'),\n created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z'),\n FOREIGN KEY(project_id,execution_id,attempt_id) REFERENCES execution_attempts(project_id,execution_id,id) ON DELETE CASCADE,\n FOREIGN KEY(project_id,execution_id,attempt_id,tool_call_id) REFERENCES execution_tool_calls(project_id,execution_id,attempt_id,id),\n CHECK((kind='command')=(tool_call_id IS NOT NULL)), CHECK((kind='staged_merge')=(staged_hash IS NOT NULL))\n)",
      "dependsOn": []
    },
    {
      "kind": "table",
      "name": "execution_validation_results",
      "createSql": "CREATE TABLE execution_validation_results(\n id TEXT PRIMARY KEY, project_id TEXT NOT NULL, execution_id TEXT NOT NULL, attempt_id TEXT NOT NULL,\n policy_revision_id TEXT NOT NULL, policy_entry_id TEXT NOT NULL, tool_call_id TEXT NOT NULL UNIQUE,\n sandbox_manifest_hash TEXT NOT NULL CHECK(length(sandbox_manifest_hash)=64 AND sandbox_manifest_hash NOT GLOB '*[^0-9a-f]*'),\n required INTEGER NOT NULL CHECK(required IN (0,1)), exit_code INTEGER NOT NULL, succeeded INTEGER NOT NULL CHECK(succeeded IN (0,1)),\n stdout_bytes INTEGER NOT NULL CHECK(stdout_bytes BETWEEN 0 AND 1048576), stderr_bytes INTEGER NOT NULL CHECK(stderr_bytes BETWEEN 0 AND 1048576),\n stdout_sha256 TEXT NOT NULL CHECK(length(stdout_sha256)=64 AND stdout_sha256 NOT GLOB '*[^0-9a-f]*'),\n stderr_sha256 TEXT NOT NULL CHECK(length(stderr_sha256)=64 AND stderr_sha256 NOT GLOB '*[^0-9a-f]*'),\n stdout_truncated INTEGER NOT NULL CHECK(stdout_truncated IN (0,1)), stderr_truncated INTEGER NOT NULL CHECK(stderr_truncated IN (0,1)),\n finished_at TEXT NOT NULL CHECK(finished_at GLOB '????-??-??T??:??:??.???Z'),\n UNIQUE(execution_id,policy_entry_id,sandbox_manifest_hash),\n FOREIGN KEY(project_id,execution_id,attempt_id) REFERENCES execution_attempts(project_id,execution_id,id) ON DELETE CASCADE,\n FOREIGN KEY(project_id,execution_id,attempt_id,tool_call_id) REFERENCES execution_tool_calls(project_id,execution_id,attempt_id,id),\n FOREIGN KEY(project_id,policy_revision_id,policy_entry_id) REFERENCES project_validation_policy_entries(project_id,revision_id,id)\n)",
      "dependsOn": []
    },
    {
      "kind": "table",
      "name": "execution_validation_output_chunks",
      "createSql": "CREATE TABLE execution_validation_output_chunks(\n validation_id TEXT NOT NULL REFERENCES execution_validation_results(id) ON DELETE CASCADE,\n stream TEXT NOT NULL CHECK(stream IN ('stdout','stderr')), chunk_index INTEGER NOT NULL CHECK(chunk_index BETWEEN 0 AND 16),\n byte_offset INTEGER NOT NULL CHECK(byte_offset BETWEEN 0 AND 1048575), byte_length INTEGER NOT NULL CHECK(byte_length BETWEEN 1 AND 65536),\n text TEXT NOT NULL CHECK(length(CAST(text AS BLOB))=byte_length),\n sha256 TEXT NOT NULL CHECK(length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*'),\n PRIMARY KEY(validation_id,stream,chunk_index), UNIQUE(validation_id,stream,byte_offset)\n)",
      "dependsOn": []
    },
    {
      "kind": "table",
      "name": "execution_staged_results",
      "createSql": "CREATE TABLE execution_staged_results(\n id TEXT PRIMARY KEY, project_id TEXT NOT NULL, execution_id TEXT NOT NULL, attempt_id TEXT NOT NULL UNIQUE, action_id TEXT NOT NULL UNIQUE,\n baseline_manifest_hash TEXT NOT NULL CHECK(length(baseline_manifest_hash)=64 AND baseline_manifest_hash NOT GLOB '*[^0-9a-f]*'),\n sandbox_manifest_hash TEXT NOT NULL CHECK(length(sandbox_manifest_hash)=64 AND sandbox_manifest_hash NOT GLOB '*[^0-9a-f]*'),\n context_hash TEXT NOT NULL CHECK(length(context_hash)=64 AND context_hash NOT GLOB '*[^0-9a-f]*'),\n policy_hash TEXT NOT NULL CHECK(length(policy_hash)=64 AND policy_hash NOT GLOB '*[^0-9a-f]*'),\n staged_hash TEXT NOT NULL UNIQUE CHECK(length(staged_hash)=64 AND staged_hash NOT GLOB '*[^0-9a-f]*'),\n observed_path_count INTEGER NOT NULL CHECK(observed_path_count BETWEEN 1 AND 100000),\n observed_final_bytes INTEGER NOT NULL CHECK(observed_final_bytes BETWEEN 0 AND 9007199254740991),\n merge_file_count INTEGER NOT NULL CHECK(merge_file_count BETWEEN 0 AND 100),\n merge_final_bytes INTEGER NOT NULL CHECK(merge_final_bytes BETWEEN 0 AND 10485760),\n blocker_count INTEGER NOT NULL CHECK(blocker_count BETWEEN 0 AND 100000),\n classification TEXT NOT NULL CHECK(classification IN ('auto_eligible','approval_required','blocked')),\n block_reasons_json TEXT NOT NULL CHECK(json_valid(block_reasons_json) AND length(CAST(block_reasons_json AS BLOB))<=65536),\n created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z'),\n UNIQUE(project_id,execution_id,id), UNIQUE(project_id,execution_id,attempt_id,id),\n FOREIGN KEY(project_id,execution_id,attempt_id,action_id) REFERENCES execution_actions(project_id,execution_id,attempt_id,id) ON DELETE CASCADE\n)",
      "dependsOn": []
    },
    {
      "kind": "table",
      "name": "execution_staged_observations",
      "createSql": "CREATE TABLE execution_staged_observations(\n id TEXT PRIMARY KEY, staged_result_id TEXT NOT NULL REFERENCES execution_staged_results(id) ON DELETE CASCADE,\n position INTEGER NOT NULL CHECK(position BETWEEN 0 AND 99999),\n path TEXT NOT NULL CHECK(length(CAST(path AS BLOB)) BETWEEN 1 AND 4096),\n path_key TEXT NOT NULL CHECK(length(CAST(path_key AS BLOB)) BETWEEN 1 AND 4096),\n kind TEXT NOT NULL CHECK(kind IN ('added','modified','deleted','renamed','binary','permission','special')),\n baseline_hash TEXT CHECK(baseline_hash IS NULL OR (length(baseline_hash)=64 AND baseline_hash NOT GLOB '*[^0-9a-f]*')),\n observed_hash TEXT CHECK(observed_hash IS NULL OR (length(observed_hash)=64 AND observed_hash NOT GLOB '*[^0-9a-f]*')),\n final_size INTEGER NOT NULL CHECK(final_size BETWEEN 0 AND 9007199254740991),\n diff_text TEXT CHECK(diff_text IS NULL OR length(CAST(diff_text AS BLOB))<=262144),\n diff_bytes INTEGER NOT NULL CHECK(diff_bytes BETWEEN 0 AND 262144), diff_truncated INTEGER NOT NULL CHECK(diff_truncated IN (0,1)),\n UNIQUE(staged_result_id,position), UNIQUE(staged_result_id,path_key), UNIQUE(staged_result_id,id),\n CHECK((diff_text IS NULL AND diff_bytes=0) OR (diff_text IS NOT NULL AND length(CAST(diff_text AS BLOB))=diff_bytes))\n)",
      "dependsOn": []
    },
    {
      "kind": "table",
      "name": "execution_staged_files",
      "createSql": "CREATE TABLE execution_staged_files(\n id TEXT PRIMARY KEY, staged_result_id TEXT NOT NULL REFERENCES execution_staged_results(id) ON DELETE CASCADE,\n observation_id TEXT NOT NULL, position INTEGER NOT NULL CHECK(position BETWEEN 0 AND 99),\n path TEXT NOT NULL, path_key TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('added','modified')),\n baseline_hash TEXT CHECK(baseline_hash IS NULL OR (length(baseline_hash)=64 AND baseline_hash NOT GLOB '*[^0-9a-f]*')),\n staged_hash TEXT NOT NULL CHECK(length(staged_hash)=64 AND staged_hash NOT GLOB '*[^0-9a-f]*'),\n size INTEGER NOT NULL CHECK(size BETWEEN 0 AND 1048576),\n UNIQUE(staged_result_id,position), UNIQUE(staged_result_id,path_key), UNIQUE(staged_result_id,observation_id),\n FOREIGN KEY(staged_result_id,observation_id) REFERENCES execution_staged_observations(staged_result_id,id)\n)",
      "dependsOn": []
    },
    {
      "kind": "table",
      "name": "execution_staged_blockers",
      "createSql": "CREATE TABLE execution_staged_blockers(\n staged_result_id TEXT NOT NULL REFERENCES execution_staged_results(id) ON DELETE CASCADE, observation_id TEXT NOT NULL,\n position INTEGER NOT NULL CHECK(position BETWEEN 0 AND 99999),\n path TEXT NOT NULL CHECK(length(CAST(path AS BLOB)) BETWEEN 1 AND 4096),\n kind TEXT NOT NULL CHECK(kind IN ('deleted','renamed','binary','permission','special','file_size_limit','file_count_limit','byte_limit')),\n detail_json TEXT NOT NULL CHECK(json_valid(detail_json) AND length(CAST(detail_json AS BLOB))<=4096),\n PRIMARY KEY(staged_result_id,position), UNIQUE(staged_result_id,observation_id),\n FOREIGN KEY(staged_result_id,observation_id) REFERENCES execution_staged_observations(staged_result_id,id)\n)",
      "dependsOn": []
    },
    {
      "kind": "table",
      "name": "execution_artifacts",
      "createSql": "CREATE TABLE execution_artifacts(\n id TEXT PRIMARY KEY, project_id TEXT NOT NULL, execution_id TEXT NOT NULL, attempt_id TEXT NOT NULL,\n name TEXT NOT NULL CHECK(length(CAST(name AS BLOB)) BETWEEN 1 AND 255),\n path TEXT NOT NULL CHECK(length(CAST(path AS BLOB)) BETWEEN 1 AND 4096),\n content_bytes INTEGER NOT NULL CHECK(content_bytes BETWEEN 0 AND 1048576),\n sha256 TEXT NOT NULL CHECK(length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*'),\n truncated INTEGER NOT NULL CHECK(truncated IN (0,1)),\n created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z'),\n FOREIGN KEY(project_id,execution_id,attempt_id) REFERENCES execution_attempts(project_id,execution_id,id) ON DELETE CASCADE\n)",
      "dependsOn": []
    },
    {
      "kind": "table",
      "name": "execution_artifact_chunks",
      "createSql": "CREATE TABLE execution_artifact_chunks(\n artifact_id TEXT NOT NULL REFERENCES execution_artifacts(id) ON DELETE CASCADE,\n chunk_index INTEGER NOT NULL CHECK(chunk_index BETWEEN 0 AND 16),\n byte_offset INTEGER NOT NULL CHECK(byte_offset BETWEEN 0 AND 1048575),\n byte_length INTEGER NOT NULL CHECK(byte_length BETWEEN 1 AND 65536),\n text TEXT NOT NULL CHECK(length(CAST(text AS BLOB))=byte_length),\n sha256 TEXT NOT NULL CHECK(length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*'),\n PRIMARY KEY(artifact_id,chunk_index), UNIQUE(artifact_id,byte_offset)\n)",
      "dependsOn": []
    },
    {
      "kind": "table",
      "name": "execution_events",
      "createSql": "CREATE TABLE execution_events(\n id TEXT PRIMARY KEY, project_id TEXT NOT NULL, execution_id TEXT NOT NULL,\n sequence INTEGER NOT NULL CHECK(sequence>=1), attempt_no INTEGER NOT NULL CHECK(attempt_no>=1),\n type TEXT NOT NULL, actor_type TEXT NOT NULL CHECK(actor_type IN ('owner','agent','system')), actor_id TEXT,\n payload_json TEXT NOT NULL CHECK(json_valid(payload_json) AND length(CAST(payload_json AS BLOB))<=65536),\n created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z'),\n UNIQUE(execution_id,sequence),\n FOREIGN KEY(project_id,execution_id) REFERENCES executions(project_id,id) ON DELETE CASCADE\n)",
      "dependsOn": []
    },
    {
      "kind": "table",
      "name": "audit_event_outbox",
      "createSql": "CREATE TABLE audit_event_outbox(\n id TEXT PRIMARY KEY,\n project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,\n source TEXT NOT NULL CHECK(source IN('safe_execution','public_collaboration')),\n event_type TEXT NOT NULL,\n payload_json TEXT NOT NULL CHECK(json_valid(payload_json) AND length(CAST(payload_json AS BLOB))<=65536),\n occurred_at TEXT NOT NULL CHECK(occurred_at GLOB '????-??-??T??:??:??.???Z'),\n outbox_seq INTEGER NOT NULL UNIQUE CHECK(outbox_seq>=1)\n)",
      "dependsOn": []
    },
    {
      "kind": "table",
      "name": "audit_event_projection",
      "createSql": "CREATE TABLE audit_event_projection(\n outbox_seq INTEGER NOT NULL UNIQUE CHECK(outbox_seq>=1),\n id TEXT NOT NULL,\n project_id TEXT NOT NULL,\n source TEXT NOT NULL,\n event_type TEXT NOT NULL,\n actor_type TEXT,\n occurred_at TEXT NOT NULL CHECK(occurred_at GLOB '????-??-??T??:??:??.???Z'),\n execution_id TEXT,\n payload_json TEXT NOT NULL CHECK(json_valid(payload_json) AND length(CAST(payload_json AS BLOB))<=65536)\n)",
      "dependsOn": []
    },
    {
      "kind": "table",
      "name": "audit_projection_checkpoints",
      "createSql": "CREATE TABLE audit_projection_checkpoints(\n consumer_id TEXT PRIMARY KEY,\n last_outbox_seq INTEGER NOT NULL DEFAULT 0 CHECK(last_outbox_seq>=0),\n status TEXT NOT NULL CHECK(status IN ('idle','rebuilding')),\n updated_at TEXT NOT NULL CHECK(updated_at GLOB '????-??-??T??:??:??.???Z')\n)",
      "dependsOn": []
    },
    {
      "kind": "table",
      "name": "thread_search_index",
      "createSql": "CREATE TABLE thread_search_index(\n project_id TEXT NOT NULL,\n thread_id TEXT NOT NULL,\n kind TEXT NOT NULL CHECK(kind IN('thread_title','message')),\n message_id TEXT,\n content TEXT NOT NULL CHECK(length(content)>=1),\n occurred_at TEXT NOT NULL CHECK(occurred_at GLOB '????-??-??T??:??:??.???Z'),\n source_seq INTEGER NOT NULL CHECK(source_seq>=0),\n UNIQUE(project_id,thread_id,kind,message_id),\n CHECK((kind='thread_title' AND message_id IS NULL AND source_seq=0)\n    OR (kind='message' AND message_id IS NOT NULL AND source_seq>=1))\n)",
      "dependsOn": []
    },
    {
      "kind": "table",
      "name": "execution_merge_journals",
      "createSql": "CREATE TABLE execution_merge_journals(\n id TEXT PRIMARY KEY, project_id TEXT NOT NULL, execution_id TEXT NOT NULL, attempt_id TEXT NOT NULL,\n staged_result_id TEXT NOT NULL UNIQUE, merge_action_id TEXT NOT NULL UNIQUE, operation_id TEXT NOT NULL,\n status TEXT NOT NULL CHECK(status IN ('prepared','applying','db_committed','rolling_back','rolling_forward','manual_recovery','completed','resolved_old','resolved_new','abandoned')),\n next_file_position INTEGER NOT NULL DEFAULT 0 CHECK(next_file_position>=0),\n old_manifest_hash TEXT NOT NULL CHECK(length(old_manifest_hash)=64 AND old_manifest_hash NOT GLOB '*[^0-9a-f]*'),\n post_manifest_hash TEXT NOT NULL CHECK(length(post_manifest_hash)=64 AND post_manifest_hash NOT GLOB '*[^0-9a-f]*'),\n observed_manifest_hash TEXT CHECK(observed_manifest_hash IS NULL OR (length(observed_manifest_hash)=64 AND observed_manifest_hash NOT GLOB '*[^0-9a-f]*')),\n mismatch_phase TEXT, mismatch_path_key TEXT,\n journal_root TEXT NOT NULL CHECK(length(CAST(journal_root AS BLOB)) BETWEEN 1 AND 32767), error_code TEXT,\n created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z'),\n updated_at TEXT NOT NULL CHECK(updated_at GLOB '????-??-??T??:??:??.???Z'),\n UNIQUE(project_id,id),\n FOREIGN KEY(project_id,execution_id,attempt_id,staged_result_id) REFERENCES execution_staged_results(project_id,execution_id,attempt_id,id),\n FOREIGN KEY(project_id,execution_id,attempt_id,merge_action_id) REFERENCES execution_actions(project_id,execution_id,attempt_id,id),\n FOREIGN KEY(project_id,operation_id) REFERENCES execution_operations(project_id,id),\n FOREIGN KEY(project_id,operation_id,merge_action_id) REFERENCES execution_actions(project_id,operation_id,id),\n CHECK(status<>'manual_recovery' OR observed_manifest_hash IS NOT NULL)\n)",
      "dependsOn": []
    },
    {
      "kind": "table",
      "name": "execution_merge_files",
      "createSql": "CREATE TABLE execution_merge_files(\n journal_id TEXT NOT NULL REFERENCES execution_merge_journals(id) ON DELETE CASCADE,\n position INTEGER NOT NULL CHECK(position>=0),\n path TEXT NOT NULL CHECK(length(CAST(path AS BLOB)) BETWEEN 1 AND 4096),\n path_key TEXT NOT NULL CHECK(length(CAST(path_key AS BLOB)) BETWEEN 1 AND 4096),\n old_target_ref_json TEXT NOT NULL CHECK(json_valid(old_target_ref_json) AND length(CAST(old_target_ref_json AS BLOB))<=16384),\n post_target_ref_json TEXT CHECK(post_target_ref_json IS NULL OR (json_valid(post_target_ref_json) AND length(CAST(post_target_ref_json AS BLOB))<=16384)),\n backup_ref_json TEXT CHECK(backup_ref_json IS NULL OR (json_valid(backup_ref_json) AND length(CAST(backup_ref_json AS BLOB))<=16384)),\n durable_new_ref_json TEXT NOT NULL CHECK(json_valid(durable_new_ref_json) AND length(CAST(durable_new_ref_json AS BLOB))<=16384),\n canonical_temp_locator_json TEXT NOT NULL CHECK(json_valid(canonical_temp_locator_json) AND length(CAST(canonical_temp_locator_json AS BLOB))<=8192),\n canonical_temp_ref_json TEXT CHECK(canonical_temp_ref_json IS NULL OR (json_valid(canonical_temp_ref_json) AND length(CAST(canonical_temp_ref_json AS BLOB))<=16384)),\n status TEXT NOT NULL CHECK(status IN ('pending','temp_ready','applied','rolled_back','rolled_forward','verified')),\n PRIMARY KEY(journal_id,position), UNIQUE(journal_id,path_key),\n CHECK((status='pending' AND canonical_temp_ref_json IS NULL AND post_target_ref_json IS NULL)\n    OR (status<>'pending' AND canonical_temp_ref_json IS NOT NULL AND post_target_ref_json IS NOT NULL))\n)",
      "dependsOn": []
    },
    {
      "kind": "table",
      "name": "work_item_result_versions",
      "createSql": "CREATE TABLE work_item_result_versions(\n id TEXT PRIMARY KEY, project_id TEXT NOT NULL, mission_id TEXT NOT NULL,\n work_item_id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version>=1),\n execution_id TEXT NOT NULL UNIQUE, staged_result_id TEXT NOT NULL UNIQUE,\n merge_journal_id TEXT NOT NULL UNIQUE, supersedes_result_id TEXT,\n executor_agent_id TEXT NOT NULL, created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z'),\n UNIQUE(work_item_id,version), UNIQUE(work_item_id,id),\n FOREIGN KEY(project_id,mission_id,work_item_id,execution_id) REFERENCES executions(project_id,mission_id,work_item_id,id),\n FOREIGN KEY(work_item_id,supersedes_result_id) REFERENCES work_item_result_versions(work_item_id,id),\n FOREIGN KEY(project_id,executor_agent_id) REFERENCES project_memberships(project_id,agent_id)\n)",
      "dependsOn": []
    },
    {
      "kind": "table",
      "name": "work_item_review_heads",
      "createSql": "CREATE TABLE work_item_review_heads(\n work_item_id TEXT PRIMARY KEY REFERENCES work_items(id) ON DELETE CASCADE,\n project_id TEXT NOT NULL, mission_id TEXT NOT NULL, current_result_id TEXT,\n current_attempt_id TEXT,\n state TEXT NOT NULL CHECK(state IN ('executing','pending_review','reviewing','rework','waiting_owner','passed')),\n version INTEGER NOT NULL CHECK(version>=1),\n updated_at TEXT NOT NULL CHECK(updated_at GLOB '????-??-??T??:??:??.???Z'),\n FOREIGN KEY(project_id,mission_id) REFERENCES missions(project_id,id),\n FOREIGN KEY(mission_id,work_item_id) REFERENCES work_items(mission_id,id) ON DELETE CASCADE,\n FOREIGN KEY(work_item_id,current_result_id) REFERENCES work_item_result_versions(work_item_id,id)\n)",
      "dependsOn": []
    },
    {
      "kind": "table",
      "name": "review_operations",
      "createSql": "CREATE TABLE review_operations(\n id TEXT NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,\n kind TEXT NOT NULL CHECK(kind IN ('start_review','answer_escalation','generate_delivery','terminate_mission')),\n parent_id TEXT NOT NULL, request_hash TEXT NOT NULL CHECK(length(request_hash)=64 AND request_hash NOT GLOB '*[^0-9a-f]*'),\n status TEXT NOT NULL CHECK(status IN ('pending','completed')), http_status INTEGER,\n response_json TEXT CHECK(response_json IS NULL OR json_valid(response_json)),\n created_at TEXT NOT NULL,\n updated_at TEXT NOT NULL,\n PRIMARY KEY(project_id,id),\n CHECK((status='pending' AND http_status IS NULL AND response_json IS NULL)\n    OR (status='completed' AND http_status BETWEEN 100 AND 599 AND response_json IS NOT NULL))\n)",
      "dependsOn": []
    },
    {
      "kind": "table",
      "name": "review_attempts",
      "createSql": "CREATE TABLE review_attempts(\n id TEXT PRIMARY KEY, project_id TEXT NOT NULL, mission_id TEXT NOT NULL,\n work_item_id TEXT NOT NULL, result_id TEXT NOT NULL, reviewer_agent_id TEXT NOT NULL,\n operation_id TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN\n   ('calling','finalizing','rejected','escalated','passed','failed','interrupted','discarded')),\n lease_token TEXT NOT NULL, lease_expires_at TEXT NOT NULL CHECK(lease_expires_at GLOB '????-??-??T??:??:??.???Z'),\n frozen_material_json TEXT NOT NULL CHECK(json_valid(frozen_material_json)),\n frozen_material_hash TEXT NOT NULL CHECK(length(frozen_material_hash)=64 AND frozen_material_hash NOT GLOB '*[^0-9a-f]*'),\n prompt_hash TEXT NOT NULL CHECK(length(prompt_hash)=64 AND prompt_hash NOT GLOB '*[^0-9a-f]*'),\n provider_id TEXT NOT NULL, provider_version INTEGER NOT NULL CHECK(provider_version>=1),\n credential_generation INTEGER NOT NULL CHECK(credential_generation>=1),\n verified_at TEXT NOT NULL CHECK(verified_at GLOB '????-??-??T??:??:??.???Z'),\n model TEXT NOT NULL, parsed_output_json TEXT CHECK(parsed_output_json IS NULL OR json_valid(parsed_output_json)),\n parsed_output_hash TEXT, output_checkpointed_at TEXT, finalize_error_code TEXT, error_category TEXT,\n started_at TEXT NOT NULL CHECK(started_at GLOB '????-??-??T??:??:??.???Z'), finished_at TEXT,\n UNIQUE(project_id,operation_id),\n FOREIGN KEY(project_id,operation_id) REFERENCES review_operations(project_id,id),\n FOREIGN KEY(project_id,mission_id) REFERENCES missions(project_id,id),\n FOREIGN KEY(mission_id,work_item_id) REFERENCES work_items(mission_id,id),\n FOREIGN KEY(work_item_id,result_id) REFERENCES work_item_result_versions(work_item_id,id),\n FOREIGN KEY(project_id,reviewer_agent_id) REFERENCES project_memberships(project_id,agent_id),\n FOREIGN KEY(provider_id) REFERENCES providers(id),\n CHECK((parsed_output_json IS NULL AND parsed_output_hash IS NULL AND output_checkpointed_at IS NULL)\n    OR (parsed_output_json IS NOT NULL AND parsed_output_hash IS NOT NULL AND output_checkpointed_at IS NOT NULL)),\n CHECK(status<>'finalizing' OR parsed_output_json IS NOT NULL)\n)",
      "dependsOn": []
    },
    {
      "kind": "table",
      "name": "review_model_calls",
      "createSql": "CREATE TABLE review_model_calls(\n id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL REFERENCES review_attempts(id) ON DELETE CASCADE,\n kind TEXT NOT NULL CHECK(kind IN ('primary','repair')), call_index INTEGER NOT NULL CHECK(call_index IN (1,2)),\n status TEXT NOT NULL CHECK(status IN ('calling','succeeded','provider_failed','response_invalid','usage_invalid','interrupted','discarded')),\n prompt_hash TEXT NOT NULL CHECK(length(prompt_hash)=64 AND prompt_hash NOT GLOB '*[^0-9a-f]*'),\n prompt_tokens INTEGER CHECK(prompt_tokens IS NULL OR prompt_tokens>=0),\n completion_tokens INTEGER CHECK(completion_tokens IS NULL OR completion_tokens>=0),\n total_tokens INTEGER CHECK(total_tokens IS NULL OR total_tokens>=0), error_category TEXT,\n started_at TEXT NOT NULL CHECK(started_at GLOB '????-??-??T??:??:??.???Z'), finished_at TEXT,\n UNIQUE(attempt_id,call_index), CHECK(total_tokens IS NULL OR total_tokens=prompt_tokens+completion_tokens),\n CHECK((status='calling' AND finished_at IS NULL) OR (status<>'calling' AND finished_at IS NOT NULL))\n)",
      "dependsOn": []
    },
    {
      "kind": "table",
      "name": "review_decisions",
      "createSql": "CREATE TABLE review_decisions(\n id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL UNIQUE REFERENCES review_attempts(id),\n result_id TEXT NOT NULL, reviewer_agent_id TEXT NOT NULL,\n choice TEXT NOT NULL CHECK(choice IN ('reject','escalate','pass')), public_summary TEXT NOT NULL,\n findings_json TEXT NOT NULL CHECK(json_valid(findings_json)),\n evidence_refs_json TEXT NOT NULL CHECK(json_valid(evidence_refs_json)),\n limitations_json TEXT NOT NULL CHECK(json_valid(limitations_json)),\n created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z'),\n FOREIGN KEY(result_id) REFERENCES work_item_result_versions(id),\n FOREIGN KEY(reviewer_agent_id) REFERENCES agents(id)\n)",
      "dependsOn": []
    },
    {
      "kind": "table",
      "name": "memory_entries",
      "createSql": "CREATE TABLE memory_entries(\n id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,\n chain_id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version>=1),\n type TEXT NOT NULL CHECK(type IN ('goal','decision','fact','artifact','experience')),\n content TEXT NOT NULL, dedupe_hash TEXT NOT NULL CHECK(length(dedupe_hash)=64 AND dedupe_hash NOT GLOB '*[^0-9a-f]*'),\n source_type TEXT NOT NULL CHECK(source_type IN ('owner_input','work_item','artifact_path','task','result','review','validation','artifact')),\n source_id TEXT NOT NULL, source_version TEXT,\n proposer_actor_type TEXT NOT NULL CHECK(proposer_actor_type IN ('owner','agent')),\n proposer_actor_id TEXT, confirming_review_attempt_id TEXT,\n persistence_actor TEXT NOT NULL CHECK(persistence_actor='platform'), supersedes_id TEXT,\n created_at TEXT NOT NULL,\n UNIQUE(project_id,id), UNIQUE(chain_id,version), UNIQUE(project_id,supersedes_id),\n FOREIGN KEY(project_id,supersedes_id) REFERENCES memory_entries(project_id,id),\n FOREIGN KEY(confirming_review_attempt_id) REFERENCES review_attempts(id),\n CHECK((proposer_actor_type='owner' AND proposer_actor_id IS NULL AND confirming_review_attempt_id IS NULL)\n    OR (proposer_actor_type='agent' AND proposer_actor_id IS NOT NULL\n      AND confirming_review_attempt_id IS NOT NULL AND source_version IS NOT NULL))\n)",
      "dependsOn": []
    },
    {
      "kind": "table",
      "name": "review_memory_candidates",
      "createSql": "CREATE TABLE review_memory_candidates(\n id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL REFERENCES review_attempts(id),\n position INTEGER NOT NULL CHECK(position>=0), type TEXT NOT NULL CHECK(type IN ('decision','fact','artifact','experience')),\n content TEXT NOT NULL, source_type TEXT NOT NULL CHECK(source_type IN ('task','result','review','validation','artifact')),\n source_id TEXT NOT NULL, source_version TEXT NOT NULL, supersedes_memory_id TEXT,\n created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z'), UNIQUE(attempt_id,position)\n)",
      "dependsOn": []
    },
    {
      "kind": "table",
      "name": "review_memory_associations",
      "createSql": "CREATE TABLE review_memory_associations(\n candidate_id TEXT PRIMARY KEY REFERENCES review_memory_candidates(id),\n decision_id TEXT NOT NULL REFERENCES review_decisions(id), memory_id TEXT NOT NULL REFERENCES memory_entries(id),\n outcome TEXT NOT NULL CHECK(outcome IN ('reused','created','superseded')),\n created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z')\n)",
      "dependsOn": []
    },
    {
      "kind": "table",
      "name": "review_escalations",
      "createSql": "CREATE TABLE review_escalations(\n id TEXT PRIMARY KEY, decision_id TEXT NOT NULL UNIQUE REFERENCES review_decisions(id),\n work_item_id TEXT NOT NULL REFERENCES work_items(id), result_id TEXT NOT NULL REFERENCES work_item_result_versions(id),\n question TEXT NOT NULL, options_json TEXT NOT NULL CHECK(json_valid(options_json)),\n evidence_refs_json TEXT NOT NULL CHECK(json_valid(evidence_refs_json)),\n created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z')\n)",
      "dependsOn": []
    },
    {
      "kind": "table",
      "name": "review_escalation_answers",
      "createSql": "CREATE TABLE review_escalation_answers(\n id TEXT PRIMARY KEY, escalation_id TEXT NOT NULL UNIQUE REFERENCES review_escalations(id),\n operation_id TEXT NOT NULL, answer TEXT NOT NULL,\n action TEXT NOT NULL CHECK(action IN ('continue_review','rework','terminate_mission')),\n created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z')\n)",
      "dependsOn": []
    },
    {
      "kind": "table",
      "name": "mission_deliveries",
      "createSql": "CREATE TABLE mission_deliveries(\n id TEXT PRIMARY KEY, project_id TEXT NOT NULL, mission_id TEXT NOT NULL,\n version INTEGER NOT NULL CHECK(version>=1), input_fingerprint TEXT NOT NULL,\n summary_json TEXT NOT NULL CHECK(json_valid(summary_json)),\n evidence_manifest_json TEXT NOT NULL CHECK(json_valid(evidence_manifest_json)),\n supersedes_delivery_id TEXT, created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z'),\n UNIQUE(mission_id,version), UNIQUE(mission_id,id), UNIQUE(mission_id,input_fingerprint),\n FOREIGN KEY(mission_id,supersedes_delivery_id) REFERENCES mission_deliveries(mission_id,id),\n FOREIGN KEY(project_id,mission_id) REFERENCES missions(project_id,id)\n)",
      "dependsOn": []
    },
    {
      "kind": "table",
      "name": "mission_delivery_heads",
      "createSql": "CREATE TABLE mission_delivery_heads(\n mission_id TEXT PRIMARY KEY REFERENCES missions(id) ON DELETE CASCADE, project_id TEXT NOT NULL,\n context_version INTEGER NOT NULL CHECK(context_version>=1),\n state TEXT NOT NULL CHECK(state IN ('ongoing','generating','completed','owner_terminated')),\n current_delivery_id TEXT, current_operation_id TEXT, generation_lease_token TEXT,\n generation_lease_expires_at TEXT, last_error_code TEXT,\n next_event_sequence INTEGER NOT NULL CHECK(next_event_sequence>=1), version INTEGER NOT NULL CHECK(version>=1),\n updated_at TEXT NOT NULL,\n FOREIGN KEY(project_id,mission_id) REFERENCES missions(project_id,id),\n FOREIGN KEY(mission_id,current_delivery_id) REFERENCES mission_deliveries(mission_id,id),\n CHECK((state='generating' AND current_operation_id IS NOT NULL AND generation_lease_token IS NOT NULL\n    AND generation_lease_expires_at IS NOT NULL)\n   OR (state<>'generating' AND current_operation_id IS NULL AND generation_lease_token IS NULL\n    AND generation_lease_expires_at IS NULL)),\n CHECK((state='completed')=(current_delivery_id IS NOT NULL))\n)",
      "dependsOn": []
    },
    {
      "kind": "table",
      "name": "review_events",
      "createSql": "CREATE TABLE review_events(\n id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,\n mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,\n sequence INTEGER NOT NULL CHECK(sequence>=1), type TEXT NOT NULL,\n actor_type TEXT NOT NULL CHECK(actor_type IN ('owner','agent','system')), actor_id TEXT,\n payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),\n created_at TEXT NOT NULL, UNIQUE(mission_id,sequence),\n FOREIGN KEY(project_id,mission_id) REFERENCES missions(project_id,id)\n)",
      "dependsOn": []
    },
    {
      "kind": "table",
      "name": "collaboration_threads",
      "createSql": "CREATE TABLE collaboration_threads(\n id TEXT PRIMARY KEY,project_id TEXT NOT NULL,title TEXT NOT NULL CHECK(length(title)>=1 AND title=trim(title)),\n active_policy_revision_id TEXT NOT NULL,policy_version INTEGER NOT NULL CHECK(policy_version>=1),\n next_fact_sequence INTEGER NOT NULL CHECK(next_fact_sequence>=1),last_activity_sequence INTEGER NOT NULL CHECK(last_activity_sequence>=1),\n version INTEGER NOT NULL CHECK(version>=1),\n created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z'),\n updated_at TEXT NOT NULL CHECK(updated_at GLOB '????-??-??T??:??:??.???Z'),\n deleted_at TEXT CHECK(deleted_at IS NULL OR deleted_at GLOB '????-??-??T??:??:??.???Z'),\n UNIQUE(project_id,id),UNIQUE(project_id,last_activity_sequence),\n FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,\n FOREIGN KEY(project_id,id,active_policy_revision_id)\n  REFERENCES collaboration_thread_policy_revisions(project_id,thread_id,id)\n  ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED\n)",
      "dependsOn": []
    },
    {
      "kind": "table",
      "name": "collaboration_project_thread_sequences",
      "createSql": "CREATE TABLE collaboration_project_thread_sequences(\n project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,\n next_activity_sequence INTEGER NOT NULL CHECK(next_activity_sequence>=1)\n)",
      "dependsOn": []
    },
    {
      "kind": "table",
      "name": "collaboration_runs",
      "createSql": "CREATE TABLE collaboration_runs(\n id TEXT PRIMARY KEY,project_id TEXT NOT NULL,thread_id TEXT NOT NULL,\n status TEXT NOT NULL CHECK(status IN('running','waiting_owner','paused','failed','planned','stopped')),\n current_agent_id TEXT NOT NULL,round_count INTEGER NOT NULL DEFAULT 0 CHECK(round_count>=0),\n next_event_sequence INTEGER NOT NULL DEFAULT 1 CHECK(next_event_sequence>=1),\n version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),execution_epoch INTEGER NOT NULL DEFAULT 1 CHECK(execution_epoch>=1),\n pause_reason TEXT,pause_category TEXT,\n created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z'),\n updated_at TEXT NOT NULL CHECK(updated_at GLOB '????-??-??T??:??:??.???Z'),\n UNIQUE(project_id,id),UNIQUE(project_id,thread_id,id),\n FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,\n FOREIGN KEY(project_id,thread_id) REFERENCES collaboration_threads(project_id,id) ON DELETE CASCADE,\n FOREIGN KEY(current_agent_id) REFERENCES agents(id) ON DELETE NO ACTION\n)",
      "dependsOn": []
    },
    {
      "kind": "table",
      "name": "collaboration_thread_policy_revisions",
      "createSql": "CREATE TABLE collaboration_thread_policy_revisions(\n id TEXT PRIMARY KEY,project_id TEXT NOT NULL,thread_id TEXT NOT NULL,version INTEGER NOT NULL CHECK(version>=1),\n created_operation_id TEXT NOT NULL,\n created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z'),\n UNIQUE(project_id,thread_id,id),UNIQUE(project_id,thread_id,version),\n FOREIGN KEY(project_id,thread_id) REFERENCES collaboration_threads(project_id,id) ON DELETE CASCADE,\n FOREIGN KEY(project_id,thread_id,created_operation_id) REFERENCES collaboration_operations(project_id,thread_id,id)\n  ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED\n)",
      "dependsOn": []
    },
    {
      "kind": "table",
      "name": "collaboration_thread_policy_members",
      "createSql": "CREATE TABLE collaboration_thread_policy_members(\n project_id TEXT NOT NULL,thread_id TEXT NOT NULL,revision_id TEXT NOT NULL,position INTEGER NOT NULL CHECK(position>=0),\n agent_id TEXT NOT NULL,agent_display_name TEXT NOT NULL CHECK(length(agent_display_name)>=1),\n PRIMARY KEY(project_id,thread_id,revision_id,agent_id),UNIQUE(project_id,thread_id,revision_id,position),\n FOREIGN KEY(project_id,thread_id,revision_id) REFERENCES collaboration_thread_policy_revisions(project_id,thread_id,id) ON DELETE CASCADE\n)",
      "dependsOn": []
    },
    {
      "kind": "table",
      "name": "collaboration_project_sequences",
      "createSql": "CREATE TABLE collaboration_project_sequences(\n project_id TEXT NOT NULL,thread_id TEXT NOT NULL,next_message_sequence INTEGER NOT NULL DEFAULT 1 CHECK(next_message_sequence>=1),\n PRIMARY KEY(project_id,thread_id),\n FOREIGN KEY(project_id,thread_id) REFERENCES collaboration_threads(project_id,id) ON DELETE CASCADE\n)",
      "dependsOn": []
    },
    {
      "kind": "table",
      "name": "collaboration_messages",
      "createSql": "CREATE TABLE collaboration_messages(\n id TEXT PRIMARY KEY,project_id TEXT NOT NULL,thread_id TEXT NOT NULL,run_id TEXT,\n author_type TEXT NOT NULL CHECK(author_type IN('owner','agent')),author_agent_id TEXT,\n author_display_name TEXT NOT NULL CHECK(length(author_display_name)>=1),content TEXT NOT NULL CHECK(length(content)>=1),\n mention_agent_id TEXT,mention_display_name TEXT,sequence INTEGER NOT NULL CHECK(sequence>=1),\n reply_to_message_id TEXT,reply_to_sequence INTEGER CHECK(reply_to_sequence IS NULL OR reply_to_sequence>=1),\n reply_to_author_display_name TEXT,reply_to_excerpt TEXT,\n consumed_at TEXT CHECK(consumed_at IS NULL OR consumed_at GLOB '????-??-??T??:??:??.???Z'),\n created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z'),\n UNIQUE(project_id,thread_id,id),UNIQUE(project_id,thread_id,run_id,id),UNIQUE(project_id,thread_id,sequence),\n CHECK((author_type='owner' AND author_agent_id IS NULL) OR (author_type='agent' AND author_agent_id IS NOT NULL)),\n CHECK((mention_agent_id IS NULL AND mention_display_name IS NULL) OR\n       (mention_agent_id IS NOT NULL AND mention_display_name IS NOT NULL)),\n FOREIGN KEY(project_id,thread_id) REFERENCES collaboration_threads(project_id,id) ON DELETE CASCADE,\n FOREIGN KEY(project_id,thread_id,run_id) REFERENCES collaboration_runs(project_id,thread_id,id) ON DELETE NO ACTION,\n FOREIGN KEY(project_id,thread_id,reply_to_message_id)\n  REFERENCES collaboration_messages(project_id,thread_id,id) ON DELETE NO ACTION,\n FOREIGN KEY(author_agent_id) REFERENCES agents(id) ON DELETE NO ACTION,\n FOREIGN KEY(mention_agent_id) REFERENCES agents(id) ON DELETE NO ACTION\n)",
      "dependsOn": []
    },
    {
      "kind": "table",
      "name": "thread_drafts",
      "createSql": "CREATE TABLE thread_drafts(\n project_id TEXT NOT NULL,thread_id TEXT NOT NULL,\n content TEXT NOT NULL,\n attachments_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(attachments_json) AND json_type(attachments_json)='array' AND length(CAST(attachments_json AS BLOB))<=65536),\n reply_to_message_id TEXT,\n version INTEGER NOT NULL CHECK(version>=1),\n updated_at TEXT NOT NULL CHECK(updated_at GLOB '????-??-??T??:??:??.???Z'),\n PRIMARY KEY(project_id,thread_id),\n FOREIGN KEY(project_id,thread_id) REFERENCES collaboration_threads(project_id,id) ON DELETE CASCADE\n)",
      "dependsOn": []
    },
    {
      "kind": "table",
      "name": "thread_favorites",
      "createSql": "CREATE TABLE thread_favorites(\n project_id TEXT NOT NULL,thread_id TEXT NOT NULL,\n created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z'),\n PRIMARY KEY(project_id,thread_id),\n FOREIGN KEY(project_id,thread_id) REFERENCES collaboration_threads(project_id,id) ON DELETE CASCADE\n)",
      "dependsOn": []
    },
    {
      "kind": "table",
      "name": "input_history_entries",
      "createSql": "CREATE TABLE input_history_entries(\n id TEXT PRIMARY KEY,\n project_id TEXT NOT NULL,thread_id TEXT NOT NULL,\n content TEXT NOT NULL,\n created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z'),\n FOREIGN KEY(project_id,thread_id) REFERENCES collaboration_threads(project_id,id) ON DELETE CASCADE\n)",
      "dependsOn": []
    },
    {
      "kind": "table",
      "name": "input_history_clear_events",
      "createSql": "CREATE TABLE input_history_clear_events(\n id TEXT PRIMARY KEY,\n project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,\n cleared_at TEXT NOT NULL CHECK(cleared_at GLOB '????-??-??T??:??:??.???Z')\n)",
      "dependsOn": []
    },
    {
      "kind": "table",
      "name": "message_attachments",
      "createSql": "CREATE TABLE message_attachments(\n id TEXT PRIMARY KEY,\n project_id TEXT NOT NULL,thread_id TEXT NOT NULL,message_id TEXT,\n file_name TEXT NOT NULL CHECK(length(CAST(file_name AS BLOB)) BETWEEN 1 AND 1024),\n size INTEGER NOT NULL CHECK(size BETWEEN 1 AND 5242880),\n mime_type TEXT NOT NULL CHECK(mime_type IN('image/png','image/jpeg','image/gif','image/webp')),\n sha256 TEXT NOT NULL CHECK(length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*'),\n storage_relpath TEXT NOT NULL CHECK(length(CAST(storage_relpath AS BLOB)) BETWEEN 1 AND 512),\n status TEXT NOT NULL CHECK(status IN('uploaded','linked')),\n created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z'),\n linked_at TEXT CHECK(linked_at IS NULL OR linked_at GLOB '????-??-??T??:??:??.???Z'),\n UNIQUE(project_id,thread_id,id),UNIQUE(thread_id,sha256),\n CHECK((status='uploaded' AND message_id IS NULL AND linked_at IS NULL)\n    OR (status='linked' AND message_id IS NOT NULL AND linked_at IS NOT NULL)),\n FOREIGN KEY(project_id,thread_id) REFERENCES collaboration_threads(project_id,id) ON DELETE CASCADE,\n FOREIGN KEY(project_id,thread_id,message_id) REFERENCES collaboration_messages(project_id,thread_id,id) ON DELETE NO ACTION\n)",
      "dependsOn": []
    },
    {
      "kind": "table",
      "name": "attachment_events",
      "createSql": "CREATE TABLE attachment_events(\n id TEXT PRIMARY KEY,\n project_id TEXT NOT NULL,thread_id TEXT NOT NULL,attachment_id TEXT NOT NULL,\n type TEXT NOT NULL CHECK(type IN('uploaded','linked','removed')),\n created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z'),\n FOREIGN KEY(project_id,thread_id) REFERENCES collaboration_threads(project_id,id) ON DELETE CASCADE\n)",
      "dependsOn": []
    },
    {
      "kind": "table",
      "name": "collaboration_attempts",
      "createSql": "CREATE TABLE collaboration_attempts(\n id TEXT PRIMARY KEY,project_id TEXT NOT NULL,thread_id TEXT NOT NULL,run_id TEXT NOT NULL,agent_id TEXT NOT NULL,\n operation_id TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN('calling','committed','failed','interrupted','discarded')),\n lease_token TEXT NOT NULL,lease_expires_at TEXT NOT NULL CHECK(lease_expires_at GLOB '????-??-??T??:??:??.???Z'),\n prompt_hash TEXT NOT NULL,acquire_execution_epoch INTEGER NOT NULL CHECK(acquire_execution_epoch>=1),\n acquire_context_hash TEXT NOT NULL,included_message_sequence INTEGER NOT NULL CHECK(included_message_sequence>=0),\n error_category TEXT,failure_provider_id TEXT,\n failure_provider_version INTEGER CHECK(failure_provider_version IS NULL OR failure_provider_version>=1),\n failure_credential_version INTEGER CHECK(failure_credential_version IS NULL OR failure_credential_version>=1),\n failure_credential_generation INTEGER CHECK(failure_credential_generation IS NULL OR failure_credential_generation>=1),\n failure_verified_at TEXT CHECK(failure_verified_at IS NULL OR failure_verified_at GLOB '????-??-??T??:??:??.???Z'),\n started_at TEXT NOT NULL CHECK(started_at GLOB '????-??-??T??:??:??.???Z'),\n finished_at TEXT CHECK(finished_at IS NULL OR finished_at GLOB '????-??-??T??:??:??.???Z'),\n UNIQUE(project_id,thread_id,id),UNIQUE(project_id,thread_id,run_id,id),\n UNIQUE(project_id,thread_id,run_id,operation_id),\n CHECK((status='calling' AND finished_at IS NULL) OR (status<>'calling' AND finished_at IS NOT NULL)),\n FOREIGN KEY(project_id,thread_id) REFERENCES collaboration_threads(project_id,id) ON DELETE CASCADE,\n FOREIGN KEY(project_id,thread_id,run_id) REFERENCES collaboration_runs(project_id,thread_id,id) ON DELETE CASCADE,\n FOREIGN KEY(project_id,thread_id,run_id,operation_id)\n  REFERENCES collaboration_operations(project_id,thread_id,run_id,id) ON DELETE NO ACTION,\n FOREIGN KEY(agent_id) REFERENCES agents(id) ON DELETE NO ACTION\n)",
      "dependsOn": []
    },
    {
      "kind": "table",
      "name": "collaboration_model_calls",
      "createSql": "CREATE TABLE collaboration_model_calls(\n id TEXT PRIMARY KEY,attempt_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN('primary','repair')),\n call_index INTEGER NOT NULL CHECK(call_index IN(1,2)),\n status TEXT NOT NULL CHECK(status IN('succeeded','provider_failed','response_invalid','usage_invalid')),\n prompt_tokens INTEGER CHECK(prompt_tokens IS NULL OR prompt_tokens>=0),\n completion_tokens INTEGER CHECK(completion_tokens IS NULL OR completion_tokens>=0),\n total_tokens INTEGER CHECK(total_tokens IS NULL OR total_tokens>=0),error_category TEXT,\n created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z'),\n UNIQUE(attempt_id,call_index),\n CHECK((prompt_tokens IS NULL AND completion_tokens IS NULL AND total_tokens IS NULL) OR\n       (prompt_tokens IS NOT NULL AND completion_tokens IS NOT NULL AND total_tokens=prompt_tokens+completion_tokens)),\n FOREIGN KEY(attempt_id) REFERENCES collaboration_attempts(id) ON DELETE CASCADE\n)",
      "dependsOn": []
    },
    {
      "kind": "table",
      "name": "collaboration_turns",
      "createSql": "CREATE TABLE collaboration_turns(\n id TEXT PRIMARY KEY,project_id TEXT NOT NULL,thread_id TEXT NOT NULL,attempt_id TEXT NOT NULL,\n run_id TEXT NOT NULL,agent_id TEXT NOT NULL,round_number INTEGER NOT NULL CHECK(round_number>=1),\n message_id TEXT NOT NULL,disposition TEXT NOT NULL CHECK(disposition IN('handoff','decision_request','plan_ready')),\n created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z'),\n UNIQUE(project_id,thread_id,id),UNIQUE(project_id,thread_id,run_id,id),\n UNIQUE(attempt_id),UNIQUE(message_id),UNIQUE(run_id,round_number),\n FOREIGN KEY(project_id,thread_id,run_id,attempt_id)\n  REFERENCES collaboration_attempts(project_id,thread_id,run_id,id) ON DELETE NO ACTION,\n FOREIGN KEY(project_id,thread_id,run_id) REFERENCES collaboration_runs(project_id,thread_id,id) ON DELETE CASCADE,\n FOREIGN KEY(project_id,thread_id,run_id,message_id)\n  REFERENCES collaboration_messages(project_id,thread_id,run_id,id) ON DELETE NO ACTION,\n FOREIGN KEY(agent_id) REFERENCES agents(id) ON DELETE NO ACTION\n)",
      "dependsOn": []
    },
    {
      "kind": "table",
      "name": "decision_requests",
      "createSql": "CREATE TABLE decision_requests(\n id TEXT PRIMARY KEY,project_id TEXT NOT NULL,thread_id TEXT NOT NULL,run_id TEXT NOT NULL,turn_id TEXT NOT NULL,\n requesting_agent_id TEXT NOT NULL,question TEXT NOT NULL CHECK(length(question)>=1),\n options_json TEXT NOT NULL CHECK(json_valid(options_json) AND json_type(options_json)='array' AND json_array_length(options_json) BETWEEN 2 AND 8),\n status TEXT NOT NULL CHECK(status IN('open','answered')),answer TEXT,answer_message_id TEXT,\n version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),\n created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z'),\n answered_at TEXT CHECK(answered_at IS NULL OR answered_at GLOB '????-??-??T??:??:??.???Z'),\n UNIQUE(project_id,thread_id,run_id,id),UNIQUE(turn_id),\n CHECK((status='open' AND answer IS NULL AND answer_message_id IS NULL AND answered_at IS NULL) OR\n       (status='answered' AND length(answer)>=1 AND answer_message_id IS NOT NULL AND answered_at IS NOT NULL)),\n FOREIGN KEY(project_id,thread_id,run_id) REFERENCES collaboration_runs(project_id,thread_id,id) ON DELETE CASCADE,\n FOREIGN KEY(project_id,thread_id,run_id,turn_id)\n  REFERENCES collaboration_turns(project_id,thread_id,run_id,id) ON DELETE NO ACTION,\n FOREIGN KEY(project_id,thread_id,run_id,answer_message_id)\n  REFERENCES collaboration_messages(project_id,thread_id,run_id,id) ON DELETE NO ACTION,\n FOREIGN KEY(requesting_agent_id) REFERENCES agents(id) ON DELETE NO ACTION\n)",
      "dependsOn": []
    },
    {
      "kind": "table",
      "name": "collaboration_events",
      "createSql": "CREATE TABLE collaboration_events(\n id TEXT PRIMARY KEY,project_id TEXT NOT NULL,thread_id TEXT NOT NULL,run_id TEXT NOT NULL,\n sequence INTEGER NOT NULL CHECK(sequence>=1),\n type TEXT NOT NULL CHECK(type IN('run_started','owner_message','agent_message','model_call_started','model_call_succeeded','model_call_failed','usage_recorded','tasks_created','task_claimed','handoff','decision_requested','decision_answered','boundary_paused','run_paused','run_resumed','run_retried','run_planned','run_stopped','attempt_interrupted','action_rejected','context_changed')),\n actor_type TEXT NOT NULL CHECK(actor_type IN('owner','agent','system')),actor_id TEXT,\n payload_json TEXT NOT NULL CHECK(json_valid(payload_json) AND length(CAST(payload_json AS BLOB))<=65536),\n created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z'),\n UNIQUE(project_id,thread_id,run_id,id),UNIQUE(run_id,sequence),\n FOREIGN KEY(project_id,thread_id,run_id) REFERENCES collaboration_runs(project_id,thread_id,id) ON DELETE CASCADE\n)",
      "dependsOn": []
    },
    {
      "kind": "table",
      "name": "executions",
      "createSql": "CREATE TABLE executions(\n id TEXT PRIMARY KEY, project_id TEXT NOT NULL,\n source_collaboration_thread_id TEXT NOT NULL, source_collaboration_run_id TEXT NOT NULL,\n mission_id TEXT NOT NULL, work_item_id TEXT NOT NULL,\n agent_id TEXT NOT NULL, current_policy_revision_id TEXT NOT NULL,\n status TEXT NOT NULL CHECK(status IN ('queued','running','waiting_approval','paused','staged','stale','conflicted','failed','stopped','merged')),\n resume_target TEXT CHECK(resume_target IS NULL OR resume_target IN ('queued','running','waiting_approval')),\n reason_code TEXT,\n manual_recovery_required INTEGER NOT NULL DEFAULT 0 CHECK(manual_recovery_required IN (0,1)),\n recovery_resolution TEXT CHECK(recovery_resolution IS NULL OR recovery_resolution IN ('recovered_old','recovered_new','abandoned')),\n current_attempt_no INTEGER NOT NULL CHECK(current_attempt_no>=1),\n business_round_count INTEGER NOT NULL DEFAULT 0 CHECK(business_round_count>=0),\n tool_call_count INTEGER NOT NULL DEFAULT 0 CHECK(tool_call_count>=0),\n next_event_sequence INTEGER NOT NULL DEFAULT 1 CHECK(next_event_sequence>=1),\n version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),\n created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z'),\n business_deadline_at TEXT CHECK(business_deadline_at IS NULL OR business_deadline_at GLOB '????-??-??T??:??:??.???Z'),\n first_running_at TEXT CHECK(first_running_at IS NULL OR first_running_at GLOB '????-??-??T??:??:??.???Z'),\n updated_at TEXT NOT NULL CHECK(updated_at GLOB '????-??-??T??:??:??.???Z'),\n merged_at TEXT CHECK(merged_at IS NULL OR merged_at GLOB '????-??-??T??:??:??.???Z'),\n UNIQUE(project_id,id), UNIQUE(project_id,mission_id,work_item_id,id),\n FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,\n FOREIGN KEY(project_id,source_collaboration_thread_id,source_collaboration_run_id)\n  REFERENCES collaboration_runs(project_id,thread_id,id),\n FOREIGN KEY(project_id,mission_id) REFERENCES missions(project_id,id),\n FOREIGN KEY(mission_id,work_item_id) REFERENCES work_items(mission_id,id),\n FOREIGN KEY(project_id,agent_id) REFERENCES project_memberships(project_id,agent_id),\n FOREIGN KEY(project_id,current_policy_revision_id) REFERENCES project_validation_policy_revisions(project_id,id),\n CHECK((manual_recovery_required=1 AND status='conflicted' AND recovery_resolution IS NULL) OR manual_recovery_required=0),\n CHECK((status='merged') = (merged_at IS NOT NULL)),\n CHECK((first_running_at IS NULL AND business_deadline_at IS NULL) OR (first_running_at IS NOT NULL AND business_deadline_at IS NOT NULL))\n)",
      "dependsOn": []
    },
    {
      "kind": "table",
      "name": "collaboration_operations",
      "createSql": "CREATE TABLE collaboration_operations(\n id TEXT NOT NULL,project_id TEXT NOT NULL,thread_id TEXT NOT NULL,run_id TEXT,\n kind TEXT NOT NULL CHECK(kind IN('thread_create','policy_update','start','message','control','answer_decision','advance','recover','inline_decision')),\n request_hash TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN('pending','completed','version_conflict')),\n http_status INTEGER,response_json TEXT,response_schema_version INTEGER,\n lease_applicability TEXT CHECK(lease_applicability IS NULL OR lease_applicability='not_applicable'),\n lease_id TEXT,\n created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z'),\n updated_at TEXT NOT NULL CHECK(updated_at GLOB '????-??-??T??:??:??.???Z'),\n PRIMARY KEY(project_id,id),UNIQUE(project_id,thread_id,id),UNIQUE(project_id,thread_id,run_id,id),\n UNIQUE(project_id,thread_id,id,request_hash),\n CHECK(\n  (kind<>'inline_decision' AND lease_applicability IS NULL AND lease_id IS NULL AND (\n    (kind='advance' AND status='pending' AND http_status IS NULL AND response_json IS NULL AND response_schema_version IS NULL) OR\n    (status='completed' AND http_status BETWEEN 100 AND 599 AND json_valid(response_json)\n     AND length(CAST(response_json AS BLOB))<=262144 AND response_schema_version=7)\n  )) OR\n  (kind='inline_decision' AND lease_applicability='not_applicable' AND lease_id IS NULL AND (\n    (status='completed' AND http_status=200 AND json_valid(response_json) AND response_schema_version=8) OR\n    (status='version_conflict' AND http_status=409 AND json_valid(response_json) AND response_schema_version=8)\n  ))\n ),\n FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,\n FOREIGN KEY(project_id,thread_id) REFERENCES collaboration_threads(project_id,id)\n  ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,\n FOREIGN KEY(project_id,thread_id,run_id) REFERENCES collaboration_runs(project_id,thread_id,id) ON DELETE CASCADE\n)",
      "dependsOn": []
    },
    {
      "kind": "table",
      "name": "collaboration_thread_facts",
      "createSql": "CREATE TABLE collaboration_thread_facts(\n id TEXT PRIMARY KEY,project_id TEXT NOT NULL,thread_id TEXT NOT NULL,sequence INTEGER NOT NULL CHECK(sequence>=1),\n activity_sequence INTEGER NOT NULL CHECK(activity_sequence>=1),\n type TEXT NOT NULL CHECK(type IN('thread_created','policy_changed','owner_message','agent_message','run_linked','run_event','inline_decision')),\n actor_type TEXT NOT NULL CHECK(actor_type IN('owner','agent','system')),actor_id TEXT,\n run_id TEXT,message_id TEXT,run_event_id TEXT,policy_revision_id TEXT,\n inline_decision_id TEXT,business_receipt_id TEXT,\n payload_json TEXT NOT NULL CHECK(json_valid(payload_json) AND length(CAST(payload_json AS BLOB))<=65536),\n created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z'),\n UNIQUE(project_id,thread_id,id),UNIQUE(project_id,thread_id,sequence),UNIQUE(project_id,activity_sequence),\n FOREIGN KEY(project_id,thread_id) REFERENCES collaboration_threads(project_id,id) ON DELETE CASCADE,\n FOREIGN KEY(project_id,thread_id,run_id) REFERENCES collaboration_runs(project_id,thread_id,id) ON DELETE NO ACTION,\n FOREIGN KEY(project_id,thread_id,message_id) REFERENCES collaboration_messages(project_id,thread_id,id) ON DELETE NO ACTION,\n FOREIGN KEY(project_id,thread_id,run_id,message_id) REFERENCES collaboration_messages(project_id,thread_id,run_id,id) ON DELETE NO ACTION,\n FOREIGN KEY(project_id,thread_id,run_id,run_event_id) REFERENCES collaboration_events(project_id,thread_id,run_id,id) ON DELETE NO ACTION,\n FOREIGN KEY(project_id,thread_id,policy_revision_id) REFERENCES collaboration_thread_policy_revisions(project_id,thread_id,id) ON DELETE NO ACTION,\n FOREIGN KEY(project_id,thread_id,inline_decision_id) REFERENCES inline_decisions(project_id,thread_id,id) ON DELETE NO ACTION,\n FOREIGN KEY(project_id,thread_id,business_receipt_id,inline_decision_id)\n  REFERENCES business_action_receipts(project_id,thread_id,id,decision_id) ON DELETE NO ACTION,\n CHECK(\n  (type='thread_created' AND run_id IS NULL AND message_id IS NULL AND run_event_id IS NULL AND policy_revision_id IS NULL AND inline_decision_id IS NULL AND business_receipt_id IS NULL) OR\n  (type='policy_changed' AND run_id IS NULL AND message_id IS NULL AND run_event_id IS NULL AND policy_revision_id IS NOT NULL AND inline_decision_id IS NULL AND business_receipt_id IS NULL) OR\n  (type IN('owner_message','agent_message') AND message_id IS NOT NULL AND run_event_id IS NULL AND policy_revision_id IS NULL AND inline_decision_id IS NULL AND business_receipt_id IS NULL) OR\n  (type='run_linked' AND run_id IS NOT NULL AND message_id IS NULL AND run_event_id IS NULL AND policy_revision_id IS NULL AND inline_decision_id IS NULL AND business_receipt_id IS NULL) OR\n  (type='run_event' AND run_id IS NOT NULL AND message_id IS NULL AND run_event_id IS NOT NULL AND policy_revision_id IS NULL AND inline_decision_id IS NULL AND business_receipt_id IS NULL) OR\n  (type='inline_decision' AND message_id IS NULL AND run_event_id IS NULL AND policy_revision_id IS NULL AND inline_decision_id IS NOT NULL AND business_receipt_id IS NOT NULL)\n )\n)",
      "dependsOn": []
    },
    {
      "kind": "table",
      "name": "structured_message_blocks",
      "createSql": "CREATE TABLE structured_message_blocks(\n id TEXT PRIMARY KEY,project_id TEXT NOT NULL,thread_id TEXT NOT NULL,run_id TEXT,message_id TEXT NOT NULL,\n logical_block_id TEXT NOT NULL,block_type TEXT NOT NULL CHECK(block_type IN('proposal','checklist','diff_preview','file_reference','handoff_card')),\n block_schema_version INTEGER NOT NULL CHECK(block_schema_version>=1),\n block_revision INTEGER NOT NULL CHECK(block_revision>=1),position INTEGER NOT NULL CHECK(position>=0),\n payload_json TEXT NOT NULL CHECK(json_valid(payload_json) AND length(CAST(payload_json AS BLOB))<=65536),\n payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64),\n actor_type TEXT NOT NULL CHECK(actor_type IN('owner','agent')),actor_id TEXT,actor_display_name TEXT NOT NULL CHECK(length(actor_display_name)>=1),\n source_kind TEXT NOT NULL CHECK(source_kind IN('message','artifact','execution','handoff')),\n source_id TEXT NOT NULL,source_entity_version TEXT,\n created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z'),\n UNIQUE(project_id,thread_id,id),UNIQUE(project_id,thread_id,id,block_revision),\n UNIQUE(project_id,thread_id,message_id,position),\n UNIQUE(project_id,thread_id,logical_block_id,block_revision),\n CHECK((actor_type='owner' AND actor_id IS NULL) OR (actor_type='agent' AND actor_id IS NOT NULL)),\n CHECK((source_kind='message' AND source_entity_version IS NULL) OR (source_kind<>'message' AND source_entity_version IS NOT NULL)),\n FOREIGN KEY(project_id,thread_id,message_id) REFERENCES collaboration_messages(project_id,thread_id,id) ON DELETE NO ACTION,\n FOREIGN KEY(project_id,thread_id,run_id,message_id) REFERENCES collaboration_messages(project_id,thread_id,run_id,id) ON DELETE NO ACTION,\n FOREIGN KEY(actor_id) REFERENCES agents(id) ON DELETE NO ACTION\n)",
      "dependsOn": []
    },
    {
      "kind": "table",
      "name": "structured_message_state_revisions",
      "createSql": "CREATE TABLE structured_message_state_revisions(\n project_id TEXT NOT NULL,thread_id TEXT NOT NULL,block_id TEXT NOT NULL,\n state_version INTEGER NOT NULL CHECK(state_version>=1),\n prior_state_version INTEGER,\n state_kind TEXT NOT NULL CHECK(state_kind IN('proposal','checklist','read_only')),\n state_json TEXT NOT NULL CHECK(json_valid(state_json) AND json_type(state_json)='object'),\n created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z'),\n PRIMARY KEY(project_id,thread_id,block_id,state_version),\n CHECK((state_version=1 AND prior_state_version IS NULL) OR (state_version>1 AND prior_state_version=state_version-1)),\n FOREIGN KEY(project_id,thread_id,block_id) REFERENCES structured_message_blocks(project_id,thread_id,id) ON DELETE CASCADE,\n FOREIGN KEY(project_id,thread_id,block_id,prior_state_version)\n  REFERENCES structured_message_state_revisions(project_id,thread_id,block_id,state_version)\n  ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED\n)",
      "dependsOn": []
    },
    {
      "kind": "table",
      "name": "structured_message_state_heads",
      "createSql": "CREATE TABLE structured_message_state_heads(\n project_id TEXT NOT NULL,thread_id TEXT NOT NULL,block_id TEXT NOT NULL,\n current_state_version INTEGER NOT NULL CHECK(current_state_version>=1),\n PRIMARY KEY(project_id,thread_id,block_id),\n FOREIGN KEY(project_id,thread_id,block_id,current_state_version)\n  REFERENCES structured_message_state_revisions(project_id,thread_id,block_id,state_version)\n  ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED\n)",
      "dependsOn": []
    },
    {
      "kind": "table",
      "name": "inline_decisions",
      "createSql": "CREATE TABLE inline_decisions(\n id TEXT PRIMARY KEY,project_id TEXT NOT NULL,thread_id TEXT NOT NULL,run_id TEXT,\n operation_id TEXT NOT NULL,block_id TEXT NOT NULL,block_revision INTEGER NOT NULL,\n decision_schema_version INTEGER NOT NULL CHECK(decision_schema_version=1),\n from_state_version INTEGER NOT NULL CHECK(from_state_version>=1),\n to_state_version INTEGER NOT NULL CHECK(to_state_version=from_state_version+1),\n action TEXT NOT NULL CHECK(action IN('accept','reject','check_item','uncheck_item')),\n item_id TEXT,actor_type TEXT NOT NULL CHECK(actor_type='owner'),actor_id TEXT,\n created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z'),\n UNIQUE(project_id,thread_id,id),UNIQUE(project_id,thread_id,operation_id),UNIQUE(project_id,thread_id,block_id,to_state_version),\n UNIQUE(project_id,thread_id,id,operation_id,block_id,block_revision,from_state_version,to_state_version),\n CHECK((action IN('accept','reject') AND item_id IS NULL) OR (action IN('check_item','uncheck_item') AND item_id IS NOT NULL)),\n FOREIGN KEY(project_id,thread_id,operation_id) REFERENCES collaboration_operations(project_id,thread_id,id) ON DELETE NO ACTION,\n FOREIGN KEY(project_id,thread_id,block_id,block_revision)\n  REFERENCES structured_message_blocks(project_id,thread_id,id,block_revision) ON DELETE NO ACTION,\n FOREIGN KEY(project_id,thread_id,block_id,from_state_version) REFERENCES structured_message_state_revisions(project_id,thread_id,block_id,state_version) ON DELETE NO ACTION,\n FOREIGN KEY(project_id,thread_id,block_id,to_state_version) REFERENCES structured_message_state_revisions(project_id,thread_id,block_id,state_version) ON DELETE NO ACTION\n)",
      "dependsOn": []
    },
    {
      "kind": "table",
      "name": "business_action_receipts",
      "createSql": "CREATE TABLE business_action_receipts(\n id TEXT PRIMARY KEY,project_id TEXT NOT NULL,thread_id TEXT NOT NULL,run_id TEXT,\n decision_id TEXT NOT NULL,operation_id TEXT NOT NULL,request_hash TEXT NOT NULL,\n receipt_schema_version INTEGER NOT NULL CHECK(receipt_schema_version=1),\n block_id TEXT NOT NULL,block_revision INTEGER NOT NULL,\n from_state_version INTEGER NOT NULL,to_state_version INTEGER NOT NULL,\n result_json TEXT NOT NULL CHECK(json_valid(result_json) AND json_type(result_json)='object'),\n created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z'),\n UNIQUE(project_id,thread_id,id),UNIQUE(project_id,thread_id,id,decision_id),\n UNIQUE(project_id,thread_id,decision_id),UNIQUE(project_id,thread_id,operation_id),\n FOREIGN KEY(project_id,thread_id,decision_id,operation_id,block_id,block_revision,from_state_version,to_state_version)\n  REFERENCES inline_decisions(project_id,thread_id,id,operation_id,block_id,block_revision,from_state_version,to_state_version)\n  ON DELETE NO ACTION,\n FOREIGN KEY(project_id,thread_id,operation_id,request_hash)\n  REFERENCES collaboration_operations(project_id,thread_id,id,request_hash) ON DELETE NO ACTION,\n FOREIGN KEY(project_id,thread_id,block_id,to_state_version) REFERENCES structured_message_state_revisions(project_id,thread_id,block_id,state_version) ON DELETE NO ACTION\n)",
      "dependsOn": []
    },
    {
      "kind": "table",
      "name": "thread_tags",
      "createSql": "CREATE TABLE thread_tags(\n id TEXT PRIMARY KEY,project_id TEXT NOT NULL,\n name TEXT NOT NULL CHECK(length(name)>=1 AND name=trim(name)),\n name_key TEXT NOT NULL CHECK(length(name_key)>=1),\n created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z'),\n UNIQUE(project_id,id),UNIQUE(project_id,name_key),\n FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE\n)",
      "dependsOn": []
    },
    {
      "kind": "table",
      "name": "thread_tag_edges",
      "createSql": "CREATE TABLE thread_tag_edges(\n project_id TEXT NOT NULL,thread_id TEXT NOT NULL,tag_id TEXT NOT NULL,\n created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z'),\n PRIMARY KEY(project_id,thread_id,tag_id),\n FOREIGN KEY(project_id,thread_id) REFERENCES collaboration_threads(project_id,id) ON DELETE CASCADE,\n FOREIGN KEY(project_id,tag_id) REFERENCES thread_tags(project_id,id) ON DELETE CASCADE\n)",
      "dependsOn": []
    },
    {
      "kind": "table",
      "name": "thread_tag_operations",
      "createSql": "CREATE TABLE thread_tag_operations(\n id TEXT NOT NULL,project_id TEXT NOT NULL,\n kind TEXT NOT NULL CHECK(kind='tag_batch'),\n request_hash TEXT NOT NULL CHECK(length(request_hash)=64 AND request_hash NOT GLOB '*[^0-9a-f]*'),\n status TEXT NOT NULL CHECK(status='completed'),\n http_status INTEGER,\n response_json TEXT CHECK(json_valid(response_json)),\n created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z'),\n PRIMARY KEY(project_id,id),UNIQUE(project_id,id,request_hash),\n FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE\n)",
      "dependsOn": []
    },
    {
      "kind": "table",
      "name": "thread_purge_markers",
      "createSql": "CREATE TABLE thread_purge_markers(\n project_id TEXT NOT NULL,thread_id TEXT NOT NULL,\n created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z'),\n PRIMARY KEY(project_id,thread_id),\n FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE\n)",
      "dependsOn": []
    },
    {
      "kind": "table",
      "name": "thread_message_queue",
      "createSql": "CREATE TABLE thread_message_queue(\n id TEXT PRIMARY KEY,project_id TEXT NOT NULL,thread_id TEXT NOT NULL,\n content TEXT NOT NULL CHECK(length(content)>=1),\n position INTEGER NOT NULL CHECK(position>=1),\n status TEXT NOT NULL CHECK(status IN('pending','consumed','cancelled')),\n operation_id TEXT NOT NULL,\n created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z'),\n updated_at TEXT NOT NULL CHECK(updated_at GLOB '????-??-??T??:??:??.???Z'),\n UNIQUE(project_id,thread_id,position),\n FOREIGN KEY(project_id,thread_id) REFERENCES collaboration_threads(project_id,id) ON DELETE CASCADE\n)",
      "dependsOn": []
    },
    {
      "kind": "index",
      "name": "thread_message_queue_pending_idx",
      "createSql": "CREATE INDEX thread_message_queue_pending_idx\n ON thread_message_queue(project_id,thread_id,position,id)\n WHERE status='pending'",
      "dependsOn": [
        "thread_message_queue"
      ]
    },
    {
      "kind": "index",
      "name": "agents_provider_id_idx",
      "createSql": "CREATE INDEX agents_provider_id_idx ON agents(provider_id)",
      "dependsOn": [
        "agents"
      ]
    },
    {
      "kind": "index",
      "name": "agent_skills_skill_id_idx",
      "createSql": "CREATE INDEX agent_skills_skill_id_idx ON agent_skills(skill_id)",
      "dependsOn": [
        "agent_skills"
      ]
    },
    {
      "kind": "index",
      "name": "projects_workspace_key_unique",
      "createSql": "CREATE UNIQUE INDEX projects_workspace_key_unique\n    ON projects(workspace_key) WHERE workspace_key IS NOT NULL",
      "dependsOn": [
        "projects"
      ]
    },
    {
      "kind": "index",
      "name": "missions_project_id_id",
      "createSql": "CREATE UNIQUE INDEX missions_project_id_id ON missions(project_id,id)",
      "dependsOn": [
        "missions"
      ]
    },
    {
      "kind": "index",
      "name": "work_items_mission_id_id",
      "createSql": "CREATE UNIQUE INDEX work_items_mission_id_id ON work_items(mission_id,id)",
      "dependsOn": [
        "work_items"
      ]
    },
    {
      "kind": "index",
      "name": "execution_one_acting_attempt",
      "createSql": "CREATE UNIQUE INDEX execution_one_acting_attempt ON execution_attempts(execution_id) WHERE status='acting'",
      "dependsOn": [
        "execution_attempts"
      ]
    },
    {
      "kind": "index",
      "name": "execution_actions_execution_status",
      "createSql": "CREATE INDEX execution_actions_execution_status ON execution_actions(execution_id,status,created_at,id)",
      "dependsOn": [
        "execution_actions"
      ]
    },
    {
      "kind": "index",
      "name": "execution_actions_expiry",
      "createSql": "CREATE INDEX execution_actions_expiry ON execution_actions(project_id,status,lease_expires_at,id)",
      "dependsOn": [
        "execution_actions"
      ]
    },
    {
      "kind": "index",
      "name": "execution_one_running_action",
      "createSql": "CREATE UNIQUE INDEX execution_one_running_action ON execution_actions(execution_id) WHERE status='running'",
      "dependsOn": [
        "execution_actions"
      ]
    },
    {
      "kind": "index",
      "name": "execution_operation_one_running_action",
      "createSql": "CREATE UNIQUE INDEX execution_operation_one_running_action ON execution_actions(project_id,operation_id) WHERE status='running'",
      "dependsOn": [
        "execution_actions"
      ]
    },
    {
      "kind": "index",
      "name": "validation_policy_revisions_page",
      "createSql": "CREATE INDEX validation_policy_revisions_page ON project_validation_policy_revisions(project_id,revision_no,id)",
      "dependsOn": [
        "project_validation_policy_revisions"
      ]
    },
    {
      "kind": "index",
      "name": "validation_policy_audits_page",
      "createSql": "CREATE INDEX validation_policy_audits_page ON project_validation_policy_audits(project_id,sequence,id)",
      "dependsOn": [
        "project_validation_policy_audits"
      ]
    },
    {
      "kind": "index",
      "name": "execution_one_pending_approval",
      "createSql": "CREATE UNIQUE INDEX execution_one_pending_approval ON execution_approvals(execution_id) WHERE status IN ('pending','approved')",
      "dependsOn": [
        "execution_approvals"
      ]
    },
    {
      "kind": "index",
      "name": "execution_approvals_page",
      "createSql": "CREATE INDEX execution_approvals_page ON execution_approvals(execution_id,created_at,id)",
      "dependsOn": [
        "execution_approvals"
      ]
    },
    {
      "kind": "index",
      "name": "execution_validations_page",
      "createSql": "CREATE INDEX execution_validations_page ON execution_validation_results(execution_id,finished_at,id)",
      "dependsOn": [
        "execution_validation_results"
      ]
    },
    {
      "kind": "index",
      "name": "staged_files_path_key",
      "createSql": "CREATE INDEX staged_files_path_key ON execution_staged_files(path_key,staged_result_id)",
      "dependsOn": [
        "execution_staged_files"
      ]
    },
    {
      "kind": "index",
      "name": "staged_observations_page",
      "createSql": "CREATE INDEX staged_observations_page ON execution_staged_observations(staged_result_id,position,id)",
      "dependsOn": [
        "execution_staged_observations"
      ]
    },
    {
      "kind": "index",
      "name": "staged_blockers_page",
      "createSql": "CREATE INDEX staged_blockers_page ON execution_staged_blockers(staged_result_id,position,observation_id)",
      "dependsOn": [
        "execution_staged_blockers"
      ]
    },
    {
      "kind": "index",
      "name": "execution_artifacts_page",
      "createSql": "CREATE INDEX execution_artifacts_page ON execution_artifacts(execution_id,created_at,id)",
      "dependsOn": [
        "execution_artifacts"
      ]
    },
    {
      "kind": "index",
      "name": "execution_one_project_merge",
      "createSql": "CREATE UNIQUE INDEX execution_one_project_merge ON execution_merge_journals(project_id) WHERE status IN ('prepared','applying','db_committed','rolling_back','rolling_forward','manual_recovery')",
      "dependsOn": [
        "execution_merge_journals"
      ]
    },
    {
      "kind": "index",
      "name": "work_item_result_versions_item",
      "createSql": "CREATE INDEX work_item_result_versions_item ON work_item_result_versions(work_item_id,version,id)",
      "dependsOn": [
        "work_item_result_versions"
      ]
    },
    {
      "kind": "index",
      "name": "review_one_active_result",
      "createSql": "CREATE UNIQUE INDEX review_one_active_result ON review_attempts(result_id)\n WHERE status IN ('calling','finalizing')",
      "dependsOn": [
        "review_attempts"
      ]
    },
    {
      "kind": "index",
      "name": "review_attempts_item",
      "createSql": "CREATE INDEX review_attempts_item ON review_attempts(work_item_id,started_at,id)",
      "dependsOn": [
        "review_attempts"
      ]
    },
    {
      "kind": "index",
      "name": "memory_v6_dedupe",
      "createSql": "CREATE INDEX memory_v6_dedupe ON memory_entries(project_id,type,dedupe_hash)",
      "dependsOn": [
        "memory_entries"
      ]
    },
    {
      "kind": "index",
      "name": "review_events_page",
      "createSql": "CREATE INDEX review_events_page ON review_events(mission_id,sequence,id)",
      "dependsOn": [
        "review_events"
      ]
    },
    {
      "kind": "index",
      "name": "execution_one_active_task",
      "createSql": "CREATE UNIQUE INDEX execution_one_active_task ON executions(work_item_id) WHERE status IN ('queued','running','waiting_approval','paused','staged')",
      "dependsOn": [
        "executions"
      ]
    },
    {
      "kind": "index",
      "name": "execution_one_active_agent",
      "createSql": "CREATE UNIQUE INDEX execution_one_active_agent ON executions(agent_id) WHERE status IN ('queued','running','waiting_approval','paused','staged')",
      "dependsOn": [
        "executions"
      ]
    },
    {
      "kind": "index",
      "name": "executions_project_status",
      "createSql": "CREATE INDEX executions_project_status ON executions(project_id,status,created_at,id)",
      "dependsOn": [
        "executions"
      ]
    },
    {
      "kind": "index",
      "name": "collaboration_one_active_project",
      "createSql": "CREATE UNIQUE INDEX collaboration_one_active_project ON collaboration_runs(project_id) WHERE status IN('running','waiting_owner','paused','failed')",
      "dependsOn": [
        "collaboration_runs"
      ]
    },
    {
      "kind": "index",
      "name": "collaboration_one_calling_attempt",
      "createSql": "CREATE UNIQUE INDEX collaboration_one_calling_attempt ON collaboration_attempts(run_id) WHERE status='calling'",
      "dependsOn": [
        "collaboration_attempts"
      ]
    },
    {
      "kind": "index",
      "name": "collaboration_one_open_decision",
      "createSql": "CREATE UNIQUE INDEX collaboration_one_open_decision ON decision_requests(run_id) WHERE status='open'",
      "dependsOn": [
        "decision_requests"
      ]
    },
    {
      "kind": "index",
      "name": "thread_search_one_title",
      "createSql": "CREATE UNIQUE INDEX thread_search_one_title ON thread_search_index(project_id,thread_id) WHERE kind='thread_title'",
      "dependsOn": [
        "thread_search_index"
      ]
    },
    {
      "kind": "index",
      "name": "thread_fact_one_created",
      "createSql": "CREATE UNIQUE INDEX thread_fact_one_created ON collaboration_thread_facts(project_id,thread_id) WHERE type='thread_created'",
      "dependsOn": [
        "collaboration_thread_facts"
      ]
    },
    {
      "kind": "index",
      "name": "thread_fact_one_policy",
      "createSql": "CREATE UNIQUE INDEX thread_fact_one_policy ON collaboration_thread_facts(project_id,thread_id,policy_revision_id) WHERE type='policy_changed'",
      "dependsOn": [
        "collaboration_thread_facts"
      ]
    },
    {
      "kind": "index",
      "name": "thread_fact_one_message",
      "createSql": "CREATE UNIQUE INDEX thread_fact_one_message ON collaboration_thread_facts(project_id,thread_id,message_id) WHERE type IN('owner_message','agent_message')",
      "dependsOn": [
        "collaboration_thread_facts"
      ]
    },
    {
      "kind": "index",
      "name": "thread_fact_one_run_link",
      "createSql": "CREATE UNIQUE INDEX thread_fact_one_run_link ON collaboration_thread_facts(project_id,thread_id,run_id) WHERE type='run_linked'",
      "dependsOn": [
        "collaboration_thread_facts"
      ]
    },
    {
      "kind": "index",
      "name": "thread_fact_one_run_event",
      "createSql": "CREATE UNIQUE INDEX thread_fact_one_run_event ON collaboration_thread_facts(project_id,thread_id,run_event_id) WHERE type='run_event'",
      "dependsOn": [
        "collaboration_thread_facts"
      ]
    },
    {
      "kind": "index",
      "name": "collaboration_threads_activity_page",
      "createSql": "CREATE INDEX collaboration_threads_activity_page ON collaboration_threads(project_id,last_activity_sequence DESC,id)",
      "dependsOn": [
        "collaboration_threads"
      ]
    },
    {
      "kind": "index",
      "name": "input_history_entries_project_page",
      "createSql": "CREATE INDEX input_history_entries_project_page ON input_history_entries(project_id,created_at,id)",
      "dependsOn": [
        "input_history_entries"
      ]
    },
    {
      "kind": "index",
      "name": "collaboration_facts_page",
      "createSql": "CREATE INDEX collaboration_facts_page ON collaboration_thread_facts(project_id,thread_id,sequence,id)",
      "dependsOn": [
        "collaboration_thread_facts"
      ]
    },
    {
      "kind": "index",
      "name": "collaboration_runs_thread_page",
      "createSql": "CREATE INDEX collaboration_runs_thread_page ON collaboration_runs(project_id,thread_id,created_at,id)",
      "dependsOn": [
        "collaboration_runs"
      ]
    },
    {
      "kind": "index",
      "name": "thread_fact_one_inline_decision",
      "createSql": "CREATE UNIQUE INDEX thread_fact_one_inline_decision ON collaboration_thread_facts(project_id,thread_id,inline_decision_id) WHERE type='inline_decision'",
      "dependsOn": [
        "collaboration_thread_facts"
      ]
    },
    {
      "kind": "index",
      "name": "structured_message_blocks_message_position",
      "createSql": "CREATE UNIQUE INDEX structured_message_blocks_message_position ON structured_message_blocks(project_id,thread_id,message_id,position)",
      "dependsOn": [
        "structured_message_blocks"
      ]
    },
    {
      "kind": "index",
      "name": "thread_tag_edges_by_tag",
      "createSql": "CREATE INDEX thread_tag_edges_by_tag ON thread_tag_edges(project_id,tag_id,thread_id)",
      "dependsOn": [
        "thread_tag_edges"
      ]
    },
    {
      "kind": "index",
      "name": "collaboration_threads_recycle_bin",
      "createSql": "CREATE INDEX collaboration_threads_recycle_bin ON collaboration_threads(project_id,deleted_at) WHERE deleted_at IS NOT NULL",
      "dependsOn": [
        "collaboration_threads"
      ]
    },
    {
      "kind": "trigger",
      "name": "validation_policy_revision_no_update",
      "createSql": "CREATE TRIGGER validation_policy_revision_no_update BEFORE UPDATE ON project_validation_policy_revisions BEGIN SELECT RAISE(ABORT,'IMMUTABLE_POLICY_REVISION'); END",
      "dependsOn": [
        "project_validation_policy_revisions"
      ]
    },
    {
      "kind": "trigger",
      "name": "validation_policy_revision_no_delete",
      "createSql": "CREATE TRIGGER validation_policy_revision_no_delete BEFORE DELETE ON project_validation_policy_revisions WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id) BEGIN SELECT RAISE(ABORT,'IMMUTABLE_POLICY_REVISION'); END",
      "dependsOn": [
        "project_validation_policy_revisions"
      ]
    },
    {
      "kind": "trigger",
      "name": "validation_policy_entry_no_update",
      "createSql": "CREATE TRIGGER validation_policy_entry_no_update BEFORE UPDATE ON project_validation_policy_entries BEGIN SELECT RAISE(ABORT,'IMMUTABLE_POLICY_ENTRY'); END",
      "dependsOn": [
        "project_validation_policy_entries"
      ]
    },
    {
      "kind": "trigger",
      "name": "validation_policy_entry_no_delete",
      "createSql": "CREATE TRIGGER validation_policy_entry_no_delete BEFORE DELETE ON project_validation_policy_entries WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id) BEGIN SELECT RAISE(ABORT,'IMMUTABLE_POLICY_ENTRY'); END",
      "dependsOn": [
        "project_validation_policy_entries"
      ]
    },
    {
      "kind": "trigger",
      "name": "validation_policy_audit_no_update",
      "createSql": "CREATE TRIGGER validation_policy_audit_no_update BEFORE UPDATE ON project_validation_policy_audits BEGIN SELECT RAISE(ABORT,'IMMUTABLE_POLICY_AUDIT'); END",
      "dependsOn": [
        "project_validation_policy_audits"
      ]
    },
    {
      "kind": "trigger",
      "name": "validation_policy_audit_no_delete",
      "createSql": "CREATE TRIGGER validation_policy_audit_no_delete BEFORE DELETE ON project_validation_policy_audits WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id) BEGIN SELECT RAISE(ABORT,'IMMUTABLE_POLICY_AUDIT'); END",
      "dependsOn": [
        "project_validation_policy_audits"
      ]
    },
    {
      "kind": "trigger",
      "name": "review_result_no_update",
      "createSql": "CREATE TRIGGER review_result_no_update BEFORE UPDATE ON work_item_result_versions\nBEGIN SELECT RAISE(ABORT,'IMMUTABLE_RESULT'); END",
      "dependsOn": [
        "work_item_result_versions"
      ]
    },
    {
      "kind": "trigger",
      "name": "review_result_no_delete",
      "createSql": "CREATE TRIGGER review_result_no_delete BEFORE DELETE ON work_item_result_versions\nWHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id)\nBEGIN SELECT RAISE(ABORT,'IMMUTABLE_RESULT'); END",
      "dependsOn": [
        "work_item_result_versions"
      ]
    },
    {
      "kind": "trigger",
      "name": "review_decision_no_update",
      "createSql": "CREATE TRIGGER review_decision_no_update BEFORE UPDATE ON review_decisions\nBEGIN SELECT RAISE(ABORT,'IMMUTABLE_REVIEW_DECISION'); END",
      "dependsOn": [
        "review_decisions"
      ]
    },
    {
      "kind": "trigger",
      "name": "review_decision_no_delete",
      "createSql": "CREATE TRIGGER review_decision_no_delete BEFORE DELETE ON review_decisions\nWHEN EXISTS(SELECT 1 FROM review_attempts WHERE id=OLD.attempt_id)\nBEGIN SELECT RAISE(ABORT,'IMMUTABLE_REVIEW_DECISION'); END",
      "dependsOn": [
        "review_decisions"
      ]
    },
    {
      "kind": "trigger",
      "name": "review_memory_candidate_no_update",
      "createSql": "CREATE TRIGGER review_memory_candidate_no_update BEFORE UPDATE ON review_memory_candidates\nBEGIN SELECT RAISE(ABORT,'IMMUTABLE_MEMORY_CANDIDATE'); END",
      "dependsOn": [
        "review_memory_candidates"
      ]
    },
    {
      "kind": "trigger",
      "name": "review_memory_candidate_no_delete",
      "createSql": "CREATE TRIGGER review_memory_candidate_no_delete BEFORE DELETE ON review_memory_candidates\nWHEN EXISTS(SELECT 1 FROM review_attempts WHERE id=OLD.attempt_id)\nBEGIN SELECT RAISE(ABORT,'IMMUTABLE_MEMORY_CANDIDATE'); END",
      "dependsOn": [
        "review_memory_candidates"
      ]
    },
    {
      "kind": "trigger",
      "name": "review_memory_association_no_update",
      "createSql": "CREATE TRIGGER review_memory_association_no_update BEFORE UPDATE ON review_memory_associations\nBEGIN SELECT RAISE(ABORT,'IMMUTABLE_MEMORY_ASSOCIATION'); END",
      "dependsOn": [
        "review_memory_associations"
      ]
    },
    {
      "kind": "trigger",
      "name": "review_memory_association_no_delete",
      "createSql": "CREATE TRIGGER review_memory_association_no_delete BEFORE DELETE ON review_memory_associations\nWHEN EXISTS(SELECT 1 FROM review_memory_candidates WHERE id=OLD.candidate_id)\nBEGIN SELECT RAISE(ABORT,'IMMUTABLE_MEMORY_ASSOCIATION'); END",
      "dependsOn": [
        "review_memory_associations"
      ]
    },
    {
      "kind": "trigger",
      "name": "review_escalation_no_update",
      "createSql": "CREATE TRIGGER review_escalation_no_update BEFORE UPDATE ON review_escalations\nBEGIN SELECT RAISE(ABORT,'IMMUTABLE_REVIEW_ESCALATION'); END",
      "dependsOn": [
        "review_escalations"
      ]
    },
    {
      "kind": "trigger",
      "name": "review_escalation_no_delete",
      "createSql": "CREATE TRIGGER review_escalation_no_delete BEFORE DELETE ON review_escalations\nWHEN EXISTS(SELECT 1 FROM review_decisions WHERE id=OLD.decision_id)\nBEGIN SELECT RAISE(ABORT,'IMMUTABLE_REVIEW_ESCALATION'); END",
      "dependsOn": [
        "review_escalations"
      ]
    },
    {
      "kind": "trigger",
      "name": "review_escalation_answer_no_update",
      "createSql": "CREATE TRIGGER review_escalation_answer_no_update BEFORE UPDATE ON review_escalation_answers\nBEGIN SELECT RAISE(ABORT,'IMMUTABLE_ESCALATION_ANSWER'); END",
      "dependsOn": [
        "review_escalation_answers"
      ]
    },
    {
      "kind": "trigger",
      "name": "review_escalation_answer_no_delete",
      "createSql": "CREATE TRIGGER review_escalation_answer_no_delete BEFORE DELETE ON review_escalation_answers\nWHEN EXISTS(SELECT 1 FROM review_escalations WHERE id=OLD.escalation_id)\nBEGIN SELECT RAISE(ABORT,'IMMUTABLE_ESCALATION_ANSWER'); END",
      "dependsOn": [
        "review_escalation_answers"
      ]
    },
    {
      "kind": "trigger",
      "name": "memory_entry_v6_no_update",
      "createSql": "CREATE TRIGGER memory_entry_v6_no_update BEFORE UPDATE ON memory_entries\nBEGIN SELECT RAISE(ABORT,'IMMUTABLE_MEMORY_ENTRY'); END",
      "dependsOn": [
        "memory_entries"
      ]
    },
    {
      "kind": "trigger",
      "name": "memory_entry_v6_no_delete",
      "createSql": "CREATE TRIGGER memory_entry_v6_no_delete BEFORE DELETE ON memory_entries\nWHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id)\nBEGIN SELECT RAISE(ABORT,'IMMUTABLE_MEMORY_ENTRY'); END",
      "dependsOn": [
        "memory_entries"
      ]
    },
    {
      "kind": "trigger",
      "name": "mission_delivery_no_update",
      "createSql": "CREATE TRIGGER mission_delivery_no_update BEFORE UPDATE ON mission_deliveries\nBEGIN SELECT RAISE(ABORT,'IMMUTABLE_MISSION_DELIVERY'); END",
      "dependsOn": [
        "mission_deliveries"
      ]
    },
    {
      "kind": "trigger",
      "name": "mission_delivery_no_delete",
      "createSql": "CREATE TRIGGER mission_delivery_no_delete BEFORE DELETE ON mission_deliveries\nWHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id)\nBEGIN SELECT RAISE(ABORT,'IMMUTABLE_MISSION_DELIVERY'); END",
      "dependsOn": [
        "mission_deliveries"
      ]
    },
    {
      "kind": "trigger",
      "name": "review_event_no_update",
      "createSql": "CREATE TRIGGER review_event_no_update BEFORE UPDATE ON review_events\nBEGIN SELECT RAISE(ABORT,'IMMUTABLE_REVIEW_EVENT'); END",
      "dependsOn": [
        "review_events"
      ]
    },
    {
      "kind": "trigger",
      "name": "review_event_no_delete",
      "createSql": "CREATE TRIGGER review_event_no_delete BEFORE DELETE ON review_events\nWHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id)\nBEGIN SELECT RAISE(ABORT,'IMMUTABLE_REVIEW_EVENT'); END",
      "dependsOn": [
        "review_events"
      ]
    },
    {
      "kind": "trigger",
      "name": "review_attempt_terminal_no_update",
      "createSql": "CREATE TRIGGER review_attempt_terminal_no_update\nBEFORE UPDATE ON review_attempts\nWHEN OLD.status IN ('rejected','escalated','passed','failed','interrupted','discarded')\nBEGIN SELECT RAISE(ABORT,'IMMUTABLE_REVIEW_ATTEMPT'); END",
      "dependsOn": [
        "review_attempts"
      ]
    },
    {
      "kind": "trigger",
      "name": "review_attempt_terminal_no_delete",
      "createSql": "CREATE TRIGGER review_attempt_terminal_no_delete\nBEFORE DELETE ON review_attempts\nWHEN OLD.status IN ('rejected','escalated','passed','failed','interrupted','discarded')\n AND EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id)\nBEGIN SELECT RAISE(ABORT,'IMMUTABLE_REVIEW_ATTEMPT'); END",
      "dependsOn": [
        "review_attempts"
      ]
    },
    {
      "kind": "trigger",
      "name": "thread_policy_revision_no_update",
      "createSql": "CREATE TRIGGER thread_policy_revision_no_update BEFORE UPDATE ON collaboration_thread_policy_revisions\n BEGIN SELECT RAISE(ABORT,'IMMUTABLE_THREAD_POLICY_REVISION'); END",
      "dependsOn": [
        "collaboration_thread_policy_revisions"
      ]
    },
    {
      "kind": "trigger",
      "name": "thread_policy_revision_no_delete",
      "createSql": "CREATE TRIGGER thread_policy_revision_no_delete BEFORE DELETE ON collaboration_thread_policy_revisions\n WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id)\n AND NOT EXISTS(SELECT 1 FROM thread_purge_markers m WHERE m.project_id=OLD.project_id AND m.thread_id=OLD.thread_id)\n BEGIN SELECT RAISE(ABORT,'IMMUTABLE_THREAD_POLICY_REVISION'); END",
      "dependsOn": [
        "collaboration_thread_policy_revisions"
      ]
    },
    {
      "kind": "trigger",
      "name": "thread_policy_member_no_update",
      "createSql": "CREATE TRIGGER thread_policy_member_no_update BEFORE UPDATE ON collaboration_thread_policy_members\n BEGIN SELECT RAISE(ABORT,'IMMUTABLE_THREAD_POLICY_MEMBER'); END",
      "dependsOn": [
        "collaboration_thread_policy_members"
      ]
    },
    {
      "kind": "trigger",
      "name": "thread_policy_member_no_delete",
      "createSql": "CREATE TRIGGER thread_policy_member_no_delete BEFORE DELETE ON collaboration_thread_policy_members\n WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id)\n AND NOT EXISTS(SELECT 1 FROM thread_purge_markers m WHERE m.project_id=OLD.project_id AND m.thread_id=OLD.thread_id)\n BEGIN SELECT RAISE(ABORT,'IMMUTABLE_THREAD_POLICY_MEMBER'); END",
      "dependsOn": [
        "collaboration_thread_policy_members"
      ]
    },
    {
      "kind": "trigger",
      "name": "thread_fact_no_update",
      "createSql": "CREATE TRIGGER thread_fact_no_update BEFORE UPDATE ON collaboration_thread_facts\n BEGIN SELECT RAISE(ABORT,'IMMUTABLE_THREAD_FACT'); END",
      "dependsOn": [
        "collaboration_thread_facts"
      ]
    },
    {
      "kind": "trigger",
      "name": "thread_fact_no_delete",
      "createSql": "CREATE TRIGGER thread_fact_no_delete BEFORE DELETE ON collaboration_thread_facts\n WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id)\n AND NOT EXISTS(SELECT 1 FROM thread_purge_markers m WHERE m.project_id=OLD.project_id AND m.thread_id=OLD.thread_id)\n BEGIN SELECT RAISE(ABORT,'IMMUTABLE_THREAD_FACT'); END",
      "dependsOn": [
        "collaboration_thread_facts"
      ]
    },
    {
      "kind": "trigger",
      "name": "thread_identity_no_update",
      "createSql": "CREATE TRIGGER thread_identity_no_update BEFORE UPDATE OF id,project_id,created_at ON collaboration_threads\n BEGIN SELECT RAISE(ABORT,'IMMUTABLE_THREAD_IDENTITY'); END",
      "dependsOn": [
        "collaboration_threads"
      ]
    },
    {
      "kind": "trigger",
      "name": "structured_message_blocks_no_update",
      "createSql": "CREATE TRIGGER structured_message_blocks_no_update BEFORE UPDATE ON structured_message_blocks BEGIN SELECT RAISE(ABORT,'IMMUTABLE_STRUCTURED_MESSAGE_BLOCK'); END",
      "dependsOn": [
        "structured_message_blocks"
      ]
    },
    {
      "kind": "trigger",
      "name": "structured_message_state_revisions_no_update",
      "createSql": "CREATE TRIGGER structured_message_state_revisions_no_update BEFORE UPDATE ON structured_message_state_revisions BEGIN SELECT RAISE(ABORT,'IMMUTABLE_STRUCTURED_MESSAGE_STATE'); END",
      "dependsOn": [
        "structured_message_state_revisions"
      ]
    },
    {
      "kind": "trigger",
      "name": "inline_decisions_no_update",
      "createSql": "CREATE TRIGGER inline_decisions_no_update BEFORE UPDATE ON inline_decisions BEGIN SELECT RAISE(ABORT,'IMMUTABLE_INLINE_DECISION'); END",
      "dependsOn": [
        "inline_decisions"
      ]
    },
    {
      "kind": "trigger",
      "name": "business_action_receipts_no_update",
      "createSql": "CREATE TRIGGER business_action_receipts_no_update BEFORE UPDATE ON business_action_receipts BEGIN SELECT RAISE(ABORT,'IMMUTABLE_BUSINESS_RECEIPT'); END",
      "dependsOn": [
        "business_action_receipts"
      ]
    }
  ]
} as const satisfies CurrentSchemaManifest;

const TABLE_REFERENCE = /\bREFERENCES\s+([A-Za-z_][A-Za-z0-9_]*)\b/giu;
const tableDependencies = (sql: string): readonly string[] =>
  [...new Set(
    [...sql.matchAll(TABLE_REFERENCE)]
      .map((match) => match[1])
      .filter((name): name is string => name !== undefined),
  )];

export const CURRENT_SCHEMA: CurrentSchemaManifest = {
  identity: CURRENT_SCHEMA_DEFINITION.identity,
  objects: CURRENT_SCHEMA_DEFINITION.objects.map((object) =>
    object.kind === "table"
      ? { ...object, dependsOn: tableDependencies(object.createSql) }
      : object),
};

const CREATE_HEADER =
  /^CREATE\s+(UNIQUE\s+)?(TABLE|INDEX|TRIGGER)\s+([A-Za-z_][A-Za-z0-9_]*)\b/u;
const FORBIDDEN_SQL =
  /\b(?:ALTER\s+TABLE|ATTACH|DETACH|DROP\s+(?:TABLE|INDEX|TRIGGER)|INSERT\s+INTO|PRAGMA|VACUUM|CREATE\s+TEMP)\b/iu;
const SECOND_STATEMENT =
  /;\s*(?:CREATE|ALTER|ATTACH|DETACH|DROP|INSERT|PRAGMA|REINDEX|VACUUM)\b/iu;
const SAFE_TRIGGER_BODY =
  /\bBEGIN\s+SELECT\s+RAISE\s*\(\s*ABORT\s*,\s*'[^']+'\s*\)\s*;\s*END$/iu;

export function normalizeCanonicalSql(sql: string): string {
  return sql.replace(/;\s*$/u, "").replace(/\s+/gu, " ").trim();
}

export function assertCurrentSchemaManifest(
  manifest: CurrentSchemaManifest = CURRENT_SCHEMA,
): void {
  if (
    !Number.isSafeInteger(manifest.identity.userVersion)
    || manifest.identity.userVersion <= 8
  ) {
    throw new Error("CURRENT_SCHEMA_IDENTITY_INVALID");
  }

  const objectsByName = new Map<string, CurrentSchemaObject>();
  const identities = new Set<string>();
  for (const object of manifest.objects) {
    const identity = `${object.kind}:${object.name}`;
    if (
      object.name.startsWith("sqlite_")
      || objectsByName.has(object.name)
      || identities.has(identity)
    ) {
      throw new Error("CURRENT_SCHEMA_OBJECT_IDENTITY_INVALID");
    }
    const header = normalizeCanonicalSql(object.createSql).match(CREATE_HEADER);
    const headerKind = header?.[2]?.toLowerCase();
    const headerName = header?.[3];
    const targetMatch = normalizeCanonicalSql(object.createSql)
      .match(/\bON\s+([A-Za-z_][A-Za-z0-9_]*)\b/iu);
    const target = object.kind === "table" ? undefined : targetMatch?.[1];
    if (
      !header
      || headerName !== object.name
      || headerKind !== object.kind
      || FORBIDDEN_SQL.test(object.createSql)
      || SECOND_STATEMENT.test(object.createSql)
      || (object.kind !== "trigger" && object.createSql.includes(";"))
      || (object.kind === "trigger" && !SAFE_TRIGGER_BODY.test(object.createSql))
      || (object.kind === "table"
        && JSON.stringify([...object.dependsOn].sort())
          !== JSON.stringify([...tableDependencies(object.createSql)].sort()))
      || (object.kind !== "table"
        && (target === undefined
          || object.dependsOn.length !== 1
          || object.dependsOn[0] !== target))
      || (object.createSql.match(/\bCREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX|TRIGGER)\b/giu)
        ?.length ?? 0) !== 1
    ) {
      throw new Error("CURRENT_SCHEMA_DDL_INVALID");
    }
    identities.add(identity);
    objectsByName.set(object.name, object);
  }

  for (const object of manifest.objects) {
    if (
      new Set(object.dependsOn).size !== object.dependsOn.length
      || object.dependsOn.some((dependency) =>
        objectsByName.get(dependency)?.kind !== "table"
      )
    ) {
      throw new Error("CURRENT_SCHEMA_DEPENDENCY_INVALID");
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (name: string): void => {
    if (visiting.has(name)) throw new Error("CURRENT_SCHEMA_DEPENDENCY_CYCLE");
    if (visited.has(name)) return;
    visiting.add(name);
    const object = objectsByName.get(name);
    for (const dependency of object?.kind === "table" ? [] : object?.dependsOn ?? []) {
      visit(dependency);
    }
    visiting.delete(name);
    visited.add(name);
  };
  for (const object of manifest.objects) visit(object.name);

  const derivedCount = (["table", "index", "trigger"] as const)
    .reduce(
      (count, kind) => count + manifest.objects.filter((object) => object.kind === kind).length,
      0,
    );
  if (derivedCount !== manifest.objects.length) {
    throw new Error("CURRENT_SCHEMA_INVENTORY_INVALID");
  }
}

export function orderedCurrentSchemaObjects(
  manifest: CurrentSchemaManifest = CURRENT_SCHEMA,
): readonly CurrentSchemaObject[] {
  assertCurrentSchemaManifest(manifest);
  const objectsByName = new Map(manifest.objects.map((object) => [object.name, object]));
  const tables = manifest.objects.filter((object) => object.kind === "table");
  const ordered: CurrentSchemaObject[] = [...tables];
  const visited = new Set(tables.map((object) => object.name));
  const visit = (object: CurrentSchemaObject): void => {
    if (visited.has(object.name)) return;
    for (const dependency of object.dependsOn) {
      const dependencyObject = objectsByName.get(dependency);
      if (!dependencyObject) throw new Error("CURRENT_SCHEMA_DEPENDENCY_INVALID");
      visit(dependencyObject);
    }
    visited.add(object.name);
    ordered.push(object);
  };
  for (const object of manifest.objects) visit(object);
  return ordered;
}

assertCurrentSchemaManifest();
