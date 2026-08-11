import type { DatabaseSync } from "node:sqlite";

/**
 * Feature 033 anchor writer for thread_purge_markers. Markers are
 * transaction-local exemption tokens for the three thread no_delete triggers:
 * the purge command inserts a marker at transaction start and deletes it
 * before commit, so a marker visible in a consistent snapshot fails the
 * reopen data invariant.
 */
export function insertThreadPurgeMarkerTx(
  database: DatabaseSync,
  projectId: string,
  threadId: string,
  now: string,
): void {
  database
    .prepare(
      `INSERT INTO thread_purge_markers(project_id,thread_id,created_at)
       VALUES (?,?,?)`,
    )
    .run(projectId, threadId, now);
}

export function deleteThreadPurgeMarkerTx(
  database: DatabaseSync,
  projectId: string,
  threadId: string,
): void {
  database
    .prepare(
      "DELETE FROM thread_purge_markers WHERE project_id=? AND thread_id=?",
    )
    .run(projectId, threadId);
}
