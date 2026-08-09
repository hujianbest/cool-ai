

import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { updateMission } from "@/src/adapters/outbound/sqlite/mission-work/mission-service";
import { createMission } from "@/src/composition/mission-commands";
import { createProject } from "@/src/adapters/outbound/sqlite/project-workspace/projects";
import {
  acquireDeliveryGeneration,
  invalidateMissionContextTx,
  reconcileDeliveryGeneration,
  type DeliveryBuildInput,
} from "@/src/adapters/outbound/sqlite/review-delivery/delivery-service";
import { memoryDatabasePath, rawMemoryDatabasePath } from "@/tests/fixtures/sqlite/memory-database";

const NOW = new Date("2026-08-01T09:00:00.000Z");
const HASH = "a".repeat(64);
const databases: DatabaseSync[] = [];

function buildInput(): DeliveryBuildInput {
  return {
    schemaVersion: 1,
    mission: { contextVersion: 1, goal: "Goal", id: "mission", title: "Mission", version: 1 },
    tasks: [{
      decision: { choice: "pass", id: "decision", limitations: [], publicSummary: "Passed." },
      evidence: [
        {
          contentStatus: "complete",
          href: "/results/result?version=1",
          id: "result",
          kind: "result",
          sha256: HASH,
          version: "1",
        },
        {
          contentStatus: "complete",
          href: "/reviews/attempt?version=checkpoint",
          id: "attempt",
          kind: "review",
          sha256: HASH,
          version: "checkpoint",
        },
        {
          contentStatus: "complete",
          href: "/diffs/diff?version=1",
          id: "diff",
          kind: "diff",
          sha256: HASH,
          version: "1",
        },
      ],
      execution: {
        id: "execution",
        mergeFileCount: 1,
        mergeFinalBytes: 1,
        sourceCollaborationRunId: "run",
        sourceCollaborationThreadId: "thread",
        sourceHref: "/projects/project?thread=thread&run=run",
        stagedHash: HASH,
      },
      executor: { agentId: "executor", name: "Executor" },
      result: { id: "result", version: 1 },
      review: { attemptId: "attempt", reviewerAgentId: "reviewer" },
      reviewer: { agentId: "reviewer", name: "Reviewer" },
      workItem: { id: "work", title: "Work", version: 1 },
    }],
  };
}

function createSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE mission_delivery_heads(
      mission_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,context_version INTEGER NOT NULL,
      state TEXT NOT NULL,current_delivery_id TEXT,current_operation_id TEXT,
      generation_lease_token TEXT,generation_lease_expires_at TEXT,last_error_code TEXT,
      next_event_sequence INTEGER NOT NULL,version INTEGER NOT NULL,updated_at TEXT NOT NULL
    );
    CREATE TABLE mission_deliveries(
      id TEXT PRIMARY KEY,project_id TEXT NOT NULL,mission_id TEXT NOT NULL,version INTEGER NOT NULL,
      input_fingerprint TEXT NOT NULL,summary_json TEXT NOT NULL,evidence_manifest_json TEXT NOT NULL,
      supersedes_delivery_id TEXT,created_at TEXT NOT NULL,
      UNIQUE(mission_id,version),UNIQUE(mission_id,input_fingerprint)
    );
    CREATE TABLE review_operations(
      id TEXT NOT NULL,project_id TEXT NOT NULL,kind TEXT NOT NULL,parent_id TEXT NOT NULL,
      request_hash TEXT NOT NULL,status TEXT NOT NULL,http_status INTEGER,response_json TEXT,
      created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(project_id,id)
    );
    CREATE TABLE review_attempts(
      id TEXT PRIMARY KEY,project_id TEXT NOT NULL,mission_id TEXT NOT NULL,work_item_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,status TEXT NOT NULL,error_category TEXT,finished_at TEXT
    );
    CREATE TABLE review_model_calls(
      id TEXT PRIMARY KEY,attempt_id TEXT NOT NULL,status TEXT NOT NULL,
      error_category TEXT,finished_at TEXT
    );
    CREATE TABLE work_item_review_heads(
      work_item_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,mission_id TEXT NOT NULL,state TEXT NOT NULL,
      current_attempt_id TEXT,version INTEGER NOT NULL,updated_at TEXT NOT NULL
    );
    CREATE TABLE review_events(
      id TEXT PRIMARY KEY,project_id TEXT NOT NULL,mission_id TEXT NOT NULL,sequence INTEGER NOT NULL,
      type TEXT NOT NULL,actor_type TEXT NOT NULL,actor_id TEXT,payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,UNIQUE(mission_id,sequence)
    );
  `);
}

function fixture(state: "ongoing" | "generating" = "ongoing"): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  createSchema(database);
  database.prepare(`
    INSERT INTO mission_delivery_heads VALUES(
      'mission','project',1,?,NULL,?,?,?,NULL,1,1,?
    )
  `).run(
    state,
    state === "generating" ? "generation" : null,
    state === "generating" ? "lease" : null,
    state === "generating" ? "2026-08-01T09:02:00.000Z" : null,
    NOW.toISOString(),
  );
  if (state === "generating") {
    database.prepare(`
      INSERT INTO review_operations VALUES(
        'generation','project','generate_delivery','mission',?,'pending',NULL,NULL,?,?
      )
    `).run(HASH, NOW.toISOString(), NOW.toISOString());
  }
  return database;
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("delivery invalidation and restart recovery", () => {
  it("atomically bumps context when mission title and goal change", () => {
    const path = memoryDatabasePath();
    const project = createProject("Delivery context", path);
    const mission = createMission(path, project.id, {
      expectedVersion: 0,
      goal: "Old",
      operationId: "16000000-0000-4000-8000-000000000115",
      title: "Before",
    });

    updateMission(path, mission.id, {
      expectedVersion: mission.version,
      goal: "New",
      title: "After",
    });
    const database = openDatabase(path);
    databases.push(database);
    expect(database.prepare(`
      SELECT context_version AS contextVersion,state,current_delivery_id AS deliveryId
      FROM mission_delivery_heads WHERE mission_id=?
    `).get(mission.id)).toEqual({ contextVersion: 2, deliveryId: null, state: "ongoing" });
  });

  it("discards calling/finalizing review attempts and generating delivery atomically", () => {
    const database = fixture("generating");
    database.exec(`
      INSERT INTO review_attempts VALUES
        ('calling','project','mission','work-1','review-calling','calling',NULL,NULL),
        ('finalizing','project','mission','work-2','review-finalizing','finalizing',NULL,NULL);
      INSERT INTO review_model_calls VALUES
        ('call-1','calling','calling',NULL,NULL),
        ('call-2','finalizing','succeeded',NULL,'2026-08-01T08:59:00.000Z');
      INSERT INTO work_item_review_heads VALUES
        ('work-1','project','mission','reviewing','calling',1,'2026-08-01T09:00:00.000Z'),
        ('work-2','project','mission','reviewing','finalizing',1,'2026-08-01T09:00:00.000Z');
    `);

    const result = invalidateMissionContextTx(database, {
      missionId: "mission",
      projectId: "project",
      reason: "MISSION_CONTEXT_CHANGED",
    });

    expect(result.discardedAttemptIds).toEqual(["calling", "finalizing"]);
    expect(database.prepare(
      "SELECT id,status,error_category AS error FROM review_attempts ORDER BY id",
    ).all()).toEqual([
      { error: "stale", id: "calling", status: "discarded" },
      { error: "stale", id: "finalizing", status: "discarded" },
    ]);
    expect(database.prepare(`
      SELECT context_version AS contextVersion,state,current_operation_id AS operationId
      FROM mission_delivery_heads
    `).get()).toEqual({ contextVersion: 2, operationId: null, state: "ongoing" });
    expect(database.prepare(
      "SELECT status,http_status AS statusCode FROM review_operations",
    ).get()).toEqual({ status: "completed", statusCode: 409 });
  });

  it("keeps immutable delivery history when current delivery is invalidated", () => {
    const database = fixture();
    database.exec(`
      INSERT INTO mission_deliveries VALUES(
        'delivery','project','mission',1,'${HASH}','{}','{}',NULL,
        '2026-08-01T08:00:00.000Z'
      );
      UPDATE mission_delivery_heads
      SET state='completed',current_delivery_id='delivery'
      WHERE mission_id='mission';
    `);

    invalidateMissionContextTx(database, {
      missionId: "mission",
      projectId: "project",
      reason: "MISSION_CONTEXT_CHANGED",
    });

    expect(database.prepare(
      "SELECT state,current_delivery_id AS deliveryId FROM mission_delivery_heads",
    ).get()).toEqual({ deliveryId: null, state: "ongoing" });
    expect(database.prepare("SELECT id,version FROM mission_deliveries").all())
      .toEqual([{ id: "delivery", version: 1 }]);
  });

  it("never generates on restart and requires explicit retry after lease expiry", () => {
    const path = rawMemoryDatabasePath();
    let database = new DatabaseSync(path);
    createSchema(database);
    database.exec(`
      INSERT INTO mission_delivery_heads VALUES(
        'mission','project',1,'ongoing',NULL,NULL,NULL,NULL,NULL,1,1,
        '2026-08-01T09:00:00.000Z'
      )
    `);
    acquireDeliveryGeneration(database, {
      buildInput: buildInput(),
      expectedHeadVersion: 1,
      missionId: "mission",
      operationId: "first",
      projectId: "project",
    }, { clock: () => NOW, randomUUID: () => "lease" });
    database.close();

    database = new DatabaseSync(path);
    expect(reconcileDeliveryGeneration(database, {
      missionId: "mission",
      projectId: "project",
    }, { clock: () => new Date("2026-08-01T09:01:00.000Z") })).toEqual({ reconciled: false });
    expect(database.prepare("SELECT COUNT(*) AS count FROM mission_deliveries").get())
      .toEqual({ count: 0 });
    expect(reconcileDeliveryGeneration(database, {
      missionId: "mission",
      projectId: "project",
    }, {
      clock: () => new Date("2026-08-01T09:03:00.000Z"),
      randomUUID: () => "expired-event",
    })).toEqual({ reconciled: true });
    expect(database.prepare(`
      SELECT state,last_error_code AS errorCode FROM mission_delivery_heads
    `).get()).toEqual({
      errorCode: "DELIVERY_GENERATION_INTERRUPTED",
      state: "ongoing",
    });
    expect(database.prepare("SELECT COUNT(*) AS count FROM mission_deliveries").get())
      .toEqual({ count: 0 });
    expect(acquireDeliveryGeneration(database, {
      buildInput: buildInput(),
      expectedHeadVersion: 3,
      missionId: "mission",
      operationId: "owner-retry",
      projectId: "project",
    }, {
      clock: () => new Date("2026-08-01T09:03:01.000Z"),
      randomUUID: () => "retry-lease",
    }).leaseToken).toBe("retry-lease");
    database.close();
  });
});
