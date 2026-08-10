import type { DatabaseSync } from "node:sqlite";

import { createCredentialVault } from "@/src/modules/identity-capability/internal/credential-vault";
import { seedMissionInitialization } from "@/tests/fixtures/review/mission-initialization";

/**
 * Shared collaboration graph for thread search tests (feature 031): one
 * provider with a real vault envelope (the public-text classifier on the
 * message write path must see a decryptable key), two member agents, and
 * per-project scaffolding (project row, memberships, mission, review
 * initialization) so createThread/writeOwnerThreadMessage work through the
 * real write paths. Callers must set COCKPIT_MASTER_KEY before seeding.
 */
export function seedSearchCollaborationGraph(
  database: DatabaseSync,
  input: {
    agentIds: [string, string];
    now: string;
    projectIds: string[];
    providerId: string;
  },
): void {
  const encrypted = createCredentialVault().encrypt(input.providerId, "provider-key");
  database.prepare(
    `INSERT INTO providers(
       id,name,base_url,default_model,api_key_cipher,api_key_iv,api_key_tag,
       credential_version,credential_generation,key_id,api_key_mask,verified_at,
       version,created_at,updated_at
     ) VALUES (?,'Provider','http://localhost/v1','model',?,?,?,1,1,?,'***',?,1,?,?)`,
  ).run(
    input.providerId,
    encrypted.apiKeyCipher,
    encrypted.apiKeyIv,
    encrypted.apiKeyTag,
    encrypted.keyId,
    input.now,
    input.now,
    input.now,
  );
  const insertAgent = database.prepare(
    `INSERT INTO agents(
       id,name,role,system_prompt,provider_id,model,avatar_text,accent_token,
       can_read,can_write,can_execute,max_tokens,max_handoffs,version,created_at,
       updated_at,review_capable
     ) VALUES (?,?,'Peer','Prompt',?,'model','A','sage',1,1,0,1000,3,1,?,?,0)`,
  );
  insertAgent.run(input.agentIds[0], "Agent A", input.providerId, input.now, input.now);
  insertAgent.run(input.agentIds[1], "Agent B", input.providerId, input.now, input.now);
  const insertProject = database.prepare(
    `INSERT INTO projects(id,name,created_at,workspace_path,workspace_key,version)
     VALUES (?,?,?,'D:\\workspace',?,1)`,
  );
  const insertMember = database.prepare(
    "INSERT INTO project_memberships(project_id,agent_id,joined_at) VALUES (?,?,?)",
  );
  const insertMission = database.prepare(
    `INSERT INTO missions(id,project_id,title,goal,version,created_at,updated_at)
     VALUES (?,?,'Mission','Goal',1,?,?)`,
  );
  for (const projectId of input.projectIds) {
    insertProject.run(projectId, `Project ${projectId}`, input.now, `d:/workspace/${projectId}`);
    insertMember.run(projectId, input.agentIds[0], input.now);
    insertMember.run(projectId, input.agentIds[1], input.now);
    insertMission.run(`${projectId}-mission`, projectId, input.now, input.now);
    seedMissionInitialization(database, {
      missionId: `${projectId}-mission`,
      occurredAt: input.now,
      projectId,
    });
  }
}
