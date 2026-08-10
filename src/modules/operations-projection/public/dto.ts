export type {
  AuditEventListItemDto,
  AuditProjectionFreshness,
  AuditProjectionFreshnessStatus,
  ProjectAuditEventsPageDto,
} from "@/src/shared/audit-contracts";

export interface AuditProjectionCatchUpResult {
  /** Newly inserted projection rows (replayed duplicates excluded). */
  applied: number;
  /** Non-empty replay batches committed during this run. */
  batches: number;
  /** Checkpoint position after the run. */
  lastOutboxSeq: number;
}

export interface AuditProjectionRebuildResult {
  lastOutboxSeq: number;
  /** Projection rows after the full replay (== outbox row count). */
  replayed: number;
}
