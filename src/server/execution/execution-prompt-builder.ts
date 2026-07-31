import { createHash } from "node:crypto";

import { EXECUTION_ACTION_SCHEMA_INSTRUCTIONS } from "./execution-action-schema";

const INTERNAL_CONTEXT_LIMIT = 2_097_152;
const TOOL_RESULT_SUMMARY_LIMIT = 65_536;

export type ExecutionPromptMessage = {
  role: "system" | "user";
  content: string;
};

export type FrozenExecutionPromptInput = {
  task: {
    id: string;
    title: string;
    description: string;
    version: number;
    status: "todo" | "in_progress" | "blocked" | "done";
    assigneeAgentId: string | null;
  };
  dependencies: Array<{
    id: string;
    title: string;
    status: "todo" | "in_progress" | "blocked" | "done";
    version: number;
  }>;
  mission: {
    id: string;
    title: string;
    goal: string;
    version: number;
  };
  sharedContext: Array<{
    id: string;
    type: "goal" | "decision" | "fact" | "artifact";
    content: string;
    sourceRef: string;
  }>;
  members: Array<{
    agentId: string;
    name: string;
    role: string;
    avatarText: string;
    accentToken: string;
    skillNames: string[];
    permissions: { read: boolean; write: boolean; execute: boolean };
  }>;
  publicCollaboration: Array<{
    sequence: number;
    authorType: "owner" | "agent";
    authorAgentId: string | null;
    authorDisplayName: string;
    content: string;
  }>;
  currentAgent: {
    id: string;
    name: string;
    role: string;
    systemPrompt: string;
    skills: Array<{
      position: number;
      id: string;
      version: number;
      name: string;
      instructions: string;
    }>;
    permissions: { read: boolean; write: boolean; execute: boolean };
  };
  validationPolicy: {
    revisionId: string;
    version: number;
    policyHash: string;
    classifierVersion: number;
    entries: Array<{
      position: number;
      id: string;
      executable: string;
      executableIdentity: string;
      args: string[];
      workdir: string;
      required: boolean;
      tupleHash: string;
    }>;
  };
  manifests: {
    baseline: { hash: string; fileCount: number; totalBytes: number };
    sandbox: { hash: string; fileCount: number; totalBytes: number } | null;
  };
  priorToolResults: ExecutionTypedToolResult[];
  publicSummaries: Array<{ sequence: number; summary: string }>;
};

export type ExecutionTypedToolResult = {
  toolCallId: string;
  type: "list" | "read" | "write" | "command";
  status: "succeeded" | "rejected" | "failed" | "interrupted";
  code: string | null;
  path?: string;
  entries?: Array<{
    name: string;
    kind: "file" | "directory";
    size: number | null;
  }>;
  content?: string;
  beforeHash?: string | null;
  afterHash?: string | null;
  exitCode?: number | null;
  durationMs?: number;
  stdout?: string;
  stderr?: string;
  truncated?: boolean;
};

export type ExecutionToolResultSummary = {
  entries: ExecutionTypedToolResult[];
  includedCount: number;
  omittedCount: number;
  truncated: boolean;
  bytes: number;
};

export type FrozenExecutionPrompt = {
  schemaVersion: 1;
  contextHash: string;
  promptHash: string;
  internalContextBytes: number;
  toolResultSummary: ExecutionToolResultSummary;
  messages: ExecutionPromptMessage[];
};

const PLATFORM_PROMPT = [
  "You are executing one frozen project task in an auditable sandbox.",
  EXECUTION_ACTION_SCHEMA_INSTRUCTIONS,
  "Use only the supplied relative sandbox paths and the declared tools.",
  "Return visible conclusions only. Never reveal or invent hidden chain-of-thought.",
].join("\n");

