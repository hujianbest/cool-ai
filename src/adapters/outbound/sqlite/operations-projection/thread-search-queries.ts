import type { DatabaseSync } from "node:sqlite";

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import {
  OperationsProjectionError,
  type ProjectThreadSearchPageDto,
  type SearchProjectThreadsOptions,
  type ThreadSearchResultItemDto,
} from "@/src/modules/operations-projection";
import { catchUpThreadSearchIndex } from "./thread-search-index-consumer";

export const THREAD_SEARCH_DEFAULT_LIMIT = 20;
export const THREAD_SEARCH_MAX_LIMIT = 50;
export const THREAD_SEARCH_QUERY_MAX_GRAPHEMES = 200;
export const THREAD_SEARCH_SNIPPET_CONTEXT_GRAPHEMES = 60;

const segmenter = new Intl.Segmenter("zh-CN", { granularity: "grapheme" });

function graphemes(value: string): string[] {
  return Array.from(segmenter.segment(value), (part) => part.segment);
}

// Mirrors SQLite lower(): ASCII-only case folding, so the JS snippet locator
// agrees with the SQL instr(lower(content), lower(?)) match predicate.
function asciiFold(value: string): string {
  return value.replace(/[A-Z]/g, (char) => char.toLowerCase());
}

type IndexHitRow = {
  content: string;
  kind: "message" | "thread_title";
  messageId: string | null;
  occurredAt: string;
  threadId: string;
  threadTitle: string;
};

// The cursor is the page's last row sort key: occurred_at DESC, then
// thread_id/message_id ASC (title rows carry message_id NULL and sort first).
type Cursor = {
  messageId: string | null;
  occurredAt: string;
  threadId: string;
};

const CURSOR_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function invalidInput(): OperationsProjectionError {
  return new OperationsProjectionError(
    "INVALID_INPUT",
    "Thread search query is invalid.",
  );
}

function encodeCursor(row: IndexHitRow): string {
  return Buffer.from(
    JSON.stringify([row.occurredAt, row.threadId, row.messageId]),
  ).toString("base64url");
}

function decodeCursor(raw: string): Cursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw invalidInput();
  }
  if (!Array.isArray(parsed) || parsed.length !== 3) throw invalidInput();
  const [occurredAt, threadId, messageId] = parsed as unknown[];
  if (typeof occurredAt !== "string" || !CURSOR_TIMESTAMP.test(occurredAt)) {
    throw invalidInput();
  }
  if (typeof threadId !== "string" || threadId.length === 0) throw invalidInput();
  if (messageId !== null && typeof messageId !== "string") throw invalidInput();
  return { messageId, occurredAt, threadId };
}

function requireValidOptions(options: SearchProjectThreadsOptions): {
  before: Cursor | null;
  limit: number;
  query: string;
} {
  if (options === null || typeof options !== "object") throw invalidInput();
  const query = typeof options.query === "string" ? options.query.trim() : "";
  if (
    query.length === 0
    || graphemes(query).length > THREAD_SEARCH_QUERY_MAX_GRAPHEMES
  ) {
    throw invalidInput();
  }
  const limit = options.limit ?? THREAD_SEARCH_DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > THREAD_SEARCH_MAX_LIMIT) {
    throw invalidInput();
  }
  const before = options.before === undefined ? null : decodeCursor(options.before);
  return { before, limit, query };
}

function ensureProject(database: DatabaseSync, projectId: string): void {
  if (!database.prepare("SELECT 1 FROM projects WHERE id=?").get(projectId)) {
    throw new OperationsProjectionError(
      "PROJECT_NOT_FOUND",
      "Project was not found.",
    );
  }
}

