import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import {
  createTask,
  executeTask,
  startTask,
} from "@/src/adapters/outbound/sqlite/mission-work/tasks";
import {
  createWorkItem,
  createWorkItemBatchTx,
  transitionWorkItem,
  updateMission,
  updateWorkItem,
} from "@/src/adapters/outbound/sqlite/mission-work/mission-service";
import {
  markWorkItemDoneTx,
  markWorkItemInProgressTx,
} from "@/src/adapters/outbound/sqlite/mission-work/work-item-status-effects";
import { createProject } from "@/src/adapters/outbound/sqlite/project-workspace/projects";
import { createMission } from "@/src/composition/mission-commands";
import { TaskExecutionError } from "@/src/modules/mission-work";
import { memoryDatabasePath } from "@/tests/fixtures/sqlite/memory-database";

const NOW = "2026-08-12T03:00:00.000Z";

let databasePath: string;
let database: DatabaseSync;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  databasePath = memoryDatabasePath();
  database = openDatabase(databasePath);
});

afterEach(() => {
  try {
    database.close();
  } catch {
    // The connection may already be closed by reopen exercises.
  }
  vi.useRealTimers();
});

describe("mission-work audit outbox schema", () => {
  it("bootstraps identity 22 and accepts the mission_work outbox source", () => {
    expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 25 });
    const project = createProject("MissionWorkAudit", databasePath);
    // createProject writes a project_workspace outbox row since feature 036,
    // so manual rows take the next shared outbox_seq values.
    const firstSeq = (database.prepare(
      "SELECT COALESCE(MAX(outbox_seq),0)+1 AS nextSeq FROM audit_event_outbox",
    ).get() as { nextSeq: number }).nextSeq;
    database.prepare(`
      INSERT INTO audit_event_outbox (
        id,project_id,source,event_type,payload_json,occurred_at,outbox_seq
      ) VALUES ('mwk-event-1',?,'mission_work','task_created','{}',?,?)
    `).run(project.id, NOW, firstSeq);
    expect(database.prepare(
      "SELECT source FROM audit_event_outbox WHERE id='mwk-event-1'",
    ).get()).toEqual({ source: "mission_work" });
    expect(() => database.prepare(`
      INSERT INTO audit_event_outbox (
        id,project_id,source,event_type,payload_json,occurred_at,outbox_seq
      ) VALUES ('mwk-event-2',?,'mission-work','task_created','{}',?,?)
    `).run(project.id, NOW, firstSeq + 1)).toThrow();
  });
});

type OutboxRow = {
  eventType: string;
  id: string;
  occurredAt: string;
  payloadJson: string;
  projectId: string;
  seq: number;
  source: string;
};

// This suite's subject is the mission-work writer seam; since feature 036 the
// shared outbox also carries project_workspace rows (project creation precedes
// every mission-work write), so the reader scopes to this source.
function outboxRows(path: string = databasePath): OutboxRow[] {
  const reader = openDatabase(path);
  try {
    return reader.prepare(`
      SELECT id,project_id AS projectId,source,event_type AS eventType,
             payload_json AS payloadJson,occurred_at AS occurredAt,outbox_seq AS seq
      FROM audit_event_outbox WHERE source='mission_work' ORDER BY outbox_seq
    `).all() as OutboxRow[];
  } finally {
    reader.close();
  }
}

