import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import {
  catchUpAuditProjection,
  getAuditProjectionFreshness,
  rebuildAuditProjection,
} from "@/src/adapters/outbound/sqlite/operations-projection/audit-projection-consumer";
import {
  insertAuditProjectionRows,
  upsertAuditCheckpoint,
} from "@/src/adapters/outbound/sqlite/operations-projection/audit-projection-store";
import { SchemaError } from "@/src/adapters/outbound/sqlite/schema-error";
import { OperationsProjectionError } from "@/src/modules/operations-projection";
import { memoryDatabasePath } from "@/tests/fixtures/sqlite/memory-database";

const NOW = "2026-08-10T03:00:00.000Z";
const PROJECT_ID = "audit-project";

let databasePath: string;
let database: DatabaseSync;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  databasePath = memoryDatabasePath();
  database = openDatabase(databasePath);
  database.prepare(
    "INSERT INTO projects(id,name,created_at,version) VALUES (?,?,?,1)",
  ).run(PROJECT_ID, "Audit", NOW);
});

afterEach(() => {
  try {
    database.close();
  } catch {
    // Already closed by a failure-path test.
  }
  vi.useRealTimers();
});

function insertOutboxRow(input: {
  id: string;
  seq: number;
  eventType?: string;
  occurredAt?: string;
  payload?: Record<string, unknown>;
  projectId?: string;
}): void {
  const occurredAt = input.occurredAt ?? NOW;
  database.prepare(`
    INSERT INTO audit_event_outbox (
      id,project_id,source,event_type,payload_json,occurred_at,outbox_seq
    ) VALUES (?,?,'safe_execution',?,?,?,?)
  `).run(
    input.id,
    input.projectId ?? PROJECT_ID,
    input.eventType ?? "execution_started",
    JSON.stringify(input.payload ?? {
      actorId: null,
      actorType: "agent",
      attemptNo: 1,
      executionId: "execution-1",
      occurredAt,
      type: input.eventType ?? "execution_started",
    }),
    occurredAt,
    input.seq,
  );
}

type ProjectionRow = {
  actor_type: string | null;
  event_type: string;
  execution_id: string | null;
  id: string;
  occurred_at: string;
  outbox_seq: number;
  payload_json: string;
  project_id: string;
  source: string;
};

function projectionRows(): ProjectionRow[] {
  return database.prepare(`
    SELECT outbox_seq,id,project_id,source,event_type,actor_type,occurred_at,
           execution_id,payload_json
    FROM audit_event_projection ORDER BY outbox_seq
  `).all() as unknown as ProjectionRow[];
}

