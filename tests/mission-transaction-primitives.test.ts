import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openDatabase } from "@/src/server/db";
import { createProject } from "@/src/server/projects";
import {
  createMission,
  createWorkItem,
  getMissionState,
  updateWorkItem,
} from "@/src/server/mission-service";

type Proposal = {
  clientKey: string;
  title: string;
  description: string;
  dependsOnKeys: string[];
};
type Actor = { type: "owner" } | { type: "agent"; agentId: string };
type Primitives = {
  createWorkItemBatchTx?: (
    database: DatabaseSync,
    projectId: string,
    expectedMissionId: string,
    proposals: Proposal[],
    actor: Actor,
  ) => Record<string, string>;
  claimWorkItemTx?: (
    database: DatabaseSync,
    projectId: string,
    workItemId: string,
    agentId: string,
    expectedWorkItemVersion: number,
  ) => ReturnType<typeof createWorkItem>;
};

let directory: string;
let databasePath: string;
let projectId: string;
let missionId: string;

function seed(): void {
  const database = openDatabase(databasePath);
  try {
    database.exec(`
      INSERT INTO providers (
        id, name, base_url, default_model, api_key_cipher, api_key_iv, api_key_tag,
        credential_version, credential_generation, key_id, api_key_mask, verified_at,
        version, created_at, updated_at
      ) VALUES (
        'provider-tx', 'Provider', 'https://example.invalid', 'model',
        'cipher', 'iv', 'tag', 1, 1, 'key', '****', 'now', 1, 'now', 'now'
      );
      INSERT INTO agents (
        id, name, role, system_prompt, provider_id, model, avatar_text, accent_token,
        can_read, can_write, can_execute, max_tokens, max_handoffs, version,
        created_at, updated_at
      ) VALUES
        ('agent-a', 'Alpha', 'Peer', 'private', 'provider-tx', 'model', 'A', 'sage',
         1, 1, 0, 1000, 5, 1, 'now', 'now'),
        ('agent-b', 'Beta', 'Peer', 'private', 'provider-tx', 'model', 'B', 'gold',
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

async function primitives(): Promise<Required<Primitives>> {
  const domain = (await import("@/src/server/mission-service")) as Primitives;
  expect(domain.createWorkItemBatchTx, "batch transaction primitive must be exported").toBeTypeOf(
    "function",
  );
  expect(domain.claimWorkItemTx, "claim transaction primitive must be exported").toBeTypeOf(
    "function",
  );
  return domain as Required<Primitives>;
}

function withTransaction<T>(database: DatabaseSync, operation: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function row(database: DatabaseSync, workItemId: string) {
  return database
    .prepare(
      `SELECT status, assignee_agent_id AS assigneeAgentId, version
       FROM work_items WHERE id = ?`,
    )
    .get(workItemId) as
    | { status: string; assigneeAgentId: string | null; version: number }
    | undefined;
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "mission-tx-primitives-"));
  databasePath = join(directory, "cockpit.sqlite");
  const project = createProject("Transactions", databasePath);
  projectId = project.id;
  seed();
  missionId = createMission(databasePath, projectId, {
    title: "Transaction mission",
    goal: "Compose atomic actions",
  }).id;
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(directory, { force: true, recursive: true });
});

describe("transaction-aware mission primitives", () => {
  it("uses the caller transaction, supports outer rollback, and never begins or closes it", async () => {
    const domain = await primitives();
    const database = openDatabase(databasePath);
    const exec = vi.spyOn(database, "exec");
    const close = vi.spyOn(database, "close");

    database.exec("BEGIN IMMEDIATE");
    const keys = domain.createWorkItemBatchTx(
      database,
      projectId,
      missionId,
      [{ clientKey: "draft", title: " Draft ", description: " Body ", dependsOnKeys: [] }],
      { type: "agent", agentId: "agent-a" },
    );
    expect(keys.draft).toBeTypeOf("string");
    expect(row(database, keys.draft)).toMatchObject({ status: "todo", version: 1 });
    database.exec("ROLLBACK");

    expect(close).not.toHaveBeenCalled();
    expect(
      exec.mock.calls.filter(([sql]) => /^\s*BEGIN\b/i.test(String(sql))),
      "only the caller may begin a transaction",
    ).toHaveLength(1);
    expect(getMissionState(databasePath, projectId).workItems).toEqual([]);
    database.close();
  });

  it("creates a complete DAG and rejects claims behind forged legacy done", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-30T01:02:03.000Z"));
    const domain = await primitives();
    const database = openDatabase(databasePath);
    try {
      const keys = withTransaction(database, () =>
        domain.createWorkItemBatchTx(
          database,
          projectId,
          missionId,
          [
            { clientKey: "research", title: " Research ", description: "", dependsOnKeys: [] },
            {
              clientKey: "write",
              title: "Write",
              description: " Draft ",
              dependsOnKeys: ["research"],
            },
          ],
          { type: "agent", agentId: "agent-a" },
        ),
      );
      expect(Object.keys(keys)).toEqual(["research", "write"]);
      expect(keys.research).not.toBe(keys.write);
      const state = getMissionState(databasePath, projectId);
      expect(state.mission).toMatchObject({ id: missionId, version: 2 });
      expect(state.workItems.find(({ id }) => id === keys.research)).toMatchObject({
        id: keys.research,
        title: "Research",
        dependencyIds: [],
        version: 1,
      });
      expect(state.workItems.find(({ id }) => id === keys.write)).toMatchObject({
        id: keys.write,
        title: "Write",
        description: "Draft",
        dependencyIds: [keys.research],
        version: 1,
      });
      expect(
        database
          .prepare(
            `SELECT depends_on_id AS id
             FROM work_item_dependencies WHERE work_item_id = ?`,
          )
          .get(keys.write),
      ).toEqual({ id: keys.research });

      expect(() =>
        withTransaction(database, () =>
          domain.claimWorkItemTx(database, projectId, keys.write, "agent-a", 1),
        ),
      ).toThrowError(expect.objectContaining({ code: "ACTION_CONFLICT" }));
      database
        .prepare("UPDATE work_items SET status = 'done' WHERE id = ?")
        .run(keys.research);
      expect(() =>
        withTransaction(database, () =>
          domain.claimWorkItemTx(database, projectId, keys.write, "agent-a", 1),
        ),
      ).toThrowError(expect.objectContaining({ code: "ACTION_CONFLICT" }));
      expect(row(database, keys.write)).toEqual({
        assigneeAgentId: null,
        status: "todo",
        version: 1,
      });
    } finally {
      database.close();
    }
  });

  it("reuses S-3 fields and rejects duplicate keys, missing dependencies, and cycles atomically", async () => {
    const domain = await primitives();
    const cases: Array<{ proposals: Proposal[]; code: string; fields?: unknown }> = [
      {
        proposals: [
          {
            clientKey: "bad",
            title: "任".repeat(161),
            description: "述".repeat(5001),
            dependsOnKeys: [],
          },
        ],
        code: "INVALID_INPUT",
        fields: [
          { field: "title", code: "too_long" },
          { field: "description", code: "too_long" },
        ],
      },
      {
        proposals: [
          { clientKey: "same", title: "One", description: "", dependsOnKeys: [] },
          { clientKey: "same", title: "Two", description: "", dependsOnKeys: [] },
        ],
        code: "INVALID_INPUT",
      },
      {
        proposals: [
          {
            clientKey: "dependent",
            title: "Missing",
            description: "",
            dependsOnKeys: ["absent"],
          },
        ],
        code: "DEPENDENCY_SCOPE",
      },
      {
        proposals: [
          { clientKey: "a", title: "A", description: "", dependsOnKeys: ["b"] },
          { clientKey: "b", title: "B", description: "", dependsOnKeys: ["a"] },
        ],
        code: "DEPENDENCY_CYCLE",
      },
    ];

    for (const testCase of cases) {
      const database = openDatabase(databasePath);
      try {
        expect(() =>
          withTransaction(database, () =>
            domain.createWorkItemBatchTx(
              database,
              projectId,
              missionId,
              testCase.proposals,
              { type: "owner" },
            ),
          ),
        ).toThrowError(
          expect.objectContaining({
            code: testCase.code,
            ...(testCase.fields ? { fields: testCase.fields } : {}),
          }),
        );
      } finally {
        database.close();
      }
      expect(getMissionState(databasePath, projectId)).toMatchObject({
        mission: { version: 1 },
        workItems: [],
      });
    }
  });

  it("rejects mission, membership, item version, status, and assignment conflicts without mutation", async () => {
    const domain = await primitives();
    const item = createWorkItem(databasePath, missionId, {
      title: "Claimable",
      description: "",
      assigneeAgentId: null,
      dependencyIds: [],
    });
    const database = openDatabase(databasePath);
    try {
      expect(() =>
        withTransaction(database, () =>
          domain.createWorkItemBatchTx(database, projectId, "wrong-mission", [], {
            type: "owner",
          }),
        ),
      ).toThrowError(expect.objectContaining({ code: "ACTION_CONFLICT" }));

      for (const [agentId, version] of [
        ["missing-agent", 1],
        ["agent-a", 2],
      ] as const) {
        expect(() =>
          withTransaction(database, () =>
            domain.claimWorkItemTx(database, projectId, item.id, agentId, version),
          ),
        ).toThrowError(expect.objectContaining({ code: "ACTION_CONFLICT" }));
      }
      database
        .prepare("UPDATE work_items SET status = 'blocked' WHERE id = ?")
        .run(item.id);
      expect(() =>
        withTransaction(database, () =>
          domain.claimWorkItemTx(database, projectId, item.id, "agent-a", 1),
        ),
      ).toThrowError(expect.objectContaining({ code: "ACTION_CONFLICT" }));
      database
        .prepare(
          `UPDATE work_items
           SET status = 'todo', assignee_agent_id = 'agent-b'
           WHERE id = ?`,
        )
        .run(item.id);
      expect(() =>
        withTransaction(database, () =>
          domain.claimWorkItemTx(database, projectId, item.id, "agent-a", 1),
        ),
      ).toThrowError(expect.objectContaining({ code: "ACTION_CONFLICT" }));
      expect(row(database, item.id)).toEqual({
        assigneeAgentId: "agent-b",
        status: "todo",
        version: 1,
      });
    } finally {
      database.close();
    }
  });

  it("makes an owner write win deterministically and reports the stale claim version", async () => {
    const domain = await primitives();
    const item = createWorkItem(databasePath, missionId, {
      title: "Owner race",
      description: "",
      assigneeAgentId: null,
      dependencyIds: [],
    });
    const owner = openDatabase(databasePath);
    const agent = openDatabase(databasePath);
    try {
      owner.exec("BEGIN IMMEDIATE");
      owner
        .prepare(
          `UPDATE work_items
           SET title = 'Owner won', version = version + 1
           WHERE id = ? AND version = 1`,
        )
        .run(item.id);
      expect(() => agent.exec("BEGIN IMMEDIATE")).toThrow();
      owner.exec("COMMIT");

      agent.exec("BEGIN IMMEDIATE");
      expect(() =>
        domain.claimWorkItemTx(agent, projectId, item.id, "agent-a", 1),
      ).toThrowError(
        expect.objectContaining({
          code: "ACTION_CONFLICT",
          currentVersion: 2,
        }),
      );
      agent.exec("ROLLBACK");
      expect(row(owner, item.id)).toEqual({
        assigneeAgentId: null,
        status: "todo",
        version: 2,
      });
    } finally {
      owner.close();
      agent.close();
    }

    const updated = updateWorkItem(databasePath, item.id, {
      title: "Public owner edit",
      description: "",
      assigneeAgentId: null,
      dependencyIds: [],
      expectedVersion: 2,
    });
    expect(updated.version).toBe(3);
  });
});
