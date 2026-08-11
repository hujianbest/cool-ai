import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { CollaborationError } from "@/src/modules/public-collaboration";
import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { ensureActiveThread } from "@/src/adapters/outbound/sqlite/public-collaboration/active-thread-guards";
import type {
  AttachmentRemoveResponse,
  AttachmentUploadResponse,
  MessageAttachmentDto,
  MessageAttachmentMimeType,
  ThreadMessageAttachmentRefDto,
} from "@/src/shared/collaboration-contracts";

export const ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;

const RESOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$/;
const NAME_MAX_GRAPHEMES = 255;

const segmenter = new Intl.Segmenter("zh-CN", { granularity: "grapheme" });

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
  throw new CollaborationError("INVALID_INPUT", 400, "Attachment input is invalid.", {
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

function storageUnavailable(): never {
  throw new CollaborationError(
    "STORAGE_UNAVAILABLE",
    503,
    "Attachment storage is unavailable.",
  );
}

function sniffImageMime(bytes: Uint8Array): MessageAttachmentMimeType | null {
  if (
    bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 6
    && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38
    && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61
  ) {
    return "image/gif";
  }
  if (
    bytes.length >= 12
    && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

function parseFileName(rawName: unknown): string {
  if (typeof rawName !== "string") invalidInput({ name: "invalid_format" });
  const fileName = rawName.trim();
  const length = Array.from(segmenter.segment(fileName)).length;
  if (
    length < 1
    || length > NAME_MAX_GRAPHEMES
    || fileName.includes("/")
    || fileName.includes("\\")
    || fileName.includes("\0")
  ) {
    invalidInput({ name: "invalid_format" });
  }
  return fileName;
}

function parseBytes(bytes: Uint8Array): Uint8Array {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    invalidInput({ file: "required" });
  }
  if (bytes.byteLength > ATTACHMENT_MAX_BYTES) {
    throw new CollaborationError("BODY_TOO_LARGE", 413, "Request body is too large.");
  }
  return bytes;
}

// Attachment ids and project ids are server-side identities (UUID/RESOURCE_ID
// shape, no separators or dots), so the resolved target cannot escape the
// attachments root; the resolve+containment assertion below is the
// defense-in-depth boundary before any host filesystem touch.
function resolveStoragePath(
  attachmentsRoot: string,
  projectId: string,
  attachmentId: string,
): string {
  if (!RESOURCE_ID.test(projectId) || !RESOURCE_ID.test(attachmentId)) {
    storageUnavailable();
  }
  const base = resolve(attachmentsRoot);
  const target = resolve(base, projectId, attachmentId);
  if (dirname(target) !== resolve(base, projectId) || !target.startsWith(`${base}${sep}`)) {
    storageUnavailable();
  }
  return target;
}

type AttachmentRow = {
  createdAt: string;
  fileName: string;
  id: string;
  linkedAt: string | null;
  messageId: string | null;
  mimeType: MessageAttachmentMimeType;
  projectId: string;
  sha256: string;
  size: number;
  status: "uploaded" | "linked";
  threadId: string;
};

const ATTACHMENT_SELECT = `SELECT id,project_id AS projectId,thread_id AS threadId,
                                message_id AS messageId,file_name AS fileName,size,
                                mime_type AS mimeType,sha256,status,
                                created_at AS createdAt,linked_at AS linkedAt
                         FROM message_attachments`;

function mapAttachmentRow(row: AttachmentRow): MessageAttachmentDto {
  if (
    !RESOURCE_ID.test(row.id)
    || !RESOURCE_ID.test(row.projectId)
    || !RESOURCE_ID.test(row.threadId)
    || (row.messageId !== null && !RESOURCE_ID.test(row.messageId))
  ) {
    resourceNotFound();
  }
  return {
    createdAt: row.createdAt,
    fileName: row.fileName,
    id: row.id,
    linkedAt: row.linkedAt,
    messageId: row.messageId,
    mimeType: row.mimeType,
    projectId: row.projectId,
    sha256: row.sha256,
    size: row.size,
    status: row.status,
    threadId: row.threadId,
  };
}

function appendEventTx(
  database: DatabaseSync,
  input: {
    attachmentId: string;
    projectId: string;
    threadId: string;
    timestamp: string;
    type: "uploaded" | "linked" | "removed";
  },
): void {
  database
    .prepare(
      `INSERT INTO attachment_events(
         id,project_id,thread_id,attachment_id,type,created_at
       ) VALUES (?,?,?,?,?,?)`,
    )
    .run(randomUUID(), input.projectId, input.threadId, input.attachmentId, input.type, input.timestamp);
}

export function uploadAttachment(
  databasePath: string,
  attachmentsRoot: string,
  projectId: string,
  threadId: string,
  rawInput: { bytes: Uint8Array; fileName: unknown },
): { body: AttachmentUploadResponse; status: 200 | 201 } {
  const fileName = parseFileName(rawInput.fileName);
  const bytes = parseBytes(rawInput.bytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const database = openDatabase(databasePath);
  database.exec("PRAGMA busy_timeout=5000");
  try {
    return transaction(database, () => {
      ensureActiveThread(database, projectId, threadId);

      const existing = database
        .prepare(`${ATTACHMENT_SELECT} WHERE project_id=? AND thread_id=? AND sha256=?`)
        .get(projectId, threadId, sha256) as AttachmentRow | undefined;
      if (existing) {
        return {
          body: { attachment: mapAttachmentRow(existing), reused: true },
          status: 200 as const,
        };
      }

      const mimeType = sniffImageMime(bytes);
      if (mimeType === null) invalidInput({ file: "unsupported_type" });

      const attachmentId = randomUUID();
      const timestamp = new Date().toISOString();
      const target = resolveStoragePath(attachmentsRoot, projectId, attachmentId);
      database
        .prepare(
          `INSERT INTO message_attachments(
             id,project_id,thread_id,message_id,file_name,size,mime_type,sha256,
             storage_relpath,status,created_at,linked_at
           ) VALUES (?,?,?,NULL,?,?,?,?,?,'uploaded',?,NULL)`,
        )
        .run(
          attachmentId,
          projectId,
          threadId,
          fileName,
          bytes.byteLength,
          mimeType,
          sha256,
          `${projectId}/${attachmentId}`,
          timestamp,
        );
      appendEventTx(database, {
        attachmentId,
        projectId,
        threadId,
        timestamp,
        type: "uploaded",
      });
      try {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, bytes, { flag: "wx" });
      } catch {
        // The transaction rolls the row and event back; the partial file (if
        // any) is removed here so neither side of the fact survives a failure.
        try {
          rmSync(target, { force: true });
        } catch {
          // Best-effort compensation; the sanitized storage error stands.
        }
        storageUnavailable();
      }
      const row = database
        .prepare(`${ATTACHMENT_SELECT} WHERE project_id=? AND thread_id=? AND id=?`)
        .get(projectId, threadId, attachmentId) as AttachmentRow | undefined;
      if (!row) storageUnavailable();
      return {
        body: { attachment: mapAttachmentRow(row), reused: false },
        status: 201 as const,
      };
    });
  } finally {
    database.close();
  }
}

export function removeAttachment(
  databasePath: string,
  attachmentsRoot: string,
  projectId: string,
  threadId: string,
  attachmentId: string,
): { body: AttachmentRemoveResponse; status: 200 } {
  const database = openDatabase(databasePath);
  database.exec("PRAGMA busy_timeout=5000");
  try {
    return transaction(database, () => {
      ensureActiveThread(database, projectId, threadId);
      const row = database
        .prepare(`${ATTACHMENT_SELECT} WHERE project_id=? AND thread_id=? AND id=?`)
        .get(projectId, threadId, attachmentId) as AttachmentRow | undefined;
      if (!row) resourceNotFound();
      if (row.status !== "uploaded" || row.messageId !== null) {
        throw new CollaborationError(
          "ACTION_CONFLICT",
          409,
          "Attachment is already linked to a message.",
        );
      }
      const target = resolveStoragePath(attachmentsRoot, row.projectId, row.id);
      const timestamp = new Date().toISOString();
      appendEventTx(database, {
        attachmentId: row.id,
        projectId,
        threadId,
        timestamp,
        type: "removed",
      });
      database
        .prepare("DELETE FROM message_attachments WHERE project_id=? AND thread_id=? AND id=?")
        .run(projectId, threadId, row.id);
      try {
        unlinkSync(target);
      } catch {
        // Rolls the row delete and the audit event back, so a retained file
        // always keeps its uploaded row; the failure is reported, not silent.
        storageUnavailable();
      }
      return { body: { removed: true as const }, status: 200 as const };
    });
  } finally {
    database.close();
  }
}

// Message attachment refs are always read back in row insertion order so the
// write response and every later read agree on a single deterministic order.
export function readMessageAttachmentRefsTx(
  database: DatabaseSync,
  tuple: { messageId: string; projectId: string; threadId: string },
): ThreadMessageAttachmentRefDto[] {
  const rows = database
    .prepare(
      `SELECT id,file_name AS fileName,size,mime_type AS mimeType
       FROM message_attachments
       WHERE project_id=? AND thread_id=? AND message_id=? AND status='linked'
       ORDER BY rowid`,
    )
    .all(tuple.projectId, tuple.threadId, tuple.messageId) as Array<{
    fileName: string;
    id: string;
    mimeType: MessageAttachmentMimeType;
    size: number;
  }>;
  return rows.map((row) => {
    if (!RESOURCE_ID.test(row.id)) resourceNotFound();
    return {
      fileName: row.fileName,
      id: row.id,
      mimeType: row.mimeType,
      size: row.size,
    };
  });
}

// Link validation and update run inside the caller's message transaction:
// every id must belong to the same (project, thread) tuple, still be an
// uploaded orphan, and each row is claimed with a guarded UPDATE so a lost
// race fails closed instead of double-linking.
export function linkMessageAttachmentsTx(
  database: DatabaseSync,
  input: {
    attachmentIds: string[];
    messageId: string;
    projectId: string;
    threadId: string;
    timestamp: string;
  },
): void {
  const readRow = database.prepare(
    `SELECT status,message_id AS messageId
     FROM message_attachments
     WHERE project_id=? AND thread_id=? AND id=?`,
  );
  const claim = database.prepare(
    `UPDATE message_attachments
     SET status='linked',message_id=?,linked_at=?
     WHERE project_id=? AND thread_id=? AND id=?
       AND status='uploaded' AND message_id IS NULL`,
  );
  for (const attachmentId of input.attachmentIds) {
    const row = readRow.get(input.projectId, input.threadId, attachmentId) as
      | { messageId: string | null; status: string }
      | undefined;
    if (!row) {
      invalidInput({ attachmentIds: "not_found" });
    }
    if (row.status !== "uploaded" || row.messageId !== null) {
      invalidInput({ attachmentIds: "already_linked" });
    }
  }
  for (const attachmentId of input.attachmentIds) {
    const update = claim.run(
      input.messageId,
      input.timestamp,
      input.projectId,
      input.threadId,
      attachmentId,
    );
    if (update.changes !== 1) storageUnavailable();
    appendEventTx(database, {
      attachmentId,
      projectId: input.projectId,
      threadId: input.threadId,
      timestamp: input.timestamp,
      type: "linked",
    });
  }
}

export type AttachmentContent = {
  bytes: Uint8Array<ArrayBuffer>;
  mimeType: MessageAttachmentMimeType;
};

export function readAttachmentContent(
  databasePath: string,
  attachmentsRoot: string,
  projectId: string,
  threadId: string,
  attachmentId: string,
): AttachmentContent {
  const database = openDatabase(databasePath);
  try {
    ensureActiveThread(database, projectId, threadId);
    const row = database
      .prepare(
        `SELECT status,message_id AS messageId,mime_type AS mimeType
         FROM message_attachments
         WHERE project_id=? AND thread_id=? AND id=?`,
      )
      .get(projectId, threadId, attachmentId) as
      | {
          messageId: string | null;
          mimeType: MessageAttachmentMimeType;
          status: string;
        }
      | undefined;
    if (!row || row.status !== "linked" || row.messageId === null) {
      resourceNotFound();
    }
    const target = resolveStoragePath(attachmentsRoot, projectId, attachmentId);
    let file: Buffer;
    try {
      file = readFileSync(target);
    } catch {
      storageUnavailable();
    }
    const bytes = new Uint8Array(file.byteLength);
    bytes.set(file);
    return { bytes, mimeType: row.mimeType };
  } finally {
    database.close();
  }
}
