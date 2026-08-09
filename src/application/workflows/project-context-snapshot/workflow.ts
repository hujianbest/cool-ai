import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import type {
  MemoryEntry,
  Mission,
  ProjectContextSnapshot,
  ProjectMember,
  WorkItem,
  WorkItemStatus,
} from "@/src/shared/project-context-contracts";

type MissingContext = "workspace" | "members" | "mission";
type ProjectRow = {
  id: string;
  name: string;
  workspacePath: string | null;
};
type AgentRow = {
  id: string;
  name: string;
  role: string;
  systemPrompt: string;
  canRead: number;
  canWrite: number;
  canExecute: number;
};
type RosterRow = {
  agentId: string;
  joinedAt: string;
  name: string;
  role: string;
  model: string;
  avatarText: string;
  accentToken: string;
  canRead: number;
  canWrite: number;
  canExecute: number;
};
type WorkItemRow = Omit<WorkItem, "dependencyIds" | "status"> & {
  status: WorkItemStatus;
};
type MemoryRow = Omit<MemoryEntry, "active">;

export type CollaborationContextFacts = {
  schemaVersion: 1;
  roster: Array<{ agentId: string; joinedAt: string }>;
  mission: {
    id: string;
    title: string;
    goal: string;
    version: number;
  };
  workItems: Array<{
    id: string;
    title: string;
    description: string;
    status: WorkItemStatus;
    assigneeAgentId: string | null;
    dependencyIds: string[];
    version: number;
  }>;
};

export type CollaborationContextFingerprint = {
  facts: CollaborationContextFacts;
  hash: string;
};

export type AcquiredContextDisposition =
  | { category: null; disposition: "current" }
  | { category: "context_changed"; disposition: "discarded" };

export class ContextSnapshotError extends Error {
  constructor(
    public readonly code: string,
    public readonly httpStatus: number,
    message: string,
    public readonly missing?: MissingContext[],
  ) {
    super(message);
    this.name = "ContextSnapshotError";
  }
}

function permissions(row: {
  canRead: number;
  canWrite: number;
  canExecute: number;
}) {
  return {
    readFiles: row.canRead === 1,
    runCommands: row.canExecute === 1,
    writeFiles: row.canWrite === 1,
  };
}

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

function rosterSkillNames(database: DatabaseSync, agentId: string): string[] {
  return (
    database
      .prepare(
        `SELECT skills.name
         FROM agent_skills
         JOIN skills ON skills.id = agent_skills.skill_id
         WHERE agent_skills.agent_id = ?
         ORDER BY agent_skills.position ASC, skills.id ASC`,
      )
      .all(agentId) as Array<{ name: string }>
  ).map(({ name }) => name);
}

function roster(database: DatabaseSync, projectId: string): ProjectMember[] {
  const rows = database
    .prepare(
      `SELECT
         memberships.agent_id AS agentId,
         memberships.joined_at AS joinedAt,
         agents.name,
         agents.role,
         agents.model,
         agents.avatar_text AS avatarText,
         agents.accent_token AS accentToken,
         agents.can_read AS canRead,
         agents.can_write AS canWrite,
         agents.can_execute AS canExecute
       FROM project_memberships memberships
       JOIN agents ON agents.id = memberships.agent_id
       WHERE memberships.project_id = ?
       ORDER BY memberships.joined_at ASC, memberships.agent_id ASC`,
    )
    .all(projectId) as RosterRow[];
  return rows.map((row) => ({
    accentToken: row.accentToken,
    agentId: row.agentId,
    avatarText: row.avatarText,
    joinedAt: row.joinedAt,
    model: row.model,
    name: row.name,
    permissions: permissions(row),
    role: row.role,
    skillNames: rosterSkillNames(database, row.agentId),
  }));
}

function missionForProject(
  database: DatabaseSync,
  projectId: string,
): Mission | undefined {
  return database
    .prepare(
      `SELECT
         id, project_id AS projectId, title, goal, version,
         created_at AS createdAt, updated_at AS updatedAt
       FROM missions
       WHERE project_id = ?`,
    )
    .get(projectId) as Mission | undefined;
}

