import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { commitAgentTaskActionsTx } from "@/src/server/collaboration/action-committer";
import {
  collaborationErrorBody,
  CollaborationError,
} from "@/src/server/collaboration/collaboration-errors";
import {
  canonicalRequestHash,
  completeOperationReceipt,
  readOperationReceipt,
} from "@/src/server/collaboration/operation-receipts";
import {
  buildCollaborationPromptFromDatabase,
  type CollaborationPromptSnapshot,
} from "@/src/server/collaboration/prompt-builder";
import type { StructuredTurnResult } from "@/src/server/collaboration/structured-repair";
import { openDatabase } from "@/src/server/db";
import {
  timelinePayloadSchemas,
  type CollaborationRun,
  type TimelineEvent,
  type TimelineEventType,
} from "@/src/shared/collaboration-contracts";

const CALL_LEASE_MILLISECONDS = 120_000;
const MAX_RUN_ROUNDS = 50;

type AcquireDependencies = {
  clock: () => Date;
  randomUUID: () => string;
};

type FinalizeDependencies = AcquireDependencies & {
  commitBusinessTurn?: (
    database: DatabaseSync,
    input: {
      agentId: string;
      attemptId: string;
      runId: string;
      timestamp: string;
      turn: NonNullable<StructuredTurnResult["turn"]>;
    },
  ) => void;
};

type AdvanceInput = {
  operationId: string;
};

type RecoveryDependencies = AcquireDependencies;

type RecoveryAttempt = {
  id: string;
  leaseExpiresAt: string;
  operationId: string;
  projectId: string;
  runId: string;
  status: "calling" | "committed" | "failed" | "interrupted" | "discarded";
};

export type RecoverRunResponse = {
  attempt: {
    id: string;
    leaseExpiresAt: string;
    status: RecoveryAttempt["status"];
  } | null;
  run: CollaborationRun;
};

type RunRow = {
  id: string;
  projectId: string;
  status: CollaborationRun["status"];
  currentAgentId: string;
  roundCount: number;
  pauseCategory: string | null;
  version: number;
  executionEpoch: number;
  createdAt: string;
  updatedAt: string;
};

export type AcquiredAdvance = {
  kind: "acquired";
  attempt: {
    id: string;
    operationId: string;
    leaseToken: string;
    leaseExpiresAt: string;
    promptHash: string;
    acquireExecutionEpoch: number;
    acquireContextHash: string;
    includedMessageSequence: number;
  };
  prompt: CollaborationPromptSnapshot;
};

export type PausedAdvance = {
  kind: "paused";
  boundary: "rounds" | "tokens" | "handoffs";
  run: CollaborationRun;
};

export type ReplayedAdvance = {
  kind: "replayed";
  body: unknown;
  status: number;
};

export type FinalizeAdvanceResponse = {
  affectedRows: 0 | 1;
  body: unknown;
  status: number;
};

type Boundary = {
  boundary: PausedAdvance["boundary"];
  value: number;
  limit: number;
} | null;

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
      // Preserve the collaboration error that caused the rollback.
    }
    throw error;
  }
}

function parseInput(input: unknown): AdvanceInput {
  if (!input || typeof input !== "object") {
    throw new CollaborationError("INVALID_INPUT", 400, "Advance input is invalid.");
  }
  const operationId = (input as Record<string, unknown>).operationId;
  if (
    typeof operationId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      operationId,
    )
  ) {
    throw new CollaborationError("INVALID_INPUT", 400, "Advance input is invalid.", {
      fields: { operationId: "invalid_format" },
    });
  }
  return { operationId };
}

function runRow(database: DatabaseSync, runId: string): RunRow {
  const row = database
    .prepare(
      `SELECT id, project_id AS projectId, status,
              current_agent_id AS currentAgentId, round_count AS roundCount,
              pause_category AS pauseCategory, version,
              execution_epoch AS executionEpoch,
              created_at AS createdAt, updated_at AS updatedAt
       FROM collaboration_runs
       WHERE id = ?`,
    )
    .get(runId) as RunRow | undefined;
  if (!row) {
    throw new CollaborationError("RUN_NOT_FOUND", 404, "Collaboration run was not found.");
  }
  return row;
}

function publicRun(row: RunRow): CollaborationRun {
  return {
    createdAt: row.createdAt,
    currentAgentId: row.currentAgentId,
    id: row.id,
    pauseCategory: row.pauseCategory,
    projectId: row.projectId,
    roundCount: row.roundCount,
    status: row.status,
    updatedAt: row.updatedAt,
    version: row.version,
  };
}

