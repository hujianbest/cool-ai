import type {
  AuditProjectionFreshness,
  ProjectAuditEventsPageDto,
  ProjectThreadSearchPageDto,
  ProjectTimelinePageDto,
} from "./dto";

export interface ListProjectAuditEventsOptions {
  /** Exclusive cursor: only events with outbox_seq < beforeSeq are returned. */
  beforeSeq?: number;
  /** Page size; defaults to 50, capped at 100. */
  limit?: number;
}

export interface ListProjectTimelineOptions {
  /** Page size; defaults to 50, capped at 100. First page only (A-333). */
  limit?: number;
  /** Exact payload.missionId match; events without the field are excluded. */
  missionId?: string;
}

export interface SearchProjectThreadsOptions {
  /** Exclusive opaque cursor from a previous page's nextCursor. */
  before?: string;
  /** Page size; defaults to 20, capped at 50. */
  limit?: number;
  /**
   * Required search term; trimmed, 1..200 graphemes, matched literally
   * (LIKE wildcards are not special) with ASCII case folding.
   */
  query: string;
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
  /**
   * Newest-first thread search page for one project (feature 031 T-02). The
   * read path synchronously catches the search index up before reading (same
   * MVP protocol as the audit projection), so a claimed rebuild fails closed
   * instead of serving a stale page. Results are project-scoped by
   * construction; an unknown project fails PROJECT_NOT_FOUND.
   */
  searchProjectThreads: (
    databasePath: string,
    projectId: string,
    options: SearchProjectThreadsOptions,
  ) => ProjectThreadSearchPageDto;
  /**
   * Oldest-first run timeline for one project (feature 047). Same catch-up
   * protocol as listProjectAuditEvents. First page + limit only (A-333).
   */
  listProjectTimeline: (
    databasePath: string,
    projectId: string,
    options?: ListProjectTimelineOptions,
  ) => ProjectTimelinePageDto;
}