describe("mission-work audit outbox task lifecycle", () => {
  it("mirrors task creation and run lifecycle transitions into the outbox", () => {
    const project = createProject("MissionWorkAudit", databasePath);
    const queued = createTask(project.id, "Prepare launch notes", databasePath);
    startTask(queued.task.id, databasePath);
    executeTask(queued.task.id, databasePath);

    const events = database.prepare(`
      SELECT id,sequence,status,message FROM task_events
      WHERE task_id=? ORDER BY sequence
    `).all(queued.task.id) as Array<{
      id: string;
      message: string;
      sequence: number;
      status: string;
    }>;
    expect(events).toHaveLength(3);

    const rows = outboxRows();
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.eventType)).toEqual([
      "task_created",
      "task_started",
      "task_completed",
    ]);
    expect(rows.map((row) => row.seq)).toEqual([2, 3, 4]);
    expect(new Set(rows.map((row) => row.source))).toEqual(new Set(["mission_work"]));
    expect(new Set(rows.map((row) => row.projectId))).toEqual(new Set([project.id]));
    expect(new Set(rows.map((row) => row.occurredAt))).toEqual(new Set([NOW]));
    expect(rows.map((row) => row.id)).toEqual(events.map((event) => event.id));

    expect(JSON.parse(rows[0]!.payloadJson)).toEqual({
      actorId: null,
      actorType: "owner",
      message: "Task queued.",
      occurredAt: NOW,
      status: "queued",
      taskId: queued.task.id,
      title: "Prepare launch notes",
      type: "task_created",
    });
    expect(JSON.parse(rows[1]!.payloadJson)).toEqual({
      actorId: null,
      actorType: "owner",
      message: "Task started.",
      occurredAt: NOW,
      status: "running",
      taskId: queued.task.id,
      title: "Prepare launch notes",
      type: "task_started",
    });
    expect(JSON.parse(rows[2]!.payloadJson)).toEqual({
      actorId: null,
      actorType: "owner",
      message: "Task completed.",
      occurredAt: NOW,
      status: "completed",
      taskId: queued.task.id,
      title: "Prepare launch notes",
      type: "task_completed",
    });
  });

  it("mirrors task_failed without leaking the executor error or result", () => {
    const project = createProject("MissionWorkAudit", databasePath);
    const queued = createTask(project.id, "Prepare launch notes", databasePath);
    startTask(queued.task.id, databasePath);

    let failure: TaskExecutionError | undefined;
    try {
      executeTask(queued.task.id, databasePath, () => {
        throw new Error("provider offline secret detail");
      });
    } catch (error) {
      failure = error as TaskExecutionError;
    }
    expect(failure).toBeInstanceOf(TaskExecutionError);

    const task = database.prepare(
      "SELECT error FROM task_runs WHERE id=?",
    ).get(queued.task.id) as { error: string };
    expect(task.error).toBe("provider offline secret detail");

    const rows = outboxRows();
    expect(rows.map((row) => row.eventType)).toEqual([
      "task_created",
      "task_started",
      "task_failed",
    ]);
    const payload = JSON.parse(rows[2]!.payloadJson) as Record<string, unknown>;
    expect(payload).toEqual({
      actorId: null,
      actorType: "owner",
      message: "Task failed.",
      occurredAt: NOW,
      status: "failed",
      taskId: queued.task.id,
      title: "Prepare launch notes",
      type: "task_failed",
    });
    expect(payload).not.toHaveProperty("error");
    expect(payload).not.toHaveProperty("result");
  });
});

const MISSION_OPERATION_ID = "16000000-0000-4000-8000-000000000125";

function seedMission(): { missionId: string; projectId: string } {
  const project = createProject("MissionWorkAudit", databasePath);
  const mission = createMission(databasePath, project.id, {
    title: "Launch mission",
    goal: "Ship the launch",
    operationId: MISSION_OPERATION_ID,
    expectedVersion: 0,
  });
  return { missionId: mission.id, projectId: project.id };
}

describe("mission-work audit outbox mission creation", () => {
  it("mirrors mission creation into the outbox in the same transaction", () => {
    const { missionId, projectId } = seedMission();

    const rows = outboxRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      eventType: "mission_created",
      occurredAt: NOW,
      projectId,
      seq: 2,
      source: "mission_work",
    });
    expect(JSON.parse(rows[0]!.payloadJson)).toEqual({
      actorId: null,
      actorType: "owner",
      missionId,
      occurredAt: NOW,
      title: "Launch mission",
      type: "mission_created",
    });
  });
});

describe("mission-work audit outbox work items", () => {
  it("mirrors work item creation and status transitions into the outbox", () => {
    const { missionId, projectId } = seedMission();
    const item = createWorkItem(databasePath, missionId, {
      title: "Draft launch notes",
      description: "",
      assigneeAgentId: null,
      dependencyIds: [],
    });

    const transitioned = transitionWorkItem(databasePath, item.id, {
      toStatus: "in_progress",
      expectedVersion: item.version,
    });
    expect(transitioned.status).toBe("in_progress");

    const writer = openDatabase(databasePath);
    try {
      writer.exec("BEGIN IMMEDIATE");
      const done = markWorkItemDoneTx(writer, {
        expectedVersion: transitioned.version,
        occurredAt: NOW,
        workItemId: item.id,
      });
      expect(done.changes).toBe(1);
      const reopened = markWorkItemInProgressTx(writer, {
        occurredAt: NOW,
        workItemId: item.id,
      });
      expect(reopened.changes).toBe(1);
      writer.exec("COMMIT");
    } finally {
      writer.close();
    }

    const rows = outboxRows();
    expect(rows.map((row) => row.eventType)).toEqual([
      "mission_created",
      "work_item_created",
      "work_item_status_changed",
      "work_item_status_changed",
      "work_item_status_changed",
    ]);
    expect(rows.map((row) => row.seq)).toEqual([2, 3, 4, 5, 6]);
    expect(new Set(rows.map((row) => row.projectId))).toEqual(new Set([projectId]));

    expect(JSON.parse(rows[1]!.payloadJson)).toEqual({
      actorId: null,
      actorType: "owner",
      missionId,
      occurredAt: NOW,
      title: "Draft launch notes",
      type: "work_item_created",
      workItemId: item.id,
    });
    expect(JSON.parse(rows[2]!.payloadJson)).toEqual({
      actorId: null,
      actorType: "owner",
      fromStatus: "todo",
      missionId,
      occurredAt: NOW,
      title: "Draft launch notes",
      toStatus: "in_progress",
      type: "work_item_status_changed",
      workItemId: item.id,
    });
    expect(JSON.parse(rows[3]!.payloadJson)).toEqual({
      actorId: null,
      actorType: "system",
      fromStatus: "in_progress",
      missionId,
      occurredAt: NOW,
      title: "Draft launch notes",
      toStatus: "done",
      type: "work_item_status_changed",
      workItemId: item.id,
    });
    expect(JSON.parse(rows[4]!.payloadJson)).toEqual({
      actorId: null,
      actorType: "system",
      fromStatus: "done",
      missionId,
      occurredAt: NOW,
      title: "Draft launch notes",
      toStatus: "in_progress",
      type: "work_item_status_changed",
      workItemId: item.id,
    });
  });

  it("mirrors batch work item creation with one outbox row per item", () => {
    const { missionId, projectId } = seedMission();

    let keyToId: Record<string, string> = {};
    const writer = openDatabase(databasePath);
    try {
      writer.exec("BEGIN IMMEDIATE");
      keyToId = createWorkItemBatchTx(
        writer,
        projectId,
        missionId,
        [
          { clientKey: "audit", dependsOnKeys: [], description: "", title: "Audit" },
          { clientKey: "report", dependsOnKeys: ["audit"], description: "", title: "Report" },
        ],
        { type: "owner" },
      );
      writer.exec("COMMIT");
    } finally {
      writer.close();
    }

    const rows = outboxRows();
    expect(rows.map((row) => row.eventType)).toEqual([
      "mission_created",
      "work_item_created",
      "work_item_created",
    ]);
    expect(rows.map((row) => row.seq)).toEqual([2, 3, 4]);
    expect(JSON.parse(rows[1]!.payloadJson)).toEqual({
      actorId: null,
      actorType: "owner",
      missionId,
      occurredAt: NOW,
      title: "Audit",
      type: "work_item_created",
      workItemId: keyToId["audit"],
    });
    expect(JSON.parse(rows[2]!.payloadJson)).toEqual({
      actorId: null,
      actorType: "owner",
      missionId,
      occurredAt: NOW,
      title: "Report",
      type: "work_item_created",
      workItemId: keyToId["report"],
    });
  });
});

