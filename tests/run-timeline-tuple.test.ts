import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createThread } from "@/src/server/collaboration/thread-service";
import { openDatabase } from "@/src/server/db";

type TupleRoute = {
  GET(
    request: Request,
    context: {
      params: Promise<{ projectId: string; threadId: string; runId: string }>;
    },
  ): Promise<Response>;
};

type LegacyRoute = {
  GET(
    request: Request,
    context: { params: Promise<{ runId: string }> },
  ): Promise<Response>;
};

const tupleRouteModules = import.meta.glob<TupleRoute>(
  "../app/api/projects/[projectId]/threads/[threadId]/runs/[runId]/timeline/route.ts",
);
const legacyRouteModules = import.meta.glob<LegacyRoute>(
  "../app/api/runs/[runId]/timeline/route.ts",
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
    database.prepare(
      `INSERT INTO projects(id,name,created_at,workspace_path,workspace_key,version)
       VALUES (?,?,?,NULL,NULL,1)`,
    ).run(projectId, projectId, NOW);
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

function seedRun(
  projectId: string,
  threadId: string,
  runId: string,
  agentId: string,
  status: "running" | "stopped",
  eventCount: number,
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
       ) VALUES (?,?,?,?,?,0,?,1,1,NULL,NULL,?,?)`,
    ).run(runId, projectId, threadId, status, agentId, eventCount + 1, NOW, NOW);
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
    const insertEvent = database.prepare(
      `INSERT INTO collaboration_events(
         id,project_id,thread_id,run_id,sequence,type,actor_type,actor_id,
         payload_json,created_at
       ) VALUES (?,?,?,?,?,'run_stopped','system',NULL,?,?)`,
    );
    const insertFact = database.prepare(
      `INSERT INTO collaboration_thread_facts(
         id,project_id,thread_id,sequence,activity_sequence,type,actor_type,actor_id,
         run_id,message_id,run_event_id,policy_revision_id,payload_json,created_at
       ) VALUES (?,?,?,?,?,'run_event','system',NULL,?,NULL,?,NULL,?,?)`,
    );
    for (let sequence = 1; sequence <= eventCount; sequence += 1) {
      const eventId = `event-${runId}-${sequence}`;
      const createdAt = `2026-08-08T08:00:${String(sequence).padStart(2, "0")}.000Z`;
      insertEvent.run(
        eventId,
        projectId,
        threadId,
        runId,
        sequence,
        JSON.stringify({}),
        createdAt,
      );
      insertFact.run(
        `fact-${eventId}`,
        projectId,
        threadId,
        thread.factSequence + sequence,
        project.activitySequence + sequence,
        runId,
        eventId,
        JSON.stringify({ eventType: "run_stopped" }),
        createdAt,
      );
    }
    database.prepare(
      `UPDATE collaboration_threads
       SET next_fact_sequence=next_fact_sequence+?,
           last_activity_sequence=?
       WHERE project_id=? AND id=?`,
    ).run(
      eventCount + 1,
      project.activitySequence + eventCount,
      projectId,
      threadId,
    );
    database.prepare(
      `UPDATE collaboration_project_thread_sequences
       SET next_activity_sequence=next_activity_sequence+?
       WHERE project_id=?`,
    ).run(eventCount + 1, projectId);
    database.exec("COMMIT");
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
}

async function tupleRoute(): Promise<TupleRoute> {
  const key =
    "../app/api/projects/[projectId]/threads/[threadId]/runs/[runId]/timeline/route.ts";
  const load = tupleRouteModules[key];
  expect(load, "tuple-scoped timeline route must exist").toBeTypeOf("function");
  return load!();
}

async function timeline(
  projectId: string,
  threadId: string,
  runId: string,
  query = "",
  suffix = "",
): Promise<Response> {
  return (await tupleRoute()).GET(
    new Request(
      `http://localhost/api/projects/${projectId}/threads/${threadId}/runs/${runId}/timeline${query}${suffix}`,
    ),
    { params: Promise.resolve({ projectId, threadId, runId }) },
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  directory = mkdtempSync(join(tmpdir(), "run-timeline-tuple-"));
  databasePath = join(directory, "cockpit.sqlite");
  process.env.COCKPIT_DB_PATH = databasePath;
  threadA = seedProject(
    "project-a",
    ["agent-a", "agent-b"],
    "00000000-0000-4000-8000-000000001401",
  );
  threadB = createThread(databasePath, "project-a", {
    memberAgentIds: ["agent-a", "agent-b"],
    operationId: "00000000-0000-4000-8000-000000001402",
    title: "Thread B",
  }).body.thread.id;
  foreignThread = seedProject(
    "project-b",
    ["agent-c", "agent-d"],
    "00000000-0000-4000-8000-000000001403",
  );
  seedRun("project-a", threadA, "run-a", "agent-a", "running", 3);
  seedRun("project-a", threadB, "run-b", "agent-b", "stopped", 1);
  seedRun("project-b", foreignThread, "run-foreign", "agent-c", "stopped", 1);
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.COCKPIT_DB_PATH;
  rmSync(directory, { force: true, recursive: true });
});