function recoveryAttempt(
  database: DatabaseSync,
  runId: string,
): RecoveryAttempt | undefined {
  return database
    .prepare(
      `SELECT id, project_id AS projectId, run_id AS runId,
              operation_id AS operationId, status,
              lease_expires_at AS leaseExpiresAt
       FROM collaboration_attempts
       WHERE run_id = ?
       ORDER BY started_at DESC, id DESC
       LIMIT 1`,
    )
    .get(runId) as RecoveryAttempt | undefined;
}

function appendEvent(
  database: DatabaseSync,
  dependencies: AcquireDependencies,
  runId: string,
  type: string,
  actorType: "agent" | "system",
  actorId: string | null,
  payload: Record<string, unknown>,
  timestamp: string,
): void {
  const sequence = (
    database
      .prepare(
        `SELECT next_event_sequence AS sequence
         FROM collaboration_runs WHERE id = ?`,
      )
      .get(runId) as { sequence: number }
  ).sequence;
  database
    .prepare(
      `INSERT INTO collaboration_events (
         id, run_id, sequence, type, actor_type, actor_id, payload_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      dependencies.randomUUID(),
      runId,
      sequence,
      type,
      actorType,
      actorId,
      JSON.stringify(payload),
      timestamp,
    );
  database
    .prepare(
      `UPDATE collaboration_runs
       SET next_event_sequence = next_event_sequence + 1, updated_at = ?
       WHERE id = ?`,
    )
    .run(timestamp, runId);
}

type FinalizeAttemptRow = {
  id: string;
  projectId: string;
  runId: string;
  agentId: string;
  operationId: string;
  status: "calling" | "committed" | "failed" | "interrupted" | "discarded";
  leaseToken: string;
  leaseExpiresAt: string;
  acquireExecutionEpoch: number;
  acquireContextHash: string;
};

function finalizeAttemptRow(
  database: DatabaseSync,
  runId: string,
  attemptId: string,
): FinalizeAttemptRow | undefined {
  return database
    .prepare(
      `SELECT id, project_id AS projectId, run_id AS runId,
              agent_id AS agentId, operation_id AS operationId, status,
              lease_token AS leaseToken, lease_expires_at AS leaseExpiresAt,
              acquire_execution_epoch AS acquireExecutionEpoch,
              acquire_context_hash AS acquireContextHash
       FROM collaboration_attempts
       WHERE id = ? AND run_id = ?`,
    )
    .get(attemptId, runId) as FinalizeAttemptRow | undefined;
}

function publicFinalizeRun(database: DatabaseSync, runId: string): CollaborationRun {
  return publicRun(runRow(database, runId));
}

function publicAttemptEvents(
  database: DatabaseSync,
  runId: string,
  attemptId: string,
): TimelineEvent[] {
  const rows = database
    .prepare(
      `SELECT id, run_id AS runId, sequence, type, actor_type AS actorType,
              actor_id AS actorId, payload_json AS payloadJson, created_at AS createdAt
       FROM collaboration_events
       WHERE run_id = ?
       ORDER BY sequence ASC`,
    )
    .all(runId) as Array<{
      actorId: string | null;
      actorType: "owner" | "agent" | "system";
      createdAt: string;
      id: string;
      payloadJson: string;
      runId: string;
      sequence: number;
      type: string;
    }>;
  const events = rows.map(({ payloadJson, ...row }) => {
    const schema = timelinePayloadSchemas[row.type as TimelineEventType];
    if (!schema) {
      throw new CollaborationError(
        "INTERNAL_ERROR",
        500,
        "Persisted collaboration event is invalid.",
        { category: "internal_failure" },
      );
    }
    return {
      ...row,
      payload: schema.parse(JSON.parse(payloadJson)),
    } as TimelineEvent;
  });
  const start = events.findIndex(
    (event) =>
      event.type === "model_call_started" && event.payload.attemptId === attemptId,
  );
  return start < 0 ? [] : events.slice(start);
}

function readDurableAdvance(
  database: DatabaseSync,
  attempt: FinalizeAttemptRow,
): FinalizeAdvanceResponse {
  const prior = readOperationReceipt<unknown>(
    database,
    attempt.projectId,
    attempt.operationId,
    "advance",
    canonicalRequestHash({}),
  );
  if (!prior) {
    throw new CollaborationError(
      "OPERATION_IN_PROGRESS",
      409,
      "Advance result is not durable yet.",
    );
  }
  return { affectedRows: 0, body: prior.body, status: prior.status };
}

function callStatus(
  call: StructuredTurnResult["calls"][number],
  result: StructuredTurnResult,
): "succeeded" | "provider_failed" | "response_invalid" | "usage_invalid" {
  if (
    result.status === "paused" &&
    result.pauseCategory === "structured_output_invalid" &&
    call.result.status === "succeeded"
  ) {
    return "response_invalid";
  }
  return call.result.status;
}

function persistCallAudit(
  database: DatabaseSync,
  dependencies: FinalizeDependencies,
  attempt: FinalizeAttemptRow,
  result: StructuredTurnResult,
  timestamp: string,
): void {
  result.calls.forEach((call, index) => {
    const status = callStatus(call, result);
    const usage = call.result.usage;
    const errorCategory =
      call.result.error?.category ??
      (status === "response_invalid" ? "structured_output_invalid" : null);
    const inserted = database
      .prepare(
        `INSERT OR IGNORE INTO collaboration_model_calls (
           id, attempt_id, kind, call_index, status, prompt_tokens,
           completion_tokens, total_tokens, error_category, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        dependencies.randomUUID(),
        attempt.id,
        call.kind,
        index + 1,
        status,
        usage?.promptTokens ?? null,
        usage?.completionTokens ?? null,
        usage?.totalTokens ?? null,
        errorCategory,
        timestamp,
      );
    if (inserted.changes !== 1) {
      throw new CollaborationError(
        "INTERNAL_ERROR",
        500,
        "Model call audit could not be persisted.",
        { category: "internal_failure" },
      );
    }
    appendEvent(
      database,
      dependencies,
      attempt.runId,
      status === "succeeded" ? "model_call_succeeded" : "model_call_failed",
      "agent",
      attempt.agentId,
      status === "succeeded"
        ? { attemptId: attempt.id, kind: call.kind }
        : {
            attemptId: attempt.id,
            category: errorCategory ?? "provider_response_invalid",
            kind: call.kind,
          },
      timestamp,
    );
    appendEvent(
      database,
      dependencies,
      attempt.runId,
      "usage_recorded",
      "agent",
      attempt.agentId,
      {
        attemptId: attempt.id,
        completionTokens: usage?.completionTokens ?? 0,
        kind: call.kind,
        promptTokens: usage?.promptTokens ?? 0,
        reported: usage !== null,
        totalTokens: usage?.totalTokens ?? 0,
      },
      timestamp,
    );
  });
}

