import type {
  AuditProjectionCatchUpResult,
  AuditProjectionRebuildResult,
  ThreadSearchIndexCatchUpResult,
  ThreadSearchIndexRebuildResult,
} from "./dto";

/**
 * Projection consumer write capability (feature 028, CAP-OPS-01; thread search
 * index consumer added by feature 031 T-01, CAP-OPS-02). Public from the
 * module but wired only for composition/test seams — no HTTP write route;
 * the MVP read path triggers catchUp, rebuild is an operations/test seam.
 */
export interface OperationsProjectionCommands {
  catchUpAuditProjection: (databasePath: string) => AuditProjectionCatchUpResult;
  catchUpThreadSearchIndex: (databasePath: string) => ThreadSearchIndexCatchUpResult;
  rebuildAuditProjection: (databasePath: string) => AuditProjectionRebuildResult;
  rebuildThreadSearchIndex: (databasePath: string) => ThreadSearchIndexRebuildResult;
}
