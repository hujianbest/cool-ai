import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { CollaborationError } from "@/src/modules/public-collaboration";
import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { canonicalRequestHash } from "@/src/adapters/outbound/sqlite/public-collaboration/operation-receipts";
import type {
  ThreadTagAssignmentResponse,
  ThreadTagBatchResponse,
  ThreadTagCreateResponse,
  ThreadTagDeleteResponse,
  ThreadTagDto,
  ThreadTagListResponseDto,
} from "@/src/shared/collaboration-contracts";

const RESOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$/;

const NAME_MAX_GRAPHEMES = 40;
const QUERY_MAX_GRAPHEMES = 100;
const LIST_DEFAULT_LIMIT = 50;
const LIST_MAX_LIMIT = 100;
const BATCH_MAX_THREAD_IDS = 100;
const BATCH_MAX_TAG_IDS = 20;

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

function invalidInput(fields: Record<string, string>): never {
  throw new CollaborationError("INVALID_INPUT", 400, "Thread tag input is invalid.", {
    fields,
  });
}

function resourceNotFound(): never {
  throw new CollaborationError(
    "RESOURCE_NOT_FOUND",
    404,
    "Resource was not found.",
  );
}

function graphemeLength(value: string): number {
  return Array.from(
    new Intl.Segmenter("zh-CN", { granularity: "grapheme" }).segment(value),
  ).length;
}

function ensureProject(database: DatabaseSync, projectId: string): void {
  if (!database.prepare("SELECT 1 FROM projects WHERE id=?").get(projectId)) {
    throw new CollaborationError("PROJECT_NOT_FOUND", 404, "Project was not found.");
  }
}

// Folded uniqueness key (A-183): NFC + case folding keeps synonym spellings
// (case/NFC/trim differences) on a single row per project.
function tagNameKey(name: string): string {
  return name.normalize("NFC").toLowerCase();
}

function parseCreateInput(rawInput: unknown): { name: string } {
  if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput)) {
    invalidInput({ input: "invalid_format" });
  }
  const input = rawInput as Record<string, unknown>;
  const fields: Record<string, string> = {};
  for (const key of Object.keys(input)) {
    if (key !== "name") fields[key] = "unknown";
  }
  if (!Object.hasOwn(input, "name")) {
    fields.name = "required";
  } else if (typeof input.name !== "string") {
    fields.name = "invalid_format";
  } else if (input.name.trim().length === 0) {
    fields.name = "required";
  } else if (graphemeLength(input.name.trim()) > NAME_MAX_GRAPHEMES) {
    fields.name = "too_long";
  }
  if (Object.keys(fields).length > 0) invalidInput(fields);
  return { name: (input.name as string).trim() };
}

function parseListInput(rawInput: unknown): { limit: number; query: string | null } {
  if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput)) {
    invalidInput({ input: "invalid_format" });
  }
  const input = rawInput as Record<string, unknown>;
  const fields: Record<string, string> = {};
  for (const key of Object.keys(input)) {
    if (key !== "query" && key !== "limit") fields[key] = "unknown";
  }
  let query: string | null = null;
  if (input.query !== undefined) {
    if (typeof input.query !== "string") {
      fields.query = "invalid_format";
    } else {
      const trimmed = input.query.trim();
      if (trimmed.length === 0) fields.query = "required";
      else if (graphemeLength(trimmed) > QUERY_MAX_GRAPHEMES) fields.query = "too_long";
      else query = trimmed;
    }
  }
  const limit = input.limit === undefined ? LIST_DEFAULT_LIMIT : input.limit;
  if (
    !Number.isSafeInteger(limit)
    || Number(limit) < 1
    || Number(limit) > LIST_MAX_LIMIT
  ) {
    fields.limit = "invalid_range";
  }
  if (Object.keys(fields).length > 0) invalidInput(fields);
  return { limit: Number(limit), query };
}

// Tags are a preference-class organization fact (favorites precedent): no
// operation receipt, no version column. A folded-name conflict returns the
// existing row with created:false; ON CONFLICT keeps a concurrent same-key
// race on the same idempotent path instead of surfacing a constraint error.
export function createThreadTag(
  databasePath: string,
  projectId: string,
  rawInput: unknown,
): { body: ThreadTagCreateResponse; status: 200 } {
  const input = parseCreateInput(rawInput);
  const database = openDatabase(databasePath);
  database.exec("PRAGMA busy_timeout=5000");
  try {
    return transaction(database, () => {
      ensureProject(database, projectId);
      const nameKey = tagNameKey(input.name);
      const inserted = database
        .prepare(
          `INSERT INTO thread_tags(id,project_id,name,name_key,created_at)
           VALUES (?,?,?,?,?)
           ON CONFLICT(project_id,name_key) DO NOTHING`,
        )
        .run(randomUUID(), projectId, input.name, nameKey, new Date().toISOString())
        .changes;
      const tag = database
        .prepare(
          `SELECT id,project_id AS projectId,name,created_at AS createdAt
           FROM thread_tags WHERE project_id=? AND name_key=?`,
        )
        .get(projectId, nameKey) as ThreadTagDto | undefined;
      if (!tag) throw new Error("THREAD_TAG_WRITE_LOST");
      return {
        body: { created: Number(inserted) === 1, tag },
        status: 200 as const,
      };
    });
  } finally {
    database.close();
  }
}

