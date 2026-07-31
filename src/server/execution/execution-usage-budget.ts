import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export const MAX_EXECUTION_BUSINESS_ROUNDS = 20;
export const MAX_EXECUTION_TOOL_CALLS = 40;

export type ExecutionBudgetBoundary =
  | "BUSINESS_ROUND_LIMIT"
  | "EXECUTION_TIME_LIMIT"
  | "MODEL_USAGE_INVALID"
  | "TOKEN_BUDGET_EXCEEDED"
  | "TOOL_CALL_LIMIT";

type BudgetRow = {
  agentId: string;
  businessDeadlineAt: string | null;
  businessRounds: number;
  invalidUsageCount: number;
  maxTokens: number;
  sourceRunId: string;
  toolCalls: number;
  totalTokens: number;
};

const usageCte = `
  WITH all_calls AS (
    SELECT c.prompt_tokens,c.completion_tokens,c.total_tokens,c.status
    FROM collaboration_model_calls c
    JOIN collaboration_attempts a ON a.id=c.attempt_id
    WHERE a.run_id=:sourceRunId AND a.agent_id=:agentId
    UNION ALL
    SELECT c.prompt_tokens,c.completion_tokens,c.total_tokens,c.status
    FROM execution_model_calls c
    JOIN executions e ON e.id=c.execution_id
    WHERE e.source_collaboration_run_id=:sourceRunId AND e.agent_id=:agentId
  ),
  usage AS (
    SELECT
      COALESCE(SUM(CASE WHEN
        typeof(prompt_tokens)='integer' AND typeof(completion_tokens)='integer'
        AND typeof(total_tokens)='integer'
        AND prompt_tokens>=0 AND completion_tokens>=0
        AND total_tokens=prompt_tokens+completion_tokens
        THEN total_tokens ELSE 0 END),0) AS totalTokens,
      COALESCE(SUM(CASE WHEN status='usage_invalid' THEN 1 ELSE 0 END),0)
        AS invalidUsageCount
    FROM all_calls
  )
`;

export function executionBudget(
  database: DatabaseSync,
  executionId: string,
): BudgetRow {
  const identity = database.prepare(`
    SELECT e.agent_id AS agentId,e.source_collaboration_run_id AS sourceRunId,
           e.business_round_count AS businessRounds,e.tool_call_count AS toolCalls,
           e.business_deadline_at AS businessDeadlineAt,a.max_tokens AS maxTokens
    FROM executions e JOIN agents a ON a.id=e.agent_id WHERE e.id=?
  `).get(executionId) as Omit<BudgetRow, "invalidUsageCount" | "totalTokens"> | undefined;
  if (!identity) throw new Error("EXECUTION_NOT_FOUND");
  const usage = database.prepare(`${usageCte}
    SELECT totalTokens,invalidUsageCount FROM usage
  `).get({
    agentId: identity.agentId,
    sourceRunId: identity.sourceRunId,
  }) as Pick<BudgetRow, "invalidUsageCount" | "totalTokens">;
  return { ...identity, ...usage };
}

export function preExecutionBoundary(
  database: DatabaseSync,
  executionId: string,
  nextKind: "model" | "stage" | "tool",
): { boundary: ExecutionBudgetBoundary; limit: number; value: number } | null {
  const budget = executionBudget(database, executionId);
  if (budget.invalidUsageCount > 0) {
    return { boundary: "MODEL_USAGE_INVALID", limit: 0, value: budget.invalidUsageCount };
  }
  if (budget.totalTokens >= budget.maxTokens) {
    return {
      boundary: "TOKEN_BUDGET_EXCEEDED",
      limit: budget.maxTokens,
      value: budget.totalTokens,
    };
  }
  if (budget.businessDeadlineAt !== null) {
    const expired = database.prepare(`
      SELECT ?<=strftime('%Y-%m-%dT%H:%M:%fZ','now') AS value
    `).get(budget.businessDeadlineAt) as { value: number };
    if (expired.value === 1) {
      return { boundary: "EXECUTION_TIME_LIMIT", limit: 900, value: 900 };
    }
  }
  if (nextKind === "model" && budget.businessRounds >= MAX_EXECUTION_BUSINESS_ROUNDS) {
    return {
      boundary: "BUSINESS_ROUND_LIMIT",
      limit: MAX_EXECUTION_BUSINESS_ROUNDS,
      value: budget.businessRounds,
    };
  }
  if (nextKind === "tool" && budget.toolCalls >= MAX_EXECUTION_TOOL_CALLS) {
    return {
      boundary: "TOOL_CALL_LIMIT",
      limit: MAX_EXECUTION_TOOL_CALLS,
      value: budget.toolCalls,
    };
  }
  return null;
}

