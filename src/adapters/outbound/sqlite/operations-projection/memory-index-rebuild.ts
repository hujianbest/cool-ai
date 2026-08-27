import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import {
  OperationsProjectionError,
  type MemoryIndexRebuildResult,
} from "@/src/modules/operations-projection";
import { catchUpMemorySearchIndex } from "./memory-search-index-consumer";

const CONFIRMATION = "重建记忆索引";

type RebuildInput = {
  confirmation: string;
  expectedVersion: number;
  operationId: string;
};

type StateRow = {
  operationHash: string | null;
  operationId: string | null;
  operationResultJson: string | null;
  status: "failed" | "idle" | "rebuilding";
  version: number;
};

type SourceRow = {
  chainId: string;
  content: string;
  createdAt: string;
  id: string;
  type: "artifact" | "decision" | "experience" | "fact" | "goal";
  version: number;
};

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function requestHash(input: RebuildInput): string {
  return sha256(JSON.stringify({
    confirmation: input.confirmation,
    expectedVersion: input.expectedVersion,
    operationId: input.operationId,
  }));
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

function readState(database: DatabaseSync, projectId: string): StateRow | undefined {
  return database.prepare(`
    SELECT status,version,operation_id AS operationId,operation_hash AS operationHash,
           operation_result_json AS operationResultJson
    FROM memory_search_index_state
    WHERE project_id=?
  `).get(projectId) as StateRow | undefined;
}

function ensureState(databasePath: string, projectId: string): void {
  const database = openDatabase(databasePath);
  let exists: boolean;
  try {
    exists = readState(database, projectId) !== undefined;
  } finally {
    database.close();
  }
  if (!exists) catchUpMemorySearchIndex(databasePath, projectId);
}

export function rebuildMemorySearchIndex(
  databasePath: string,
  projectId: string,
  input: RebuildInput,
): MemoryIndexRebuildResult {
  if (input.confirmation !== CONFIRMATION) {
    throw new OperationsProjectionError(
      "MEMORY_INDEX_CONFIRMATION_REQUIRED",
      "Memory index rebuild confirmation is required.",
    );
  }
  ensureState(databasePath, projectId);
  const hash = requestHash(input);
  const database = openDatabase(databasePath);
  try {
    return transaction(database, () => {
      const state = readState(database, projectId);
      if (state === undefined) {
        throw new OperationsProjectionError(
          "PROJECTION_CHECKPOINT_CORRUPT",
          "Memory search index checkpoint is corrupt.",
        );
      }
      if (state.operationId === input.operationId) {
        if (state.operationHash !== hash) {
          throw new OperationsProjectionError(
            "MEMORY_INDEX_OPERATION_CONFLICT",
            "Memory index rebuild operation conflicts with an existing request.",
          );
        }
        if (state.operationResultJson !== null) {
          return JSON.parse(state.operationResultJson) as MemoryIndexRebuildResult;
        }
        throw new OperationsProjectionError(
          "PROJECTION_REBUILD_IN_PROGRESS",
          "Memory search index is rebuilding.",
        );
      }
      if (state.status === "rebuilding") {
        throw new OperationsProjectionError(
          "PROJECTION_REBUILD_IN_PROGRESS",
          "Memory search index is rebuilding.",
        );
      }
      if (state.version !== input.expectedVersion) {
        throw new OperationsProjectionError(
          "MEMORY_INDEX_VERSION_CONFLICT",
          "Memory index version conflict.",
        );
      }

      const version = state.version + 1;
      const now = new Date().toISOString();
      database.prepare(`
        UPDATE memory_search_index_state
        SET status='rebuilding',version=?,operation_id=?,operation_hash=?,
            operation_result_json=NULL,last_error_code=NULL,updated_at=?
        WHERE project_id=?
      `).run(version, input.operationId, hash, now, projectId);
      database.prepare("DELETE FROM memory_search_index WHERE project_id=?").run(projectId);
      const source = database.prepare(`
        SELECT m.id,m.chain_id AS chainId,m.version,m.type,m.content,m.created_at AS createdAt
        FROM memory_entries m
        WHERE m.project_id=?
          AND NOT EXISTS(
            SELECT 1 FROM memory_entries successor
            WHERE successor.project_id=m.project_id AND successor.supersedes_id=m.id
          )
        ORDER BY m.created_at,m.id
      `).all(projectId) as unknown as SourceRow[];
      const insert = database.prepare(`
        INSERT INTO memory_search_index(
          project_id,memory_id,chain_id,memory_version,memory_type,search_text,
          content_sha256,source_created_at,indexed_at
        ) VALUES (?,?,?,?,?,?,?,?,?)
      `);
      for (const memory of source) {
        insert.run(
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
      }
      const indexed = (database.prepare(`
        SELECT COUNT(*) AS count FROM memory_search_index WHERE project_id=?
      `).get(projectId) as { count: number }).count;
      if (indexed !== source.length) {
        throw new OperationsProjectionError(
          "PROJECTION_REBUILD_INCOMPLETE",
          "Memory search index rebuild is incomplete.",
        );
      }
      const latest = database.prepare(`
        SELECT created_at AS createdAt,id FROM memory_entries
        WHERE project_id=? ORDER BY created_at DESC,id DESC LIMIT 1
      `).get(projectId) as { createdAt: string; id: string } | undefined;
      const result: MemoryIndexRebuildResult = {
        operationId: input.operationId,
        replayed: source.length,
        status: "caught_up",
        version,
      };
      database.prepare(`
        UPDATE memory_search_index_state
        SET status='idle',source_created_at=?,source_memory_id=?,
            active_count=?,indexed_count=?,operation_result_json=?,updated_at=?
        WHERE project_id=? AND version=? AND status='rebuilding'
      `).run(
        latest?.createdAt ?? null,
        latest?.id ?? null,
        source.length,
        source.length,
        JSON.stringify(result),
        now,
        projectId,
        version,
      );
      return result;
    });
  } finally {
    database.close();
  }
}