export function listProjectTags(
  databasePath: string,
  projectId: string,
  rawInput: unknown = {},
): { body: ThreadTagListResponseDto; status: 200 } {
  const input = parseListInput(rawInput);
  const database = openDatabase(databasePath);
  try {
    ensureProject(database, projectId);
    const values: Array<string | number> = [projectId];
    if (input.query !== null) values.push(input.query);
    values.push(input.limit);
    const tags = database
      .prepare(
        `SELECT tags.id,tags.project_id AS projectId,tags.name,
                tags.created_at AS createdAt,
                (SELECT count(*) FROM thread_tag_edges AS edges
                  WHERE edges.project_id=tags.project_id
                    AND edges.tag_id=tags.id) AS threadCount
         FROM thread_tags AS tags
         WHERE tags.project_id=?
           ${input.query === null ? "" : "AND instr(lower(tags.name), lower(?))>0"}
         ORDER BY tags.name,tags.id
         LIMIT ?`,
      )
      .all(...values) as Array<ThreadTagDto & { threadCount: number }>;
    return { body: { tags }, status: 200 as const };
  } finally {
    database.close();
  }
}

export function deleteThreadTag(
  databasePath: string,
  projectId: string,
  tagId: string,
): { body: ThreadTagDeleteResponse; status: 200 } {
  const database = openDatabase(databasePath);
  database.exec("PRAGMA busy_timeout=5000");
  try {
    return transaction(database, () => {
      const tag = database
        .prepare("SELECT 1 FROM thread_tags WHERE project_id=? AND id=?")
        .get(projectId, tagId);
      if (!tag) resourceNotFound();
      // Edges are cleared explicitly in the same transaction so the response
      // count is honest; the FK CASCADE only backstops thread-level cascades.
      const removedEdgeCount = Number(
        database
          .prepare("DELETE FROM thread_tag_edges WHERE project_id=? AND tag_id=?")
          .run(projectId, tagId).changes,
      );
      database
        .prepare("DELETE FROM thread_tags WHERE project_id=? AND id=?")
        .run(projectId, tagId);
      return { body: { removedEdgeCount, tagId }, status: 200 as const };
    });
  } finally {
    database.close();
  }
}

function parseAssignmentInput(rawInput: unknown): { assigned: boolean; tagId: string } {
  if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput)) {
    invalidInput({ input: "invalid_format" });
  }
  const input = rawInput as Record<string, unknown>;
  const fields: Record<string, string> = {};
  for (const key of Object.keys(input)) {
    if (key !== "tagId" && key !== "assigned") fields[key] = "unknown";
  }
  if (!Object.hasOwn(input, "tagId")) {
    fields.tagId = "required";
  } else if (typeof input.tagId !== "string" || !RESOURCE_ID.test(input.tagId)) {
    fields.tagId = "invalid_format";
  }
  if (!Object.hasOwn(input, "assigned")) {
    fields.assigned = "required";
  } else if (typeof input.assigned !== "boolean") {
    fields.assigned = "invalid_format";
  }
  if (Object.keys(fields).length > 0) invalidInput(fields);
  return { assigned: input.assigned as boolean, tagId: input.tagId as string };
}

function requireAssignmentTuple(
  database: DatabaseSync,
  projectId: string,
  threadId: string,
  tagId: string,
): void {
  if (
    !database
      .prepare(
        `SELECT 1
         FROM collaboration_threads AS threads
         JOIN thread_tags AS tags ON tags.project_id=threads.project_id
         WHERE threads.project_id=? AND threads.id=? AND tags.id=?`,
      )
      .get(projectId, threadId, tagId)
  ) {
    resourceNotFound();
  }
}

