import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createCredentialVault } from "@/src/server/credential-vault";
import { controlThreadRun } from "@/src/server/collaboration/run-service";
import type { StructuredTurnResult } from "@/src/server/collaboration/structured-repair";
import { createThread } from "@/src/server/collaboration/thread-service";
import {
  acquireAdvance,
  finalizeAdvance,
} from "@/src/server/collaboration/turn-orchestrator";
import { openDatabase } from "@/src/server/db";
import { createMission } from "@/src/server/mission-service";

type TupleRoute = {
  POST(
    request: Request,
    context: {
      params: Promise<{ projectId: string; threadId: string; runId: string }>;
    },
  ): Promise<Response>;
};

type LegacyRoute = {
  POST(
    request: Request,
    context: { params: Promise<{ runId: string }> },
  ): Promise<Response>;
};

const tupleRoutes = import.meta.glob<TupleRoute>(
  "../app/api/projects/[projectId]/threads/[threadId]/runs/[runId]/advance/route.ts",
);
const legacyRoutes = import.meta.glob<LegacyRoute>(
  "../app/api/runs/[runId]/advance/route.ts",
);

const PROJECT_ID = "project-advance-tuple";
const RUN_ID = "run-advance-tuple";
const AGENT_ID = "agent-advance-alpha";
const TARGET_ID = "agent-advance-beta";
const API_KEY = "provider-secret-tuple";
const PRIVATE_PROMPT = "PRIVATE_ADVANCE_TUPLE_PROMPT";

let databasePath: string;
let directory: string;
let provider: Server;
let providerBaseUrl: string;
let providerCalls: number;
let threadId: string;
let otherThreadId: string;
let operationSequence: number;

function operationId(): string {
  operationSequence += 1;
  return `17000000-0000-4000-8000-${operationSequence.toString().padStart(12, "0")}`;
}

function validTurn(): string {
  return JSON.stringify({
    claim: null,
    disposition: {
      reason: "Beta should review.",
      summary: "Draft complete.",
      targetAgentId: TARGET_ID,
      type: "handoff",
    },
    message: "The release draft is ready for review.",
    tasks: [],
  });
}

function validResult(): StructuredTurnResult {
  const usage = { completionTokens: 3, promptTokens: 7, totalTokens: 10 };
  return {
    calls: [{
      kind: "primary",
      result: {
        content: validTurn(),
        error: null,
        httpStatus: 200,
        status: "succeeded",
        usage,
        usageReported: true,
      },
    }],
    pauseCategory: null,
    status: "completed",
    turn: JSON.parse(validTurn()),
    usage: [{ kind: "primary", usage, usageReported: true }],
  };
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Provider did not listen.");
  return `http://127.0.0.1:${address.port}/v1`;
}

