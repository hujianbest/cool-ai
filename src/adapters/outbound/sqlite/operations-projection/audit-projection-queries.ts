import type { DatabaseSync } from "node:sqlite";

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import {
  OperationsProjectionError,
  type ListProjectAuditEventsOptions,
  type ProjectAuditEventsPageDto,
} from "@/src/modules/operations-projection";
import {
  catchUpAuditProjection,
  readAuditProjectionFreshness,
} from "./audit-projection-consumer";

export const AUDIT_EVENTS_DEFAULT_LIMIT = 50;
export const AUDIT_EVENTS_MAX_LIMIT = 100;

type ProjectionEventRow = {
  actorType: string | null;
  eventType: string;
  executionId: string | null;
  id: string;
  occurredAt: string;
  outboxSeq: number;
  payloadJson: string;
};

function ensureProject(database: DatabaseSync, projectId: string): void {
  if (!database.prepare("SELECT 1 FROM projects WHERE id=?").get(projectId)) {
    throw new OperationsProjectionError(
      "PROJECT_NOT_FOUND",
      "Project was not found.",
    );
  }
}

// payload_json is CHECK json_valid and holds the source owner's already
// sanitized whitelist object; a non-object payload degrades to {} rather than
// failing the page (the outbox row stays the source of truth).
function parsePayload(payloadJson: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(payloadJson);
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}

function requireValidOptions(options: ListProjectAuditEventsOptions): {
  beforeSeq: number | null;
  limit: number;
} {
  const limit = options.limit ?? AUDIT_EVENTS_DEFAULT_LIMIT;
  const beforeSeq = options.beforeSeq ?? null;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > AUDIT_EVENTS_MAX_LIMIT) {
    throw new OperationsProjectionError(
      "INVALID_INPUT",
      "Audit events query is invalid.",
    );
  }
  if (beforeSeq !== null && (!Number.isSafeInteger(beforeSeq) || beforeSeq < 1)) {
    throw new OperationsProjectionError(
      "INVALID_INPUT",
      "Audit events query is invalid.",
    );
  }
  return { beforeSeq, limit };
}

export function listProjectAuditEvents(
  databasePath: string,
  projectId: string,
  options: ListProjectAuditEventsOptions = {},
): ProjectAuditEventsPageDto {
  const { beforeSeq, limit } = requireValidOptions(options);
  // Tuple validation precedes the global catch-up: an unknown project must not
  // trigger consumer work or be masked by a rebuild-in-progress failure.
  const guard = openDatabase(databasePath);
  try {
    ensureProject(guard, projectId);
  } finally {
    guard.close();
  }
  // MVP read path: synchronous catch-up, no background daemon. A claimed
  // rebuild fails closed here, so the route never serves a partial list.
  catchUpAuditProjection(databasePath);
  const database = openDatabase(databasePath);
  try {
    database.exec("BEGIN");
    try {
      const rows = database.prepare(`
        SELECT outbox_seq AS outboxSeq, id, event_type AS eventType,
               actor_type AS actorType, occurred_at AS occurredAt,
               execution_id AS executionId, payload_json AS payloadJson
        FROM audit_event_projection
        WHERE project_id=? AND (? IS NULL OR outbox_seq < ?)
        ORDER BY outbox_seq DESC
        LIMIT ?
      `).all(
        projectId,
        beforeSeq,
        beforeSeq,
        limit + 1,
      ) as unknown as ProjectionEventRow[];
      const freshness = readAuditProjectionFreshness(database);
      database.exec("COMMIT");
      const events = rows.slice(0, limit).map((row) => ({
        actorType: row.actorType,
        eventType: row.eventType,
        executionId: row.executionId,
        id: row.id,
        occurredAt: row.occurredAt,
        outboxSeq: row.outboxSeq,
        payload: parsePayload(row.payloadJson),
      }));
      const nextBeforeSeq = rows.length > limit
        ? events[events.length - 1].outboxSeq
        : null;
      return { events, freshness, nextBeforeSeq };
    } catch (error) {
      if (database.isTransaction) database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
}
