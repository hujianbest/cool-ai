export type Project = {
  id: string;
  name: string;
  createdAt: string;
};

export type ApiError = {
  error: {
    code: string;
    message: string;
    category?: string;
    fields?: Record<string, string>;
    currentVersion?: number;
    correlationId?: string;
  };
};

export type TaskStatus = "queued" | "running" | "completed" | "failed";

export type TaskRun = {
  id: string;
  projectId: string;
  goal: string;
  status: TaskStatus;
  result: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

export type TaskEvent = {
  id: string;
  taskId: string;
  sequence: number;
  status: TaskStatus;
  message: string;
  createdAt: string;
};

export type TaskStateResponse = {
  task: TaskRun;
  events: TaskEvent[];
};

export type TaskFailureResponse = TaskStateResponse & {
  error: {
    code: "TASK_EXECUTION_FAILED";
    message: string;
  };
};
