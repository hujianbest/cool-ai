import type { DatabaseSync } from "node:sqlite";

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { OperationsProjectionError } from "@/src/modules/operations-projection";
import type {
  ThreadSearchIndexCatchUpResult,
  ThreadSearchIndexRebuildResult,
} from "@/src/modules/operations-projection";
import { upsertAuditCheckpoint } from "./audit-projection-store";
import {
  clearThreadSearchIndex,
  insertAllThreadSearchTitleRows,
  insertThreadSearchMessageRow,
  insertThreadSearchTitleRow,
} from "./thread-search-index-store";

export const THREAD_SEARCH_INDEX_CONSUMER_ID = "thread-search-index";

const CATCH_UP_BATCH_SIZE = 500;
const COLLABORATION_SOURCE = "public_collaboration";
const MESSAGE_EVENT_TYPES: ReadonlySet<string> = new Set([
  "agent_message",
  "owner_message",
]);

type CheckpointRow = {
  lastOutboxSeq: number;
  status: "idle" | "rebuilding";
};

type OutboxRow = {
  eventType: string;
  outboxSeq: number;
  payloadJson: string;
  projectId: string;
  source: string;
};

function readCheckpoint(database: DatabaseSync): CheckpointRow | null {
  const row = database.prepare(`
    SELECT last_outbox_seq AS lastOutboxSeq, status
    FROM audit_projection_checkpoints
    WHERE consumer_id=?
  `).get(THREAD_SEARCH_INDEX_CONSUMER_ID) as
    | { lastOutboxSeq: number; status: "idle" | "rebuilding" }
    | undefined;
  return row ?? null;
}

function maxOutboxSeq(database: DatabaseSync): number {
  return (database.prepare(
    "SELECT COALESCE(MAX(outbox_seq),0) AS maxSeq FROM audit_event_outbox",
  ).get() as { maxSeq: number }).maxSeq;
}

function transaction<T>(database: DatabaseSync, operation: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  }
}

function selectOutboxBatch(
  database: DatabaseSync,
  afterSeq: number,
  limit: number,
): OutboxRow[] {
  return database.prepare(`
    SELECT outbox_seq AS outboxSeq, project_id AS projectId, source,
           event_type AS eventType, payload_json AS payloadJson
    FROM audit_event_outbox
    WHERE outbox_seq > ?
    ORDER BY outbox_seq
    LIMIT ?
  `).all(afterSeq, limit) as unknown as OutboxRow[];
}

// Every collaboration event carries threadId (030 payload contract), so any of
// them is a title hint; message events additionally index the persisted body.
// Malformed payloads degrade to a skipped row instead of failing the batch —
// the outbox row stays the source of truth.
function applyOutboxRow(database: DatabaseSync, row: OutboxRow): number {
  if (row.source !== COLLABORATION_SOURCE) return 0;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.payloadJson);
  } catch {
    return 0;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return 0;
  const payload = parsed as Record<string, unknown>;
  const threadId = typeof payload.threadId === "string" ? payload.threadId : null;
  if (threadId === null) return 0;
  let applied = insertThreadSearchTitleRow(database, {
    projectId: row.projectId,
    threadId,
  });
  if (MESSAGE_EVENT_TYPES.has(row.eventType)) {
    const messageId = payload.messageId;
    if (typeof messageId === "string") {
      applied += insertThreadSearchMessageRow(database, {
        messageId,
        projectId: row.projectId,
        sourceSeq: row.outboxSeq,
        threadId,
      });
    }
  }
  return applied;
}

function requireCatchUpAllowed(
  checkpoint: CheckpointRow | null,
  maxSeq: number,
): void {
  if (checkpoint?.status === "rebuilding") {
    throw new OperationsProjectionError(
      "PROJECTION_REBUILD_IN_PROGRESS",
      "Thread search index is rebuilding.",
    );
  }
  if (checkpoint !== null && checkpoint.lastOutboxSeq > maxSeq) {
    // Reopen invariants already fail-close this drift at open; this in-transaction
    // check is defense in depth. Recovery is an explicit rebuild, never a silent
    // checkpoint rewind.
    throw new OperationsProjectionError(
      "PROJECTION_CHECKPOINT_CORRUPT",
      "Thread search index checkpoint is corrupt.",
    );
  }
}

/**
 * Idempotent catch-up (feature 031 T-01, same protocol as the 028 audit
 * consumer): each batch commits applied rows and the advanced checkpoint in
 * one transaction, so an interrupted run resumes from the last batch boundary
 * and replays dedupe on the index constraints.
 */
