import { describe, expect, it } from "vitest";

import { createMemory } from "@/src/adapters/outbound/sqlite/knowledge-provenance/memory-service";
import { createProject } from "@/src/adapters/outbound/sqlite/project-workspace/projects";
import { memoryDatabasePath } from "@/tests/fixtures/sqlite/memory-database";

type HealthDto = {
  coverage: { active: number; indexed: number; ratio: number; valid: number };
  freshness: { pending: number; status: "behind" | "caught_up" | "failed" | "rebuilding" };
  lastErrorCode: string | null;
  projectId: string;
  searchMode: "source_fallback";
  status: "behind" | "caught_up" | "failed" | "rebuilding";
  updatedAt: string;
  version: number;
};

type HealthModule = {
  getProjectMemoryIndexHealth(databasePath: string, projectId: string): HealthDto;
};

const healthModules = import.meta.glob<HealthModule>(
  "../../../src/adapters/outbound/sqlite/operations-projection/memory-index-health.ts",
);

async function healthService(): Promise<HealthModule> {
  const load = healthModules[
    "../../../src/adapters/outbound/sqlite/operations-projection/memory-index-health.ts"
  ];
  expect(load, "the memory index health query must exist").toBeTypeOf("function");
  return load();
}

describe("memory index health", () => {
  it("reports project-scoped active-head coverage without exposing memory content", async () => {
    const databasePath = memoryDatabasePath();
    const project = createProject("Memory health", databasePath);
    createMemory(databasePath, project.id, {
      content: "Private current context",
      sourceRef: "Owner brief",
      sourceType: "owner_input",
      type: "goal",
    });

    const service = await healthService();
    const health = service.getProjectMemoryIndexHealth(databasePath, project.id);
    expect(health).toMatchObject({
      coverage: { active: 1, indexed: 1, ratio: 1, valid: 1 },
      freshness: { pending: 0, status: "caught_up" },
      lastErrorCode: null,
      projectId: project.id,
      searchMode: "source_fallback",
      status: "caught_up",
      version: 1,
    });
    expect(JSON.stringify(health)).not.toContain("Private current context");
  });
});
