import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createThread } from "@/src/adapters/outbound/sqlite/public-collaboration/thread-service";
import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";

type GetRoute = {
  GET(
    request: Request,
    context: { params: Promise<{ projectId: string; threadId: string }> },
  ): Promise<Response>;
};

const messageRouteModules = import.meta.glob<GetRoute>(
  "../../../app/api/projects/[projectId]/threads/[threadId]/messages/route.ts",
);
const factRouteModules = import.meta.glob<GetRoute>(
  "../../../app/api/projects/[projectId]/threads/[threadId]/facts/route.ts",
);

const NOW = "2026-08-08T08:00:00.000Z";
let directory: string;
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
         VALUES (?,?,?,NULL,NULL,1)`,
      )
      .run(projectId, projectId, NOW);
    const providerId = `provider-${projectId}`;
    database
      .prepare(
        `INSERT INTO providers(
           id,name,base_url,default_model,api_key_cipher,api_key_iv,api_key_tag,
           credential_version,credential_generation,key_id,api_key_mask,verified_at,
           version,created_at,updated_at
         ) VALUES (?,'Provider','http://localhost/v1','model','cipher','iv','tag',
           1,1,'key','***',?,1,?,?)`,
      )
      .run(providerId, NOW, NOW, NOW);
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
    memberAgentIds: agentIds,
    operationId,
    title: `Thread ${projectId}`,
  }).body.thread.id;
}

function seedMessages(
  projectId: string,
  threadId: string,
  authorAgentId: string,
  prefix: string,
): void {
  const database = openDatabase(databasePath);
  try {
    database.exec("BEGIN IMMEDIATE");
    const thread = database
      .prepare(
        `SELECT next_fact_sequence AS nextFactSequence,last_activity_sequence AS lastActivity
         FROM collaboration_threads WHERE project_id=? AND id=?`,
      )
      .get(projectId, threadId) as { nextFactSequence: number; lastActivity: number };
    const activity = database
      .prepare(
        `SELECT next_activity_sequence AS nextActivity
         FROM collaboration_project_thread_sequences WHERE project_id=?`,
      )
      .get(projectId) as { nextActivity: number };
    const insertMessage = database.prepare(
      `INSERT INTO collaboration_messages(
         id,project_id,thread_id,run_id,author_type,author_agent_id,
         author_display_name,content,mention_agent_id,mention_display_name,
         sequence,consumed_at,created_at
       ) VALUES (?,?,?,NULL,?,?,?,?,NULL,NULL,?,NULL,?)`,
    );
    const insertFact = database.prepare(
      `INSERT INTO collaboration_thread_facts(
         id,project_id,thread_id,sequence,activity_sequence,type,actor_type,actor_id,
         run_id,message_id,run_event_id,policy_revision_id,payload_json,created_at
       ) VALUES (?,?,?,?,?,'agent_message','agent',?,NULL,?,NULL,NULL,?,?)`,
    );
    for (let index = 1; index <= 3; index += 1) {
      const messageId = `${prefix}-message-${index}`;
      const createdAt = `2026-08-08T08:00:0${index}.000Z`;
      insertMessage.run(
        messageId,
        projectId,
        threadId,
        "agent",
        authorAgentId,
        `Agent ${authorAgentId}`,
        `${prefix} content ${index}`,
        index,
        createdAt,
      );
      insertFact.run(
        `${prefix}-fact-${index}`,
        projectId,
        threadId,
        thread.nextFactSequence + index - 1,
        activity.nextActivity + index - 1,
        authorAgentId,
        messageId,
        JSON.stringify({ messageId }),
        createdAt,
      );
    }
    database
      .prepare(
        `UPDATE collaboration_threads
         SET next_fact_sequence=next_fact_sequence+3,last_activity_sequence=?
         WHERE project_id=? AND id=?`,
      )
      .run(activity.nextActivity + 2, projectId, threadId);
    database
      .prepare(
        `UPDATE collaboration_project_thread_sequences
         SET next_activity_sequence=next_activity_sequence+3 WHERE project_id=?`,
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

function replaceFactPayload(factId: string, messageId: string): void {
  const database = openDatabase(databasePath);
  try {
    database.exec("DROP TRIGGER thread_fact_no_update");
    database
      .prepare(
        `UPDATE collaboration_thread_facts SET payload_json=?
         WHERE project_id=? AND thread_id=? AND id=?`,
      )
      .run(JSON.stringify({ messageId }), "project-a", threadA, factId);
    database.exec(
      `CREATE TRIGGER thread_fact_no_update BEFORE UPDATE ON collaboration_thread_facts
       BEGIN SELECT RAISE(ABORT,'IMMUTABLE_THREAD_FACT'); END;`,
    );
  } finally {
    database.close();
  }
}

async function route(kind: "messages" | "facts"): Promise<GetRoute> {
  const key = `../../../app/api/projects/[projectId]/threads/[threadId]/${kind}/route.ts`;
  const load = (kind === "messages" ? messageRouteModules : factRouteModules)[key];
  expect(load, `${kind} history route must exist`).toBeTypeOf("function");
  return load!();
}

async function history(
  kind: "messages" | "facts",
  projectId: string,
  threadId: string,
  query = "",
): Promise<Response> {
  return (await route(kind)).GET(
    new Request(
      `http://localhost/api/projects/${projectId}/threads/${threadId}/${kind}${query}`,
    ),
    { params: Promise.resolve({ projectId, threadId }) },
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  directory = mkdtempSync(join(tmpdir(), "thread-history-api-"));
  databasePath = join(directory, "cockpit.sqlite");
  process.env.COCKPIT_DB_PATH = databasePath;
  threadA = seedProject(
    "project-a",
    ["agent-a", "agent-b"],
    "00000000-0000-4000-8000-000000001101",
  );
  threadB = createThread(databasePath, "project-a", {
    memberAgentIds: ["agent-a", "agent-b"],
    operationId: "00000000-0000-4000-8000-000000001102",
    title: "Thread B",
  }).body.thread.id;
  foreignThread = seedProject(
    "project-b",
    ["agent-c", "agent-d"],
    "00000000-0000-4000-8000-000000001103",
  );
  seedMessages("project-a", threadA, "agent-a", "a");
  seedMessages("project-a", threadB, "agent-b", "b");
  seedMessages("project-b", foreignThread, "agent-c", "foreign");
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.COCKPIT_DB_PATH;
  rmSync(directory, { force: true, recursive: true });
});

