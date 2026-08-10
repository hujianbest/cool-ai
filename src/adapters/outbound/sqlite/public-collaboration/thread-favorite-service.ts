import type { DatabaseSync } from "node:sqlite";

import { CollaborationError } from "@/src/modules/public-collaboration";
import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import type { ThreadFavoriteSetResponse } from "@/src/shared/collaboration-contracts";

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
  throw new CollaborationError("INVALID_INPUT", 400, "Thread favorite input is invalid.", {
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

function parseFavoriteInput(rawInput: unknown): { favorite: boolean } {
  if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput)) {
    invalidInput({ input: "invalid_format" });
  }
  const input = rawInput as Record<string, unknown>;
  const fields: Record<string, string> = {};
  for (const key of Object.keys(input)) {
    if (key !== "favorite") fields[key] = "unknown";
  }
  if (!Object.hasOwn(input, "favorite")) {
    fields.favorite = "required";
  } else if (typeof input.favorite !== "boolean") {
    fields.favorite = "invalid_format";
  }
  if (Object.keys(fields).length > 0) invalidInput(fields);
  return { favorite: input.favorite as boolean };
}

function requireThreadTuple(
  database: DatabaseSync,
  projectId: string,
  threadId: string,
): void {
  if (
    !database
      .prepare("SELECT 1 FROM collaboration_threads WHERE project_id=? AND id=?")
      .get(projectId, threadId)
  ) {
    resourceNotFound();
  }
}

// Favorites are an idempotent preference-class fact (draft precedent): no
// operation receipt, no version column. A repeated `true` keeps the original
// created_at so the favorites view ordering stays stable across re-marks.
export function setThreadFavorite(
  databasePath: string,
  projectId: string,
  threadId: string,
  rawInput: unknown,
): { body: ThreadFavoriteSetResponse; status: 200 } {
  const input = parseFavoriteInput(rawInput);
  const database = openDatabase(databasePath);
  database.exec("PRAGMA busy_timeout=5000");
  try {
    return transaction(database, () => {
      requireThreadTuple(database, projectId, threadId);
      if (input.favorite) {
        database
          .prepare(
            `INSERT INTO thread_favorites(project_id,thread_id,created_at)
             VALUES (?,?,?)
             ON CONFLICT(project_id,thread_id) DO NOTHING`,
          )
          .run(projectId, threadId, new Date().toISOString());
      } else {
        database
          .prepare("DELETE FROM thread_favorites WHERE project_id=? AND thread_id=?")
          .run(projectId, threadId);
      }
      const row = database
        .prepare(
          `SELECT created_at AS favoritedAt
           FROM thread_favorites WHERE project_id=? AND thread_id=?`,
        )
        .get(projectId, threadId) as { favoritedAt: string } | undefined;
      return {
        body: {
          favoritedAt: row?.favoritedAt ?? null,
          isFavorite: row !== undefined,
          projectId,
          threadId,
        },
        status: 200 as const,
      };
    });
  } finally {
    database.close();
  }
}
