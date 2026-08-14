/**
 * Audit projection wire contracts (feature 028, CAP-OPS-02). Shared between the
 * operations-projection module, the inbound audit-events route, and the audit
 * panel UI (T-04), mirroring the ThreadListItemDto sinking precedent (A-122).
 * Self-contained: src/shared must not depend on any upper layer.
 */

export type AuditProjectionFreshnessStatus = "caught_up" | "behind" | "rebuilding";

export type AuditProjectionFreshness = {
  /** max(audit_event_outbox.outbox_seq) - checkpoint.last_outbox_seq. */
  lag: number;
  status: AuditProjectionFreshnessStatus;
};

export type AuditEventListItemDto = {
  actorType: string | null;
  eventType: string;
  executionId: string | null;
  id: string;
  occurredAt: string;
  outboxSeq: number;
  /** Source-owner whitelist payload, passed through byte-identical. */
  payload: Record<string, unknown>;
};

export type ProjectAuditEventsPageDto = {
  events: AuditEventListItemDto[];
  /** Embedded so the UI learns freshness without a second round-trip. */
  freshness: AuditProjectionFreshness;
  /** Exclusive cursor for the next (older) page; null when no more events. */
  nextBeforeSeq: number | null;
};

export type TimelineEventItemDto = AuditEventListItemDto & {
  /**
   * True when the payload has no locatable identity the audit panel would
   * link (A-330). The timeline must not fabricate an href.
   */
  sourceMissing: boolean;
};

export type ProjectTimelinePageDto = {
  /** Embedded so the UI learns freshness without a second round-trip. */
  freshness: AuditProjectionFreshness;
  items: TimelineEventItemDto[];
};
