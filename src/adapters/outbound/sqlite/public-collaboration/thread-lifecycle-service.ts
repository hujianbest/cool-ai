import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { TextDecoder } from "node:util";

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { deleteThreadSearchIndexRowsTx } from "@/src/adapters/outbound/sqlite/operations-projection/thread-search-index-store";
import { appendCollaborationAuditOutboxRow } from "@/src/adapters/outbound/sqlite/public-collaboration/audit-event-outbox";
import {
  deleteThreadPurgeMarkerTx,
  insertThreadPurgeMarkerTx,
} from "@/src/adapters/outbound/sqlite/public-collaboration/thread-purge-marker-store";
import { CollaborationError } from "@/src/modules/public-collaboration";
import type {
  RecycleBinItemDto,
  RecycleBinListResponseDto,
  ThreadDeleteResponse,
  ThreadPurgeResponse,
  ThreadRestoreResponse,
} from "@/src/shared/collaboration-contracts";

const RESOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const LIST_DEFAULT_LIMIT = 50;
const LIST_MAX_LIMIT = 100;

const utf8 = new TextDecoder("utf-8", { fatal: true });

function transaction<T>(database: DatabaseSync, operation: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  database.exec("PRAGMA defer_foreign_keys=ON");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  }
}

type StoredLifecycleThread = {
  deletedAt: string | null;
  title: string;
};

type StoredAttachmentPath = { storageRelpath: string };

function invalidInput(fields: Record<string, string>): never {
  throw new CollaborationError(
    "INVALID_INPUT",
    400,
    "Thread recycle bin input is invalid.",
    { fields },
  );
}

function ensureProject(database: DatabaseSync, projectId: string): void {
  if (!database.prepare("SELECT 1 FROM projects WHERE id=?").get(projectId)) {
    throw new CollaborationError("PROJECT_NOT_FOUND", 404, "Project was not found.");
  }
}

function readThread(
  database: DatabaseSync,
  projectId: string,
  threadId: string,
): StoredLifecycleThread {
  const row = database
    .prepare(
      `SELECT title,deleted_at AS deletedAt
       FROM collaboration_threads
       WHERE project_id=? AND id=?`,
    )
    .get(projectId, threadId) as StoredLifecycleThread | undefined;
  // Missing and cross-project tuples share one unmarked 404 so the deletion
  // state never leaks across project boundaries (active-thread-guards rule).
  if (!row) {
    throw new CollaborationError("RESOURCE_NOT_FOUND", 404, "Resource was not found.");
  }
  return row;
}

function resolveAttachmentStoragePath(
  attachmentsRoot: string,
  storageRelpath: string,
): string {
  const base = resolve(attachmentsRoot);
  const target = resolve(base, storageRelpath);
  if (!target.startsWith(`${base}${sep}`)) {
    throw new CollaborationError(
      "STORAGE_UNAVAILABLE",
      503,
      "Attachment storage is unavailable.",
    );
  }
  return target;
}

// The delete/restore commands are state-machine edges, not preference facts:
// a repeat is a no-op that replays the current state and writes no second
// audit event, so the audit trail keeps exactly one row per real transition.
export function deleteThread(
  databasePath: string,
  projectId: string,
  threadId: string,
): { body: ThreadDeleteResponse; status: 200 } {
  const database = openDatabase(databasePath);
  database.exec("PRAGMA busy_timeout=5000");
  try {
    return transaction(database, () => {
      const thread = readThread(database, projectId, threadId);
      if (thread.deletedAt !== null) {
        return {
          body: { deleted: false, deletedAt: thread.deletedAt, threadId },
          status: 200 as const,
        };
      }
      const hasActiveRun = database
        .prepare(
          `SELECT 1 FROM collaboration_runs
           WHERE project_id=? AND thread_id=?
             AND status NOT IN ('failed','stopped')
           LIMIT 1`,
        )
        .get(projectId, threadId);
      if (hasActiveRun) {
        throw new CollaborationError(
          "OPERATION_CONFLICT",
          409,
          "Thread has an active run.",
          { fields: { threadId: "has_active_run" } },
        );
      }
      const timestamp = new Date().toISOString();
      database
        .prepare(
          `UPDATE collaboration_threads
           SET deleted_at=?,version=version+1
           WHERE project_id=? AND id=?`,
        )
        .run(timestamp, projectId, threadId);
      appendCollaborationAuditOutboxRow(database, {
        actorId: null,
        actorType: "owner",
        eventId: randomUUID(),
        eventType: "thread_deleted",
        projectId,
        runId: null,
        threadId,
        sourcePayload: { title: thread.title },
      });
      return {
        body: { deleted: true, deletedAt: timestamp, threadId },
        status: 200 as const,
      };
    });
  } finally {
    database.close();
  }
}

