import type { AuditEventListItemDto, TimelineEventItemDto } from "@/src/shared/audit-contracts";

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

export interface MemorySearchIndexCatchUpResult {
  active: number;
  /** Rows inserted, updated, or removed by this catch-up. */
  applied: number;
  indexed: number;
  /** Project-scoped index state version. */
  version: number;
}

export type MemoryIndexHealthStatus =
  | "behind"
  | "caught_up"
  | "failed"
  | "rebuilding";

export interface ProjectMemoryIndexHealthDto {
  coverage: {
    active: number;
    indexed: number;
    ratio: number;
    valid: number;
  };
  freshness: {
    pending: number;
    status: MemoryIndexHealthStatus;
  };
  lastErrorCode: string | null;
  projectId: string;
  searchMode: "source_fallback";
  status: MemoryIndexHealthStatus;
  updatedAt: string;
  version: number;
}

export interface MemoryIndexRebuildResult {
  operationId: string;
  replayed: number;
  status: "caught_up";
  version: number;
}

export type ServiceHealthStatus = "degraded" | "failed" | "ok" | "unknown";

export interface ServiceHealthDto {
  app: {
    detail: string | null;
    schemaIdentity: number;
    status: ServiceHealthStatus;
  };
  execution: {
    active: number;
    detail: string | null;
    failed: number;
    projectId: string | null;
    status: ServiceHealthStatus;
  };
  memoryIndex: {
    detail: string | null;
    projectId: string | null;
    status: ServiceHealthStatus;
  };
  providers: {
    detail: string | null;
    status: ServiceHealthStatus;
    total: number;
    verified: number;
  };
}

export interface UsageTotalsDto {
  completionTokens: number;
  invalidCalls: number;
  promptTokens: number;
  totalTokens: number;
  unreportedCalls: number;
}

export interface UsageQuotaDto {
  budgets: Array<{
    agentId: string;
    maxHandoffs: number;
    maxTokens: number;
    name: string;
    usedTokens: number;
  }>;
  disclaimer: "not_invoice";
  project: {
    detail: string | null;
    projectId: string | null;
    totals: UsageTotalsDto;
  };
  providers: Array<{
    id: string;
    name: string;
    totals: UsageTotalsDto;
  }>;
  runs: Array<{
    id: string;
    roundCount: number;
    roundLimit: number;
    totals: UsageTotalsDto;
  }>;
}

export interface ContributionInsightDto {
  disclaimer: "not_ranking";
  project: {
    detail: string | null;
    projectId: string | null;
  };
  roles: Array<{
    agentId: string;
    name: string;
    reviews: {
      failed: number;
      passed: number;
    };
    role: string;
    workItems: {
      blocked: number;
      completed: number;
      inProgress: number;
    };
    evidence: Array<{
      id: string;
      kind: "review" | "work_item";
      title: string;
    }>;
  }>;
}

export interface RedactedExportDto {
  contentHash: string;
  events: AuditEventListItemDto[];
  exportedAt: string;
  formatVersion: 1;
  messages: Array<{
    authorDisplayName: string;
    authorType: string;
    content: string;
    createdAt: string;
    id: string;
    sequence: number;
    threadId: string;
  }>;
  scope: {
    detail: string;
    projectId: string;
    threadId: string | null;
  };
}

export interface DeliveryReplayDto {
  formatVersion: 1;
  items: TimelineEventItemDto[];
  replayHash: string;
  scope: {
    detail: string;
    projectId: string;
    runId: string;
  };
}
