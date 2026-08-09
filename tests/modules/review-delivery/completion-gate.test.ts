import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { createMission, createWorkItem } from "@/src/adapters/outbound/sqlite/mission-work/mission-service";
import { createProject } from "@/src/adapters/outbound/sqlite/project-workspace/projects";

type GateModule = {
  completionBlockersTx?: (
    database: DatabaseSync,
    missionId: string,
  ) => Array<{ code: string; workItemId: string | null }>;
  invalidateCompletionTx?: (
    database: DatabaseSync,
    input: { reason: string; workItemId: string },
  ) => { invalidatedWorkItemIds: string[] };
  projectPassedWorkItemTx?: (
    database: DatabaseSync,
    input: { expectedHeadVersion: number; workItemId: string },
  ) => void;
  writeMissionCompletionTx?: (
    database: DatabaseSync,
    input: { missionId: string; toState: "completed" },
  ) => void;
  writeWorkItemStatusTx?: (
    database: DatabaseSync,
    input: {
      expectedVersion: number;
      toStatus: "done" | "in_progress";
      workItemId: string;
    },
  ) => void;
};

const gateModules = import.meta.glob<GateModule>(
  "../../../src/adapters/outbound/sqlite/review-delivery/completion-gate.ts",
);

let directory: string;
let databasePath: string;
let database: DatabaseSync;
let projectId: string;
let missionId: string;

function tx<T>(work: () => T): T {
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

function item(title: string, dependencyIds: string[] = []) {
  return createWorkItem(databasePath, missionId, {
    assigneeAgentId: null,
    dependencyIds,
    description: "",
    title,
  });
}

function seedHead(workItemId: string, state: "pending_review" | "passed", version = 1): void {
  database.prepare(`
    INSERT INTO work_item_review_heads(
      work_item_id,project_id,mission_id,current_result_id,current_attempt_id,
      state,version,updated_at
    ) VALUES (?, ?, ?, NULL, NULL, ?, ?, '2026-08-01T05:00:00.000Z')
  `).run(workItemId, projectId, missionId, state, version);
}

function markPassed(workItemId: string, version = 1): void {
  seedHead(workItemId, "passed", version);
  database.prepare(
    "UPDATE work_items SET status='done',version=version+1 WHERE id=?",
  ).run(workItemId);
}

function state(workItemId: string) {
  return database.prepare(`
    SELECT w.status,w.version,h.state,h.version AS headVersion
    FROM work_items w LEFT JOIN work_item_review_heads h ON h.work_item_id=w.id
    WHERE w.id=?
  `).get(workItemId);
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "completion-gate-"));
  databasePath = join(directory, "cockpit.sqlite");
  projectId = createProject("Completion gate", databasePath).id;
  missionId = createMission(databasePath, projectId, {
    expectedVersion: 0,
    goal: "Only reviewed work can complete",
    operationId: "16000000-0000-4000-8000-000000000104",
    title: "Completion mission",
  }).id;
  database = openDatabase(databasePath);
});

afterEach(() => {
  database.close();
  rmSync(directory, { force: true, recursive: true });
});

async function gate(): Promise<Required<GateModule>> {
  const load = gateModules["../../../src/adapters/outbound/sqlite/review-delivery/completion-gate.ts"];
  expect(load, "the shared completion gate module must exist").toBeTypeOf("function");
  const module = await load();
  expect(module.writeWorkItemStatusTx).toBeTypeOf("function");
  expect(module.projectPassedWorkItemTx).toBeTypeOf("function");
  expect(module.completionBlockersTx).toBeTypeOf("function");
  expect(module.invalidateCompletionTx).toBeTypeOf("function");
  expect(module.writeMissionCompletionTx).toBeTypeOf("function");
  return module as Required<GateModule>;
}

