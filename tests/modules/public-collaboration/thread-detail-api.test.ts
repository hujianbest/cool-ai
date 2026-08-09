import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createThread } from "@/src/adapters/outbound/sqlite/public-collaboration/thread-service";
import { createCredentialVault } from "@/src/modules/identity-capability/internal/credential-vault";
import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { seedMissionInitializationForMission as initializeMissionDeliveryTx } from "@/tests/fixtures/review/mission-initialization";
import { memoryDatabasePath } from "@/tests/fixtures/sqlite/memory-database";

type GetRoute = {
  GET(
    request: Request,
    context: { params: Promise<{ projectId: string; threadId: string }> },
  ): Promise<Response>;
};

const routeModules = import.meta.glob<GetRoute>(
  "../../../app/api/projects/[projectId]/threads/[threadId]/route.ts",
);

const NOW = "2026-08-08T08:00:00.000Z";
const MASTER_KEY = Buffer.alloc(32, 10).toString("base64url");
let databasePath: string;
let threadA: string;
let threadB: string;
let foreignThread: string;

function seedProject(
  projectId: string,
  agentIds: [string, string],
  operationId: string,
): string {
  const database = openDatabase(databasePath);
  try {
    database
      .prepare(
        `INSERT INTO projects(id,name,created_at,workspace_path,workspace_key,version)
         VALUES (?,?,?,?,?,1)`,
      )
      .run(projectId, projectId, NOW, `D:/workspace/${projectId}`, `d:/workspace/${projectId}`);
    database
      .prepare(
        `INSERT INTO missions(id,project_id,title,goal,version,created_at,updated_at)
         VALUES (?,?,?,'Goal',1,?,?)`,
      )
      .run(`mission-${projectId}`, projectId, `Mission ${projectId}`, NOW, NOW);
    const insertProvider = database.prepare(
      `INSERT INTO providers(
         id,name,base_url,default_model,api_key_cipher,api_key_iv,api_key_tag,
         credential_version,credential_generation,key_id,api_key_mask,verified_at,
         version,created_at,updated_at
       ) VALUES (?,?, 'http://localhost/v1','model',?,?,?,?,?,?,?, ?,1,?,?)`,
    );
    const insertAgent = database.prepare(
      `INSERT INTO agents(
         id,name,role,system_prompt,provider_id,model,avatar_text,accent_token,
         can_read,can_write,can_execute,max_tokens,max_handoffs,version,created_at,
         updated_at,review_capable
       ) VALUES (?,?,'Peer','Prompt',?,'model','A','sage',
         1,1,0,1000,3,1,?,?,0)`,
    );
    const insertMember = database.prepare(
      "INSERT INTO project_memberships(project_id,agent_id,joined_at) VALUES (?,?,?)",
    );
    const vault = createCredentialVault();
    agentIds.forEach((agentId, position) => {
      const providerId = `provider-${agentId}`;
      const encrypted = vault.encrypt(providerId, `key-${agentId}`);
      insertProvider.run(
        providerId,
        `Provider ${agentId}`,
        encrypted.apiKeyCipher,
        encrypted.apiKeyIv,
        encrypted.apiKeyTag,
        encrypted.credentialVersion,
        1,
        encrypted.keyId,
        encrypted.apiKeyMask,
        NOW,
        NOW,
        NOW,
      );
      insertAgent.run(agentId, `Agent ${agentId}`, providerId, NOW, NOW);
      insertMember.run(projectId, agentId, `2026-08-08T08:00:0${position}.000Z`);
    });
    initializeMissionDeliveryTx(database, {
      id: `mission-${projectId}`,
      projectId,
      updatedAt: NOW,
    });
  } finally {
    database.close();
  }
  return createThread(databasePath, projectId, {
    memberAgentIds: agentIds,
    operationId,
    title: `Thread ${operationId.at(-1)}`,
  }).body.thread.id;
}