describe("tuple-scoped run timeline API", () => {
  it("returns exact ordered event DTOs and stable first, middle, and end pages", async () => {
    const first = await timeline("project-a", threadA, "run-a", "?after=0&limit=2");
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody).toEqual({
      items: [
        {
          id: "event-run-a-1",
          projectId: "project-a",
          threadId: threadA,
          runId: "run-a",
          sequence: 1,
          type: "run_stopped",
          actorType: "system",
          actorId: null,
          payload: {},
          createdAt: "2026-08-08T08:00:01.000Z",
        },
        {
          id: "event-run-a-2",
          projectId: "project-a",
          threadId: threadA,
          runId: "run-a",
          sequence: 2,
          type: "run_stopped",
          actorType: "system",
          actorId: null,
          payload: {},
          createdAt: "2026-08-08T08:00:02.000Z",
        },
      ],
      nextAfter: 2,
    });

    const middle = await timeline(
      "project-a",
      threadA,
      "run-a",
      `?after=${firstBody.nextAfter}&limit=1`,
    );
    expect(await middle.json()).toMatchObject({
      items: [{ sequence: 3 }],
      nextAfter: null,
    });

    const end = await timeline("project-a", threadA, "run-a", "?after=3&limit=50");
    expect(await end.json()).toEqual({ items: [], nextAfter: null });
  });

  it("reads both nonterminal and terminal runs without changing their status", async () => {
    const [nonterminal, terminal] = await Promise.all([
      timeline("project-a", threadA, "run-a"),
      timeline("project-a", threadB, "run-b"),
    ]);
    expect(nonterminal.status).toBe(200);
    expect(terminal.status).toBe(200);
    expect((await nonterminal.json()).items).toHaveLength(3);
    expect((await terminal.json()).items).toEqual([
      expect.objectContaining({
        projectId: "project-a",
        threadId: threadB,
        runId: "run-b",
      }),
    ]);
    const database = openDatabase(databasePath);
    try {
      expect(
        database.prepare(
          "SELECT id,status FROM collaboration_runs WHERE id IN ('run-a','run-b') ORDER BY id",
        ).all(),
      ).toEqual([
        { id: "run-a", status: "running" },
        { id: "run-b", status: "stopped" },
      ]);
    } finally {
      database.close();
    }
  });

  it.each([
    "?after=1&after=2",
    "?limit=1&limit=2",
    "?unknown=1",
    "?after=",
    "?after=-1",
    "?after=1.5",
    "?after=1e2",
    "?after=9007199254740992",
    "?limit=",
    "?limit=0",
    "?limit=201",
    "?limit=1e2",
  ])("rejects duplicate, unknown, malformed, or out-of-range query: %s", async (query) => {
    const response = await timeline("project-a", threadA, "run-a", query);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "INVALID_INPUT" },
    });
  });

  it.each([
    ["bad%2Fproject", "thread", "run"],
    ["project-a", "bad%5Cthread", "run"],
    ["project-a", "thread", ".."],
  ])("rejects malformed path IDs", async (projectId, threadId, runId) => {
    const response = await timeline(projectId, threadId, runId);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "INVALID_INPUT" },
    });
  });

  it("rejects URL fragments", async () => {
    const response = await timeline("project-a", threadA, "run-a", "", "#fragment");
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "INVALID_INPUT" },
    });
  });

  it("uses one sanitized 404 for every unknown or cross tuple", async () => {
    const responses = await Promise.all([
      timeline("unknown-project", threadA, "run-a"),
      timeline("project-a", "unknown-thread", "run-a"),
      timeline("project-a", threadA, "unknown-run"),
      timeline("project-a", threadB, "run-a"),
      timeline("project-a", threadA, "run-b"),
      timeline("project-a", threadA, "run-foreign"),
      timeline("project-a", foreignThread, "run-foreign"),
    ]);
    const bodies = await Promise.all(responses.map((response) => response.json()));
    expect(responses.map(({ status }) => status)).toEqual([
      404, 404, 404, 404, 404, 404, 404,
    ]);
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

  it("never leaks events from another project or thread", async () => {
    const response = await timeline("project-a", threadA, "run-a", "?after=0&limit=200");
    const text = await response.text();
    expect(text).toContain("event-run-a-1");
    expect(text).not.toContain("event-run-b-1");
    expect(text).not.toContain("event-run-foreign-1");
    expect(text).not.toContain("project-b");
  });

  it("keeps the legacy run-only route permanently unavailable", async () => {
    const key = "../app/api/runs/[runId]/timeline/route.ts";
    const load = legacyRouteModules[key];
    expect(load, "legacy route module remains an explicit 404").toBeTypeOf("function");
    const route = await load!();
    for (const runId of ["run-a", "run-foreign", "unknown-run"]) {
      const response = await route.GET(
        new Request(`http://localhost/api/runs/${runId}/timeline?after=0&limit=1`),
        { params: Promise.resolve({ runId }) },
      );
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        error: {
          code: "RESOURCE_NOT_FOUND",
          message: "Resource was not found.",
        },
      });
    }
  });
});
