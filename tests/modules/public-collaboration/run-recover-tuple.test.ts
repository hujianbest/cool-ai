import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  canonicalRequestHash,
  completeOperationReceipt,
} from "@/src/adapters/outbound/sqlite/public-collaboration/operation-receipts";
import { createThread, startThreadRun } from "@/src/adapters/outbound/sqlite/public-collaboration/thread-service";
import {
  finalizeAdvance,
  type ProjectThreadRunTuple,
} from "@/src/adapters/outbound/sqlite/public-collaboration/turn-orchestrator";
import { createCredentialVault } from "@/src/modules/identity-capability/internal/credential-vault";
import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { createMission } from "@/src/composition/mission-commands";
import type { StructuredTurnResult } from "@/src/modules/public-collaboration";

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
  "../../../app/api/projects/[projectId]/threads/[threadId]/runs/[runId]/recover/route.ts",
);
const legacyRoutes = import.meta.glob<LegacyRoute>(
  "../../../app/api/runs/[runId]/recover/route.ts",
);

const PROJECT_ID = "project-recover-tuple";
const AGENT_ID = "agent-recover-alpha";
const OTHER_AGENT_ID = "agent-recover-beta";
const ACQUIRED_AT = "2026-08-08T01:00:00.000Z";
const EXPIRED_AT = "2000-01-01T00:00:00.000Z";
const LIVE_UNTIL = "2099-01-01T00:00:00.000Z";
const ADVANCE_ID = "18000000-0000-4000-8000-000000001888";
const ATTEMPT_ID = "attempt-recover-tuple";
const LEASE_TOKEN = "lease-recover-tuple";

let databasePath: string;
let directory: string;
let threadId: string;
let otherThreadId: string;
let runId: string;
let operationSequence: number;
let fetchSpy: ReturnType<typeof vi.spyOn>;

function operationId(): string {
  operationSequence += 1;
  return `18000000-0000-4000-8000-${operationSequence.toString().padStart(12, "0")}`;
}

