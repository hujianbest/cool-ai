import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { canonicalRequestHash } from "@/src/server/collaboration/operation-receipts";
import { openDatabase } from "@/src/server/db";
import { acquireExecutionAction } from "@/src/server/execution/execution-actions";
import { captureExecutionFrozenInput } from "@/src/server/execution/execution-frozen-input";
import type { SandboxExecutor } from "@/src/server/execution/sandbox-executor";
import {
  executionDtoSchema,
  executionListResponseSchema,
  startExecutionRejectionSchema,
  startExecutionInputSchema,
  type StartExecutionRejection,
  type ExecutionDto,
  type ExecutionListResponse,
  type StartExecutionInput,
  type TaskRejection,
} from "@/src/shared/execution-contracts";

export class ExecutionError extends Error {
  constructor(
    public readonly code: string,
    public readonly httpStatus: number,
    message: string,
  ) {
    super(message);
    this.name = "ExecutionError";
  }
}

export function assertManualRecoveryNotRequired(
  database: DatabaseSync,
  executionId: string,
): void {
  const row = database.prepare(`
    SELECT manual_recovery_required AS manualRecoveryRequired
    FROM executions WHERE id=?
  `).get(executionId) as { manualRecoveryRequired: number } | undefined;
  if (row?.manualRecoveryRequired === 1) {
    throw new ExecutionError(
      "MANUAL_RECOVERY_REQUIRED",
      409,
      "Only an exact manual recovery resolution is allowed.",
    );
  }
}

type ExecutionRow = {
  id: string;
  projectId: string;
  sourceCollaborationRunId: string;
  workItemId: string;
  workItemTitle: string;
  agentId: string;
  agentName: string;
  avatarText: string;
  accentToken: string;
  status: ExecutionDto["status"];
  reasonCode: string | null;
  resumeTarget: ExecutionDto["resumeTarget"];
  attemptNo: number;
  version: number;
  businessRounds: number;
  toolCalls: number;
  maxTokens: number;
  manualRecoveryRequired: number;
  createdAt: string;
  firstRunningAt: string | null;
  businessDeadlineAt: string | null;
  updatedAt: string;
  mergedAt: string | null;
};

type ActionRow = {
  kind: ExecutionDto["currentAction"]["kind"];
  actionIndex: number;
  startedAt: string | null;
  overallDeadlineAt: string;
  lastHeartbeatAt: string | null;
};

function transaction<T>(database: DatabaseSync, operation: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the stable execution error.
    }
    throw error;
  }
}

function usageFor(
  database: DatabaseSync,
  sourceCollaborationRunId: string,
  agentId: string,
): ExecutionDto["usage"] {
  const row = database
    .prepare(
      `WITH calls AS (
         SELECT c.prompt_tokens,c.completion_tokens,c.total_tokens
         FROM collaboration_model_calls c
         JOIN collaboration_attempts a ON a.id=c.attempt_id
         WHERE a.run_id=? AND a.agent_id=?
         UNION ALL
         SELECT c.prompt_tokens,c.completion_tokens,c.total_tokens
         FROM execution_model_calls c
         JOIN executions e ON e.id=c.execution_id
         WHERE e.source_collaboration_run_id=? AND e.agent_id=?
       )
       SELECT
         COALESCE(SUM(prompt_tokens),0) AS promptTokens,
         COALESCE(SUM(completion_tokens),0) AS completionTokens,
         COALESCE(SUM(total_tokens),0) AS totalTokens
       FROM calls
       WHERE typeof(prompt_tokens)='integer'
         AND typeof(completion_tokens)='integer'
         AND typeof(total_tokens)='integer'
         AND prompt_tokens>=0 AND completion_tokens>=0
         AND total_tokens=prompt_tokens+completion_tokens`,
    )
    .get(sourceCollaborationRunId, agentId, sourceCollaborationRunId, agentId) as {
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
    };
  const agent = database
    .prepare("SELECT max_tokens AS maxTokens FROM agents WHERE id=?")
    .get(agentId) as { maxTokens: number };
  return { ...row, maxTokens: agent.maxTokens };
}