describe("catchUpAuditProjection", () => {
  it("replays pending outbox rows into the projection and creates the checkpoint", () => {
    insertOutboxRow({ id: "event-1", seq: 1 });
    insertOutboxRow({
      id: "event-2",
      seq: 2,
      eventType: "model_call_finished",
      payload: {
        actorId: "agent-1",
        actorType: "agent",
        attemptNo: 1,
        executionId: "execution-1",
        occurredAt: NOW,
        totalTokens: 42,
        type: "model_call_finished",
      },
    });

    const result = catchUpAuditProjection(databasePath);

    expect(result).toEqual({ applied: 2, batches: 1, lastOutboxSeq: 2 });
    expect(projectionRows()).toEqual([
      {
        actor_type: "agent",
        event_type: "execution_started",
        execution_id: "execution-1",
        id: "event-1",
        occurred_at: NOW,
        outbox_seq: 1,
        payload_json: JSON.stringify({
          actorId: null,
          actorType: "agent",
          attemptNo: 1,
          executionId: "execution-1",
          occurredAt: NOW,
          type: "execution_started",
        }),
        project_id: PROJECT_ID,
        source: "safe_execution",
      },
      {
        actor_type: "agent",
        event_type: "model_call_finished",
        execution_id: "execution-1",
        id: "event-2",
        occurred_at: NOW,
        outbox_seq: 2,
        payload_json: JSON.stringify({
          actorId: "agent-1",
          actorType: "agent",
          attemptNo: 1,
          executionId: "execution-1",
          occurredAt: NOW,
          totalTokens: 42,
          type: "model_call_finished",
        }),
        project_id: PROJECT_ID,
        source: "safe_execution",
      },
    ]);
    const checkpoint = database.prepare(`
      SELECT last_outbox_seq AS lastOutboxSeq, status
      FROM audit_projection_checkpoints WHERE consumer_id='audit-event-projection'
    `).get() as { lastOutboxSeq: number; status: string } | undefined;
    expect(checkpoint).toEqual({ lastOutboxSeq: 2, status: "idle" });
  });

  it("is idempotent: a second run applies nothing and the projection is byte-identical", () => {
    insertOutboxRow({ id: "event-1", seq: 1 });
    insertOutboxRow({ id: "event-2", seq: 2, eventType: "execution_finished" });
    insertOutboxRow({ id: "event-3", seq: 3, eventType: "merge_completed" });

    expect(catchUpAuditProjection(databasePath)).toEqual({
      applied: 3,
      batches: 1,
      lastOutboxSeq: 3,
    });
    const firstPass = projectionRows();

    expect(catchUpAuditProjection(databasePath)).toEqual({
      applied: 0,
      batches: 0,
      lastOutboxSeq: 3,
    });
    expect(projectionRows()).toEqual(firstPass);
  });

  it("self-heals the checkpoint row on an empty outbox", () => {
    expect(catchUpAuditProjection(databasePath)).toEqual({
      applied: 0,
      batches: 0,
      lastOutboxSeq: 0,
    });
    expect(projectionRows()).toEqual([]);
    const checkpoint = database.prepare(`
      SELECT last_outbox_seq AS lastOutboxSeq, status
      FROM audit_projection_checkpoints WHERE consumer_id='audit-event-projection'
    `).get() as { lastOutboxSeq: number; status: string } | undefined;
    expect(checkpoint).toEqual({ lastOutboxSeq: 0, status: "idle" });
  });

  it("catches up a backlog larger than the batch size across multiple batches", () => {
    database.exec("BEGIN");
    for (let seq = 1; seq <= 1200; seq += 1) {
      insertOutboxRow({
        id: `event-${seq}`,
        seq,
        payload: {
          actorId: null,
          actorType: seq % 2 === 0 ? "agent" : "system",
          attemptNo: 1,
          executionId: `execution-${seq % 7}`,
          occurredAt: NOW,
          type: "execution_started",
        },
      });
    }
    database.exec("COMMIT");

    const result = catchUpAuditProjection(databasePath);

    expect(result).toEqual({ applied: 1200, batches: 3, lastOutboxSeq: 1200 });
    const rows = projectionRows();
    expect(rows).toHaveLength(1200);
    expect(rows[0]).toMatchObject({
      actor_type: "system",
      id: "event-1",
      outbox_seq: 1,
    });
    expect(rows[1199]).toMatchObject({
      actor_type: "agent",
      execution_id: "execution-3",
      id: "event-1200",
      outbox_seq: 1200,
    });
    expect(
      database.prepare(
        "SELECT last_outbox_seq AS s FROM audit_projection_checkpoints WHERE consumer_id='audit-event-projection'",
      ).get(),
    ).toEqual({ s: 1200 });
  });

  it("resumes from an interrupted batch boundary without duplicating rows", () => {
    database.exec("BEGIN");
    for (let seq = 1; seq <= 600; seq += 1) {
      insertOutboxRow({ id: `event-${seq}`, seq });
    }
    database.exec("COMMIT");
    // State an interrupted run leaves behind: the first batch's rows and the
    // batch-boundary checkpoint committed together (constructed with the same
    // store primitives the consumer uses).
    database.exec("BEGIN");
    const firstBatch = database.prepare(`
      SELECT outbox_seq AS outboxSeq, id, project_id AS projectId, source,
             event_type AS eventType, occurred_at AS occurredAt,
             payload_json AS payloadJson
      FROM audit_event_outbox WHERE outbox_seq<=500 ORDER BY outbox_seq
    `).all() as unknown as Array<{
      eventType: string;
      id: string;
      occurredAt: string;
      outboxSeq: number;
      payloadJson: string;
      projectId: string;
      source: string;
    }>;
    insertAuditProjectionRows(database, firstBatch.map((row) => ({
      actorType: "agent",
      eventType: row.eventType,
      executionId: "execution-1",
      id: row.id,
      occurredAt: row.occurredAt,
      outboxSeq: row.outboxSeq,
      payloadJson: row.payloadJson,
      projectId: row.projectId,
      source: row.source,
    })));
    upsertAuditCheckpoint(database, {
      consumerId: "audit-event-projection",
      lastOutboxSeq: 500,
      status: "idle",
    });
    database.exec("COMMIT");

    expect(catchUpAuditProjection(databasePath)).toEqual({
      applied: 100,
      batches: 1,
      lastOutboxSeq: 600,
    });
    const rows = projectionRows();
    expect(rows).toHaveLength(600);
    expect(new Set(rows.map((row) => row.outbox_seq)).size).toBe(600);
  });

  it("replays an overlapping window without duplicates when the checkpoint lags the projection", () => {
    database.exec("BEGIN");
    for (let seq = 1; seq <= 10; seq += 1) {
      insertOutboxRow({ id: `event-${seq}`, seq });
    }
    database.exec("COMMIT");
    expect(catchUpAuditProjection(databasePath)).toEqual({
      applied: 10,
      batches: 1,
      lastOutboxSeq: 10,
    });
    const before = projectionRows();
    // Checkpoint rewound behind the projection (e.g. restored backup): the
    // replayed window 6..10 must dedupe on the UNIQUE outbox_seq.
    upsertAuditCheckpoint(database, {
      consumerId: "audit-event-projection",
      lastOutboxSeq: 5,
      status: "idle",
    });

    expect(catchUpAuditProjection(databasePath)).toEqual({
      applied: 0,
      batches: 1,
      lastOutboxSeq: 10,
    });
    expect(projectionRows()).toEqual(before);
  });

  it("tracks interleaved multi-project outbox rows into one global projection", () => {
    database.prepare(
      "INSERT INTO projects(id,name,created_at,version) VALUES (?,?,?,1)",
    ).run("project-b", "B", NOW);
    database.exec("BEGIN");
    insertOutboxRow({ id: "a-1", seq: 1 });
    insertOutboxRow({ id: "b-1", projectId: "project-b", seq: 2 });
    insertOutboxRow({ id: "a-2", seq: 3 });
    insertOutboxRow({ id: "b-2", projectId: "project-b", seq: 4 });
    database.exec("COMMIT");

    expect(catchUpAuditProjection(databasePath)).toEqual({
      applied: 4,
      batches: 1,
      lastOutboxSeq: 4,
    });
    const rows = projectionRows();
    expect(rows.map((row) => [row.outbox_seq, row.project_id, row.id])).toEqual([
      [1, PROJECT_ID, "a-1"],
      [2, "project-b", "b-1"],
      [3, PROJECT_ID, "a-2"],
      [4, "project-b", "b-2"],
    ]);
  });

  it("refuses to catch up while a rebuild is in progress", () => {
    insertOutboxRow({ id: "event-1", seq: 1 });
    upsertAuditCheckpoint(database, {
      consumerId: "audit-event-projection",
      lastOutboxSeq: 0,
      status: "rebuilding",
    });

    expect(() => catchUpAuditProjection(databasePath)).toThrowError(
      expect.objectContaining({
        code: "PROJECTION_REBUILD_IN_PROGRESS",
        name: "OperationsProjectionError",
      }) as OperationsProjectionError,
    );
    expect(projectionRows()).toEqual([]);
  });

  it("fails closed on a corrupt checkpoint (last_outbox_seq beyond the outbox)", () => {
    database.exec("BEGIN");
    for (let seq = 1; seq <= 5; seq += 1) {
      insertOutboxRow({ id: `event-${seq}`, seq });
    }
    database.exec("COMMIT");
    catchUpAuditProjection(databasePath);
    const before = projectionRows();
    // Outbox rows deleted behind the checkpoint: reopen invariants reject this
    // drift at open, so the consumer never silently rewinds or self-heals it.
    database.exec("DELETE FROM audit_event_outbox WHERE outbox_seq>3");

    expect(() => catchUpAuditProjection(databasePath)).toThrowError(
      expect.objectContaining({
        code: "SCHEMA_DATA_INVALID",
        name: "SchemaError",
      }) as SchemaError,
    );
    expect(projectionRows()).toEqual(before);
  });
});

