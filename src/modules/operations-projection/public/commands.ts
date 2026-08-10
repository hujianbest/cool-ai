import type {
  AuditProjectionCatchUpResult,
  AuditProjectionRebuildResult,
} from "./dto";

/**
 * Projection consumer write capability (feature 028, CAP-OPS-01). Public from
 * the module but wired only for composition/test seams — no HTTP write route;
 * the MVP read path triggers catchUp, rebuild is an operations/test seam.
 */
export interface OperationsProjectionCommands {
  catchUpAuditProjection: (databasePath: string) => AuditProjectionCatchUpResult;
  rebuildAuditProjection: (databasePath: string) => AuditProjectionRebuildResult;
}
