import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import {
  OperationsProjectionError,
  type ContributionInsightDto,
} from "@/src/modules/operations-projection";

const NEEDS_PROJECT = "需要打开项目";

const EMPTY: ContributionInsightDto = {
  disclaimer: "not_ranking",
  project: { detail: NEEDS_PROJECT, projectId: null },
  roles: [],
};

type RoleRow = {
  agentId: string;
  blocked: number;
  completed: number;
  failed: number;
  inProgress: number;
  name: string;
  passed: number;
  role: string;
};

type EvidenceRow = {
  agentId: string;
  id: string;
  kind: "review" | "work_item";
  title: string;
};

const EVIDENCE_LIMIT = 5;

export function getContributionInsight(
  databasePath: string,
  projectId?: string,
): ContributionInsightDto {
  const database = openDatabase(databasePath);
  try {
    if (projectId === undefined) {
      return EMPTY;
    }
    const project = database.prepare("SELECT 1 AS found FROM projects WHERE id=?").get(projectId);
    if (project === undefined) {
      throw new OperationsProjectionError("PROJECT_NOT_FOUND", "Project was not found.");
    }

    const evidenceByAgent = new Map<string, ContributionInsightDto["roles"][number]["evidence"]>();
    for (const row of database.prepare(`
      SELECT agentId, id, kind, title FROM (
        SELECT
          w.assignee_agent_id AS agentId,
          w.id AS id,
          'work_item' AS kind,
          w.title AS title,
          w.updated_at AS sortAt
        FROM work_items w
        JOIN missions mi ON mi.id=w.mission_id
        WHERE mi.project_id=? AND w.assignee_agent_id IS NOT NULL
        UNION ALL
        SELECT
          r.reviewer_agent_id AS agentId,
          r.id AS id,
          'review' AS kind,
          w.title AS title,
          r.started_at AS sortAt
        FROM review_attempts r
        JOIN work_items w ON w.id=r.work_item_id
        WHERE r.project_id=? AND r.status IN ('passed','failed')
      )
      ORDER BY sortAt DESC, id
    `).all(projectId, projectId) as unknown as EvidenceRow[]) {
      const list = evidenceByAgent.get(row.agentId) ?? [];
      if (list.length < EVIDENCE_LIMIT) {
        list.push({ id: row.id, kind: row.kind, title: row.title });
        evidenceByAgent.set(row.agentId, list);
      }
    }

    const roles = (
      database.prepare(`
        SELECT
          a.id AS agentId,
          a.name AS name,
          a.role AS role,
          COALESCE(SUM(CASE WHEN w.status='done' THEN 1 ELSE 0 END),0) AS completed,
          COALESCE(SUM(CASE WHEN w.status='in_progress' THEN 1 ELSE 0 END),0) AS inProgress,
          COALESCE(SUM(CASE WHEN w.status='blocked' THEN 1 ELSE 0 END),0) AS blocked,
          COALESCE((
            SELECT COUNT(*) FROM review_attempts r
            WHERE r.project_id=m.project_id AND r.reviewer_agent_id=a.id AND r.status='passed'
          ),0) AS passed,
          COALESCE((
            SELECT COUNT(*) FROM review_attempts r
            WHERE r.project_id=m.project_id AND r.reviewer_agent_id=a.id AND r.status='failed'
          ),0) AS failed
        FROM project_memberships m
        JOIN agents a ON a.id=m.agent_id
        LEFT JOIN missions mi ON mi.project_id=m.project_id
        LEFT JOIN work_items w ON w.mission_id=mi.id AND w.assignee_agent_id=a.id
        WHERE m.project_id=?
        GROUP BY a.id, a.name, a.role, m.project_id
        ORDER BY a.name, a.id
      `).all(projectId) as unknown as RoleRow[]
    ).map((row) => ({
      agentId: row.agentId,
      evidence: evidenceByAgent.get(row.agentId) ?? [],
      name: row.name,
      reviews: { failed: row.failed, passed: row.passed },
      role: row.role,
      workItems: {
        blocked: row.blocked,
        completed: row.completed,
        inProgress: row.inProgress,
      },
    }));

    return {
      disclaimer: "not_ranking",
      project: {
        detail: roles.length === 0 ? "尚无项目成员" : null,
        projectId,
      },
      roles,
    };
  } finally {
    database.close();
  }
}
