import { randomUUID } from "node:crypto";

import { ContextSnapshotError } from "@/src/server/context-snapshot-service";
import { SchemaError } from "@/src/adapters/outbound/sqlite/schema-error";

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
  if (error instanceof SchemaError) {
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
