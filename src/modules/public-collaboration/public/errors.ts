import type {
  CollaborationApiError,
  CollaborationErrorCode,
  RunErrorCategory,
} from "@/src/shared/collaboration-contracts";

import type { PublicTextCredentialCategory } from "../internal/public-text-credential-classifier";

export class CollaborationError extends Error {
  constructor(
    public readonly code: CollaborationErrorCode,
    public readonly httpStatus: number,
    message: string,
    public readonly details: {
      activeRunId?: string;
      activeThreadId?: string;
      category?: RunErrorCategory;
      fields?: Record<string, string>;
      currentVersion?: number;
      missing?: Array<"participants" | "tasks" | "claim">;
      reason?: "thread_deleted";
    } = {},
  ) {
    super(message);
    this.name = "CollaborationError";
  }
}

export function collaborationErrorBody(
  error: CollaborationError,
): CollaborationApiError {
  return {
    error: {
      code: error.code,
      message: error.message,
      ...(error.details.activeThreadId
        ? { activeThreadId: error.details.activeThreadId }
        : {}),
      ...(error.details.activeRunId ? { activeRunId: error.details.activeRunId } : {}),
      ...(error.details.category ? { category: error.details.category } : {}),
      ...(error.details.fields ? { fields: error.details.fields } : {}),
      ...(error.details.currentVersion !== undefined
        ? { currentVersion: error.details.currentVersion }
        : {}),
      ...(error.details.reason ? { reason: error.details.reason } : {}),
    },
  };
}

export class StructuredMessageCodecError extends Error {
  constructor(
    readonly code:
      | "INVALID_JSON"
      | "DUPLICATE_KEY"
      | "INVALID_I_JSON"
      | "INVALID_SCHEMA"
      | "WIRE_TOO_LARGE"
      | "CANONICAL_TOO_LARGE"
      | "CREDENTIAL_CONTENT_REJECTED",
    readonly credentialCategory?: PublicTextCredentialCategory,
  ) {
    super(code);
  }
}
