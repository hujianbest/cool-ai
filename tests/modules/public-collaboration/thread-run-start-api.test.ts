import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createThread } from "@/src/adapters/outbound/sqlite/public-collaboration/thread-service";
import { createCredentialVault } from "@/src/modules/identity-capability/internal/credential-vault";
import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { seedMissionInitializationForMission as initializeMissionDeliveryTx } from "@/tests/fixtures/review/mission-initialization";
import { memoryDatabasePath } from "@/tests/fixtures/sqlite/memory-database";

type RunRoute = {
  POST(
    request: Request,
    context: { params: Promise<{ projectId: string; threadId: string }> },
  ): Promise<Response>;
};

type StartFaultPoint =
  | "after_receipt"
  | "after_run"
  | "after_message"
  | "after_event"
  | "after_facts"
  | "after_sequences";

type RunStartService = {
  startThreadRun(
    databasePath: string,
    projectId: string,
    threadId: string,
    input: unknown,
    hooks?: { fault?: (point: StartFaultPoint) => void },
  ): unknown;
};

const routeModules = import.meta.glob<RunRoute>(
  "../../../app/api/projects/[projectId]/threads/[threadId]/runs/route.ts",
);
const NOW = "2026-08-08T08:00:00.000Z";
const MASTER_KEY = Buffer.alloc(32, 13).toString("base64url");
const OPERATION = "00000000-0000-4000-8000-000000001301";
let databasePath: string;
let threadA: string;
let threadB: string;
let foreignThread: string;

function seedProject(
  projectId: string,
  agentIds: [string, string, ...string[]],
  operationId: string,
): string {
  const database = openDatabase(databasePath);
  try {
    database.prepare(
      `INSERT INTO projects(id,name,created_at,workspace_path,workspace_key,version)
       VALUES (?,?,?,?,?,1)`,
    ).run(projectId, projectId, NOW, `D:/workspace/${projectId}`, `workspace-${projectId}`);
    database.prepare(
      `INSERT INTO missions(id,project_id,title,goal,version,created_at,updated_at)
       VALUES (?,?,?,'Goal',1,?,?)`,
    ).run(`mission-${projectId}`, projectId, `Mission ${projectId}`, NOW, NOW);
    const vault = createCredentialVault();
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
    memberAgentIds: agentIds.slice(0, 2),
    operationId,
    title: `Thread ${projectId}`,
  }).body.thread.id;
}

