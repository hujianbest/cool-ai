import { createThread } from "@/src/server/collaboration/thread-service";
import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { seedMissionInitialization } from "@/tests/fixtures/review/mission-initialization";

export type CurrentAdvanceFixtureInput = {
  additionalAgents?: Array<{ id: string; prompt: string }>;
  agentId: string;
  agentPrompt: string;
  missionId: string;
  now: string;
  ownerMessage: string | null;
  projectId: string;
  projectName: string;
  providerId: string;
  runId: string;
  secondAgentId: string;
  secondAgentPrompt: string;
  threadCreateOperationId: string;
};

export function seedCurrentAdvanceFixture(
  databasePath: string,
  input: CurrentAdvanceFixtureInput,
): string {
  const database = openDatabase(databasePath);
  try {
    database.prepare(
      `INSERT INTO projects(
         id,name,created_at,workspace_path,workspace_key,version
       ) VALUES (?, ?, ?, 'D:\\workspace', ?, 1)`,
    ).run(
      input.projectId,
      input.projectName,
      input.now,
      `d:/workspace/${input.projectId}`,
    );
    database.prepare(
      `INSERT INTO providers(
         id,name,base_url,default_model,api_key_cipher,api_key_iv,api_key_tag,
         credential_version,credential_generation,key_id,api_key_mask,verified_at,
         version,created_at,updated_at
       ) VALUES (?, 'Local', 'http://127.0.0.1:4000/v1', 'model',
                 'cipher','iv','tag',1,1,'key-1','***',?,1,?,?)`,
    ).run(input.providerId, input.now, input.now, input.now);
    const insertAgent = database.prepare(
      `INSERT INTO agents(
         id,name,role,system_prompt,provider_id,model,avatar_text,accent_token,
         can_read,can_write,can_execute,max_tokens,max_handoffs,version,
         created_at,updated_at
       ) VALUES (?,?,'Fixture',?,?,'model',?,'sage',1,0,0,1000,2,1,?,?)`,
    );
    insertAgent.run(
      input.agentId,
      "Alpha",
      input.agentPrompt,
      input.providerId,
      "A",
      input.now,
      input.now,
    );
    insertAgent.run(
      input.secondAgentId,
      "Beta",
      input.secondAgentPrompt,
      input.providerId,
      "B",
      input.now,
      input.now,
    );
    const insertMember = database.prepare(
      "INSERT INTO project_memberships(project_id,agent_id,joined_at) VALUES (?,?,?)",
    );
    insertMember.run(input.projectId, input.agentId, "a");
    insertMember.run(input.projectId, input.secondAgentId, "b");
    for (const [index, agent] of (input.additionalAgents ?? []).entries()) {
      insertAgent.run(
        agent.id,
        `Additional ${index + 1}`,
        agent.prompt,
        input.providerId,
        "X",
        input.now,
        input.now,
      );
      insertMember.run(input.projectId, agent.id, `c${index}`);
    }
    database.prepare(
      `INSERT INTO missions(
         id,project_id,title,goal,version,created_at,updated_at
       ) VALUES (?,?,'Mission','Build safely',1,?,?)`,
    ).run(input.missionId, input.projectId, input.now, input.now);
    seedMissionInitialization(database, {
      missionId: input.missionId,
      occurredAt: input.now,
      projectId: input.projectId,
    });
  } finally {
    database.close();
  }

  const memberAgentIds = [
    input.agentId,
    input.secondAgentId,
    ...(input.additionalAgents?.map(({ id }) => id) ?? []),
  ];
  const threadId = createThread(databasePath, input.projectId, {
    memberAgentIds,
    operationId: input.threadCreateOperationId,
    title: "Advance thread",
  }).body.thread.id;

  const runDatabase = openDatabase(databasePath);
  runDatabase.exec("BEGIN IMMEDIATE");
  try {
    const thread = runDatabase.prepare(
      `SELECT next_fact_sequence AS sequence
       FROM collaboration_threads WHERE project_id=? AND id=?`,
    ).get(input.projectId, threadId) as { sequence: number };
    const activity = runDatabase.prepare(
      `SELECT next_activity_sequence AS sequence
       FROM collaboration_project_thread_sequences WHERE project_id=?`,
    ).get(input.projectId) as { sequence: number };
    runDatabase.prepare(
      `INSERT INTO collaboration_runs(
         id,project_id,thread_id,status,current_agent_id,round_count,
         next_event_sequence,version,execution_epoch,pause_reason,pause_category,
         created_at,updated_at
       ) VALUES (?,?,?,'running',?,0,1,1,7,NULL,NULL,?,?)`,
    ).run(
      input.runId,
      input.projectId,
      threadId,
      input.agentId,
      input.now,
      input.now,
    );
    runDatabase.prepare(
      `INSERT INTO collaboration_project_sequences(
         project_id,thread_id,next_message_sequence
       ) VALUES (?,?,?)`,
    ).run(input.projectId, threadId, input.ownerMessage === null ? 1 : 2);
    runDatabase.prepare(
      `INSERT INTO collaboration_thread_facts(
         id,project_id,thread_id,sequence,activity_sequence,type,actor_type,
         actor_id,run_id,message_id,run_event_id,policy_revision_id,payload_json,
         created_at
       ) VALUES (
         'fixture-run-link',?,?,?,?,'run_linked','system',NULL,?,NULL,NULL,NULL,
         json_object('runId',?),?
       )`,
    ).run(
      input.projectId,
      threadId,
      thread.sequence,
      activity.sequence,
      input.runId,
      input.runId,
      input.now,
    );
    if (input.ownerMessage !== null) {
      runDatabase.prepare(
        `INSERT INTO collaboration_messages(
           id,project_id,thread_id,run_id,author_type,author_agent_id,
           author_display_name,content,mention_agent_id,mention_display_name,
           sequence,consumed_at,created_at
         ) VALUES (
           'owner-message',?,?,?,'owner',NULL,'Owner',?,NULL,NULL,1,NULL,?
         )`,
      ).run(
        input.projectId,
        threadId,
        input.runId,
        input.ownerMessage,
        input.now,
      );
      runDatabase.prepare(
        `INSERT INTO collaboration_thread_facts(
           id,project_id,thread_id,sequence,activity_sequence,type,actor_type,
           actor_id,run_id,message_id,run_event_id,policy_revision_id,payload_json,
           created_at
         ) VALUES (
           'fixture-owner-message',?,?,?,?,'owner_message','owner',NULL,?,
           'owner-message',NULL,NULL,json_object('messageId','owner-message'),?
         )`,
      ).run(
        input.projectId,
        threadId,
        thread.sequence + 1,
        activity.sequence + 1,
        input.runId,
        input.now,
      );
    }
    const factCount = input.ownerMessage === null ? 1 : 2;
    runDatabase.prepare(
      `UPDATE collaboration_threads
       SET next_fact_sequence=next_fact_sequence+?,last_activity_sequence=?
       WHERE project_id=? AND id=?`,
    ).run(
      factCount,
      activity.sequence + factCount - 1,
      input.projectId,
      threadId,
    );
    runDatabase.prepare(
      `UPDATE collaboration_project_thread_sequences
       SET next_activity_sequence=next_activity_sequence+? WHERE project_id=?`,
    ).run(factCount, input.projectId);
    runDatabase.exec("COMMIT");
  } catch (error) {
    if (runDatabase.isTransaction) runDatabase.exec("ROLLBACK");
    throw error;
  } finally {
    runDatabase.close();
  }
  return threadId;
}
