import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  collaborationContextFingerprintFromDatabase,
  createContextSnapshotFromDatabase,
} from "@/src/server/context-snapshot-service";
import { openDatabase } from "@/src/server/db";

const MAX_PUBLIC_MESSAGES = 30;
const MAX_PUBLIC_MESSAGE_CHARACTERS = 60_000;

const PLATFORM_SYSTEM_PROMPT = [
  "You are participating in an auditable collaboration turn.",
  "Return only visible conclusions and structured actions; do not provide hidden chain-of-thought.",
  "The response must be a JSON object that follows the collaboration turn contract.",
].join("\n");

export type PublicMessageRow = {
  id: string;
  sequence: number;
  authorType: "owner" | "agent";
  authorAgentId: string | null;
  authorDisplayName: string;
  content: string;
  mentionAgentId: string | null;
  mentionDisplayName: string | null;
};

export type PromptMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type PromptSafeSharedContext = {
  project: {
    id: string;
    name: string;
    workspaceBound: true;
  };
  roster: Array<{
    agentId: string;
    joinedAt: string;
    name: string;
    role: string;
    model: string;
    avatarText: string;
    accentToken: string;
    skillNames: string[];
    permissions: {
      readFiles: boolean;
      writeFiles: boolean;
      runCommands: boolean;
    };
  }>;
  mission: {
    id: string;
    projectId: string;
    title: string;
    goal: string;
    version: number;
    createdAt: string;
    updatedAt: string;
  };
  workItems: Array<{
    id: string;
    missionId: string;
    title: string;
    description: string;
    status: "todo" | "in_progress" | "blocked" | "done";
    assigneeAgentId: string | null;
    dependencyIds: string[];
    version: number;
    createdAt: string;
    updatedAt: string;
  }>;
  memories: Array<{
    id: string;
    projectId: string;
    type: "goal" | "decision" | "fact" | "artifact";
    content: string;
    sourceType: "owner_input" | "work_item" | "artifact_path";
    sourceRef: string;
    createdBy: "owner";
    supersedesId: string | null;
    active: boolean;
    createdAt: string;
  }>;
};

export type CollaborationPromptSnapshot = {
  schemaVersion: 1;
  agentId: string;
  currentAgent: {
    id: string;
    name: string;
    role: string;
    systemPrompt: string;
    skills: Array<{ id: string; name: string; instructions: string }>;
    permissionSummary: {
      configured: {
        readFiles: boolean;
        writeFiles: boolean;
        runCommands: boolean;
      };
      collaborationTools: {
        fileRead: "unavailable";
        fileWrite: "unavailable";
        commandExecution: "unavailable";
        network: "unavailable";
      };
    };
  };
  sharedContext: PromptSafeSharedContext;
  publicMessages: PublicMessageRow[];
  includedMessageSequence: number;
  contextHash: string;
  promptHash: string;
  messages: PromptMessage[];
};

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

export function canonicalPromptHash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
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

export function collaborationPublicMessageWindow(
  database: DatabaseSync,
  projectId: string,
  maximumSequence?: number,
): PublicMessageRow[] {
  const newest = database
    .prepare(
      `SELECT id, sequence, author_type AS authorType,
              author_agent_id AS authorAgentId,
              author_display_name AS authorDisplayName, content,
              mention_agent_id AS mentionAgentId,
              mention_display_name AS mentionDisplayName
       FROM collaboration_messages
       WHERE project_id = ?
         AND (? IS NULL OR sequence <= ?)
       ORDER BY sequence DESC
       LIMIT ?`,
    )
    .all(
      projectId,
      maximumSequence ?? null,
      maximumSequence ?? null,
      MAX_PUBLIC_MESSAGES,
    ) as PublicMessageRow[];
  const selected: PublicMessageRow[] = [];
  let characters = 0;
  for (const message of newest) {
    if (characters + message.content.length > MAX_PUBLIC_MESSAGE_CHARACTERS) break;
    selected.push(message);
    characters += message.content.length;
  }
  return selected.reverse();
}

function promptMessages(
  currentAgent: CollaborationPromptSnapshot["currentAgent"],
  sharedContext: PromptSafeSharedContext,
  publicMessages: PublicMessageRow[],
): PromptMessage[] {
  const messages: PromptMessage[] = [
    { content: PLATFORM_SYSTEM_PROMPT, role: "system" },
    {
      content: JSON.stringify({
        currentAgent,
        scope: "current-agent-private-configuration",
      }),
      role: "system",
    },
    {
      content: JSON.stringify({
        projectContext: sharedContext,
        scope: "prompt-safe-shared-context",
      }),
      role: "system",
    },
  ];
  for (const message of publicMessages) {
    messages.push({
      content: JSON.stringify({
        authorAgentId: message.authorAgentId,
        authorDisplayName: message.authorDisplayName,
        content: message.content,
        mentionAgentId: message.mentionAgentId,
        mentionDisplayName: message.mentionDisplayName,
        sequence: message.sequence,
      }),
      role: message.authorType === "owner" ? "user" : "assistant",
    });
  }
  return messages;
}

export function acquireCollaborationPrompt(
  databasePath: string,
  projectId: string,
  agentId: string,
): CollaborationPromptSnapshot {
  const database = openDatabase(databasePath);
  database.exec("BEGIN");
  try {
    const snapshot = buildCollaborationPromptFromDatabase(database, projectId, agentId);
    database.exec("COMMIT");
    return snapshot;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the stable context error.
    }
    throw error;
  } finally {
    database.close();
  }
}

export function buildCollaborationPromptFromDatabase(
  database: DatabaseSync,
  projectId: string,
  agentId: string,
): CollaborationPromptSnapshot {
  const context = createContextSnapshotFromDatabase(database, projectId, agentId);
  const fingerprint = collaborationContextFingerprintFromDatabase(database, projectId);
  const publicMessages = collaborationPublicMessageWindow(database, projectId);
  const currentAgent: CollaborationPromptSnapshot["currentAgent"] = {
    id: context.currentAgent.id,
    name: context.currentAgent.name,
    permissionSummary: {
      collaborationTools: {
        commandExecution: "unavailable",
        fileRead: "unavailable",
        fileWrite: "unavailable",
        network: "unavailable",
      },
      configured: { ...context.currentAgent.permissions },
    },
    role: context.currentAgent.role,
    skills: context.currentAgent.skills.map((skill) => ({ ...skill })),
    systemPrompt: context.currentAgent.systemPrompt,
  };
  const sharedContext: PromptSafeSharedContext = {
    memories: context.shared.memories.map((memory) => ({ ...memory })),
    mission: { ...context.shared.mission },
    project: {
      id: context.shared.project.id,
      name: context.shared.project.name,
      workspaceBound: true,
    },
    roster: context.shared.roster.map((member) => ({
      ...member,
      permissions: { ...member.permissions },
      skillNames: [...member.skillNames],
    })),
    workItems: context.shared.workItems.map((item) => ({
      ...item,
      dependencyIds: [...item.dependencyIds],
    })),
  };
  const messages = promptMessages(currentAgent, sharedContext, publicMessages);
  return deepFreeze({
    agentId,
    contextHash: fingerprint.hash,
    currentAgent,
    includedMessageSequence: publicMessages.at(-1)?.sequence ?? 0,
    messages,
    promptHash: canonicalPromptHash(messages),
    publicMessages,
    schemaVersion: 1,
    sharedContext,
  });
}
