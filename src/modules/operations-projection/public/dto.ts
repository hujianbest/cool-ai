export type {
  AuditEventListItemDto,
  AuditProjectionFreshness,
  AuditProjectionFreshnessStatus,
  ProjectAuditEventsPageDto,
  ProjectTimelinePageDto,
  TimelineEventItemDto,
} from "@/src/shared/audit-contracts";

export type {
  ProjectThreadSearchPageDto,
  ThreadSearchResultItemDto,
  ThreadSearchResultKind,
} from "@/src/shared/thread-search-contracts";

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

export interface ThreadSearchIndexCatchUpResult {
  /** Newly inserted index rows (title + message rows; replayed duplicates excluded). */
  applied: number;
  /** Non-empty replay batches committed during this run. */
  batches: number;
  /** Checkpoint position after the run. */
  lastOutboxSeq: number;
}

export interface ThreadSearchIndexRebuildResult {
  lastOutboxSeq: number;
  /** Index rows after the rebuild (thread titles + event-sourced message rows). */
  replayed: number;
}