function insertRun(
  id: string,
  projectId: string,
  threadId: string,
  currentAgentId: string,
  status: "running" | "planned" | "stopped",
  createdAt: string,
): void {
  const database = openDatabase(databasePath);
  try {
    database.exec("BEGIN IMMEDIATE");
    database
      .prepare(
        `INSERT INTO collaboration_runs(
           id,project_id,thread_id,status,current_agent_id,round_count,
           next_event_sequence,version,execution_epoch,pause_reason,pause_category,
           created_at,updated_at
         ) VALUES (?,?,?,?,?,0,1,1,1,NULL,NULL,?,?)`,
      )
      .run(id, projectId, threadId, status, currentAgentId, createdAt, createdAt);
    const thread = database
      .prepare(
        `SELECT next_fact_sequence AS nextFactSequence
         FROM collaboration_threads WHERE project_id=? AND id=?`,
      )
      .get(projectId, threadId) as { nextFactSequence: number };
    const projectSequence = database
      .prepare(
        `SELECT next_activity_sequence AS nextActivitySequence
         FROM collaboration_project_thread_sequences WHERE project_id=?`,
      )
      .get(projectId) as { nextActivitySequence: number };
    database
      .prepare(
        `INSERT INTO collaboration_thread_facts(
           id,project_id,thread_id,sequence,activity_sequence,type,actor_type,actor_id,
           run_id,message_id,run_event_id,policy_revision_id,payload_json,created_at
         ) VALUES (?,?,?,?,?,'run_linked','system',NULL,?,NULL,NULL,NULL,?,?)`,
      )
      .run(
        `fact-${id}`,
        projectId,
        threadId,
        thread.nextFactSequence,
        projectSequence.nextActivitySequence,
        id,
        JSON.stringify({ runId: id }),
        createdAt,
      );
    database
      .prepare(
        `UPDATE collaboration_threads
         SET next_fact_sequence=next_fact_sequence+1,last_activity_sequence=?
         WHERE project_id=? AND id=?`,
      )
      .run(projectSequence.nextActivitySequence, projectId, threadId);
    database
      .prepare(
        `UPDATE collaboration_project_thread_sequences
         SET next_activity_sequence=next_activity_sequence+1 WHERE project_id=?`,
      )
      .run(projectId);
    database.exec("COMMIT");
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
}

async function route(): Promise<GetRoute> {
  const load = routeModules[
    "../../../app/api/projects/[projectId]/threads/[threadId]/route.ts"
  ];
  expect(load, "thread detail route must exist").toBeTypeOf("function");
  return load!();
}

async function detail(
  projectId: string,
  threadId: string,
  query = "",
  urlSuffix = "",
): Promise<Response> {
  return (await route()).GET(
    new Request(
      `http://localhost/api/projects/${projectId}/threads/${threadId}${query}${urlSuffix}`,
    ),
    { params: Promise.resolve({ projectId, threadId }) },
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  process.env.COCKPIT_MASTER_KEY = MASTER_KEY;
  databasePath = memoryDatabasePath();
  process.env.COCKPIT_DB_PATH = databasePath;

  threadA = seedProject(
    "project-a",
    ["agent-a", "agent-b"],
    "00000000-0000-4000-8000-000000001001",
  );
  threadB = createThread(databasePath, "project-a", {
    memberAgentIds: ["agent-a", "agent-b"],
    operationId: "00000000-0000-4000-8000-000000001002",
    title: "Thread B",
  }).body.thread.id;
  foreignThread = seedProject(
    "project-b",
    ["agent-c", "agent-d"],
    "00000000-0000-4000-8000-000000001003",
  );
  insertRun(
    "run-a-old",
    "project-a",
    threadA,
    "agent-a",
    "stopped",
    "2026-08-08T07:00:00.000Z",
  );
  insertRun(
    "run-a-new",
    "project-a",
    threadA,
    "agent-b",
    "planned",
    "2026-08-08T09:00:00.000Z",
  );
  insertRun(
    "run-b-active",
    "project-a",
    threadB,
    "agent-a",
    "running",
    "2026-08-08T10:00:00.000Z",
  );
  insertRun(
    "run-foreign",
    "project-b",
    foreignThread,
    "agent-c",
    "stopped",
    "2026-08-08T11:00:00.000Z",
  );
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.COCKPIT_DB_PATH;
  delete process.env.COCKPIT_MASTER_KEY;
});

describe("tuple-scoped thread detail API", () => {
  it("returns the exact detail envelope with no implicit latest-run selection", async () => {
    const response = await detail("project-a", threadA);
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(Object.keys(body).sort()).toEqual([
      "activeRun",
      "readiness",
      "runs",
      "selectedRun",
      "thread",
    ]);
    expect(body.selectedRun).toBeNull();
    expect(body.runs.map(({ id }: { id: string }) => id)).toEqual([
      "run-a-new",
      "run-a-old",
    ]);
    expect(body.runs[0]).toEqual({
      id: "run-a-new",
      projectId: "project-a",
      threadId: threadA,
      status: "planned",
      currentAgentId: "agent-b",
      roundCount: 0,
      pauseCategory: null,
      version: 1,
      createdAt: "2026-08-08T09:00:00.000Z",
      updatedAt: "2026-08-08T09:00:00.000Z",
    });
    expect(body.activeRun).toEqual({ threadId: threadB, runId: "run-b-active" });
    expect(body.readiness).toEqual({
      dispatch: "project_run_active",
      missingProjectFacts: [],
      selectedMemberId: "agent-a",
    });
    expect(Object.keys(body.thread).sort()).toEqual([
      "availability",
      "createdAt",
      "id",
      "lastActivitySequence",
      "policy",
      "policyVersion",
      "projectId",
      "title",
      "updatedAt",
      "version",
    ]);
    expect(Object.keys(body.thread.policy).sort()).toEqual([
      "availability",
      "createdAt",
      "members",
      "revisionId",
      "unavailableMemberIds",
      "version",
    ]);
  });

  it("selects only an explicitly requested run from the same tuple", async () => {
    const response = await detail("project-a", threadA, "?run=run-a-old");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.selectedRun).toEqual(
      body.runs.find(({ id }: { id: string }) => id === "run-a-old"),
    );
    expect(body.selectedRun.id).toBe("run-a-old");
  });

  it.each([
    "?run=run-a-old&run=run-a-new",
    "?unknown=value",
    "?run=",
    "?run=bad%2Fid",
  ])("rejects malformed, duplicate, or unknown query input: %s", async (query) => {
    const response = await detail("project-a", threadA, query);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "INVALID_INPUT" },
    });
  });

  it.each([
    ["bad%2Fproject", "thread"],
    ["project-a", "bad%5Cthread"],
    ["project-a", ".."],
  ])("rejects malformed path IDs", async (projectId, threadId) => {
    const response = await detail(projectId, threadId);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "INVALID_INPUT" },
    });
  });

  it("rejects URL fragments", async () => {
    const response = await detail("project-a", threadA, "", "#fragment");
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "INVALID_INPUT" },
    });
  });

  it("uses one safe 404 for unknown and cross-tuple identities", async () => {
    const responses = await Promise.all([
      detail("project-a", "unknown-thread"),
      detail("project-a", foreignThread),
      detail("project-a", threadA, "?run=unknown-run"),
      detail("project-a", threadA, "?run=run-b-active"),
      detail("project-a", threadA, "?run=run-foreign"),
    ]);
    const bodies = await Promise.all(responses.map((response) => response.json()));

    expect(responses.map(({ status }) => status)).toEqual([404, 404, 404, 404, 404]);
    expect(new Set(bodies.map((body) => JSON.stringify(body)))).toEqual(
      new Set([
        JSON.stringify({
          error: {
            code: "RESOURCE_NOT_FOUND",
            message: "Resource was not found.",
          },
        }),
      ]),
    );
  });
});