function finalizeErrorFor(result: StructuredTurnResult): CollaborationError | null {
  const providerError = result.calls.find((call) => call.result.error)?.result.error;
  if (providerError) {
    return new CollaborationError(
      providerError.code,
      providerError.httpStatus,
      "Provider call failed.",
      { category: providerError.category },
    );
  }
  if (result.status === "paused" && result.pauseCategory === "structured_output_invalid") {
    return new CollaborationError(
      "STRUCTURED_OUTPUT_INVALID",
      400,
      "Structured provider output is invalid.",
      { category: "structured_output_invalid" },
    );
  }
  return null;
}

function completeAdvance(
  database: DatabaseSync,
  attempt: FinalizeAttemptRow,
  status: number,
  body: unknown,
  timestamp: string,
): void {
  completeOperationReceipt(database, {
    body,
    kind: "advance",
    operationId: attempt.operationId,
    projectId: attempt.projectId,
    requestHash: canonicalRequestHash({}),
    runId: attempt.runId,
    status,
    timestamp,
  });
}

function reconcileExpiredAttemptTx(
  database: DatabaseSync,
  runId: string,
  dependencies: RecoveryDependencies,
): {
  affectedRows: 0 | 1;
  attempt: RecoverRunResponse["attempt"];
  run: CollaborationRun;
} {
  const before = recoveryAttempt(database, runId);
  const run = runRow(database, runId);
  if (
    !before ||
    before.status !== "calling" ||
    dependencies.clock().toISOString() < before.leaseExpiresAt
  ) {
    return {
      affectedRows: 0,
      attempt: before
        ? {
            id: before.id,
            leaseExpiresAt: before.leaseExpiresAt,
            status: before.status,
          }
        : null,
      run: publicRun(run),
    };
  }

  const timestamp = dependencies.clock().toISOString();
  const update = database
    .prepare(
      `UPDATE collaboration_attempts
       SET status = 'interrupted', error_category = 'interrupted', finished_at = ?
       WHERE id = ? AND status = 'calling' AND lease_expires_at <= ?`,
    )
    .run(timestamp, before.id, timestamp);
  if (update.changes !== 1) {
    const current = recoveryAttempt(database, runId);
    return {
      affectedRows: 0,
      attempt: current
        ? {
            id: current.id,
            leaseExpiresAt: current.leaseExpiresAt,
            status: current.status,
          }
        : null,
      run: publicRun(runRow(database, runId)),
    };
  }

  database
    .prepare(
      `UPDATE collaboration_runs
       SET status = 'paused', pause_category = 'interrupted',
           pause_reason = 'interrupted', version = version + 1,
           execution_epoch = execution_epoch + 1, updated_at = ?
       WHERE id = ?`,
    )
    .run(timestamp, runId);
  database
    .prepare(
      `INSERT OR IGNORE INTO collaboration_model_calls (
         id, attempt_id, kind, call_index, status, prompt_tokens,
         completion_tokens, total_tokens, error_category, created_at
       ) VALUES (?, ?, 'primary', 1, 'provider_failed', NULL, NULL, NULL,
                 'interrupted', ?)`,
    )
    .run(dependencies.randomUUID(), before.id, timestamp);
  appendEvent(
    database,
    dependencies,
    runId,
    "attempt_interrupted",
    "system",
    null,
    { attemptId: before.id },
    timestamp,
  );
  const body = {
    attemptStatus: "interrupted" as const,
    run: publicRun(runRow(database, runId)),
  };
  completeOperationReceipt(database, {
    body,
    kind: "advance",
    operationId: before.operationId,
    projectId: before.projectId,
    requestHash: canonicalRequestHash({}),
    runId,
    status: 200,
    timestamp,
  });
  return {
    affectedRows: 1,
    attempt: {
      id: before.id,
      leaseExpiresAt: before.leaseExpiresAt,
      status: "interrupted",
    },
    run: body.run,
  };
}

