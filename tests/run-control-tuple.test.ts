import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  controlThreadRun,
  type ThreadControlFaultPoint,
} from "@/src/server/collaboration/run-service";
import { createThread } from "@/src/server/collaboration/thread-service";
import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";

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
  "../app/api/projects/[projectId]/threads/[threadId]/runs/[runId]/control/route.ts",
);
const legacyRoutes = import.meta.glob<LegacyRoute>(
  "../app/api/runs/[runId]/control/route.ts",
);

const NOW = "2026-08-08T08:00:00.000Z";
let directory: string;
let databasePath: string;
let threadA: string;
let threadB: string;
let foreignThread: string;
let operationSequence: number;

function operationId(): string {
  operationSequence += 1;
  return `00000000-0000-4000-8000-${operationSequence.toString().padStart(12, "0")}`;
}

function seedProject(projectId: string, agentIds: [string, string]): string {
  const database = openDatabase(databasePath);
  try {
    database.prepare(
      `INSERT INTO projects(id,name,created_at,workspace_path,workspace_key,version)
       VALUES (?,?,?,'D:\\workspace',?,1)`,
    ).run(projectId, projectId, NOW, `d:/workspace/${projectId}`);
    const providerId = `provider-${projectId}`;
    database.prepare(
      `INSERT INTO providers(
         id,name,base_url,default_model,api_key_cipher,api_key_iv,api_key_tag,
         credential_version,credential_generation,key_id,api_key_mask,verified_at,
         version,created_at,updated_at
       ) VALUES (?,'Provider','http://localhost/v1','model','cipher','iv','tag',
         1,1,'key','***',?,1,?,?)`,
    ).run(providerId, NOW, NOW, NOW);
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
      insertMember.run(projectId, agentId, `${NOW.slice(0, -5)}${position}.000Z`);
    });
  } finally {
    database.close();
  }
  return createThread(databasePath, projectId, {
    memberAgentIds: agentIds,
    operationId: operationId(),
    title: `Thread ${projectId}`,
  }).body.thread.id;
}

