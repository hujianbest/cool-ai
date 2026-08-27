import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { createProject } from "@/src/adapters/outbound/sqlite/project-workspace/projects";
import { initializeMissingMissionHeads } from "@/tests/fixtures/execution/current-graph";
import { memoryDatabasePath } from "@/tests/fixtures/sqlite/memory-database";

const PROJECT_ID = "recovery-project";
const EXECUTION_ID = "recovery-execution";
const NOW = "2026-08-21T05:00:00.000Z";
const HASH = "a".repeat(64);
const POLICY_HASH =
  "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945";
const OPERATION_ID = "00000000-0000-4000-8000-000000000044";

type RecoveryAction = {
  approvalRequired: boolean;
  id: string;
  reversible: boolean;
  title: string;
};

type RecoveryPreview = {
  actionId: string;
  changes: string[];
  writesFiles: false;
};

type RecoveryExecuteInput = {
  actionId: string;
  confirmation: string;
  expectedVersion: number;
  operationId: string;
};

type RecoveryExecuteResponse = {
  actionId: string;
  executionId: string;
  fromStatus: string;
  toStatus: string;
  version: number;
  writesFiles: false;
};

type RecoveryModule = {
  executeRecoveryAction(
    databasePath: string,
    projectId: string,
    executionId: string,
    input: RecoveryExecuteInput,
  ): RecoveryExecuteResponse;
  listRecoveryActions(
    databasePath: string,
    projectId: string,
    executionId: string,
  ): RecoveryAction[];
  previewRecoveryAction(actionId: string): RecoveryPreview;
  recoveryActionsFor(
    status: string,
    reasonCode: string | null,
  ): RecoveryAction[];
  undoRecoveryAction(
    databasePath: string,
    projectId: string,
    executionId: string,
    input: RecoveryExecuteInput,
  ): RecoveryExecuteResponse;
};

