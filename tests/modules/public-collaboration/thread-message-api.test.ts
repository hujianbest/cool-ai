import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createThread,
  writeOwnerThreadMessage,
  type ThreadMessageWriteFaultPoint,
} from "@/src/adapters/outbound/sqlite/public-collaboration/thread-service";
import { createCredentialVault } from "@/src/modules/identity-capability/internal/credential-vault";
import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { memoryDatabasePath } from "@/tests/fixtures/sqlite/memory-database";

type MessageRoute = {
  POST(
    request: Request,
    context: { params: Promise<{ projectId: string; threadId: string }> },
  ): Promise<Response>;
};
type OperationRoute = {
  GET(
    request: Request,
    context: {
      params: Promise<{ projectId: string; threadId: string; operationId: string }>;
    },
  ): Promise<Response>;
};

const messageRoutes = import.meta.glob<MessageRoute>(
  "../../../app/api/projects/[projectId]/threads/[threadId]/messages/route.ts",
);
const operationRoutes = import.meta.glob<OperationRoute>(
  "../../../app/api/projects/[projectId]/threads/[threadId]/operations/[operationId]/route.ts",
);

const NOW = "2026-08-08T08:00:00.000Z";
const MASTER_KEY = Buffer.alloc(32, 31).toString("base64url");
const OPERATION = "00000000-0000-4000-8000-000000001201";
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
       VALUES (?,?,?,NULL,NULL,1)`,
    ).run(projectId, projectId, NOW);
    const providerId = `provider-${projectId}`;
    const encrypted = createCredentialVault().encrypt(providerId, `key-${projectId}`);
    database.prepare(
      `INSERT INTO providers(
         id,name,base_url,default_model,api_key_cipher,api_key_iv,api_key_tag,
         credential_version,credential_generation,key_id,api_key_mask,verified_at,
         version,created_at,updated_at
       ) VALUES (?,'Provider','http://localhost/v1','model',?,?,?,?,1,?,?,?,1,?,?)`,
    ).run(
      providerId,
      encrypted.apiKeyCipher,
      encrypted.apiKeyIv,
      encrypted.apiKeyTag,
      encrypted.credentialVersion,
      encrypted.keyId,
      encrypted.apiKeyMask,
      NOW,
      NOW,
      NOW,
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
      insertAgent.run(agentId, `Agent ${agentId}`, providerId, NOW, NOW);
      insertMember.run(projectId, agentId, `2026-08-08T08:00:0${position}.000Z`);
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

function counts(projectId: string, threadId: string) {
  const database = openDatabase(databasePath);
  try {
    return database.prepare(
      `SELECT
         (SELECT count(*) FROM collaboration_messages
           WHERE project_id=? AND thread_id=?) AS messages,
         (SELECT count(*) FROM collaboration_thread_facts
           WHERE project_id=? AND thread_id=? AND type='owner_message') AS facts,
         (SELECT count(*) FROM collaboration_operations
           WHERE project_id=? AND thread_id=? AND kind='message') AS operations,
         (SELECT next_message_sequence FROM collaboration_project_sequences
           WHERE project_id=? AND thread_id=?) AS nextMessageSequence,
         (SELECT next_fact_sequence FROM collaboration_threads
           WHERE project_id=? AND id=?) AS nextFactSequence,
         (SELECT last_activity_sequence FROM collaboration_threads
           WHERE project_id=? AND id=?) AS lastActivitySequence`,
    ).get(
      projectId, threadId,
      projectId, threadId,
      projectId, threadId,
      projectId, threadId,
      projectId, threadId,
      projectId, threadId,
    );
  } finally {
    database.close();
  }
}

function addActiveRun(projectId: string, threadId: string, agentId: string): void {
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
       ) VALUES ('active-run',?,?, 'running',?,0,1,1,1,NULL,NULL,?,?)`,
    ).run(projectId, threadId, agentId, NOW, NOW);
    database.prepare(
      `INSERT INTO collaboration_thread_facts(
         id,project_id,thread_id,sequence,activity_sequence,type,actor_type,actor_id,
         run_id,message_id,run_event_id,policy_revision_id,payload_json,created_at
       ) VALUES ('active-run-fact',?,?,?,?,'run_linked','system',NULL,
         'active-run',NULL,NULL,NULL,?,?)`,
    ).run(
      projectId,
      threadId,
      thread.factSequence,
      project.activitySequence,
      JSON.stringify({ runId: "active-run" }),
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

async function messageRoute(): Promise<MessageRoute> {
  const load = messageRoutes[
    "../../../app/api/projects/[projectId]/threads/[threadId]/messages/route.ts"
  ];
  expect(load).toBeTypeOf("function");
  return load!();
}

async function post(
  projectId: string,
  threadId: string,
  body: BodyInit,
  contentType = "application/json",
  urlSuffix = "",
): Promise<Response> {
  return (await messageRoute()).POST(
    new Request(
      `http://localhost/api/projects/${projectId}/threads/${threadId}/messages${urlSuffix}`,
      { body, headers: { "content-type": contentType }, method: "POST" },
    ),
    { params: Promise.resolve({ projectId, threadId }) },
  );
}

async function lookup(
  projectId: string,
  threadId: string,
  operationId: string,
  suffix = "",
): Promise<Response> {
  const key =
    "../../../app/api/projects/[projectId]/threads/[threadId]/operations/[operationId]/route.ts";
  const load = operationRoutes[key];
  expect(load, "thread operation lookup route must exist").toBeTypeOf("function");
  return (await load!()).GET(
    new Request(
      `http://localhost/api/projects/${projectId}/threads/${threadId}/operations/${operationId}${suffix}`,
    ),
    { params: Promise.resolve({ operationId, projectId, threadId }) },
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  databasePath = memoryDatabasePath();
  process.env.COCKPIT_MASTER_KEY = MASTER_KEY;
  process.env.COCKPIT_DB_PATH = databasePath;
  threadA = seedProject(
    "project-a",
    ["agent-a", "agent-b", "agent-extra"],
    "00000000-0000-4000-8000-000000001211",
  );
  threadB = createThread(databasePath, "project-a", {
    memberAgentIds: ["agent-a", "agent-b"],
    operationId: "00000000-0000-4000-8000-000000001212",
    title: "Thread B",
  }).body.thread.id;
  foreignThread = seedProject(
    "project-b",
    ["agent-c", "agent-d"],
    "00000000-0000-4000-8000-000000001213",
  );
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.COCKPIT_DB_PATH;
  delete process.env.COCKPIT_MASTER_KEY;
});

describe("tuple-scoped owner message API", () => {
  it("atomically returns the exact nested message/fact response without starting a run", async () => {
    addActiveRun("project-a", threadB, "agent-a");
    const response = await post("project-a", threadA, JSON.stringify({
      content: "  Hello 👩🏽‍💻  ",
      mentionAgentId: "agent-b",
      operationId: OPERATION,
    }));
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual(["fact", "message", "run"]);
    expect(body.run).toBeNull();
    expect(body.message).toEqual({
      id: body.message.id,
      projectId: "project-a",
      threadId: threadA,
      sequence: 1,
      runId: null,
      authorType: "owner",
      authorAgentId: null,
      authorDisplayName: "Owner",
      content: "Hello 👩🏽‍💻",
      mentionAgentId: "agent-b",
      mentionDisplayName: "Agent agent-b",
      mentionMemberStatus: "current",
      createdAt: NOW,
    });
    expect(body.fact).toEqual({
      id: body.fact.id,
      projectId: "project-a",
      threadId: threadA,
      sequence: 3,
      activitySequence: 6,
      type: "owner_message",
      actorType: "owner",
      actorId: null,
      runId: null,
      messageId: body.message.id,
      runEventId: null,
      policyRevisionId: null,
      payload: { messageId: body.message.id },
      message: body.message,
      createdAt: NOW,
    });
    expect(counts("project-a", threadA)).toEqual({
      facts: 1,
      lastActivitySequence: 6,
      messages: 1,
      nextFactSequence: 4,
      nextMessageSequence: 2,
      operations: 1,
    });
  });

  it("replays the exact status/body and conflicts on the same ID with another hash", async () => {
    const input = JSON.stringify({ content: "Stable", operationId: OPERATION });
    const first = await post("project-a", threadA, input);
    const firstText = await first.text();
    const replay = await post("project-a", threadA, input);
    expect(replay.status).toBe(201);
    expect(await replay.text()).toBe(firstText);

    const conflict = await post("project-a", threadA, JSON.stringify({
      content: "Changed",
      operationId: OPERATION,
    }));
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({
      error: {
        code: "OPERATION_CONFLICT",
        message: "Operation id was already used for different input.",
      },
    });
    expect(counts("project-a", threadA)).toMatchObject({
      facts: 1,
      messages: 1,
      operations: 1,
    });
  });

  it("recovers an uncertain result through the strict thread operation lookup", async () => {
    const created = await post("project-a", threadA, JSON.stringify({
      content: "Recover me",
      operationId: OPERATION,
    }));
    const createdBody = await created.json();
    const operation = await lookup("project-a", threadA, OPERATION);
    expect(operation.status).toBe(200);
    expect(await operation.json()).toEqual({
      operationId: OPERATION,
      kind: "message",
      status: "completed",
      httpStatus: 201,
      response: createdBody,
    });
    expect((await lookup("project-a", threadB, OPERATION)).status).toBe(404);
    expect((await lookup("project-b", foreignThread, OPERATION)).status).toBe(404);
    expect((await lookup("project-a", threadA, OPERATION, "?extra=1")).status).toBe(400);
  });

  it.each([
    [{ content: "x" }, "missing operationId"],
    [{ content: "x", operationId: "not-uuid" }, "invalid operationId"],
    [{ content: "", operationId: OPERATION }, "empty content"],
    [{ content: "a".repeat(10_001), operationId: OPERATION }, "long content"],
    [{ content: "x", mentionAgentId: null, operationId: OPERATION }, "null mention"],
    [{ content: "x", operationId: OPERATION, extra: true }, "extra key"],
  ])("rejects strict body envelope: %s (%s)", async (body, _description) => {
    const response = await post("project-a", threadA, JSON.stringify(body));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "INVALID_INPUT" } });
    expect(counts("project-a", threadA)).toMatchObject({
      facts: 0,
      messages: 0,
      operations: 0,
    });
  });

  it("enforces content type, valid JSON, and the 65536-byte streaming body limit", async () => {
    const unsupported = await post("project-a", threadA, "{}", "text/plain");
    expect(unsupported.status).toBe(415);
    expect(await unsupported.json()).toMatchObject({
      error: { code: "UNSUPPORTED_MEDIA_TYPE" },
    });
    const malformed = await post("project-a", threadA, "{");
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: { code: "INVALID_JSON" } });
    const oversized = await post(
      "project-a",
      threadA,
      JSON.stringify({ content: "a".repeat(65_536), operationId: OPERATION }),
    );
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toMatchObject({ error: { code: "BODY_TOO_LARGE" } });
    expect(counts("project-a", threadA)).toMatchObject({
      facts: 0,
      messages: 0,
      operations: 0,
    });
  });

  it("accepts the one and 10000 grapheme content boundaries after trimming", async () => {
    const one = await post("project-a", threadA, JSON.stringify({
      content: " x ",
      operationId: OPERATION,
    }));
    expect(one.status).toBe(201);
    expect((await one.json()).message.content).toBe("x");
    const maximum = "a".repeat(10_000);
    const max = await post("project-a", threadA, JSON.stringify({
      content: ` ${maximum} `,
      operationId: "00000000-0000-4000-8000-000000001202",
    }));
    expect(max.status).toBe(201);
    expect((await max.json()).message.content).toBe(maximum);
  });

  it.each([
    ["bad%2Fproject", "thread"],
    ["project-a", "bad%5Cthread"],
    ["project-a", ".."],
  ])("rejects malformed project/thread path IDs", async (projectId, threadId) => {
    const response = await post(projectId, threadId, JSON.stringify({
      content: "No",
      operationId: OPERATION,
    }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "INVALID_INPUT" } });
  });

  it("rejects query keys and fragments on the message route", async () => {
    for (const suffix of ["?unknown=1", "#fragment"]) {
      const response = await post(
        "project-a",
        threadA,
        JSON.stringify({ content: "No", operationId: OPERATION }),
        "application/json",
        suffix,
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "INVALID_INPUT" } });
    }
  });

  it("requires a mention in both the active policy and live project membership", async () => {
    const outsidePolicy = await post("project-a", threadA, JSON.stringify({
      content: "No",
      mentionAgentId: "agent-extra",
      operationId: OPERATION,
    }));
    expect(outsidePolicy.status).toBe(409);
    expect(await outsidePolicy.json()).toMatchObject({ error: { code: "AGENT_NOT_MEMBER" } });

    const database = openDatabase(databasePath);
    try {
      database.prepare(
        "DELETE FROM project_memberships WHERE project_id=? AND agent_id=?",
      ).run("project-a", "agent-b");
    } finally {
      database.close();
    }
    const removed = await post("project-a", threadA, JSON.stringify({
      content: "No",
      mentionAgentId: "agent-b",
      operationId: "00000000-0000-4000-8000-000000001202",
    }));
    expect(removed.status).toBe(409);
    expect(await removed.json()).toMatchObject({ error: { code: "AGENT_NOT_MEMBER" } });
    expect(counts("project-a", threadA)).toMatchObject({
      facts: 0,
      messages: 0,
      operations: 0,
    });
  });

  it("uses identical safe 404s for unknown and cross-project tuples with zero writes", async () => {
    const beforeA = counts("project-a", threadA);
    const beforeForeign = counts("project-b", foreignThread);
    const responses = await Promise.all([
      post("project-a", "unknown-thread", JSON.stringify({
        content: "No",
        operationId: OPERATION,
      })),
      post("project-a", foreignThread, JSON.stringify({
        content: "No",
        operationId: "00000000-0000-4000-8000-000000001202",
      })),
    ]);
    expect(responses.map(({ status }) => status)).toEqual([404, 404]);
    const bodies = await Promise.all(responses.map((response) => response.json()));
    expect(bodies[0]).toEqual(bodies[1]);
    expect(bodies[0]).toEqual({
      error: { code: "RESOURCE_NOT_FOUND", message: "Resource was not found." },
    });
    expect(counts("project-a", threadA)).toEqual(beforeA);
    expect(counts("project-b", foreignThread)).toEqual(beforeForeign);
  });

  it("allocates message sequence independently per thread", async () => {
    const a = await (await post("project-a", threadA, JSON.stringify({
      content: "A1",
      operationId: OPERATION,
    }))).json();
    const b = await (await post("project-a", threadB, JSON.stringify({
      content: "B1",
      operationId: "00000000-0000-4000-8000-000000001202",
    }))).json();
    const a2 = await (await post("project-a", threadA, JSON.stringify({
      content: "A2",
      operationId: "00000000-0000-4000-8000-000000001203",
    }))).json();
    expect([a.message.sequence, b.message.sequence, a2.message.sequence]).toEqual([1, 1, 2]);
  });

  it.each([
    "after_receipt",
    "after_message",
    "after_fact",
    "after_thread_update",
  ] satisfies ThreadMessageWriteFaultPoint[])(
    "rolls back receipt, message, fact, and sequences on %s",
    (point) => {
      const before = counts("project-a", threadA);
      expect(() => writeOwnerThreadMessage(
        databasePath,
        "project-a",
        threadA,
        { content: "Rollback", operationId: OPERATION },
        {
          credentialCheck: () => undefined,
          fault: (current) => {
            if (current === point) throw new Error(`fault:${point}`);
          },
        },
      )).toThrow(`fault:${point}`);
      expect(counts("project-a", threadA)).toEqual(before);
    },
  );

  it("runs the credential hook before transaction writes and leaves no partial state on failure", () => {
    const before = counts("project-a", threadA);
    expect(() => writeOwnerThreadMessage(
      databasePath,
      "project-a",
      threadA,
      { content: "Hook", operationId: OPERATION },
      { credentialCheck: () => { throw new Error("credential hook failed"); } },
    )).toThrow("credential hook failed");
    expect(counts("project-a", threadA)).toEqual(before);
  });
});
