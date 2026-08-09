import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMission, createWorkItem } from "@/src/server/mission-service";
import { createProject } from "@/src/adapters/outbound/sqlite/project-workspace/projects";

type MemoryType = "goal" | "decision" | "fact" | "artifact";
type SourceType = "owner_input" | "work_item" | "artifact_path";
type MemoryEntry = {
  id: string;
  projectId: string;
  type: MemoryType;
  content: string;
  sourceType: SourceType;
  sourceRef: string;
  createdBy: "owner";
  supersedesId: string | null;
  active: boolean;
  createdAt: string;
};
type CreateMemoryInput = {
  type: MemoryType;
  content: string;
  sourceType: SourceType;
  sourceRef: string;
  supersedesId?: string;
};
type MemoryServiceModule = {
  createMemory(
    databasePath: string,
    projectId: string,
    input: CreateMemoryInput,
  ): MemoryEntry;
  listMemories(
    databasePath: string,
    projectId: string,
    includeInactive?: boolean,
  ): MemoryEntry[];
};

const serviceModules =
  import.meta.glob<MemoryServiceModule>("../src/server/memory-service.ts");

let directory: string;
let databasePath: string;
let missionOperationSequence: number;

async function service(): Promise<MemoryServiceModule> {
  const load = serviceModules["../src/server/memory-service.ts"];
  expect(load, "the sourced memory service must exist").toBeTypeOf("function");
  return load();
}

function projectWithWorkItem(name: string) {
  const project = createProject(name, databasePath);
  const mission = createMission(databasePath, project.id, {
    expectedVersion: 0,
    title: `${name} mission`,
    goal: `${name} goal`,
    operationId: `16000000-0000-4000-8000-${(++missionOperationSequence)
      .toString(16)
      .padStart(12, "0")}`,
  });
  const workItem = createWorkItem(databasePath, mission.id, {
    title: `${name} work`,
    description: "",
    assigneeAgentId: null,
    dependencyIds: [],
  });
  return { project, workItem };
}

function expectCode(operation: () => unknown, code: string): void {
  expect(operation).toThrowError(expect.objectContaining({ code }));
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cockpit-memory-service-"));
  databasePath = join(directory, "cockpit.sqlite");
  missionOperationSequence = 0;
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(directory, { force: true, recursive: true });
});