export function seedStaleExecution(database: DatabaseSync): number {
  database.exec(`
    BEGIN;
    PRAGMA defer_foreign_keys=ON;
    INSERT INTO projects (id,name,created_at,workspace_path,workspace_key,version)
    VALUES ('${PROJECT_ID}','Recovery','${NOW}','D:\\canonical','d:/canonical',1);
    INSERT INTO providers (
      id,name,base_url,default_model,api_key_cipher,api_key_iv,api_key_tag,
      credential_version,credential_generation,key_id,api_key_mask,verified_at,
      version,created_at,updated_at
    ) VALUES (
      'provider','Provider','http://127.0.0.1:4000/v1','model','c','i','t',
      1,1,'k','***','${NOW}',1,'${NOW}','${NOW}'
    );
    INSERT INTO agents (
      id,name,role,system_prompt,provider_id,model,avatar_text,accent_token,
      can_read,can_write,can_execute,max_tokens,max_handoffs,version,created_at,updated_at
    ) VALUES (
      'agent','Agent','Builder','private','provider','model','A','sage',
      1,1,1,1000,5,1,'${NOW}','${NOW}'
    );
    INSERT INTO project_memberships (project_id,agent_id,joined_at)
    VALUES ('${PROJECT_ID}','agent','${NOW}');
    INSERT INTO missions (id,project_id,title,goal,version,created_at,updated_at)
    VALUES ('mission','${PROJECT_ID}','Mission','Goal',1,'${NOW}','${NOW}');
    INSERT INTO work_items (
      id,mission_id,title,description,status,assignee_agent_id,version,created_at,updated_at,
      lease_token,lease_expires_at,last_heartbeat_at
    ) VALUES (
      'work','mission','Work','','in_progress','agent',1,'${NOW}','${NOW}',
      'work-lease','2099-01-01T00:00:00.000Z','${NOW}'
    );
    INSERT INTO collaboration_operations (
      id,project_id,thread_id,run_id,kind,request_hash,status,http_status,
      response_json,response_schema_version,created_at,updated_at
    ) VALUES (
      'thread-op','${PROJECT_ID}','thread',NULL,'thread_create','thread-hash',
      'completed',201,'{}',7,'${NOW}','${NOW}'
    );
    INSERT INTO collaboration_thread_policy_revisions (
      id,project_id,thread_id,version,created_operation_id,created_at
    ) VALUES ('thread-policy','${PROJECT_ID}','thread',1,'thread-op','${NOW}');
    INSERT INTO collaboration_threads (
      id,project_id,title,active_policy_revision_id,policy_version,next_fact_sequence,
      last_activity_sequence,version,created_at,updated_at
    ) VALUES ('thread','${PROJECT_ID}','Thread','thread-policy',1,4,3,1,'${NOW}','${NOW}');
    INSERT INTO collaboration_thread_policy_members (
      project_id,thread_id,revision_id,position,agent_id,agent_display_name
    ) VALUES ('${PROJECT_ID}','thread','thread-policy',0,'agent','Agent');
    INSERT INTO collaboration_project_thread_sequences (project_id,next_activity_sequence)
    VALUES ('${PROJECT_ID}',4);
    INSERT INTO collaboration_runs (
      id,project_id,thread_id,status,current_agent_id,round_count,next_event_sequence,
      version,execution_epoch,pause_reason,pause_category,created_at,updated_at
    ) VALUES (
      'run','${PROJECT_ID}','thread','planned','agent',1,1,1,1,NULL,NULL,'${NOW}','${NOW}'
    );
    INSERT INTO collaboration_thread_facts (
      id,project_id,thread_id,sequence,activity_sequence,type,actor_type,actor_id,
      run_id,message_id,run_event_id,policy_revision_id,payload_json,created_at
    ) VALUES
      ('thread-created','${PROJECT_ID}','thread',1,1,'thread_created','system',NULL,NULL,NULL,NULL,NULL,'{"title":"Thread"}','${NOW}'),
      ('thread-policy-fact','${PROJECT_ID}','thread',2,2,'policy_changed','system',NULL,NULL,NULL,NULL,'thread-policy','{"policyVersion":1}','${NOW}'),
      ('thread-run-fact','${PROJECT_ID}','thread',3,3,'run_linked','system',NULL,'run',NULL,NULL,NULL,'{"runId":"run"}','${NOW}');
    INSERT INTO project_validation_policy_revisions (
      id,project_id,created_operation_id,created_actor_type,revision_no,policy_hash,
      classifier_version,warning_accepted,canonical_bytes,entry_count,created_at
    ) VALUES ('policy','${PROJECT_ID}',NULL,'system',1,'${POLICY_HASH}',1,0,2,0,'${NOW}');
    INSERT INTO project_validation_policies (project_id,active_revision_id,version,updated_at)
    VALUES ('${PROJECT_ID}','policy',1,'${NOW}');
    INSERT INTO executions (
      id,project_id,source_collaboration_thread_id,source_collaboration_run_id,
      mission_id,work_item_id,agent_id,
      current_policy_revision_id,status,resume_target,reason_code,
      manual_recovery_required,recovery_resolution,current_attempt_no,
      business_round_count,tool_call_count,next_event_sequence,version,created_at,
      business_deadline_at,first_running_at,updated_at,merged_at
    ) VALUES (
      '${EXECUTION_ID}','${PROJECT_ID}','thread','run','mission','work','agent','policy',
      'stale',NULL,'STALE_EXECUTION',0,NULL,1,0,0,1,1,'${NOW}',
      '2026-08-21T05:15:00.000Z','${NOW}','${NOW}',NULL
    );
    INSERT INTO execution_attempts (
      id,project_id,execution_id,attempt_no,status,sandbox_root,
      baseline_manifest_path,baseline_manifest_hash,sandbox_manifest_hash,
      frozen_public_json,frozen_private_json,frozen_context_hash,
      frozen_policy_revision_id,frozen_policy_version,frozen_policy_hash,
      started_at,finished_at
    ) VALUES (
      'attempt','${PROJECT_ID}','${EXECUTION_ID}',1,'ready','D:\\sandbox',
      NULL,'${HASH}','${HASH}','{}','{}','${HASH}','policy',1,'${POLICY_HASH}','${NOW}',NULL
    );
    COMMIT;
  `);
  initializeMissingMissionHeads(database);
  return (database.prepare("SELECT version FROM executions WHERE id=?")
    .get(EXECUTION_ID) as { version: number }).version;
}

const modules = import.meta.glob<RecoveryModule>(
  "../../../src/adapters/outbound/sqlite/safe-execution/recovery-actions.ts",
);

async function recovery(): Promise<RecoveryModule> {
  const load = modules[
    "../../../src/adapters/outbound/sqlite/safe-execution/recovery-actions.ts"
  ];
  expect(load, "the recovery action catalog must exist").toBeTypeOf("function");
  return load();
}

