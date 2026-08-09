import { join } from "node:path";

import {
  internalErrorResponse,
  storageErrorResponse,
} from "@/src/server/api-errors";
import type { TaskExecutor } from "@/src/modules/mission-work";
import {
  TaskDomainError,
  TaskExecutionError,
} from "@/src/modules/mission-work";
import {
  createTask,
  executeTask,
  listProjectTasks,
  startTask,
} from "@/src/adapters/outbound/sqlite/mission-work/tasks";

export type RouteContext<Key extends string> = {
  params: Promise<Record<Key, string>>;
};

function databasePath(): string {
  return process.env.COCKPIT_DB_PATH ?? join(process.cwd(), ".data", "cockpit.sqlite");
}

function taskErrorResponse(error: unknown, route: string): Response {
  if (error instanceof TaskExecutionError) {
    return Response.json(error.response, { status: 500 });
  }

  if (error instanceof TaskDomainError) {
    const status =
      error.code === "EMPTY_GOAL"
        ? 400
        : error.code === "PROJECT_NOT_FOUND" || error.code === "TASK_NOT_FOUND"
          ? 404
          : 409;
    return Response.json(
      { error: { code: error.code, message: error.message } },
      { status },
    );
  }

  return storageErrorResponse(error) ?? internalErrorResponse(route);
}

export async function getProjectTasksResponse(
  context: RouteContext<"projectId">,
): Promise<Response> {
  try {
    const { projectId } = await context.params;
    return Response.json(listProjectTasks(projectId, databasePath()));
  } catch (error) {
    return taskErrorResponse(error, "GET /api/projects/:projectId/tasks");
  }
}

export async function createTaskResponse(
  request: Request,
  context: RouteContext<"projectId">,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: { code: "INVALID_JSON", message: "Request body must be valid JSON." } },
      { status: 400 },
    );
  }

  if (!body || typeof body !== "object" || typeof (body as { goal?: unknown }).goal !== "string") {
    return Response.json(
      { error: { code: "INVALID_INPUT", message: "Task goal must be a string." } },
      { status: 400 },
    );
  }

  try {
    const { projectId } = await context.params;
    const response = createTask(projectId, (body as { goal: string }).goal, databasePath());
    return Response.json(response, { status: 201 });
  } catch (error) {
    return taskErrorResponse(error, "POST /api/projects/:projectId/tasks");
  }
}

export async function startTaskResponse(
  context: RouteContext<"taskId">,
): Promise<Response> {
  try {
    const { taskId } = await context.params;
    return Response.json(startTask(taskId, databasePath()));
  } catch (error) {
    return taskErrorResponse(error, "POST /api/tasks/:taskId/start");
  }
}

export async function executeTaskResponse(
  context: RouteContext<"taskId">,
  executor?: TaskExecutor,
): Promise<Response> {
  try {
    const { taskId } = await context.params;
    return Response.json(executeTask(taskId, databasePath(), executor));
  } catch (error) {
    return taskErrorResponse(error, "POST /api/tasks/:taskId/execute");
  }
}