function actionFor(database: DatabaseSync, executionId: string): ActionRow | undefined {
  return database
    .prepare(
      `SELECT kind, action_index AS actionIndex, started_at AS startedAt,
              overall_deadline_at AS overallDeadlineAt,
              last_heartbeat_at AS lastHeartbeatAt
       FROM execution_actions
       WHERE execution_id=? AND status IN ('pending','running')
       ORDER BY action_index DESC
       LIMIT 1`,
    )
    .get(executionId) as ActionRow | undefined;
}

function executionRow(database: DatabaseSync, executionId: string): ExecutionRow {
  const row = database
    .prepare(
      `SELECT
         e.id, e.project_id AS projectId,
         e.source_collaboration_run_id AS sourceCollaborationRunId,
         e.work_item_id AS workItemId, w.title AS workItemTitle,
         e.agent_id AS agentId, a.name AS agentName,
         a.avatar_text AS avatarText, a.accent_token AS accentToken,
         e.status, e.reason_code AS reasonCode, e.resume_target AS resumeTarget,
         e.current_attempt_no AS attemptNo, e.version,
         e.business_round_count AS businessRounds, e.tool_call_count AS toolCalls,
         a.max_tokens AS maxTokens,
         e.manual_recovery_required AS manualRecoveryRequired,
         e.created_at AS createdAt, e.first_running_at AS firstRunningAt,
         e.business_deadline_at AS businessDeadlineAt, e.updated_at AS updatedAt,
         e.merged_at AS mergedAt
       FROM executions e
       JOIN work_items w ON w.id=e.work_item_id
       JOIN agents a ON a.id=e.agent_id
       WHERE e.id=?`,
    )
    .get(executionId) as ExecutionRow | undefined;
  if (!row) {
    throw new ExecutionError("EXECUTION_NOT_FOUND", 404, "Execution was not found.");
  }
  return row;
}

function toDto(database: DatabaseSync, row: ExecutionRow): ExecutionDto {
  const action = actionFor(database, row.id);
  return executionDtoSchema.parse({
    id: row.id,
    projectId: row.projectId,
    sourceCollaborationRunId: row.sourceCollaborationRunId,
    workItem: { id: row.workItemId, title: row.workItemTitle },
    agent: {
      id: row.agentId,
      name: row.agentName,
      avatarText: row.avatarText,
      accentToken: row.accentToken,
    },
    status: row.status,
    reasonCode: row.reasonCode,
    resumeTarget: row.resumeTarget,
    attemptNo: row.attemptNo,
    version: row.version,
    businessRounds: row.businessRounds,
    toolCalls: row.toolCalls,
    limits: {
      businessRounds: 20,
      toolCalls: 40,
      businessWallClockSeconds: 900,
      businessClockStarts: "first_running",
      sandboxBuildSeconds: 900,
      commandSeconds: 120,
    },
    usage: usageFor(database, row.sourceCollaborationRunId, row.agentId),
    currentAction: action
      ? {
          kind: action.kind,
          actionIndex: action.actionIndex,
          startedAt: action.startedAt,
          overallDeadlineAt: action.overallDeadlineAt,
          lastHeartbeatAt: action.lastHeartbeatAt,
        }
      : {
          kind: null,
          actionIndex: null,
          startedAt: null,
          overallDeadlineAt: null,
          lastHeartbeatAt: null,
        },
    manualRecoveryRequired: row.manualRecoveryRequired === 1,
    createdAt: row.createdAt,
    firstRunningAt: row.firstRunningAt,
    businessDeadlineAt: row.businessDeadlineAt,
    updatedAt: row.updatedAt,
    mergedAt: row.mergedAt,
  });
}

export function executionDtoFromDatabase(
  database: DatabaseSync,
  executionId: string,
): ExecutionDto {
  return toDto(database, executionRow(database, executionId));
}

export function listExecutions(
  databasePath: string,
  projectId: string,
): ExecutionListResponse {
  const database = openDatabase(databasePath);
  try {
    if (!database.prepare("SELECT 1 FROM projects WHERE id=?").get(projectId)) {
      throw new ExecutionError("PROJECT_NOT_FOUND", 404, "Project was not found.");
    }
    const rows = database
      .prepare(
        `SELECT id FROM executions
         WHERE project_id=?
         ORDER BY created_at ASC, id ASC
         LIMIT 50`,
      )
      .all(projectId) as Array<{ id: string }>;
    return executionListResponseSchema.parse({
      executions: rows.map(({ id }) => toDto(database, executionRow(database, id))),
    });
  } finally {
    database.close();
  }
}