describe("rebuildAuditProjection", () => {
  it("replays the full outbox from scratch and establishes the checkpoint", () => {
    database.exec("BEGIN");
    for (let seq = 1; seq <= 3; seq += 1) {
      insertOutboxRow({ id: `event-${seq}`, seq });
    }
    database.exec("COMMIT");

    expect(rebuildAuditProjection(databasePath)).toEqual({
      lastOutboxSeq: 3,
      replayed: 3,
    });
    expect(projectionRows().map((row) => row.outbox_seq)).toEqual([1, 2, 3]);
    expect(
      database.prepare(
        `SELECT last_outbox_seq AS s, status FROM audit_projection_checkpoints
         WHERE consumer_id='audit-event-projection'`,
      ).get(),
    ).toEqual({ s: 3, status: "idle" });
  });

  it("repairs a diverged projection deterministically back to the outbox content", () => {
    database.exec("BEGIN");
    for (let seq = 1; seq <= 5; seq += 1) {
      insertOutboxRow({ id: `event-${seq}`, seq });
    }
    database.exec("COMMIT");
    catchUpAuditProjection(databasePath);
    const reference = projectionRows();
    // Diverge the projection: drop one row and tamper another's payload.
    database.exec("DELETE FROM audit_event_projection WHERE outbox_seq=3");
    database.exec(
      "UPDATE audit_event_projection SET payload_json='{}' WHERE outbox_seq=2",
    );

    expect(rebuildAuditProjection(databasePath)).toEqual({
      lastOutboxSeq: 5,
      replayed: 5,
    });
    expect(projectionRows()).toEqual(reference);
    // Rebuilding again is a fixed point.
    expect(rebuildAuditProjection(databasePath)).toEqual({
      lastOutboxSeq: 5,
      replayed: 5,
    });
    expect(projectionRows()).toEqual(reference);
  });

  it("rebuilds an empty outbox to an empty projection and an idle zero checkpoint", () => {
    expect(rebuildAuditProjection(databasePath)).toEqual({
      lastOutboxSeq: 0,
      replayed: 0,
    });
    expect(projectionRows()).toEqual([]);
    expect(
      database.prepare(
        `SELECT last_outbox_seq AS s, status FROM audit_projection_checkpoints
         WHERE consumer_id='audit-event-projection'`,
      ).get(),
    ).toEqual({ s: 0, status: "idle" });
  });

  it("rejects a concurrent rebuild and leaves the projection untouched", () => {
    database.exec("BEGIN");
    for (let seq = 1; seq <= 2; seq += 1) {
      insertOutboxRow({ id: `event-${seq}`, seq });
    }
    database.exec("COMMIT");
    catchUpAuditProjection(databasePath);
    const before = projectionRows();
    upsertAuditCheckpoint(database, {
      consumerId: "audit-event-projection",
      lastOutboxSeq: 2,
      status: "rebuilding",
    });

    expect(() => rebuildAuditProjection(databasePath)).toThrowError(
      expect.objectContaining({
        code: "PROJECTION_REBUILD_IN_PROGRESS",
        name: "OperationsProjectionError",
      }) as OperationsProjectionError,
    );
    expect(projectionRows()).toEqual(before);
    expect(
      database.prepare(
        `SELECT last_outbox_seq AS s, status FROM audit_projection_checkpoints
         WHERE consumer_id='audit-event-projection'`,
      ).get(),
    ).toEqual({ s: 2, status: "rebuilding" });
  });
});