function seed(): void {
  const database = openDatabase(databasePath);
  const now = ACQUIRED_AT;
  const credential = createCredentialVault().encrypt(
    "provider-recover-tuple",
    "provider-secret-recover-tuple",
  );
  try {
    database.prepare(
      `INSERT INTO projects(id,name,created_at,workspace_path,workspace_key,version)
       VALUES (?,? ,?,'D:\\workspace','d:/workspace/recover-tuple',1)`,
    ).run(PROJECT_ID, "Recover tuple", now);
    database.prepare(
      `INSERT INTO providers(
         id,name,base_url,default_model,api_key_cipher,api_key_iv,api_key_tag,
         credential_version,credential_generation,key_id,api_key_mask,verified_at,
         version,created_at,updated_at
       ) VALUES ('provider-recover-tuple','Local','http://127.0.0.1:1/v1','model',
                 ?,?,?,1,1,?,?,?,1,?,?)`,
    ).run(
      credential.apiKeyCipher,
      credential.apiKeyIv,
      credential.apiKeyTag,
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
       ) VALUES (?,?,'Peer','private','provider-recover-tuple','model',?,'sage',
                 1,1,0,1000,5,1,?,?,0)`,
    );
    insertAgent.run(AGENT_ID, "Alpha", "A", now, now);
    insertAgent.run(OTHER_AGENT_ID, "Beta", "B", now, now);
    database.prepare(
      "INSERT INTO project_memberships(project_id,agent_id,joined_at) VALUES (?,?,?)",
    ).run(PROJECT_ID, AGENT_ID, now);
    database.prepare(
      "INSERT INTO project_memberships(project_id,agent_id,joined_at) VALUES (?,?,?)",
    ).run(PROJECT_ID, OTHER_AGENT_ID, "2026-08-08T01:00:00.001Z");
  } finally {
    database.close();
  }
  createMission(databasePath, PROJECT_ID, {
    expectedVersion: 0,
    goal: "Recover safely",
    operationId: "16000000-0000-4000-8000-000000000111",
    title: "Recovery",
  });
  threadId = createThread(databasePath, PROJECT_ID, {
    memberAgentIds: [AGENT_ID, OTHER_AGENT_ID],
    operationId: operationId(),
    title: "Primary",
  }).body.thread.id;
  otherThreadId = createThread(databasePath, PROJECT_ID, {
    memberAgentIds: [AGENT_ID, OTHER_AGENT_ID],
    operationId: operationId(),
    title: "Other",
  }).body.thread.id;
  runId = startThreadRun(databasePath, PROJECT_ID, threadId, {
    message: "Recover this run",
    operationId: operationId(),
  }).body.run.id;
}

function seedAttempt(
  status: "calling" | "committed" | "failed" | "interrupted" | "discarded",
  leaseExpiresAt = EXPIRED_AT,
): void {
  const database = openDatabase(databasePath);
  try {
    database.exec("BEGIN IMMEDIATE");
    database.prepare(
      `INSERT INTO collaboration_operations(
         id,project_id,thread_id,run_id,kind,request_hash,status,http_status,
         response_json,response_schema_version,created_at,updated_at
       ) VALUES (?,?,?,?,'advance',?,'pending',NULL,NULL,NULL,?,?)`,
    ).run(
      ADVANCE_ID,
      PROJECT_ID,
      threadId,
      runId,
      canonicalRequestHash({}),
      ACQUIRED_AT,
      ACQUIRED_AT,
    );
    database.prepare(
      `INSERT INTO collaboration_attempts(
         id,project_id,thread_id,run_id,agent_id,operation_id,status,lease_token,
         lease_expires_at,prompt_hash,acquire_execution_epoch,acquire_context_hash,
         included_message_sequence,error_category,started_at,finished_at
       ) VALUES (?,?,?,?,?,?,?,?,?,'prompt',1,'context',1,?,?,?)`,
    ).run(
      ATTEMPT_ID,
      PROJECT_ID,
      threadId,
      runId,
      AGENT_ID,
      ADVANCE_ID,
      status,
      LEASE_TOKEN,
      leaseExpiresAt,
      status === "calling" ? null : status,
      ACQUIRED_AT,
      status === "calling" ? null : ACQUIRED_AT,
    );
    if (status !== "calling") {
      completeOperationReceipt(database, {
        body: {
          attempt: { id: ATTEMPT_ID, status },
          attemptStatus: status,
          events: [],
          run: runDto(database),
        },
        kind: "advance",
        operationId: ADVANCE_ID,
        projectId: PROJECT_ID,
        requestHash: canonicalRequestHash({}),
        runId,
        status: 200,
        threadId,
        timestamp: ACQUIRED_AT,
      });
    }
    database.exec("COMMIT");
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
}

function runDto(database: ReturnType<typeof openDatabase>) {
  const row = database.prepare(
    `SELECT id,project_id AS projectId,thread_id AS threadId,status,
            current_agent_id AS currentAgentId,round_count AS roundCount,
            pause_category AS pauseCategory,version,created_at AS createdAt,
            updated_at AS updatedAt
     FROM collaboration_runs WHERE project_id=? AND thread_id=? AND id=?`,
  ).get(PROJECT_ID, threadId, runId) as Record<string, unknown>;
  return row;
}

async function tupleRoute(): Promise<TupleRoute> {
  const load = tupleRoutes[
    "../../../app/api/projects/[projectId]/threads/[threadId]/runs/[runId]/recover/route.ts"
  ];
  expect(load, "tuple-scoped recover route must exist").toBeTypeOf("function");
  return load!();
}

async function post(
  body: unknown,
  tuple: { projectId?: string; threadId?: string; runId?: string } = {},
  options: { contentType?: string; query?: string; rawBody?: string } = {},
): Promise<Response> {
  const projectId = tuple.projectId ?? PROJECT_ID;
  const selectedThreadId = tuple.threadId ?? threadId;
  const selectedRunId = tuple.runId ?? runId;
  return (await tupleRoute()).POST(
    new Request(
      `http://localhost/api/projects/${projectId}/threads/${selectedThreadId}/runs/${selectedRunId}/recover${options.query ?? ""}`,
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
        projectId,
        runId: selectedRunId,
        threadId: selectedThreadId,
      }),
    },
  );
}