export function getExecution(databasePath: string, executionId: string): ExecutionDto {
  const database = openDatabase(databasePath);
  try {
    return toDto(database, executionRow(database, executionId));
  } finally {
    database.close();
  }
}

type EligibleTask = {
  agentId: string;
  missionId: string;
  policyHash: string;
  policyRevisionId: string;
  policyVersion: number;
  workItemTitle: string;
};

export type StartExecutionResult = {
  body: StartExecutionRejection;
  status: number;
};

const ACTIVE_EXECUTION_SQL =
  "('queued','running','waiting_approval','paused','staged')";

function rejection(workItemId: string, code: TaskRejection["code"]): StartExecutionResult {
  return {
    body: startExecutionRejectionSchema.parse({
      rejection: {
        code,
        messageKey: code.toLowerCase(),
        workItemId,
      },
    }),
    status: 409,
  };
}

function readStartReceipt(
  database: DatabaseSync,
  projectId: string,
  operationId: string,
  requestHash: string,
): StartExecutionResult | null {
  const row = database.prepare(
    `SELECT kind,request_hash AS requestHash,status,http_status AS httpStatus,
            response_json AS responseJson
     FROM execution_operations WHERE project_id=? AND id=?`,
  ).get(projectId, operationId) as {
    kind: string;
    requestHash: string;
    status: "pending" | "completed";
    httpStatus: number | null;
    responseJson: string | null;
  } | undefined;
  if (!row) return null;
  if (row.kind !== "start" || row.requestHash !== requestHash) {
    throw new ExecutionError(
      "OPERATION_CONFLICT",
      409,
      "Operation id was already used for different input.",
    );
  }
  if (row.status === "pending" || row.httpStatus === null || row.responseJson === null) {
    throw new ExecutionError("OPERATION_IN_PROGRESS", 409, "Operation is still in progress.");
  }
  return {
    body: startExecutionRejectionSchema.parse(JSON.parse(row.responseJson)),
    status: row.httpStatus,
  };
}

function persistRejection(
  database: DatabaseSync,
  projectId: string,
  input: StartExecutionInput,
  requestHash: string,
  result: StartExecutionResult,
): StartExecutionResult {
  const timestamp = new Date().toISOString();
  database.prepare(
    `INSERT INTO execution_operations (
       id,project_id,execution_id,kind,request_hash,has_external_actions,
       action_count,final_action_index,status,http_status,response_json,created_at,updated_at
     ) VALUES (?, ?, NULL, 'start', ?, 0, 0, NULL, 'completed', ?, ?, ?, ?)`,
  ).run(
    input.operationId,
    projectId,
    requestHash,
    result.status,
    JSON.stringify(result.body),
    timestamp,
    timestamp,
  );
  return result;
}

