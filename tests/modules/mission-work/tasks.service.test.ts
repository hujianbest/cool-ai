

import { afterEach, describe, expect, it } from "vitest";

import { createProject } from "@/src/adapters/outbound/sqlite/project-workspace/projects";
import {
  createTask,
  executeTask,
  listProjectTasks,
  startTask,
} from "@/src/adapters/outbound/sqlite/mission-work/tasks";
import {
  TaskDomainError,
  TaskExecutionError,
} from "@/src/modules/mission-work";
import { memoryDatabasePath } from "@/tests/fixtures/sqlite/memory-database";

function databasePath() {
  return memoryDatabasePath();
}

afterEach(() => {
});

describe("task service", () => {
  it("persists queued, running, and completed states with ordered events", () => {
    const path = databasePath();
    const project = createProject("Launch plan", path);

    const queued = createTask(project.id, "  Prepare launch notes  ", path);
    const running = startTask(queued.task.id, path);
    const completed = executeTask(queued.task.id, path);
    const reloaded = listProjectTasks(project.id, path);

    expect(queued.task).toMatchObject({ goal: "Prepare launch notes", status: "queued" });
    expect(running.task.status).toBe("running");
    expect(completed.task).toMatchObject({
      status: "completed",
      error: null,
    });
    expect(completed.task.result).toContain("Prepare launch notes");
    expect(completed.events.map(({ sequence, status }) => ({ sequence, status }))).toEqual([
      { sequence: 1, status: "queued" },
      { sequence: 2, status: "running" },
      { sequence: 3, status: "completed" },
    ]);
    expect(reloaded).toEqual({
      tasks: [completed.task],
      events: completed.events,
    });
  });

  it("persists failed state and event when execution throws", () => {
    const path = databasePath();
    const project = createProject("Launch plan", path);
    const queued = createTask(project.id, "Prepare launch notes", path);
    startTask(queued.task.id, path);

    let failure: TaskExecutionError | undefined;
    try {
      executeTask(queued.task.id, path, () => {
        throw new Error("provider offline");
      });
    } catch (error) {
      failure = error as TaskExecutionError;
    }

    expect(failure).toBeInstanceOf(TaskExecutionError);
    expect(failure?.response).toMatchObject({
      task: { status: "failed", result: null, error: "provider offline" },
      error: { code: "TASK_EXECUTION_FAILED", message: "provider offline" },
    });
    expect(failure?.response.events.map((event) => event.status)).toEqual([
      "queued",
      "running",
      "failed",
    ]);
    expect(listProjectTasks(project.id, path)).toEqual({
      tasks: [failure?.response.task],
      events: failure?.response.events,
    });
  });

  it("rejects empty goals and missing projects without orphan tasks", () => {
    const path = databasePath();
    const project = createProject("Launch plan", path);

    expect(() => createTask(project.id, "   ", path)).toThrowError(
      expect.objectContaining({ code: "EMPTY_GOAL" }),
    );
    expect(() => createTask("missing-project", "Goal", path)).toThrowError(
      expect.objectContaining({ code: "PROJECT_NOT_FOUND" }),
    );
    expect(listProjectTasks(project.id, path)).toEqual({ tasks: [], events: [] });
  });

  it("rejects missing tasks and illegal repeated transitions", () => {
    const path = databasePath();
    const project = createProject("Launch plan", path);
    const queued = createTask(project.id, "Goal", path);

    expect(() => startTask("missing-task", path)).toThrowError(
      expect.objectContaining({ code: "TASK_NOT_FOUND" }),
    );
    expect(() => executeTask(queued.task.id, path)).toThrowError(
      expect.objectContaining({ code: "TASK_NOT_EXECUTABLE" }),
    );

    startTask(queued.task.id, path);
    expect(() => startTask(queued.task.id, path)).toThrowError(
      expect.objectContaining({ code: "TASK_NOT_STARTABLE" }),
    );
    executeTask(queued.task.id, path);
    expect(() => executeTask(queued.task.id, path)).toThrowError(
      expect.objectContaining({ code: "TASK_NOT_EXECUTABLE" }),
    );
  });

  it("uses domain errors for expected failures", () => {
    const path = databasePath();

    expect(() => startTask("missing-task", path)).toThrow(TaskDomainError);
  });
});
