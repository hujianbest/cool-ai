import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  answerThreadDecision,
  type ThreadDecisionAnswerFaultPoint,
} from "@/src/server/collaboration/run-service";
import { createThread } from "@/src/server/collaboration/thread-service";
import { createCredentialVault } from "@/src/server/credential-vault";
import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";

type TupleRoute = {
  POST(
    request: Request,
    context: {
      params: Promise<{
        decisionId: string;
        projectId: string;
        runId: string;
        threadId: string;
      }>;
    },
  ): Promise<Response>;
};

const tupleRoutes = import.meta.glob<TupleRoute>(
  "../app/api/projects/[projectId]/threads/[threadId]/runs/[runId]/decisions/[decisionId]/answer/route.ts",
);
const legacyRoutes = import.meta.glob<TupleRoute>(
  "../app/api/runs/[runId]/decisions/[decisionId]/answer/route.ts",
);

const NOW = "2026-08-08T08:00:00.000Z";
const MASTER_KEY = Buffer.alloc(32, 37).toString("base64url");
let databasePath: string;
let directory: string;
let threadA: string;

function operationId(sequence: number): string {
  return `16000000-0000-4000-8000-${sequence.toString().padStart(12, "0")}`;
}

function seedProject(): void {
  const encrypted = createCredentialVault().encrypt("provider-a", "key-provider-a");
  const database = openDatabase(databasePath);
  try {
    database.exec(`
      INSERT INTO projects(id,name,created_at,workspace_path,workspace_key,version)
      VALUES ('project-a','A','${NOW}','D:\\a','d:/a',1);
    `);
    database.prepare(
      `INSERT INTO providers(
         id,name,base_url,default_model,api_key_cipher,api_key_iv,api_key_tag,
         credential_version,credential_generation,key_id,api_key_mask,verified_at,
         version,created_at,updated_at
       ) VALUES ('provider-a','P','http://localhost/v1','model',?,?,?,?,1,?,?,?,1,?,?)`,
    ).run(
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
    database.exec(`
      INSERT INTO agents(
        id,name,role,system_prompt,provider_id,model,avatar_text,accent_token,
        can_read,can_write,can_execute,max_tokens,max_handoffs,version,created_at,
        updated_at,review_capable
      ) VALUES
        ('agent-a','Agent A','Peer','Prompt','provider-a','model','A','sage',
         1,1,0,1000,3,1,'${NOW}','${NOW}',0),
        ('agent-b','Agent B','Peer','Prompt','provider-a','model','B','gold',
         1,1,0,1000,3,1,'${NOW}','${NOW}',0);
      INSERT INTO project_memberships(project_id,agent_id,joined_at) VALUES
        ('project-a','agent-a','${NOW}'),
        ('project-a','agent-b','2026-08-08T08:00:01.000Z');
    `);
  } finally {
    database.close();
  }
  threadA = createThread(databasePath, "project-a", {
    memberAgentIds: ["agent-a", "agent-b"],
    operationId: operationId(1),
    title: "Thread A",
  }).body.thread.id;
}

function seedDecision(): void {
  const database = openDatabase(databasePath);
  try {
    database.exec("BEGIN IMMEDIATE");
    database.prepare(`
      INSERT INTO collaboration_runs(
        id,project_id,thread_id,status,current_agent_id,round_count,
        next_event_sequence,version,execution_epoch,pause_reason,pause_category,
        created_at,updated_at
      ) VALUES ('run-a','project-a',?,'waiting_owner','agent-a',1,1,2,1,NULL,NULL,?,?)
    `).run(threadA, NOW, NOW);
    database.prepare(`
      INSERT INTO collaboration_operations(
        id,project_id,thread_id,run_id,kind,request_hash,status,http_status,
        response_json,response_schema_version,created_at,updated_at
      ) VALUES (?,?,?,?, 'advance','hash','completed',200,'{}',7,?,?)
    `).run(operationId(2), "project-a", threadA, "run-a", NOW, NOW);
    database.prepare(`
      INSERT INTO collaboration_messages(
        id,project_id,thread_id,run_id,author_type,author_agent_id,
        author_display_name,content,mention_agent_id,mention_display_name,
        sequence,consumed_at,created_at
      ) VALUES ('agent-message','project-a',?,'run-a','agent','agent-a',
                'Agent A','Choose',NULL,NULL,1,NULL,?)
    `).run(threadA, NOW);
    database.prepare(`
      INSERT INTO collaboration_project_sequences(
        project_id,thread_id,next_message_sequence
      ) VALUES ('project-a',?,2)
    `).run(threadA);
    database.prepare(`
      INSERT INTO collaboration_attempts(
        id,project_id,thread_id,run_id,agent_id,operation_id,status,lease_token,
        lease_expires_at,prompt_hash,acquire_execution_epoch,acquire_context_hash,
        included_message_sequence,error_category,started_at,finished_at
      ) VALUES ('attempt-a','project-a',?,'run-a','agent-a',?,'committed','lease',
                '2026-08-08T08:01:00.000Z','prompt',1,'context',0,NULL,?,?)
    `).run(threadA, operationId(2), NOW, NOW);
    database.prepare(`
      INSERT INTO collaboration_turns(
        id,project_id,thread_id,attempt_id,run_id,agent_id,round_number,
        message_id,disposition,created_at
      ) VALUES ('turn-a','project-a',?,'attempt-a','run-a','agent-a',1,
                'agent-message','decision_request',?)
    `).run(threadA, NOW);
    database.prepare(`
      INSERT INTO decision_requests(
        id,project_id,thread_id,run_id,turn_id,requesting_agent_id,question,
        options_json,status,answer,answer_message_id,version,created_at,answered_at
      ) VALUES ('decision-a','project-a',?,'run-a','turn-a','agent-a','Proceed?',
                json_array('Yes','No'),'open',NULL,NULL,1,?,NULL)
    `).run(threadA, NOW);
    database.prepare(`
      INSERT INTO collaboration_thread_facts(
        id,project_id,thread_id,sequence,activity_sequence,type,actor_type,actor_id,
        run_id,message_id,run_event_id,policy_revision_id,payload_json,created_at
      ) VALUES
        ('fact-run','project-a',?,3,3,'run_linked','system',NULL,
         'run-a',NULL,NULL,NULL,json_object('runId','run-a'),?),
        ('fact-agent-message','project-a',?,4,4,'agent_message','agent','agent-a',
         'run-a','agent-message',NULL,NULL,json_object('messageId','agent-message'),?)
    `).run(threadA, NOW, threadA, NOW);
    database.prepare(`
      UPDATE collaboration_threads
      SET next_fact_sequence=5,last_activity_sequence=4
      WHERE project_id='project-a' AND id=?
    `).run(threadA);
    database.prepare(`
      UPDATE collaboration_project_thread_sequences
      SET next_activity_sequence=5 WHERE project_id='project-a'
    `).run();
    database.exec("COMMIT");
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
}

async function route(): Promise<TupleRoute> {
  const load = tupleRoutes[
    "../app/api/projects/[projectId]/threads/[threadId]/runs/[runId]/decisions/[decisionId]/answer/route.ts"
  ];
  expect(load, "tuple-scoped decision answer route must exist").toBeTypeOf("function");
  return load!();
}

async function post(
  body: unknown,
  tuple: {
    decisionId?: string;
    projectId?: string;
    runId?: string;
    threadId?: string;
  } = {},
  options: {
    contentType?: string;
    query?: string;
    rawBody?: string;
  } = {},
): Promise<Response> {
  const projectId = tuple.projectId ?? "project-a";
  const threadId = tuple.threadId ?? threadA;
  const runId = tuple.runId ?? "run-a";
  const decisionId = tuple.decisionId ?? "decision-a";
  return (await route()).POST(
    new Request(
      `http://localhost/api/projects/${projectId}/threads/${threadId}/runs/${runId}/decisions/${decisionId}/answer${options.query ?? ""}`,
      {
        body: options.rawBody ?? JSON.stringify(body),
        headers: options.contentType === undefined
          ? { "content-type": "application/json" }
          : { "content-type": options.contentType },
        method: "POST",
      },
    ),
    {
      params: Promise.resolve({
        decisionId,
        projectId,
        runId,
        threadId,
      }),
    },
  );
}

function snapshot(): unknown {
  const database = openDatabase(databasePath);
  try {
    return {
      activities: database.prepare(
        `SELECT next_activity_sequence AS nextActivitySequence
         FROM collaboration_project_thread_sequences WHERE project_id='project-a'`,
      ).get(),
      decision: database.prepare(
        `SELECT status,answer,answer_message_id AS answerMessageId,version,answered_at AS answeredAt
         FROM decision_requests WHERE id='decision-a'`,
      ).get(),
      events: database.prepare(
        `SELECT id,project_id AS projectId,thread_id AS threadId,run_id AS runId,
                sequence,type,actor_type AS actorType,payload_json AS payload
         FROM collaboration_events WHERE run_id='run-a' ORDER BY sequence`,
      ).all(),
      facts: database.prepare(
        `SELECT id,sequence,activity_sequence AS activitySequence,type,actor_type AS actorType,
                run_id AS runId,message_id AS messageId,run_event_id AS runEventId,
                payload_json AS payload
         FROM collaboration_thread_facts WHERE project_id='project-a' AND thread_id=?
         ORDER BY sequence`,
      ).all(threadA),
      messages: database.prepare(
        `SELECT id,project_id AS projectId,thread_id AS threadId,run_id AS runId,
                author_type AS authorType,author_display_name AS authorDisplayName,
                content,mention_agent_id AS mentionAgentId,
                mention_display_name AS mentionDisplayName,sequence
         FROM collaboration_messages WHERE project_id='project-a' AND thread_id=?
         ORDER BY sequence`,
      ).all(threadA),
      operations: database.prepare(
        `SELECT id,thread_id AS threadId,run_id AS runId,kind,status,http_status AS httpStatus,
                response_json AS responseJson
         FROM collaboration_operations WHERE project_id='project-a' ORDER BY id`,
      ).all(),
      run: database.prepare(
        `SELECT status,current_agent_id AS currentAgentId,version,
                next_event_sequence AS nextEventSequence
         FROM collaboration_runs WHERE id='run-a'`,
      ).get(),
      sequences: database.prepare(
        `SELECT next_message_sequence AS nextMessageSequence
         FROM collaboration_project_sequences
         WHERE project_id='project-a' AND thread_id=?`,
      ).get(threadA),
      thread: database.prepare(
        `SELECT next_fact_sequence AS nextFactSequence,
                last_activity_sequence AS lastActivitySequence,version
         FROM collaboration_threads WHERE project_id='project-a' AND id=?`,
      ).get(threadA),
    };
  } finally {
    database.close();
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  directory = mkdtempSync(join(tmpdir(), "decision-answer-tuple-"));
  databasePath = join(directory, "cockpit.sqlite");
  process.env.COCKPIT_MASTER_KEY = MASTER_KEY;
  process.env.COCKPIT_DB_PATH = databasePath;
  seedProject();
  seedDecision();
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.COCKPIT_DB_PATH;
  delete process.env.COCKPIT_MASTER_KEY;
  rmSync(directory, { force: true, recursive: true });
});

describe("tuple-scoped decision answer", () => {
  it("atomically writes the exact answer, event, two facts, state changes, and scoped receipt", async () => {
    const input = {
      answer: "Yes",
      expectedVersion: 1,
      operationId: operationId(10),
    };
    const direct = answerThreadDecision(
      databasePath,
      "project-a",
      threadA,
      "run-a",
      "decision-a",
      input,
    );
    expect(direct.status).toBe(200);
    const response = await post(input);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(direct.body);
    expect(direct.body).toMatchObject({
      decision: {
        answer: "Yes",
        id: "decision-a",
        projectId: "project-a",
        runId: "run-a",
        status: "answered",
        threadId: threadA,
        version: 2,
      },
      facts: [
        {
          messageId: direct.body.message.id,
          projectId: "project-a",
          runId: "run-a",
          threadId: threadA,
          type: "owner_message",
        },
        {
          payload: { eventType: "decision_answered" },
          projectId: "project-a",
          runId: "run-a",
          threadId: threadA,
          type: "run_event",
        },
      ],
      message: {
        content: "Yes",
        mentionAgentId: null,
        projectId: "project-a",
        runId: "run-a",
        sequence: 2,
        threadId: threadA,
      },
      run: {
        currentAgentId: "agent-a",
        status: "running",
        version: 3,
      },
    });
    const state = snapshot() as {
      events: Array<{ id: string; payload: string; type: string }>;
      facts: Array<{
        messageId: string | null;
        payload: string;
        runEventId: string | null;
        type: string;
      }>;
      operations: Array<{
        httpStatus: number;
        id: string;
        kind: string;
        responseJson: string;
        runId: string;
        threadId: string;
      }>;
    };
    const event = state.events.at(-1)!;
    expect({ ...event, payload: JSON.parse(event.payload) }).toMatchObject({
      payload: {
        answer: "Yes",
        decisionId: "decision-a",
        messageId: direct.body.message.id,
        messageSequence: 2,
        nextAgentId: "agent-a",
      },
      type: "decision_answered",
    });
    expect(state.facts.slice(-2)).toEqual([
      expect.objectContaining({
        messageId: direct.body.message.id,
        payload: JSON.stringify({ messageId: direct.body.message.id }),
        type: "owner_message",
      }),
      expect.objectContaining({
        payload: '{"eventType":"decision_answered"}',
        runEventId: event.id,
        type: "run_event",
      }),
    ]);
    expect(state.operations.find(({ id }) => id === input.operationId)).toEqual(
      expect.objectContaining({
        httpStatus: 200,
        kind: "answer_decision",
        responseJson: JSON.stringify(direct.body),
        runId: "run-a",
        threadId: threadA,
      }),
    );
  });

  it("returns one sanitized 404 with zero writes for every tuple mismatch", async () => {
    const tuples = [
      { projectId: "project-missing" },
      { threadId: "thread-missing" },
      { runId: "run-missing" },
      { decisionId: "decision-missing" },
      { projectId: "project-a", threadId: "thread-missing", runId: "run-a" },
    ];
    const before = snapshot();
    const bodies = [];
    for (const tuple of tuples) {
      const response = await post({
        answer: "Yes",
        expectedVersion: 1,
        operationId: operationId(20 + bodies.length),
      }, tuple);
      expect(response.status).toBe(404);
      bodies.push(await response.json());
      expect(snapshot()).toEqual(before);
    }
    expect(new Set(bodies.map((body) => JSON.stringify(body)))).toEqual(new Set([
      JSON.stringify({
        error: {
          code: "RESOURCE_NOT_FOUND",
          message: "Resource was not found.",
        },
      }),
    ]));
  });

  it("strictly validates all path ids, JSON envelope, operation, version, and grapheme bounds", async () => {
    const invalidPaths = [
      { projectId: "bad%2Fproject" },
      { threadId: "bad%5Cthread" },
      { runId: ".." },
      { decisionId: "bad%00decision" },
    ];
    for (const tuple of invalidPaths) {
      const response = await post({
        answer: "Yes",
        expectedVersion: 1,
        operationId: operationId(30),
      }, tuple);
      expect(response.status).toBe(400);
    }
    const invalidBodies = [
      {},
      { answer: "Yes", expectedVersion: 1, operationId: "bad" },
      { answer: "Yes", expectedVersion: 0, operationId: operationId(31) },
      { answer: "", expectedVersion: 1, operationId: operationId(32) },
      { answer: "x".repeat(5_001), expectedVersion: 1, operationId: operationId(33) },
      { answer: "Yes", expectedVersion: 1, operationId: operationId(34), extra: true },
      [],
    ];
    const before = snapshot();
    for (const body of invalidBodies) {
      const response = await post(body);
      expect(response.status).toBe(400);
      expect(snapshot()).toEqual(before);
    }
    expect((await post(null, {}, { contentType: "text/plain" })).status).toBe(415);
    expect((await post(null, {}, { rawBody: "{" })).status).toBe(400);
    expect((await post(null, {}, { rawBody: `"${"x".repeat(65_536)}"` })).status).toBe(413);
    expect((await post(null, {}, { query: "?extra=1" })).status).toBe(400);

    const boundary = await post({
      answer: "e\u0301".repeat(5_000),
      expectedVersion: 1,
      operationId: operationId(35),
    });
    expect(boundary.status).toBe(200);
  });

  it("preserves version conflict, duplicate answer, exact replay, and operation conflict", async () => {
    const staleInput = {
      answer: "Yes",
      expectedVersion: 2,
      operationId: operationId(40),
    };
    const stale = await post(staleInput);
    expect(stale.status).toBe(409);
    const staleBody = await stale.json();
    expect(staleBody).toMatchObject({
      error: { code: "RUN_STATE_CONFLICT", currentVersion: 1 },
    });
    const staleReplay = await post(staleInput);
    expect(staleReplay.status).toBe(409);
    expect(await staleReplay.json()).toEqual(staleBody);
    const input = {
      answer: "Yes",
      expectedVersion: 1,
      operationId: operationId(41),
    };
    const first = await post(input);
    const firstBody = await first.json();
    const replay = await post(input);
    expect(await replay.json()).toEqual(firstBody);
    const conflict = await post({ ...input, answer: "No" });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: { code: "OPERATION_CONFLICT" } });
    const duplicate = await post({
      answer: "No",
      expectedVersion: 2,
      operationId: operationId(42),
    });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({
      error: { code: "DECISION_ALREADY_ANSWERED", currentVersion: 2 },
    });
    expect((snapshot() as { messages: unknown[] }).messages).toHaveLength(2);
  });

  it("allows exactly one race winner without partial writes", async () => {
    const [left, right] = await Promise.all([
      post({
        answer: "Yes",
        expectedVersion: 1,
        operationId: operationId(45),
      }),
      post({
        answer: "No",
        expectedVersion: 1,
        operationId: operationId(46),
      }),
    ]);
    expect([left.status, right.status].sort()).toEqual([200, 409]);
    const state = snapshot() as {
      events: unknown[];
      facts: unknown[];
      messages: unknown[];
    };
    expect(state.messages).toHaveLength(2);
    expect(state.events).toHaveLength(1);
    expect(state.facts).toHaveLength(6);
  });

  it("gives a valid owner mention priority and rejects invalid or unready policy selections", async () => {
    const mentioned = await post({
      answer: "Agent B should continue",
      expectedVersion: 1,
      mentionAgentId: "agent-b",
      operationId: operationId(50),
    });
    expect(await mentioned.json()).toMatchObject({
      message: {
        mentionAgentId: "agent-b",
        mentionDisplayName: "Agent B",
      },
      run: { currentAgentId: "agent-b" },
    });
  });

  it("rejects a mention outside the active policy without business writes", async () => {
    const before = snapshot();
    const response = await post({
      answer: "No",
      expectedVersion: 1,
      mentionAgentId: "agent-missing",
      operationId: operationId(51),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "AGENT_NOT_MEMBER" } });
    const after = snapshot() as { operations: unknown[] };
    expect({ ...after, operations: [] }).toEqual({
      ...(before as { operations: unknown[] }),
      operations: [],
    });
  });

  it("rejects an answer while the active thread policy requires repair", async () => {
    const database = openDatabase(databasePath);
    database.prepare(
      "DELETE FROM project_memberships WHERE project_id='project-a' AND agent_id='agent-b'",
    ).run();
    database.close();
    const before = snapshot();
    const response = await post({
      answer: "Yes",
      expectedVersion: 1,
      operationId: operationId(52),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: "THREAD_POLICY_REPAIR_REQUIRED" },
    });
    const after = snapshot() as { operations: unknown[] };
    expect({ ...after, operations: [] }).toEqual({
      ...(before as { operations: unknown[] }),
      operations: [],
    });
  });

  it("rolls back message, decision, run, event, facts, sequences, and receipt at every fault", () => {
    const points: ThreadDecisionAnswerFaultPoint[] = [
      "after_receipt",
      "after_message",
      "after_decision",
      "after_run",
      "after_event",
      "after_facts",
      "after_sequences",
    ];
    for (const [index, point] of points.entries()) {
      const before = snapshot();
      expect(() =>
        answerThreadDecision(
          databasePath,
          "project-a",
          threadA,
          "run-a",
          "decision-a",
          {
            answer: "Yes",
            expectedVersion: 1,
            operationId: operationId(60 + index),
          },
          {
            fault(current) {
              if (current === point) throw new Error(`FAULT:${point}`);
            },
          },
        ),
      ).toThrow(`FAULT:${point}`);
      expect(snapshot()).toEqual(before);
    }
  });

  it("keeps the legacy run-only answer route permanently unavailable", async () => {
    const load = legacyRoutes[
      "../app/api/runs/[runId]/decisions/[decisionId]/answer/route.ts"
    ];
    expect(load).toBeTypeOf("function");
    const legacy = await load!();
    const before = snapshot();
    const response = await legacy.POST(
      new Request("http://localhost/api/runs/run-a/decisions/decision-a/answer", {
        body: JSON.stringify({
          answer: "Yes",
          expectedVersion: 1,
          operationId: operationId(70),
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      {
        params: Promise.resolve({
          decisionId: "decision-a",
          projectId: "",
          runId: "run-a",
          threadId: "",
        }),
      },
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: {
        code: "RESOURCE_NOT_FOUND",
        message: "Resource was not found.",
      },
    });
    expect(snapshot()).toEqual(before);
  });
});