export function restoreThread(
  databasePath: string,
  projectId: string,
  threadId: string,
): { body: ThreadRestoreResponse; status: 200 } {
  const database = openDatabase(databasePath);
  database.exec("PRAGMA busy_timeout=5000");
  try {
    return transaction(database, () => {
      const thread = readThread(database, projectId, threadId);
      if (thread.deletedAt === null) {
        return {
          body: { restored: false, threadId },
          status: 200 as const,
        };
      }
      database
        .prepare(
          `UPDATE collaboration_threads
           SET deleted_at=NULL,version=version+1
           WHERE project_id=? AND id=?`,
        )
        .run(projectId, threadId);
      appendCollaborationAuditOutboxRow(database, {
        actorId: null,
        actorType: "owner",
        eventId: randomUUID(),
        eventType: "thread_restored",
        projectId,
        runId: null,
        threadId,
        sourcePayload: { title: thread.title },
      });
      return {
        body: { restored: true, threadId },
        status: 200 as const,
      };
    });
  } finally {
    database.close();
  }
}

export function purgeThread(
  databasePath: string,
  attachmentsRoot: string,
  projectId: string,
  threadId: string,
): { body: ThreadPurgeResponse; status: 200 } {
  const database = openDatabase(databasePath);
  database.exec("PRAGMA busy_timeout=5000");
  try {
    return transaction(database, () => {
      const thread = readThread(database, projectId, threadId);
      if (thread.deletedAt === null) {
        throw new CollaborationError("RESOURCE_NOT_FOUND", 404, "Resource was not found.");
      }
      const hasExecutions = database
        .prepare(
          `SELECT 1 FROM executions
           WHERE project_id=? AND source_collaboration_thread_id=?
           LIMIT 1`,
        )
        .get(projectId, threadId);
      if (hasExecutions) {
        throw new CollaborationError(
          "OPERATION_CONFLICT",
          409,
          "Thread has execution provenance.",
          { fields: { threadId: "has_executions" } },
        );
      }
      const timestamp = new Date().toISOString();
      insertThreadPurgeMarkerTx(database, projectId, threadId, timestamp);
      const removedMessageCount = (
        database
          .prepare(
            "SELECT count(*) AS count FROM collaboration_messages WHERE project_id=? AND thread_id=?",
          )
          .get(projectId, threadId) as { count: number }
      ).count;
      const removedAttachmentCount = (
        database
          .prepare("SELECT count(*) AS count FROM message_attachments WHERE project_id=? AND thread_id=?")
          .get(projectId, threadId) as { count: number }
      ).count;
      database.prepare(
        "DELETE FROM collaboration_thread_facts WHERE project_id=? AND thread_id=?",
      ).run(projectId, threadId);
      database.prepare(
        "DELETE FROM structured_message_state_heads WHERE project_id=? AND thread_id=?",
      ).run(projectId, threadId);
      database.prepare(
        "DELETE FROM structured_message_state_revisions WHERE project_id=? AND thread_id=?",
      ).run(projectId, threadId);
      database.prepare(
        "DELETE FROM structured_message_blocks WHERE project_id=? AND thread_id=?",
      ).run(projectId, threadId);
      database.prepare(
        "DELETE FROM business_action_receipts WHERE project_id=? AND thread_id=?",
      ).run(projectId, threadId);
      database.prepare("DELETE FROM inline_decisions WHERE project_id=? AND thread_id=?").run(
        projectId,
        threadId,
      );
      deleteThreadSearchIndexRowsTx(database, { projectId, threadId });
      const attachmentRows = database.prepare(
        `SELECT storage_relpath AS storageRelpath
         FROM message_attachments
         WHERE project_id=? AND thread_id=?`,
      ).all(projectId, threadId) as StoredAttachmentPath[];
      const storagePaths = [...new Set(attachmentRows.map((row) => row.storageRelpath))];
      const unlinkCandidates = storagePaths.filter((storageRelpath) => {
        const sharedReferences = (
          database
            .prepare(
              `SELECT count(*) AS count
               FROM message_attachments
               WHERE project_id=? AND storage_relpath=? AND thread_id<>?`,
            )
            .get(projectId, storageRelpath, threadId) as { count: number }
        ).count;
        return sharedReferences === 0;
      });
      database.prepare("DELETE FROM collaboration_threads WHERE project_id=? AND id=?").run(
        projectId,
        threadId,
      );
      for (const storageRelpath of unlinkCandidates) {
        try {
          unlinkSync(resolveAttachmentStoragePath(attachmentsRoot, storageRelpath));
        } catch (error) {
          if (
            typeof error === "object"
            && error !== null
            && "code" in error
            && (error as { code?: string }).code === "ENOENT"
          ) {
            // The blob was already absent; as long as no live rows reference it,
            // purge still succeeds and leaves storage in the desired state.
            continue;
          }
          throw new CollaborationError(
            "STORAGE_UNAVAILABLE",
            503,
            "Attachment storage is unavailable.",
          );
        }
      }
      database.prepare(
        `INSERT OR IGNORE INTO collaboration_project_thread_sequences(
           project_id,next_activity_sequence
         ) VALUES (?,1)`,
      ).run(projectId);
      database.prepare(
        `UPDATE collaboration_project_thread_sequences
         SET next_activity_sequence=1+COALESCE(
           (SELECT MAX(activity_sequence)
            FROM collaboration_thread_facts
            WHERE project_id=?),0
         )
         WHERE project_id=?`,
      ).run(projectId, projectId);
      deleteThreadPurgeMarkerTx(database, projectId, threadId);
      appendCollaborationAuditOutboxRow(database, {
        actorId: null,
        actorType: "owner",
        eventId: randomUUID(),
        eventType: "thread_purged",
        projectId,
        runId: null,
        sourcePayload: { title: thread.title },
        threadId,
      });
      return {
        body: {
          purged: true,
          removedAttachmentCount,
          removedMessageCount,
          threadId,
        },
        status: 200 as const,
      };
    });
  } finally {
    database.close();
  }
}

