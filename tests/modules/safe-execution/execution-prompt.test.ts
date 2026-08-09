import { describe, expect, it } from "vitest";

type PromptMessage = { role: "system" | "user"; content: string };
type ToolResult = {
  toolCallId: string;
  type: "list" | "read" | "write" | "command";
  status: "succeeded" | "rejected" | "failed" | "interrupted";
  code: string | null;
  path?: string;
  entries?: Array<{ name: string; kind: "file" | "directory"; size: number | null }>;
  content?: string;
  beforeHash?: string | null;
  afterHash?: string | null;
  exitCode?: number | null;
  durationMs?: number;
  stdout?: string;
  stderr?: string;
  truncated?: boolean;
};
type PromptInput = ReturnType<typeof fixture>;
type PromptResult = {
  schemaVersion: 1;
  contextHash: string;
  promptHash: string;
  internalContextBytes: number;
  toolResultSummary: {
    entries: ToolResult[];
    includedCount: number;
    omittedCount: number;
    truncated: boolean;
    bytes: number;
  };
  messages: PromptMessage[];
};
type PromptModule = {
  buildFrozenExecutionPrompt(input: PromptInput): PromptResult;
};

const modules = import.meta.glob<PromptModule>(
  "../../../src/modules/safe-execution/internal/execution-prompt-builder.ts",
);
const hash = (character: string) => character.repeat(64);

async function loadModule(): Promise<PromptModule> {
  const load = modules["../../../src/modules/safe-execution/internal/execution-prompt-builder.ts"];
  expect(load, "the frozen execution prompt builder must exist").toBeTypeOf("function");
  return load();
}

function fixture() {
  return {
    task: {
      id: "task-current",
      title: "Implement deterministic prompt",
      description: "Produce one visible structured action.",
      version: 7,
      status: "in_progress" as const,
      assigneeAgentId: "agent-current",
    },
    dependencies: [
      { id: "task-b", title: "Second byte-order item", status: "done" as const, version: 2 },
      { id: "task-a", title: "First byte-order item", status: "done" as const, version: 3 },
    ],
    mission: {
      id: "mission",
      title: "Safe execution",
      goal: "Complete work without leaking private configuration.",
      version: 4,
    },
    sharedContext: [
      { id: "memory-b", type: "fact" as const, content: "Public fact B", sourceRef: "owner" },
      { id: "memory-a", type: "decision" as const, content: "Public decision A", sourceRef: "owner" },
    ],
    members: [
      {
        agentId: "agent-other",
        name: "Other",
        role: "Reviewer",
        avatarText: "O",
        accentToken: "amber",
        skillNames: ["Review", "Audit"],
        permissions: { read: true, write: false, execute: false },
        systemPrompt: "OTHER_PRIVATE_SYSTEM_MUST_NOT_APPEAR",
        skills: [{ name: "Other private skill", instructions: "OTHER_PRIVATE_SKILL_MUST_NOT_APPEAR" }],
        providerKey: "OTHER_PROVIDER_KEY_MUST_NOT_APPEAR",
      },
      {
        agentId: "agent-current",
        name: "Current",
        role: "Builder",
        avatarText: "C",
        accentToken: "sage",
        skillNames: ["Build"],
        permissions: { read: true, write: true, execute: true },
      },
    ],
    publicCollaboration: [
      { sequence: 2, authorType: "agent" as const, authorAgentId: "agent-other", authorDisplayName: "Other", content: "Public reply" },
      { sequence: 1, authorType: "owner" as const, authorAgentId: null, authorDisplayName: "Owner", content: "Public request" },
    ],
    currentAgent: {
      id: "agent-current",
      name: "Current",
      role: "Builder",
      systemPrompt: "CURRENT_PRIVATE_SYSTEM_ALLOWED",
      skills: [
        { position: 1, id: "skill-b", version: 2, name: "Second", instructions: "SECOND_SKILL_BODY" },
        { position: 0, id: "skill-a", version: 3, name: "First", instructions: "FIRST_SKILL_BODY" },
      ],
      permissions: { read: true, write: true, execute: true },
      providerKey: "CURRENT_PROVIDER_KEY_MUST_NOT_APPEAR",
      providerCipher: "CIPHER_MUST_NOT_APPEAR",
      validationToken: "VALIDATION_TOKEN_MUST_NOT_APPEAR",
      hiddenThoughts: "HIDDEN_COT_MUST_NOT_APPEAR",
    },
    validationPolicy: {
      revisionId: "policy-revision",
      version: 5,
      policyHash: hash("a"),
      classifierVersion: 2,
      entries: [
        { position: 1, id: "policy-b", executable: "node", executableIdentity: hash("b"), args: ["b"], workdir: ".", required: false, tupleHash: hash("c") },
        { position: 0, id: "policy-a", executable: "npm", executableIdentity: hash("d"), args: ["test"], workdir: ".", required: true, tupleHash: hash("e") },
      ],
    },
    manifests: {
      baseline: { hash: hash("f"), fileCount: 12, totalBytes: 3456 },
      sandbox: { hash: hash("1"), fileCount: 12, totalBytes: 3456 },
      canonicalAbsolutePath: "D:\\canonical\\secret",
      sandboxHostPath: "C:\\state\\execution\\sandbox",
    },
    priorToolResults: [
      {
        toolCallId: "tool-2",
        type: "read" as const,
        status: "succeeded" as const,
        code: null,
        path: "src/b.ts",
        content: "second",
        truncated: false,
      },
      {
        toolCallId: "tool-1",
        type: "list" as const,
        status: "succeeded" as const,
        code: null,
        path: ".",
        entries: [{ name: "src", kind: "directory" as const, size: null }],
        truncated: false,
      },
    ],
    publicSummaries: [
      { sequence: 2, summary: "Later visible conclusion" },
      { sequence: 1, summary: "Earlier visible conclusion" },
    ],
    credentialRotation: {
      providerKey: "ROTATED_PROVIDER_KEY_MUST_NOT_APPEAR",
      credentialGeneration: 99,
      masterKey: "MASTER_KEY_MUST_NOT_APPEAR",
    },
    rawCommand: {
      env: { SECRET: "RAW_ENV_MUST_NOT_APPEAR" },
      stdout: "RAW_UNREDACTED_OUTPUT_MUST_NOT_APPEAR",
    },
  };
}