function seedRun(
  projectId: string,
  threadId: string,
  runId: string,
  agentId: string,
  status: "running" | "stopped",
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
         id,project_id,thread_id,status,current_agent_id,round_count,
         next_event_sequence,version,execution_epoch,pause_reason,pause_category,
         created_at,updated_at
       ) VALUES (?,?,?,?,?,0,1,1,1,NULL,NULL,?,?)`,
    ).run(runId, projectId, threadId, status, agentId, NOW, NOW);
    database.prepare(
      `INSERT INTO collaboration_thread_facts(
         id,project_id,thread_id,sequence,activity_sequence,type,actor_type,actor_id,
         run_id,message_id,run_event_id,policy_revision_id,payload_json,created_at
       ) VALUES (?,?,?,?,?,'run_linked','system',NULL,?,NULL,NULL,NULL,?,?)`,
    ).run(
      `fact-link-${runId}`,
      projectId,
      threadId,
      thread.factSequence,
      project.activitySequence,
      runId,
      JSON.stringify({ runId }),
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

function forceRun(
  status: "running" | "waiting_owner" | "paused" | "failed" | "planned" | "stopped",
  pauseCategory: string | null = null,
): void {
  const database = openDatabase(databasePath);
  try {
    database.prepare(
      `UPDATE collaboration_runs
       SET status=?,pause_category=?,pause_reason=NULL
       WHERE project_id='project-a' AND thread_id=? AND id='run-a'`,
    ).run(status, pauseCategory, threadA);
  } finally {
    database.close();
  }
}

function snapshot(): unknown {
  const database = openDatabase(databasePath);
  try {
    return {
      run: database.prepare(
        `SELECT status,version,execution_epoch AS executionEpoch,
                next_event_sequence AS nextEventSequence,pause_category AS pauseCategory
         FROM collaboration_runs WHERE id='run-a'`,
      ).get(),
      eventCount: database.prepare(
        "SELECT count(*) AS count FROM collaboration_events",
      ).get(),
      factCount: database.prepare(
        "SELECT count(*) AS count FROM collaboration_thread_facts",
      ).get(),
      operationCount: database.prepare(
        "SELECT count(*) AS count FROM collaboration_operations",
      ).get(),
      thread: database.prepare(
        `SELECT next_fact_sequence AS nextFactSequence,
                last_activity_sequence AS lastActivitySequence,version
         FROM collaboration_threads WHERE project_id='project-a' AND id=?`,
      ).get(threadA),
      projectSequence: database.prepare(
        `SELECT next_activity_sequence AS nextActivitySequence
         FROM collaboration_project_thread_sequences WHERE project_id='project-a'`,
      ).get(),
    };
  } finally {
    database.close();
  }
}

async function tupleRoute(): Promise<TupleRoute> {
  const load =
    tupleRoutes[
      "../app/api/projects/[projectId]/threads/[threadId]/runs/[runId]/control/route.ts"
    ];
  expect(load, "tuple-scoped run control route must exist").toBeTypeOf("function");
  return load!();
}

async function post(
  projectId: string,
  threadId: string,
  runId: string,
  body: unknown,
  options: { contentType?: string; query?: string; rawBody?: string } = {},
): Promise<Response> {
  const rawBody = options.rawBody ?? JSON.stringify(body);
  return (await tupleRoute()).POST(
    new Request(
      `http://localhost/api/projects/${projectId}/threads/${threadId}/runs/${runId}/control${options.query ?? ""}`,
      {
        body: rawBody,
        headers: options.contentType === undefined
          ? { "content-type": "application/json" }
          : { "content-type": options.contentType },
        method: "POST",
      },
    ),
    { params: Promise.resolve({ projectId, runId, threadId }) },
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  directory = mkdtempSync(join(tmpdir(), "run-control-tuple-"));
  databasePath = join(directory, "cockpit.sqlite");
  process.env.COCKPIT_DB_PATH = databasePath;
  operationSequence = 1500;
  threadA = seedProject("project-a", ["agent-a", "agent-b"]);
  threadB = createThread(databasePath, "project-a", {
    memberAgentIds: ["agent-a", "agent-b"],
    operationId: operationId(),
    title: "Thread B",
  }).body.thread.id;
  foreignThread = seedProject("project-b", ["agent-c", "agent-d"]);
  seedRun("project-a", threadA, "run-a", "agent-a", "running");
  seedRun("project-a", threadB, "run-b", "agent-b", "stopped");
  seedRun("project-b", foreignThread, "run-foreign", "agent-c", "stopped");
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.COCKPIT_DB_PATH;
  rmSync(directory, { force: true, recursive: true });
});