const defaultRecoveryDependencies: RecoveryDependencies = {
  clock: () => new Date(),
  randomUUID,
};

export function reconcileExpiredAttempt(
  databasePath: string,
  runId: string,
  dependencies: RecoveryDependencies = defaultRecoveryDependencies,
): {
  affectedRows: 0 | 1;
  attempt: RecoverRunResponse["attempt"];
  run: CollaborationRun;
} {
  const database = openDatabase(databasePath);
  try {
    return transaction(database, () =>
      reconcileExpiredAttemptTx(database, runId, dependencies),
    );
  } finally {
    database.close();
  }
}

export function reconcileProjectExpiredAttempt(
  databasePath: string,
  projectId: string,
  dependencies: RecoveryDependencies = defaultRecoveryDependencies,
): void {
  const database = openDatabase(databasePath);
  try {
    transaction(database, () => {
      const row = database
        .prepare(
          `SELECT runs.id
           FROM collaboration_runs AS runs
           JOIN collaboration_attempts AS attempts ON attempts.run_id = runs.id
           WHERE runs.project_id = ? AND attempts.status = 'calling'
           ORDER BY attempts.started_at DESC
           LIMIT 1`,
        )
        .get(projectId) as { id: string } | undefined;
      if (row) reconcileExpiredAttemptTx(database, row.id, dependencies);
    });
  } finally {
    database.close();
  }
}

export function recoverRun(
  databasePath: string,
  runId: string,
  rawInput: unknown,
  dependencies: RecoveryDependencies = defaultRecoveryDependencies,
): { body: RecoverRunResponse; status: number } {
  const input = parseInput(rawInput);
  const requestHash = canonicalRequestHash({});
  const database = openDatabase(databasePath);
  try {
    return transaction(database, () => {
      const run = runRow(database, runId);
      const prior = readOperationReceipt<RecoverRunResponse>(
        database,
        run.projectId,
        input.operationId,
        "recover",
        requestHash,
      );
      if (prior) return prior;
      const reconciled = reconcileExpiredAttemptTx(database, runId, dependencies);
      const body: RecoverRunResponse = {
        attempt: reconciled.attempt,
        run: reconciled.run,
      };
      const timestamp = dependencies.clock().toISOString();
      completeOperationReceipt(database, {
        body,
        kind: "recover",
        operationId: input.operationId,
        projectId: run.projectId,
        requestHash,
        runId,
        status: 200,
        timestamp,
      });
      return { body, status: 200 };
    });
  } finally {
    database.close();
  }
}

