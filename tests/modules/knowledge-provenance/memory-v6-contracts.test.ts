import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createMemory, listMemories } from "@/src/adapters/outbound/sqlite/knowledge-provenance/memory-service";
import { createProject } from "@/src/adapters/outbound/sqlite/project-workspace/projects";

type MemoryContractsModule = {
  memoryEntryV6Schema: {
    parse(value: unknown): any;
    safeParse(value: unknown): { success: boolean };
  };
};
const contractModules = import.meta.glob<MemoryContractsModule>(
  "../../../src/shared/memory-contracts.ts",
);

let directory: string;
let databasePath: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "memory-v6-contracts-"));
  databasePath = join(directory, "cockpit.sqlite");
});

afterEach(() => {
  rmSync(directory, { force: true, recursive: true });
});

async function contracts(): Promise<MemoryContractsModule> {
  const load = contractModules["../../../src/shared/memory-contracts.ts"];
  expect(load, "the memory v6 strict contract module must exist").toBeTypeOf("function");
  return load();
}

describe("memory v6 strict contracts", () => {
  it("accepts all five types and preserves owner actor and legacy source semantics", async () => {
    const { memoryEntryV6Schema } = await contracts();
    const project = createProject("Memory v6", databasePath);

    for (const type of ["goal", "decision", "fact", "artifact", "experience"] as const) {
      const memory = createMemory(databasePath, project.id, {
        content: `Owner ${type}`,
        sourceRef: "Owner brief",
        sourceType: "owner_input",
        type,
      });

      expect(memoryEntryV6Schema.parse(memory)).toMatchObject({
        actor: {
          confirmer: null,
          persistedBy: "platform",
          proposerAgent: null,
          proposerType: "owner",
        },
        source: {
          href: null,
          id: "Owner brief",
          type: "owner_input",
          version: null,
        },
        type,
      });
    }

    expect(listMemories(databasePath, project.id).map(({ type }) => type)).toEqual([
      "goal",
      "decision",
      "fact",
      "artifact",
      "experience",
    ]);
  });

  it("models Agent proposal, review confirmation, and platform persistence separately", async () => {
    const { memoryEntryV6Schema } = await contracts();
    const parsed = memoryEntryV6Schema.parse({
      active: true,
      actor: {
        confirmer: { decisionId: "decision-1", reviewAttemptId: "attempt-1" },
        persistedBy: "platform",
        proposerAgent: {
          accentToken: "sage",
          avatarText: "R",
          id: "reviewer-1",
          name: "Reviewer",
        },
        proposerType: "agent",
      },
      chainId: "memory-1",
      content: "A reviewed fact",
      createdAt: "2026-08-01T09:00:00.000Z",
      id: "memory-1",
      projectId: "project-1",
      source: {
        href: "/projects/project-1/tasks/task-1?version=3",
        id: "task-1",
        type: "task",
        version: "3",
      },
      supersedesId: null,
      type: "fact",
      version: 1,
    });

    expect(parsed.actor).toEqual({
      confirmer: { decisionId: "decision-1", reviewAttemptId: "attempt-1" },
      persistedBy: "platform",
      proposerAgent: {
        accentToken: "sage",
        avatarText: "R",
        id: "reviewer-1",
        name: "Reviewer",
      },
      proposerType: "agent",
    });
  });

  it.each([
    ["unknown memory type", { type: "unknown" }],
    ["unknown source type", { source: { type: "unknown" } }],
    ["extra top-level field", { leaked: "secret" }],
    ["extra actor field", { actor: { rawProviderBody: "secret" } }],
    ["extra source field", { source: { absolutePath: "D:\\secret" } }],
  ])("fails closed without echoing %s", async (_name, change) => {
    const { memoryEntryV6Schema } = await contracts();
    const changed = change as Record<string, any>;
    const valid = {
      active: true,
      actor: {
        confirmer: null,
        persistedBy: "platform",
        proposerAgent: null,
        proposerType: "owner",
      },
      chainId: "memory-1",
      content: "Safe",
      createdAt: "2026-08-01T09:00:00.000Z",
      id: "memory-1",
      projectId: "project-1",
      source: {
        href: null,
        id: "Owner",
        type: "owner_input",
        version: null,
      },
      supersedesId: null,
      type: "goal",
      version: 1,
    };
    const candidate = {
      ...valid,
      ...changed,
      actor: { ...valid.actor, ...(changed.actor ?? {}) },
      source: { ...valid.source, ...(changed.source ?? {}) },
    };
    const result = memoryEntryV6Schema.safeParse(candidate);

    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).not.toContain("secret");
  });
});
