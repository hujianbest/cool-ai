/**
 * safe-execution 公开稳定错误面（T-09 自 src/server/execution/ 各实现文件原样提取）。
 * 类定义逐字保持原实现；含 SQL/工作区逻辑的实现文件改从本模块 import 并就地 re-export，
 * 以维持既有 `instanceof` 与命名空间访问的兼容。
 */
export class ExecutionError extends Error {
  constructor(
    public readonly code: string,
    public readonly httpStatus: number,
    message: string,
  ) {
    super(message);
    this.name = "ExecutionError";
  }
}

export class CommandRequestError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly currentVersion?: number,
  ) {
    super(message);
    this.name = "CommandRequestError";
  }
}

export class SandboxListError extends Error {
  constructor(
    public readonly code: "SANDBOX_UNVERIFIABLE" | "SPECIAL_FILE_REJECTED",
    message: string,
  ) {
    super(message);
    this.name = "SandboxListError";
  }
}

export class SandboxReadError extends Error {
  constructor(
    public readonly code:
      | "FILE_LIMIT_EXCEEDED"
      | "SANDBOX_UNVERIFIABLE"
      | "SPECIAL_FILE_REJECTED"
      | "TEXT_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "SandboxReadError";
  }
}

export class SandboxWriteError extends Error {
  constructor(
    public readonly code:
      | "FILE_LIMIT_EXCEEDED"
      | "SANDBOX_FILE_CONFLICT"
      | "SANDBOX_UNVERIFIABLE"
      | "SPECIAL_FILE_REJECTED"
      | "TEXT_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "SandboxWriteError";
  }
}

export class PathGuardError extends Error {
  readonly code = "PATH_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "PathGuardError";
  }
}

export class SandboxPreflightError extends Error {
  constructor(
    public readonly code:
      | "SANDBOX_LIMIT_EXCEEDED"
      | "SANDBOX_ROOT_INTERSECTION"
      | "SANDBOX_UNVERIFIABLE"
      | "SPECIAL_FILE_REJECTED",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SandboxPreflightError";
  }
}

export class SandboxSnapshotError extends Error {
  constructor(
    public readonly code:
      | "SANDBOX_DESTINATION_EXISTS"
      | "SANDBOX_LIMIT_EXCEEDED"
      | "SANDBOX_SOURCE_MISMATCH"
      | "SANDBOX_UNVERIFIABLE",
    message: string,
  ) {
    super(message);
    this.name = "SandboxSnapshotError";
  }
}

export class WindowsNativeError extends Error {
  readonly code = "SANDBOX_UNVERIFIABLE" as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WindowsNativeError";
  }
}

export class WindowsNativeWriteFailure extends WindowsNativeError {
  constructor(
    public readonly mutationState:
      | "cleanup-confirmed"
      | "cleanup-unconfirmed"
      | "post-replace-unverifiable",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WindowsNativeWriteFailure";
  }
}