function seed(): void {
  const now = new Date().toISOString();
  const vault = createCredentialVault();
  const credential = vault.encrypt("provider-advance-tuple", API_KEY);
  const database = openDatabase(databasePath);
  try {
    database.prepare(
      `INSERT INTO projects(id,name,created_at,workspace_path,workspace_key,version)
       VALUES (?,? ,?,'D:\\workspace','d:/workspace/advance-tuple',1)`,
    ).run(PROJECT_ID, "Advance tuple", now);
    database.prepare(
      `INSERT INTO providers(
         id,name,base_url,default_model,api_key_cipher,api_key_iv,api_key_tag,
         credential_version,credential_generation,key_id,api_key_mask,verified_at,
         version,created_at,updated_at
       ) VALUES (?,'Local',?,'model',?,?,?,?,1,?,?,?,1,?,?)`,
    ).run(
      "provider-advance-tuple",
      providerBaseUrl,
      credential.apiKeyCipher,
      credential.apiKeyIv,
      credential.apiKeyTag,
      1,
      credential.keyId,
      credential.apiKeyMask,
      now,
      now,
      now,
    );
    const insertAgent = database.prepare(
      `INSERT INTO agents(
         id,name,role,system_prompt,provider_id,model,avatar_text,accent_token,
         can_read,can_write,can_execute,max_tokens,max_handoffs,version,created_at,
         updated_at,review_capable
       ) VALUES (?,?,'Peer',?,'provider-advance-tuple','model',?,'sage',
         1,1,0,1000,5,1,?,?,0)`,
    );
    insertAgent.run(AGENT_ID, "Alpha", PRIVATE_PROMPT, "A", now, now);
    insertAgent.run(TARGET_ID, "Beta", "BETA_PRIVATE", "B", now, now);
    database.prepare(
      "INSERT INTO project_memberships(project_id,agent_id,joined_at) VALUES (?,?,?)",
    ).run(PROJECT_ID, AGENT_ID, now);
    database.prepare(
      "INSERT INTO project_memberships(project_id,agent_id,joined_at) VALUES (?,?,?)",
    ).run(PROJECT_ID, TARGET_ID, new Date(Date.now() + 1).toISOString());
  } finally {
    database.close();
  }
  createMission(databasePath, PROJECT_ID, {
    expectedVersion: 0,
    goal: "Prepare a safe release",
    operationId: "16000000-0000-4000-8000-000000000124",
    title: "Release",
  });
  threadId = createThread(databasePath, PROJECT_ID, {
    memberAgentIds: [AGENT_ID, TARGET_ID],
    operationId: operationId(),
    title: "Primary",
  }).body.thread.id;
  otherThreadId = createThread(databasePath, PROJECT_ID, {
    memberAgentIds: [AGENT_ID, TARGET_ID],
    operationId: operationId(),
    title: "Other",
  }).body.thread.id;

  const runDatabase = openDatabase(databasePath);
  try {
    runDatabase.exec("BEGIN IMMEDIATE");
    const thread = runDatabase.prepare(
      `SELECT next_fact_sequence AS factSequence
       FROM collaboration_threads WHERE project_id=? AND id=?`,
    ).get(PROJECT_ID, threadId) as { factSequence: number };
    const activity = runDatabase.prepare(
      `SELECT next_activity_sequence AS activitySequence
       FROM collaboration_project_thread_sequences WHERE project_id=?`,
    ).get(PROJECT_ID) as { activitySequence: number };
    runDatabase.prepare(
      `INSERT INTO collaboration_runs(
         id,project_id,thread_id,status,current_agent_id,round_count,
         next_event_sequence,version,execution_epoch,pause_reason,pause_category,
         created_at,updated_at
       ) VALUES (?,?,?,'running',?,0,1,1,1,NULL,NULL,?,?)`,
    ).run(RUN_ID, PROJECT_ID, threadId, AGENT_ID, now, now);
    runDatabase.prepare(
      `INSERT INTO collaboration_project_sequences(
         project_id,thread_id,next_message_sequence
       ) VALUES (?,?,2)`,
    ).run(PROJECT_ID, threadId);
    runDatabase.prepare(
      `INSERT INTO collaboration_messages(
         id,project_id,thread_id,run_id,author_type,author_agent_id,
         author_display_name,content,mention_agent_id,mention_display_name,
         sequence,consumed_at,created_at
       ) VALUES ('owner-advance-tuple',?,?,?,'owner',NULL,'Owner',
                 'Prepare the release',NULL,NULL,1,NULL,?)`,
    ).run(PROJECT_ID, threadId, RUN_ID, now);
    runDatabase.prepare(
      `INSERT INTO collaboration_thread_facts(
         id,project_id,thread_id,sequence,activity_sequence,type,actor_type,actor_id,
         run_id,message_id,run_event_id,policy_revision_id,payload_json,created_at
       ) VALUES
         ('fact-run-advance-tuple',?,?,?,?, 'run_linked','system',NULL,
          ?,NULL,NULL,NULL,json_object('runId',?),?),
         ('fact-owner-advance-tuple',?,?,?,?, 'owner_message','owner',NULL,
          ?,'owner-advance-tuple',NULL,NULL,
          json_object('messageId','owner-advance-tuple'),?)`,
    ).run(
      PROJECT_ID,
      threadId,
      thread.factSequence,
      activity.activitySequence,
      RUN_ID,
      RUN_ID,
      now,
      PROJECT_ID,
      threadId,
      thread.factSequence + 1,
      activity.activitySequence + 1,
      RUN_ID,
      now,
    );
    runDatabase.prepare(
      `UPDATE collaboration_threads
       SET next_fact_sequence=next_fact_sequence+2,last_activity_sequence=?
       WHERE project_id=? AND id=?`,
    ).run(activity.activitySequence + 1, PROJECT_ID, threadId);
    runDatabase.prepare(
      `UPDATE collaboration_project_thread_sequences
       SET next_activity_sequence=next_activity_sequence+2 WHERE project_id=?`,
    ).run(PROJECT_ID);
    runDatabase.exec("COMMIT");
  } catch (error) {
    if (runDatabase.isTransaction) runDatabase.exec("ROLLBACK");
    throw error;
  } finally {
    runDatabase.close();
  }
}

