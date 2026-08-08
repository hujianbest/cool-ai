import { createHash } from "node:crypto";
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
const directories: string[] = [];
const PROJECT_A = "project-backfill-a";
const PROJECT_B = "project-backfill-b";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function threadId(projectId: string): string {
  return `legacy-thread-${sha256(projectId)}`;
}

function policyId(projectId: string): string {
  return `migration-policy-${sha256(projectId)}`;
}

function bootstrapV6(path: string): DatabaseSync {
  const database = new DatabaseSync(path);
  database.exec("PRAGMA foreign_keys=ON");
  expect(() => migrateWithHook(database, (step) => {
    if (step === "precheck") throw new Error("stop-at-v6");
  })).toThrow(expect.objectContaining({ code: "STORAGE_UNAVAILABLE" }));
  expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 6 });
  return database;
}

function createBackfillV6(path: string): void {
  const database = bootstrapV6(path);
  try {
    database.exec(`
      INSERT INTO projects(id,name,created_at,workspace_path,workspace_key,version) VALUES
        ('${PROJECT_A}','Backfill A','2026-08-08T00:00:00.000Z',NULL,NULL,1),
        ('${PROJECT_B}','Backfill B','2026-08-08T00:30:00.000Z',NULL,NULL,1);
      INSERT INTO providers(
        id,name,base_url,default_model,api_key_cipher,api_key_iv,api_key_tag,
        credential_version,credential_generation,key_id,api_key_mask,verified_at,
        version,created_at,updated_at
      ) VALUES (
        'provider-backfill','Fixture','http://localhost/v1','fixture-model',
        'cipher','iv','tag',1,1,'key','***','2026-08-08T00:00:00.000Z',
        1,'2026-08-08T00:00:00.000Z','2026-08-08T00:00:00.000Z'
      );
      INSERT INTO agents(
        id,name,role,system_prompt,provider_id,model,avatar_text,accent_token,
        can_read,can_write,can_execute,max_tokens,max_handoffs,version,created_at,
        updated_at,review_capable
      ) VALUES
        ('agent-a1','Alpha now','Role','Prompt','provider-backfill','fixture-model','A','sage',1,1,0,1000,3,1,'2026-08-08T00:00:00.000Z','2026-08-08T00:00:00.000Z',0),
        ('agent-a2','Beta now','Role','Prompt','provider-backfill','fixture-model','B','gold',1,1,0,1000,3,1,'2026-08-08T00:00:00.000Z','2026-08-08T00:00:00.000Z',0),
        ('agent-b1','Solo now','Role','Prompt','provider-backfill','fixture-model','S','coral',1,1,0,1000,3,1,'2026-08-08T00:00:00.000Z','2026-08-08T00:00:00.000Z',0),
        ('agent-removed','Renamed after history','Role','Prompt','provider-backfill','fixture-model','R','violet',1,1,0,1000,3,1,'2026-08-08T00:00:00.000Z','2026-08-08T00:00:00.000Z',0);
      INSERT INTO project_memberships(project_id,agent_id,joined_at) VALUES
        ('${PROJECT_A}','agent-a2','2026-08-08T02:00:00.000Z'),
        ('${PROJECT_A}','agent-a1','2026-08-08T01:00:00.000Z'),
        ('${PROJECT_B}','agent-b1','2026-08-08T01:30:00.000Z');
      INSERT INTO collaboration_runs(
        id,project_id,status,current_agent_id,round_count,next_event_sequence,
        version,execution_epoch,pause_reason,pause_category,created_at,updated_at
      ) VALUES
        ('run-a-stopped','${PROJECT_A}','stopped','agent-a1',0,3,1,1,NULL,NULL,'2026-08-08T03:00:00.000Z','2026-08-08T03:10:00.000Z'),
        ('run-a-active','${PROJECT_A}','waiting_owner','agent-a2',0,2,1,1,NULL,NULL,'2026-08-08T05:00:00.000Z','2026-08-08T05:10:00.000Z'),
        ('run-b-planned','${PROJECT_B}','planned','agent-b1',0,2,1,1,NULL,NULL,'2026-08-08T02:30:00.000Z','2026-08-08T02:30:00.000Z'),
        ('run-b-failed','${PROJECT_B}','failed','agent-b1',0,3,1,1,NULL,NULL,'2026-08-08T04:00:00.000Z','2026-08-08T04:10:00.000Z');
      INSERT INTO collaboration_project_sequences(project_id,next_message_sequence) VALUES
        ('${PROJECT_A}',4),('${PROJECT_B}',3);
      INSERT INTO collaboration_messages(
        id,project_id,run_id,author_type,author_agent_id,author_display_name,
        content,mention_agent_id,mention_display_name,sequence,consumed_at,created_at
      ) VALUES
        ('message-a-project-agent','${PROJECT_A}',NULL,'agent','agent-removed','Original author name','project-only agent history',NULL,NULL,1,NULL,'2026-08-08T01:00:00.000Z'),
        ('message-a-run-owner','${PROJECT_A}','run-a-stopped','owner',NULL,'Owner','run-linked A',NULL,NULL,2,NULL,'2026-08-08T03:01:00.000Z'),
        ('message-a-project-owner','${PROJECT_A}',NULL,'owner',NULL,'Owner','project-only owner history',NULL,NULL,3,NULL,'2026-08-08T06:00:00.000Z'),
        ('message-b-project-owner','${PROJECT_B}',NULL,'owner',NULL,'Owner','project-only B',NULL,NULL,1,NULL,'2026-08-08T01:00:00.000Z'),
        ('message-b-run-owner','${PROJECT_B}','run-b-failed','owner',NULL,'Owner','run-linked B',NULL,NULL,2,NULL,'2026-08-08T04:01:00.000Z');
      INSERT INTO collaboration_events(
        id,run_id,sequence,type,actor_type,actor_id,payload_json,created_at
      ) VALUES
        ('event-a-stopped-start','run-a-stopped',1,'run_started','owner',NULL,json_object('messageId','message-a-run-owner','messageSequence',2,'currentAgentId','agent-a1'),'2026-08-08T03:00:00.000Z'),
        ('event-a-stopped-owner','run-a-stopped',2,'owner_message','owner',NULL,json_object('messageId','message-a-run-owner','messageSequence',2,'mentionAgentId',NULL,'mentionDisplayName',NULL),'2026-08-08T03:01:00.000Z'),
        ('event-a-active-start','run-a-active',1,'run_started','owner',NULL,json_object('messageId','message-a-project-owner','messageSequence',3,'currentAgentId','agent-a2'),'2026-08-08T05:00:00.000Z'),
        ('event-b-planned-start','run-b-planned',1,'run_started','owner',NULL,json_object('messageId','message-b-project-owner','messageSequence',1,'currentAgentId','agent-b1'),'2026-08-08T02:30:00.000Z'),
        ('event-b-failed-start','run-b-failed',1,'run_started','owner',NULL,json_object('messageId','message-b-run-owner','messageSequence',2,'currentAgentId','agent-b1'),'2026-08-08T04:00:00.000Z'),
        ('event-b-failed-owner','run-b-failed',2,'owner_message','owner',NULL,json_object('messageId','message-b-run-owner','messageSequence',2,'mentionAgentId',NULL,'mentionDisplayName',NULL),'2026-08-08T04:01:00.000Z');
    `);
  } finally {
    database.close();
  }
}

