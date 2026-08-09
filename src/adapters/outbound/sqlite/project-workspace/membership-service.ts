import type { DatabaseSync } from "node:sqlite";

import { MembershipError } from "@/src/modules/project-workspace";
import { hasActiveCollaborationForProject } from "@/src/server/collaboration/active-run-guards";
import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import type {
  MembershipState,
  ProjectMember,
} from "@/src/shared/project-context-contracts";

type ProjectVersionRow = {
  version: number;
};

type MemberRow = {
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

type ReplaceMembersInput = {
  agentIds: string[];
  expectedProjectVersion: number;
};

function invalidInput(code: string): MembershipError {
  return new MembershipError(
    "INVALID_INPUT",
    400,
    "Project members input is invalid.",
    [{ field: "agentIds", code }],
  );
}

function validateInput(input: ReplaceMembersInput): void {
  if (
    !input ||
    !Array.isArray(input.agentIds) ||
    !input.agentIds.every((agentId) => typeof agentId === "string" && agentId.length > 0) ||
    !Number.isInteger(input.expectedProjectVersion) ||
    input.expectedProjectVersion < 1
  ) {
    throw invalidInput("invalid_format");
  }
  if (input.agentIds.length < 2) throw invalidInput("too_small");
  if (new Set(input.agentIds).size !== input.agentIds.length) {
    throw invalidInput("duplicate");
  }
}

function projectVersion(database: DatabaseSync, projectId: string): number {
  const project = database
    .prepare("SELECT version FROM projects WHERE id = ?")
    .get(projectId) as ProjectVersionRow | undefined;
  if (!project) {
    throw new MembershipError("PROJECT_NOT_FOUND", 404, "Project was not found.");
  }
  return project.version;
}

function skillNames(database: DatabaseSync, agentId: string): string[] {
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

function listMembers(database: DatabaseSync, projectId: string): ProjectMember[] {
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
       FROM project_memberships AS memberships
       JOIN agents ON agents.id = memberships.agent_id
       WHERE memberships.project_id = ?
       ORDER BY memberships.joined_at ASC, memberships.agent_id ASC`,
    )
    .all(projectId) as MemberRow[];
  return rows.map((row) => ({
    accentToken: row.accentToken,
    agentId: row.agentId,
    avatarText: row.avatarText,
    joinedAt: row.joinedAt,
    model: row.model,
    name: row.name,
    permissions: {
      readFiles: row.canRead === 1,
      runCommands: row.canExecute === 1,
      writeFiles: row.canWrite === 1,
    },
    role: row.role,
    skillNames: skillNames(database, row.agentId),
  }));
}

function state(database: DatabaseSync, projectId: string): MembershipState {
  return {
    members: listMembers(database, projectId),
    projectVersion: projectVersion(database, projectId),
  };
}

function tableExists(database: DatabaseSync, table: string): boolean {
  return Boolean(
    database
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table),
  );
}

function ensureAgentsExist(database: DatabaseSync, agentIds: string[]): void {
  const placeholders = agentIds.map(() => "?").join(", ");
  const found = database
    .prepare(`SELECT id FROM agents WHERE id IN (${placeholders})`)
    .all(...agentIds) as Array<{ id: string }>;
  if (found.length !== agentIds.length) {
    throw new MembershipError(
      "AGENT_NOT_FOUND",
      404,
      "One or more agents were not found.",
    );
  }
}

function assignedRemovedMembers(
  database: DatabaseSync,
  projectId: string,
  removedAgentIds: string[],
): string[] {
  if (
    removedAgentIds.length === 0 ||
    !tableExists(database, "missions") ||
    !tableExists(database, "work_items")
  ) {
    return [];
  }
  const placeholders = removedAgentIds.map(() => "?").join(", ");
  return (
    database
      .prepare(
        `SELECT DISTINCT work_items.assignee_agent_id AS agentId
         FROM work_items
         JOIN missions ON missions.id = work_items.mission_id
         WHERE missions.project_id = ?
           AND work_items.assignee_agent_id IN (${placeholders})
         ORDER BY work_items.assignee_agent_id ASC`,
      )
      .all(projectId, ...removedAgentIds) as Array<{ agentId: string }>
  ).map(({ agentId }) => agentId);
}

export function getMembers(databasePath: string, projectId: string): MembershipState {
  const database = openDatabase(databasePath);
  try {
    return state(database, projectId);
  } finally {
    database.close();
  }
}

export function replaceMembers(
  databasePath: string,
  projectId: string,
  input: ReplaceMembersInput,
): MembershipState {
  validateInput(input);
  const database = openDatabase(databasePath);
  database.exec("BEGIN IMMEDIATE");
  try {
    const currentVersion = projectVersion(database, projectId);
    if (currentVersion !== input.expectedProjectVersion) {
      throw new MembershipError(
        "RESOURCE_CONFLICT",
        409,
        "Project version is stale.",
        undefined,
        currentVersion,
      );
    }
    ensureAgentsExist(database, input.agentIds);

    const existingIds = (
      database
        .prepare("SELECT agent_id AS agentId FROM project_memberships WHERE project_id = ?")
        .all(projectId) as Array<{ agentId: string }>
    ).map(({ agentId }) => agentId);
    const requested = new Set(input.agentIds);
    const removedIds = existingIds.filter((agentId) => !requested.has(agentId));
    if (
      removedIds.length > 0 &&
      hasActiveCollaborationForProject(database, projectId)
    ) {
      throw new MembershipError(
        "COLLABORATION_ACTIVE",
        409,
        "Project members cannot be removed during an active collaboration.",
      );
    }
    const assignedIds = assignedRemovedMembers(database, projectId, removedIds);
    if (assignedIds.length > 0) {
      throw new MembershipError(
        "MEMBER_HAS_ASSIGNMENTS",
        409,
        "Assigned members cannot be removed.",
        undefined,
        undefined,
        assignedIds,
      );
    }

    if (removedIds.length > 0) {
      const placeholders = removedIds.map(() => "?").join(", ");
      database
        .prepare(
          `DELETE FROM project_memberships
           WHERE project_id = ? AND agent_id IN (${placeholders})`,
        )
        .run(projectId, ...removedIds);
    }
    const joinedAt = new Date().toISOString();
    const insert = database.prepare(
      `INSERT OR IGNORE INTO project_memberships (project_id, agent_id, joined_at)
       VALUES (?, ?, ?)`,
    );
    for (const agentId of input.agentIds) {
      insert.run(projectId, agentId, joinedAt);
    }
    database
      .prepare("UPDATE projects SET version = version + 1 WHERE id = ?")
      .run(projectId);
    database.exec("COMMIT");
    return state(database, projectId);
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the stable membership error.
    }
    throw error;
  } finally {
    database.close();
  }
}
