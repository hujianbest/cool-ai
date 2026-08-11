import type { DatabaseSync } from "node:sqlite";

import { CollaborationError } from "@/src/modules/public-collaboration";

/**
 * Feature 033: thread-level seams never see soft-deleted threads. A tuple
 * that exists with deleted_at NOT NULL fails closed with the thread_deleted
 * reason marker; a missing or cross-project tuple keeps the plain unmarked
 * 404 so the deletion state never leaks across project boundaries.
 */
export function threadDeletedNotFound(): never {
  throw new CollaborationError(
    "RESOURCE_NOT_FOUND",
    404,
    "Resource was not found.",
    { reason: "thread_deleted" },
  );
}

export function ensureActiveThread(
  database: DatabaseSync,
  projectId: string,
  threadId: string,
): void {
  const row = database
    .prepare(
      `SELECT deleted_at AS deletedAt
       FROM collaboration_threads
       WHERE project_id=? AND id=?`,
    )
    .get(projectId, threadId) as { deletedAt: string | null } | undefined;
  if (row === undefined) {
    throw new CollaborationError(
      "RESOURCE_NOT_FOUND",
      404,
      "Resource was not found.",
    );
  }
  if (row.deletedAt !== null) {
    threadDeletedNotFound();
  }
}
