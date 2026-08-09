import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { CollaborationError } from "@/src/modules/public-collaboration";
import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { classifyPublicTextFromDatabaseConnection } from "@/src/adapters/outbound/sqlite/public-collaboration/public-text-credential-classifier";
import type {
  InputHistoryClearResponse,
  InputHistoryEntryDto,
  InputHistorySearchResponse,
} from "@/src/shared/collaboration-contracts";

const QUERY_MAX_GRAPHEMES = 200;
const SEARCH_LIMIT = 100;

const segmenter = new Intl.Segmenter("zh-CN", { granularity: "grapheme" });

function graphemeLength(value: string): number {
  return Array.from(segmenter.segment(value)).length;
}

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

function requireProject(database: DatabaseSync, projectId: string): void {
  if (!database.prepare("SELECT 1 FROM projects WHERE id=?").get(projectId)) {
    throw new CollaborationError(
      "RESOURCE_NOT_FOUND",
      404,
      "Resource was not found.",
    );
  }
}

/**
 * 发送事务内的联动副作用：凭据分类 fail-closed（命中即跳过，不落盘也不写日志），
 * 随后删除同 tuple 草稿。仅在操作收据判定为重放之前的路径之后调用，
 * 因此同 operationId 重放不会重复追加或二次清除。
 */
export function recordOwnerInputAndClearDraftTx(
  database: DatabaseSync,
  projectId: string,
  threadId: string,
  content: string,
  timestamp: string,
  recordHistory = true,
): void {
  if (
    recordHistory
    && classifyPublicTextFromDatabaseConnection(database, content) === null
  ) {
    database
      .prepare(
        `INSERT INTO input_history_entries(id,project_id,thread_id,content,created_at)
         VALUES (?,?,?,?,?)`,
      )
      .run(randomUUID(), projectId, threadId, content, timestamp);
  }
  database
    .prepare("DELETE FROM thread_drafts WHERE project_id=? AND thread_id=?")
    .run(projectId, threadId);
}

export function searchInputHistory(
  databasePath: string,
  projectId: string,
  query: string,
): { body: InputHistorySearchResponse; status: 200 } {
  if (typeof query !== "string") {
    throw new CollaborationError("INVALID_INPUT", 400, "Input history input is invalid.", {
      fields: { query: "invalid_format" },
    });
  }
  if (graphemeLength(query) > QUERY_MAX_GRAPHEMES) {
    throw new CollaborationError("INVALID_INPUT", 400, "Input history input is invalid.", {
      fields: { query: "too_long" },
    });
  }
  const database = openDatabase(databasePath);
  try {
    requireProject(database, projectId);
    const escaped = query.replace(/[\\%_]/gu, (char) => `\\${char}`);
    const entries = database
      .prepare(
        `SELECT id,thread_id AS threadId,content,created_at AS createdAt
         FROM input_history_entries
         WHERE project_id=? AND content LIKE '%'||?||'%' ESCAPE '\\'
         ORDER BY created_at DESC,id DESC
         LIMIT ${SEARCH_LIMIT}`,
      )
      .all(projectId, escaped) as unknown as InputHistoryEntryDto[];
    const lastClear = database
      .prepare(
        `SELECT MAX(cleared_at) AS lastClearedAt
         FROM input_history_clear_events WHERE project_id=?`,
      )
      .get(projectId) as { lastClearedAt: string | null };
    return {
      body: { entries, lastClearedAt: lastClear.lastClearedAt },
      status: 200,
    };
  } finally {
    database.close();
  }
}

export function clearInputHistory(
  databasePath: string,
  projectId: string,
): { body: InputHistoryClearResponse; status: 200 } {
  const database = openDatabase(databasePath);
  database.exec("PRAGMA busy_timeout=5000");
  try {
    return transaction(database, () => {
      requireProject(database, projectId);
      const timestamp = new Date().toISOString();
      database
        .prepare("DELETE FROM input_history_entries WHERE project_id=?")
        .run(projectId);
      database
        .prepare(
          `INSERT INTO input_history_clear_events(id,project_id,cleared_at)
           VALUES (?,?,?)`,
        )
        .run(randomUUID(), projectId, timestamp);
      return {
        body: { cleared: true as const, clearedAt: timestamp },
        status: 200 as const,
      };
    });
  } finally {
    database.close();
  }
}
