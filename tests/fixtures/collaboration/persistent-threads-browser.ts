import { createThread } from "@/src/server/collaboration/thread-service";
import { createCredentialVault } from "@/src/server/credential-vault";
import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { execV7TupleStatements } from "@/tests/fixtures/execution/current-graph";

const databasePath = process.env.THREAD_SMOKE_DB_PATH;
if (!databasePath) throw new Error("THREAD_SMOKE_DB_PATH is required");

let database = openDatabase(databasePath);
try {
  const vault = createCredentialVault();
  const encrypted = vault.encrypt("legacy-provider", "legacy-fixture-key");
  database.prepare(`
    INSERT INTO projects(id,name,created_at,workspace_path,workspace_key,version)
    VALUES ('legacy-project','Persistent Threads Legacy','2026-08-08T00:00:00.000Z',NULL,NULL,1)
  `).run();
  database.prepare(`
    INSERT INTO providers(
      id,name,base_url,default_model,api_key_cipher,api_key_iv,api_key_tag,
      credential_version,credential_generation,key_id,api_key_mask,verified_at,
      version,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)
  `).run(
    "legacy-provider",
    "Legacy Provider",
    "http://127.0.0.1:1/v1",
    "legacy-model",
    encrypted.apiKeyCipher,
    encrypted.apiKeyIv,
    encrypted.apiKeyTag,
    encrypted.credentialVersion,
    1,
    encrypted.keyId,
    encrypted.apiKeyMask,
    "2026-08-08T00:00:00.000Z",
    "2026-08-08T00:00:00.000Z",
    "2026-08-08T00:00:00.000Z",
  );
  const insertAgent = database.prepare(`
    INSERT INTO agents(
      id,name,role,system_prompt,provider_id,model,avatar_text,accent_token,
      can_read,can_write,can_execute,max_tokens,max_handoffs,version,created_at,
      updated_at,review_capable
    ) VALUES (?,?,'Legacy member','Legacy fixture prompt','legacy-provider',
      'legacy-model',?,'sage',1,1,0,4000,3,1,
      '2026-08-08T00:00:00.000Z','2026-08-08T00:00:00.000Z',0)
  `);
  insertAgent.run("legacy-agent-a", "Legacy Alpha", "LA");
  insertAgent.run("legacy-agent-b", "Legacy Beta", "LB");
  database.prepare(`
    INSERT INTO project_memberships(project_id,agent_id,joined_at) VALUES
      ('legacy-project','legacy-agent-a','2026-08-08T00:00:00.000Z'),
      ('legacy-project','legacy-agent-b','2026-08-08T00:00:01.000Z')
  `).run();
  database.close();
  const threadId = createThread(databasePath, "legacy-project", {
    memberAgentIds: ["legacy-agent-a", "legacy-agent-b"],
    operationId: "00000000-0000-4000-8000-000000008001",
    title: "历史协作",
  }).body.thread.id;
  database = openDatabase(databasePath);
  execV7TupleStatements(database, `
    INSERT INTO collaboration_runs(
      id,project_id,thread_id,status,current_agent_id,round_count,next_event_sequence,
      version,execution_epoch,pause_reason,pause_category,created_at,updated_at
    ) VALUES (
      'legacy-run-stopped','legacy-project','${threadId}','stopped','legacy-agent-a',1,3,
      1,1,NULL,NULL,'2026-08-08T00:10:00.000Z','2026-08-08T00:12:00.000Z'
    )
  ;
    INSERT INTO collaboration_project_sequences(project_id,thread_id,next_message_sequence)
    VALUES ('legacy-project','${threadId}',2)
  ;
    INSERT INTO collaboration_messages(
      id,project_id,thread_id,run_id,author_type,author_agent_id,author_display_name,
      content,mention_agent_id,mention_display_name,sequence,consumed_at,created_at
    ) VALUES (
      'legacy-owner-message','legacy-project','${threadId}','legacy-run-stopped','owner',NULL,
      '项目所有者','Legacy owner history',NULL,NULL,1,NULL,
      '2026-08-08T00:11:00.000Z'
    )
  ;
    INSERT INTO collaboration_events(
      id,project_id,thread_id,run_id,sequence,type,actor_type,actor_id,
      payload_json,created_at
    ) VALUES
      ('legacy-run-start','legacy-project','${threadId}','legacy-run-stopped',
       1,'run_started','owner',NULL,
       json_object('messageId','legacy-owner-message','messageSequence',1,
                   'currentAgentId','legacy-agent-a'),'2026-08-08T00:10:00.000Z'),
      ('legacy-owner-event','legacy-project','${threadId}','legacy-run-stopped',
       2,'owner_message','owner',NULL,
       json_object('messageId','legacy-owner-message','messageSequence',1,
                   'mentionAgentId',NULL,'mentionDisplayName',NULL),
       '2026-08-08T00:11:00.000Z')
  ;`);
} finally {
  if (database.isOpen) database.close();
}
