import { createHash } from "node:crypto";

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import {
  OperationsProjectionError,
  type MemoryIndexHealthStatus,
  type ProjectMemoryIndexHealthDto,
} from "@/src/modules/operations-projection";
import { catchUpMemorySearchIndex } from "./memory-search-index-consumer";

type StateRow = {
  lastErrorCode: string | null;
  status: "failed" | "idle" | "rebuilding";
  updatedAt: string;
  version: number;
};

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function getProjectMemoryIndexHealth(
  databasePath: string,
  projectId: string,
): ProjectMemoryIndexHealthDto {
  const before = openDatabase(databasePath);
  let shouldCatchUp = false;
  try {
    const project = before.prepare("SELECT 1 AS found FROM projects WHERE id=?").get(projectId);
    if (project === undefined) {
      throw new OperationsProjectionError("PROJECT_NOT_FOUND", "Project was not found.");
    }
    const state = before.prepare(`
      SELECT status,version,last_error_code AS lastErrorCode,updated_at AS updatedAt
      FROM memory_search_index_state
      WHERE project_id=?
    `).get(projectId) as StateRow | undefined;
    if (state?.status === "idle" || state === undefined) {
      shouldCatchUp = true;
    }
  } finally {
    before.close();
  }
  if (shouldCatchUp) catchUpMemorySearchIndex(databasePath, projectId);

  const database = openDatabase(databasePath);
  try {
    const state = database.prepare(`
      SELECT status,version,last_error_code AS lastErrorCode,updated_at AS updatedAt
      FROM memory_search_index_state
      WHERE project_id=?
    `).get(projectId) as StateRow | undefined;
    if (state === undefined) {
      throw new OperationsProjectionError(
        "PROJECTION_CHECKPOINT_CORRUPT",
        "Memory search index checkpoint is corrupt.",
      );
    }
    const activeRows = database.prepare(`
      SELECT m.id,m.content
      FROM memory_entries m
      WHERE m.project_id=?
        AND NOT EXISTS(
          SELECT 1 FROM memory_entries successor
          WHERE successor.project_id=m.project_id AND successor.supersedes_id=m.id
        )
    `).all(projectId) as unknown as Array<{ content: string; id: string }>;
    const indexRows = database.prepare(`
      SELECT memory_id AS memoryId,content_sha256 AS contentSha256
      FROM memory_search_index
      WHERE project_id=?
    `).all(projectId) as unknown as Array<{
      contentSha256: string;
      memoryId: string;
    }>;
    const expectedHashes = new Map(activeRows.map((row) => [row.id, sha256(row.content)]));
    const valid = indexRows.reduce(
      (count, row) =>
        count + (expectedHashes.get(row.memoryId) === row.contentSha256 ? 1 : 0),
      0,
    );
    const active = activeRows.length;
    const ratio = active === 0 ? 1 : valid / active;
    let status: MemoryIndexHealthStatus;
    if (state.status === "rebuilding") {
      status = "rebuilding";
    } else if (state.status === "failed") {
      status = "failed";
    } else {
      status = valid === active && indexRows.length === active ? "caught_up" : "behind";
    }
    return {
      coverage: {
        active,
        indexed: indexRows.length,
        ratio,
        valid,
      },
      freshness: {
        pending: Math.max(active - valid, 0),
        status,
      },
      lastErrorCode: state.lastErrorCode,
      projectId,
      searchMode: "source_fallback",
      status,
      updatedAt: state.updatedAt,
      version: state.version,
    };
  } finally {
    database.close();
  }
}
