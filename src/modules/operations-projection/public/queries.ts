import type {
  AuditProjectionFreshness,
  ProjectAuditEventsPageDto,
} from "./dto";

export interface ListProjectAuditEventsOptions {
  /** Exclusive cursor: only events with outbox_seq < beforeSeq are returned. */
  beforeSeq?: number;
  /** Page size; defaults to 50, capped at 100. */
  limit?: number;
}

export interface OperationsProjectionQueries {
  getAuditProjectionFreshness: (databasePath: string) => AuditProjectionFreshness;
  /**
   * Newest-first audit page for one project. The MVP read path synchronously
   * catches the projection up before reading (no background daemon), so the
   * embedded freshness is normally caught_up; a claimed rebuild fails closed
   * instead of serving a partial list.
   */
  listProjectAuditEvents: (
    databasePath: string,
    projectId: string,
    options?: ListProjectAuditEventsOptions,
  ) => ProjectAuditEventsPageDto;
}
