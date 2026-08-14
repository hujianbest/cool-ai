import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GET as getMission } from "@/app/api/projects/[projectId]/mission/route";
import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import {
  claimWorkItemTx,
  createWorkItem,
} from "@/src/adapters/outbound/sqlite/mission-work/mission-service";
import { createProject } from "@/src/adapters/outbound/sqlite/project-workspace/projects";
import { createThread } from "@/src/adapters/outbound/sqlite/public-collaboration/thread-service";
import { createMission } from "@/src/composition/mission-commands";
import { memoryDatabasePath } from "@/tests/fixtures/sqlite/memory-database";

type LeaseRoute = {
  POST(
    request: Request,
    context: { params: Promise<{ workItemId: string }> },
  ): Promise<Response>;
};

const heartbeatModules = import.meta.glob<LeaseRoute>(
  "../../../app/api/work-items/[workItemId]/heartbeat/route.ts",
);
const releaseModules = import.meta.glob<LeaseRoute>(
  "../../../app/api/work-items/[workItemId]/release/route.ts",
);
const reclaimModules = import.meta.glob<LeaseRoute>(
  "../../../app/api/work-items/[workItemId]/reclaim/route.ts",
);

const OPERATION_ID = "16000000-0000-4000-8000-000000000272";

let databasePath: string;
let projectId: string;
let missionId: string;

function seedMembers(): void {
  const database = openDatabase(databasePath);
  try {
    database.exec(`
      INSERT INTO providers (
        id, name, base_url, default_model, api_key_cipher, api_key_iv, api_key_tag,
        credential_version, credential_generation, key_id, api_key_mask, verified_at,
        version, created_at, updated_at
      ) VALUES (
        'provider-lease-api', 'Provider', 'https://example.invalid', 'model',
        'cipher', 'iv', 'tag', 1, 1, 'key', '****', 'now', 1, 'now', 'now'
      );
      INSERT INTO agents (
        id, name, role, system_prompt, provider_id, model, avatar_text, accent_token,
        can_read, can_write, can_execute, max_tokens, max_handoffs, version,
        created_at, updated_at
      ) VALUES
        ('agent-a', 'Alpha', 'Peer', 'private', 'provider-lease-api', 'model', 'A', 'sage',
         1, 1, 0, 1000, 5, 1, 'now', 'now'),
        ('agent-b', 'Beta', 'Peer', 'private', 'provider-lease-api', 'model', 'B', 'gold',
         1, 1, 0, 1000, 5, 1, 'now', 'now');
    `);
    database
      .prepare(
        `INSERT INTO project_memberships (project_id, agent_id, joined_at)
         VALUES (?, 'agent-a', 'now'), (?, 'agent-b', 'now')`,
      )
      .run(projectId, projectId);
  } finally {
    database.close();
  }
}

function item(title: string) {
  return createWorkItem(databasePath, missionId, {
    title,
    description: `${title} description`,
    assigneeAgentId: null,
    dependencyIds: [],
  });
}

function claim(workItemId: string, agentId = "agent-a", version = 1) {
  const database = openDatabase(databasePath);
  try {
    return claimWorkItemTx(database, projectId, workItemId, agentId, version);
  } finally {
    database.close();
  }
}

function expireLease(workItemId: string): void {
  const database = openDatabase(databasePath);
  try {
    database
      .prepare("UPDATE work_items SET lease_expires_at = ? WHERE id = ?")
      .run("2020-01-01T00:00:00.000Z", workItemId);
  } finally {
    database.close();
  }
}

async function leaseRoute(
  modules: Record<string, () => Promise<LeaseRoute>>,
  file: string,
  label: string,
): Promise<LeaseRoute> {
  const load = modules[file];
  expect(load, `${label} route must exist`).toBeTypeOf("function");
  return load();
}

function context(workItemId: string) {
  return { params: Promise.resolve({ workItemId }) };
}

