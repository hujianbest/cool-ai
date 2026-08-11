import type { DatabaseSync } from "node:sqlite";

import { CollaborationError } from "@/src/modules/public-collaboration";
import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { ensureActiveThread } from "@/src/adapters/outbound/sqlite/public-collaboration/active-thread-guards";
import { classifyPublicTextFromDatabaseConnection } from "@/src/adapters/outbound/sqlite/public-collaboration/public-text-credential-classifier";
import type {
  ThreadDraftAttachmentDto,
  ThreadDraftClearResponse,
  ThreadDraftDto,
  ThreadDraftReadResponse,
  ThreadDraftSaveResponse,
} from "@/src/shared/collaboration-contracts";

const RESOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$/;
const CONTENT_MAX_GRAPHEMES = 10_000;
const ATTACHMENT_NAME_MAX_GRAPHEMES = 255;
const ATTACHMENT_MAX_COUNT = 8;

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

function invalidInput(fields: Record<string, string>): never {
  throw new CollaborationError("INVALID_INPUT", 400, "Thread draft input is invalid.", {
    fields,
  });
}

type DraftInput = {
  attachments: ThreadDraftAttachmentDto[];
  content: string;
  replyToMessageId: string | null;
};

function parseDraftInput(rawInput: unknown): DraftInput {
  if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput)) {
    invalidInput({ input: "invalid_format" });
  }
  const input = rawInput as Record<string, unknown>;
  const allowedKeys = new Set(["attachments", "content", "replyToMessageId"]);
  const fields: Record<string, string> = {};
  for (const key of Object.keys(input)) {
    if (!allowedKeys.has(key)) fields[key] = "unknown";
  }
  for (const key of allowedKeys) {
    if (!Object.hasOwn(input, key)) fields[key] = "required";
  }

  const content = typeof input.content === "string" ? input.content : "";
  if (Object.hasOwn(input, "content")) {
    if (typeof input.content !== "string") fields.content = "invalid_format";
    else if (graphemeLength(content) > CONTENT_MAX_GRAPHEMES) fields.content = "too_long";
  }

  const attachments: ThreadDraftAttachmentDto[] = [];
  if (Object.hasOwn(input, "attachments")) {
    const rawAttachments = input.attachments;
    if (!Array.isArray(rawAttachments)) {
      fields.attachments = "invalid_format";
    } else if (rawAttachments.length > ATTACHMENT_MAX_COUNT) {
      fields.attachments = "invalid_range";
    } else {
      for (const rawAttachment of rawAttachments) {
        if (
          !rawAttachment
          || typeof rawAttachment !== "object"
          || Array.isArray(rawAttachment)
        ) {
          fields.attachments = "invalid_format";
          break;
        }
        const attachment = rawAttachment as Record<string, unknown>;
        const keys = Object.keys(attachment);
        const attachmentId = attachment.attachmentId;
        const name = attachment.name;
        const size = attachment.size;
        const hasReference = Object.hasOwn(attachment, "attachmentId");
        if (
          keys.length !== (hasReference ? 3 : 2)
          || !keys.includes("name")
          || !keys.includes("size")
          || (hasReference
            && (typeof attachmentId !== "string" || !RESOURCE_ID.test(attachmentId)))
          || typeof name !== "string"
          || graphemeLength(name) < 1
          || graphemeLength(name) > ATTACHMENT_NAME_MAX_GRAPHEMES
          || typeof size !== "number"
          || !Number.isSafeInteger(size)
          || size < 0
        ) {
          fields.attachments = "invalid_format";
          break;
        }
        attachments.push(
          hasReference
            ? { attachmentId: attachmentId as string, name, size }
            : { name, size },
        );
      }
    }
  }

  let replyToMessageId: string | null = null;
  if (Object.hasOwn(input, "replyToMessageId") && input.replyToMessageId !== null) {
    if (
      typeof input.replyToMessageId !== "string"
      || !RESOURCE_ID.test(input.replyToMessageId)
    ) {
      fields.replyToMessageId = "invalid_format";
    } else {
      replyToMessageId = input.replyToMessageId;
    }
  }

  if (Object.keys(fields).length > 0) invalidInput(fields);
  return { attachments, content, replyToMessageId };
}

