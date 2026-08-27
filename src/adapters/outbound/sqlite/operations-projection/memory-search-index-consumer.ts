import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import {
  OperationsProjectionError,
  type MemorySearchIndexCatchUpResult,
} from "@/src/modules/operations-projection";

type ActiveMemoryRow = {
  chainId: string;
  content: string;
  createdAt: string;
  id: string;
  type: "artifact" | "decision" | "experience" | "fact" | "goal";
  version: number;
};

type ExistingIndexRow = {
  chainId: string;
  contentSha256: string;
  memoryId: string;
  memoryType: ActiveMemoryRow["type"];
  memoryVersion: number;
  searchText: string;
  sourceCreatedAt: string;
};

type StateRow = {
  status: "failed" | "idle" | "rebuilding";
  version: number;
};

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function transaction<T>(database: DatabaseSync, operation: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  }
}

function activeMemories(database: DatabaseSync, projectId: string): ActiveMemoryRow[] {
  return database.prepare(`
    SELECT m.id,m.chain_id AS chainId,m.version,m.type,m.content,m.created_at AS createdAt
    FROM memory_entries m
    WHERE m.project_id=?
      AND NOT EXISTS(
        SELECT 1 FROM memory_entries successor
        WHERE successor.project_id=m.project_id AND successor.supersedes_id=m.id
      )
    ORDER BY m.created_at,m.id
  `).all(projectId) as unknown as ActiveMemoryRow[];
}

function existingIndex(database: DatabaseSync, projectId: string): ExistingIndexRow[] {
  return database.prepare(`
    SELECT memory_id AS memoryId,chain_id AS chainId,memory_version AS memoryVersion,
           memory_type AS memoryType,search_text AS searchText,
           content_sha256 AS contentSha256,source_created_at AS sourceCreatedAt
    FROM memory_search_index
    WHERE project_id=?
    ORDER BY source_created_at,memory_id
  `).all(projectId) as unknown as ExistingIndexRow[];
}

function sameRow(existing: ExistingIndexRow, desired: ActiveMemoryRow): boolean {
  return existing.memoryId === desired.id
    && existing.chainId === desired.chainId
    && existing.memoryVersion === desired.version
    && existing.memoryType === desired.type
    && existing.searchText === desired.content
    && existing.contentSha256 === sha256(desired.content)
    && existing.sourceCreatedAt === desired.createdAt;
}

/**
 * Builds the project-scoped active-memory projection from immutable Knowledge
 * facts. The source scan is intentional: Knowledge has no public outbox, and
 * the canonical S-28 search remains independent of this derived index.
 */
export function catchUpMemorySearchIndex(
  databasePath: string,
  projectId: string,
): MemorySearchIndexCatchUpResult {
  const database = openDatabase(databasePath);
  try {
    return transaction(database, () => {
      const project = database.prepare("SELECT 1 AS found FROM projects WHERE id=?").get(projectId);
      if (project === undefined) {
        throw new OperationsProjectionError("PROJECT_NOT_FOUND", "Project was not found.");
      }
      const state = database.prepare(`
        SELECT status,version FROM memory_search_index_state WHERE project_id=?
      `).get(projectId) as StateRow | undefined;
      if (state?.status === "rebuilding") {
        throw new OperationsProjectionError(
          "PROJECTION_REBUILD_IN_PROGRESS",
          "Memory search index is rebuilding.",
        );
      }

      const desired = activeMemories(database, projectId);
      const current = existingIndex(database, projectId);
      const currentById = new Map(current.map((row) => [row.memoryId, row]));
      const desiredIds = new Set(desired.map(({ id }) => id));
      const now = new Date().toISOString();
      let applied = 0;

      for (const memory of desired) {
        const existing = currentById.get(memory.id);
        if (existing !== undefined && sameRow(existing, memory)) continue;
        database.prepare(`
          INSERT INTO memory_search_index(
            project_id,memory_id,chain_id,memory_version,memory_type,search_text,
            content_sha256,source_created_at,indexed_at
          ) VALUES (?,?,?,?,?,?,?,?,?)
          ON CONFLICT(project_id,memory_id) DO UPDATE SET
            chain_id=excluded.chain_id,
            memory_version=excluded.memory_version,
            memory_type=excluded.memory_type,
            search_text=excluded.search_text,
            content_sha256=excluded.content_sha256,
            source_created_at=excluded.source_created_at,
            indexed_at=excluded.indexed_at
        `).run(
          projectId,
          memory.id,
          memory.chainId,
          memory.version,
          memory.type,
          memory.content,
          sha256(memory.content),
          memory.createdAt,
          now,
        );
        applied += 1;
      }
      for (const row of current) {
        if (desiredIds.has(row.memoryId)) continue;
        applied += Number(database.prepare(`
          DELETE FROM memory_search_index WHERE project_id=? AND memory_id=?
        `).run(projectId, row.memoryId).changes);
      }

      const latest = database.prepare(`
        SELECT created_at AS createdAt,id
        FROM memory_entries
        WHERE project_id=?
        ORDER BY created_at DESC,id DESC
        LIMIT 1
      `).get(projectId) as { createdAt: string; id: string } | undefined;
      const version = state === undefined ? 1 : state.version + (applied > 0 ? 1 : 0);
      database.prepare(`
        INSERT INTO memory_search_index_state(
          project_id,status,version,source_created_at,source_memory_id,
          active_count,indexed_count,last_error_code,updated_at
        ) VALUES (?,'idle',?,?,?,?,?,NULL,?)
        ON CONFLICT(project_id) DO UPDATE SET
          status='idle',
          version=excluded.version,
          source_created_at=excluded.source_created_at,
          source_memory_id=excluded.source_memory_id,
          active_count=excluded.active_count,
          indexed_count=excluded.indexed_count,
          last_error_code=NULL,
          updated_at=excluded.updated_at
      `).run(
        projectId,
        version,
        latest?.createdAt ?? null,
        latest?.id ?? null,
        desired.length,
        desired.length,
        now,
      );

      return {
        active: desired.length,
        applied,
        indexed: desired.length,
        version,
      };
    });
  } finally {
    database.close();
  }
}
