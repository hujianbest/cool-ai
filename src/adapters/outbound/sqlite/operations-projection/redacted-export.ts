import { createHash } from "node:crypto";

import canonicalize from "canonicalize";

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { listProjectAuditEvents } from "@/src/adapters/outbound/sqlite/operations-projection/audit-projection-queries";
import {
  OperationsProjectionError,
  type RedactedExportDto,
} from "@/src/modules/operations-projection";

export type RedactedExportOptions = {
  now?: string;
  threadId?: string;
};

const EXPORT_LIMIT = 5000;
const AUDIT_PAGE = 100;
const TOO_LARGE = "Export is too large. Narrow the scope to one conversation.";

type MessageRow = RedactedExportDto["messages"][number];

function contentHash(payload: Omit<RedactedExportDto, "contentHash">): string {
  const canonical = canonicalize(payload);
  if (canonical === undefined) {
    throw new OperationsProjectionError("INVALID_INPUT", "Export payload could not be canonicalized.");
  }
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function collectAuditEvents(databasePath: string, projectId: string): RedactedExportDto["events"] {
  const events: RedactedExportDto["events"] = [];
  let beforeSeq: number | undefined;
  for (;;) {
    const page = listProjectAuditEvents(databasePath, projectId, {
      limit: AUDIT_PAGE,
      ...(beforeSeq === undefined ? {} : { beforeSeq }),
    });
    events.push(...page.events);
    if (events.length > EXPORT_LIMIT) {
      throw new OperationsProjectionError("EXPORT_TOO_LARGE", TOO_LARGE);
    }
    if (page.nextBeforeSeq === null) break;
    beforeSeq = page.nextBeforeSeq;
  }
  return events;
}

export function getRedactedExport(
  databasePath: string,
  projectId: string,
  options: RedactedExportOptions = {},
): RedactedExportDto {
  const database = openDatabase(databasePath);
  try {
    const project = database.prepare("SELECT 1 AS found FROM projects WHERE id=?").get(projectId);
    if (project === undefined) {
      throw new OperationsProjectionError("PROJECT_NOT_FOUND", "Project was not found.");
    }
    if (options.threadId !== undefined) {
      const thread = database.prepare(
        "SELECT 1 AS found FROM collaboration_threads WHERE project_id=? AND id=?",
      ).get(projectId, options.threadId);
      if (thread === undefined) {
        throw new OperationsProjectionError("THREAD_NOT_FOUND", "Thread was not found.");
      }
    }
    const messages = (
      database.prepare(`
        SELECT
          id,
          thread_id AS threadId,
          sequence,
          author_type AS authorType,
          author_display_name AS authorDisplayName,
          content,
          created_at AS createdAt
        FROM collaboration_messages
        WHERE project_id=? AND (? IS NULL OR thread_id=?)
        ORDER BY created_at, sequence, id
        LIMIT ?
      `).all(
        projectId,
        options.threadId ?? null,
        options.threadId ?? null,
        EXPORT_LIMIT + 1,
      ) as unknown as MessageRow[]
    );
    if (messages.length > EXPORT_LIMIT) {
      throw new OperationsProjectionError("EXPORT_TOO_LARGE", TOO_LARGE);
    }
    const unsigned: Omit<RedactedExportDto, "contentHash"> = {
      events: collectAuditEvents(databasePath, projectId),
      exportedAt: options.now ?? new Date().toISOString(),
      formatVersion: 1,
      messages,
      scope: {
        detail: "当前项目",
        projectId,
        threadId: options.threadId ?? null,
      },
    };
    return { ...unsigned, contentHash: contentHash(unsigned) };
  } finally {
    database.close();
  }
}
