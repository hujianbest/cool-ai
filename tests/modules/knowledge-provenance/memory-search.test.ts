import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createMemory } from "@/src/adapters/outbound/sqlite/knowledge-provenance/memory-service";
import { createProject } from "@/src/adapters/outbound/sqlite/project-workspace/projects";
import { MemoryError } from "@/src/modules/knowledge-provenance";
import type { MemoryEntryV6, MemorySourceType, MemoryType } from "@/src/shared/memory-contracts";
import { memoryDatabasePath } from "@/tests/fixtures/sqlite/memory-database";

type SearchMemoriesOptions = {
  q: string;
  limit?: number;
  sourceType?: MemorySourceType;
  type?: MemoryType;
  version?: number;
};

type MemorySearchHit = {
  memory: MemoryEntryV6;
  snippet: string;
};

type MemorySearchModule = {
  searchMemories(
    databasePath: string,
    projectId: string,
    options: SearchMemoriesOptions,
  ): MemorySearchHit[];
};

const serviceModules = import.meta.glob<MemorySearchModule>(
  "../../../src/adapters/outbound/sqlite/knowledge-provenance/memory-service.ts",
);

let databasePath: string;

async function service(): Promise<MemorySearchModule> {
  const load =
    serviceModules[
      "../../../src/adapters/outbound/sqlite/knowledge-provenance/memory-service.ts"
    ];
  expect(load, "the sourced memory service must exist").toBeTypeOf("function");
  return load();
}

function ownerMemory(
  projectId: string,
  input: {
    content: string;
    sourceRef?: string;
    sourceType?: "artifact_path" | "owner_input";
    supersedesId?: string;
    type?: MemoryType;
  },
): MemoryEntryV6 {
  return createMemory(databasePath, projectId, {
    content: input.content,
    sourceRef: input.sourceRef ?? "Owner brief",
    sourceType: input.sourceType ?? "owner_input",
    type: input.type ?? "goal",
    ...(input.supersedesId ? { supersedesId: input.supersedesId } : {}),
  });
}

function contents(hits: MemorySearchHit[]): string[] {
  return hits.map((hit) => hit.memory.content);
}

beforeEach(() => {
  databasePath = memoryDatabasePath();
});

afterEach(() => {
});

describe("searchMemories", () => {
  it("matches content with ASCII case folding and returns a snippet", async () => {
    const memories = await service();
    const project = createProject("Search ASCII", databasePath);
    ownerMemory(project.id, { content: "Hello World Goal" });

    const hits = memories.searchMemories(databasePath, project.id, {
      q: "hello world",
    });

    expect(contents(hits)).toEqual(["Hello World Goal"]);
    expect(hits[0]?.snippet).toBe("Hello World Goal");
    expect(hits[0]?.memory.active).toBe(true);
  });

  it("matches a Chinese substring in content", async () => {
    const memories = await service();
    const project = createProject("Search Chinese", databasePath);
    ownerMemory(project.id, { content: "当前项目知识动态" });

    const hits = memories.searchMemories(databasePath, project.id, {
      q: "知识动态",
    });

    expect(contents(hits)).toEqual(["当前项目知识动态"]);
    expect(hits[0]?.snippet).toContain("知识动态");
  });

  it("filters by type, sourceType, and version", async () => {
    const memories = await service();
    const project = createProject("Search filters", databasePath);
    ownerMemory(project.id, {
      content: "Shared keyword goal",
      type: "goal",
    });
    ownerMemory(project.id, {
      content: "Shared keyword fact",
      type: "fact",
    });
    ownerMemory(project.id, {
      content: "Shared keyword artifact",
      sourceRef: "docs/note.md",
      sourceType: "artifact_path",
      type: "artifact",
    });
    const original = ownerMemory(project.id, {
      content: "Versioned original search",
      type: "decision",
    });
    const replacement = ownerMemory(project.id, {
      content: "Versioned replacement search",
      supersedesId: original.id,
      type: "decision",
    });

    expect(
      contents(
        memories.searchMemories(databasePath, project.id, {
          q: "Shared keyword",
          type: "goal",
        }),
      ),
    ).toEqual(["Shared keyword goal"]);
    expect(
      contents(
        memories.searchMemories(databasePath, project.id, {
          q: "Shared keyword",
          sourceType: "artifact_path",
        }),
      ),
    ).toEqual(["Shared keyword artifact"]);
    expect(
      memories.searchMemories(databasePath, project.id, {
        q: "Versioned",
        version: replacement.version,
      }).map((hit) => hit.memory.id),
    ).toEqual([replacement.id]);
    expect(
      memories.searchMemories(databasePath, project.id, {
        q: "Versioned",
        version: original.version,
      }),
    ).toEqual([]);
  });

  it("excludes a superseded parent and includes the replacement", async () => {
    const memories = await service();
    const project = createProject("Search supersede", databasePath);
    const parent = ownerMemory(project.id, { content: "Initial context goal" });
    const child = ownerMemory(project.id, {
      content: "Current context goal",
      supersedesId: parent.id,
    });

    const hits = memories.searchMemories(databasePath, project.id, {
      q: "context goal",
    });

    expect(contents(hits)).toEqual(["Current context goal"]);
    expect(hits.map((hit) => hit.memory.id)).toEqual([child.id]);
    expect(hits.some((hit) => hit.memory.id === parent.id)).toBe(false);
  });

  it("never returns another project's memories", async () => {
    const memories = await service();
    const projectA = createProject("Search project A", databasePath);
    const projectB = createProject("Search project B", databasePath);
    ownerMemory(projectA.id, { content: "Alpha unique phrase" });
    ownerMemory(projectB.id, { content: "Beta unique phrase" });

    expect(
      contents(
        memories.searchMemories(databasePath, projectA.id, {
          q: "Beta unique",
        }),
      ),
    ).toEqual([]);
    expect(
      contents(
        memories.searchMemories(databasePath, projectB.id, {
          q: "Beta unique",
        }),
      ),
    ).toEqual(["Beta unique phrase"]);
  });

  it("throws PROJECT_NOT_FOUND 404 when the project is missing", async () => {
    const memories = await service();

    try {
      memories.searchMemories(databasePath, "missing-project", { q: "goal" });
      expect.unreachable("missing project must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(MemoryError);
      expect(error).toMatchObject({
        code: "PROJECT_NOT_FOUND",
        httpStatus: 404,
      });
    }
  });

  it("returns an empty list when q matches no active memory", async () => {
    const memories = await service();
    const project = createProject("Search empty", databasePath);
    ownerMemory(project.id, { content: "Visible words only" });

    expect(
      memories.searchMemories(databasePath, project.id, { q: "zzz-no-match" }),
    ).toEqual([]);
  });

  it("builds a grapheme window snippet around the first match", async () => {
    const memories = await service();
    const project = createProject("Search snippet", databasePath);
    const content = `${"前".repeat(80)}UNIQUE_SNIPPET_TOKEN${"后".repeat(80)}`;
    ownerMemory(project.id, { content });

    const hits = memories.searchMemories(databasePath, project.id, {
      q: "UNIQUE_SNIPPET_TOKEN",
    });

    expect(hits).toHaveLength(1);
    expect(hits[0]?.snippet).toBe(
      `…${"前".repeat(60)}UNIQUE_SNIPPET_TOKEN${"后".repeat(60)}…`,
    );
  });
});
