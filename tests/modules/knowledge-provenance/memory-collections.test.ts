import { describe, expect, it } from "vitest";

import { createMemory, listMemories } from "@/src/adapters/outbound/sqlite/knowledge-provenance/memory-service";
import { createProject } from "@/src/adapters/outbound/sqlite/project-workspace/projects";
import { memoryDatabasePath } from "@/tests/fixtures/sqlite/memory-database";

type MemoryCollectionDto = {
  id: string;
  name: string;
  projectId: string;
};

type CollectionCatalogDto = MemoryCollectionDto & {
  members: Array<{ chainId: string; memoryId: string }>;
};

type CollectionModule = {
  addMemoryToCollection(
    databasePath: string,
    projectId: string,
    collectionId: string,
    input: { memoryId: string },
  ): void;
  createMemoryCollection(
    databasePath: string,
    projectId: string,
    input: { name: string },
  ): MemoryCollectionDto;
  listMemoryCollections(
    databasePath: string,
    projectId: string,
  ): CollectionCatalogDto[];
  deleteMemoryCollection(
    databasePath: string,
    projectId: string,
    collectionId: string,
  ): void;
  removeMemoryFromCollection(
    databasePath: string,
    projectId: string,
    collectionId: string,
    input: { memoryId: string },
  ): void;
};

const collectionModules = import.meta.glob<CollectionModule>(
  "../../../src/adapters/outbound/sqlite/knowledge-provenance/memory-collections.ts",
);

async function collections(): Promise<CollectionModule> {
  const load = collectionModules[
    "../../../src/adapters/outbound/sqlite/knowledge-provenance/memory-collections.ts"
  ];
  expect(load, "the memory collection command must exist").toBeTypeOf("function");
  return load();
}

describe("memory collections", () => {
  it("creates a project-scoped collection with a unique name", async () => {
    const databasePath = memoryDatabasePath();
    const project = createProject("Collections A", databasePath);
    const other = createProject("Collections B", databasePath);
    const service = await collections();
    const created = service.createMemoryCollection(databasePath, project.id, { name: "架构决策" });
    expect(created).toMatchObject({ name: "架构决策", projectId: project.id });
    expect(created.id).toMatch(/^[A-Za-z0-9-]+$/u);
    expect(() => service.createMemoryCollection(databasePath, project.id, { name: "架构决策" }))
      .toThrowError(/already exists/i);
    const otherCollection = service.createMemoryCollection(databasePath, other.id, { name: "架构决策" });
    expect(otherCollection.projectId).toBe(other.id);
  });

  it("adds current-head members to the catalog and rejects unknown memories", async () => {
    const databasePath = memoryDatabasePath();
    const project = createProject("Catalog A", databasePath);
    const other = createProject("Catalog B", databasePath);
    const service = await collections();
    const collection = service.createMemoryCollection(databasePath, project.id, { name: "架构决策" });
    const memory = createMemory(databasePath, project.id, {
      content: "Use RS256",
      sourceRef: "Owner brief",
      sourceType: "owner_input",
      type: "decision",
    });
    const foreign = createMemory(databasePath, other.id, {
      content: "Other project fact",
      sourceRef: "Owner brief",
      sourceType: "owner_input",
      type: "fact",
    });

    service.addMemoryToCollection(databasePath, project.id, collection.id, { memoryId: memory.id });
    expect(service.listMemoryCollections(databasePath, project.id)).toEqual([
      {
        id: collection.id,
        members: [{ chainId: memory.id, memoryId: memory.id }],
        name: "架构决策",
        projectId: project.id,
      },
    ]);
    expect(service.listMemoryCollections(databasePath, other.id)).toEqual([]);

    expect(() => service.addMemoryToCollection(
      databasePath,
      project.id,
      collection.id,
      { memoryId: "missing-memory" },
    )).toThrowError(/not found/i);
    expect(() => service.addMemoryToCollection(
      databasePath,
      project.id,
      collection.id,
      { memoryId: foreign.id },
    )).toThrowError(/not found/i);

    service.removeMemoryFromCollection(databasePath, project.id, collection.id, {
      memoryId: memory.id,
    });
    expect(service.listMemoryCollections(databasePath, project.id)[0]?.members).toEqual([]);
  });

  it("deletes a collection without deleting source memories", async () => {
    const databasePath = memoryDatabasePath();
    const project = createProject("Delete Keep", databasePath);
    const service = await collections();
    const collection = service.createMemoryCollection(databasePath, project.id, { name: "架构决策" });
    const memory = createMemory(databasePath, project.id, {
      content: "Use RS256",
      sourceRef: "Owner brief",
      sourceType: "owner_input",
      type: "decision",
    });
    service.addMemoryToCollection(databasePath, project.id, collection.id, { memoryId: memory.id });
    service.deleteMemoryCollection(databasePath, project.id, collection.id);
    expect(service.listMemoryCollections(databasePath, project.id)).toEqual([]);
    expect(listMemories(databasePath, project.id).some((entry) => entry.id === memory.id)).toBe(true);
  });
});