export function appendExecutionEvent(
  database: DatabaseSync,
  input: {
    actorId: string | null;
    actorType: "agent" | "system";
    executionId: string;
    payload: unknown;
    projectId: string;
    type: string;
  },
): void {
  const row = database.prepare(`
    SELECT current_attempt_no AS attemptNo,next_event_sequence AS sequence
    FROM executions WHERE project_id=? AND id=?
  `).get(input.projectId, input.executionId) as { attemptNo: number; sequence: number };
  database.prepare(`
    INSERT INTO execution_events (
      id,project_id,execution_id,sequence,attempt_no,type,actor_type,actor_id,
      payload_json,created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  `).run(
    randomUUID(),
    input.projectId,
    input.executionId,
    row.sequence,
    row.attemptNo,
    input.type,
    input.actorType,
    input.actorId,
    JSON.stringify(input.payload),
  );
  database.prepare(`
    UPDATE executions SET next_event_sequence=next_event_sequence+1
    WHERE project_id=? AND id=? AND next_event_sequence=?
  `).run(input.projectId, input.executionId, row.sequence);
}

export function recordUsageEvent(
  database: DatabaseSync,
  callId: string,
  usage: {
    completionTokens: number;
    promptTokens: number;
    totalTokens: number;
  } | null,
): void {
  const row = database.prepare(`
    SELECT c.project_id AS projectId,c.execution_id AS executionId,e.agent_id AS agentId
    FROM execution_model_calls c JOIN executions e ON e.id=c.execution_id
    WHERE c.id=?
  `).get(callId) as { agentId: string; executionId: string; projectId: string };
  appendExecutionEvent(database, {
    actorId: row.agentId,
    actorType: "agent",
    executionId: row.executionId,
    payload: {
      agentId: row.agentId,
      completionTokens: usage?.completionTokens ?? 0,
      modelCallId: callId,
      promptTokens: usage?.promptTokens ?? 0,
      reported: usage !== null,
      totalTokens: usage?.totalTokens ?? 0,
    },
    projectId: row.projectId,
    type: "usage_recorded",
  });
}

export function commitPostCallTokenBoundary(
  database: DatabaseSync,
  input: {
    actionId: string;
    businessRound: number;
    leaseToken: string;
    projectId: string;
  },
): boolean {
  const identity = database.prepare(`
    SELECT execution_id AS executionId FROM execution_actions
    WHERE project_id=? AND id=? AND status='running' AND lease_token=?
  `).get(input.projectId, input.actionId, input.leaseToken) as
    | { executionId: string }
    | undefined;
  if (!identity) return false;
  const budget = executionBudget(database, identity.executionId);
  if (budget.invalidUsageCount > 0 || budget.totalTokens <= budget.maxTokens) return false;
  const boundary: ExecutionBudgetBoundary = "TOKEN_BUDGET_EXCEEDED";
  const updated = database.prepare(`
    UPDATE executions SET business_round_count=?,status='paused',resume_target='running',
      reason_code=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),version=version+1
    WHERE project_id=? AND id=? AND status='running'
      AND business_round_count=? AND business_deadline_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
  `).run(
    input.businessRound,
    boundary,
    input.projectId,
    identity.executionId,
    input.businessRound - 1,
  );
  if (updated.changes !== 1) return false;
  appendExecutionEvent(database, {
    actorId: null,
    actorType: "system",
    executionId: identity.executionId,
    payload: {
      agentId: budget.agentId,
      boundary: "tokens",
      limit: budget.maxTokens,
      value: budget.totalTokens,
    },
    projectId: input.projectId,
    type: "boundary_paused",
  });
  return true;
}