async function tupleRoute(): Promise<TupleRoute> {
  const load = tupleRoutes[
    "../app/api/projects/[projectId]/threads/[threadId]/runs/[runId]/advance/route.ts"
  ];
  expect(load, "tuple-scoped advance route must exist").toBeTypeOf("function");
  return load!();
}

async function post(
  body: unknown,
  tuple: { projectId?: string; threadId?: string; runId?: string } = {},
  options: { contentType?: string; query?: string; rawBody?: string } = {},
): Promise<Response> {
  const projectId = tuple.projectId ?? PROJECT_ID;
  const selectedThreadId = tuple.threadId ?? threadId;
  const runId = tuple.runId ?? RUN_ID;
  return (await tupleRoute()).POST(
    new Request(
      `http://localhost/api/projects/${projectId}/threads/${selectedThreadId}/runs/${runId}/advance${options.query ?? ""}`,
      {
        body: options.rawBody ?? JSON.stringify(body),
        headers: options.contentType === undefined
          ? { "content-type": "application/json" }
          : { "content-type": options.contentType },
        method: "POST",
      },
    ),
    { params: Promise.resolve({ projectId, runId, threadId: selectedThreadId }) },
  );
}

function state(): {
  attempts: Array<Record<string, unknown>>;
  events: Array<Record<string, unknown>>;
  facts: Array<Record<string, unknown>>;
  messages: Array<Record<string, unknown>>;
  operations: Array<Record<string, unknown>>;
  turns: Array<Record<string, unknown>>;
} {
  const database = openDatabase(databasePath);
  try {
    return {
      attempts: database.prepare(
        `SELECT project_id AS projectId,thread_id AS threadId,run_id AS runId,status
         FROM collaboration_attempts ORDER BY started_at,id`,
      ).all() as Array<Record<string, unknown>>,
      events: database.prepare(
        `SELECT id,project_id AS projectId,thread_id AS threadId,run_id AS runId,type,
                payload_json AS payload
         FROM collaboration_events ORDER BY sequence`,
      ).all() as Array<Record<string, unknown>>,
      facts: database.prepare(
        `SELECT project_id AS projectId,thread_id AS threadId,run_id AS runId,type,
                message_id AS messageId,run_event_id AS runEventId,payload_json AS payload
         FROM collaboration_thread_facts ORDER BY sequence`,
      ).all() as Array<Record<string, unknown>>,
      messages: database.prepare(
        `SELECT project_id AS projectId,thread_id AS threadId,run_id AS runId,
                author_type AS authorType,content
         FROM collaboration_messages ORDER BY sequence`,
      ).all() as Array<Record<string, unknown>>,
      operations: database.prepare(
        `SELECT id,project_id AS projectId,thread_id AS threadId,run_id AS runId,
                kind,status,http_status AS httpStatus,response_json AS responseJson
         FROM collaboration_operations ORDER BY created_at,id`,
      ).all() as Array<Record<string, unknown>>,
      turns: database.prepare(
        `SELECT project_id AS projectId,thread_id AS threadId,run_id AS runId
         FROM collaboration_turns`,
      ).all() as Array<Record<string, unknown>>,
    };
  } finally {
    database.close();
  }
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "run-advance-tuple-"));
  databasePath = join(directory, "cockpit.sqlite");
  process.env.COCKPIT_DB_PATH = databasePath;
  process.env.COCKPIT_MASTER_KEY = Buffer.alloc(32, 17).toString("base64url");
  providerCalls = 0;
  operationSequence = 1700;
  provider = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      providerCalls += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        choices: [{ message: { content: validTurn() } }],
        usage: { completion_tokens: 3, prompt_tokens: 7, total_tokens: 10 },
      }));
    });
  });
  providerBaseUrl = await listen(provider);
  seed();
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) =>
    provider.close((error) => (error ? reject(error) : resolve())),
  );
  delete process.env.COCKPIT_DB_PATH;
  delete process.env.COCKPIT_MASTER_KEY;
  rmSync(directory, { force: true, recursive: true });
});

