import type { DatabaseSync } from "node:sqlite";

// Write anchor for the thread_search_index projection (feature 031 T-01).
// All inserts are INSERT OR IGNORE against the dedupe constraints
// (UNIQUE(project_id,thread_id,kind,message_id) plus the thread_search_one_title
// partial unique index), so replays of an already-applied window are safe.
// Indexed text is the already-persisted public surface: thread titles and
// collaboration_messages bodies; the projection never writes back to sources.

export function insertThreadSearchTitleRow(
  database: DatabaseSync,
  input: { projectId: string; threadId: string },
): number {
  return Number(database.prepare(`
    INSERT OR IGNORE INTO thread_search_index(
      project_id,thread_id,kind,message_id,content,occurred_at,source_seq
    )
    SELECT project_id,id,'thread_title',NULL,title,created_at,0
    FROM collaboration_threads
    WHERE project_id=? AND id=?
  `).run(input.projectId, input.threadId).changes);
}

export function insertThreadSearchMessageRow(
  database: DatabaseSync,
  input: {
    messageId: string;
    projectId: string;
    sourceSeq: number;
    threadId: string;
  },
): number {
  return Number(database.prepare(`
    INSERT OR IGNORE INTO thread_search_index(
      project_id,thread_id,kind,message_id,content,occurred_at,source_seq
    )
    SELECT project_id,thread_id,'message',id,content,created_at,?
    FROM collaboration_messages
    WHERE project_id=? AND thread_id=? AND id=?
  `).run(input.sourceSeq, input.projectId, input.threadId, input.messageId).changes);
}

export function insertAllThreadSearchTitleRows(database: DatabaseSync): number {
  return Number(database.prepare(`
    INSERT OR IGNORE INTO thread_search_index(
      project_id,thread_id,kind,message_id,content,occurred_at,source_seq
    )
    SELECT project_id,id,'thread_title',NULL,title,created_at,0
    FROM collaboration_threads
  `).run().changes);
}

export function clearThreadSearchIndex(database: DatabaseSync): void {
  database.exec("DELETE FROM thread_search_index");
}

export function deleteThreadSearchIndexRowsTx(
  database: DatabaseSync,
  input: { projectId: string; threadId: string },
): number {
  return Number(database.prepare(
    `DELETE FROM thread_search_index
     WHERE project_id=? AND thread_id=?`,
  ).run(input.projectId, input.threadId).changes);
}