// Tag assignments are an idempotent preference-class fact (025 favorites
// precedent): no operation receipt, no version column. ON CONFLICT DO NOTHING
// freezes the first edge's created_at across repeated assigns.
export function setThreadTagAssignment(
  databasePath: string,
  projectId: string,
  threadId: string,
  rawInput: unknown,
): { body: ThreadTagAssignmentResponse; status: 200 } {
  const input = parseAssignmentInput(rawInput);
  const database = openDatabase(databasePath);
  database.exec("PRAGMA busy_timeout=5000");
  try {
    return transaction(database, () => {
      requireAssignmentTuple(database, projectId, threadId, input.tagId);
      if (input.assigned) {
        database
          .prepare(
            `INSERT INTO thread_tag_edges(project_id,thread_id,tag_id,created_at)
             VALUES (?,?,?,?)
             ON CONFLICT(project_id,thread_id,tag_id) DO NOTHING`,
          )
          .run(projectId, threadId, input.tagId, new Date().toISOString());
      } else {
        database
          .prepare(
            `DELETE FROM thread_tag_edges
             WHERE project_id=? AND thread_id=? AND tag_id=?`,
          )
          .run(projectId, threadId, input.tagId);
      }
      const edge = database
        .prepare(
          `SELECT 1 FROM thread_tag_edges
           WHERE project_id=? AND thread_id=? AND tag_id=?`,
        )
        .get(projectId, threadId, input.tagId);
      return {
        body: {
          assigned: edge !== undefined,
          projectId,
          tagId: input.tagId,
          threadId,
        },
        status: 200 as const,
      };
    });
  } finally {
    database.close();
  }
}

type BatchInput = {
  addTagIds: string[];
  operationId: string;
  removeTagIds: string[];
  threadIds: string[];
};

function parseIdList(
  input: Record<string, unknown>,
  field: string,
  fields: Record<string, string>,
): string[] | undefined {
  const value = input[field];
  if (!Object.hasOwn(input, field)) {
    fields[field] = "required";
    return undefined;
  }
  if (
    !Array.isArray(value)
    || value.some((item) => typeof item !== "string" || !RESOURCE_ID.test(item))
  ) {
    fields[field] = "invalid_format";
    return undefined;
  }
  return value as string[];
}

function dedupePreservingOrder(values: string[]): string[] {
  return [...new Set(values)];
}

function parseBatchInput(rawInput: unknown): BatchInput {
  if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput)) {
    invalidInput({ input: "invalid_format" });
  }
  const input = rawInput as Record<string, unknown>;
  const fields: Record<string, string> = {};
  for (const key of Object.keys(input)) {
    if (!["operationId", "threadIds", "addTagIds", "removeTagIds"].includes(key)) {
      fields[key] = "unknown";
    }
  }
  let operationId: string | undefined;
  if (!Object.hasOwn(input, "operationId")) {
    fields.operationId = "required";
  } else if (
    typeof input.operationId !== "string"
    || !RESOURCE_ID.test(input.operationId)
  ) {
    fields.operationId = "invalid_format";
  } else {
    operationId = input.operationId;
  }
  const threadIds = parseIdList(input, "threadIds", fields);
  const addTagIds = parseIdList(input, "addTagIds", fields);
  const removeTagIds = parseIdList(input, "removeTagIds", fields);
  if (threadIds) {
    if (threadIds.length === 0) fields.threadIds = "required";
    else if (threadIds.length > BATCH_MAX_THREAD_IDS) {
      fields.threadIds = "too_many";
    }
  }
  // Duplicates are folded before the ceiling counts, so [alpha, alpha] is a
  // one-tag batch (dedupe is part of the batch contract, A-187).
  if (
    addTagIds
    && removeTagIds
    && new Set([...addTagIds, ...removeTagIds]).size > BATCH_MAX_TAG_IDS
  ) {
    fields.tagIds = "too_many";
  }
  if (Object.keys(fields).length > 0) invalidInput(fields);
  return {
    addTagIds: dedupePreservingOrder(addTagIds!),
    operationId: operationId!,
    removeTagIds: dedupePreservingOrder(removeTagIds!),
    threadIds: dedupePreservingOrder(threadIds!),
  };
}

function requireBatchThreads(
  database: DatabaseSync,
  projectId: string,
  threadIds: string[],
): void {
  if (threadIds.length === 0) return;
  const placeholders = threadIds.map(() => "?").join(",");
  const found = database
    .prepare(
      `SELECT count(*) AS count FROM collaboration_threads
       WHERE project_id=? AND id IN (${placeholders})`,
    )
    .get(projectId, ...threadIds) as { count: number };
  if (Number(found.count) !== threadIds.length) resourceNotFound();
}

function requireBatchTags(
  database: DatabaseSync,
  projectId: string,
  tagIds: string[],
): void {
  if (tagIds.length === 0) return;
  const placeholders = tagIds.map(() => "?").join(",");
  const found = database
    .prepare(
      `SELECT count(*) AS count FROM thread_tags
       WHERE project_id=? AND id IN (${placeholders})`,
    )
    .get(projectId, ...tagIds) as { count: number };
  if (Number(found.count) !== tagIds.length) resourceNotFound();
}

