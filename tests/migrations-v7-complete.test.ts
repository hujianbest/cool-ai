import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { validateV7 } from "@/src/server/migrations-v7";
import { migrateDatabase } from "@/src/server/migrations";

type MigrationHook = (step: string, database: DatabaseSync) => void;
type HookedMigration = (database: DatabaseSync, afterV7Step?: MigrationHook) => void;

const migrateWithHook = migrateDatabase as HookedMigration;
const NOW = "2026-08-08T04:00:00.000Z";
const PROJECT = "project-v6";
const RUN = "run-v6";
const OWNER_MESSAGE = "message-owner-v6";
const AGENT_MESSAGE = "message-agent-v6";
const EXECUTION = "execution-v6";
const OPERATION = "00000000-0000-4000-8000-000000000701";
const directories: string[] = [];

function version(database: DatabaseSync): number {
  return (database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
}

function createCompleteV6(path: string): void {
  const database = new DatabaseSync(path);
  database.exec("PRAGMA foreign_keys=ON");
  try {
    expect(() => migrateWithHook(database, (step) => {
      if (step === "precheck") throw new Error("stop-at-v6");
    })).toThrow(expect.objectContaining({ code: "STORAGE_UNAVAILABLE" }));
    expect(version(database)).toBe(6);
    database.exec(`
      INSERT INTO projects(id,name,created_at,workspace_path,workspace_key,version)
        VALUES ('${PROJECT}','Migration fixture','${NOW}',NULL,NULL,1);
      INSERT INTO providers(
        id,name,base_url,default_model,api_key_cipher,api_key_iv,api_key_tag,
        credential_version,credential_generation,key_id,api_key_mask,verified_at,
        version,created_at,updated_at
      ) VALUES (
        'provider-v6','Fixture','http://localhost/v1','fixture-model','cipher','iv','tag',
        1,1,'key','***','${NOW}',1,'${NOW}','${NOW}'
      );
      INSERT INTO agents(
        id,name,role,system_prompt,provider_id,model,avatar_text,accent_token,
        can_read,can_write,can_execute,max_tokens,max_handoffs,version,created_at,
        updated_at,review_capable
      ) VALUES
        ('agent-a','Alpha','Planner','alpha','provider-v6','fixture-model','A','sage',
         1,1,0,1000,3,1,'${NOW}','${NOW}',0),
        ('agent-b','Beta','Builder','beta','provider-v6','fixture-model','B','gold',
         1,1,1,1000,3,1,'${NOW}','${NOW}',0);
      INSERT INTO project_memberships(project_id,agent_id,joined_at) VALUES
        ('${PROJECT}','agent-a','2026-08-08T01:00:00.000Z'),
        ('${PROJECT}','agent-b','2026-08-08T02:00:00.000Z');
      INSERT INTO missions(id,project_id,title,goal,version,created_at,updated_at)
      VALUES ('mission-v6','${PROJECT}','Mission','Goal',1,'${NOW}','${NOW}');
      INSERT INTO work_items(
        id,mission_id,title,description,status,assignee_agent_id,version,created_at,updated_at
      ) VALUES ('work-v6','mission-v6','Work','','in_progress','agent-b',1,'${NOW}','${NOW}');
      INSERT INTO mission_delivery_heads(
        mission_id,project_id,context_version,state,current_delivery_id,current_operation_id,
        generation_lease_token,generation_lease_expires_at,last_error_code,
        next_event_sequence,version,updated_at
      ) VALUES ('mission-v6','${PROJECT}',1,'ongoing',NULL,NULL,NULL,NULL,NULL,2,1,'${NOW}');
      INSERT INTO review_events(
        id,project_id,mission_id,sequence,type,actor_type,actor_id,payload_json,created_at
      ) VALUES ('review-event-v6','${PROJECT}','mission-v6',1,'mission_review_initialized',
        'system',NULL,'{}','${NOW}');
      INSERT INTO collaboration_runs(
        id,project_id,status,current_agent_id,round_count,next_event_sequence,
        version,execution_epoch,pause_reason,pause_category,created_at,updated_at
      ) VALUES ('${RUN}','${PROJECT}','waiting_owner','agent-b',1,5,2,1,NULL,NULL,'${NOW}','${NOW}');
      INSERT INTO project_validation_policy_revisions(
        id,project_id,created_operation_id,created_actor_type,revision_no,policy_hash,
        classifier_version,warning_accepted,canonical_bytes,entry_count,created_at
      ) VALUES ('execution-policy-v6','${PROJECT}',NULL,'system',1,
        '${"4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945"}',
        1,0,2,0,'${NOW}');
      INSERT INTO project_validation_policies(project_id,active_revision_id,version,updated_at)
      VALUES ('${PROJECT}','execution-policy-v6',1,'${NOW}');
      INSERT INTO executions(
        id,project_id,source_collaboration_run_id,mission_id,work_item_id,agent_id,
        current_policy_revision_id,status,resume_target,reason_code,
        manual_recovery_required,recovery_resolution,current_attempt_no,
        business_round_count,tool_call_count,next_event_sequence,version,created_at,
        business_deadline_at,first_running_at,updated_at,merged_at
      ) VALUES (
        '${EXECUTION}','${PROJECT}','${RUN}','mission-v6','work-v6','agent-b',
        'execution-policy-v6','failed',NULL,'PROVIDER_FAILED',0,NULL,1,0,0,1,1,
        '${NOW}',NULL,NULL,'${NOW}',NULL
      );
      INSERT INTO execution_attempts(
        id,project_id,execution_id,attempt_no,status,sandbox_root,
        baseline_manifest_path,sandbox_manifest_path,baseline_manifest_hash,
        sandbox_manifest_hash,frozen_public_json,frozen_private_json,frozen_context_hash,
        frozen_policy_revision_id,frozen_policy_version,frozen_policy_hash,started_at,finished_at
      ) VALUES (
        'execution-attempt-v6','${PROJECT}','${EXECUTION}',1,'failed','D:\\sandbox',
        NULL,NULL,NULL,NULL,'{}','{}','${"a".repeat(64)}','execution-policy-v6',1,
        '${"4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945"}',
        '${NOW}','${NOW}'
      );
      INSERT INTO collaboration_project_sequences(project_id,next_message_sequence)
        VALUES ('${PROJECT}',3);
      INSERT INTO collaboration_messages(
        id,project_id,run_id,author_type,author_agent_id,author_display_name,
        content,mention_agent_id,mention_display_name,sequence,consumed_at,created_at
      ) VALUES
        ('${OWNER_MESSAGE}','${PROJECT}','${RUN}','owner',NULL,'Owner','Please plan',
         'agent-a','Alpha',1,'${NOW}','2026-08-08T04:00:01.000Z'),
        ('${AGENT_MESSAGE}','${PROJECT}','${RUN}','agent','agent-a','Alpha','Plan ready',
         NULL,NULL,2,NULL,'2026-08-08T04:00:02.000Z');
      INSERT INTO collaboration_operations(
        id,project_id,run_id,kind,request_hash,status,http_status,response_json,
        created_at,updated_at
      ) VALUES (
        '${OPERATION}','${PROJECT}','${RUN}','start','legacy-hash','completed',201,
        json_object(
          'created',json('true'),
          'run',json_object(
            'id','${RUN}','projectId','${PROJECT}','status','waiting_owner',
            'currentAgentId','agent-b','roundCount',1,'pauseCategory',NULL,
            'version',2,'createdAt','${NOW}','updatedAt','${NOW}'
          ),
          'message',json_object(
            'id','${OWNER_MESSAGE}','sequence',1,'runId','${RUN}','authorType','owner',
            'authorAgentId',NULL,'authorDisplayName','Owner','content','Please plan',
            'mentionAgentId','agent-a','mentionDisplayName','Alpha',
            'mentionMemberStatus','current','createdAt','2026-08-08T04:00:01.000Z'
          )
        ),
        '${NOW}','${NOW}'
      );
      INSERT INTO collaboration_attempts(
        id,project_id,run_id,agent_id,operation_id,status,lease_token,lease_expires_at,
        prompt_hash,acquire_execution_epoch,acquire_context_hash,included_message_sequence,
        error_category,failure_provider_id,failure_provider_version,
        failure_credential_version,failure_credential_generation,failure_verified_at,
        started_at,finished_at
      ) VALUES (
        'attempt-v6','${PROJECT}','${RUN}','agent-a','${OPERATION}','committed',
        'lease','${NOW}','prompt-hash',1,'context-hash',1,NULL,NULL,NULL,NULL,NULL,NULL,
        '${NOW}','2026-08-08T04:00:02.000Z'
      );
      INSERT INTO collaboration_model_calls(
        id,attempt_id,kind,call_index,status,prompt_tokens,completion_tokens,total_tokens,
        error_category,created_at
      ) VALUES ('call-v6','attempt-v6','primary',1,'succeeded',8,5,13,NULL,'${NOW}');
      INSERT INTO collaboration_turns(
        id,attempt_id,run_id,agent_id,round_number,message_id,disposition,created_at
      ) VALUES ('turn-v6','attempt-v6','${RUN}','agent-a',1,'${AGENT_MESSAGE}','handoff','${NOW}');
      INSERT INTO collaboration_events(
        id,run_id,sequence,type,actor_type,actor_id,payload_json,created_at
      ) VALUES
        ('event-start','${RUN}',1,'run_started','owner',NULL,
         json_object('messageId','${OWNER_MESSAGE}','messageSequence',1,'currentAgentId','agent-a'),
         '${NOW}'),
        ('event-owner','${RUN}',2,'owner_message','owner',NULL,
         json_object('messageId','${OWNER_MESSAGE}','messageSequence',1,
           'mentionAgentId','agent-a','mentionDisplayName','Alpha'),
         '2026-08-08T04:00:01.000Z'),
        ('event-agent','${RUN}',3,'agent_message','agent','agent-a',
         json_object('messageId','${AGENT_MESSAGE}','messageSequence',2,'agentId','agent-a',
           'agentDisplayName','Alpha','turnId','turn-v6'),
         '2026-08-08T04:00:02.000Z'),
        ('event-handoff','${RUN}',4,'handoff','agent','agent-a',
         json_object('turnId','turn-v6','fromAgentId','agent-a','toAgentId','agent-b',
           'summary','Plan complete','reason','Build next','overriddenByMention',json('false')),
         '2026-08-08T04:00:03.000Z');
    `);
  } finally {
    database.close();
  }
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("complete v6 to v7 migration", () => {
  it("opens one complete v6 fixture as final v7 without exposing version 7 early", () => {
    const directory = mkdtempSync(join(tmpdir(), "cockpit-v7-complete-"));
    directories.push(directory);
    const path = join(directory, "cockpit.sqlite");
    createCompleteV6(path);

    const observed: Array<{ step: string; version: number }> = [];
    const database = new DatabaseSync(path);
    database.exec("PRAGMA foreign_keys=ON");
    try {
      migrateWithHook(database, (step, connection) => {
        observed.push({ step, version: version(connection) });
      });
    } catch (error) {
      database.close();
      throw new Error(`migration failed after ${observed.at(-1)?.step ?? "none"}`, {
        cause: error,
      });
    }

    expect(observed.length).toBeGreaterThan(10);
    expect(observed.every(({ version: observedVersion }) => observedVersion === 6)).toBe(true);
    expect(version(database)).toBe(7);
    expect(validateV7(database)).toBeNull();

    const thread = database.prepare(`
      SELECT id,project_id AS projectId,title,policy_version AS policyVersion,
             next_fact_sequence AS nextFactSequence,last_activity_sequence AS lastActivitySequence
      FROM collaboration_threads
    `).get() as {
      id: string; lastActivitySequence: number; nextFactSequence: number;
      policyVersion: number; projectId: string; title: string;
    };
    expect(thread).toMatchObject({
      projectId: PROJECT,
      title: "历史协作",
      policyVersion: 1,
    });
    expect(thread.nextFactSequence).toBe(thread.lastActivitySequence + 1);
    expect(database.prepare(
      "SELECT id,project_id AS projectId,thread_id AS threadId FROM collaboration_runs",
    ).get()).toEqual({ id: RUN, projectId: PROJECT, threadId: thread.id });
    expect(database.prepare(`
      SELECT id,project_id AS projectId,
             source_collaboration_thread_id AS threadId,
             source_collaboration_run_id AS runId
      FROM executions WHERE id=?
    `).get(EXECUTION)).toEqual({
      id: EXECUTION,
      projectId: PROJECT,
      runId: RUN,
      threadId: thread.id,
    });
    expect(database.prepare(`
      SELECT id,run_id AS runId,thread_id AS threadId,sequence
      FROM collaboration_messages ORDER BY sequence
    `).all()).toEqual([
      { id: OWNER_MESSAGE, runId: RUN, sequence: 1, threadId: thread.id },
      { id: AGENT_MESSAGE, runId: RUN, sequence: 2, threadId: thread.id },
    ]);
    expect(database.prepare(`
      SELECT type,message_id AS messageId,run_id AS runId,run_event_id AS runEventId
      FROM collaboration_thread_facts ORDER BY sequence
    `).all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "thread_created" }),
      expect.objectContaining({ type: "policy_changed" }),
      expect.objectContaining({ runId: RUN, type: "run_linked" }),
      expect.objectContaining({ messageId: OWNER_MESSAGE, type: "owner_message" }),
      expect.objectContaining({ messageId: AGENT_MESSAGE, type: "agent_message" }),
      expect.objectContaining({ runEventId: "event-handoff", type: "run_event" }),
    ]));
    const receipt = database.prepare(`
      SELECT thread_id AS threadId,response_schema_version AS schemaVersion,response_json AS responseJson
      FROM collaboration_operations WHERE id=?
    `).get(OPERATION) as { responseJson: string; schemaVersion: number; threadId: string };
    expect(receipt.threadId).toBe(thread.id);
    expect(receipt.schemaVersion).toBe(7);
    expect(JSON.parse(receipt.responseJson)).toMatchObject({
      message: { id: OWNER_MESSAGE, projectId: PROJECT, threadId: thread.id },
      run: { id: RUN, projectId: PROJECT, threadId: thread.id },
    });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    database.close();
  });
});
