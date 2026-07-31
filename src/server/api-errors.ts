import { randomUUID } from "node:crypto";

export function storageErrorResponse(error: unknown): Response | null {
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code: unknown }).code)
      : "";
  const message = error instanceof Error ? error.message : "";
  const storageFailure =
    /^(EACCES|EISDIR|ENOENT|ENOSPC|EPERM|EROFS|ERR_SQLITE)/.test(code) ||
    /database|disk|directory|readonly|sqlite/i.test(message);

  if (storageFailure) {
    return Response.json(
      {
        error: {
          code: "STORAGE_UNAVAILABLE",
          message: "Storage is unavailable.",
        },
      },
      { status: 503 },
    );
  }
  return null;
}

export function internalErrorResponse(route: string): Response {
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