// The recycle bin cursor is isomorphic to the listThreads codec (feature 033
// A-212): an opaque base64url JSON envelope with a strict canonical
// round-trip check. The sort key here is the deleted_at ISO string (fixed
// GLOB shape, so lexicographic order is chronological), not an integer
// activity sequence.
type RecycleBinCursor = {
  d: string;
  id: string;
  v: 1;
};

function encodeRecycleBinCursor(value: Omit<RecycleBinCursor, "v">): string {
  if (!ISO_TIMESTAMP.test(value.d) || !RESOURCE_ID.test(value.id)) {
    invalidInput({ cursor: "invalid_format" });
  }
  return Buffer.from(
    JSON.stringify({ d: value.d, id: value.id, v: 1 }),
    "utf8",
  ).toString("base64url");
}

function decodeRecycleBinCursor(cursor: string): RecycleBinCursor {
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error("INVALID_CURSOR");
  const bytes = Buffer.from(cursor, "base64url");
  if (bytes.toString("base64url") !== cursor) throw new Error("INVALID_CURSOR");
  const json = utf8.decode(bytes);
  const value = JSON.parse(json) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("INVALID_CURSOR");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 3
    || record.v !== 1
    || typeof record.d !== "string"
    || !ISO_TIMESTAMP.test(record.d)
    || typeof record.id !== "string"
    || !RESOURCE_ID.test(record.id)
    || JSON.stringify({ d: record.d, id: record.id, v: 1 }) !== json
  ) {
    throw new Error("INVALID_CURSOR");
  }
  return { d: record.d, id: record.id, v: 1 };
}

