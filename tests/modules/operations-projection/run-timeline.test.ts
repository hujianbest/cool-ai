import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { listProjectTimeline } from "@/src/adapters/outbound/sqlite/operations-projection/audit-projection-queries";
import { OperationsProjectionError } from "@/src/modules/operations-projection";
import { memoryDatabasePath } from "@/tests/fixtures/sqlite/memory-database";

const NOW = "2026-08-15T03:00:00.000Z";
const EARLIER = "2026-08-15T01:00:00.000Z";
const LATER = "2026-08-15T05:00:00.000Z";
const PROJECT_ID = "timeline-project";

let databasePath: string;
let database: DatabaseSync;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  databasePath = memoryDatabasePath();
  database = openDatabase(databasePath);
  database.prepare(
    "INSERT INTO projects(id,name,created_at,version) VALUES (?,?,?,1)",
  ).run(PROJECT_ID, "Timeline", NOW);
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
  const eventType = input.eventType ?? "execution_started";
  database.prepare(`
    INSERT INTO audit_event_outbox (
      id,project_id,source,event_type,payload_json,occurred_at,outbox_seq
    ) VALUES (?,?,'safe_execution',?,?,?,?)
  `).run(
    input.id,
    input.projectId ?? PROJECT_ID,
    eventType,
    JSON.stringify(input.payload ?? {
      actorId: null,
      actorType: "agent",
      attemptNo: 1,
      executionId: "execution-1",
      occurredAt,
      type: eventType,
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

function outboxCount(): number {
  return (database.prepare(
    "SELECT COUNT(*) AS value FROM audit_event_outbox",
  ).get() as { value: number }).value;
}

describe("listProjectTimeline", () => {
  it("catches up unprojected outbox rows and returns chronological items", () => {
    insertOutboxRow({
      eventType: "execution_finished",
      id: "event-late",
      occurredAt: LATER,
      payload: {
        actorType: "agent",
        executionId: "execution-late",
        occurredAt: LATER,
        type: "execution_finished",
      },
      seq: 1,
    });
    insertOutboxRow({
      eventType: "execution_started",
      id: "event-early",
      occurredAt: EARLIER,
      payload: {
        actorType: "agent",
        executionId: "execution-early",
        occurredAt: EARLIER,
        type: "execution_started",
      },
      seq: 2,
    });
    insertOutboxRow({
      eventType: "status_changed",
      id: "event-mid-b",
      occurredAt: NOW,
      payload: {
        actorType: "system",
        executionId: "execution-mid",
        occurredAt: NOW,
        type: "status_changed",
      },
      seq: 4,
    });
    insertOutboxRow({
      eventType: "tool_requested",
      id: "event-mid-a",
      occurredAt: NOW,
      payload: {
        actorType: "agent",
        executionId: "execution-mid",
        occurredAt: NOW,
        type: "tool_requested",
      },
      seq: 3,
    });
    expect(checkpointRow()).toBeUndefined();

    const page = listProjectTimeline(databasePath, PROJECT_ID);

    expect(page.items.map((item) => item.id)).toEqual([
      "event-early",
      "event-mid-a",
      "event-mid-b",
      "event-late",
    ]);
    expect(page.items.map((item) => item.outboxSeq)).toEqual([2, 3, 4, 1]);
    expect(page.freshness).toEqual({ lag: 0, status: "caught_up" });
    expect(checkpointRow()).toEqual({ lastOutboxSeq: 4, status: "idle" });
  });

  it("filters by payload missionId and excludes events without that field", () => {
    insertOutboxRow({
      eventType: "work_item_created",
      id: "mission-a",
      payload: {
        actorType: "owner",
        missionId: "mission-alpha",
        type: "work_item_created",
        workItemId: "work-1",
      },
      seq: 1,
    });
    insertOutboxRow({
      eventType: "work_item_created",
      id: "mission-b",
      payload: {
        actorType: "owner",
        missionId: "mission-beta",
        type: "work_item_created",
        workItemId: "work-2",
      },
      seq: 2,
    });
    insertOutboxRow({
      eventType: "execution_started",
      id: "no-mission",
      seq: 3,
    });

    const filtered = listProjectTimeline(databasePath, PROJECT_ID, {
      missionId: "mission-alpha",
    });
    expect(filtered.items.map((item) => item.id)).toEqual(["mission-a"]);

    const unfiltered = listProjectTimeline(databasePath, PROJECT_ID);
    expect(unfiltered.items.map((item) => item.id)).toEqual([
      "mission-a",
      "mission-b",
      "no-mission",
    ]);
  });

  it("dedupes identical public facts and keeps the smallest outbox_seq", () => {
    const sharedPayload = {
      actorType: "agent",
      approvalId: "approval-1",
      executionId: "execution-1",
      occurredAt: NOW,
      threadId: "thread-1",
      type: "approval_requested",
      workItemId: "work-1",
    };
    insertOutboxRow({
      eventType: "approval_requested",
      id: "first-fact",
      payload: sharedPayload,
      seq: 2,
    });
    insertOutboxRow({
      eventType: "approval_requested",
      id: "echo-retry",
      payload: sharedPayload,
      seq: 5,
    });
    insertOutboxRow({
      eventType: "approval_approved",
      id: "different-type",
      payload: { ...sharedPayload, type: "approval_approved" },
      seq: 3,
    });
    insertOutboxRow({
      eventType: "approval_requested",
      id: "different-work",
      payload: { ...sharedPayload, workItemId: "work-2" },
      seq: 4,
    });

    const page = listProjectTimeline(databasePath, PROJECT_ID);

    expect(page.items.map((item) => item.id)).toEqual([
      "first-fact",
      "different-type",
      "different-work",
    ]);
    expect(page.items.find((item) => item.id === "first-fact")?.outboxSeq).toBe(2);
    expect(page.items.some((item) => item.id === "echo-retry")).toBe(false);
  });

  it("marks sourceMissing only when no locatable identity is present", () => {
    insertOutboxRow({
      eventType: "project_created",
      id: "missing-source",
      payload: { actorType: "owner", projectName: "Timeline", type: "project_created" },
      seq: 1,
    });
    insertOutboxRow({
      eventType: "work_item_created",
      id: "has-work",
      payload: {
        actorType: "owner",
        type: "work_item_created",
        workItemId: "work-1",
      },
      seq: 2,
    });
    insertOutboxRow({
      eventType: "owner_message",
      id: "has-thread",
      payload: { actorType: "owner", threadId: "thread-1", type: "owner_message" },
      seq: 3,
    });
    insertOutboxRow({
      eventType: "execution_started",
      id: "has-execution",
      seq: 4,
    });

    const page = listProjectTimeline(databasePath, PROJECT_ID);
    const byId = Object.fromEntries(page.items.map((item) => [item.id, item]));

    expect(byId["missing-source"]?.sourceMissing).toBe(true);
    expect(byId["has-work"]?.sourceMissing).toBe(false);
    expect(byId["has-thread"]?.sourceMissing).toBe(false);
    expect(byId["has-execution"]?.sourceMissing).toBe(false);
    expect(byId["missing-source"]?.payload).toEqual({
      actorType: "owner",
      projectName: "Timeline",
      type: "project_created",
    });
  });

  it("isolates projects and does not write outbox rows", () => {
    database.prepare(
      "INSERT INTO projects(id,name,created_at,version) VALUES (?,?,?,1)",
    ).run("project-b", "B", NOW);
    insertOutboxRow({ id: "a-1", seq: 1 });
    insertOutboxRow({ id: "b-1", projectId: "project-b", seq: 2 });
    const before = outboxCount();

    const pageA = listProjectTimeline(databasePath, PROJECT_ID);
    const pageB = listProjectTimeline(databasePath, "project-b");

    expect(pageA.items.map((item) => item.id)).toEqual(["a-1"]);
    expect(pageB.items.map((item) => item.id)).toEqual(["b-1"]);
    expect(outboxCount()).toBe(before);
  });

  it("returns the oldest first-page slice for the requested limit", () => {
    insertOutboxRow({ id: "event-1", occurredAt: EARLIER, seq: 1 });
    insertOutboxRow({ id: "event-2", occurredAt: NOW, seq: 2 });
    insertOutboxRow({ id: "event-3", occurredAt: LATER, seq: 3 });

    const page = listProjectTimeline(databasePath, PROJECT_ID, { limit: 2 });
    expect(page.items.map((item) => item.id)).toEqual(["event-1", "event-2"]);
  });

  it("throws PROJECT_NOT_FOUND for a missing project without leaking the id", () => {
    expect(() => listProjectTimeline(databasePath, "missing-project")).toThrowError(
      expect.objectContaining({
        code: "PROJECT_NOT_FOUND",
        message: "Project was not found.",
        name: "OperationsProjectionError",
      }) as OperationsProjectionError,
    );
  });

  it.each([
    [{ limit: 0 }],
    [{ limit: 101 }],
    [{ limit: 1.5 }],
    [{ limit: Number.NaN }],
    [{ missionId: "" }],
  ])("rejects invalid options defensively: %o", (options) => {
    expect(() => listProjectTimeline(databasePath, PROJECT_ID, options)).toThrowError(
      expect.objectContaining({
        code: "INVALID_INPUT",
        name: "OperationsProjectionError",
      }) as OperationsProjectionError,
    );
  });
});