// Batch organize is a versioned write (A-187): a durable thread_tag_operations
// receipt short-circuits identical replays and rejects same-id different-input
// reuse, while the tuple check plus idempotent edge upsert/delete run in one
// transaction so a partial mismatch applies nothing and writes no receipt.
export function applyThreadTagBatch(
  databasePath: string,
  projectId: string,
  rawInput: unknown,
): { body: ThreadTagBatchResponse; status: 200 } {
  const input = parseBatchInput(rawInput);
  const database = openDatabase(databasePath);
  database.exec("PRAGMA busy_timeout=5000");
  try {
    return transaction(database, () => {
      ensureProject(database, projectId);
      const requestHash = canonicalRequestHash({
        addTagIds: input.addTagIds,
        removeTagIds: input.removeTagIds,
        threadIds: input.threadIds,
      });
      const prior = database
        .prepare(
          `SELECT request_hash AS requestHash, http_status AS httpStatus,
                  response_json AS responseJson
           FROM thread_tag_operations
           WHERE project_id=? AND id=?`,
        )
        .get(projectId, input.operationId) as
        | {
            httpStatus: number | null;
            requestHash: string;
            responseJson: string | null;
          }
        | undefined;
      if (prior) {
        if (
          prior.requestHash !== requestHash
          || prior.httpStatus === null
          || prior.responseJson === null
        ) {
          throw new CollaborationError(
            "OPERATION_CONFLICT",
            409,
            "Operation id was already used for different input.",
          );
        }
        const stored = JSON.parse(prior.responseJson) as Omit<
          ThreadTagBatchResponse,
          "replayed"
        >;
        return {
          body: { ...stored, replayed: true },
          status: 200 as const,
        };
      }

      requireBatchThreads(database, projectId, input.threadIds);
      requireBatchTags(
        database,
        projectId,
        [...new Set([...input.addTagIds, ...input.removeTagIds])],
      );

      // A tag listed in both lists is added then removed within the same batch
      // (the summary reports both effects honestly; the net edge does not stick).
      const timestamp = new Date().toISOString();
      const upsertEdge = database.prepare(
        `INSERT INTO thread_tag_edges(project_id,thread_id,tag_id,created_at)
         VALUES (?,?,?,?)
         ON CONFLICT(project_id,thread_id,tag_id) DO NOTHING`,
      );
      const deleteEdge = database.prepare(
        `DELETE FROM thread_tag_edges
         WHERE project_id=? AND thread_id=? AND tag_id=?`,
      );
      const applied = input.threadIds.map((threadId) => {
        const addedTagIds: string[] = [];
        for (const tagId of input.addTagIds) {
          if (Number(upsertEdge.run(projectId, threadId, tagId, timestamp).changes) === 1) {
            addedTagIds.push(tagId);
          }
        }
        const removedTagIds: string[] = [];
        for (const tagId of input.removeTagIds) {
          if (Number(deleteEdge.run(projectId, threadId, tagId).changes) === 1) {
            removedTagIds.push(tagId);
          }
        }
        return { addedTagIds, removedTagIds, threadId };
      });
      const response: Omit<ThreadTagBatchResponse, "replayed"> = {
        applied,
        operationId: input.operationId,
      };
      insertThreadTagOperationReceiptTx(database, {
        httpStatus: 200,
        id: input.operationId,
        projectId,
        requestHash,
        responseJson: JSON.stringify(response),
      });
      return {
        body: { ...response, replayed: false },
        status: 200 as const,
      };
    });
  } finally {
    database.close();
  }
}

// Write anchor for the thread_tag_operations receipt table (feature 032 T-01):
// T-03's applyThreadTagBatch persists its completed batch receipt through this
// primitive. Registering it with the schema keeps the write-ownership guard's
// "every table has at least one production writer" invariant honest (028/031
// anchor-writer precedent).
export function insertThreadTagOperationReceiptTx(
  database: DatabaseSync,
  input: {
    httpStatus: number;
    id: string;
    projectId: string;
    requestHash: string;
    responseJson: string;
  },
): void {
  database
    .prepare(
      `INSERT INTO thread_tag_operations(
         id,project_id,kind,request_hash,status,http_status,response_json,created_at
       ) VALUES (?,?,'tag_batch',?,'completed',?,?,?)`,
    )
    .run(
      input.id,
      input.projectId,
      input.requestHash,
      input.httpStatus,
      input.responseJson,
      new Date().toISOString(),
    );
}