function state(): Record<string, unknown> {
  const database = openDatabase(databasePath);
  try {
    return {
      attempts: database.prepare(
        `SELECT id,status,error_category AS errorCategory,finished_at AS finishedAt
         FROM collaboration_attempts ORDER BY started_at,id`,
      ).all(),
      events: database.prepare(
        `SELECT id,type,payload_json AS payload FROM collaboration_events
         WHERE type='attempt_interrupted' ORDER BY sequence`,
      ).all(),
      facts: database.prepare(
        `SELECT id,type,run_event_id AS runEventId,payload_json AS payload
         FROM collaboration_thread_facts WHERE type='run_event'
         AND payload_json=json_object('eventType','attempt_interrupted') ORDER BY sequence`,
      ).all(),
      operations: database.prepare(
        `SELECT id,kind,status,http_status AS httpStatus,response_json AS responseJson
         FROM collaboration_operations WHERE id IN (?,?) ORDER BY id`,
      ).all(ADVANCE_ID, "18000000-0000-4000-8000-000000001899"),
      run: database.prepare(
        `SELECT status,pause_category AS pauseCategory,pause_reason AS pauseReason,
                version,execution_epoch AS executionEpoch
         FROM collaboration_runs WHERE id=?`,
      ).get(runId),
    };
  } finally {
    database.close();
  }
}

function validResult(): StructuredTurnResult {
  const usage = { completionTokens: 1, promptTokens: 1, totalTokens: 2 };
  return {
    calls: [{
      kind: "primary",
      result: {
        content: "{}",
        error: null,
        httpStatus: 200,
        status: "succeeded",
        usage,
        usageReported: true,
      },
    }],
    pauseCategory: null,
    status: "completed",
    turn: {
      claim: null,
      disposition: { type: "plan_ready" },
      message: "late",
      tasks: [],
    },
    usage: [{ kind: "primary", usage, usageReported: true }],
  };
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "run-recover-tuple-"));
  databasePath = join(directory, "cockpit.sqlite");
  process.env.COCKPIT_DB_PATH = databasePath;
  process.env.COCKPIT_MASTER_KEY = Buffer.alloc(32, 18).toString("base64url");
  operationSequence = 1800;
  fetchSpy = vi.spyOn(globalThis, "fetch");
  seed();
});

afterEach(() => {
  fetchSpy.mockRestore();
  delete process.env.COCKPIT_DB_PATH;
  delete process.env.COCKPIT_MASTER_KEY;
  rmSync(directory, { force: true, recursive: true });
});