type DraftRow = {
  attachmentsJson: string;
  content: string;
  projectId: string;
  replyToMessageId: string | null;
  threadId: string;
  updatedAt: string;
  version: number;
};

const DRAFT_SELECT = `SELECT project_id AS projectId,thread_id AS threadId,content,
                             attachments_json AS attachmentsJson,
                             reply_to_message_id AS replyToMessageId,version,
                             updated_at AS updatedAt
                      FROM thread_drafts`;

function readDraftRow(
  database: DatabaseSync,
  projectId: string,
  threadId: string,
): DraftRow | undefined {
  return database
    .prepare(`${DRAFT_SELECT} WHERE project_id=? AND thread_id=?`)
    .get(projectId, threadId) as DraftRow | undefined;
}

function mapDraftRow(row: DraftRow): ThreadDraftDto {
  return {
    attachments: JSON.parse(row.attachmentsJson) as ThreadDraftAttachmentDto[],
    content: row.content,
    projectId: row.projectId,
    replyToMessageId: row.replyToMessageId,
    threadId: row.threadId,
    updatedAt: row.updatedAt,
    version: row.version,
  };
}

function requireReplyTarget(
  database: DatabaseSync,
  projectId: string,
  threadId: string,
  replyToMessageId: string | null,
): void {
  if (replyToMessageId === null) return;
  const target = database
    .prepare(
      `SELECT 1 FROM collaboration_messages
       WHERE project_id=? AND thread_id=? AND id=?`,
    )
    .get(projectId, threadId, replyToMessageId);
  if (!target) invalidInput({ replyToMessageId: "not_found" });
}

export function saveThreadDraft(
  databasePath: string,
  projectId: string,
  threadId: string,
  rawInput: unknown,
): { body: ThreadDraftSaveResponse; status: 200 } {
  const input = parseDraftInput(rawInput);
  const database = openDatabase(databasePath);
  database.exec("PRAGMA busy_timeout=5000");
  try {
    return transaction(database, () => {
      ensureActiveThread(database, projectId, threadId);
      requireReplyTarget(database, projectId, threadId, input.replyToMessageId);
      const contentSaved =
        classifyPublicTextFromDatabaseConnection(database, input.content) === null;
      const timestamp = new Date().toISOString();
      database
        .prepare(
          `INSERT INTO thread_drafts(
             project_id,thread_id,content,attachments_json,reply_to_message_id,
             version,updated_at
           ) VALUES (?,?,?,?,?,1,?)
           ON CONFLICT(project_id,thread_id) DO UPDATE SET
             content=excluded.content,
             attachments_json=excluded.attachments_json,
             reply_to_message_id=excluded.reply_to_message_id,
             version=thread_drafts.version+1,
             updated_at=excluded.updated_at`,
        )
        .run(
          projectId,
          threadId,
          contentSaved ? input.content : "",
          JSON.stringify(input.attachments),
          input.replyToMessageId,
          timestamp,
        );
      const row = readDraftRow(database, projectId, threadId);
      if (!row) {
        throw new CollaborationError(
          "STORAGE_UNAVAILABLE",
          503,
          "Draft storage is unavailable.",
        );
      }
      return {
        body: { contentSaved, draft: mapDraftRow(row) },
        status: 200 as const,
      };
    });
  } finally {
    database.close();
  }
}

export function clearThreadDraft(
  databasePath: string,
  projectId: string,
  threadId: string,
): { body: ThreadDraftClearResponse; status: 200 } {
  const database = openDatabase(databasePath);
  database.exec("PRAGMA busy_timeout=5000");
  try {
    return transaction(database, () => {
      ensureActiveThread(database, projectId, threadId);
      database
        .prepare("DELETE FROM thread_drafts WHERE project_id=? AND thread_id=?")
        .run(projectId, threadId);
      return { body: { cleared: true as const }, status: 200 as const };
    });
  } finally {
    database.close();
  }
}

export function readThreadDraft(
  databasePath: string,
  projectId: string,
  threadId: string,
): { body: ThreadDraftReadResponse; status: 200 } {
  const database = openDatabase(databasePath);
  try {
    ensureActiveThread(database, projectId, threadId);
    const row = readDraftRow(database, projectId, threadId);
    return {
      body: { draft: row ? mapDraftRow(row) : null },
      status: 200,
    };
  } finally {
    database.close();
  }
}