function qualifyTask(
  database: DatabaseSync,
  projectId: string,
  input: StartExecutionInput,
): EligibleTask | StartExecutionResult {
  const project = database.prepare(
    "SELECT workspace_path AS workspacePath FROM projects WHERE id=?",
  ).get(projectId) as { workspacePath: string | null } | undefined;
  if (!project) return rejection(input.workItemId, "NOT_FOUND");

  const latestRun = database.prepare(
    `SELECT id,status FROM collaboration_runs
     WHERE project_id=? ORDER BY created_at DESC,id DESC LIMIT 1`,
  ).get(projectId) as { id: string; status: string } | undefined;
  const unavailableProvider = database.prepare(
    `SELECT 1 FROM project_memberships pm
     JOIN agents a ON a.id=pm.agent_id
     JOIN providers p ON p.id=a.provider_id
     WHERE pm.project_id=? AND p.verified_at='' LIMIT 1`,
  ).get(projectId);
  if (
    !project.workspacePath
    || !latestRun
    || latestRun.id !== input.sourceCollaborationRunId
    || latestRun.status !== "planned"
  ) {
    return rejection(input.workItemId, "NOT_FOUND");
  }

  const basic = database.prepare(
    `SELECT w.mission_id AS missionId,w.title AS workItemTitle,w.status,
            w.assignee_agent_id AS agentId
     FROM work_items w
     JOIN missions m ON m.id=w.mission_id AND m.project_id=?
     WHERE w.id=?`,
  ).get(projectId, input.workItemId) as {
    agentId: string | null;
    missionId: string;
    status: string;
    workItemTitle: string;
  } | undefined;
  if (!basic) return rejection(input.workItemId, "NOT_FOUND");
  if (basic.status !== "in_progress") {
    return rejection(input.workItemId, "NOT_IN_PROGRESS");
  }
  if (!basic.agentId) return rejection(input.workItemId, "UNASSIGNED");
  if (!database.prepare(
    "SELECT 1 FROM project_memberships WHERE project_id=? AND agent_id=?",
  ).get(projectId, basic.agentId)) {
    return rejection(input.workItemId, "ASSIGNEE_NOT_MEMBER");
  }
  if (unavailableProvider) {
    return rejection(input.workItemId, "NOT_FOUND");
  }
  if (database.prepare(
    `WITH RECURSIVE dependencies(id) AS (
       SELECT depends_on_id FROM work_item_dependencies WHERE work_item_id=?
       UNION
       SELECT d.depends_on_id FROM work_item_dependencies d
       JOIN dependencies prior ON d.work_item_id=prior.id
     )
     SELECT 1 FROM dependencies
     JOIN work_items w ON w.id=dependencies.id
     WHERE w.status<>'done' LIMIT 1`,
  ).get(input.workItemId)) {
    return rejection(input.workItemId, "DEPENDENCY_NOT_DONE");
  }
  if (!database.prepare(
    `SELECT 1
     FROM collaboration_events ce
     JOIN collaboration_turns ct
       ON ct.run_id=ce.run_id AND ct.id=json_extract(ce.payload_json,'$.turnId')
     JOIN collaboration_attempts ca
       ON ca.id=ct.attempt_id AND ca.status='committed'
     WHERE ce.run_id=? AND ce.type='task_claimed'
       AND json_extract(ce.payload_json,'$.workItemId')=?
       AND json_extract(ce.payload_json,'$.agentId')=?
       AND ct.agent_id=? LIMIT 1`,
  ).get(input.sourceCollaborationRunId, input.workItemId, basic.agentId, basic.agentId)) {
    return rejection(input.workItemId, "NOT_FOUND");
  }
  if (database.prepare(
    `SELECT 1 FROM executions WHERE work_item_id=? AND status IN ${ACTIVE_EXECUTION_SQL} LIMIT 1`,
  ).get(input.workItemId)) {
    return rejection(input.workItemId, "TASK_ACTIVE");
  }
  if (database.prepare(
    `SELECT 1 FROM executions WHERE agent_id=? AND status IN ${ACTIVE_EXECUTION_SQL} LIMIT 1`,
  ).get(basic.agentId)) {
    return rejection(input.workItemId, "AGENT_ACTIVE");
  }
  if (database.prepare(
    `WITH RECURSIVE
       ancestors(id) AS (
         SELECT depends_on_id FROM work_item_dependencies WHERE work_item_id=?
         UNION
         SELECT d.depends_on_id FROM work_item_dependencies d
         JOIN ancestors a ON d.work_item_id=a.id
       ),
       descendants(id) AS (
         SELECT work_item_id FROM work_item_dependencies WHERE depends_on_id=?
         UNION
         SELECT d.work_item_id FROM work_item_dependencies d
         JOIN descendants prior ON d.depends_on_id=prior.id
       )
     SELECT 1 FROM executions e
     WHERE e.status IN ${ACTIVE_EXECUTION_SQL}
       AND e.work_item_id IN (
         SELECT id FROM ancestors UNION SELECT id FROM descendants
       ) LIMIT 1`,
  ).get(input.workItemId, input.workItemId)) {
    return rejection(input.workItemId, "RELATED_SELECTION");
  }
  const activeCount = Number((database.prepare(
    `SELECT COUNT(*) AS count FROM executions
     WHERE project_id=? AND status IN ${ACTIVE_EXECUTION_SQL}`,
  ).get(projectId) as { count: number }).count);
  if (activeCount >= 2) return rejection(input.workItemId, "PROJECT_LIMIT");

  const row = database
    .prepare(
      `SELECT
         w.mission_id AS missionId, w.title AS workItemTitle,
         w.assignee_agent_id AS agentId,
         p.active_revision_id AS policyRevisionId, p.version AS policyVersion,
         r.policy_hash AS policyHash
       FROM work_items w
       JOIN missions m ON m.id=w.mission_id AND m.project_id=?
       JOIN project_memberships pm
         ON pm.project_id=m.project_id AND pm.agent_id=w.assignee_agent_id
       JOIN collaboration_runs cr
         ON cr.id=? AND cr.project_id=m.project_id AND cr.status='planned'
       JOIN project_validation_policies p ON p.project_id=m.project_id
       JOIN project_validation_policy_revisions r
         ON r.project_id=p.project_id AND r.id=p.active_revision_id
       WHERE w.id=? AND w.status='in_progress'
         AND EXISTS (
           SELECT 1
           FROM collaboration_events ce
           JOIN collaboration_turns ct
             ON ct.run_id=ce.run_id
            AND ct.id=json_extract(ce.payload_json,'$.turnId')
           JOIN collaboration_attempts ca
             ON ca.id=ct.attempt_id AND ca.status='committed'
           WHERE ce.run_id=cr.id AND ce.type='task_claimed'
             AND json_extract(ce.payload_json,'$.workItemId')=w.id
             AND json_extract(ce.payload_json,'$.agentId')=w.assignee_agent_id
             AND ct.agent_id=w.assignee_agent_id
         )`,
    )
    .get(projectId, input.sourceCollaborationRunId, input.workItemId) as
    | {
        agentId: string;
        missionId: string;
        policyHash: string;
        policyRevisionId: string;
        policyVersion: number;
        workItemTitle: string;
      }
    | undefined;
  if (!row) return rejection(input.workItemId, "NOT_FOUND");
  return row;
}

