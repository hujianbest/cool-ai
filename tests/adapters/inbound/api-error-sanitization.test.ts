import { afterEach, describe, expect, it, vi } from "vitest";

const { sentinel } = vi.hoisted(() => ({
  sentinel:
    "SENSITIVE_SENTINEL api-key-token https://owner:secret@example.test/raw-body",
}));

vi.mock("@/src/adapters/outbound/sqlite/project-workspace/projects", () => ({
  createProject: () => {
    throw new Error(sentinel);
  },
  listProjects: () => {
    throw new Error(sentinel);
  },
}));

vi.mock("@/src/adapters/outbound/sqlite/mission-work/tasks", () => {
  class TaskDomainError extends Error {
    code = "DOMAIN";
  }
  class TaskExecutionError extends Error {
    response = { error: { code: "EXECUTION" } };
  }
  const fail = () => {
    throw new Error(sentinel);
  };
  return {
    createTask: fail,
    executeTask: fail,
    listProjectTasks: fail,
    startTask: fail,
    TaskDomainError,
    TaskExecutionError,
  };
});

import * as projectRoute from "@/app/api/projects/route";
import {
  createTaskResponse,
  executeTaskResponse,
  getProjectTasksResponse,
  startTaskResponse,
} from "@/app/api/_shared/task-api";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sanitized project and task fallback errors", () => {
  it("never returns or logs raw unknown project failures", async () => {
    const logged: unknown[] = [];
    vi.spyOn(console, "error").mockImplementation((value) => logged.push(value));

    const responses = [
      await projectRoute.GET(),
      await projectRoute.POST(
        new Request("http://localhost/api/projects", {
          body: JSON.stringify({ name: sentinel }),
          headers: { "content-type": "application/json" },
          method: "POST",
        }),
      ),
    ];

    for (const response of responses) {
      expect(response.status).toBe(500);
      expect(await response.text()).not.toContain(sentinel);
    }
    expect(logged).toHaveLength(2);
    for (const entry of logged) {
      expect(JSON.stringify(entry)).not.toContain(sentinel);
      expect(Object.keys(entry as object).sort()).toEqual([
        "code",
        "correlationId",
        "route",
      ]);
    }
    expect(logged).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ route: "GET /api/projects" }),
        expect.objectContaining({ route: "POST /api/projects" }),
      ]),
    );
  });

  it("never returns or logs raw unknown task failures on every route action", async () => {
    const logged: unknown[] = [];
    vi.spyOn(console, "error").mockImplementation((value) => logged.push(value));
    const projectContext = { params: Promise.resolve({ projectId: "project-1" }) };
    const taskContext = { params: Promise.resolve({ taskId: "task-1" }) };
    const responses = [
      await getProjectTasksResponse(projectContext),
      await createTaskResponse(
        new Request("http://localhost/api/projects/project-1/tasks", {
          body: JSON.stringify({ goal: sentinel }),
          headers: { "content-type": "application/json" },
          method: "POST",
        }),
        projectContext,
      ),
      await startTaskResponse(taskContext),
      await executeTaskResponse(taskContext),
    ];

    for (const response of responses) {
      expect(response.status).toBe(500);
      expect(await response.text()).not.toContain(sentinel);
    }
    expect(logged).toHaveLength(4);
    for (const entry of logged) {
      expect(JSON.stringify(entry)).not.toContain(sentinel);
      expect(Object.keys(entry as object).sort()).toEqual([
        "code",
        "correlationId",
        "route",
      ]);
    }
    expect(logged.map((entry) => (entry as { route: string }).route)).toEqual([
      "GET /api/projects/:projectId/tasks",
      "POST /api/projects/:projectId/tasks",
      "POST /api/tasks/:taskId/start",
      "POST /api/tasks/:taskId/execute",
    ]);
  });
});