function markFailure(
  database: DatabaseSync,
  dependencies: FinalizeDependencies,
  attempt: FinalizeAttemptRow,
  result: StructuredTurnResult,
  error: CollaborationError,
  timestamp: string,
  callsPersisted = false,
  runStatus: "paused" | "failed" = "paused",
): FinalizeAdvanceResponse {
  if (!callsPersisted) {
    persistCallAudit(database, dependencies, attempt, result, timestamp);
  }
  const provider = database
    .prepare(
      `SELECT providers.id AS providerId, providers.version AS providerVersion,
              providers.credential_version AS credentialVersion,
              providers.credential_generation AS credentialGeneration,
              providers.verified_at AS verifiedAt
       FROM agents
       JOIN providers ON providers.id = agents.provider_id
       WHERE agents.id = ?`,
    )
    .get(attempt.agentId) as
    | {
        providerId: string;
        providerVersion: number;
        credentialVersion: number;
        credentialGeneration: number;
        verifiedAt: string;
      }
    | undefined;
  const attemptUpdate = database
    .prepare(
      `UPDATE collaboration_attempts
       SET status = 'failed', error_category = ?,
           failure_provider_id = ?, failure_provider_version = ?,
           failure_credential_version = ?, failure_credential_generation = ?,
           failure_verified_at = ?, finished_at = ?
       WHERE id = ? AND status = 'calling' AND lease_token = ?`,
    )
    .run(
      error.details.category ?? "internal_failure",
      provider?.providerId ?? null,
      provider?.providerVersion ?? null,
      provider?.credentialVersion ?? null,
      provider?.credentialGeneration ?? null,
      provider?.verifiedAt ?? null,
      timestamp,
      attempt.id,
      attempt.leaseToken,
    );
  if (attemptUpdate.changes !== 1) return readDurableAdvance(database, attempt);
  database
    .prepare(
      `UPDATE collaboration_runs
       SET status = ?, pause_category = ?, pause_reason = ?,
           version = version + 1, updated_at = ?
       WHERE id = ? AND status = 'running'`,
    )
    .run(
      runStatus,
      error.details.category ?? "internal_failure",
      error.details.category ?? "internal_failure",
      timestamp,
      attempt.runId,
    );
  const body = collaborationErrorBody(error);
  appendEvent(
    database,
    dependencies,
    attempt.runId,
    error.details.category === "action_invalid" ? "action_rejected" : "run_paused",
    "system",
    null,
    error.details.category === "action_invalid"
      ? {
          attemptId: attempt.id,
          category: "action_invalid",
          missing: error.details.missing ?? [],
        }
      : { category: error.details.category ?? "internal_failure" },
    timestamp,
  );
  completeAdvance(database, attempt, error.httpStatus, body, timestamp);
  return { affectedRows: 1, body, status: error.httpStatus };
}

function crossedTokenBoundary(
  database: DatabaseSync,
  attempt: FinalizeAttemptRow,
): NonNullable<Boundary> | null {
  const row = database
    .prepare(
      `SELECT agents.max_tokens AS maximum,
              COALESCE(SUM(CASE
                WHEN calls.prompt_tokens IS NOT NULL
                 AND calls.completion_tokens IS NOT NULL
                 AND calls.total_tokens IS NOT NULL
                 AND calls.prompt_tokens >= 0
                 AND calls.completion_tokens >= 0
                 AND calls.total_tokens = calls.prompt_tokens + calls.completion_tokens
                THEN calls.total_tokens ELSE 0 END), 0) AS current
       FROM agents
       LEFT JOIN collaboration_attempts AS attempts
         ON attempts.agent_id = agents.id AND attempts.run_id = ?
       LEFT JOIN collaboration_model_calls AS calls ON calls.attempt_id = attempts.id
       WHERE agents.id = ?
       GROUP BY agents.id, agents.max_tokens`,
    )
    .get(attempt.runId, attempt.agentId) as
    | { current: number; maximum: number }
    | undefined;
  if (!row) {
    throw new CollaborationError("AGENT_NOT_FOUND", 404, "Current Agent was not found.");
  }
  return row.current > row.maximum
    ? { boundary: "tokens", limit: row.maximum, value: row.current }
    : null;
}

function discardAtTokenBoundary(
  database: DatabaseSync,
  dependencies: FinalizeDependencies,
  attempt: FinalizeAttemptRow,
  boundary: NonNullable<Boundary>,
  timestamp: string,
): FinalizeAdvanceResponse {
  const attemptUpdate = database
    .prepare(
      `UPDATE collaboration_attempts
       SET status = 'discarded', error_category = 'boundary_reached', finished_at = ?
       WHERE id = ? AND status = 'calling' AND lease_token = ?`,
    )
    .run(timestamp, attempt.id, attempt.leaseToken);
  if (attemptUpdate.changes !== 1) return readDurableAdvance(database, attempt);
  const runUpdate = database
    .prepare(
      `UPDATE collaboration_runs
       SET status = 'paused', pause_category = 'boundary_reached',
           pause_reason = 'tokens', version = version + 1,
           execution_epoch = execution_epoch + 1, updated_at = ?
       WHERE id = ? AND status = 'running'
         AND execution_epoch = ?`,
    )
    .run(timestamp, attempt.runId, attempt.acquireExecutionEpoch);
  if (runUpdate.changes !== 1) {
    throw new CollaborationError(
      "RUN_STATE_CONFLICT",
      409,
      "Run changed while applying the token boundary.",
    );
  }
  appendEvent(
    database,
    dependencies,
    attempt.runId,
    "boundary_paused",
    "system",
    null,
    {
      agentId: attempt.agentId,
      boundary: boundary.boundary,
      limit: boundary.limit,
      value: boundary.value,
    },
    timestamp,
  );
  const body = {
    attempt: { id: attempt.id, status: "discarded" as const },
    attemptStatus: "discarded" as const,
    events: publicAttemptEvents(database, attempt.runId, attempt.id),
    run: publicFinalizeRun(database, attempt.runId),
  };
  completeAdvance(database, attempt, 200, body, timestamp);
  return { affectedRows: 1, body, status: 200 };
}