function post(url: string, body: unknown) {
  return new Request(url, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
}

function commandBody(
  expectedVersion: number,
  agentId = "agent-a",
  operationId = OPERATION_ID,
) {
  return {
    agentId,
    expectedVersion,
    operationId,
  };
}

beforeEach(() => {
  databasePath = memoryDatabasePath();
  process.env.COCKPIT_DB_PATH = databasePath;
  const project = createProject("Lease API", databasePath);
  projectId = project.id;
  seedMembers();
  missionId = createMission(databasePath, projectId, {
    expectedVersion: 0,
    title: "Lease API mission",
    goal: "Exercise lease HTTP",
    operationId: "16000000-0000-4000-8000-000000000273",
  }).id;
  createThread(databasePath, projectId, {
    memberAgentIds: ["agent-a", "agent-b"],
    operationId: "16000000-0000-4000-8000-000000000275",
    title: "Lease fixture thread",
  });
});

afterEach(() => {
  delete process.env.COCKPIT_DB_PATH;
});

describe("work-item lease HTTP", () => {
  it("projects lease fields on GET mission state", async () => {
    const created = item("Visible lease");
    const claimed = claim(created.id);

    const response = await getMission(
      new Request(`http://localhost/api/projects/${projectId}/mission`),
      { params: Promise.resolve({ projectId }) },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      workItems: Array<{ id: string; lease?: unknown }>;
    };
    expect(body.workItems.find((entry) => entry.id === created.id)?.lease).toEqual(
      claimed.lease,
    );
  });

  it("heartbeats, releases, and reclaims through dedicated POST routes", async () => {
    const heartbeat = await leaseRoute(
      heartbeatModules,
      "../../../app/api/work-items/[workItemId]/heartbeat/route.ts",
      "heartbeat",
    );
    const release = await leaseRoute(
      releaseModules,
      "../../../app/api/work-items/[workItemId]/release/route.ts",
      "release",
    );
    const reclaim = await leaseRoute(
      reclaimModules,
      "../../../app/api/work-items/[workItemId]/reclaim/route.ts",
      "reclaim",
    );

    const live = item("HTTP heartbeat");
    const claimed = claim(live.id);
    const heartbeated = await heartbeat.POST(
      post(
        `http://localhost/api/work-items/${live.id}/heartbeat`,
        commandBody(claimed.version),
      ),
      context(live.id),
    );
    expect(heartbeated.status).toBe(200);
    const heartbeatedBody = (await heartbeated.json()) as {
      workItem: { lease: { lastHeartbeatAt: string }; version: number };
    };
    expect(heartbeatedBody.workItem.version).toBe(claimed.version + 1);
    expect(heartbeatedBody.workItem.lease.lastHeartbeatAt).toEqual(
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u),
    );

    const released = await release.POST(
      post(
        `http://localhost/api/work-items/${live.id}/release`,
        commandBody(
          heartbeatedBody.workItem.version,
          "agent-a",
          "16000000-0000-4000-8000-000000000276",
        ),
      ),
      context(live.id),
    );
    expect(released.status).toBe(200);
    await expect(released.json()).resolves.toEqual({
      workItem: expect.objectContaining({
        assigneeAgentId: null,
        lease: null,
        status: "todo",
        version: heartbeatedBody.workItem.version + 1,
      }),
    });

    const expired = item("HTTP reclaim");
    const expiredClaim = claim(expired.id);
    expireLease(expired.id);
    const reclaimed = await reclaim.POST(
      post(
        `http://localhost/api/work-items/${expired.id}/reclaim`,
        {
          actorType: "owner",
          expectedVersion: expiredClaim.version,
          operationId: "16000000-0000-4000-8000-000000000274",
        },
      ),
      context(expired.id),
    );
    expect(reclaimed.status).toBe(200);
    await expect(reclaimed.json()).resolves.toEqual({
      workItem: expect.objectContaining({
        assigneeAgentId: null,
        lease: null,
        status: "todo",
      }),
    });
  });

  it("rejects extra keys, missing actor, and reclaim of a live lease", async () => {
    const heartbeat = await leaseRoute(
      heartbeatModules,
      "../../../app/api/work-items/[workItemId]/heartbeat/route.ts",
      "heartbeat",
    );
    const reclaim = await leaseRoute(
      reclaimModules,
      "../../../app/api/work-items/[workItemId]/reclaim/route.ts",
      "reclaim",
    );
    const created = item("HTTP reject");
    const claimed = claim(created.id);

    const extra = await heartbeat.POST(
      post(`http://localhost/api/work-items/${created.id}/heartbeat`, {
        ...commandBody(claimed.version),
        extra: true,
      }),
      context(created.id),
    );
    expect(extra.status).toBe(400);
    await expect(extra.json()).resolves.toEqual({
      error: {
        code: "INVALID_INPUT",
        fields: [{ field: "extra", code: "not_supported" }],
        message: "Mission input is invalid.",
      },
    });

    const missingActor = await heartbeat.POST(
      post(`http://localhost/api/work-items/${created.id}/heartbeat`, {
        expectedVersion: claimed.version,
        operationId: OPERATION_ID,
      }),
      context(created.id),
    );
    expect(missingActor.status).toBe(400);
    await expect(missingActor.json()).resolves.toMatchObject({
      error: {
        code: "INVALID_INPUT",
        fields: [{ field: "agentId", code: "required" }],
      },
    });

    const liveReclaim = await reclaim.POST(
      post(
        `http://localhost/api/work-items/${created.id}/reclaim`,
        commandBody(claimed.version, "agent-b"),
      ),
      context(created.id),
    );
    expect(liveReclaim.status).toBe(422);
    await expect(liveReclaim.json()).resolves.toMatchObject({
      error: { code: "INVALID_INPUT" },
    });
  });

  it("replays the same lease operationId and conflicts on a different hash", async () => {
    const heartbeat = await leaseRoute(
      heartbeatModules,
      "../../../app/api/work-items/[workItemId]/heartbeat/route.ts",
      "heartbeat",
    );
    const created = item("HTTP replay");
    const claimed = claim(created.id);
    const body = commandBody(claimed.version);
    const first = await heartbeat.POST(
      post(`http://localhost/api/work-items/${created.id}/heartbeat`, body),
      context(created.id),
    );
    const replay = await heartbeat.POST(
      post(`http://localhost/api/work-items/${created.id}/heartbeat`, body),
      context(created.id),
    );
    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    const firstBody = await first.json();
    expect(await replay.json()).toEqual(firstBody);
    expect(firstBody).toMatchObject({
      workItem: { id: created.id, version: claimed.version + 1 },
    });

    const conflict = await heartbeat.POST(
      post(`http://localhost/api/work-items/${created.id}/heartbeat`, {
        ...body,
        expectedVersion: claimed.version + 1,
      }),
      context(created.id),
    );
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      error: { code: "OPERATION_CONFLICT" },
    });
  });
});