export function catchUpThreadSearchIndex(
  databasePath: string,
): ThreadSearchIndexCatchUpResult {
  const database = openDatabase(databasePath);
  try {
    let applied = 0;
    let batches = 0;
    let lastOutboxSeq = 0;
    for (;;) {
      const batch = transaction(database, () => {
        const checkpoint = readCheckpoint(database);
        const maxSeq = maxOutboxSeq(database);
        requireCatchUpAllowed(checkpoint, maxSeq);
        const last = checkpoint?.lastOutboxSeq ?? 0;
        const rows = selectOutboxBatch(database, last, CATCH_UP_BATCH_SIZE);
        if (rows.length === 0) {
          if (checkpoint === null) {
            upsertAuditCheckpoint(database, {
              consumerId: THREAD_SEARCH_INDEX_CONSUMER_ID,
              lastOutboxSeq: 0,
              status: "idle",
            });
          }
          return { applied: 0, lastOutboxSeq: last, scanned: 0 };
        }
        let batchApplied = 0;
        for (const row of rows) {
          batchApplied += applyOutboxRow(database, row);
        }
        const batchLast = rows[rows.length - 1].outboxSeq;
        upsertAuditCheckpoint(database, {
          consumerId: THREAD_SEARCH_INDEX_CONSUMER_ID,
          lastOutboxSeq: batchLast,
          status: "idle",
        });
        return { applied: batchApplied, lastOutboxSeq: batchLast, scanned: rows.length };
      });
      if (batch.scanned === 0) {
        lastOutboxSeq = batch.lastOutboxSeq;
        break;
      }
      applied += batch.applied;
      batches += 1;
      lastOutboxSeq = batch.lastOutboxSeq;
    }
    return { applied, batches, lastOutboxSeq };
  } finally {
    database.close();
  }
}

/**
 * Deterministic rebuild in a single transaction (same claim protocol as the
 * 028 audit rebuild): clear the index, insert one title row per thread from a
 * full collaboration_threads scan, then replay the whole outbox in seq order.
 * Post-conditions pin the derived set exactly: title rows == thread count and
 * message rows == the distinct message keys resolved during the replay; any
 * mismatch rolls the transaction back.
 */
export function rebuildThreadSearchIndex(
  databasePath: string,
): ThreadSearchIndexRebuildResult {
  const database = openDatabase(databasePath);
  try {
    return transaction(database, () => {
      const now = new Date().toISOString();
      const claimed = database.prepare(`
        UPDATE audit_projection_checkpoints
        SET status='rebuilding', updated_at=?
        WHERE consumer_id=? AND status='idle'
      `).run(now, THREAD_SEARCH_INDEX_CONSUMER_ID).changes;
      if (claimed === 0) {
        if (readCheckpoint(database) !== null) {
          throw new OperationsProjectionError(
            "PROJECTION_REBUILD_IN_PROGRESS",
            "Thread search index is rebuilding.",
          );
        }
        database.prepare(`
          INSERT INTO audit_projection_checkpoints (
            consumer_id,last_outbox_seq,status,updated_at
          ) VALUES (?,0,'rebuilding',?)
        `).run(THREAD_SEARCH_INDEX_CONSUMER_ID, now);
      }
      clearThreadSearchIndex(database);
      insertAllThreadSearchTitleRows(database);
      let lastOutboxSeq = 0;
      const messageKeys = new Set<string>();
      for (;;) {
        const rows = selectOutboxBatch(database, lastOutboxSeq, CATCH_UP_BATCH_SIZE);
        if (rows.length === 0) break;
        for (const row of rows) {
          if (
            row.source === COLLABORATION_SOURCE
            && MESSAGE_EVENT_TYPES.has(row.eventType)
          ) {
            let parsed: unknown;
            try {
              parsed = JSON.parse(row.payloadJson);
            } catch {
              continue;
            }
            if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
              continue;
            }
            const payload = parsed as Record<string, unknown>;
            const threadId = typeof payload.threadId === "string" ? payload.threadId : null;
            const messageId = typeof payload.messageId === "string" ? payload.messageId : null;
            if (threadId === null || messageId === null) continue;
            const inserted = insertThreadSearchMessageRow(database, {
              messageId,
              projectId: row.projectId,
              sourceSeq: row.outboxSeq,
              threadId,
            });
            if (inserted === 1) {
              messageKeys.add(JSON.stringify([row.projectId, threadId, messageId]));
            }
          }
        }
        lastOutboxSeq = rows[rows.length - 1].outboxSeq;
      }
      const titles = (database.prepare(
        "SELECT COUNT(*) AS count FROM thread_search_index WHERE kind='thread_title'",
      ).get() as { count: number }).count;
      const threadCount = (database.prepare(
        "SELECT COUNT(*) AS count FROM collaboration_threads",
      ).get() as { count: number }).count;
      const messages = (database.prepare(
        "SELECT COUNT(*) AS count FROM thread_search_index WHERE kind='message'",
      ).get() as { count: number }).count;
      if (titles !== threadCount || messages !== messageKeys.size) {
        // Deterministic post-condition: after a full rebuild the index is
        // exactly titles ∪ event-sourced messages; anything else rolls back.
        throw new OperationsProjectionError(
          "PROJECTION_REBUILD_INCOMPLETE",
          "Thread search index rebuild is incomplete.",
        );
      }
      upsertAuditCheckpoint(database, {
        consumerId: THREAD_SEARCH_INDEX_CONSUMER_ID,
        lastOutboxSeq,
        status: "idle",
      });
      return { lastOutboxSeq, replayed: titles + messages };
    });
  } finally {
    database.close();
  }
}
