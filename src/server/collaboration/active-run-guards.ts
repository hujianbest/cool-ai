import type { DatabaseSync } from "node:sqlite";

const ACTIVE_RUN_STATUSES = "('running','waiting_owner','paused','failed')";

export function hasActiveCollaborationForProject(
  database: DatabaseSync,
  projectId: string,
): boolean {
  return Boolean(
    database
      .prepare(
        `SELECT 1
         FROM collaboration_runs
         WHERE project_id = ?
           AND status IN ${ACTIVE_RUN_STATUSES}
         LIMIT 1`,
      )
      .get(projectId),
  );
}

export function isAgentInActiveCollaboration(
  database: DatabaseSync,
  agentId: string,
): boolean {
  return Boolean(
    database
      .prepare(
        `SELECT 1
         FROM project_memberships AS memberships
         JOIN collaboration_runs AS runs
           ON runs.project_id = memberships.project_id
         WHERE memberships.agent_id = ?
           AND runs.status IN ${ACTIVE_RUN_STATUSES}
         LIMIT 1`,
      )
      .get(agentId),
  );
}

export function isProviderInActiveCollaboration(
  database: DatabaseSync,
  providerId: string,
): boolean {
  return Boolean(
    database
      .prepare(
        `SELECT 1
         FROM agents
         JOIN project_memberships AS memberships
           ON memberships.agent_id = agents.id
         JOIN collaboration_runs AS runs
           ON runs.project_id = memberships.project_id
         WHERE agents.provider_id = ?
           AND runs.status IN ${ACTIVE_RUN_STATUSES}
         LIMIT 1`,
      )
      .get(providerId),
  );
}
