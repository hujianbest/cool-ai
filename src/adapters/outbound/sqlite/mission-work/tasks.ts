import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type {
  TaskEvent,
  TaskRun,
  TaskStateResponse,
  TaskStatus,
} from "@/src/shared/contracts";
import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { appendTaskEventAuditOutboxRow } from "@/src/adapters/outbound/sqlite/mission-work/audit-event-outbox";
import {
  TaskDomainError,
  TaskExecutionError,
  type TaskExecutor,
} from "@/src/modules/mission-work";

type TaskRow = {
  id: string;
  projectId: string;
  goal: string;
  status: TaskStatus;
  result: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

type EventRow = {
  id: string;
  taskId: string;
  sequence: number;
  status: TaskStatus;
  message: string;
  createdAt: string;
};

function toTask(row: TaskRow): TaskRun {
  return { ...row };
}

function toEvent(row: EventRow): TaskEvent {
  return { ...row };
}

function readTask(database: DatabaseSync, taskId: string): TaskRun | undefined {
  const row = database
    .prepare(`
      SELECT id, project_id AS projectId, goal, status, result, error,
             created_at AS createdAt, updated_at AS updatedAt
      FROM task_runs
      WHERE id = ?
    `)
    .get(taskId) as TaskRow | undefined;
  return row ? toTask(row) : undefined;
}

function readEvents(database: DatabaseSync, taskId: string): TaskEvent[] {
  const rows = database
    .prepare(`
      SELECT id, task_id AS taskId, sequence, status, message, created_at AS createdAt
      FROM task_events
      WHERE task_id = ?
      ORDER BY sequence ASC
    `)
    .all(taskId) as EventRow[];
  return rows.map(toEvent);
}

function requireTask(database: DatabaseSync, taskId: string): TaskRun {
  const task = readTask(database, taskId);
  if (!task) {
    throw new TaskDomainError("TASK_NOT_FOUND", "Task was not found.");
  }
  return task;
}

function appendState(
  database: DatabaseSync,
  task: TaskRun,
  status: TaskStatus,
  message: string,
  result: string | null,
  error: string | null,
): TaskStateResponse {
  const updatedAt = new Date().toISOString();
  database.exec("BEGIN IMMEDIATE");
  let event: TaskEvent;
  try {
    const sequenceRow = database
      .prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM task_events WHERE task_id = ?")
      .get(task.id) as { sequence: number };
    event = {
      id: randomUUID(),
      taskId: task.id,
      sequence: sequenceRow.sequence,
      status,
      message,
      createdAt: updatedAt,
    };
    database
      .prepare(`
        UPDATE task_runs
        SET status = ?, result = ?, error = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(status, result, error, updatedAt, task.id);
    database
      .prepare(`
        INSERT INTO task_events (id, task_id, sequence, status, message, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(event.id, event.taskId, event.sequence, event.status, event.message, event.createdAt);
    appendTaskEventAuditOutboxRow(database, { event, task });
    database.exec("COMMIT");
  } catch (cause) {
    database.exec("ROLLBACK");
    throw cause;
  }

  return {
    task: {
      ...task,
      status,
      result,
      error,
      updatedAt,
    },
    events: [...readEvents(database, task.id)],
  };
}

function deterministicExecutor(goal: string): string {
  const summary = goal.slice(0, 120);
  return `${summary} — 示例 Agent 已完成骨架任务`;
}

export function createTask(
  projectId: string,
  goal: string,
  databasePath: string,
): TaskStateResponse {
  const trimmedGoal = goal.trim();
  if (!trimmedGoal) {
    throw new TaskDomainError("EMPTY_GOAL", "Task goal is required.");
  }

  const database = openDatabase(databasePath);
  try {
    const project = database.prepare("SELECT id FROM projects WHERE id = ?").get(projectId);
    if (!project) {
      throw new TaskDomainError("PROJECT_NOT_FOUND", "Project was not found.");
    }

    const createdAt = new Date().toISOString();
    const task: TaskRun = {
      id: randomUUID(),
      projectId,
      goal: trimmedGoal,
      status: "queued",
      result: null,
      error: null,
      createdAt,
      updatedAt: createdAt,
    };
    const event: TaskEvent = {
      id: randomUUID(),
      taskId: task.id,
      sequence: 1,
      status: "queued",
      message: "Task queued.",
      createdAt,
    };

    database.exec("BEGIN IMMEDIATE");
    try {
      database
        .prepare(`
          INSERT INTO task_runs
            (id, project_id, goal, status, result, error, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          task.id,
          task.projectId,
          task.goal,
          task.status,
          task.result,
          task.error,
          task.createdAt,
          task.updatedAt,
        );
      database
        .prepare(`
          INSERT INTO task_events (id, task_id, sequence, status, message, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `)
        .run(event.id, event.taskId, event.sequence, event.status, event.message, event.createdAt);
      appendTaskEventAuditOutboxRow(database, { event, task });
      database.exec("COMMIT");
    } catch (cause) {
      database.exec("ROLLBACK");
      throw cause;
    }

    return { task, events: [event] };
  } finally {
    database.close();
  }
}

export function startTask(taskId: string, databasePath: string): TaskStateResponse {
  const database = openDatabase(databasePath);
  try {
    const task = requireTask(database, taskId);
    if (task.status !== "queued") {
      throw new TaskDomainError("TASK_NOT_STARTABLE", "Task is not queued.");
    }
    return appendState(database, task, "running", "Task started.", null, null);
  } finally {
    database.close();
  }
}

export function executeTask(
  taskId: string,
  databasePath: string,
  executor: TaskExecutor = deterministicExecutor,
): TaskStateResponse {
  const database = openDatabase(databasePath);
  try {
    const task = requireTask(database, taskId);
    if (task.status !== "running") {
      throw new TaskDomainError("TASK_NOT_EXECUTABLE", "Task is not running.");
    }

    let result: string;
    try {
      result = executor(task.goal);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Task execution failed.";
      const failed = appendState(database, task, "failed", "Task failed.", null, message);
      throw new TaskExecutionError({
        ...failed,
        error: {
          code: "TASK_EXECUTION_FAILED",
          message,
        },
      });
    }
    return appendState(database, task, "completed", "Task completed.", result, null);
  } finally {
    database.close();
  }
}

export function listProjectTasks(
  projectId: string,
  databasePath: string,
): { tasks: TaskStateResponse["task"][]; events: TaskStateResponse["events"] } {
  const database = openDatabase(databasePath);
  try {
    const project = database.prepare("SELECT id FROM projects WHERE id = ?").get(projectId);
    if (!project) {
      throw new TaskDomainError("PROJECT_NOT_FOUND", "Project was not found.");
    }

    const taskRows = database
      .prepare(`
        SELECT id, project_id AS projectId, goal, status, result, error,
               created_at AS createdAt, updated_at AS updatedAt
        FROM task_runs
        WHERE project_id = ?
        ORDER BY created_at ASC, id ASC
      `)
      .all(projectId) as TaskRow[];
    const eventRows = database
      .prepare(`
        SELECT task_events.id, task_events.task_id AS taskId, task_events.sequence,
               task_events.status, task_events.message, task_events.created_at AS createdAt
        FROM task_events
        JOIN task_runs ON task_runs.id = task_events.task_id
        WHERE task_runs.project_id = ?
        ORDER BY task_runs.created_at ASC, task_runs.id ASC, task_events.sequence ASC
      `)
      .all(projectId) as EventRow[];

    return {
      tasks: taskRows.map(toTask),
      events: eventRows.map(toEvent),
    };
  } finally {
    database.close();
  }
}
