import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { CollaborationError } from "@/src/server/collaboration/collaboration-errors";

export type CompletedOperation<T> = {
  body: T;
  status: number;
};

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => key !== "operationId")
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

export function canonicalRequestHash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

export function readOperationReceipt<T>(
  database: DatabaseSync,
  projectId: string,
  operationId: string,
  kind: string,
  requestHash: string,
): CompletedOperation<T> | null {
  const row = database
    .prepare(
      `SELECT kind, request_hash AS requestHash, status, http_status AS httpStatus,
              response_json AS responseJson
       FROM collaboration_operations
       WHERE project_id = ? AND id = ?`,
    )
    .get(projectId, operationId) as
    | {
        kind: string;
        requestHash: string;
        status: "pending" | "completed";
        httpStatus: number | null;
        responseJson: string | null;
      }
    | undefined;
  if (!row) return null;
  if (row.kind !== kind || row.requestHash !== requestHash) {
    throw new CollaborationError(
      "OPERATION_CONFLICT",
      409,
      "Operation id was already used for different input.",
    );
  }
  if (row.status !== "completed" || row.httpStatus === null || row.responseJson === null) {
    throw new CollaborationError(
      "OPERATION_IN_PROGRESS",
      409,
      "Operation is still in progress.",
    );
  }
  const body = JSON.parse(row.responseJson) as T;
  return {
    body,
    status: row.httpStatus,
  };
}

export function completeOperationReceipt(
  database: DatabaseSync,
  input: {
    operationId: string;
    projectId: string;
    threadId?: string;
    runId: string | null;
    kind: string;
    requestHash: string;
    status: number;
    body: unknown;
    timestamp: string;
  },
): void {
  const threadId =
    input.threadId
    ?? (
      input.runId
        ? (
            database
              .prepare(
                `SELECT thread_id AS threadId
                 FROM collaboration_runs
                 WHERE project_id = ? AND id = ?`,
              )
              .get(input.projectId, input.runId) as { threadId: string } | undefined
          )?.threadId
        : undefined
    );
  if (!threadId) {
    throw new CollaborationError(
      "STORAGE_UNAVAILABLE",
      503,
      "Operation receipt storage is unavailable.",
    );
  }
  database
    .prepare(
      `INSERT INTO collaboration_operations (
         id, project_id, thread_id, run_id, kind, request_hash, status,
         http_status, response_json, response_schema_version, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'completed', ?, ?, 7, ?, ?)
       ON CONFLICT(project_id, id) DO UPDATE SET
         thread_id = excluded.thread_id,
         run_id = excluded.run_id,
         status = 'completed',
         http_status = excluded.http_status,
         response_json = excluded.response_json,
         response_schema_version = excluded.response_schema_version,
         updated_at = excluded.updated_at
       WHERE collaboration_operations.kind = excluded.kind
         AND collaboration_operations.request_hash = excluded.request_hash`,
    )
    .run(
      input.operationId,
      input.projectId,
      threadId,
      input.runId,
      input.kind,
      input.requestHash,
      input.status,
      JSON.stringify(input.body),
      input.timestamp,
      input.timestamp,
    );
}