describe("tuple-scoped run control API", () => {
  it("pauses, continues, retries, and stops with one matching event and fact", async () => {
    const pause = await post("project-a", threadA, "run-a", {
      action: "pause",
      expectedVersion: 1,
      operationId: operationId(),
    });
    expect(pause.status).toBe(200);
    const paused = await pause.json();
    expect(paused).toMatchObject({
      fact: {
        projectId: "project-a",
        threadId: threadA,
        runId: "run-a",
        type: "run_event",
        payload: { eventType: "run_paused" },
      },
      run: {
        projectId: "project-a",
        threadId: threadA,
        id: "run-a",
        status: "paused",
        pauseCategory: "manual",
        version: 2,
      },
    });

    const continued = await post("project-a", threadA, "run-a", {
      action: "continue",
      expectedVersion: 2,
      operationId: operationId(),
    });
    expect(await continued.json()).toMatchObject({
      fact: { payload: { eventType: "run_resumed" } },
      run: { status: "running", version: 3 },
    });

    forceRun("failed", "internal_failure");
    const retried = await post("project-a", threadA, "run-a", {
      action: "retry",
      expectedVersion: 3,
      operationId: operationId(),
    });
    expect(await retried.json()).toMatchObject({
      fact: { payload: { eventType: "run_retried" } },
      run: { status: "running", version: 4 },
    });

    const stopped = await post("project-a", threadA, "run-a", {
      action: "stop",
      expectedVersion: 4,
      operationId: operationId(),
    });
    expect(await stopped.json()).toMatchObject({
      fact: { payload: { eventType: "run_stopped" } },
      run: { status: "stopped", version: 5 },
    });

    const database = openDatabase(databasePath);
    try {
      expect(database.prepare(
        `SELECT events.type,facts.payload_json AS factPayload
         FROM collaboration_events AS events
         JOIN collaboration_thread_facts AS facts
           ON facts.project_id=events.project_id
          AND facts.thread_id=events.thread_id
          AND facts.run_id=events.run_id
          AND facts.run_event_id=events.id
         WHERE events.run_id='run-a' ORDER BY events.sequence`,
      ).all()).toEqual([
        { factPayload: '{"eventType":"run_paused"}', type: "run_paused" },
        { factPayload: '{"eventType":"run_resumed"}', type: "run_resumed" },
        { factPayload: '{"eventType":"run_retried"}', type: "run_retried" },
        { factPayload: '{"eventType":"run_stopped"}', type: "run_stopped" },
      ]);
    } finally {
      database.close();
    }
  });

  it.each([
    ["waiting_owner", null, "pause"],
    ["failed", "internal_failure", "continue"],
    ["running", null, "retry"],
    ["planned", null, "stop"],
    ["stopped", null, "pause"],
  ] as const)(
    "rejects %s/%s for %s without state or event writes",
    async (status, category, action) => {
      forceRun(status, category);
      const before = snapshot();
      const response = await post("project-a", threadA, "run-a", {
        action,
        expectedVersion: 1,
        operationId: operationId(),
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: { code: "RUN_STATE_CONFLICT" },
      });
      const after = snapshot() as typeof before;
      expect((after as { run: unknown }).run).toEqual((before as { run: unknown }).run);
      expect((after as { eventCount: unknown }).eventCount).toEqual(
        (before as { eventCount: unknown }).eventCount,
      );
      expect((after as { factCount: unknown }).factCount).toEqual(
        (before as { factCount: unknown }).factCount,
      );
    },
  );

  it("allows one expected-version winner and exactly replays or conflicts receipts", async () => {
    const replayOperationId = operationId();
    const input = {
      action: "pause" as const,
      expectedVersion: 1,
      operationId: replayOperationId,
    };
    const first = await post("project-a", threadA, "run-a", input);
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    const replay = await post("project-a", threadA, "run-a", input);
    expect(await replay.json()).toEqual(firstBody);
    const conflict = await post("project-a", threadA, "run-a", {
      ...input,
      action: "stop",
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      error: { code: "OPERATION_CONFLICT" },
    });

    await post("project-a", threadA, "run-a", {
      action: "continue",
      expectedVersion: 2,
      operationId: operationId(),
    });
    const [pause, stop] = await Promise.all([
      post("project-a", threadA, "run-a", {
        action: "pause",
        expectedVersion: 3,
        operationId: operationId(),
      }),
      post("project-a", threadA, "run-a", {
        action: "stop",
        expectedVersion: 3,
        operationId: operationId(),
      }),
    ]);
    const responses = await Promise.all(
      [pause, stop].map(async (response) => ({
        body: await response.json(),
        status: response.status,
      })),
    );
    expect(responses.filter(({ status }) => status === 200)).toHaveLength(1);
    expect(responses.filter(({ status }) => status === 409)).toHaveLength(1);
    const database = openDatabase(databasePath);
    try {
      expect(database.prepare(
        `SELECT count(*) AS count FROM collaboration_operations
         WHERE project_id='project-a' AND thread_id=? AND run_id='run-a'
           AND kind='control' AND id=?`,
      ).get(threadA, replayOperationId)).toEqual({ count: 1 });
    } finally {
      database.close();
    }
  });

  it.each([
    ["project-a", "bad%2Fthread", "run-a"],
    ["project-a", "bad%5Cthread", "run-a"],
    ["project-a", "thread", ".."],
  ])("strictly rejects malformed path tuple %s/%s/%s", async (projectId, threadId, runId) => {
    const response = await post(projectId, threadId, runId, {
      action: "pause",
      expectedVersion: 1,
      operationId: operationId(),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "INVALID_INPUT" } });
  });

  it.each([
    [{ action: "pause", expectedVersion: 1 }, "missing operationId"],
    [{ action: "pause", expectedVersion: 1, operationId: "bad" }, "invalid operationId"],
    [{ action: "invalid", expectedVersion: 1, operationId: "00000000-0000-4000-8000-000000001599" }, "invalid action"],
    [{ action: "pause", expectedVersion: 0, operationId: "00000000-0000-4000-8000-000000001598" }, "invalid expectedVersion"],
    [{ action: "pause", expectedVersion: 1, operationId: "00000000-0000-4000-8000-000000001597", extra: true }, "extra key"],
  ])("strictly rejects %s (%s)", async (body, _description) => {
    const before = snapshot();
    const response = await post("project-a", threadA, "run-a", body);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "INVALID_INPUT" } });
    expect(snapshot()).toEqual(before);
  });

  it("enforces JSON media type, valid JSON, body size, and no URL suffix", async () => {
    const input = {
      action: "pause",
      expectedVersion: 1,
      operationId: operationId(),
    };
    const media = await post("project-a", threadA, "run-a", input, {
      contentType: "text/plain",
    });
    expect(media.status).toBe(415);
    const invalidJson = await post("project-a", threadA, "run-a", input, {
      rawBody: "{",
    });
    expect(invalidJson.status).toBe(400);
    const oversized = await post("project-a", threadA, "run-a", input, {
      rawBody: JSON.stringify({ ...input, padding: "x".repeat(65_536) }),
    });
    expect(oversized.status).toBe(413);
    const query = await post("project-a", threadA, "run-a", input, {
      query: "?unknown=1",
    });
    expect(query.status).toBe(400);
  });

  it("returns one safe 404 and zero writes for every unknown or cross tuple", async () => {
    const tuples = [
      ["unknown-project", threadA, "run-a"],
      ["project-a", "unknown-thread", "run-a"],
      ["project-a", threadA, "unknown-run"],
      ["project-a", threadB, "run-a"],
      ["project-a", threadA, "run-b"],
      ["project-a", threadA, "run-foreign"],
      ["project-a", foreignThread, "run-foreign"],
    ];
    const before = snapshot();
    const responses = [];
    for (const [projectId, threadId, runId] of tuples) {
      responses.push(await post(projectId!, threadId!, runId!, {
        action: "pause",
        expectedVersion: 1,
        operationId: operationId(),
      }));
    }
    const bodies = await Promise.all(responses.map((response) => response.json()));
    expect(responses.map(({ status }) => status)).toEqual([404, 404, 404, 404, 404, 404, 404]);
    expect(new Set(bodies.map((body) => JSON.stringify(body)))).toEqual(new Set([
      JSON.stringify({
        error: {
          code: "RESOURCE_NOT_FOUND",
          message: "Resource was not found.",
        },
      }),
    ]));
    expect(snapshot()).toEqual(before);
  });

  it("rolls back run, event, fact, activity, and receipt at every injected fault", () => {
    const points: ThreadControlFaultPoint[] = [
      "after_receipt",
      "after_run",
      "after_event",
      "after_fact",
      "after_sequences",
    ];
    for (const point of points) {
      const before = snapshot();
      expect(() =>
        controlThreadRun(
          databasePath,
          "project-a",
          threadA,
          "run-a",
          {
            action: "pause",
            expectedVersion: 1,
            operationId: operationId(),
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

  it("keeps the legacy run-only control route permanently unavailable", async () => {
    const load = legacyRoutes["../app/api/runs/[runId]/control/route.ts"];
    expect(load).toBeTypeOf("function");
    const route = await load!();
    for (const runId of ["run-a", "run-foreign", "unknown-run"]) {
      const before = snapshot();
      const response = await route.POST(
        new Request(`http://localhost/api/runs/${runId}/control`, {
          body: JSON.stringify({
            action: "pause",
            expectedVersion: 1,
            operationId: operationId(),
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        }),
        { params: Promise.resolve({ runId }) },
      );
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        error: {
          code: "RESOURCE_NOT_FOUND",
          message: "Resource was not found.",
        },
      });
      expect(snapshot()).toEqual(before);
    }
  });
});
