export class MembershipError extends Error {
  constructor(
    public readonly code: string,
    public readonly httpStatus: number,
    message: string,
    public readonly fields?: Array<{ field: string; code: string }>,
    public readonly currentVersion?: number,
    public readonly agentIds?: string[],
  ) {
    super(message);
    this.name = "MembershipError";
  }
}

export type WorkspaceErrorCode =
  | "INVALID_INPUT"
  | "WORKSPACE_INVALID"
  | "PROJECT_NOT_FOUND"
  | "WORKSPACE_NOT_FOUND"
  | "WORKSPACE_NOT_DIRECTORY"
  | "WORKSPACE_NOT_READABLE"
  | "WORKSPACE_ALREADY_BOUND"
  | "REBIND_CONFIRMATION_REQUIRED"
  | "RESOURCE_CONFLICT"
  | "WORKSPACE_NOT_BOUND"
  | "WORKSPACE_ENTRY_NOT_FOUND"
  | "WORKSPACE_PATH_REJECTED"
  | "WORKSPACE_NOT_PREVIEWABLE"
  | "WORKSPACE_FILE_TOO_LARGE"
  | "WORKSPACE_BROWSE_UNAVAILABLE"
  | "WORKSPACE_NOT_EDITABLE"
  | "WORKSPACE_EDIT_NOT_FOUND";

export class WorkspaceError extends Error {
  constructor(
    public readonly code: WorkspaceErrorCode,
    message: string,
    public readonly fields?: Array<{ field: string; code: string }>,
    public readonly currentVersion?: number,
  ) {
    super(message);
    this.name = "WorkspaceError";
  }
}

export class ValidationPolicyError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly currentVersion?: number,
  ) {
    super(message);
    this.name = "ValidationPolicyError";
  }
}
