import { describe, expect, it } from "vitest";

type SchemaModule = {
  parseAgentTurnContent: (content: string) =>
    | { success: true; turn: Record<string, unknown> }
    | { success: false; turn: null };
};

const schemaModules = import.meta.glob<SchemaModule>(
  "../src/server/collaboration/agent-turn-schema.ts",
);

async function loadSchema(): Promise<SchemaModule> {
  const load = schemaModules["../src/server/collaboration/agent-turn-schema.ts"];
  expect(load, "the strict Agent turn schema must exist").toBeTypeOf("function");
  return load();
}

const task = {
  clientKey: "task_1",
  title: "Implement the parser",
  description: "Keep the output strict.",
  dependsOnKeys: [],
};

function turn(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    message: "I reviewed the mission.",
    tasks: [],
    claim: null,
    disposition: {
      type: "handoff",
      targetAgentId: "agent-2",
      summary: "Schema is ready.",
      reason: "A second agent should verify it.",
    },
    ...overrides,
  };
}

async function parses(value: unknown): Promise<boolean> {
  const { parseAgentTurnContent } = await loadSchema();
  return parseAgentTurnContent(JSON.stringify(value)).success;
}

describe("strict Agent turn schema", () => {
  it("accepts handoff and plan-ready with tasks and either claim union", async () => {
    await expect(parses(turn({
      tasks: [task],
      claim: { source: "proposed", clientKey: "task_1" },
    }))).resolves.toBe(true);
    await expect(parses(turn({
      claim: { source: "existing", workItemId: "work-1" },
      disposition: { type: "plan_ready" },
    }))).resolves.toBe(true);
  });

  it("requires exactly one deeply strict disposition shape", async () => {
    const unknownCases = [
      { ...turn(), unexpected: true },
      turn({ tasks: [{ ...task, unexpected: true }] }),
      turn({ claim: { source: "existing", workItemId: "work-1", unexpected: true } }),
      turn({
        disposition: {
          type: "handoff",
          targetAgentId: "agent-2",
          summary: "summary",
          reason: "reason",
          question: "also decide",
        },
      }),
      turn({ disposition: { type: "plan_ready", targetAgentId: "agent-2" } }),
    ];
    for (const value of unknownCases) {
      await expect(parses(value)).resolves.toBe(false);
    }
    await expect(parses(turn({ disposition: null }))).resolves.toBe(false);
    await expect(parses({ ...turn(), disposition: undefined })).resolves.toBe(false);
  });

  it("counts graphemes and enforces field, list, and clientKey bounds", async () => {
    await expect(parses(turn({ message: "👨‍👩‍👧‍👦".repeat(20_000) }))).resolves.toBe(true);
    await expect(parses(turn({ message: "👨‍👩‍👧‍👦".repeat(20_001) }))).resolves.toBe(false);
    await expect(parses(turn({ message: "   " }))).resolves.toBe(false);

    await expect(parses(turn({ tasks: Array.from({ length: 20 }, (_, index) => ({
      ...task,
      clientKey: `task_${index}`,
    })) }))).resolves.toBe(true);
    await expect(parses(turn({ tasks: Array.from({ length: 21 }, (_, index) => ({
      ...task,
      clientKey: `task_${index}`,
    })) }))).resolves.toBe(false);

    for (const clientKey of ["", "x".repeat(65), "contains space", "dot.key"]) {
      await expect(parses(turn({ tasks: [{ ...task, clientKey }] }))).resolves.toBe(false);
    }
    await expect(parses(turn({
      tasks: [{
        ...task,
        clientKey: "A-z_0-9",
        title: "x".repeat(160),
        description: "x".repeat(5_000),
        dependsOnKeys: Array.from({ length: 20 }, (_, index) => `task_${index}`),
      }],
    }))).resolves.toBe(true);
    await expect(parses(turn({ tasks: [{ ...task, title: "x".repeat(161) }] }))).resolves.toBe(false);
    await expect(parses(turn({
      tasks: [{ ...task, description: "x".repeat(5_001) }],
    }))).resolves.toBe(false);
    await expect(parses(turn({
      tasks: [{
        ...task,
        dependsOnKeys: Array.from({ length: 21 }, (_, index) => `task_${index}`),
      }],
    }))).resolves.toBe(false);
  });

  it("requires decision requests to have no tasks or claim", async () => {
    const decision = {
      type: "decision_request",
      question: "Which route?",
      options: ["Fast", "Careful"],
    };
    await expect(parses(turn({ disposition: decision }))).resolves.toBe(true);
    await expect(parses(turn({ tasks: [task], disposition: decision }))).resolves.toBe(false);
    await expect(parses(turn({
      claim: { source: "existing", workItemId: "work-1" },
      disposition: decision,
    }))).resolves.toBe(false);
  });

  it("enforces handoff, plan-ready, and decision option combinations", async () => {
    await expect(parses(turn({
      disposition: {
        type: "handoff",
        targetAgentId: "agent-2",
        summary: "x".repeat(5_000),
        reason: "x".repeat(5_000),
      },
    }))).resolves.toBe(true);
    await expect(parses(turn({
      disposition: {
        type: "handoff",
        targetAgentId: "agent-2",
        summary: "",
        reason: "reason",
      },
    }))).resolves.toBe(false);
    await expect(parses(turn({
      disposition: {
        type: "handoff",
        targetAgentId: "agent-2",
        summary: "summary",
        reason: "x".repeat(5_001),
      },
    }))).resolves.toBe(false);

    for (const options of [
      ["one"],
      Array.from({ length: 9 }, (_, index) => `${index}`),
      ["same", " same "],
      ["valid", ""],
      ["valid", "x".repeat(501)],
    ]) {
      await expect(parses(turn({
        disposition: { type: "decision_request", question: "Choose?", options },
      }))).resolves.toBe(false);
    }
    await expect(parses(turn({
      disposition: {
        type: "decision_request",
        question: "x".repeat(1_000),
        options: Array.from({ length: 8 }, (_, index) => `option-${index}`),
      },
    }))).resolves.toBe(true);
    await expect(parses(turn({
      disposition: {
        type: "decision_request",
        question: "x".repeat(1_001),
        options: ["yes", "no"],
      },
    }))).resolves.toBe(false);
  });

  it("rejects malformed JSON and incomplete existing/proposed claims", async () => {
    const { parseAgentTurnContent } = await loadSchema();
    expect(parseAgentTurnContent("not-json")).toEqual({ success: false, turn: null });
    await expect(parses(turn({ claim: { source: "existing", clientKey: "task_1" } }))).resolves.toBe(false);
    await expect(parses(turn({ claim: { source: "proposed", workItemId: "work-1" } }))).resolves.toBe(false);
    await expect(parses(turn({ claim: { source: "other", workItemId: "work-1" } }))).resolves.toBe(false);
  });

  it("accepts only strict Proposal and Checklist block shapes", async () => {
    const proposal = {
      actions: ["accept", "reject"],
      blockRevision: 1,
      blockSchemaVersion: 1,
      blockType: "proposal",
      body: "Adopt the design.",
      logicalBlockId: "proposal-1",
      title: "Design",
    };
    const checklist = {
      actions: ["check_item", "uncheck_item"],
      blockRevision: 1,
      blockSchemaVersion: 1,
      blockType: "checklist",
      items: [{ id: "item-1", text: "Run focused tests" }],
      logicalBlockId: "checklist-1",
      title: "Verification",
    };
    await expect(parses(turn({ blocks: [proposal, checklist] }))).resolves.toBe(true);
    await expect(parses(turn({ blocks: [] }))).resolves.toBe(true);
    await expect(parses(turn({
      blocks: [{ ...proposal, actions: ["accept", "execute"] }],
    }))).resolves.toBe(false);
    await expect(parses(turn({
      blocks: [{ ...proposal, body: "Authorization: Bearer exposed-value" }],
    }))).resolves.toBe(true);
    await expect(parses(turn({
      blocks: [{ ...proposal, unexpected: true }],
    }))).resolves.toBe(false);
  });

  it("enforces grapheme totals and spec block/file-reference quantity limits", async () => {
    const proposal = (index: number, body: string) => ({
      actions: ["accept", "reject"],
      blockRevision: 1,
      blockSchemaVersion: 1,
      blockType: "proposal",
      body,
      logicalBlockId: `proposal-${index}`,
      title: "e\u0301",
    });
    const exact = Array.from(
      { length: 4 },
      (_, index) => proposal(index, "👨‍👩‍👧‍👦".repeat(4_999)),
    );
    await expect(parses(turn({ blocks: exact }))).resolves.toBe(true);
    await expect(parses(turn({
      blocks: exact.map((block, index) =>
        index === 0 ? { ...block, body: `${block.body}界` } : block),
    }))).resolves.toBe(false);
    for (const count of [9, 10]) {
      await expect(parses(turn({
        blocks: Array.from({ length: count }, (_, index) => proposal(index, "ok")),
      }))).resolves.toBe(true);
    }
    await expect(parses(turn({
      blocks: Array.from({ length: 11 }, (_, index) => proposal(index, "ok")),
    }))).resolves.toBe(false);

    const diff = {
      blockRevision: 1,
      blockSchemaVersion: 1,
      blockType: "diff_preview",
      fileReferences: Array.from({ length: 99 }, (_, index) => `src/${index}.ts`),
      logicalBlockId: "diff",
      observationHash: "b".repeat(64),
      observationId: "observation",
      stagedResultId: "staged",
      title: "Diff",
    };
    await expect(parses(turn({ blocks: [diff] }))).resolves.toBe(true);
    await expect(parses(turn({
      blocks: [{ ...diff, fileReferences: [...diff.fileReferences, "src/99.ts"] }],
    }))).resolves.toBe(true);
    await expect(parses(turn({
      blocks: [{
        ...diff,
        fileReferences: [...diff.fileReferences, "src/99.ts", "src/overflow.ts"],
      }],
    }))).resolves.toBe(false);
  });

  it("accepts only identity-based Diff, File, and Handoff source references", async () => {
    const hash = "a".repeat(64);
    const readOnlyBlocks = [
      {
        blockRevision: 1,
        blockSchemaVersion: 1,
        blockType: "diff_preview",
        logicalBlockId: "diff-1",
        observationHash: hash,
        observationId: "observation-1",
        stagedResultId: "staged-1",
        title: "Diff",
      },
      {
        artifactHash: hash,
        artifactId: "artifact-1",
        blockRevision: 1,
        blockSchemaVersion: 1,
        blockType: "file_reference",
        executionId: "execution-1",
        logicalBlockId: "file-1",
        title: "File",
      },
      {
        blockRevision: 1,
        blockSchemaVersion: 1,
        blockType: "handoff_card",
        factId: "fact-1",
        logicalBlockId: "handoff-1",
        title: "Handoff",
        turnId: "turn-1",
      },
    ];
    await expect(parses(turn({ blocks: readOnlyBlocks }))).resolves.toBe(true);
    await expect(parses(turn({
      blocks: [{ ...readOnlyBlocks[1], latest: true, path: "D:\\secret" }],
    }))).resolves.toBe(false);
  });
});