describe("append-only sourced memory service", () => {
  it("creates all four types with owner, work-item, and normalized artifact sources", async () => {
    const memories = await service();
    const { project, workItem } = projectWithWorkItem("Sources");
    const created = [
      memories.createMemory(databasePath, project.id, {
        type: "goal",
        content: "  Ship the slice  ",
        sourceType: "owner_input",
        sourceRef: "  Owner brief  ",
      }),
      memories.createMemory(databasePath, project.id, {
        type: "decision",
        content: "Use the current mission",
        sourceType: "work_item",
        sourceRef: workItem.id,
      }),
      memories.createMemory(databasePath, project.id, {
        type: "fact",
        content: "The plan is documented",
        sourceType: "artifact_path",
        sourceRef: "docs/./draft/../plan.md",
      }),
      memories.createMemory(databasePath, project.id, {
        type: "artifact",
        content: "A referenced output",
        sourceType: "artifact_path",
        sourceRef: "outputs/definitely-does-not-exist.txt",
      }),
    ];

    expect(created.map(({ type }) => type)).toEqual([
      "goal",
      "decision",
      "fact",
      "artifact",
    ]);
    expect(created[0]).toMatchObject({
      content: "Ship the slice",
      sourceRef: "Owner brief",
      createdBy: "owner",
      active: true,
      supersedesId: null,
    });
    expect(created[2].sourceRef).toBe("docs/plan.md");
    expect(created[3].sourceRef).toBe("outputs/definitely-does-not-exist.txt");
  });

  it("normalizes approved artifact examples lexically and rejects boundary escapes without fs", async () => {
    const memories = await service();
    const { project } = projectWithWorkItem("Artifacts");
    const accepted = [
      ["docs/plan.md", "docs/plan.md"],
      ["docs/./draft/../plan.md", "docs/plan.md"],
      ["a\\b\\..\\c.txt", "a/c.txt"],
      ["docs/%2e%2e/note", "docs/%2e%2e/note"],
    ];

    for (const [sourceRef, normalized] of accepted) {
      expect(
        memories.createMemory(databasePath, project.id, {
          type: "artifact",
          content: `Reference ${sourceRef}`,
          sourceType: "artifact_path",
          sourceRef,
        }).sourceRef,
      ).toBe(normalized);
    }

    for (const sourceRef of [
      "../secret",
      "a/../../secret",
      "/tmp/a",
      "C:\\a",
      "\\\\server\\share",
      "https://example.invalid/a",
      "bad\0path",
    ]) {
      expect(() =>
        memories.createMemory(databasePath, project.id, {
          type: "artifact",
          content: "Invalid artifact",
          sourceType: "artifact_path",
          sourceRef,
        }),
      ).toThrowError(
        expect.objectContaining({
          code: "INVALID_SOURCE",
          fields: [{ field: "sourceRef", code: "invalid_format" }],
        }),
      );
    }
  });

  it("enforces grapheme fields and same-project work-item sources", async () => {
    const memories = await service();
    const first = projectWithWorkItem("First");
    const second = projectWithWorkItem("Second");

    expect(
      memories.createMemory(databasePath, first.project.id, {
        type: "fact",
        content: "👨‍👩‍👧‍👦".repeat(20_000),
        sourceType: "owner_input",
        sourceRef: "来".repeat(2048),
      }),
    ).toMatchObject({ active: true });

    for (const input of [
      {
        type: "fact",
        content: " ",
        sourceType: "owner_input",
        sourceRef: "Owner",
      },
      {
        type: "fact",
        content: "内".repeat(20_001),
        sourceType: "owner_input",
        sourceRef: "Owner",
      },
      {
        type: "unknown",
        content: "Content",
        sourceType: "owner_input",
        sourceRef: "Owner",
      },
    ] as CreateMemoryInput[]) {
      expectCode(
        () => memories.createMemory(databasePath, first.project.id, input),
        "INVALID_INPUT",
      );
    }
    expect(() =>
      memories.createMemory(databasePath, first.project.id, {
        type: "fact",
        content: "Wrong project source",
        sourceType: "work_item",
        sourceRef: second.workItem.id,
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_SOURCE" }));
  });

  it("lists active entries deterministically and permits only one linear superseding child", async () => {
    const memories = await service();
    const first = projectWithWorkItem("Linear");
    const second = projectWithWorkItem("Other");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T13:00:00.000Z"));

    const base = memories.createMemory(databasePath, first.project.id, {
      type: "decision",
      content: "Original",
      sourceType: "owner_input",
      sourceRef: "Owner",
    });
    const child = memories.createMemory(databasePath, first.project.id, {
      type: "decision",
      content: "Replacement",
      sourceType: "owner_input",
      sourceRef: "Owner",
      supersedesId: base.id,
    });

    expect(memories.listMemories(databasePath, first.project.id)).toEqual([child]);
    expect(memories.listMemories(databasePath, first.project.id, true)).toEqual(
      [base, child]
        .map((entry) =>
          entry.id === base.id ? { ...entry, active: false } : entry,
        )
        .sort(
          (left, right) =>
            left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
        ),
    );

    expectCode(
      () =>
        memories.createMemory(databasePath, first.project.id, {
          type: "decision",
          content: "Concurrent branch",
          sourceType: "owner_input",
          sourceRef: "Owner",
          supersedesId: base.id,
        }),
      "MEMORY_NOT_ACTIVE",
    );
    expectCode(
      () =>
        memories.createMemory(databasePath, first.project.id, {
          type: "fact",
          content: "Wrong type",
          sourceType: "owner_input",
          sourceRef: "Owner",
          supersedesId: child.id,
        }),
      "MEMORY_TYPE_MISMATCH",
    );
    expectCode(
      () =>
        memories.createMemory(databasePath, second.project.id, {
          type: "decision",
          content: "Wrong project",
          sourceType: "owner_input",
          sourceRef: "Owner",
          supersedesId: child.id,
        }),
      "MEMORY_TYPE_MISMATCH",
    );
    expect(memories.listMemories(databasePath, first.project.id, true)).toHaveLength(2);
  });
});
