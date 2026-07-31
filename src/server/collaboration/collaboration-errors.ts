import type {
  CollaborationApiError,
  CollaborationErrorCode,
  RunErrorCategory,
} from "@/src/shared/collaboration-contracts";

export class CollaborationError extends Error {
  constructor(
    public readonly code: CollaborationErrorCode,
    public readonly httpStatus: number,
    message: string,
    public readonly details: {
      category?: RunErrorCategory;
      fields?: Record<string, string>;
      currentVersion?: number;
      missing?: Array<"participants" | "tasks" | "claim">;
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
      ...(error.details.category ? { category: error.details.category } : {}),
      ...(error.details.fields ? { fields: error.details.fields } : {}),
      ...(error.details.currentVersion !== undefined
        ? { currentVersion: error.details.currentVersion }
        : {}),
    },
  };
}
