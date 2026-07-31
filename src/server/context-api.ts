import { randomUUID } from "node:crypto";

import { ContextSnapshotError } from "@/src/server/context-snapshot-service";
import { SchemaMigrationError } from "@/src/server/migrations";

export function contextApiError(error: unknown, route: string): Response {
  if (error instanceof ContextSnapshotError) {
    return Response.json(
      {
        error: {
          code: error.code,
          message: error.message,
          ...(error.missing ? { missing: error.missing } : {}),
        },
      },
      { status: error.httpStatus },
    );
  }
  if (error instanceof SchemaMigrationError) {
    return Response.json(
      { error: { code: error.code, message: error.message } },
      { status: 503 },
    );
  }
  const correlationId = randomUUID();
  console.error({ code: "INTERNAL_ERROR", correlationId, route });
  return Response.json(
    {
      error: {
        code: "INTERNAL_ERROR",
        correlationId,
        message: "An unexpected error occurred.",
      },
    },
    { status: 500 },
  );
}