describe("getAuditProjectionFreshness", () => {
  it("reports caught_up with zero lag on an empty outbox without a checkpoint", () => {
    expect(getAuditProjectionFreshness(databasePath)).toEqual({
      lag: 0,
      status: "caught_up",
    });
  });

  it("reports the full backlog as lag before the consumer ever ran", () => {
    database.exec("BEGIN");
    for (let seq = 1; seq <= 3; seq += 1) {
      insertOutboxRow({ id: `event-${seq}`, seq });
    }
    database.exec("COMMIT");

    expect(getAuditProjectionFreshness(databasePath)).toEqual({
      lag: 3,
      status: "behind",
    });
  });

  it("tracks lag as new outbox rows arrive after a catch-up", () => {
    insertOutboxRow({ id: "event-1", seq: 1 });
    catchUpAuditProjection(databasePath);
    expect(getAuditProjectionFreshness(databasePath)).toEqual({
      lag: 0,
      status: "caught_up",
    });

    insertOutboxRow({ id: "event-2", seq: 2 });
    insertOutboxRow({ id: "event-3", seq: 3 });
    expect(getAuditProjectionFreshness(databasePath)).toEqual({
      lag: 2,
      status: "behind",
    });
  });

  it("reports rebuilding while the checkpoint is claimed", () => {
    database.exec("BEGIN");
    for (let seq = 1; seq <= 4; seq += 1) {
      insertOutboxRow({ id: `event-${seq}`, seq });
    }
    database.exec("COMMIT");
    upsertAuditCheckpoint(database, {
      consumerId: "audit-event-projection",
      lastOutboxSeq: 1,
      status: "rebuilding",
    });

    expect(getAuditProjectionFreshness(databasePath)).toEqual({
      lag: 3,
      status: "rebuilding",
    });
  });

  it("fails closed on a corrupt checkpoint instead of reporting a negative lag", () => {
    database.exec("BEGIN");
    for (let seq = 1; seq <= 5; seq += 1) {
      insertOutboxRow({ id: `event-${seq}`, seq });
    }
    database.exec("COMMIT");
    catchUpAuditProjection(databasePath);
    database.exec("DELETE FROM audit_event_outbox WHERE outbox_seq>3");

    expect(() => getAuditProjectionFreshness(databasePath)).toThrowError(
      expect.objectContaining({
        code: "SCHEMA_DATA_INVALID",
        name: "SchemaError",
      }) as SchemaError,
    );
  });
});