describe("frozen execution prompt", () => {
  it("builds stable canonical messages and hashes from ordered frozen facts", async () => {
    const { buildFrozenExecutionPrompt } = await loadModule();
    const original = fixture();
    const shuffled = fixture();
    shuffled.dependencies.reverse();
    shuffled.sharedContext.reverse();
    shuffled.members.reverse();
    shuffled.publicCollaboration.reverse();
    shuffled.validationPolicy.entries.reverse();
    shuffled.currentAgent.skills.reverse();
    shuffled.priorToolResults.reverse();
    shuffled.publicSummaries.reverse();

    const first = buildFrozenExecutionPrompt(original);
    const second = buildFrozenExecutionPrompt(shuffled);
    expect(first).toEqual(second);
    expect(first.contextHash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.promptHash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.messages[0]?.content).toMatch(/structured JSON|strict JSON/i);
    expect(first.messages[0]?.content).toMatch(/hidden chain-of-thought/i);

    const serialized = JSON.stringify(first.messages);
    expect(serialized.indexOf("FIRST_SKILL_BODY")).toBeLessThan(serialized.indexOf("SECOND_SKILL_BODY"));
    expect(serialized.indexOf("task-a")).toBeLessThan(serialized.indexOf("task-b"));
    expect(serialized.indexOf("Public request")).toBeLessThan(serialized.indexOf("Public reply"));
    expect(serialized.indexOf("tool-1")).toBeLessThan(serialized.indexOf("tool-2"));
  });

  it("includes only the current Agent private configuration and allowlisted redacted facts", async () => {
    const { buildFrozenExecutionPrompt } = await loadModule();
    const result = buildFrozenExecutionPrompt(fixture());
    const serialized = JSON.stringify(result);

    expect(serialized).toContain("CURRENT_PRIVATE_SYSTEM_ALLOWED");
    expect(serialized).toContain("FIRST_SKILL_BODY");
    for (const forbidden of [
      "OTHER_PRIVATE_SYSTEM_MUST_NOT_APPEAR",
      "OTHER_PRIVATE_SKILL_MUST_NOT_APPEAR",
      "OTHER_PROVIDER_KEY_MUST_NOT_APPEAR",
      "CURRENT_PROVIDER_KEY_MUST_NOT_APPEAR",
      "CIPHER_MUST_NOT_APPEAR",
      "VALIDATION_TOKEN_MUST_NOT_APPEAR",
      "HIDDEN_COT_MUST_NOT_APPEAR",
      "ROTATED_PROVIDER_KEY_MUST_NOT_APPEAR",
      "MASTER_KEY_MUST_NOT_APPEAR",
      "RAW_ENV_MUST_NOT_APPEAR",
      "RAW_UNREDACTED_OUTPUT_MUST_NOT_APPEAR",
      "D:\\\\canonical\\\\secret",
      "C:\\\\state\\\\execution\\\\sandbox",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(serialized).toContain("agent-other");
    expect(serialized).toContain("Review");
    expect(serialized).toContain(hash("f"));
  });

  it("keeps internal frozen context within 2 MiB and rejects an oversized whole entry", async () => {
    const { buildFrozenExecutionPrompt } = await loadModule();
    const nearLimit = fixture();
    nearLimit.sharedContext[0]!.content = "x".repeat(1_900_000);
    const result = buildFrozenExecutionPrompt(nearLimit);
    expect(result.internalContextBytes).toBeLessThanOrEqual(2_097_152);

    const oversized = fixture();
    oversized.currentAgent.systemPrompt = "x".repeat(2_097_152);
    expect(() => buildFrozenExecutionPrompt(oversized)).toThrow(/2 MiB|2097152|context limit/i);
  });

  it("bounds prior typed tool results to 64 KiB by whole entry with omitted counts", async () => {
    const { buildFrozenExecutionPrompt } = await loadModule();
    const input = fixture();
    input.priorToolResults = Array.from({ length: 8 }, (_, index) => ({
      toolCallId: `tool-${String(index).padStart(2, "0")}`,
      type: "read" as const,
      status: "succeeded" as const,
      code: null,
      path: `src/${index}.ts`,
      content: `${index}`.repeat(12_000),
      truncated: false,
    }));
    const result = buildFrozenExecutionPrompt(input);

    expect(result.toolResultSummary.bytes).toBeLessThanOrEqual(65_536);
    expect(result.toolResultSummary.truncated).toBe(true);
    expect(result.toolResultSummary.includedCount).toBeGreaterThan(0);
    expect(result.toolResultSummary.omittedCount).toBe(
      input.priorToolResults.length - result.toolResultSummary.includedCount,
    );
    for (const entry of result.toolResultSummary.entries) {
      const index = Number(entry.toolCallId.slice(-2));
      expect(entry.content).toBe(`${index}`.repeat(12_000));
    }
    const toolMessage = JSON.parse(result.messages.at(-1)!.content) as {
      summary: { omittedCount: number };
    };
    expect(toolMessage.summary.omittedCount).toBe(result.toolResultSummary.omittedCount);
  });
});