describe("recovery actions", () => {
  it("returns a frozen catalog for known faults and nothing for unknown paths", async () => {
    const service = await recovery();
    expect(service.recoveryActionsFor("stale", "STALE_EXECUTION")).toEqual([
      {
        approvalRequired: false,
        id: "resume_queued",
        reversible: false,
        title: "恢复到可运行队列",
      },
    ]);
    expect(service.recoveryActionsFor("running", null)).toEqual([]);
    expect(service.recoveryActionsFor("paused", "UNKNOWN_FAULT")).toEqual([]);
  });

  it("rejects an unknown project before inventing actions", async () => {
    const databasePath = memoryDatabasePath();
    createProject("Recovery project", databasePath);
    const service = await recovery();
    expect(() =>
      service.listRecoveryActions(databasePath, "missing-project", "execution-1"),
    ).toThrowError(/Project was not found/u);
  });

  it("previews a known action without inventing unknown rescue paths", async () => {
    const service = await recovery();
    expect(service.previewRecoveryAction("resume_queued")).toEqual({
      actionId: "resume_queued",
      changes: ["Execution 回到 queued"],
      writesFiles: false,
    });
    expect(() => service.previewRecoveryAction("rm_rf")).toThrowError(/unknown recovery/iu);
  });

  it("executes resume_queued with confirmation and version CAS, then rejects undo", async () => {
    const databasePath = memoryDatabasePath();
    const database = openDatabase(databasePath);
    const version = seedStaleExecution(database);
    database.close();
    const service = await recovery();
    const input = {
      actionId: "resume_queued",
      confirmation: "执行救援",
      expectedVersion: version,
      operationId: OPERATION_ID,
    };
    const first = service.executeRecoveryAction(
      databasePath,
      PROJECT_ID,
      EXECUTION_ID,
      input,
    );
    expect(first).toEqual({
      actionId: "resume_queued",
      executionId: EXECUTION_ID,
      fromStatus: "stale",
      toStatus: "queued",
      version: version + 1,
      writesFiles: false,
    });
    expect(service.executeRecoveryAction(
      databasePath,
      PROJECT_ID,
      EXECUTION_ID,
      input,
    )).toEqual(first);
    expect(() =>
      service.executeRecoveryAction(databasePath, PROJECT_ID, EXECUTION_ID, {
        ...input,
        confirmation: "doit",
        operationId: "00000000-0000-4000-8000-000000000045",
      }),
    ).toThrowError(/confirmation/iu);
    expect(() =>
      service.executeRecoveryAction(databasePath, PROJECT_ID, EXECUTION_ID, {
        ...input,
        actionId: "rm_rf",
        operationId: "00000000-0000-4000-8000-000000000046",
      }),
    ).toThrowError(/unknown recovery/iu);
    expect(() =>
      service.executeRecoveryAction(databasePath, "missing-project", EXECUTION_ID, {
        ...input,
        operationId: "00000000-0000-4000-8000-000000000047",
      }),
    ).toThrowError(/Project was not found/u);
    expect(() =>
      service.undoRecoveryAction(databasePath, PROJECT_ID, EXECUTION_ID, input),
    ).toThrowError(/not reversible/iu);
  });

  it("rejects a stale version and an approval-gated action without a matching approval", async () => {
    const databasePath = memoryDatabasePath();
    const database = openDatabase(databasePath);
    const version = seedStaleExecution(database);
    database.prepare(`
      UPDATE executions SET status='paused',reason_code='SANDBOX_UNVERIFIABLE'
      WHERE id=?
    `).run(EXECUTION_ID);
    database.close();
    const service = await recovery();
    expect(() =>
      service.executeRecoveryAction(databasePath, PROJECT_ID, EXECUTION_ID, {
        actionId: "resume_queued",
        confirmation: "执行救援",
        expectedVersion: version + 8,
        operationId: "00000000-0000-4000-8000-000000000048",
      }),
    ).toThrowError(/version/iu);
    expect(() =>
      service.executeRecoveryAction(databasePath, PROJECT_ID, EXECUTION_ID, {
        actionId: "abandon_unverified",
        confirmation: "执行救援",
        expectedVersion: version,
        operationId: "00000000-0000-4000-8000-000000000049",
      }),
    ).toThrowError(/approval/iu);
  });
});
