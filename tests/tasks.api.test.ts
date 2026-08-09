import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  GET as getProjectTasks,
  POST as postProjectTask,
} from "@/app/api/projects/[projectId]/tasks/route";
import { POST as executeProjectTask } from "@/app/api/tasks/[taskId]/execute/route";
import { POST as startProjectTask } from "@/app/api/tasks/[taskId]/start/route";
import { createProject } from "@/src/adapters/outbound/sqlite/project-workspace/projects";
import { executeTaskResponse } from "@/src/server/task-api";
import { createTask, startTask } from "@/src/adapters/outbound/sqlite/mission-work/tasks";

let directory: string;
let path: string;

function projectContext(projectId: string) {
  return { params: Promise.resolve({ projectId }) };
}

function taskContext(taskId: string) {
  return { params: Promise.resolve({ taskId }) };
}

function jsonRequest(url: string, body: string) {
  return new Request(url, {
    body,
    headers: { "content-type": "application/json" },
    method: "POST",
  });
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cockpit-task-api-"));
  path = join(directory, "cockpit.sqlite");
  process.env.COCKPIT_DB_PATH = path;
});

afterEach(() => {
  delete process.env.COCKPIT_DB_PATH;
  rmSync(directory, { force: true, recursive: true });
});

describe("task API contract", () => {
  it("creates, starts, executes, and reloads a task with ordered events", async () => {
    const project = createProject("Launch plan", path);
    const createdResponse = await postProjectTask(
      jsonRequest(
        `http://localhost/api/projects/${project.id}/tasks`,
        JSON.stringify({ goal: "Prepare launch notes" }),
      ),
      projectContext(project.id),
    );

    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json();
    expect(created.events.map((event: { status: string }) => event.status)).toEqual(["queued"]);

    const startedResponse = await startProjectTask(
      new Request(`http://localhost/api/tasks/${created.task.id}/start`, { method: "POST" }),
      taskContext(created.task.id),
    );
    expect(startedResponse.status).toBe(200);

    const executedResponse = await executeProjectTask(
      new Request(`http://localhost/api/tasks/${created.task.id}/execute`, { method: "POST" }),
      taskContext(created.task.id),
    );
    expect(executedResponse.status).toBe(200);
    const executed = await executedResponse.json();
    expect(executed.task.status).toBe("completed");
    expect(executed.events.map((event: { sequence: number }) => event.sequence)).toEqual([1, 2, 3]);

    const loadedResponse = await getProjectTasks(
      new Request(`http://localhost/api/projects/${project.id}/tasks`),
      projectContext(project.id),
    );
    expect(loadedResponse.status).toBe(200);
    await expect(loadedResponse.json()).resolves.toEqual({
      tasks: [executed.task],
      events: executed.events,
    });
  });

  it.each([
    ["{", "INVALID_JSON"],
    [JSON.stringify({ goal: 42 }), "INVALID_INPUT"],
    [JSON.stringify({ goal: "  " }), "EMPTY_GOAL"],
  ])("returns 400 for invalid task input %#", async (body, code) => {
    const project = createProject("Launch plan", path);

    const response = await postProjectTask(
      jsonRequest(`http://localhost/api/projects/${project.id}/tasks`, body),
      projectContext(project.id),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code } });
  });

  it("returns stable 404 contracts for missing projects and tasks", async () => {
    const projectResponse = await getProjectTasks(
      new Request("http://localhost/api/projects/missing/tasks"),
      projectContext("missing"),
    );
    const taskResponse = await startProjectTask(
      new Request("http://localhost/api/tasks/missing/start", { method: "POST" }),
      taskContext("missing"),
    );

    expect(projectResponse.status).toBe(404);
    await expect(projectResponse.json()).resolves.toMatchObject({
      error: { code: "PROJECT_NOT_FOUND" },
    });
    expect(taskResponse.status).toBe(404);
    await expect(taskResponse.json()).resolves.toMatchObject({
      error: { code: "TASK_NOT_FOUND" },
    });
  });

  it("returns stable 409 contracts for illegal transitions", async () => {
    const project = createProject("Launch plan", path);
    const created = createTask(project.id, "Prepare launch notes", path);

    const executeQueued = await executeProjectTask(
      new Request(`http://localhost/api/tasks/${created.task.id}/execute`, { method: "POST" }),
      taskContext(created.task.id),
    );
    expect(executeQueued.status).toBe(409);
    await expect(executeQueued.json()).resolves.toMatchObject({
      error: { code: "TASK_NOT_EXECUTABLE" },
    });

    startTask(created.task.id, path);
    const startAgain = await startProjectTask(
      new Request(`http://localhost/api/tasks/${created.task.id}/start`, { method: "POST" }),
      taskContext(created.task.id),
    );
    expect(startAgain.status).toBe(409);
    await expect(startAgain.json()).resolves.toMatchObject({
      error: { code: "TASK_NOT_STARTABLE" },
    });
  });

  it("returns a persisted failed task and event when execution throws", async () => {
    const project = createProject("Launch plan", path);
    const created = createTask(project.id, "Prepare launch notes", path);
    startTask(created.task.id, path);

    const failedResponse = await executeTaskResponse(taskContext(created.task.id), () => {
      throw new Error("provider offline");
    });

    expect(failedResponse.status).toBe(500);
    const failed = await failedResponse.json();
    expect(failed).toMatchObject({
      task: { status: "failed", error: "provider offline" },
      error: { code: "TASK_EXECUTION_FAILED", message: "provider offline" },
    });
    expect(failed.events.map((event: { status: string }) => event.status)).toEqual([
      "queued",
      "running",
      "failed",
    ]);

    const loadedResponse = await getProjectTasks(
      new Request(`http://localhost/api/projects/${project.id}/tasks`),
      projectContext(project.id),
    );
    const loaded = await loadedResponse.json();
    expect(loaded.tasks).toEqual([failed.task]);
    expect(loaded.events).toEqual(failed.events);
  });

  it("returns STORAGE_UNAVAILABLE when SQLite cannot open the configured path", async () => {
    process.env.COCKPIT_DB_PATH = directory;

    const response = await getProjectTasks(
      new Request("http://localhost/api/projects/any/tasks"),
      projectContext("any"),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "STORAGE_UNAVAILABLE" },
    });
  });
});