export function finalizeAdvance(
  databasePath: string,
  runId: string,
  input: {
    attemptId: string;
    leaseToken: string;
    preflightError?: CollaborationError;
    result: StructuredTurnResult;
  },
  dependencies: FinalizeDependencies,
): FinalizeAdvanceResponse {
  const database = openDatabase(databasePath);
  const failureContext: { attempt: FinalizeAttemptRow | null } = { attempt: null };
  try {
    try {
      return transaction(database, () => {
        const attempt = finalizeAttemptRow(database, runId, input.attemptId);
        if (!attempt) {
          return {
            affectedRows: 0,
            body: collaborationErrorBody(
              new CollaborationError("RUN_STATE_CONFLICT", 409, "Attempt cannot be finalized."),
            ),
            status: 409,
          };
        }
        if (attempt.status !== "calling") return readDurableAdvance(database, attempt);
        if (attempt.leaseToken !== input.leaseToken) {
          return {
            affectedRows: 0,
            body: collaborationErrorBody(
              new CollaborationError("RUN_STATE_CONFLICT", 409, "Attempt lease token is stale."),
            ),
            status: 409,
          };
        }
        failureContext.attempt = attempt;
        const timestamp = dependencies.clock().toISOString();
        const run = runRow(database, runId);
        const leaseLive = timestamp < attempt.leaseExpiresAt;
        const contextHash = buildCollaborationPromptFromDatabase(
          database,
          attempt.projectId,
          attempt.agentId,
        ).contextHash;
        const contextMatches = contextHash === attempt.acquireContextHash;
        const executionMatches = run.executionEpoch === attempt.acquireExecutionEpoch;
        const acceptsBusiness =
          leaseLive && run.status === "running" && executionMatches && contextMatches;

        if (!acceptsBusiness) {
          persistCallAudit(database, dependencies, attempt, input.result, timestamp);
          const update = database
            .prepare(
              `UPDATE collaboration_attempts
               SET status = 'discarded', finished_at = ?
               WHERE id = ? AND status = 'calling' AND lease_token = ?`,
            )
            .run(timestamp, attempt.id, input.leaseToken);
          if (update.changes !== 1) return readDurableAdvance(database, attempt);
          if (!contextMatches && run.status === "running") {
            database
              .prepare(
                `UPDATE collaboration_runs
                 SET status = 'paused', pause_category = 'context_changed',
                     pause_reason = 'context_changed', version = version + 1,
                     updated_at = ?
                 WHERE id = ? AND status = 'running'`
              )
              .run(timestamp, runId);
            appendEvent(
              database,
              dependencies,
              runId,
              "context_changed",
              "system",
              null,
              { attemptId: attempt.id },
              timestamp,
            );
          }
          const body = {
            attempt: { id: attempt.id, status: "discarded" as const },
            attemptStatus: "discarded" as const,
            events: publicAttemptEvents(database, runId, attempt.id),
            run: publicFinalizeRun(database, runId),
          };
          completeAdvance(database, attempt, 200, body, timestamp);
          return { affectedRows: 1, body, status: 200 };
        }

        persistCallAudit(database, dependencies, attempt, input.result, timestamp);
        const tokenBoundary = crossedTokenBoundary(database, attempt);
        if (tokenBoundary) {
          return discardAtTokenBoundary(
            database,
            dependencies,
            attempt,
            tokenBoundary,
            timestamp,
          );
        }

        const publicError = input.preflightError ?? finalizeErrorFor(input.result);
        if (publicError) {
          return markFailure(
            database,
            dependencies,
            attempt,
            input.result,
            publicError,
            timestamp,
            true,
          );
        }
        if (input.result.status !== "completed" || !input.result.turn) {
          throw new CollaborationError(
            "INTERNAL_ERROR",
            500,
            "Finalized turn has no business result.",
            { category: "internal_failure" },
          );
        }

        const commitBusinessTurn =
          dependencies.commitBusinessTurn ?? commitAgentTaskActionsTx;
        commitBusinessTurn(database, {
          agentId: attempt.agentId,
          attemptId: attempt.id,
          runId,
          timestamp,
          turn: input.result.turn,
        });
        const committedStatus = runRow(database, runId).status;
        const runUpdate = database
          .prepare(
            `UPDATE collaboration_runs
             SET round_count = round_count + 1, updated_at = ?
             WHERE id = ? AND status = ? AND execution_epoch = ?`,
          )
          .run(timestamp, runId, committedStatus, attempt.acquireExecutionEpoch);
        if (runUpdate.changes !== 1) {
          throw new CollaborationError(
            "RUN_STATE_CONFLICT",
            409,
            "Run changed while finalizing.",
          );
        }
        const attemptUpdate = database
          .prepare(
            `UPDATE collaboration_attempts
             SET status = 'committed', finished_at = ?
             WHERE id = ? AND status = 'calling' AND lease_token = ?`,
          )
          .run(timestamp, attempt.id, input.leaseToken);
        if (attemptUpdate.changes !== 1) {
          throw new CollaborationError(
            "RUN_STATE_CONFLICT",
            409,
            "Attempt changed while finalizing.",
          );
        }
        const body = {
          attempt: { id: attempt.id, status: "committed" as const },
          attemptStatus: "committed" as const,
          events: publicAttemptEvents(database, runId, attempt.id),
          run: publicFinalizeRun(database, runId),
        };
        completeAdvance(database, attempt, 200, body, timestamp);
        return { affectedRows: 1, body, status: 200 };
      });
    } catch (error) {
      if (!failureContext.attempt) throw error;
      const attempt = failureContext.attempt;
      const durableError =
        error instanceof CollaborationError
          ? error
          : new CollaborationError(
              "INTERNAL_ERROR",
              500,
              "Internal collaboration error.",
              { category: "internal_failure" },
            );
      return transaction(database, () => {
        const current = finalizeAttemptRow(database, runId, attempt.id);
        if (!current || current.status !== "calling") {
          return current
            ? readDurableAdvance(database, current)
            : {
                affectedRows: 0,
                body: collaborationErrorBody(durableError),
                status: durableError.httpStatus,
              };
        }
        return markFailure(
          database,
          dependencies,
          current,
          input.result,
          durableError,
          dependencies.clock().toISOString(),
          false,
          error instanceof CollaborationError ? "paused" : "failed",
        );
      });
    }
  } finally {
    database.close();
  }
}