describe("mission-work audit outbox discipline", () => {
  it("truncates task title excerpts to 200 graphemes in the outbox payload", () => {
    const project = createProject("MissionWorkAudit", databasePath);
    createTask(project.id, "审".repeat(250), databasePath);

    const rows = outboxRows();
    expect(rows).toHaveLength(1);
    const payload = JSON.parse(rows[0]!.payloadJson) as Record<string, unknown>;
    const title = payload.title as string;
    expect([...title]).toHaveLength(201);
    expect(title.endsWith("…")).toBe(true);
    expect(title.startsWith("审".repeat(200))).toBe(true);
  });

  it("withholds credential-like task titles without blocking the task write", () => {
    const project = createProject("MissionWorkAudit", databasePath);
    const queued = createTask(
      project.id,
      "Rotate api_key=hunter2supersecret before launch",
      databasePath,
    );

    const task = database.prepare(
      "SELECT goal FROM task_runs WHERE id=?",
    ).get(queued.task.id) as { goal: string };
    expect(task.goal).toContain("hunter2supersecret");

    const rows = outboxRows();
    expect(rows).toHaveLength(1);
    const payload = JSON.parse(rows[0]!.payloadJson) as Record<string, unknown>;
    expect(payload.title).toBe("[redacted]");
    expect(payload.message).toBe("Task queued.");
  });

  it("keeps content edits out of the audit trail", () => {
    const { missionId } = seedMission();
    const item = createWorkItem(databasePath, missionId, {
      title: "Draft launch notes",
      description: "",
      assigneeAgentId: null,
      dependencyIds: [],
    });
    const before = outboxRows();
    expect(before.map((row) => row.eventType)).toEqual([
      "mission_created",
      "work_item_created",
    ]);

    updateMission(databasePath, missionId, {
      expectedVersion: 1,
      goal: "Updated goal",
      title: "Updated title",
    });
    updateWorkItem(databasePath, item.id, {
      title: "Renamed launch notes",
      description: "Updated description",
      assigneeAgentId: null,
      dependencyIds: [],
      expectedVersion: 1,
    });

    expect(outboxRows()).toEqual(before);
  });

  it("keeps mission-work outbox rows intact across an idempotent reopen", () => {
    seedMission();
    const before = outboxRows();
    expect(before).toHaveLength(1);

    database.close();
    database = openDatabase(databasePath);

    expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 25 });
    expect(outboxRows()).toEqual(before);
  });

  it("records no outbox row when the business write is rejected", () => {
    const project = createProject("MissionWorkAudit", databasePath);
    const queued = createTask(project.id, "Prepare launch notes", databasePath);
    startTask(queued.task.id, databasePath);

    expect(() => startTask(queued.task.id, databasePath)).toThrow();

    const rows = outboxRows();
    expect(rows.map((row) => row.eventType)).toEqual(["task_created", "task_started"]);
    expect(rows.map((row) => row.seq)).toEqual([2, 3]);
  });
});
