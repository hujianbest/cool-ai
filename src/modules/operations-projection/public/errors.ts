export type OperationsProjectionErrorCode =
  | "INVALID_INPUT"
  | "PROJECT_NOT_FOUND"
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