function parseRecycleBinListInput(rawInput: unknown): {
  cursor: RecycleBinCursor | null;
  limit: number;
} {
  if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput)) {
    invalidInput({ input: "invalid_format" });
  }
  const input = rawInput as Record<string, unknown>;
  const fields: Record<string, string> = {};
  for (const key of Object.keys(input)) {
    if (key !== "cursor" && key !== "limit") fields[key] = "unknown";
  }
  const limit = input.limit === undefined ? LIST_DEFAULT_LIMIT : input.limit;
  if (
    !Number.isSafeInteger(limit)
    || Number(limit) < 1
    || Number(limit) > LIST_MAX_LIMIT
  ) {
    fields.limit = "invalid_range";
  }
  let cursor: RecycleBinCursor | null = null;
  if (input.cursor !== undefined) {
    if (typeof input.cursor !== "string") {
      fields.cursor = "invalid_format";
    } else {
      try {
        cursor = decodeRecycleBinCursor(input.cursor);
      } catch {
        fields.cursor = "invalid_format";
      }
    }
  }
  if (Object.keys(fields).length > 0) invalidInput(fields);
  return { cursor, limit: Number(limit) };
}

export function listDeletedThreads(
  databasePath: string,
  projectId: string,
  rawInput: unknown = {},
): { body: RecycleBinListResponseDto; status: 200 } {
  const input = parseRecycleBinListInput(rawInput);
  const database = openDatabase(databasePath);
  try {
    ensureProject(database, projectId);
    const values: Array<string | number> = [projectId];
    if (input.cursor) {
      values.push(input.cursor.d, input.cursor.d, input.cursor.id);
    }
    values.push(input.limit + 1);
    const rows = database
      .prepare(
        `SELECT threads.id,threads.project_id AS projectId,threads.title,
                threads.deleted_at AS deletedAt
         FROM collaboration_threads AS threads
         WHERE threads.project_id=? AND threads.deleted_at IS NOT NULL
         ${
           input.cursor
             ? `AND (
                 threads.deleted_at < ?
                 OR (threads.deleted_at = ? AND threads.id > ?)
               )`
             : ""
         }
         ORDER BY threads.deleted_at DESC,threads.id ASC
         LIMIT ?`,
      )
      .all(...values) as Array<{
      deletedAt: string;
      id: string;
      projectId: string;
      title: string;
    }>;
    const hasMore = rows.length > input.limit;
    const pageRows = hasMore ? rows.slice(0, input.limit) : rows;
    // Counts come from two batched GROUP BY queries over the page's thread
    // ids (no N+1; 032 tags projection precedent). Attachments count every
    // stored row of the tuple — uploaded-but-unlinked bytes are also removed
    // by a purge, so the impact number stays honest.
    const messageCounts = new Map<string, number>();
    const attachmentCounts = new Map<string, number>();
    if (pageRows.length > 0) {
      const placeholders = pageRows.map(() => "?").join(",");
      const pageIds = pageRows.map((row) => row.id);
      const messageRows = database
        .prepare(
          `SELECT thread_id AS threadId,count(*) AS count
           FROM collaboration_messages
           WHERE project_id=? AND thread_id IN (${placeholders})
           GROUP BY thread_id`,
        )
        .all(projectId, ...pageIds) as Array<{ count: number; threadId: string }>;
      for (const row of messageRows) messageCounts.set(row.threadId, row.count);
      const attachmentRows = database
        .prepare(
          `SELECT thread_id AS threadId,count(*) AS count
           FROM message_attachments
           WHERE project_id=? AND thread_id IN (${placeholders})
           GROUP BY thread_id`,
        )
        .all(projectId, ...pageIds) as Array<{ count: number; threadId: string }>;
      for (const row of attachmentRows) attachmentCounts.set(row.threadId, row.count);
    }
    const threads: RecycleBinItemDto[] = pageRows.map((row) => ({
      attachmentCount: attachmentCounts.get(row.id) ?? 0,
      deletedAt: row.deletedAt,
      id: row.id,
      messageCount: messageCounts.get(row.id) ?? 0,
      projectId: row.projectId,
      title: row.title,
    }));
    const last = threads.at(-1);
    return {
      body: {
        nextCursor:
          hasMore && last
            ? encodeRecycleBinCursor({ d: last.deletedAt, id: last.id })
            : null,
        threads,
      },
      status: 200 as const,
    };
  } finally {
    database.close();
  }
}
