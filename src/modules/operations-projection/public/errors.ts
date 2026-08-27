export type OperationsProjectionErrorCode =
  | "INVALID_INPUT"
  | "MEMORY_INDEX_CONFIRMATION_REQUIRED"
  | "MEMORY_INDEX_OPERATION_CONFLICT"
  | "MEMORY_INDEX_VERSION_CONFLICT"
  | "PROJECT_NOT_FOUND"
  | "THREAD_NOT_FOUND"
  | "EXPORT_TOO_LARGE"
  | "PROJECTION_CHECKPOINT_CORRUPT"
  | "PROJECTION_REBUILD_INCOMPLETE"
  | "PROJECTION_REBUILD_IN_PROGRESS";

export class OperationsProjectionError extends Error {
  constructor(
    public readonly code: OperationsProjectionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "OperationsProjectionError";
  }
}