describe("single completion gate", () => {
  it("rejects every direct done projection until the current review head is passed", async () => {
    const completion = await gate();
    const work = item("Unreviewed");
    seedHead(work.id, "pending_review");
    database.prepare(
      "UPDATE work_items SET status='in_progress' WHERE id=?",
    ).run(work.id);

    expect(() => tx(() => completion.writeWorkItemStatusTx(database, {
      expectedVersion: 1,
      toStatus: "done",
      workItemId: work.id,
    }))).toThrowError(expect.objectContaining({
      code: "REVIEW_REQUIRED",
      httpStatus: 409,
    }));
    expect(state(work.id)).toMatchObject({
      headVersion: 1,
      state: "pending_review",
      status: "in_progress",
      version: 1,
    });
  });

  it("projects an already passed head consistently and uses CAS without a second event", async () => {
    const completion = await gate();
    const work = item("Passed projection");
    seedHead(work.id, "passed", 4);
    database.prepare(
      "UPDATE work_items SET status='in_progress',version=7 WHERE id=?",
    ).run(work.id);
    const beforeEvents = (database.prepare(
      "SELECT COUNT(*) AS count FROM review_events",
    ).get() as { count: number }).count;

    tx(() => completion.writeWorkItemStatusTx(database, {
      expectedVersion: 7,
      toStatus: "done",
      workItemId: work.id,
    }));
    expect(state(work.id)).toMatchObject({
      headVersion: 4,
      state: "passed",
      status: "done",
      version: 8,
    });
    expect((database.prepare(
      "SELECT COUNT(*) AS count FROM review_events",
    ).get() as { count: number }).count).toBe(beforeEvents);
    expect(() => tx(() => completion.writeWorkItemStatusTx(database, {
      expectedVersion: 7,
      toStatus: "done",
      workItemId: work.id,
    }))).toThrowError(expect.objectContaining({ code: "RESOURCE_CONFLICT" }));
  });

  it("reports an empty mission and stable per-task blockers, and never directly marks a mission completed", async () => {
    const completion = await gate();
    expect(completion.completionBlockersTx(database, missionId)).toEqual([
      { code: "MISSION_EMPTY", workItemId: null },
    ]);

    const missing = item("No result");
    const pending = item("Pending");
    seedHead(pending.id, "pending_review");
    expect(completion.completionBlockersTx(database, missionId)).toEqual([
      { code: "RESULT_MISSING", workItemId: missing.id },
      { code: "REVIEW_REQUIRED", workItemId: pending.id },
    ]);
    expect(() => tx(() => completion.writeMissionCompletionTx(database, {
      missionId,
      toState: "completed",
    }))).toThrowError(expect.objectContaining({
      blockers: expect.arrayContaining([
        { code: "RESULT_MISSING", workItemId: missing.id },
        { code: "REVIEW_REQUIRED", workItemId: pending.id },
      ]),
      code: "MISSION_COMPLETION_BLOCKED",
    }));
    expect(database.prepare(
      "SELECT state,current_delivery_id AS deliveryId FROM mission_delivery_heads WHERE mission_id=?",
    ).get(missionId)).toEqual({ deliveryId: null, state: "ongoing" });
  });

  it("reopens a passed dependency and every transitive downstream as rework", async () => {
    const completion = await gate();
    const root = item("Root");
    const child = item("Child", [root.id]);
    const leaf = item("Leaf", [child.id]);
    markPassed(root.id, 2);
    markPassed(child.id, 3);
    markPassed(leaf.id, 4);

    const result = tx(() => completion.invalidateCompletionTx(database, {
      reason: "DOWNSTREAM_REWORK_REQUESTED",
      workItemId: root.id,
    }));

    expect(result.invalidatedWorkItemIds).toEqual([root.id, child.id, leaf.id]);
    expect(state(root.id)).toMatchObject({ state: "rework", status: "in_progress" });
    expect(state(child.id)).toMatchObject({ state: "rework", status: "in_progress" });
    expect(state(leaf.id)).toMatchObject({ state: "rework", status: "in_progress" });
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM review_events
      WHERE type='legacy_work_item_completion_invalidated'
    `).get()).toEqual({ count: 3 });
  });

  it("invalidates only the current delivery while immutable delivery history remains", async () => {
    const completion = await gate();
    const work = item("Delivered work");
    markPassed(work.id);
    database.exec(`
      INSERT INTO mission_deliveries(
        id,project_id,mission_id,version,input_fingerprint,summary_json,
        evidence_manifest_json,supersedes_delivery_id,created_at
      ) VALUES (
        'delivery-1','${projectId}','${missionId}',1,'fingerprint-1','{}','[]',
        NULL,'2026-08-01T05:00:00.000Z'
      )
    `);
    database.prepare(`
      UPDATE mission_delivery_heads
      SET state='completed',current_delivery_id='delivery-1',version=version+1
      WHERE mission_id=?
    `).run(missionId);

    tx(() => completion.invalidateCompletionTx(database, {
      reason: "OWNER_REOPENED",
      workItemId: work.id,
    }));

    expect(database.prepare(`
      SELECT state,current_delivery_id AS deliveryId FROM mission_delivery_heads
      WHERE mission_id=?
    `).get(missionId)).toEqual({ deliveryId: null, state: "ongoing" });
    expect(database.prepare(
      "SELECT id,version FROM mission_deliveries WHERE mission_id=?",
    ).all(missionId)).toEqual([{ id: "delivery-1", version: 1 }]);
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM review_events
      WHERE type='delivery_invalidated'
    `).get()).toEqual({ count: 1 });
  });
});
