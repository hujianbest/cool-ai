import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase } from "@/src/server/db";
import { createMission, createWorkItem } from "@/src/server/mission-service";
import { createProject } from "@/src/server/projects";
import type { DeliveryBuildInput } from "@/src/server/review/delivery-service";

type DeliveryModule = typeof import("../src/server/review/delivery-service");
const modules = import.meta.glob<DeliveryModule>("../src/server/review/delivery-service.ts");
type DeliveryRuntime = DeliveryModule & {
  acquireDeliveryGeneration: (...arguments_: unknown[]) => any;
  finalizeDeliveryGeneration: (...arguments_: unknown[]) => any;
};
const NOW = new Date("2026-08-01T08:00:00.000Z");
const HASH = "a".repeat(64);
let directory: string;
let path: string;
let database: DatabaseSync;
let projectId: string;
let missionId: string;
let workItemId: string;

async function service(): Promise<DeliveryRuntime> {
  const load = modules["../src/server/review/delivery-service.ts"];
  expect(load).toBeTypeOf("function");
  const loaded = await load();
  const runtime = loaded as Partial<DeliveryRuntime>;
  expect(runtime.acquireDeliveryGeneration).toBeTypeOf("function");
  expect(runtime.finalizeDeliveryGeneration).toBeTypeOf("function");
  return loaded as never;
}

function buildInput(): DeliveryBuildInput {
  const mission = database.prepare(`
    SELECT title,goal,version FROM missions WHERE id=?
  `).get(missionId) as { goal: string; title: string; version: number };
  const head = database.prepare(`
    SELECT context_version AS contextVersion FROM mission_delivery_heads WHERE mission_id=?
  `).get(missionId) as { contextVersion: number };
  const work = database.prepare(`
    SELECT title,version FROM work_items WHERE id=?
  `).get(workItemId) as { title: string; version: number };
  return {
    schemaVersion: 1,
    mission: {
      contextVersion: head.contextVersion,
      goal: mission.goal,
      id: missionId,
      title: mission.title,
      version: mission.version,
    },
    tasks: [{
      decision: {
        choice: "pass",
        id: "decision",
        limitations: [],
        publicSummary: "Reviewed and complete.",
      },
      evidence: [
        {
          contentStatus: "complete",
          href: `/results/result?version=1`,
          id: "result",
          kind: "result",
          sha256: HASH,
          version: "1",
        },
        {
          contentStatus: "complete",
          href: `/reviews/attempt?version=checkpoint`,
          id: "attempt",
          kind: "review",
          sha256: HASH,
          version: "checkpoint",
        },
        {
          contentStatus: "complete",
          href: `/diffs/diff?version=1`,
          id: "diff",
          kind: "diff",
          sha256: HASH,
          version: "1",
        },
      ],
      execution: { id: "execution", mergeFileCount: 1, mergeFinalBytes: 12, stagedHash: HASH },
      executor: { agentId: "executor", name: "Executor" },
      result: { id: "result", version: 1 },
      review: { attemptId: "attempt", reviewerAgentId: "reviewer" },
      reviewer: { agentId: "reviewer", name: "Reviewer" },
      workItem: { id: workItemId, title: work.title, version: work.version },
    }],
  };
}

function seedPassed(): void {
  database.exec("PRAGMA foreign_keys=OFF");
  database.prepare(`
    INSERT INTO work_item_result_versions(
      id,project_id,mission_id,work_item_id,version,execution_id,staged_result_id,
      merge_journal_id,supersedes_result_id,executor_agent_id,created_at
    ) VALUES ('result',?,?,?,1,'execution','staged','journal',NULL,'executor',?)
  `).run(projectId, missionId, workItemId, NOW.toISOString());
  database.prepare(`
    INSERT INTO work_item_review_heads(
      work_item_id,project_id,mission_id,current_result_id,current_attempt_id,state,version,updated_at
    ) VALUES (?,?,?,'result','attempt','passed',1,?)
  `).run(workItemId, projectId, missionId, NOW.toISOString());
  database.prepare("UPDATE work_items SET status='done',version=2 WHERE id=?").run(workItemId);
  database.exec("PRAGMA foreign_keys=ON");
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "delivery-service-"));
  path = join(directory, "cockpit.sqlite");
  projectId = createProject("Delivery", path).id;
  missionId = createMission(path, projectId, { title: "Mission", goal: "Goal" }).id;
  workItemId = createWorkItem(path, missionId, {
    assigneeAgentId: null,
    dependencyIds: [],
    description: "",
    title: "Task",
  }).id;
  database = openDatabase(path);
  seedPassed();
});