function compareUtf8(left: string, right: string): number {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => compareUtf8(left, right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function canonicalExecutionPromptHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function bytes(value: unknown): number {
  return Buffer.byteLength(canonicalJson(value), "utf8");
}

function copyPermissions(
  permissions: FrozenExecutionPromptInput["currentAgent"]["permissions"],
) {
  return {
    execute: permissions.execute,
    read: permissions.read,
    write: permissions.write,
  };
}

function sanitizeToolResult(result: ExecutionTypedToolResult): ExecutionTypedToolResult {
  const sanitized: ExecutionTypedToolResult = {
    code: result.code,
    status: result.status,
    toolCallId: result.toolCallId,
    type: result.type,
  };
  if (result.path !== undefined) sanitized.path = result.path;
  if (result.entries !== undefined) {
    sanitized.entries = result.entries
      .map((entry) => ({ kind: entry.kind, name: entry.name, size: entry.size }))
      .sort((left, right) => compareUtf8(left.name, right.name));
  }
  if (result.content !== undefined) sanitized.content = result.content;
  if (result.beforeHash !== undefined) sanitized.beforeHash = result.beforeHash;
  if (result.afterHash !== undefined) sanitized.afterHash = result.afterHash;
  if (result.exitCode !== undefined) sanitized.exitCode = result.exitCode;
  if (result.durationMs !== undefined) sanitized.durationMs = result.durationMs;
  if (result.stdout !== undefined) sanitized.stdout = result.stdout;
  if (result.stderr !== undefined) sanitized.stderr = result.stderr;
  if (result.truncated !== undefined) sanitized.truncated = result.truncated;
  return sanitized;
}

function summarizeToolResults(
  source: ExecutionTypedToolResult[],
): ExecutionToolResultSummary {
  const ordered = source
    .map(sanitizeToolResult)
    .sort((left, right) => compareUtf8(left.toolCallId, right.toolCallId));
  const entries: ExecutionTypedToolResult[] = [];

  const materialize = (
    selected: ExecutionTypedToolResult[],
  ): ExecutionToolResultSummary => {
    const summary: ExecutionToolResultSummary = {
      entries: selected,
      includedCount: selected.length,
      omittedCount: ordered.length - selected.length,
      truncated: selected.length < ordered.length,
      bytes: 0,
    };
    for (;;) {
      const measured = bytes(summary);
      if (measured === summary.bytes) return summary;
      summary.bytes = measured;
    }
  };

  for (const entry of ordered) {
    const candidateEntries = [...entries, entry];
    const candidate = materialize(candidateEntries);
    const modelEnvelope = { scope: "prior-typed-tool-results", summary: candidate };
    if (bytes(modelEnvelope) > TOOL_RESULT_SUMMARY_LIMIT) break;
    entries.push(entry);
  }

  const summary = materialize(entries);
  const modelEnvelope = { scope: "prior-typed-tool-results", summary };
  if (bytes(modelEnvelope) > TOOL_RESULT_SUMMARY_LIMIT) {
    throw new Error("The typed tool-result summary exceeds the 64 KiB limit.");
  }
  return summary;
}

function frozenContext(input: FrozenExecutionPromptInput) {
  const publicContext = {
    dependencies: input.dependencies
      .map((dependency) => ({
        id: dependency.id,
        status: dependency.status,
        title: dependency.title,
        version: dependency.version,
      }))
      .sort((left, right) => compareUtf8(left.id, right.id)),
    manifests: {
      baseline: {
        fileCount: input.manifests.baseline.fileCount,
        hash: input.manifests.baseline.hash,
        totalBytes: input.manifests.baseline.totalBytes,
      },
      sandbox: input.manifests.sandbox === null
        ? null
        : {
            fileCount: input.manifests.sandbox.fileCount,
            hash: input.manifests.sandbox.hash,
            totalBytes: input.manifests.sandbox.totalBytes,
          },
    },
    members: input.members
      .map((member) => ({
        accentToken: member.accentToken,
        agentId: member.agentId,
        avatarText: member.avatarText,
        name: member.name,
        permissions: copyPermissions(member.permissions),
        role: member.role,
        skillNames: [...member.skillNames].sort(compareUtf8),
      }))
      .sort((left, right) => compareUtf8(left.agentId, right.agentId)),
    mission: {
      goal: input.mission.goal,
      id: input.mission.id,
      title: input.mission.title,
      version: input.mission.version,
    },
    publicCollaboration: input.publicCollaboration
      .map((message) => ({
        authorAgentId: message.authorAgentId,
        authorDisplayName: message.authorDisplayName,
        authorType: message.authorType,
        content: message.content,
        sequence: message.sequence,
      }))
      .sort((left, right) => left.sequence - right.sequence),
    publicSummaries: input.publicSummaries
      .map((summary) => ({ sequence: summary.sequence, summary: summary.summary }))
      .sort((left, right) => left.sequence - right.sequence),
    sharedContext: input.sharedContext
      .map((entry) => ({
        content: entry.content,
        id: entry.id,
        sourceRef: entry.sourceRef,
        type: entry.type,
      }))
      .sort((left, right) => compareUtf8(left.id, right.id)),
    task: {
      assigneeAgentId: input.task.assigneeAgentId,
      description: input.task.description,
      id: input.task.id,
      status: input.task.status,
      title: input.task.title,
      version: input.task.version,
    },
    validationPolicy: {
      classifierVersion: input.validationPolicy.classifierVersion,
      entries: input.validationPolicy.entries
        .map((entry) => ({
          args: [...entry.args],
          executable: entry.executable,
          executableIdentity: entry.executableIdentity,
          id: entry.id,
          position: entry.position,
          required: entry.required,
          tupleHash: entry.tupleHash,
          workdir: entry.workdir,
        }))
        .sort((left, right) => left.position - right.position || compareUtf8(left.id, right.id)),
      policyHash: input.validationPolicy.policyHash,
      revisionId: input.validationPolicy.revisionId,
      version: input.validationPolicy.version,
    },
  };
  const privateContext = {
    currentAgent: {
      id: input.currentAgent.id,
      name: input.currentAgent.name,
      permissions: copyPermissions(input.currentAgent.permissions),
      role: input.currentAgent.role,
      skills: input.currentAgent.skills
        .map((skill) => ({
          id: skill.id,
          instructions: skill.instructions,
          name: skill.name,
          position: skill.position,
          version: skill.version,
        }))
        .sort((left, right) => left.position - right.position || compareUtf8(left.id, right.id)),
      systemPrompt: input.currentAgent.systemPrompt,
    },
  };
  return { privateContext, publicContext };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

export function buildFrozenExecutionPrompt(
  input: FrozenExecutionPromptInput,
): FrozenExecutionPrompt {
  const context = frozenContext(input);
  const internalContextBytes = bytes(context);
  if (internalContextBytes > INTERNAL_CONTEXT_LIMIT) {
    throw new Error("Frozen execution context exceeds the 2 MiB context limit.");
  }
  const contextHash = canonicalExecutionPromptHash(context);
  const toolResultSummary = summarizeToolResults(input.priorToolResults);
  const messages: ExecutionPromptMessage[] = [
    { role: "system", content: PLATFORM_PROMPT },
    {
      role: "system",
      content: canonicalJson({
        currentAgent: context.privateContext.currentAgent,
        scope: "current-agent-private-configuration",
      }),
    },
    {
      role: "system",
      content: canonicalJson({
        contextHash,
        frozen: context.publicContext,
        scope: "frozen-public-execution-context",
      }),
    },
    {
      role: "user",
      content: canonicalJson({
        scope: "prior-typed-tool-results",
        summary: toolResultSummary,
      }),
    },
  ];
  return deepFreeze({
    contextHash,
    internalContextBytes,
    messages,
    promptHash: canonicalExecutionPromptHash(messages),
    schemaVersion: 1,
    toolResultSummary,
  });
}