// Title hits show the full title; message hits show a ±60-grapheme window
// around the first match, with … ellipses where the window truncates the body.
function buildSnippet(row: IndexHitRow, query: string): string {
  if (row.kind === "thread_title") return row.content;
  const parts = graphemes(row.content);
  const matchStart = asciiFold(row.content).indexOf(asciiFold(query));
  if (matchStart === -1) {
    // Unreachable while the SQL filter and asciiFold agree; degrade to the
    // head window rather than failing the page.
    const head = parts.slice(0, THREAD_SEARCH_SNIPPET_CONTEXT_GRAPHEMES * 2).join("");
    return parts.length > THREAD_SEARCH_SNIPPET_CONTEXT_GRAPHEMES * 2
      ? `${head}…`
      : row.content;
  }
  const matchEnd = matchStart + asciiFold(query).length;
  // Map the code-unit match offsets to grapheme indices.
  let offset = 0;
  let startGrapheme = 0;
  let endGrapheme = parts.length - 1;
  for (let index = 0; index < parts.length; index += 1) {
    const next = offset + parts[index].length;
    if (offset <= matchStart && matchStart < next) startGrapheme = index;
    if (offset < matchEnd && matchEnd <= next) endGrapheme = index;
    offset = next;
  }
  const windowStart = Math.max(0, startGrapheme - THREAD_SEARCH_SNIPPET_CONTEXT_GRAPHEMES);
  const windowEnd = Math.min(
    parts.length,
    endGrapheme + 1 + THREAD_SEARCH_SNIPPET_CONTEXT_GRAPHEMES,
  );
  const body = parts.slice(windowStart, windowEnd).join("");
  return `${windowStart > 0 ? "…" : ""}${body}${windowEnd < parts.length ? "…" : ""}`;
}

const HIT_SELECT = `
  SELECT i.thread_id AS threadId, i.kind AS kind, i.message_id AS messageId,
         i.content AS content, i.occurred_at AS occurredAt,
         t.title AS threadTitle
  FROM thread_search_index i
  JOIN collaboration_threads t
    ON t.project_id=i.project_id AND t.id=i.thread_id
  WHERE i.project_id=? AND instr(lower(i.content), lower(?))>0
    AND t.deleted_at IS NULL
`;

// occurred_at DESC, then (thread_id, message_id) ASC: within one project the
// (thread_id, message_id) pair is unique per index row, so the order is total
// and stable. NULL message_id (title rows) sorts before any message id.
const ORDER_AND_LIMIT = `
  ORDER BY i.occurred_at DESC, i.thread_id ASC, i.message_id ASC
  LIMIT ?
`;

function selectHits(
  database: DatabaseSync,
  projectId: string,
  query: string,
  before: Cursor | null,
  limit: number,
): IndexHitRow[] {
  if (before === null) {
    return database.prepare(`${HIT_SELECT} ${ORDER_AND_LIMIT}`).all(
      projectId,
      query,
      limit + 1,
    ) as unknown as IndexHitRow[];
  }
  // Strictly older than the cursor row in the stable order. When the cursor
  // is a title row (messageId NULL), every message row of the same
  // (occurred_at, thread_id) sorts after it; when it is a message row, the
  // title row sorts before it and NULL > ? is never true.
  return database.prepare(`
    ${HIT_SELECT}
    AND (
      i.occurred_at<?
      OR (i.occurred_at=? AND i.thread_id>?)
      OR (i.occurred_at=? AND i.thread_id=? AND (
        (? IS NULL AND i.message_id IS NOT NULL)
        OR (? IS NOT NULL AND i.message_id>?)
      ))
    )
    ${ORDER_AND_LIMIT}
  `).all(
    projectId,
    query,
    before.occurredAt,
    before.occurredAt,
    before.threadId,
    before.occurredAt,
    before.threadId,
    before.messageId,
    before.messageId,
    before.messageId,
    limit + 1,
  ) as unknown as IndexHitRow[];
}

export function searchProjectThreads(
  databasePath: string,
  projectId: string,
  options: SearchProjectThreadsOptions,
): ProjectThreadSearchPageDto {
  const { before, limit, query } = requireValidOptions(options);
  // Tuple validation precedes the global catch-up (028 precedent): an unknown
  // project must not trigger consumer work or be masked by a rebuild failure.
  const guard = openDatabase(databasePath);
  try {
    ensureProject(guard, projectId);
  } finally {
    guard.close();
  }
  // MVP read path: synchronous catch-up, no background daemon. A claimed
  // rebuild fails closed here, so the route never serves a partial page.
  catchUpThreadSearchIndex(databasePath);
  const database = openDatabase(databasePath);
  try {
    database.exec("BEGIN");
    try {
      const rows = selectHits(database, projectId, query, before, limit);
      database.exec("COMMIT");
      const pageRows = rows.slice(0, limit);
      const results: ThreadSearchResultItemDto[] = pageRows.map((row) => ({
        kind: row.kind,
        messageId: row.messageId,
        occurredAt: row.occurredAt,
        snippet: buildSnippet(row, query),
        threadId: row.threadId,
        threadTitle: row.threadTitle,
      }));
      const nextCursor = rows.length > limit
        ? encodeCursor(pageRows[pageRows.length - 1])
        : null;
      return { nextCursor, results };
    } catch (error) {
      if (database.isTransaction) database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
}
