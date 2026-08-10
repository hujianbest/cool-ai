import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { listProjectAuditEvents } from "@/src/adapters/outbound/sqlite/operations-projection/audit-projection-queries";
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

function checkpointRow(): { lastOutboxSeq: number; status: string } | undefined {
  return database.prepare(`
    SELECT last_outbox_seq AS lastOutboxSeq, status
    FROM audit_projection_checkpoints WHERE consumer_id='audit-event-projection'
  `).get() as { lastOutboxSeq: number; status: string } | undefined;
}

describe("listProjectAuditEvents", () => {
  it("returns an empty page with caught_up freshness for a project without events", () => {
    expect(listProjectAuditEvents(databasePath, PROJECT_ID)).toEqual({
      events: [],
      freshness: { lag: 0, status: "caught_up" },
      nextBeforeSeq: null,
    });
  });

  it("triggers catch-up on the read path: unprojected outbox rows become visible", () => {
    insertOutboxRow({ id: "event-1", seq: 1 });
    insertOutboxRow({ id: "event-2", seq: 2, eventType: "execution_finished" });
    // No explicit catchUp: the read path itself must advance the consumer.
    expect(checkpointRow()).toBeUndefined();

    const page = listProjectAuditEvents(databasePath, PROJECT_ID);

    expect(page.events.map((event) => event.outboxSeq)).toEqual([2, 1]);
    expect(page.freshness).toEqual({ lag: 0, status: "caught_up" });
    expect(checkpointRow()).toEqual({ lastOutboxSeq: 2, status: "idle" });
  });

  it("returns newest-first events with the whitelist payload passed through as-is", () => {
    insertOutboxRow({ id: "event-1", seq: 1 });
    insertOutboxRow({
      id: "event-2",
      seq: 2,
      eventType: "model_call_finished",
      payload: {
        actorId: "agent-1",
        actorType: "agent",
        attemptNo: 1,
        executionId: "execution-9",
        occurredAt: NOW,
        totalTokens: 42,
        type: "model_call_finished",
      },
    });
    insertOutboxRow({ id: "event-3", seq: 3, eventType: "merge_completed" });

    const page = listProjectAuditEvents(databasePath, PROJECT_ID);

    expect(page.nextBeforeSeq).toBeNull();
    expect(page.events).toEqual([
      {
        actorType: "agent",
        eventType: "merge_completed",
        executionId: "execution-1",
        id: "event-3",
        occurredAt: NOW,
        outboxSeq: 3,
        payload: {
          actorId: null,
          actorType: "agent",
          attemptNo: 1,
          executionId: "execution-1",
          occurredAt: NOW,
          type: "merge_completed",
        },
      },
      {
        actorType: "agent",
        eventType: "model_call_finished",
        executionId: "execution-9",
        id: "event-2",
        occurredAt: NOW,
        outboxSeq: 2,
        payload: {
          actorId: "agent-1",
          actorType: "agent",
          attemptNo: 1,
          executionId: "execution-9",
          occurredAt: NOW,
          totalTokens: 42,
          type: "model_call_finished",
        },
      },
      {
        actorType: "agent",
        eventType: "execution_started",
        executionId: "execution-1",
        id: "event-1",
        occurredAt: NOW,
        outboxSeq: 1,
        payload: {
          actorId: null,
          actorType: "agent",
          attemptNo: 1,
          executionId: "execution-1",
          occurredAt: NOW,
          type: "execution_started",
        },
      },
    ]);
  });

  it("paginates with an exclusive beforeSeq cursor and exposes nextBeforeSeq", () => {
    database.exec("BEGIN");
    for (let seq = 1; seq <= 5; seq += 1) {
      insertOutboxRow({ id: `event-${seq}`, seq });
    }
    database.exec("COMMIT");

    const page1 = listProjectAuditEvents(databasePath, PROJECT_ID, { limit: 2 });
    expect(page1.events.map((event) => event.outboxSeq)).toEqual([5, 4]);
    expect(page1.nextBeforeSeq).toBe(4);

    const page2 = listProjectAuditEvents(databasePath, PROJECT_ID, {
      beforeSeq: page1.nextBeforeSeq ?? undefined,
      limit: 2,
    });
    expect(page2.events.map((event) => event.outboxSeq)).toEqual([3, 2]);
    expect(page2.nextBeforeSeq).toBe(2);

    const page3 = listProjectAuditEvents(databasePath, PROJECT_ID, {
      beforeSeq: page2.nextBeforeSeq ?? undefined,
      limit: 2,
    });
    expect(page3.events.map((event) => event.outboxSeq)).toEqual([1]);
    expect(page3.nextBeforeSeq).toBeNull();
  });

  it("returns an empty page when beforeSeq equals the smallest projected seq", () => {
    insertOutboxRow({ id: "event-1", seq: 1 });
    insertOutboxRow({ id: "event-2", seq: 2 });

    const page = listProjectAuditEvents(databasePath, PROJECT_ID, { beforeSeq: 1 });

    expect(page).toEqual({
      events: [],
      freshness: { lag: 0, status: "caught_up" },
      nextBeforeSeq: null,
    });
  });

  it("defaults to a 50-event page and continues with nextBeforeSeq", () => {
    database.exec("BEGIN");
    for (let seq = 1; seq <= 55; seq += 1) {
      insertOutboxRow({ id: `event-${seq}`, seq });
    }
    database.exec("COMMIT");

    const page1 = listProjectAuditEvents(databasePath, PROJECT_ID);
    expect(page1.events).toHaveLength(50);
    expect(page1.events[0].outboxSeq).toBe(55);
    expect(page1.events[49].outboxSeq).toBe(6);
    expect(page1.nextBeforeSeq).toBe(6);

    const page2 = listProjectAuditEvents(databasePath, PROJECT_ID, {
      beforeSeq: page1.nextBeforeSeq ?? undefined,
    });
    expect(page2.events.map((event) => event.outboxSeq)).toEqual([5, 4, 3, 2, 1]);
    expect(page2.nextBeforeSeq).toBeNull();
  });

  it("isolates projects: events of other projects are never visible", () => {
    database.prepare(
      "INSERT INTO projects(id,name,created_at,version) VALUES (?,?,?,1)",
    ).run("project-b", "B", NOW);
    database.exec("BEGIN");
    insertOutboxRow({ id: "a-1", seq: 1 });
    insertOutboxRow({ id: "b-1", projectId: "project-b", seq: 2 });
    insertOutboxRow({ id: "a-2", seq: 3 });
    insertOutboxRow({ id: "b-2", projectId: "project-b", seq: 4 });
    database.exec("COMMIT");

    const pageA = listProjectAuditEvents(databasePath, PROJECT_ID);
    expect(pageA.events.map((event) => [event.outboxSeq, event.id])).toEqual([
      [3, "a-2"],
      [1, "a-1"],
    ]);

    const pageB = listProjectAuditEvents(databasePath, "project-b");
    expect(pageB.events.map((event) => [event.outboxSeq, event.id])).toEqual([
      [4, "b-2"],
      [2, "b-1"],
    ]);
  });

  it("throws PROJECT_NOT_FOUND for a missing project", () => {
    expect(() => listProjectAuditEvents(databasePath, "missing")).toThrowError(
      expect.objectContaining({
        code: "PROJECT_NOT_FOUND",
        name: "OperationsProjectionError",
      }) as OperationsProjectionError,
    );
  });

  it.each([
    [{ limit: 0 }, "limit"],
    [{ limit: 101 }, "limit"],
    [{ limit: 1.5 }, "limit"],
    [{ limit: Number.NaN }, "limit"],
    [{ beforeSeq: 0 }, "beforeSeq"],
    [{ beforeSeq: -3 }, "beforeSeq"],
    [{ beforeSeq: 2.5 }, "beforeSeq"],
  ])("rejects invalid options defensively: %o", (options, _field) => {
    expect(() => listProjectAuditEvents(databasePath, PROJECT_ID, options)).toThrowError(
      expect.objectContaining({
        code: "INVALID_INPUT",
        name: "OperationsProjectionError",
      }) as OperationsProjectionError,
    );
  });

  it("fails closed while a rebuild is in progress instead of serving a partial list", () => {
    insertOutboxRow({ id: "event-1", seq: 1 });
    database.prepare(`
      INSERT INTO audit_projection_checkpoints (
        consumer_id,last_outbox_seq,status,updated_at
      ) VALUES ('audit-event-projection',0,'rebuilding',?)
    `).run(NOW);

    expect(() => listProjectAuditEvents(databasePath, PROJECT_ID)).toThrowError(
      expect.objectContaining({
        code: "PROJECTION_REBUILD_IN_PROGRESS",
        name: "OperationsProjectionError",
      }) as OperationsProjectionError,
    );
  });
});
