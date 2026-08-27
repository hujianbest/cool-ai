import { describe, expect, it } from "vitest";

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { getProjectMemoryIndexHealth } from "@/src/adapters/outbound/sqlite/operations-projection/memory-index-health";
import { createMemory } from "@/src/adapters/outbound/sqlite/knowledge-provenance/memory-service";
import { createProject } from "@/src/adapters/outbound/sqlite/project-workspace/projects";
import { memoryDatabasePath } from "@/tests/fixtures/sqlite/memory-database";

type RebuildModule = {
  rebuildMemorySearchIndex(
    databasePath: string,
    projectId: string,
    input: {
      confirmation: string;
      expectedVersion: number;
      operationId: string;
    },
  ): {
    operationId: string;
    replayed: number;
    status: "caught_up";
    version: number;
  };
};

const rebuildModules = import.meta.glob<RebuildModule>(
  "../../../src/adapters/outbound/sqlite/operations-projection/memory-index-rebuild.ts",
);

async function rebuildService(): Promise<RebuildModule> {
  const load = rebuildModules[
    "../../../src/adapters/outbound/sqlite/operations-projection/memory-index-rebuild.ts"
  ];
  expect(load, "the memory index rebuild command must exist").toBeTypeOf("function");
  return load();
}

describe("memory index rebuild", () => {
  it("repairs derived rows with version CAS and replays one completed operation", async () => {
    const databasePath = memoryDatabasePath();
    const project = createProject("Memory rebuild", databasePath);
    createMemory(databasePath, project.id, {
      content: "Canonical source survives",
      sourceRef: "Owner brief",
      sourceType: "owner_input",
      type: "fact",
    });
    expect(getProjectMemoryIndexHealth(databasePath, project.id).version).toBe(1);

    const database = openDatabase(databasePath);
    try {
      database.prepare(`
        UPDATE memory_search_index SET content_sha256=? WHERE project_id=?
      `).run("0".repeat(64), project.id);
    } finally {
      database.close();
    }

    const service = await rebuildService();
    const input = {
      confirmation: "重建记忆索引",
      expectedVersion: 1,
      operationId: "00000000-0000-4000-8000-000000000001",
    };
    const rebuilt = service.rebuildMemorySearchIndex(databasePath, project.id, input);
    expect(rebuilt).toEqual({
      operationId: input.operationId,
      replayed: 1,
      status: "caught_up",
      version: 2,
    });
    expect(service.rebuildMemorySearchIndex(databasePath, project.id, input)).toEqual(rebuilt);

    const reopened = openDatabase(databasePath);
    try {
      expect(reopened.prepare(`
        SELECT content FROM memory_entries WHERE project_id=?
      `).get(project.id)).toEqual({ content: "Canonical source survives" });
    } finally {
      reopened.close();
    }
  });
});
