import type { DatabaseSync } from "node:sqlite";

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { OperationsProjectionError } from "@/src/modules/operations-projection";
import type {
  AuditProjectionCatchUpResult,
  AuditProjectionFreshness,
  AuditProjectionRebuildResult,
} from "@/src/modules/operations-projection";
import {
  insertAuditProjectionRows,
  upsertAuditCheckpoint,
  type AuditProjectionRow,
} from "./audit-projection-store";

export const AUDIT_PROJECTION_CONSUMER_ID = "audit-event-projection";

const CATCH_UP_BATCH_SIZE = 500;

type CheckpointRow = {
  lastOutboxSeq: number;
  status: "idle" | "rebuilding";
};

type OutboxRow = {
  eventType: string;
  id: string;
  occurredAt: string;
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
  `).get(AUDIT_PROJECTION_CONSUMER_ID) as
    | { lastOutboxSeq: number; status: "idle" | "rebuilding" }
    | undefined;
  return row ?? null;
}

function maxOutboxSeq(database: DatabaseSync): number {
  return (database.prepare(
    "SELECT COALESCE(MAX(outbox_seq),0) AS maxSeq FROM audit_event_outbox",
  ).get() as { maxSeq: number }).maxSeq;
}

// The projection columns are derived from the already-sanitized public payload
// (safe-execution whitelist); payload_json is stored byte-identical so replays
// are deterministic. Non-string extractions degrade to NULL instead of failing
// the batch — the outbox row stays the source of truth.
function toProjectionRow(row: OutboxRow): AuditProjectionRow {
  const parsed: unknown = JSON.parse(row.payloadJson);
  const payload = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
  return {
    actorType: typeof payload.actorType === "string" ? payload.actorType : null,
    eventType: row.eventType,
    executionId: typeof payload.executionId === "string" ? payload.executionId : null,
    id: row.id,
    occurredAt: row.occurredAt,
    outboxSeq: row.outboxSeq,
    payloadJson: row.payloadJson,
    projectId: row.projectId,
    source: row.source,
  };
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
    SELECT outbox_seq AS outboxSeq, id, project_id AS projectId,
           source, event_type AS eventType, occurred_at AS occurredAt,
           payload_json AS payloadJson
    FROM audit_event_outbox
    WHERE outbox_seq > ?
    ORDER BY outbox_seq
    LIMIT ?
  `).all(afterSeq, limit) as unknown as OutboxRow[];
}

function requireCatchUpAllowed(
  checkpoint: CheckpointRow | null,
  maxSeq: number,
): void {
  if (checkpoint?.status === "rebuilding") {
    throw new OperationsProjectionError(
      "PROJECTION_REBUILD_IN_PROGRESS",
      "Audit projection is rebuilding.",
    );
  }
  if (checkpoint !== null && checkpoint.lastOutboxSeq > maxSeq) {
    // Reopen invariants already fail-close this drift at open; this in-transaction
    // check is defense in depth. Recovery is an explicit rebuild, never a silent
    // checkpoint rewind.
    throw new OperationsProjectionError(
      "PROJECTION_CHECKPOINT_CORRUPT",
      "Audit projection checkpoint is corrupt.",
    );
  }
}

/**
 * Idempotent catch-up: each batch commits applied rows and the advanced
 * checkpoint in one transaction, so an interrupted run resumes from the last
 * batch boundary and replays dedupe on the UNIQUE outbox_seq.
 */