function preBoundary(database: DatabaseSync, run: RunRow): Boundary {
  if (run.roundCount >= MAX_RUN_ROUNDS) {
    return { boundary: "rounds", limit: MAX_RUN_ROUNDS, value: run.roundCount };
  }

  const agent = database
    .prepare(
      `SELECT max_tokens AS maxTokens, max_handoffs AS maxHandoffs
       FROM agents WHERE id = ?`,
    )
    .get(run.currentAgentId) as
    | { maxTokens: number; maxHandoffs: number }
    | undefined;
  if (!agent) {
    throw new CollaborationError("AGENT_NOT_FOUND", 404, "Current Agent was not found.");
  }
  const tokens = (
    database
      .prepare(
        `SELECT COALESCE(SUM(CASE
                  WHEN calls.prompt_tokens IS NOT NULL
                   AND calls.completion_tokens IS NOT NULL
                   AND calls.total_tokens IS NOT NULL
                   AND calls.prompt_tokens >= 0
                   AND calls.completion_tokens >= 0
                   AND calls.total_tokens = calls.prompt_tokens + calls.completion_tokens
                  THEN calls.total_tokens ELSE 0 END), 0) AS value
         FROM collaboration_model_calls AS calls
         JOIN collaboration_attempts AS attempts ON attempts.id = calls.attempt_id
         WHERE attempts.run_id = ? AND attempts.agent_id = ?
        `,
      )
      .get(run.id, run.currentAgentId) as { value: number }
  ).value;
  if (tokens >= agent.maxTokens) {
    return { boundary: "tokens", limit: agent.maxTokens, value: tokens };
  }

  const handoffs = (
    database
      .prepare(
        `SELECT COUNT(*) AS value
         FROM collaboration_turns
         WHERE run_id = ? AND agent_id = ? AND disposition = 'handoff'`,
      )
      .get(run.id, run.currentAgentId) as { value: number }
  ).value;
  if (handoffs >= agent.maxHandoffs) {
    return { boundary: "handoffs", limit: agent.maxHandoffs, value: handoffs };
  }
  return null;
}

function ensureAcquirable(database: DatabaseSync, run: RunRow): void {
  if (run.status !== "running") {
    throw new CollaborationError(
      "RUN_STATE_CONFLICT",
      409,
      "Only a running collaboration can advance.",
    );
  }
  if (
    database
      .prepare(
        `SELECT 1 FROM decision_requests
         WHERE run_id = ? AND status = 'open'`,
      )
      .get(run.id)
  ) {
    throw new CollaborationError(
      "RUN_STATE_CONFLICT",
      409,
      "A collaboration decision is waiting for the owner.",
    );
  }
  if (
    database
      .prepare(
        `SELECT 1 FROM collaboration_attempts
         WHERE run_id = ? AND status = 'calling'`,
      )
      .get(run.id)
  ) {
    throw new CollaborationError("TURN_IN_PROGRESS", 409, "An Agent turn is in progress.");
  }
}