describe("tuple-scoped thread history API", () => {
  it.each(["messages", "facts"] as const)(
    "returns stable first, middle, and end %s pages",
    async (kind) => {
      const first = await history(kind, "project-a", threadA, "?after=0&limit=2");
      expect(first.status).toBe(200);
      const firstBody = await first.json();
      expect(firstBody.items.map(({ sequence }: { sequence: number }) => sequence)).toEqual(
        kind === "messages" ? [1, 2] : [1, 2],
      );
      expect(firstBody.nextAfter).toBe(2);

      const middle = await history(
        kind,
        "project-a",
        threadA,
        `?after=${firstBody.nextAfter}&limit=2`,
      );
      const middleBody = await middle.json();
      expect(middleBody.items.map(({ sequence }: { sequence: number }) => sequence)).toEqual(
        kind === "messages" ? [3] : [3, 4],
      );
      expect(middleBody.nextAfter).toBe(kind === "messages" ? null : 4);

      const end = await history(
        kind,
        "project-a",
        threadA,
        `?after=${kind === "messages" ? 3 : 4}&limit=2`,
      );
      const endBody = await end.json();
      expect(endBody.items.map(({ sequence }: { sequence: number }) => sequence)).toEqual(
        kind === "messages" ? [] : [5],
      );
      expect(endBody.nextAfter).toBeNull();
    },
  );

  it("uses independent message and fact cursors and returns null at each end", async () => {
    const [messages, facts] = await Promise.all([
      history("messages", "project-a", threadA, "?after=1&limit=1"),
      history("facts", "project-a", threadA, "?after=2&limit=1"),
    ]);
    expect(await messages.json()).toMatchObject({
      items: [{ sequence: 2 }],
      nextAfter: 2,
    });
    expect(await facts.json()).toMatchObject({
      items: [{ sequence: 3 }],
      nextAfter: 3,
    });

    const [messageEnd, factEnd] = await Promise.all([
      history("messages", "project-a", threadA, "?after=3&limit=50"),
      history("facts", "project-a", threadA, "?after=5&limit=50"),
    ]);
    expect(await messageEnd.json()).toEqual({ items: [], nextAfter: null });
    expect(await factEnd.json()).toEqual({ items: [], nextAfter: null });
  });

  it("returns exact message DTOs and nests the referenced DTO only in message facts", async () => {
    const messages = await (
      await history("messages", "project-a", threadA, "?after=0&limit=1")
    ).json();
    expect(messages.items[0]).toEqual({
      id: "a-message-1",
      projectId: "project-a",
      threadId: threadA,
      sequence: 1,
      runId: null,
      authorType: "agent",
      authorAgentId: "agent-a",
      authorDisplayName: "Agent agent-a",
      content: "a content 1",
      mentionAgentId: null,
      mentionDisplayName: null,
      mentionMemberStatus: null,
      createdAt: "2026-08-08T08:00:01.000Z",
    });

    const facts = await (
      await history("facts", "project-a", threadA, "?after=0&limit=3")
    ).json();
    expect(facts.items[0].message).toBeNull();
    expect(facts.items[1].message).toBeNull();
    expect(facts.items[2]).toMatchObject({
      id: "a-fact-1",
      projectId: "project-a",
      threadId: threadA,
      sequence: 3,
      type: "agent_message",
      messageId: "a-message-1",
      payload: { messageId: "a-message-1" },
      message: messages.items[0],
    });
  });

  it.each([
    "?after=1&after=2",
    "?limit=1&limit=2",
    "?unknown=1",
    "?after=",
    "?after=-1",
    "?after=1.5",
    "?after=9007199254740992",
    "?limit=0",
    "?limit=201",
    "?limit=1e2",
  ])("rejects duplicate, unknown, malformed, or out-of-range query: %s", async (query) => {
    for (const kind of ["messages", "facts"] as const) {
      const response = await history(kind, "project-a", threadA, query);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { code: "INVALID_INPUT" },
      });
    }
  });

  it("uses one safe 404 for unknown and cross-project thread tuples", async () => {
    for (const kind of ["messages", "facts"] as const) {
      const responses = await Promise.all([
        history(kind, "project-a", "unknown-thread"),
        history(kind, "project-a", foreignThread),
      ]);
      expect(responses.map(({ status }) => status)).toEqual([404, 404]);
      expect(await Promise.all(responses.map((response) => response.json()))).toEqual([
        {
          error: {
            code: "RESOURCE_NOT_FOUND",
            message: "Resource was not found.",
          },
        },
        {
          error: {
            code: "RESOURCE_NOT_FOUND",
            message: "Resource was not found.",
          },
        },
      ]);
    }
  });

  it.each([
    ["bad%2Fproject", "thread"],
    ["project-a", "bad%5Cthread"],
    ["project-a", ".."],
  ])("rejects malformed path IDs", async (projectId, threadId) => {
    for (const kind of ["messages", "facts"] as const) {
      const response = await history(kind, projectId, threadId);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { code: "INVALID_INPUT" },
      });
    }
  });

  it("fails closed when a message fact payload names a missing or cross-tuple message", async () => {
    replaceFactPayload("a-fact-1", "missing-message");
    const missing = await history("facts", "project-a", threadA, "?after=2&limit=1");
    expect(missing.status).toBe(404);
    const missingBody = await missing.json();

    replaceFactPayload("a-fact-1", "b-message-1");
    const crossTuple = await history("facts", "project-a", threadA, "?after=2&limit=1");
    expect(crossTuple.status).toBe(404);
    expect(await crossTuple.json()).toEqual(missingBody);
  });

  it("repeats byte-stable reads across fresh database opens", async () => {
    const firstMessages = await (
      await history("messages", "project-a", threadA, "?after=0&limit=200")
    ).text();
    const firstFacts = await (
      await history("facts", "project-a", threadA, "?after=0&limit=200")
    ).text();
    const restartedMessages = await (
      await history("messages", "project-a", threadA, "?after=0&limit=200")
    ).text();
    const restartedFacts = await (
      await history("facts", "project-a", threadA, "?after=0&limit=200")
    ).text();
    expect(restartedMessages).toBe(firstMessages);
    expect(restartedFacts).toBe(firstFacts);
  });
});