export function catchUpAuditProjection(
  databasePath: string,
): AuditProjectionCatchUpResult {
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
          // Uninitialized consumer self-heals its checkpoint row even when the
          // outbox is empty, so freshness can tell initialized from never-run.
          if (checkpoint === null) {
            upsertAuditCheckpoint(database, {
              consumerId: AUDIT_PROJECTION_CONSUMER_ID,
              lastOutboxSeq: 0,
              status: "idle",
            });
          }
          return { applied: 0, lastOutboxSeq: last, scanned: 0 };
        }
        const batchApplied = insertAuditProjectionRows(
          database,
          rows.map(toProjectionRow),
        );
        const batchLast = rows[rows.length - 1].outboxSeq;
        upsertAuditCheckpoint(database, {
          consumerId: AUDIT_PROJECTION_CONSUMER_ID,
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
 * Deterministic rebuild in a single transaction: claim the consumer with a
 * status CAS (idle→rebuilding, missing row created claimed), clear the
 * projection, replay the whole outbox in seq order, then return to idle. Any
 * failure rolls the transaction back, so a rebuild never leaves a half-built
 * projection behind. The persisted `rebuilding` state is only ever produced
 * externally (a crashed future daemon); this single-transaction rebuild never
 * commits it, and MVP offers no automatic take-over for it.
 */
export function rebuildAuditProjection(
  databasePath: string,
): AuditProjectionRebuildResult {
  const database = openDatabase(databasePath);
  try {
    return transaction(database, () => {
      const now = new Date().toISOString();
      const claimed = database.prepare(`
        UPDATE audit_projection_checkpoints
        SET status='rebuilding', updated_at=?
        WHERE consumer_id=? AND status='idle'
      `).run(now, AUDIT_PROJECTION_CONSUMER_ID).changes;
      if (claimed === 0) {
        if (readCheckpoint(database) !== null) {
          throw new OperationsProjectionError(
            "PROJECTION_REBUILD_IN_PROGRESS",
            "Audit projection is rebuilding.",
          );
        }
        database.prepare(`
          INSERT INTO audit_projection_checkpoints (
            consumer_id,last_outbox_seq,status,updated_at
          ) VALUES (?,0,'rebuilding',?)
        `).run(AUDIT_PROJECTION_CONSUMER_ID, now);
      }
      database.exec("DELETE FROM audit_event_projection");
      let scanned = 0;
      let lastOutboxSeq = 0;
      for (;;) {
        const rows = selectOutboxBatch(database, lastOutboxSeq, CATCH_UP_BATCH_SIZE);
        if (rows.length === 0) break;
        insertAuditProjectionRows(database, rows.map(toProjectionRow));
        scanned += rows.length;
        lastOutboxSeq = rows[rows.length - 1].outboxSeq;
      }
      const projected = (database.prepare(
        "SELECT COUNT(*) AS count FROM audit_event_projection",
      ).get() as { count: number }).count;
      if (projected !== scanned) {
        // Deterministic post-condition: after a full replay the projection is
        // exactly the outbox set; anything else rolls the rebuild back.
        throw new OperationsProjectionError(
          "PROJECTION_REBUILD_INCOMPLETE",
          "Audit projection rebuild is incomplete.",
        );
      }
      upsertAuditCheckpoint(database, {
        consumerId: AUDIT_PROJECTION_CONSUMER_ID,
        lastOutboxSeq,
        status: "idle",
      });
      return { lastOutboxSeq, replayed: scanned };
    });
  } finally {
    database.close();
  }
}

/**
 * Freshness snapshot on an already-open connection, so the audit query can
 * read the page and the freshness in one consistent transaction.
 */
export function readAuditProjectionFreshness(
  database: DatabaseSync,
): AuditProjectionFreshness {
  const maxSeq = maxOutboxSeq(database);
  const checkpoint = readCheckpoint(database);
  if (checkpoint !== null && checkpoint.lastOutboxSeq > maxSeq) {
    throw new OperationsProjectionError(
      "PROJECTION_CHECKPOINT_CORRUPT",
      "Audit projection checkpoint is corrupt.",
    );
  }
  if (checkpoint === null) {
    // Never initialized: the whole backlog is pending.
    return { lag: maxSeq, status: maxSeq === 0 ? "caught_up" : "behind" };
  }
  const lag = maxSeq - checkpoint.lastOutboxSeq;
  if (checkpoint.status === "rebuilding") {
    return { lag, status: "rebuilding" };
  }
  return { lag, status: lag === 0 ? "caught_up" : "behind" };
}

export function getAuditProjectionFreshness(
  databasePath: string,
): AuditProjectionFreshness {
  const database = openDatabase(databasePath);
  try {
    database.exec("BEGIN");
    try {
      const freshness = readAuditProjectionFreshness(database);
      database.exec("COMMIT");
      return freshness;
    } catch (error) {
      if (database.isTransaction) database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
}