function insertRun(
  id: string,
  projectId: string,
  threadId: string,
  agentId: string,
  status: "running" | "waiting_owner" | "paused" | "failed" | "planned" | "stopped",
): void {
  const database = openDatabase(databasePath);
  try {
    database.exec("BEGIN IMMEDIATE");
    const thread = database.prepare(
      `SELECT next_fact_sequence AS factSequence
       FROM collaboration_threads WHERE project_id=? AND id=?`,
    ).get(projectId, threadId) as { factSequence: number };
    const project = database.prepare(
      `SELECT next_activity_sequence AS activitySequence
       FROM collaboration_project_thread_sequences WHERE project_id=?`,
    ).get(projectId) as { activitySequence: number };
    database.prepare(
      `INSERT INTO collaboration_runs(
         id,project_id,thread_id,status,current_agent_id,round_count,next_event_sequence,
         version,execution_epoch,pause_reason,pause_category,created_at,updated_at
       ) VALUES (?,?,?,?,?,0,1,1,1,NULL,NULL,?,?)`,
    ).run(id, projectId, threadId, status, agentId, NOW, NOW);
    database.prepare(
      `INSERT INTO collaboration_thread_facts(
         id,project_id,thread_id,sequence,activity_sequence,type,actor_type,actor_id,
         run_id,message_id,run_event_id,policy_revision_id,payload_json,created_at
       ) VALUES (?,?,?,?,?,'run_linked','system',NULL,?,NULL,NULL,NULL,?,?)`,
    ).run(
      `fact-${id}`,
      projectId,
      threadId,
      thread.factSequence,
      project.activitySequence,
      id,
      JSON.stringify({ runId: id }),
      NOW,
    );
    database.prepare(
      `UPDATE collaboration_threads
       SET next_fact_sequence=next_fact_sequence+1,last_activity_sequence=?
       WHERE project_id=? AND id=?`,
    ).run(project.activitySequence, projectId, threadId);
    database.prepare(
      `UPDATE collaboration_project_thread_sequences
       SET next_activity_sequence=next_activity_sequence+1 WHERE project_id=?`,
    ).run(projectId);
    database.exec("COMMIT");
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
}

function state(projectId: string, threadId: string): Record<string, number | null> {
  const database = openDatabase(databasePath);
  try {
    return database.prepare(
      `SELECT
         (SELECT count(*) FROM collaboration_runs WHERE project_id=? AND thread_id=?) AS runs,
         (SELECT count(*) FROM collaboration_messages WHERE project_id=? AND thread_id=?) AS messages,
         (SELECT count(*) FROM collaboration_events WHERE project_id=? AND thread_id=?) AS events,
         (SELECT count(*) FROM collaboration_thread_facts WHERE project_id=? AND thread_id=?) AS facts,
         (SELECT count(*) FROM collaboration_operations WHERE project_id=? AND thread_id=? AND kind='start') AS operations,
         (SELECT next_message_sequence FROM collaboration_project_sequences WHERE project_id=? AND thread_id=?) AS nextMessageSequence,
         (SELECT next_fact_sequence FROM collaboration_threads WHERE project_id=? AND id=?) AS nextFactSequence,
         (SELECT last_activity_sequence FROM collaboration_threads WHERE project_id=? AND id=?) AS lastActivitySequence`,
    ).get(
      projectId, threadId,
      projectId, threadId,
      projectId, threadId,
      projectId, threadId,
      projectId, threadId,
      projectId, threadId,
      projectId, threadId,
      projectId, threadId,
    ) as Record<string, number | null>;
  } finally {
    database.close();
  }
}

async function route(): Promise<RunRoute> {
  const load = routeModules[
    "../../../app/api/projects/[projectId]/threads/[threadId]/runs/route.ts"
  ];
  expect(load, "tuple-scoped run start route must exist").toBeTypeOf("function");
  return load!();
}

async function post(
  projectId: string,
  threadId: string,
  body: BodyInit,
  contentType = "application/json",
  suffix = "",
): Promise<Response> {
  return (await route()).POST(
    new Request(
      `http://localhost/api/projects/${projectId}/threads/${threadId}/runs${suffix}`,
      { body, headers: { "content-type": contentType }, method: "POST" },
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
    ["agent-a", "agent-b", "agent-extra"],
    "00000000-0000-4000-8000-000000001311",
  );
  threadB = createThread(databasePath, "project-a", {
    memberAgentIds: ["agent-b", "agent-a"],
    operationId: "00000000-0000-4000-8000-000000001312",
    title: "Thread B",
  }).body.thread.id;
  foreignThread = seedProject(
    "project-b",
    ["agent-c", "agent-d"],
    "00000000-0000-4000-8000-000000001313",
  );
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.COCKPIT_DB_PATH;
  delete process.env.COCKPIT_MASTER_KEY;
});

describe("tuple-scoped new CollaborationRun API", () => {
  it("atomically creates the strict run/message and exact ordered fact references", async () => {
    const response = await post("project-a", threadA, JSON.stringify({
      message: "  Begin work  ",
      operationId: OPERATION,
    }));
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual(["created", "facts", "message", "run"]);
    expect(body.created).toBe(true);
    expect(body.run).toEqual({
      id: body.run.id,
      projectId: "project-a",
      threadId: threadA,
      status: "running",
      currentAgentId: "agent-a",
      roundCount: 0,
      pauseCategory: null,
      version: 1,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(body.message).toEqual({
      id: body.message.id,
      projectId: "project-a",
      threadId: threadA,
      sequence: 1,
      runId: body.run.id,
      authorType: "owner",
      authorAgentId: null,
      authorDisplayName: "Owner",
      content: "Begin work",
      mentionAgentId: null,
      mentionDisplayName: null,
      mentionMemberStatus: null,
      createdAt: NOW,
    });
    expect(body.facts.map(({ type }: { type: string }) => type)).toEqual([
      "run_linked",
      "owner_message",
      "run_event",
    ]);
    expect(body.facts.map(({ sequence }: { sequence: number }) => sequence)).toEqual([3, 4, 5]);
    expect(body.facts.map(({ activitySequence }: { activitySequence: number }) => activitySequence))
      .toEqual([5, 6, 7]);
    expect(body.facts[0]).toMatchObject({
      actorId: null,
      actorType: "system",
      message: null,
      messageId: null,
      payload: { runId: body.run.id },
      policyRevisionId: null,
      projectId: "project-a",
      runEventId: null,
      runId: body.run.id,
      threadId: threadA,
    });
    expect(body.facts[1]).toMatchObject({
      actorId: null,
      actorType: "owner",
      message: body.message,
      messageId: body.message.id,
      payload: { messageId: body.message.id },
      policyRevisionId: null,
      runEventId: null,
      runId: body.run.id,
    });
    expect(body.facts[2]).toMatchObject({
      actorId: null,
      actorType: "owner",
      message: null,
      messageId: null,
      payload: { eventType: "run_started" },
      policyRevisionId: null,
      runId: body.run.id,
      runEventId: body.facts[2].runEventId,
    });

    const database = openDatabase(databasePath);
    try {
      expect(database.prepare(
        `SELECT sequence,type,actor_type AS actorType,actor_id AS actorId,payload_json AS payloadJson
         FROM collaboration_events WHERE project_id=? AND thread_id=? AND run_id=?`,
      ).all("project-a", threadA, body.run.id)).toEqual([{
        actorId: null,
        actorType: "owner",
        payloadJson: JSON.stringify({
          currentAgentId: "agent-a",
          messageId: body.message.id,
          messageSequence: 1,
        }),
        sequence: 1,
        type: "run_started",
      }]);
      expect(state("project-a", threadA)).toEqual({
        events: 1,
        facts: 5,
        lastActivitySequence: 7,
        messages: 1,
        nextFactSequence: 6,
        nextMessageSequence: 2,
        operations: 1,
        runs: 1,
      });
    } finally {
      database.close();
    }
  });

  it("uses policy position zero deterministically unless a valid mention overrides it", async () => {
    const defaultStart = await post("project-a", threadB, JSON.stringify({
      message: "Default",
      operationId: OPERATION,
    }));
    expect((await defaultStart.json()).run.currentAgentId).toBe("agent-b");

    const database = openDatabase(databasePath);
    try {
      database.prepare("UPDATE collaboration_runs SET status='stopped' WHERE project_id='project-a'")
        .run();
    } finally {
      database.close();
    }
    const mentioned = await post("project-a", threadA, JSON.stringify({
      mentionAgentId: "agent-b",
      message: "Mention",
      operationId: "00000000-0000-4000-8000-000000001302",
    }));
    const body = await mentioned.json();
    expect(body.run.currentAgentId).toBe("agent-b");
    expect(body.message).toMatchObject({
      mentionAgentId: "agent-b",
      mentionDisplayName: "Agent agent-b",
      mentionMemberStatus: "current",
    });
  });

  it("rejects policy repair and selected Provider unreadiness with no writes", async () => {
    const database = openDatabase(databasePath);
    try {
      database.prepare(
        "DELETE FROM project_memberships WHERE project_id='project-a' AND agent_id='agent-b'",
      ).run();
    } finally {
      database.close();
    }
    const beforeRepair = state("project-a", threadA);
    const repair = await post("project-a", threadA, JSON.stringify({
      message: "No",
      operationId: OPERATION,
    }));
    expect(repair.status).toBe(409);
    expect(await repair.json()).toMatchObject({
      error: { code: "THREAD_POLICY_REPAIR_REQUIRED" },
    });
    expect(state("project-a", threadA)).toEqual(beforeRepair);

    const restore = openDatabase(databasePath);
    try {
      restore.prepare(
        "INSERT INTO project_memberships(project_id,agent_id,joined_at) VALUES ('project-a','agent-b',?)",
      ).run(NOW);
      restore.prepare(
        `UPDATE providers SET verified_at=''
         WHERE id=(SELECT provider_id FROM agents WHERE id='agent-a')`,
      ).run();
    } finally {
      restore.close();
    }
    const beforeProvider = state("project-a", threadA);
    const unavailable = await post("project-a", threadA, JSON.stringify({
      message: "No",
      operationId: "00000000-0000-4000-8000-000000001302",
    }));
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({
      error: {
        category: "credential_unavailable",
        code: "CREDENTIAL_UNAVAILABLE",
      },
    });
    expect(state("project-a", threadA)).toEqual(beforeProvider);
  });

  it.each([
    ["same thread", (thread: string) => thread],
    ["other thread", () => threadB],
  ])("returns the safe active tuple for an active run in the %s", async (_label, selectThread) => {
    insertRun("active-run", "project-a", selectThread(threadA), "agent-a", "running");
    const before = state("project-a", threadA);
    const response = await post("project-a", threadA, JSON.stringify({
      message: "No",
      operationId: OPERATION,
    }));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: {
        activeRunId: "active-run",
        activeThreadId: selectThread(threadA),
        code: "PROJECT_RUN_ACTIVE",
        message: "Another thread has an active project run.",
      },
    });
    expect(state("project-a", threadA)).toEqual(before);
  });

  it("uses safe identical 404s for unknown and cross-project tuples without leaking active IDs", async () => {
    insertRun("foreign-active", "project-b", foreignThread, "agent-c", "running");
    const responses = await Promise.all([
      post("project-a", "unknown-thread", JSON.stringify({
        message: "No",
        operationId: OPERATION,
      })),
      post("project-a", foreignThread, JSON.stringify({
        message: "No",
        operationId: "00000000-0000-4000-8000-000000001302",
      })),
    ]);
    expect(responses.map(({ status }) => status)).toEqual([404, 404]);
    const bodies = await Promise.all(responses.map((response) => response.json()));
    expect(bodies[0]).toEqual(bodies[1]);
    expect(bodies[0]).toEqual({
      error: { code: "RESOURCE_NOT_FOUND", message: "Resource was not found." },
    });
  });

  it("replays the exact response and conflicts without writes for another hash or tuple", async () => {
    const input = JSON.stringify({ message: "Stable", operationId: OPERATION });
    const first = await post("project-a", threadA, input);
    const firstText = await first.text();
    const afterFirst = state("project-a", threadA);
    const replay = await post("project-a", threadA, input);
    expect(replay.status).toBe(201);
    expect(await replay.text()).toBe(firstText);
    expect(state("project-a", threadA)).toEqual(afterFirst);

    const conflict = await post("project-a", threadA, JSON.stringify({
      message: "Changed",
      operationId: OPERATION,
    }));
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: { code: "OPERATION_CONFLICT" } });
    const tupleConflict = await post("project-a", threadB, input);
    expect(tupleConflict.status).toBe(409);
    expect(await tupleConflict.json()).toMatchObject({ error: { code: "OPERATION_CONFLICT" } });
    expect(state("project-a", threadA)).toEqual(afterFirst);
  });

  it("starts a fresh identity after terminal history and never migrates the old run", async () => {
    insertRun("terminal-run", "project-a", threadA, "agent-b", "stopped");
    const response = await post("project-a", threadA, JSON.stringify({
      message: "New round",
      operationId: OPERATION,
    }));
    const body = await response.json();
    expect(response.status).toBe(201);
    expect(body.created).toBe(true);
    expect(body.run.id).not.toBe("terminal-run");
    const database = openDatabase(databasePath);
    try {
      expect(database.prepare(
        `SELECT id,thread_id AS threadId,status,current_agent_id AS currentAgentId
         FROM collaboration_runs WHERE project_id='project-a' ORDER BY id`,
      ).all()).toEqual([
        {
          currentAgentId: body.run.currentAgentId,
          id: body.run.id,
          status: "running",
          threadId: threadA,
        },
        {
          currentAgentId: "agent-b",
          id: "terminal-run",
          status: "stopped",
          threadId: threadA,
        },
      ]);
    } finally {
      database.close();
    }
  });

  it.each([
    [{ message: "x" }, "missing operation"],
    [{ message: "", operationId: OPERATION }, "empty message"],
    [{ message: "a".repeat(10_001), operationId: OPERATION }, "long message"],
    [{ message: "x", mentionAgentId: null, operationId: OPERATION }, "null mention"],
    [{ message: "x", operationId: OPERATION, extra: true }, "extra key"],
  ])("rejects the strict request envelope and bounds: %s (%s)", async (body, _description) => {
    const before = state("project-a", threadA);
    const response = await post("project-a", threadA, JSON.stringify(body));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "INVALID_INPUT" } });
    expect(state("project-a", threadA)).toEqual(before);
  });

  it("enforces route media, JSON, byte, query, fragment, and path bounds", async () => {
    expect((await post("project-a", threadA, "{}", "text/plain")).status).toBe(415);
    expect((await post("project-a", threadA, "{")).status).toBe(400);
    expect((await post(
      "project-a",
      threadA,
      JSON.stringify({ message: "a".repeat(65_536), operationId: OPERATION }),
    )).status).toBe(413);
    expect((await post(
      "project-a",
      threadA,
      JSON.stringify({ message: "x", operationId: OPERATION }),
      "application/json",
      "?extra=1",
    )).status).toBe(400);
    expect((await post(
      "project-a",
      threadA,
      JSON.stringify({ message: "x", operationId: OPERATION }),
      "application/json",
      "#fragment",
    )).status).toBe(400);
    expect((await post(
      "bad%2Fproject",
      threadA,
      JSON.stringify({ message: "x", operationId: OPERATION }),
    )).status).toBe(400);
  });

  it.each([
    "after_receipt",
    "after_run",
    "after_message",
    "after_event",
    "after_facts",
    "after_sequences",
  ] satisfies StartFaultPoint[])("rolls every durable write back at %s", async (point) => {
    const service = await import(
      "@/src/adapters/outbound/sqlite/public-collaboration/thread-service"
    ) as unknown as RunStartService;
    expect(service.startThreadRun).toBeTypeOf("function");
    const before = state("project-a", threadA);
    expect(() => service.startThreadRun(
      databasePath,
      "project-a",
      threadA,
      { message: "Rollback", operationId: OPERATION },
      { fault: (current) => {
        if (current === point) throw new Error(`fault:${point}`);
      } },
    )).toThrow(`fault:${point}`);
    expect(state("project-a", threadA)).toEqual(before);
  });
});