function pauseAtBoundary(
  database: DatabaseSync,
  dependencies: AcquireDependencies,
  run: RunRow,
  boundary: NonNullable<Boundary>,
  operationId: string,
  requestHash: string,
  timestamp: string,
): PausedAdvance {
  database
    .prepare(
      `UPDATE collaboration_runs
       SET status = 'paused', pause_category = 'boundary_reached',
           pause_reason = ?, version = version + 1,
           execution_epoch = execution_epoch + 1, updated_at = ?
       WHERE id = ? AND status = 'running'`,
    )
    .run(boundary.boundary, timestamp, run.id);
  appendEvent(
    database,
    dependencies,
    run.id,
    "boundary_paused",
    "system",
    null,
    {
      agentId: run.currentAgentId,
      boundary: boundary.boundary,
      limit: boundary.limit,
      value: boundary.value,
    },
    timestamp,
  );
  const result: PausedAdvance = {
    boundary: boundary.boundary,
    kind: "paused",
    run: publicRun(runRow(database, run.id)),
  };
  completeOperationReceipt(database, {
    body: result,
    kind: "advance",
    operationId,
    projectId: run.projectId,
    requestHash,
    runId: run.id,
    status: 200,
    timestamp,
  });
  return result;
}

export function acquireAdvance(
  databasePath: string,
  runId: string,
  rawInput: unknown,
  dependencies: AcquireDependencies,
): AcquiredAdvance | PausedAdvance | ReplayedAdvance {
  const input = parseInput(rawInput);
  reconcileExpiredAttempt(databasePath, runId, dependencies);
  const requestHash = canonicalRequestHash({});
  const database = openDatabase(databasePath);
  let projectId: string | null = null;
  try {
    return transaction(database, () => {
      const run = runRow(database, runId);
      projectId = run.projectId;
      const prior = readOperationReceipt<unknown>(
        database,
        run.projectId,
        input.operationId,
        "advance",
        requestHash,
      );
      if (prior) {
        return { body: prior.body, kind: "replayed", status: prior.status };
      }

      ensureAcquirable(database, run);
      const now = dependencies.clock();
      const timestamp = now.toISOString();
      const boundary = preBoundary(database, run);
      if (boundary) {
        return pauseAtBoundary(
          database,
          dependencies,
          run,
          boundary,
          input.operationId,
          requestHash,
          timestamp,
        );
      }

      const prompt = buildCollaborationPromptFromDatabase(
        database,
        run.projectId,
        run.currentAgentId,
      );
      const attemptId = dependencies.randomUUID();
      const leaseToken = dependencies.randomUUID();
      const leaseExpiresAt = new Date(now.getTime() + CALL_LEASE_MILLISECONDS).toISOString();
      database
        .prepare(
          `INSERT INTO collaboration_operations (
             id, project_id, run_id, kind, request_hash, status,
             http_status, response_json, created_at, updated_at
           ) VALUES (?, ?, ?, 'advance', ?, 'pending', NULL, NULL, ?, ?)`,
        )
        .run(
          input.operationId,
          run.projectId,
          run.id,
          requestHash,
          timestamp,
          timestamp,
        );
      database
        .prepare(
          `INSERT INTO collaboration_attempts (
             id, project_id, run_id, agent_id, operation_id, status,
             lease_token, lease_expires_at, prompt_hash,
             acquire_execution_epoch, acquire_context_hash,
             included_message_sequence, error_category, started_at, finished_at
           ) VALUES (
             ?, ?, ?, ?, ?, 'calling', ?, ?, ?, ?, ?, ?, NULL, ?, NULL
           )`,
        )
        .run(
          attemptId,
          run.projectId,
          run.id,
          run.currentAgentId,
          input.operationId,
          leaseToken,
          leaseExpiresAt,
          prompt.promptHash,
          run.executionEpoch,
          prompt.contextHash,
          prompt.includedMessageSequence,
          timestamp,
        );
      appendEvent(
        database,
        dependencies,
        run.id,
        "model_call_started",
        "agent",
        run.currentAgentId,
        { agentId: run.currentAgentId, attemptId, kind: "primary" },
        timestamp,
      );
      return {
        attempt: {
          acquireContextHash: prompt.contextHash,
          acquireExecutionEpoch: run.executionEpoch,
          id: attemptId,
          includedMessageSequence: prompt.includedMessageSequence,
          leaseExpiresAt,
          leaseToken,
          operationId: input.operationId,
          promptHash: prompt.promptHash,
        },
        kind: "acquired",
        prompt,
      };
    });
  } catch (error) {
    if (
      projectId &&
      error instanceof CollaborationError &&
      error.code !== "OPERATION_CONFLICT" &&
      error.code !== "OPERATION_IN_PROGRESS"
    ) {
      const timestamp = dependencies.clock().toISOString();
      completeOperationReceipt(database, {
        body: collaborationErrorBody(error),
        kind: "advance",
        operationId: input.operationId,
        projectId,
        requestHash,
        runId,
        status: error.httpStatus,
        timestamp,
      });
    }
    throw error;
  } finally {
    database.close();
  }
}
