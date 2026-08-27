import { describe, expect, it } from "vitest";

import { createMemory } from "@/src/adapters/outbound/sqlite/knowledge-provenance/memory-service";
import { createProject } from "@/src/adapters/outbound/sqlite/project-workspace/projects";
import { memoryDatabasePath } from "@/tests/fixtures/sqlite/memory-database";

type KnowledgeGraphDto = {
  edges: Array<{ fromId: string; kind: string; toId: string }>;
  nodes: Array<{ id: string; title: string }>;
};

type GraphModule = {
  getKnowledgeGraph(databasePath: string, projectId: string): KnowledgeGraphDto;
};

const graphModules = import.meta.glob<GraphModule>(
  "../../../src/adapters/outbound/sqlite/knowledge-provenance/knowledge-graph.ts",
);

async function graphService(): Promise<GraphModule> {
  const load = graphModules[
    "../../../src/adapters/outbound/sqlite/knowledge-provenance/knowledge-graph.ts"
  ];
  expect(load, "the knowledge graph query must exist").toBeTypeOf("function");
  return load();
}

describe("knowledge graph", () => {
  it("returns sourced supersedes edges and isolates projects", async () => {
    const databasePath = memoryDatabasePath();
    const project = createProject("Graph A", databasePath);
    const other = createProject("Graph B", databasePath);
    const first = createMemory(databasePath, project.id, {
      content: "Use HMAC",
      sourceRef: "Owner brief",
      sourceType: "owner_input",
      type: "decision",
    });
    const second = createMemory(databasePath, project.id, {
      content: "Use RS256",
      sourceRef: "Owner brief",
      sourceType: "owner_input",
      supersedesId: first.id,
      type: "decision",
    });
    createMemory(databasePath, other.id, {
      content: "Other fact",
      sourceRef: "Owner brief",
      sourceType: "owner_input",
      type: "fact",
    });
    const service = await graphService();
    const graph = service.getKnowledgeGraph(databasePath, project.id);
    expect(graph.edges).toContainEqual({
      fromId: second.id,
      kind: "supersedes",
      toId: first.id,
    });
    expect(graph.nodes.some((node) => node.id === first.id)).toBe(true);
    expect(service.getKnowledgeGraph(databasePath, other.id).nodes.some((node) => node.id === first.id))
      .toBe(false);
    expect(() => service.getKnowledgeGraph(databasePath, "missing-project"))
      .toThrowError(/not found/i);
  });

  it("projects collection co-occurrence and omits memories outside the collection", async () => {
    const databasePath = memoryDatabasePath();
    const project = createProject("Graph C", databasePath);
    const first = createMemory(databasePath, project.id, {
      content: "HMAC note",
      sourceRef: "Owner brief",
      sourceType: "owner_input",
      type: "fact",
    });
    const second = createMemory(databasePath, project.id, {
      content: "RS256 note",
      sourceRef: "Owner brief",
      sourceType: "owner_input",
      type: "fact",
    });
    const outsider = createMemory(databasePath, project.id, {
      content: "Unrelated",
      sourceRef: "Owner brief",
      sourceType: "owner_input",
      type: "fact",
    });
    const { createMemoryCollection, addMemoryToCollection } = await import(
      "@/src/adapters/outbound/sqlite/knowledge-provenance/memory-collections"
    );
    const collection = createMemoryCollection(databasePath, project.id, { name: "架构决策" });
    addMemoryToCollection(databasePath, project.id, collection.id, { memoryId: first.id });
    addMemoryToCollection(databasePath, project.id, collection.id, { memoryId: second.id });
    const service = await graphService();
    const graph = service.getKnowledgeGraph(databasePath, project.id);
    const [fromId, toId] = [first.id, second.id].sort();
    expect(graph.edges).toContainEqual({
      fromId,
      kind: "collection",
      toId,
    });
    expect(graph.edges.some((edge) => edge.fromId === outsider.id || edge.toId === outsider.id))
      .toBe(false);
  });
});
