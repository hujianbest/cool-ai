import type { TaskFailureResponse } from "@/src/shared/contracts";

type FieldError = { field: string; code: string };

export class MissionError extends Error {
  constructor(
    public readonly code: string,
    public readonly httpStatus: number,
    message: string,
    public readonly fields?: FieldError[],
    public readonly currentVersion?: number,
  ) {
    super(message);
    this.name = "MissionError";
  }
}

export type TaskErrorCode =
  | "EMPTY_GOAL"
  | "PROJECT_NOT_FOUND"
  | "TASK_NOT_FOUND"
  | "TASK_NOT_STARTABLE"
  | "TASK_NOT_EXECUTABLE";

export class TaskDomainError extends Error {
  constructor(
    readonly code: TaskErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TaskDomainError";
  }
}

export class TaskExecutionError extends Error {
  constructor(readonly response: TaskFailureResponse) {
    super(response.error.message);
    this.name = "TaskExecutionError";
  }
}
