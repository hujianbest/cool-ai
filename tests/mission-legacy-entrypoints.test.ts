import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase } from "@/src/server/db";
import { createProject } from "@/src/server/projects";

type WorkItem = {
  id: string;
  status: "todo" | "in_progress" | "blocked" | "done";
  version: number;
};
type MissionDomain = {
  createMission(
    databasePath: string,
    projectId: string,
    input: { goal: string; title: string },
  ): { id: string };
  createWorkItem(
    databasePath: string,
    missionId: string,
    input: {
      assigneeAgentId: null;
      dependencyIds: string[];
      description: string;
      title: string;
    },
  ): WorkItem;
  transitionWorkItem(
    databasePath: string,
    workItemId: string,
    input: {
      expectedVersion: number;
      operationId?: string;
      toStatus: WorkItem["status"];
    },
  ): WorkItem;
  transitionWorkItemTx?: (
    database: DatabaseSync,
    input: {
      actor: { agentId: string; type: "agent" };
      expectedVersion: number;
      toStatus: WorkItem["status"];
      workItemId: string;
    },
  ) => WorkItem;
};

let directory: string;
let databasePath: string;
let database: DatabaseSync;
let domain: MissionDomain;
let projectId: string;
let missionId: string;

function transaction<T>(work: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function create(title: string): WorkItem {
  return domain.createWorkItem(databasePath, missionId, {
    assigneeAgentId: null,
    dependencyIds: [],
    description: "",
    title,
  });
}

function seedHead(workItemId: string, state: "pending_review" | "passed"): void {
  database.prepare(`
    INSERT INTO work_item_review_heads(
      work_item_id,project_id,mission_id,current_result_id,current_attempt_id,
      state,version,updated_at
    ) VALUES (?, ?, ?, NULL, NULL, ?, 1, '2026-08-01T05:00:00.000Z')
  `).run(workItemId, projectId, missionId, state);
  database.prepare(
    "UPDATE work_items SET status='in_progress' WHERE id=?",
  ).run(workItemId);
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "mission-legacy-completion-"));
  databasePath = join(directory, "cockpit.sqlite");
  domain = await import("@/src/server/mission-service") as MissionDomain;
  projectId = createProject("Legacy completion", databasePath).id;
  missionId = domain.createMission(databasePath, projectId, {
    goal: "Close every completion bypass",
    title: "Legacy mission",
  }).id;
  database = openDatabase(databasePath);
});

afterEach(() => {
  database.close();
  rmSync(directory, { force: true, recursive: true });
});

describe("legacy mission completion entrypoints", () => {
  it("blocks owner transition, Agent primitive and internal status writes at one gate", async () => {
    const work = create("Not passed");

    expect(() => domain.transitionWorkItem(databasePath, work.id, {
      expectedVersion: 1,
      toStatus: "done",
    })).toThrowError(expect.objectContaining({ code: "REVIEW_REQUIRED" }));
    expect(domain.transitionWorkItemTx).toBeTypeOf("function");
    expect(() => transaction(() => domain.transitionWorkItemTx!(database, {
      actor: { agentId: "agent-does-not-matter", type: "agent" },
      expectedVersion: 1,
      toStatus: "done",
      workItemId: work.id,
    }))).toThrowError(expect.objectContaining({ code: "REVIEW_REQUIRED" }));
    expect(database.prepare(
      "SELECT status,version FROM work_items WHERE id=?",
    ).get(work.id)).toEqual({ status: "todo", version: 1 });
  });

  it("replays the original blocked result without reinterpreting later facts", () => {
    const work = create("Replay cannot reinterpret");
    const operationId = randomUUID();
    const request = {
      expectedVersion: 1,
      operationId,
      toStatus: "done" as const,
    };

    for (let index = 0; index < 2; index += 1) {
      expect(() => domain.transitionWorkItem(databasePath, work.id, request))
        .toThrowError(expect.objectContaining({ code: "REVIEW_REQUIRED" }));
      if (index === 0) {
        create("A later unrelated fact");
      }
    }
    expect(database.prepare(`
      SELECT kind,status,http_status AS httpStatus FROM collaboration_operations
      WHERE project_id=? AND id=?
    `).all(projectId, operationId)).toEqual([
      { httpStatus: 409, kind: "legacy_work_item_transition", status: "completed" },
    ]);
    expect(database.prepare(
      "SELECT status,version FROM work_items WHERE id=?",
    ).get(work.id)).toEqual({ status: "todo", version: 1 });
  });

  it("returns the existing passed projection without creating another review event", () => {
    const work = create("Already passed");
    seedHead(work.id, "passed");
    const eventCount = (database.prepare(
      "SELECT COUNT(*) AS count FROM review_events",
    ).get() as { count: number }).count;

    expect(domain.transitionWorkItemTx).toBeTypeOf("function");
    const completed = transaction(() => domain.transitionWorkItemTx!(database, {
      actor: { agentId: "review-finalizer", type: "agent" },
      expectedVersion: 1,
      toStatus: "done",
      workItemId: work.id,
    }));
    expect(completed).toMatchObject({ id: work.id, status: "done", version: 2 });
    expect((database.prepare(
      "SELECT COUNT(*) AS count FROM review_events",
    ).get() as { count: number }).count).toBe(eventCount);
  });

  it("replays a successful legacy operation without another CAS or event", () => {
    const work = create("Successful replay infrastructure");
    const operationId = randomUUID();
    const input = { expectedVersion: 1, operationId, toStatus: "blocked" as const };
    const first = domain.transitionWorkItem(databasePath, work.id, input);
    const second = domain.transitionWorkItem(databasePath, work.id, input);

    expect(second).toEqual(first);
    expect(database.prepare(
      "SELECT status,version FROM work_items WHERE id=?",
    ).get(work.id)).toEqual({ status: "blocked", version: 2 });
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM collaboration_operations
      WHERE project_id=? AND id=?
    `).get(projectId, operationId)).toEqual({ count: 1 });
  });
});
