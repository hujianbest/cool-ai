import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import {
  MemoryError,
  type MemoryCollectionCatalogDto,
  type MemoryCollectionDto,
} from "@/src/modules/knowledge-provenance";

const NAME_MAX_GRAPHEMES = 80;

type ChainRow = {
  chainId: string;
  id: string;
};

function ensureProject(database: DatabaseSync, projectId: string): void {
  if (!database.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId)) {
    throw new MemoryError("PROJECT_NOT_FOUND", 404, "Project was not found.");
  }
}

function ensureCollection(database: DatabaseSync, projectId: string, collectionId: string): void {
  if (
    database.prepare(
      "SELECT 1 FROM memory_collections WHERE project_id=? AND id=?",
    ).get(projectId, collectionId) === undefined
  ) {
    throw new MemoryError("COLLECTION_NOT_FOUND", 404, "Collection was not found.");
  }
}

function parseName(name: string): string {
  const trimmed = name.trim();
  const graphemes = [...trimmed];
  if (trimmed.length < 1 || graphemes.length > NAME_MAX_GRAPHEMES) {
    throw new MemoryError("INVALID_INPUT", 400, "Collection name is invalid.");
  }
  return trimmed;
}

function resolveProjectChain(
  database: DatabaseSync,
  projectId: string,
  memoryId: string,
): ChainRow {
  const row = database.prepare(
    "SELECT id, chain_id AS chainId FROM memory_entries WHERE project_id=? AND id=?",
  ).get(projectId, memoryId) as ChainRow | undefined;
  if (row === undefined) {
    throw new MemoryError("MEMORY_NOT_FOUND", 404, "Memory entry was not found.");
  }
  return row;
}

function withWrite<T>(databasePath: string, operation: (database: DatabaseSync) => T): T {
  const database = openDatabase(databasePath);
  try {
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation(database);
      database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Preserve the stable memory error.
      }
      throw error;
    }
  } finally {
    database.close();
  }
}

export function createMemoryCollection(
  databasePath: string,
  projectId: string,
  input: { name: string },
): MemoryCollectionDto {
  const name = parseName(input.name);
  const nameFold = name.toLocaleLowerCase("en-US");
  return withWrite(databasePath, (database) => {
    ensureProject(database, projectId);
    const existing = database.prepare(
      "SELECT 1 FROM memory_collections WHERE project_id=? AND name_fold=?",
    ).get(projectId, nameFold);
    if (existing !== undefined) {
      throw new MemoryError("COLLECTION_EXISTS", 409, "Collection already exists.");
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    database.prepare(`
      INSERT INTO memory_collections (
        id, project_id, name, name_fold, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 1, ?, ?)
    `).run(id, projectId, name, nameFold, now, now);
    return { id, name, projectId };
  });
}

export function addMemoryToCollection(
  databasePath: string,
  projectId: string,
  collectionId: string,
  input: { memoryId: string },
): void {
  withWrite(databasePath, (database) => {
    ensureProject(database, projectId);
    ensureCollection(database, projectId, collectionId);
    const chain = resolveProjectChain(database, projectId, input.memoryId);
    database.prepare(`
      INSERT INTO memory_collection_members (
        collection_id, project_id, chain_id, added_at
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(collection_id, chain_id) DO NOTHING
    `).run(collectionId, projectId, chain.chainId, new Date().toISOString());
  });
}

export function deleteMemoryCollection(
  databasePath: string,
  projectId: string,
  collectionId: string,
): void {
  withWrite(databasePath, (database) => {
    ensureProject(database, projectId);
    ensureCollection(database, projectId, collectionId);
    database.prepare("DELETE FROM memory_collections WHERE project_id=? AND id=?")
      .run(projectId, collectionId);
  });
}

export function removeMemoryFromCollection(
  databasePath: string,
  projectId: string,
  collectionId: string,
  input: { memoryId: string },
): void {
  withWrite(databasePath, (database) => {
    ensureProject(database, projectId);
    ensureCollection(database, projectId, collectionId);
    const chain = resolveProjectChain(database, projectId, input.memoryId);
    const removed = database.prepare(
      "DELETE FROM memory_collection_members WHERE collection_id=? AND chain_id=?",
    ).run(collectionId, chain.chainId);
    if (removed.changes === 0) {
      throw new MemoryError("MEMORY_NOT_FOUND", 404, "Memory entry was not found.");
    }
  });
}

export function listMemoryCollections(
  databasePath: string,
  projectId: string,
): MemoryCollectionCatalogDto[] {
  const database = openDatabase(databasePath);
  try {
    ensureProject(database, projectId);
    const collections = database.prepare(`
      SELECT id, name, project_id AS projectId
      FROM memory_collections
      WHERE project_id=?
      ORDER BY name, id
    `).all(projectId) as Array<{ id: string; name: string; projectId: string }>;
    return collections.map((collection) => {
      const memberRows = database.prepare(`
        SELECT
          member.chain_id AS chainId,
          (
            SELECT entry.id FROM memory_entries entry
            WHERE entry.project_id=member.project_id
              AND entry.chain_id=member.chain_id
              AND NOT EXISTS (
                SELECT 1 FROM memory_entries child WHERE child.supersedes_id = entry.id
              )
          ) AS memoryId
        FROM memory_collection_members member
        WHERE member.collection_id=?
        ORDER BY member.added_at, member.chain_id
      `).all(collection.id) as Array<{ chainId: string; memoryId: string | null }>;
      return {
        id: collection.id,
        members: memberRows.flatMap((member) => (
          member.memoryId === null
            ? []
            : [{ chainId: member.chainId, memoryId: member.memoryId }]
        )),
        name: collection.name,
        projectId: collection.projectId,
      };
    });
  } finally {
    database.close();
  }
}