describe("tuple-scoped run advance", () => {
  it("commits exact tuple rows and one matching fact per event and Agent message, then replays", async () => {
    const input = { operationId: operationId() };
    const first = await post(input);
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    const replay = await post(input);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(firstBody);
    expect(providerCalls).toBe(1);
    expect(firstBody).toMatchObject({
      attemptStatus: "committed",
      run: { id: RUN_ID, projectId: PROJECT_ID, threadId },
    });
    expect(JSON.stringify(firstBody)).not.toContain(API_KEY);
    expect(JSON.stringify(firstBody)).not.toContain(PRIVATE_PROMPT);

    const persisted = state();
    for (const row of [
      ...persisted.attempts,
      ...persisted.events,
      ...persisted.messages.filter(({ authorType }) => authorType === "agent"),
      ...persisted.turns,
      ...persisted.operations.filter(({ kind }) => kind === "advance"),
    ]) {
      expect(row).toMatchObject({ projectId: PROJECT_ID, runId: RUN_ID, threadId });
    }
    const publicEvents = persisted.events.filter(({ type }) => type !== "agent_message");
    for (const event of publicEvents) {
      expect(
        persisted.facts.filter(({ runEventId }) => runEventId === event.id),
      ).toHaveLength(1);
    }
    const agentMessages = persisted.messages.filter(({ authorType }) => authorType === "agent");
    expect(agentMessages).toHaveLength(1);
    expect(
      persisted.facts.filter(
        ({ messageId, type }) => type === "agent_message" && messageId !== null,
      ),
    ).toHaveLength(1);
    expect(JSON.stringify(persisted)).not.toContain(API_KEY);
    expect(JSON.stringify(persisted)).not.toContain(PRIVATE_PROMPT);
  });

  it("returns the same 404 for unknown/cross tuples before Provider or mutation", async () => {
    const before = state();
    const tuples = [
      { projectId: "missing-project" },
      { threadId: "missing-thread" },
      { runId: "missing-run" },
      { threadId: otherThreadId },
    ];
    const bodies = [];
    for (const tuple of tuples) {
      const response = await post({ operationId: operationId() }, tuple);
      expect(response.status).toBe(404);
      bodies.push(await response.json());
      expect(providerCalls).toBe(0);
      expect(state()).toEqual(before);
    }
    expect(new Set(bodies.map((body) => JSON.stringify(body)))).toEqual(new Set([
      JSON.stringify({
        error: { code: "RESOURCE_NOT_FOUND", message: "Resource was not found." },
      }),
    ]));
  });

  it("preserves pending/in-progress semantics without Provider calls", async () => {
    const dependencies = { clock: () => new Date(), randomUUID };
    const pendingOperationId = operationId();
    const acquired = acquireAdvance(
      databasePath,
      { projectId: PROJECT_ID, runId: RUN_ID, threadId },
      { operationId: pendingOperationId },
      dependencies,
    );
    expect(acquired.kind).toBe("acquired");
    const pending = await post({ operationId: pendingOperationId });
    expect(pending.status).toBe(409);
    expect(await pending.json()).toMatchObject({
      error: { code: "OPERATION_IN_PROGRESS" },
    });
    expect(providerCalls).toBe(0);
  });

  it("preserves operation-conflict semantics without Provider calls", async () => {
    const conflictOperationId = operationId();
    controlThreadRun(
      databasePath,
      PROJECT_ID,
      threadId,
      RUN_ID,
      {
        action: "pause",
        expectedVersion: 1,
        operationId: conflictOperationId,
      },
    );
    const conflict = await post({ operationId: conflictOperationId });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      error: { code: "OPERATION_CONFLICT" },
    });
    expect(providerCalls).toBe(0);
  });

  it("makes a late finalize CAS a zero-write durable replay", () => {
    const dependencies = { clock: () => new Date(), randomUUID };
    const acquired = acquireAdvance(
      databasePath,
      { projectId: PROJECT_ID, runId: RUN_ID, threadId },
      { operationId: operationId() },
      dependencies,
    );
    expect(acquired.kind).toBe("acquired");
    if (acquired.kind !== "acquired") throw new Error("Expected acquired advance.");
    const input = {
      attemptId: acquired.attempt.id,
      leaseToken: acquired.attempt.leaseToken,
      result: validResult(),
    };
    const first = finalizeAdvance(
      databasePath,
      { projectId: PROJECT_ID, runId: RUN_ID, threadId },
      input,
      dependencies,
    );
    expect(first).toMatchObject({ affectedRows: 1, status: 200 });
    const before = state();
    const late = finalizeAdvance(
      databasePath,
      { projectId: PROJECT_ID, runId: RUN_ID, threadId },
      { ...input, result: validResult() },
      dependencies,
    );
    expect(late).toEqual({ ...first, affectedRows: 0 });
    expect(state()).toEqual(before);
  });

  it("preserves paused run conflicts without calling Provider", async () => {
    const database = openDatabase(databasePath);
    database.prepare(
      `UPDATE collaboration_runs SET status='paused',pause_category='manual'
       WHERE project_id=? AND thread_id=? AND id=?`,
    ).run(PROJECT_ID, threadId, RUN_ID);
    database.close();
    const response = await post({ operationId: operationId() });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: "RUN_STATE_CONFLICT" },
    });
    expect(providerCalls).toBe(0);
  });

  it("strictly validates path, body, media type, size, operation id, and URL suffix", async () => {
    const before = state();
    const invalid = [
      post({}, {}),
      post({ operationId: "bad" }),
      post({ operationId: operationId(), extra: true }),
      post([], {}),
      post({ operationId: operationId() }, { threadId: "bad%2Fthread" }),
      post(null, {}, { contentType: "text/plain" }),
      post(null, {}, { rawBody: "{" }),
      post(null, {}, { rawBody: `"${"x".repeat(65_536)}"` }),
      post({ operationId: operationId() }, {}, { query: "?extra=1" }),
    ];
    const responses = await Promise.all(invalid);
    expect(responses.map(({ status }) => status)).toEqual([
      400, 400, 400, 400, 400, 415, 400, 413, 400,
    ]);
    expect(providerCalls).toBe(0);
    expect(state()).toEqual(before);
  });

  it("preserves boundary and sanitized Provider failure responses", async () => {
    const database = openDatabase(databasePath);
    database.prepare(
      `UPDATE collaboration_runs SET round_count=50
       WHERE project_id=? AND thread_id=? AND id=?`,
    ).run(PROJECT_ID, threadId, RUN_ID);
    database.close();
    const boundary = await post({ operationId: operationId() });
    expect(boundary.status).toBe(200);
    expect(await boundary.json()).toMatchObject({
      boundary: "rounds",
      kind: "paused",
      run: { status: "paused", threadId },
    });
    expect(providerCalls).toBe(0);

    const database2 = openDatabase(databasePath);
    database2.prepare(
      `UPDATE collaboration_runs
       SET status='running',round_count=0,pause_category=NULL,pause_reason=NULL
       WHERE project_id=? AND thread_id=? AND id=?`,
    ).run(PROJECT_ID, threadId, RUN_ID);
    database2.close();
    provider.removeAllListeners("request");
    provider.on("request", (request, response) => {
      request.resume();
      request.on("end", () => {
        providerCalls += 1;
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: `${API_KEY}:${PRIVATE_PROMPT}` }));
      });
    });
    const failed = await post({ operationId: operationId() });
    expect(failed.status).toBe(401);
    expect(await failed.json()).toEqual({
      error: {
        category: "provider_auth",
        code: "PROVIDER_AUTH",
        message: "Provider call failed.",
      },
    });
    expect(JSON.stringify(state())).not.toContain(API_KEY);
    expect(JSON.stringify(state())).not.toContain(PRIVATE_PROMPT);
  });

  it("keeps the legacy run-only advance route permanently unavailable", async () => {
    const load = legacyRoutes["../app/api/runs/[runId]/advance/route.ts"];
    expect(load).toBeTypeOf("function");
    const route = await load!();
    const before = state();
    const response = await route.POST(
      new Request(`http://localhost/api/runs/${RUN_ID}/advance`, {
        body: JSON.stringify({ operationId: operationId() }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      { params: Promise.resolve({ runId: RUN_ID }) },
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "RESOURCE_NOT_FOUND", message: "Resource was not found." },
    });
    expect(providerCalls).toBe(0);
    expect(state()).toEqual(before);
  });
});