function dependencyIds(database: DatabaseSync, workItemId: string): string[] {
  return (
    database
      .prepare(
        `SELECT dependencies.depends_on_id AS dependencyId
         FROM work_item_dependencies dependencies
         JOIN work_items prerequisite ON prerequisite.id = dependencies.depends_on_id
         WHERE dependencies.work_item_id = ?
         ORDER BY prerequisite.created_at ASC, prerequisite.id ASC`,
      )
      .all(workItemId) as Array<{ dependencyId: string }>
  ).map(({ dependencyId }) => dependencyId);
}

function workItems(database: DatabaseSync, missionId: string): WorkItem[] {
  const rows = database
    .prepare(
      `SELECT
         id, mission_id AS missionId, title, description, status,
         assignee_agent_id AS assigneeAgentId, version,
         created_at AS createdAt, updated_at AS updatedAt
       FROM work_items
       WHERE mission_id = ?
       ORDER BY created_at ASC, id ASC`,
    )
    .all(missionId) as WorkItemRow[];
  return rows.map((row) => ({
    ...row,
    dependencyIds: dependencyIds(database, row.id),
  }));
}

function activeMemories(database: DatabaseSync, projectId: string): MemoryEntry[] {
  const rows = database
    .prepare(
      `SELECT
         entry.id,
         entry.project_id AS projectId,
         entry.type,
         entry.content,
         entry.source_type AS sourceType,
         entry.source_id AS sourceRef,
         entry.proposer_actor_type AS createdBy,
         entry.supersedes_id AS supersedesId,
         entry.created_at AS createdAt
       FROM memory_entries entry
       WHERE entry.project_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM memory_entries child WHERE child.supersedes_id = entry.id
         )
       ORDER BY entry.created_at ASC, entry.id ASC`,
    )
    .all(projectId) as MemoryRow[];
  return rows.map((row) => ({ ...row, active: true }));
}

function currentAgent(
  database: DatabaseSync,
  agent: AgentRow,
): ProjectContextSnapshot["currentAgent"] {
  const skills = database
    .prepare(
      `SELECT
         skills.id,
         skills.name,
         skills.instructions
       FROM agent_skills
       JOIN skills ON skills.id = agent_skills.skill_id
       WHERE agent_skills.agent_id = ?
       ORDER BY agent_skills.position ASC, skills.id ASC`,
    )
    .all(agent.id) as Array<{ id: string; name: string; instructions: string }>;
  return {
    id: agent.id,
    name: agent.name,
    permissions: permissions(agent),
    role: agent.role,
    skills,
    systemPrompt: agent.systemPrompt,
  };
}

function missingContext(
  project: ProjectRow,
  memberCount: number,
  mission: Mission | undefined,
): MissingContext[] {
  const missing: MissingContext[] = [];
  if (!project.workspacePath) missing.push("workspace");
  if (memberCount < 2) missing.push("members");
  if (!mission) missing.push("mission");
  return missing;
}

