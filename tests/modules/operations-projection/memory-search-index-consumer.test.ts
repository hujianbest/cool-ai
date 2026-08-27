import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { createMemory } from "@/src/adapters/outbound/sqlite/knowledge-provenance/memory-service";
import { createProject } from "@/src/adapters/outbound/sqlite/project-workspace/projects";
import { memoryDatabasePath } from "@/tests/fixtures/sqlite/memory-database";

type ConsumerModule = {
  catchUpMemorySearchIndex(
    databasePath: string,
    projectId: string,
  ): {
    active: number;
    applied: number;
    indexed: number;
    version: number;
  };
};

const consumerModules = import.meta.glob<ConsumerModule>(
  "../../../src/adapters/outbound/sqlite/operations-projection/memory-search-index-consumer.ts",
);

let databasePath: string;

async function consumer(): Promise<ConsumerModule> {
  const load = consumerModules[
    "../../../src/adapters/outbound/sqlite/operations-projection/memory-search-index-consumer.ts"
  ];
  expect(load, "the memory search index consumer must exist").toBeTypeOf("function");
  return load();
}

beforeEach(() => {
  databasePath = memoryDatabasePath();
});

afterEach(() => {
  // memoryDatabasePath owns lifecycle cleanup.
});

describe("memory search index consumer", () => {
  it("indexes only active memory heads and advances a project-scoped watermark idempotently", async () => {
    const project = createProject("Memory health", databasePath);
    const first = createMemory(databasePath, project.id, {
      content: "Initial context goal",
      sourceRef: "Owner brief",
      sourceType: "owner_input",
      type: "goal",
    });
    createMemory(databasePath, project.id, {
      content: "Current context goal",
      sourceRef: "Owner revision",
      sourceType: "owner_input",
      supersedesId: first.id,
      type: "goal",
    });

    const module = await consumer();
    expect(module.catchUpMemorySearchIndex(databasePath, project.id)).toEqual({
      active: 1,
      applied: 1,
      indexed: 1,
      version: 1,
    });
    expect(module.catchUpMemorySearchIndex(databasePath, project.id)).toEqual({
      active: 1,
      applied: 0,
      indexed: 1,
      version: 1,
    });

    const database = openDatabase(databasePath);
    try {
      expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 29 });
      expect(database.prepare(`
        SELECT project_id AS projectId,search_text AS searchText,memory_version AS memoryVersion
        FROM memory_search_index
      `).all()).toEqual([{
        memoryVersion: 2,
        projectId: project.id,
        searchText: "Current context goal",
      }]);
      expect(database.prepare(`
        SELECT project_id AS projectId,status,version,active_count AS activeCount,
               indexed_count AS indexedCount
        FROM memory_search_index_state
      `).all()).toEqual([{
        activeCount: 1,
        indexedCount: 1,
        projectId: project.id,
        status: "idle",
        version: 1,
      }]);
    } finally {
      database.close();
    }
  });
});
