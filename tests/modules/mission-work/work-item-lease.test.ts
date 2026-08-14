import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import {
  claimWorkItemTx,
  createWorkItem,
  getMissionState,
  heartbeatWorkItem,
  reclaimExpiredWorkItem,
  releaseWorkItem,
} from "@/src/adapters/outbound/sqlite/mission-work/mission-service";
import { createProject } from "@/src/adapters/outbound/sqlite/project-workspace/projects";
import { createMission } from "@/src/composition/mission-commands";
import { memoryDatabasePath } from "@/tests/fixtures/sqlite/memory-database";

const CLAIMED_AT = "2026-08-15T00:00:00.000Z";
const HEARTBEAT_AT = "2026-08-15T00:10:00.000Z";
const TTL_MS = 15 * 60 * 1000;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

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
        'provider-lease', 'Provider', 'https://example.invalid', 'model',
        'cipher', 'iv', 'tag', 1, 1, 'key', '****', 'now', 1, 'now', 'now'
      );
      INSERT INTO agents (
        id, name, role, system_prompt, provider_id, model, avatar_text, accent_token,
        can_read, can_write, can_execute, max_tokens, max_handoffs, version,
        created_at, updated_at
      ) VALUES
        ('agent-a', 'Alpha', 'Peer', 'private', 'provider-lease', 'model', 'A', 'sage',
         1, 1, 0, 1000, 5, 1, 'now', 'now'),
        ('agent-b', 'Beta', 'Peer', 'private', 'provider-lease', 'model', 'B', 'gold',
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

function expectCode(operation: () => unknown, code: string, httpStatus?: number): void {
  expect(operation).toThrowError(
    expect.objectContaining({
      code,
      ...(httpStatus === undefined ? {} : { httpStatus }),
    }),
  );
}

beforeEach(() => {
  databasePath = memoryDatabasePath();
  const project = createProject("Lease", databasePath);
  projectId = project.id;
  seedMembers();
  missionId = createMission(databasePath, projectId, {
    expectedVersion: 0,
    title: "Lease mission",
    goal: "Exercise work-item lease commands",
    operationId: "16000000-0000-4000-8000-000000000270",
  }).id;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("work-item lease", () => {
  it("sets a lease token, 15-minute expiry, and heartbeat on claim", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(CLAIMED_AT));
    const created = item("Claim lease");

    const claimed = claim(created.id);

    expect(claimed.status).toBe("in_progress");
    expect(claimed.assigneeAgentId).toBe("agent-a");
    expect(claimed.lease).toEqual({
      token: expect.stringMatching(UUID),
      holderAgentId: "agent-a",
      expiresAt: new Date(Date.parse(CLAIMED_AT) + TTL_MS).toISOString(),
      lastHeartbeatAt: CLAIMED_AT,
      expired: false,
    });
    expect(claimed.lease?.expiresAt).toMatch(ISO);
    expect(claimed.lease?.lastHeartbeatAt).toMatch(ISO);
    expect(getMissionState(databasePath, projectId).workItems[0]?.lease).toEqual(
      claimed.lease,
    );
  });

  it("rejects a second claim as a version or status conflict", () => {
    const created = item("Duplicate claim");
    const claimed = claim(created.id);

    expectCode(() => claim(created.id, "agent-b", created.version), "ACTION_CONFLICT");
    expectCode(() => claim(created.id, "agent-b", claimed.version), "ACTION_CONFLICT");
    expect(getMissionState(databasePath, projectId).workItems[0]).toMatchObject({
      assigneeAgentId: "agent-a",
      status: "in_progress",
      version: claimed.version,
    });
  });

  it("extends expiry when the holder heartbeats", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(CLAIMED_AT));
    const created = item("Heartbeat extend");
    const claimed = claim(created.id);

    const heartbeated = heartbeatWorkItem(
      databasePath,
      projectId,
      created.id,
      "agent-a",
      claimed.version,
      new Date(HEARTBEAT_AT),
    );

    expect(heartbeated.version).toBe(claimed.version + 1);
    expect(heartbeated.lease).toEqual({
      token: claimed.lease?.token,
      holderAgentId: "agent-a",
      expiresAt: new Date(Date.parse(HEARTBEAT_AT) + TTL_MS).toISOString(),
      lastHeartbeatAt: HEARTBEAT_AT,
      expired: false,
    });
  });

  it("rejects a heartbeat from another agent", () => {
    const created = item("Foreign heartbeat");
    const claimed = claim(created.id);

    expectCode(
      () =>
        heartbeatWorkItem(
          databasePath,
          projectId,
          created.id,
          "agent-b",
          claimed.version,
        ),
      "ACTION_CONFLICT",
    );
    expect(getMissionState(databasePath, projectId).workItems[0]?.lease).toEqual(
      claimed.lease,
    );
  });

  it("releases a lease back to todo only for the holder", () => {
    const created = item("Release lease");
    const claimed = claim(created.id);

    expectCode(
      () =>
        releaseWorkItem(
          databasePath,
          projectId,
          created.id,
          "agent-b",
          claimed.version,
        ),
      "ACTION_CONFLICT",
    );

    const released = releaseWorkItem(
      databasePath,
      projectId,
      created.id,
      "agent-a",
      claimed.version,
    );

    expect(released).toMatchObject({
      assigneeAgentId: null,
      lease: null,
      status: "todo",
      version: claimed.version + 1,
    });
    expect(getMissionState(databasePath, projectId).workItems[0]).toMatchObject({
      assigneeAgentId: null,
      lease: null,
      status: "todo",
    });
  });

  it("reclaims an expired lease back to todo", () => {
    const created = item("Reclaim expired");
    const claimed = claim(created.id);
    const database = openDatabase(databasePath);
    try {
      database
        .prepare("UPDATE work_items SET lease_expires_at = ? WHERE id = ?")
        .run("2020-01-01T00:00:00.000Z", created.id);
    } finally {
      database.close();
    }

    const reclaimed = reclaimExpiredWorkItem(
      databasePath,
      projectId,
      created.id,
      { type: "owner" },
      claimed.version,
      new Date("2026-08-15T00:20:00.000Z"),
    );

    expect(reclaimed).toMatchObject({
      assigneeAgentId: null,
      lease: null,
      status: "todo",
      version: claimed.version + 1,
    });
  });

  it("rejects reclaim when the lease has not expired", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(CLAIMED_AT));
    const created = item("Reclaim live");
    const claimed = claim(created.id);

    expectCode(
      () =>
        reclaimExpiredWorkItem(
          databasePath,
          projectId,
          created.id,
          { type: "owner" },
          claimed.version,
          new Date(CLAIMED_AT),
        ),
      "INVALID_INPUT",
      422,
    );
    expect(getMissionState(databasePath, projectId).workItems[0]).toMatchObject({
      assigneeAgentId: "agent-a",
      status: "in_progress",
      version: claimed.version,
    });
  });

  it("marks getMissionState lease.expired when expires_at is in the past", () => {
    const created = item("Expired flag");
    claim(created.id);
    const database = openDatabase(databasePath);
    try {
      database
        .prepare("UPDATE work_items SET lease_expires_at = ? WHERE id = ?")
        .run("2020-01-01T00:00:00.000Z", created.id);
    } finally {
      database.close();
    }

    const projected = getMissionState(databasePath, projectId).workItems[0];
    expect(projected?.lease).toMatchObject({
      expiresAt: "2020-01-01T00:00:00.000Z",
      expired: true,
      holderAgentId: "agent-a",
    });
  });

  it("rejects a raw in_progress assignee insert that omits lease columns", () => {
    const database = openDatabase(databasePath);
    try {
      expect(() =>
        database
          .prepare(
            `INSERT INTO work_items (
               id,mission_id,title,description,status,assignee_agent_id,
               version,created_at,updated_at
             ) VALUES (?,?,?,?,?,?,1,?,?)`,
          )
          .run(
            "bare-lease",
            missionId,
            "Bare",
            "",
            "in_progress",
            "agent-a",
            CLAIMED_AT,
            CLAIMED_AT,
          ),
      ).toThrowError(/CHECK constraint failed/u);
    } finally {
      database.close();
    }
  });
});