describe("tuple-scoped run recovery", () => {
  it("returns read state for missing and unexpired attempts without Provider calls", async () => {
    const missing = await post({ operationId: operationId() });
    expect(missing.status).toBe(200);
    await expect(missing.json()).resolves.toMatchObject({
      attempt: null,
      fact: null,
      run: { id: runId, projectId: PROJECT_ID, threadId },
    });
    seedAttempt("calling", LIVE_UNTIL);
    const live = await post({ operationId: operationId() });
    expect(live.status).toBe(200);
    await expect(live.json()).resolves.toMatchObject({
      attempt: { id: ATTEMPT_ID, status: "calling" },
      fact: null,
      run: { status: "running" },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((state().events as unknown[])).toHaveLength(0);
  });

  it("atomically interrupts one expired attempt and exactly completes both receipts", async () => {
    seedAttempt("calling");
    const recoverId = "18000000-0000-4000-8000-000000001899";
    const first = await post({ operationId: recoverId });
    const body = await first.json();
    expect(first.status).toBe(200);
    expect(body).toMatchObject({
      attempt: { id: ATTEMPT_ID, status: "interrupted" },
      fact: {
        projectId: PROJECT_ID,
        threadId,
        runId,
        type: "run_event",
        payload: { eventType: "attempt_interrupted" },
      },
      run: {
        pauseCategory: "interrupted",
        status: "paused",
        version: 2,
      },
    });
    const persisted = state();
    expect(persisted.run).toEqual({
      executionEpoch: 2,
      pauseCategory: "interrupted",
      pauseReason: "interrupted",
      status: "paused",
      version: 2,
    });
    expect(persisted.events).toHaveLength(1);
    expect(persisted.facts).toHaveLength(1);
    expect(persisted.operations).toEqual([
      expect.objectContaining({ id: ADVANCE_ID, kind: "advance", status: "completed" }),
      expect.objectContaining({
        id: recoverId,
        kind: "recover",
        responseJson: JSON.stringify(body),
        status: "completed",
      }),
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reopens, replays, and duplicate fresh recoveries never duplicate durable effects", async () => {
    seedAttempt("calling");
    const recoverId = "18000000-0000-4000-8000-000000001899";
    const first = await post({ operationId: recoverId });
    const body = await first.json();
    const replay = await post({ operationId: recoverId });
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toEqual(body);
    const reopened = await post({ operationId: operationId() });
    expect(reopened.status).toBe(200);
    await expect(reopened.json()).resolves.toMatchObject({
      attempt: { status: "interrupted" },
      fact: null,
    });
    expect((state().events as unknown[])).toHaveLength(1);
    expect((state().facts as unknown[])).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each(["committed", "failed", "interrupted", "discarded"] as const)(
    "preserves terminal latest attempt status %s as read-only",
    async (status) => {
      seedAttempt(status);
      const before = state();
      const response = await post({ operationId: operationId() });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        attempt: { id: ATTEMPT_ID, status },
        fact: null,
      });
      expect({ ...state(), operations: [] }).toEqual({ ...before, operations: [] });
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it("late finalization replays the interrupted advance without any write", async () => {
    seedAttempt("calling");
    await post({ operationId: operationId() });
    const before = state();
    const tuple: ProjectThreadRunTuple = { projectId: PROJECT_ID, runId, threadId };
    const late = finalizeAdvance(
      databasePath,
      tuple,
      { attemptId: ATTEMPT_ID, leaseToken: LEASE_TOKEN, result: validResult() },
      { clock: () => new Date(), randomUUID: () => operationId() },
    );
    expect(late).toMatchObject({
      affectedRows: 0,
      body: { attemptStatus: "interrupted" },
      status: 200,
    });
    expect(state()).toEqual(before);
  });

  it("returns identical tuple 404s and performs no write", async () => {
    seedAttempt("calling");
    const before = state();
    const bodies = [];
    for (const tuple of [
      { projectId: "missing-project" },
      { threadId: "missing-thread" },
      { runId: "missing-run" },
      { threadId: otherThreadId },
    ]) {
      const response = await post({ operationId: operationId() }, tuple);
      expect(response.status).toBe(404);
      bodies.push(await response.json());
      expect(state()).toEqual(before);
    }
    expect(new Set(bodies.map((body) => JSON.stringify(body)))).toEqual(new Set([
      JSON.stringify({
        error: { code: "RESOURCE_NOT_FOUND", message: "Resource was not found." },
      }),
    ]));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("strictly rejects invalid path/body/media/size/operation/query before mutation", async () => {
    const before = state();
    const responses = await Promise.all([
      post({}),
      post({ operationId: "bad" }),
      post({ operationId: operationId(), extra: true }),
      post([]),
      post({ operationId: operationId() }, { threadId: "bad%2Fthread" }),
      post(null, {}, { contentType: "text/plain" }),
      post(null, {}, { rawBody: "{" }),
      post(null, {}, { rawBody: `"${"x".repeat(65_536)}"` }),
      post({ operationId: operationId() }, {}, { query: "?extra=1" }),
    ]);
    expect(responses.map(({ status }) => status)).toEqual([
      400, 400, 400, 400, 400, 415, 400, 413, 400,
    ]);
    expect(state()).toEqual(before);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects operation conflicts without reconciliation", async () => {
    seedAttempt("calling");
    const before = state();
    const conflictId = operationId();
    const database = openDatabase(databasePath);
    try {
      completeOperationReceipt(database, {
        body: { run: runDto(database) },
        kind: "control",
        operationId: conflictId,
        projectId: PROJECT_ID,
        requestHash: canonicalRequestHash({ action: "pause", expectedVersion: 1 }),
        runId,
        status: 200,
        threadId,
        timestamp: ACQUIRED_AT,
      });
    } finally {
      database.close();
    }
    const response = await post({ operationId: conflictId });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "OPERATION_CONFLICT" },
    });
    expect({ ...state(), operations: [] }).toEqual({ ...before, operations: [] });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps the legacy run-only recover route permanently unavailable", async () => {
    const load = legacyRoutes["../../../app/api/runs/[runId]/recover/route.ts"];
    expect(load).toBeTypeOf("function");
    const before = state();
    const response = await (await load!()).POST(
      new Request(`http://localhost/api/runs/${runId}/recover`, {
        body: JSON.stringify({ operationId: operationId() }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      { params: Promise.resolve({ runId }) },
    );
    expect(response.status).toBe(404);
    expect(state()).toEqual(before);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