function snapshot(database: DatabaseSync): unknown {
  const tables = [
    "collaboration_threads",
    "collaboration_thread_policy_revisions",
    "collaboration_thread_policy_members",
    "collaboration_runs",
    "collaboration_messages",
    "collaboration_thread_facts",
  ];
  return tables.map((table) => ({
    rows: database.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all(),
    table,
  }));
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("v6 to v7 legacy backfill boundaries", () => {
  it("backfills deterministic isolated histories and reopens idempotently", () => {
    const directory = mkdtempSync(join(tmpdir(), "cockpit-v7-backfill-"));
    directories.push(directory);
    const path = join(directory, "cockpit.sqlite");
    createBackfillV6(path);

    const database = new DatabaseSync(path);
    database.exec("PRAGMA foreign_keys=ON");
    try {
      migrateDatabase(database);
    } catch (error) {
      database.close();
      throw error;
    }
    expect(validateV7(database)).toBeNull();

    expect(database.prepare(`
      SELECT id,project_id AS projectId,title,active_policy_revision_id AS policyId
      FROM collaboration_threads ORDER BY project_id
    `).all()).toEqual([
      { id: threadId(PROJECT_A), policyId: policyId(PROJECT_A), projectId: PROJECT_A, title: "历史协作" },
      { id: threadId(PROJECT_B), policyId: policyId(PROJECT_B), projectId: PROJECT_B, title: "历史协作" },
    ]);
    expect(database.prepare(`
      SELECT project_id AS projectId,agent_id AS agentId,agent_display_name AS displayName,position
      FROM collaboration_thread_policy_members ORDER BY project_id,position
    `).all()).toEqual([
      { agentId: "agent-a1", displayName: "Alpha now", position: 0, projectId: PROJECT_A },
      { agentId: "agent-a2", displayName: "Beta now", position: 1, projectId: PROJECT_A },
      { agentId: "agent-b1", displayName: "Solo now", position: 0, projectId: PROJECT_B },
    ]);

    expect(database.prepare(`
      SELECT id,project_id AS projectId,thread_id AS threadId,status
      FROM collaboration_runs ORDER BY project_id,created_at,id
    `).all()).toEqual([
      { id: "run-a-stopped", projectId: PROJECT_A, status: "stopped", threadId: threadId(PROJECT_A) },
      { id: "run-a-active", projectId: PROJECT_A, status: "waiting_owner", threadId: threadId(PROJECT_A) },
      { id: "run-b-planned", projectId: PROJECT_B, status: "planned", threadId: threadId(PROJECT_B) },
      { id: "run-b-failed", projectId: PROJECT_B, status: "failed", threadId: threadId(PROJECT_B) },
    ]);
    expect(database.prepare(`
      SELECT id,project_id AS projectId,thread_id AS threadId,run_id AS runId,
             author_agent_id AS authorAgentId,author_display_name AS displayName,sequence
      FROM collaboration_messages ORDER BY project_id,sequence
    `).all()).toEqual([
      { authorAgentId: "agent-removed", displayName: "Original author name", id: "message-a-project-agent", projectId: PROJECT_A, runId: null, sequence: 1, threadId: threadId(PROJECT_A) },
      { authorAgentId: null, displayName: "Owner", id: "message-a-run-owner", projectId: PROJECT_A, runId: "run-a-stopped", sequence: 2, threadId: threadId(PROJECT_A) },
      { authorAgentId: null, displayName: "Owner", id: "message-a-project-owner", projectId: PROJECT_A, runId: null, sequence: 3, threadId: threadId(PROJECT_A) },
      { authorAgentId: null, displayName: "Owner", id: "message-b-project-owner", projectId: PROJECT_B, runId: null, sequence: 1, threadId: threadId(PROJECT_B) },
      { authorAgentId: null, displayName: "Owner", id: "message-b-run-owner", projectId: PROJECT_B, runId: "run-b-failed", sequence: 2, threadId: threadId(PROJECT_B) },
    ]);

    const projectAFacts = database.prepare(`
      SELECT sequence,type,run_id AS runId,message_id AS messageId,run_event_id AS eventId
      FROM collaboration_thread_facts WHERE project_id=? ORDER BY sequence
    `).all(PROJECT_A);
    expect(projectAFacts).toEqual([
      { eventId: null, messageId: null, runId: null, sequence: 1, type: "thread_created" },
      { eventId: null, messageId: null, runId: null, sequence: 2, type: "policy_changed" },
      { eventId: null, messageId: "message-a-project-agent", runId: null, sequence: 3, type: "agent_message" },
      { eventId: null, messageId: null, runId: "run-a-stopped", sequence: 4, type: "run_linked" },
      { eventId: "event-a-stopped-start", messageId: null, runId: "run-a-stopped", sequence: 5, type: "run_event" },
      { eventId: null, messageId: "message-a-run-owner", runId: "run-a-stopped", sequence: 6, type: "owner_message" },
      { eventId: null, messageId: null, runId: "run-a-active", sequence: 7, type: "run_linked" },
      { eventId: "event-a-active-start", messageId: null, runId: "run-a-active", sequence: 8, type: "run_event" },
      { eventId: null, messageId: "message-a-project-owner", runId: null, sequence: 9, type: "owner_message" },
    ]);

    const syntheticB = database.prepare(`
      SELECT response_json AS responseJson FROM collaboration_operations
      WHERE project_id=? AND kind='thread_create'
    `).get(PROJECT_B) as { responseJson: string };
    expect(JSON.parse(syntheticB.responseJson)).toMatchObject({
      thread: {
        availability: "repair_required",
        policy: {
          availability: "repair_required",
          unavailableMemberIds: [],
        },
      },
    });

    const beforeReopen = snapshot(database);
    database.close();
    const reopened = new DatabaseSync(path);
    reopened.exec("PRAGMA foreign_keys=ON");
    migrateDatabase(reopened);
    expect(validateV7(reopened)).toBeNull();
    expect(snapshot(reopened)).toEqual(beforeReopen);
    reopened.close();
  });
});