export function createContextSnapshotFromDatabase(
  database: DatabaseSync,
  projectId: string,
  agentId: string,
): ProjectContextSnapshot {
  const project = database
    .prepare(
      `SELECT
         id,
         name,
         workspace_path AS workspacePath
       FROM projects
       WHERE id = ?`,
    )
    .get(projectId) as ProjectRow | undefined;
  if (!project) {
    throw new ContextSnapshotError(
      "PROJECT_NOT_FOUND",
      404,
      "Project was not found.",
    );
  }

  const agent = database
    .prepare(
      `SELECT
         id,
         name,
         role,
         system_prompt AS systemPrompt,
         can_read AS canRead,
         can_write AS canWrite,
         can_execute AS canExecute
       FROM agents
       WHERE id = ?`,
    )
    .get(agentId) as AgentRow | undefined;
  if (!agent) {
    throw new ContextSnapshotError(
      "AGENT_NOT_FOUND",
      404,
      "Agent was not found.",
    );
  }
  const selectedMembership = database
    .prepare(
      `SELECT 1
       FROM project_memberships
       WHERE project_id = ? AND agent_id = ?`,
    )
    .get(projectId, agentId);
  if (!selectedMembership) {
    throw new ContextSnapshotError(
      "AGENT_NOT_MEMBER",
      409,
      "Selected agent is not a project member.",
    );
  }

  const projectRoster = roster(database, projectId);
  const mission = missionForProject(database, projectId);
  const missing = missingContext(project, projectRoster.length, mission);
  if (missing.length > 0) {
    throw new ContextSnapshotError(
      "CONTEXT_NOT_READY",
      409,
      "Project context is not ready.",
      missing,
    );
  }
  if (!mission || !project.workspacePath) {
    throw new Error("Context readiness invariant failed.");
  }

  return {
    currentAgent: currentAgent(database, agent),
    schemaVersion: 1,
    shared: {
      memories: activeMemories(database, projectId),
      mission,
      project: {
        id: project.id,
        name: project.name,
        workspacePath: project.workspacePath,
      },
      roster: projectRoster,
      workItems: workItems(database, mission.id),
    },
  };
}

export function createContextSnapshot(
  databasePath: string,
  projectId: string,
  agentId: string,
): ProjectContextSnapshot {
  const database = openDatabase(databasePath);
  database.exec("BEGIN");
  try {
    const snapshot = createContextSnapshotFromDatabase(database, projectId, agentId);
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

export function collaborationContextFingerprintFromDatabase(
  database: DatabaseSync,
  projectId: string,
): CollaborationContextFingerprint {
  const mission = missionForProject(database, projectId);
  if (!mission) {
    throw new ContextSnapshotError(
      "CONTEXT_NOT_READY",
      409,
      "Project context is not ready.",
      ["mission"],
    );
  }
  const rosterFacts = database
    .prepare(
      `SELECT agent_id AS agentId, joined_at AS joinedAt
       FROM project_memberships
       WHERE project_id = ?
       ORDER BY joined_at ASC, agent_id ASC`,
    )
    .all(projectId) as Array<{ agentId: string; joinedAt: string }>;
  const itemFacts = workItems(database, mission.id).map((item) => ({
    assigneeAgentId: item.assigneeAgentId,
    dependencyIds: item.dependencyIds,
    description: item.description,
    id: item.id,
    status: item.status,
    title: item.title,
    version: item.version,
  }));
  const facts: CollaborationContextFacts = {
    mission: {
      goal: mission.goal,
      id: mission.id,
      title: mission.title,
      version: mission.version,
    },
    roster: rosterFacts,
    schemaVersion: 1,
    workItems: itemFacts,
  };
  return {
    facts,
    hash: createHash("sha256")
      .update(JSON.stringify(canonicalize(facts)))
      .digest("hex"),
  };
}

export function collaborationContextFingerprint(
  databasePath: string,
  projectId: string,
): CollaborationContextFingerprint {
  const database = openDatabase(databasePath);
  database.exec("BEGIN");
  try {
    const fingerprint = collaborationContextFingerprintFromDatabase(database, projectId);
    database.exec("COMMIT");
    return fingerprint;
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

export function evaluateAcquiredContextFromDatabase(
  database: DatabaseSync,
  projectId: string,
  acquiredHash: string,
): AcquiredContextDisposition {
  return collaborationContextFingerprintFromDatabase(database, projectId).hash === acquiredHash
    ? { category: null, disposition: "current" }
    : { category: "context_changed", disposition: "discarded" };
}

export function evaluateAcquiredContext(
  databasePath: string,
  projectId: string,
  acquiredHash: string,
): AcquiredContextDisposition {
  const database = openDatabase(databasePath);
  database.exec("BEGIN");
  try {
    const result = evaluateAcquiredContextFromDatabase(
      database,
      projectId,
      acquiredHash,
    );
    database.exec("COMMIT");
    return result;
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