export async function startExecution(
  databasePath: string,
  projectId: string,
  rawInput: unknown,
  executor: SandboxExecutor,
  executionRoot: string,
): Promise<StartExecutionResult> {
  const parsed = startExecutionInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new ExecutionError("INVALID_INPUT", 400, "Execution input is invalid.");
  }
  const input = parsed.data;
  const requestHash = canonicalRequestHash({
    kind: "start",
    projectId,
    sourceCollaborationRunId: input.sourceCollaborationRunId,
    workItemId: input.workItemId,
  });
  const database = openDatabase(databasePath);
  let prepared!:
    | { externalInput: Parameters<SandboxExecutor>[0] }
    | { result: StartExecutionResult };
  try {
    prepared = transaction(database, () => {
      const existing = readStartReceipt(
        database,
        projectId,
        input.operationId,
        requestHash,
      );
      if (existing) return { result: existing };
      const task = qualifyTask(database, projectId, input);
      if ("status" in task) {
        return {
          result: persistRejection(database, projectId, input, requestHash, task),
        };
      }
      const executionId = randomUUID();
      const attemptId = randomUUID();
      const actionId = randomUUID();
      const clock = database.prepare(`
        SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS startedAt,
               strftime('%Y-%m-%dT%H:%M:%fZ','now','+900 seconds') AS overallDeadlineAt
      `).get() as { overallDeadlineAt: string; startedAt: string };
      const startedAt = clock.startedAt;
      const overallDeadlineAt = clock.overallDeadlineAt;
      const sandboxRoot = join(executionRoot, projectId, executionId, "1", "sandbox");
      const frozen = captureExecutionFrozenInput(database, {
        agentId: task.agentId,
        baselineManifestHash: null,
        missionId: task.missionId,
        projectId,
        sourceCollaborationRunId: input.sourceCollaborationRunId,
        workItemId: input.workItemId,
      });

      database
        .prepare(
          `INSERT INTO executions (
             id, project_id, source_collaboration_run_id, mission_id, work_item_id,
             agent_id, current_policy_revision_id, status, resume_target,
             reason_code, manual_recovery_required, recovery_resolution,
             current_attempt_no, business_round_count, tool_call_count,
             next_event_sequence, version, created_at, business_deadline_at,
             first_running_at, updated_at, merged_at
           ) VALUES (
             ?,?,?,?,?,?,?,'queued',NULL,NULL,0,NULL,1,0,0,3,1,?,NULL,NULL,?,NULL
           )`,
        )
        .run(
          executionId,
          projectId,
          input.sourceCollaborationRunId,
          task.missionId,
          input.workItemId,
          task.agentId,
          task.policyRevisionId,
          startedAt,
          startedAt,
        );
      database
        .prepare(
          `INSERT INTO execution_operations (
             id, project_id, execution_id, kind, request_hash,
             has_external_actions, action_count, final_action_index, status,
             http_status, response_json, created_at, updated_at
           ) VALUES (?, ?, ?, 'start', ?, 1, 1, NULL, 'pending', NULL, NULL, ?, ?)`,
        )
        .run(input.operationId, projectId, executionId, requestHash, startedAt, startedAt);
      database
        .prepare(
          `INSERT INTO execution_attempts (
             id, project_id, execution_id, attempt_no, status, sandbox_root,
             baseline_manifest_path, baseline_manifest_hash, sandbox_manifest_hash,
             frozen_public_json, frozen_private_json, frozen_context_hash,
             frozen_policy_revision_id, frozen_policy_version, frozen_policy_hash,
             started_at, finished_at
           ) VALUES (?, ?, ?, 1, 'preparing', ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        )
        .run(
          attemptId,
          projectId,
          executionId,
          sandboxRoot,
          JSON.stringify(frozen.publicEnvelope),
          JSON.stringify(frozen.privateEnvelope),
          frozen.contextHash,
          task.policyRevisionId,
          task.policyVersion,
          task.policyHash,
          startedAt,
        );
      database
        .prepare(
          `INSERT INTO execution_actions (
             id, project_id, execution_id, attempt_id, operation_id, action_index,
             kind, status, request_hash, lease_token, lease_expires_at,
             overall_deadline_at, last_heartbeat_at, result_json, error_code,
             created_at, started_at, finished_at
           ) VALUES (
             ?,?,?,?, ?,0,'sandbox_build','pending',?,NULL,NULL, ?,NULL,NULL,NULL,?,NULL,NULL
           )`,
        )
        .run(
          actionId,
          projectId,
          executionId,
          attemptId,
          input.operationId,
          requestHash,
          overallDeadlineAt,
          startedAt,
        );
      const insertEvent = database.prepare(
        `INSERT INTO execution_events (
           id, project_id, execution_id, sequence, attempt_no, type,
           actor_type, actor_id, payload_json, created_at
         ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
      );
      insertEvent.run(
        randomUUID(),
        projectId,
        executionId,
        1,
        "execution_created",
        "owner",
        null,
        JSON.stringify({
          agentId: task.agentId,
          attemptNo: 1,
          workItemId: input.workItemId,
        }),
        startedAt,
      );
      insertEvent.run(
        randomUUID(),
        projectId,
        executionId,
        2,
        "action_queued",
        "system",
        null,
        JSON.stringify({
          actionId,
          actionIndex: 0,
          attemptNo: 1,
          kind: "sandbox_build",
          operationId: input.operationId,
          overallDeadlineAt,
        }),
        startedAt,
      );
      return {
        externalInput: {
          actionId,
          attemptId,
          executionId,
          operationId: input.operationId,
          projectId,
          sandboxRoot,
        },
      };
    });
  } finally {
    database.close();
  }

  if ("result" in prepared) return prepared.result;
  const actionDatabase = openDatabase(databasePath);
  try {
    const acquired = acquireExecutionAction(actionDatabase, {
      actionIndex: 0,
      operationId: prepared.externalInput.operationId,
      projectId,
    });
    if (acquired.affectedRows !== 1) {
      throw new ExecutionError(
        "SANDBOX_ACTION_INTERRUPTED",
        409,
        "The queued sandbox action could not be acquired.",
      );
    }
  } finally {
    actionDatabase.close();
  }
  return executor(prepared.externalInput);
}
