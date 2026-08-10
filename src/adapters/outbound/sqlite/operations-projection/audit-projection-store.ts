import type { DatabaseSync } from "node:sqlite";

export type AuditProjectionRow = {
  actorType: string | null;
  eventType: string;
  executionId: string | null;
  id: string;
  occurredAt: string;
  outboxSeq: number;
  payloadJson: string;
  projectId: string;
  source: string;
};

// Idempotent replay primitive for the audit consumer (feature 028 T-02):
// replays dedupe on the UNIQUE outbox_seq, so re-processing a window is safe.
export function insertAuditProjectionRows(
  database: DatabaseSync,
  rows: readonly AuditProjectionRow[],
): number {
  const insert = database.prepare(`
    INSERT OR IGNORE INTO audit_event_projection (
      outbox_seq,id,project_id,source,event_type,actor_type,occurred_at,
      execution_id,payload_json
    ) VALUES (?,?,?,?,?,?,?,?,?)
  `);
  let applied = 0;
  for (const row of rows) {
    applied += Number(insert.run(
      row.outboxSeq,
      row.id,
      row.projectId,
      row.source,
      row.eventType,
      row.actorType,
      row.occurredAt,
      row.executionId,
      row.payloadJson,
    ).changes);
  }
  return applied;
}

export function upsertAuditCheckpoint(
  database: DatabaseSync,
  input: {
    consumerId: string;
    lastOutboxSeq: number;
    status: "idle" | "rebuilding";
  },
): void {
  database.prepare(`
    INSERT INTO audit_projection_checkpoints (
      consumer_id,last_outbox_seq,status,updated_at
    ) VALUES (?,?,?,?)
    ON CONFLICT(consumer_id) DO UPDATE SET
      last_outbox_seq=excluded.last_outbox_seq,
      status=excluded.status,
      updated_at=excluded.updated_at
  `).run(input.consumerId, input.lastOutboxSeq, input.status, new Date().toISOString());
}
