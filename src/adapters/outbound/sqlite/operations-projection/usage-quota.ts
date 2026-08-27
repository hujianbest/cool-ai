import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import {
  OperationsProjectionError,
  type UsageQuotaDto,
  type UsageTotalsDto,
} from "@/src/modules/operations-projection";

export const COLLABORATION_ROUND_LIMIT = 50;

const NEEDS_PROJECT = "需要打开项目";
const NO_REPORTED_USAGE = "尚无已报告用量";

const EMPTY_TOTALS: UsageTotalsDto = {
  completionTokens: 0,
  invalidCalls: 0,
  promptTokens: 0,
  totalTokens: 0,
  unreportedCalls: 0,
};

const EMPTY_USAGE: UsageQuotaDto = {
  budgets: [],
  disclaimer: "not_invoice",
  project: {
    detail: NEEDS_PROJECT,
    projectId: null,
    totals: EMPTY_TOTALS,
  },
  providers: [],
  runs: [],
};

const CALLS_CTE = `
  WITH calls AS (
    SELECT
      a.project_id AS projectId,
      a.run_id AS runId,
      ag.provider_id AS providerId,
      a.agent_id AS agentId,
      c.prompt_tokens AS promptTokens,
      c.completion_tokens AS completionTokens,
      c.total_tokens AS totalTokens,
      c.status AS status
    FROM collaboration_model_calls c
    JOIN collaboration_attempts a ON a.id=c.attempt_id
    JOIN agents ag ON ag.id=a.agent_id
    WHERE a.project_id=:projectId
    UNION ALL
    SELECT
      e.project_id,
      e.source_collaboration_run_id,
      ag.provider_id,
      e.agent_id,
      c.prompt_tokens,
      c.completion_tokens,
      c.total_tokens,
      c.status
    FROM execution_model_calls c
    JOIN executions e ON e.id=c.execution_id
    JOIN agents ag ON ag.id=e.agent_id
    WHERE e.project_id=:projectId
    UNION ALL
    SELECT
      r.project_id,
      NULL,
      r.provider_id,
      r.reviewer_agent_id,
      c.prompt_tokens,
      c.completion_tokens,
      c.total_tokens,
      c.status
    FROM review_model_calls c
    JOIN review_attempts r ON r.id=c.attempt_id
    WHERE r.project_id=:projectId
  ),
  classified AS (
    SELECT
      projectId,
      runId,
      providerId,
      agentId,
      promptTokens,
      completionTokens,
      totalTokens,
      CASE
        WHEN status='usage_invalid' THEN 'invalid'
        WHEN promptTokens IS NULL AND completionTokens IS NULL AND totalTokens IS NULL
          THEN 'unreported'
        WHEN typeof(promptTokens)='integer' AND typeof(completionTokens)='integer'
          AND typeof(totalTokens)='integer'
          AND promptTokens>=0 AND completionTokens>=0
          AND totalTokens=promptTokens+completionTokens
          THEN 'reported'
        ELSE 'invalid'
      END AS meter
    FROM calls
  )
`;

const TOTALS_SELECT = `
  COALESCE(SUM(CASE WHEN meter='reported' THEN promptTokens ELSE 0 END),0) AS promptTokens,
  COALESCE(SUM(CASE WHEN meter='reported' THEN completionTokens ELSE 0 END),0) AS completionTokens,
  COALESCE(SUM(CASE WHEN meter='reported' THEN totalTokens ELSE 0 END),0) AS totalTokens,
  COALESCE(SUM(CASE WHEN meter='unreported' THEN 1 ELSE 0 END),0) AS unreportedCalls,
  COALESCE(SUM(CASE WHEN meter='invalid' THEN 1 ELSE 0 END),0) AS invalidCalls
`;

type TotalsRow = UsageTotalsDto;

function toTotals(row: TotalsRow | undefined): UsageTotalsDto {
  return {
    completionTokens: row?.completionTokens ?? 0,
    invalidCalls: row?.invalidCalls ?? 0,
    promptTokens: row?.promptTokens ?? 0,
    totalTokens: row?.totalTokens ?? 0,
    unreportedCalls: row?.unreportedCalls ?? 0,
  };
}

export function getUsageQuota(
  databasePath: string,
  projectId?: string,
): UsageQuotaDto {
  const database = openDatabase(databasePath);
  try {
    if (projectId === undefined) {
      return EMPTY_USAGE;
    }
    const project = database.prepare("SELECT 1 AS found FROM projects WHERE id=?").get(projectId);
    if (project === undefined) {
      throw new OperationsProjectionError("PROJECT_NOT_FOUND", "Project was not found.");
    }

    const totals = toTotals(
      database.prepare(`${CALLS_CTE} SELECT ${TOTALS_SELECT} FROM classified`).get({
        projectId,
      }) as unknown as TotalsRow | undefined,
    );

    const runRows = database.prepare(`
      SELECT id, round_count AS roundCount
      FROM collaboration_runs
      WHERE project_id=?
      ORDER BY created_at, id
    `).all(projectId) as unknown as Array<{ id: string; roundCount: number }>;
    const runTotals = new Map(
      (
        database.prepare(`
          ${CALLS_CTE}
          SELECT runId, ${TOTALS_SELECT}
          FROM classified
          WHERE runId IS NOT NULL
          GROUP BY runId
        `).all({ projectId }) as unknown as Array<TotalsRow & { runId: string }>
      ).map((row) => [row.runId, toTotals(row)]),
    );

    const providers = (
      database.prepare(`
        ${CALLS_CTE}
        SELECT p.id AS id, p.name AS name, ${TOTALS_SELECT}
        FROM classified
        JOIN providers p ON p.id=classified.providerId
        GROUP BY p.id, p.name
        ORDER BY p.name, p.id
      `).all({ projectId }) as unknown as Array<TotalsRow & { id: string; name: string }>
    ).map((row) => ({
      id: row.id,
      name: row.name,
      totals: toTotals(row),
    }));

    const agentUsed = new Map(
      (
        database.prepare(`
          ${CALLS_CTE}
          SELECT agentId, COALESCE(SUM(CASE WHEN meter='reported' THEN totalTokens ELSE 0 END),0) AS usedTokens
          FROM classified
          WHERE agentId IS NOT NULL
          GROUP BY agentId
        `).all({ projectId }) as unknown as Array<{ agentId: string; usedTokens: number }>
      ).map((row) => [row.agentId, row.usedTokens]),
    );
    const budgets = (
      database.prepare(`
        SELECT a.id AS agentId, a.name AS name,
               a.max_tokens AS maxTokens, a.max_handoffs AS maxHandoffs
        FROM project_memberships m
        JOIN agents a ON a.id=m.agent_id
        WHERE m.project_id=?
        ORDER BY a.name, a.id
      `).all(projectId) as unknown as Array<{
        agentId: string;
        maxHandoffs: number;
        maxTokens: number;
        name: string;
      }>
    ).map((row) => ({
      ...row,
      usedTokens: agentUsed.get(row.agentId) ?? 0,
    }));

    return {
      budgets,
      disclaimer: "not_invoice",
      project: {
        detail: totals.totalTokens === 0 ? NO_REPORTED_USAGE : null,
        projectId,
        totals,
      },
      providers,
      runs: runRows.map((run) => ({
        id: run.id,
        roundCount: run.roundCount,
        roundLimit: COLLABORATION_ROUND_LIMIT,
        totals: runTotals.get(run.id) ?? EMPTY_TOTALS,
      })),
    };
  } finally {
    database.close();
  }
}
