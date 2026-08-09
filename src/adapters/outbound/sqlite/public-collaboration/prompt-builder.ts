import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  createContextSnapshotFromDatabase,
} from "@/src/application/workflows/project-context-snapshot";
import {
  CollaborationError,
} from "@/src/modules/public-collaboration";
import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";

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
  threadId: string;
  policyVersion: number;
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
  threadId?: string,
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
         AND (? IS NULL OR thread_id = ?)
         AND (? IS NULL OR sequence <= ?)
       ORDER BY sequence DESC
       LIMIT ?`,
    )
    .all(
      projectId,
      threadId ?? null,
      threadId ?? null,
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
  scope: {
    includedMessageSequence: number;
    policyVersion: number;
    threadId: string;
  },
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
        ...scope,
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
  threadId: string,
  agentId: string,
): CollaborationPromptSnapshot {
  const database = openDatabase(databasePath);
  database.exec("BEGIN");
  try {
    const snapshot = buildCollaborationPromptFromDatabase(
      database,
      projectId,
      threadId,
      agentId,
    );
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
  threadId: string,
  agentId: string,
  maximumMessageSequence?: number,
): CollaborationPromptSnapshot {
  const thread = database
    .prepare(
      `SELECT active_policy_revision_id AS revisionId,
              policy_version AS policyVersion
       FROM collaboration_threads
       WHERE project_id=? AND id=?`,
    )
    .get(projectId, threadId) as
    | { revisionId: string; policyVersion: number }
    | undefined;
  if (!thread) {
    throw new CollaborationError("RESOURCE_NOT_FOUND", 404, "Resource was not found.");
  }
  const context = createContextSnapshotFromDatabase(database, projectId, agentId);
  const policyRows = database
    .prepare(
      `SELECT policy.agent_id AS agentId, policy.position,
              membership.joined_at AS joinedAt,
              agents.version AS agentVersion,
              providers.id AS providerId,
              providers.version AS providerVersion,
              providers.credential_version AS credentialVersion,
              providers.credential_generation AS credentialGeneration,
              providers.verified_at AS verifiedAt
       FROM collaboration_thread_policy_members AS policy
       LEFT JOIN project_memberships AS membership
         ON membership.project_id=policy.project_id
        AND membership.agent_id=policy.agent_id
       LEFT JOIN agents ON agents.id=membership.agent_id
       LEFT JOIN providers ON providers.id=agents.provider_id
       WHERE policy.project_id=? AND policy.thread_id=? AND policy.revision_id=?
       ORDER BY policy.position ASC,policy.agent_id ASC`,
    )
    .all(projectId, threadId, thread.revisionId) as Array<{
    agentId: string;
    position: number;
    joinedAt: string | null;
    agentVersion: number | null;
    providerId: string | null;
    providerVersion: number | null;
    credentialVersion: number | null;
    credentialGeneration: number | null;
    verifiedAt: string | null;
  }>;
  if (
    policyRows.length < 2
    || policyRows.some(
      ({ agentVersion, joinedAt, providerId }) =>
        joinedAt === null || agentVersion === null || providerId === null,
    )
    || !policyRows.some(({ agentId: policyAgentId }) => policyAgentId === agentId)
  ) {
    throw new CollaborationError(
      "THREAD_POLICY_REPAIR_REQUIRED",
      409,
      "Thread policy requires repair.",
    );
  }
  const projectRoster = new Map(
    context.shared.roster.map((member) => [member.agentId, member]),
  );
  const policyRoster = policyRows.map(({ agentId: policyAgentId }) => {
    const member = projectRoster.get(policyAgentId);
    if (!member) {
      throw new CollaborationError(
        "THREAD_POLICY_REPAIR_REQUIRED",
        409,
        "Thread policy requires repair.",
      );
    }
    return member;
  });
  const publicMessages = collaborationPublicMessageWindow(
    database,
    projectId,
    maximumMessageSequence,
    threadId,
  );
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
    roster: policyRoster.map((member) => ({
      ...member,
      permissions: { ...member.permissions },
      skillNames: [...member.skillNames],
    })),
    workItems: context.shared.workItems.map((item) => ({
      ...item,
      dependencyIds: [...item.dependencyIds],
    })),
  };
  const includedMessageSequence = publicMessages.at(-1)?.sequence ?? 0;
  const scope = {
    includedMessageSequence,
    policyVersion: thread.policyVersion,
    threadId,
  };
  const messages = promptMessages(currentAgent, sharedContext, publicMessages, scope);
  const contextHash = canonicalPromptHash({
    currentAgent,
    policyConfiguration: policyRows,
    publicMessages,
    scope,
    sharedContext,
  });
  return deepFreeze({
    agentId,
    contextHash,
    currentAgent,
    includedMessageSequence,
    messages,
    policyVersion: thread.policyVersion,
    promptHash: canonicalPromptHash(messages),
    publicMessages,
    schemaVersion: 1,
    sharedContext,
    threadId,
  });
}