afterEach(() => {
  database.close();
  rmSync(directory, { force: true, recursive: true });
});

describe("two-phase delivery generation", () => {
  it("requires every task passed and a blocker-free manifest before acquire", async () => {
    const delivery = await service();
    database.prepare("UPDATE work_item_review_heads SET state='pending_review' WHERE work_item_id=?")
      .run(workItemId);

    expect(() => delivery.acquireDeliveryGeneration(database, {
      buildInput: buildInput(),
      expectedHeadVersion: 1,
      missionId,
      operationId: "operation-blocked",
      projectId,
      requestHash: HASH,
    }, { clock: () => NOW, randomUUID: () => "lease" })).toThrowError(
      expect.objectContaining({ code: "MISSION_COMPLETION_BLOCKED" }),
    );
    expect(database.prepare("SELECT state FROM mission_delivery_heads WHERE mission_id=?").get(missionId))
      .toEqual({ state: "ongoing" });
  });

  it("acquires then atomically commits one immutable delivery and receipt", async () => {
    const delivery = await service();
    const checkpoint = delivery.acquireDeliveryGeneration(database, {
      buildInput: buildInput(),
      expectedHeadVersion: 1,
      missionId,
      operationId: "operation-1",
      projectId,
      requestHash: HASH,
    }, { clock: () => NOW, randomUUID: () => "lease-1" });

    expect(database.prepare(`
      SELECT state,current_operation_id AS operationId,current_delivery_id AS deliveryId
      FROM mission_delivery_heads WHERE mission_id=?
    `).get(missionId)).toEqual({
      deliveryId: null,
      operationId: "operation-1",
      state: "generating",
    });
    expect(database.prepare("SELECT COUNT(*) AS count FROM mission_deliveries").get())
      .toEqual({ count: 0 });

    const result = delivery.finalizeDeliveryGeneration(database, checkpoint, {
      clock: () => NOW,
      randomUUID: () => "delivery-1",
    });
    expect(result).toMatchObject({ deliveryId: "delivery-1", reused: false, state: "completed" });
    expect(database.prepare(`
      SELECT h.state,h.current_delivery_id AS deliveryId,o.status AS operationStatus,
             (SELECT COUNT(*) FROM mission_deliveries) AS deliveries
      FROM mission_delivery_heads h
      JOIN review_operations o ON o.id='operation-1' AND o.project_id=h.project_id
      WHERE h.mission_id=?
    `).get(missionId)).toEqual({
      deliveries: 1,
      deliveryId: "delivery-1",
      operationStatus: "completed",
      state: "completed",
    });
  });

  it("has one CAS acquire winner and reuses the same fingerprint after invalidation", async () => {
    const delivery = await service();
    const input = buildInput();
    const winner = delivery.acquireDeliveryGeneration(database, {
      buildInput: input,
      expectedHeadVersion: 1,
      missionId,
      operationId: "winner",
      projectId,
      requestHash: HASH,
    }, { clock: () => NOW, randomUUID: () => "winner-lease" });
    expect(() => delivery.acquireDeliveryGeneration(database, {
      buildInput: input,
      expectedHeadVersion: 1,
      missionId,
      operationId: "loser",
      projectId,
      requestHash: "b".repeat(64),
    }, { clock: () => NOW, randomUUID: () => "loser-lease" })).toThrowError(
      expect.objectContaining({ code: "DELIVERY_STATE_CONFLICT" }),
    );
    const first = delivery.finalizeDeliveryGeneration(database, winner, {
      clock: () => NOW,
      randomUUID: () => "delivery-1",
    });
    database.prepare(`
      UPDATE mission_delivery_heads
      SET state='ongoing',current_delivery_id=NULL,version=version+1
      WHERE mission_id=?
    `).run(missionId);
    const version = (database.prepare(
      "SELECT version FROM mission_delivery_heads WHERE mission_id=?",
    ).get(missionId) as { version: number }).version;
    const retry = delivery.acquireDeliveryGeneration(database, {
      buildInput: input,
      expectedHeadVersion: version,
      missionId,
      operationId: "retry",
      projectId,
      requestHash: "c".repeat(64),
    }, { clock: () => NOW, randomUUID: () => "retry-lease" });
    const reused = delivery.finalizeDeliveryGeneration(database, retry, {
      clock: () => NOW,
      randomUUID: () => "must-not-be-used",
    });

    expect(reused).toMatchObject({ deliveryId: first.deliveryId, reused: true });
    expect(database.prepare("SELECT COUNT(*) AS count FROM mission_deliveries").get())
      .toEqual({ count: 1 });
  });
});
