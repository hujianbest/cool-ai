import { createHash, randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { canonicalRequestHash } from "@/src/server/collaboration/operation-receipts";
import type { OpenAiChatRequest } from "@/src/server/collaboration/openai-chat-client";
import {
  createCredentialVault,
  CredentialVaultError,
  type CredentialEnvelope,
} from "@/src/server/credential-vault";
import { openDatabase } from "@/src/server/db";
import {
  acquireExecutionAction,
  finalizeExecutionAction,
  finalizeExecutionActionWithEffects,
  reconcileExecutionAction,
} from "@/src/server/execution/execution-actions";
import type { ExecutionAction } from "@/src/server/execution/execution-action-schema";
import {
  buildFrozenExecutionPrompt,
  type ExecutionTypedToolResult,
  type FrozenExecutionPromptInput,
} from "@/src/server/execution/execution-prompt-builder";
import {
  executeStructuredExecutionAction,
  type ExecutionStructuredFaultPoint,
} from "@/src/server/execution/execution-structured-repair";
import {
  executeListToolAction,
  executeReadToolAction,
  executeWriteToolAction,
  type SandboxExecutionFileAdapter,
} from "@/src/server/execution/file-tools";
import {
  beginExternalOperation,
  readExecutionOperation,
} from "@/src/server/execution/execution-operations";
import {
  requestExecutionCommand,
} from "@/src/server/execution/command-request";
import { consumeApprovedCommand } from "@/src/server/execution/execution-approval-service";
import { executeCommandProcessAction } from "@/src/server/execution/process-runner";
import {
  assertManualRecoveryNotRequired,
  getExecution,
  ExecutionError,
} from "@/src/server/execution/execution-service";
import {
  appendExecutionEvent,
  preExecutionBoundary,
  type ExecutionBudgetBoundary,
} from "@/src/server/execution/execution-usage-budget";
import { staleExecutionIfFrozenInputChanged } from "@/src/server/execution/execution-frozen-input";
import { staleExecutionForCanonicalPathChanges } from "@/src/server/execution/execution-conflicts";
import {
  computeStagedSnapshot,
  persistComputedStage,
  type ExecutionStagingAdapter,
  type StagingEntry,
} from "@/src/server/execution/stage-service";
import {
  advanceExecutionInputSchema,
  advanceExecutionResponseSchema,
  type AdvanceExecutionResponse,
} from "@/src/shared/execution-contracts";

// The adapter's opaque handle/rollback types never escape the existing tool boundary.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FileAdapter = SandboxExecutionFileAdapter<any, any>;
type AdvanceResult = { body: unknown; status: number };

export type ExecutionOrchestratorDependencies = {
  fileAdapter: FileAdapter;
  modelFaultInjector?: (point: ExecutionStructuredFaultPoint) => void;
  onModelStarted?: (executionId: string) => void;
  stagingAdapter?: ExecutionStagingAdapter;
};

type StateRow = {
  agentId: string;
  attemptId: string;
  attemptNo: number;
  attemptStatus: AdvanceExecutionResponse["attempt"]["status"];
  businessDeadlineAt: string | null;
  businessRound: number;
  executionRoot: string;
  frozenPrivateJson: string;
  projectId: string;
  sandboxRoot: string;
  status: string;
  version: number;
  workspaceRoot: string;
};

type ProviderRow = {
  apiKeyCipher: string;
  apiKeyIv: string;
  apiKeyMask: string;
  apiKeyTag: string;
  baseUrl: string;
  credentialVersion: number;
  keyId: string;
  model: string;
  providerId: string;
  verifiedAt: string;
};

type PendingModelAction = {
  action: ExecutionAction["action"];
  actionId: string;
  summary: string;
};

const anyResponseSchema = { parse: (value: unknown) => value };

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
      // Preserve the stable orchestration error.
    }
    throw error;
  }
}

function stateRow(database: DatabaseSync, executionId: string): StateRow {
  const row = database.prepare(`
    SELECT e.project_id AS projectId,e.agent_id AS agentId,e.status,e.version,
           e.current_attempt_no AS attemptNo,e.business_round_count AS businessRound,
           e.business_deadline_at AS businessDeadlineAt,
           a.id AS attemptId,a.status AS attemptStatus,a.sandbox_root AS sandboxRoot,
           a.frozen_private_json AS frozenPrivateJson,p.workspace_path AS workspaceRoot
    FROM executions e
    JOIN execution_attempts a
      ON a.project_id=e.project_id AND a.execution_id=e.id
     AND a.attempt_no=e.current_attempt_no
    JOIN projects p ON p.id=e.project_id
    WHERE e.id=?
  `).get(executionId) as Omit<StateRow, "executionRoot"> | undefined;
  if (!row) throw new ExecutionError("EXECUTION_NOT_FOUND", 404, "Execution was not found.");
  return {
    ...row,
    executionRoot: dirname(dirname(dirname(row.sandboxRoot))),
  };
}

function parseFrozenPrompt(row: StateRow): FrozenExecutionPromptInput {
  let stored: unknown;
  try {
    stored = JSON.parse(row.frozenPrivateJson);
  } catch {
    throw new ExecutionError("INTERNAL_ERROR", 500, "Frozen execution input is unavailable.");
  }
  const promptInput = (stored as { promptInput?: unknown })?.promptInput;
  if (!promptInput || typeof promptInput !== "object") {
    throw new ExecutionError("INTERNAL_ERROR", 500, "Frozen execution input is unavailable.");
  }
  return promptInput as FrozenExecutionPromptInput;
}

function providerConnection(database: DatabaseSync, agentId: string) {
  const row = database.prepare(`
    SELECT p.id AS providerId,p.base_url AS baseUrl,a.model,
           p.api_key_cipher AS apiKeyCipher,p.api_key_iv AS apiKeyIv,
           p.api_key_tag AS apiKeyTag,p.api_key_mask AS apiKeyMask,
           p.credential_version AS credentialVersion,p.key_id AS keyId,
           p.verified_at AS verifiedAt
    FROM agents a JOIN providers p ON p.id=a.provider_id WHERE a.id=?
  `).get(agentId) as ProviderRow | undefined;
  if (!row || !row.verifiedAt) {
    throw new ExecutionError("CREDENTIAL_UNAVAILABLE", 503, "Provider credential is unavailable.");
  }
  const envelope: CredentialEnvelope = {
    apiKeyCipher: row.apiKeyCipher,
    apiKeyIv: row.apiKeyIv,
    apiKeyMask: row.apiKeyMask,
    apiKeyTag: row.apiKeyTag,
    credentialVersion: row.credentialVersion as 1,
    keyId: row.keyId,
  };
  try {
    return {
      apiKey: createCredentialVault().decrypt(row.providerId, envelope),
      baseUrl: row.baseUrl,
      model: row.model,
    };
  } catch (error) {
    if (error instanceof CredentialVaultError) {
      throw new ExecutionError("CREDENTIAL_UNAVAILABLE", 503, "Provider credential is unavailable.");
    }
    throw error;
  }
}

function storedToolResults(database: DatabaseSync, executionId: string): ExecutionTypedToolResult[] {
  const rows = database.prepare(`
    SELECT id,type,status,public_result_json AS resultJson
    FROM execution_tool_calls
    WHERE execution_id=? AND status IN ('succeeded','rejected','failed','interrupted')
    ORDER BY started_at,id
  `).all(executionId) as Array<{
    id: string;
    resultJson: string | null;
    status: ExecutionTypedToolResult["status"];
    type: ExecutionTypedToolResult["type"];
  }>;
  return rows.map((row) => {
    let result: Record<string, unknown> = {};
    try {
      result = row.resultJson ? JSON.parse(row.resultJson) as Record<string, unknown> : {};
    } catch {
      result = {};
    }
    return {
      code: typeof result.code === "string" ? result.code : null,
      status: row.status,
      toolCallId: row.id,
      type: row.type,
      ...(typeof result.path === "string" ? { path: result.path } : {}),
      ...(Array.isArray(result.entries) ? { entries: result.entries as never } : {}),
      ...(typeof result.content === "string" ? { content: result.content } : {}),
      ...(typeof result.beforeHash === "string" || result.beforeHash === null
        ? { beforeHash: result.beforeHash as string | null }
        : {}),
      ...(typeof result.afterHash === "string" || result.afterHash === null
        ? { afterHash: result.afterHash as string | null }
        : {}),
    };
  });
}

function pendingModelAction(database: DatabaseSync, executionId: string): PendingModelAction | null {
  const latest = database.prepare(`
    SELECT a.id,a.kind,a.result_json AS resultJson,
           EXISTS(
             SELECT 1 FROM execution_tool_calls t
             WHERE t.attempt_id=a.attempt_id
               AND t.business_round=(
                 SELECT MAX(c.business_round) FROM execution_model_calls c
                 WHERE c.action_id=a.id
               )
           ) AS consumed
    FROM execution_actions a
    WHERE a.execution_id=? AND a.status IN ('succeeded','failed','interrupted','discarded')
      AND a.kind<>'sandbox_build'
    ORDER BY a.created_at DESC,a.id DESC LIMIT 1
  `).get(executionId) as {
    consumed: number;
    id: string;
    kind: string;
    resultJson: string | null;
  } | undefined;
  if (!latest || latest.kind !== "model" || latest.consumed === 1 || !latest.resultJson) {
    return null;
  }
  try {
    const result = JSON.parse(latest.resultJson) as {
      nextAction?: ExecutionAction["action"];
      summary?: string;
    };
    return result.nextAction && typeof result.summary === "string"
      ? { action: result.nextAction, actionId: latest.id, summary: result.summary }
      : null;
  } catch {
    return null;
  }
}

function publicResponse(
  databasePath: string,
  executionId: string,
  row: StateRow,
  kind: AdvanceExecutionResponse["actionResult"]["kind"],
  status: AdvanceExecutionResponse["actionResult"]["status"],
  summary: string,
  nextVersion?: number,
  executionState?: Pick<
    AdvanceExecutionResponse["execution"],
    "reasonCode" | "resumeTarget" | "status"
  >,
): AdvanceExecutionResponse {
  const execution = getExecution(databasePath, executionId);
  execution.currentAction = {
    actionIndex: null,
    kind: null,
    lastHeartbeatAt: null,
    overallDeadlineAt: null,
    startedAt: null,
  };
  if (nextVersion !== undefined) execution.version = nextVersion;
  if (executionState) Object.assign(execution, executionState);
  return advanceExecutionResponseSchema.parse({
    actionResult: { kind, status, summary },
    attempt: {
      attemptNo: row.attemptNo,
      id: row.attemptId,
      status: row.attemptStatus,
    },
    execution,
    newEvents: [],
  });
}

function requestHash(executionId: string, expectedVersion: number): string {
  return canonicalRequestHash({ executionId, expectedVersion, kind: "advance" });
}

function reconcileExpiredModelAction(database: DatabaseSync, executionId: string): void {
  const expired = database.prepare(`
    SELECT id,project_id AS projectId FROM execution_actions
    WHERE execution_id=? AND kind='model' AND status='running'
      AND (
        lease_expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        OR overall_deadline_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      )
    ORDER BY created_at,id LIMIT 1
  `).get(executionId) as { id: string; projectId: string } | undefined;
  if (!expired) return;
  reconcileExecutionAction(database, {
    actionId: expired.id,
    body: {
      error: {
        code: "MODEL_ACTION_INTERRUPTED",
        message: "The model action lease expired before its result was committed.",
      },
    },
    errorCode: "MODEL_ACTION_INTERRUPTED",
    httpStatus: 409,
    projectId: expired.projectId,
  });
}

function pauseAtBudgetBoundary(
  databasePath: string,
  database: DatabaseSync,
  executionId: string,
  row: StateRow,
  operationId: string,
  hash: string,
  boundary: {
    boundary: ExecutionBudgetBoundary;
    limit: number;
    value: number;
  },
): AdvanceResult {
  const body = publicResponse(
    databasePath,
    executionId,
    row,
    "model",
    "failed",
    boundary.boundary,
    row.version + 1,
    {
      reasonCode: boundary.boundary,
      resumeTarget: "running",
      status: "paused",
    },
  );
  transaction(database, () => {
    const updated = database.prepare(`
      UPDATE executions SET status='paused',resume_target='running',reason_code=?,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),version=version+1
      WHERE project_id=? AND id=? AND version=? AND status IN ('queued','running')
    `).run(boundary.boundary, row.projectId, executionId, row.version);
    if (updated.changes !== 1) {
      throw new ExecutionError("EXECUTION_STATE_CONFLICT", 409, "Execution changed concurrently.");
    }
    appendExecutionEvent(database, {
      actorId: null,
      actorType: "system",
      executionId,
      payload: {
        agentId: row.agentId,
        boundary: boundary.boundary,
        limit: boundary.limit,
        value: boundary.value,
      },
      projectId: row.projectId,
      type: "boundary_paused",
    });
    const timestamp = new Date().toISOString();
    database.prepare(`
      INSERT INTO execution_operations (
        id,project_id,execution_id,kind,request_hash,has_external_actions,
        action_count,final_action_index,status,http_status,response_json,created_at,updated_at
      ) VALUES (?, ?, ?, 'advance', ?, 0, 0, NULL, 'completed', 409, ?, ?, ?)
    `).run(
      operationId,
      row.projectId,
      executionId,
      hash,
      JSON.stringify(body),
      timestamp,
      timestamp,
    );
  });
  return { body, status: 409 };
}

function createAction(
  database: DatabaseSync,
  row: StateRow,
  operationId: string,
  hash: string,
  kind: "model" | "file_list" | "file_read" | "file_write" | "stage_compute",
): { actionId: string; actionIndex: number } {
  const actionId = randomUUID();
  const deadline = row.businessDeadlineAt
    ?? (database.prepare(
      "SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now','+900 seconds') AS value",
    ).get() as { value: string }).value;
  const begun = beginExternalOperation(database, {
    action: {
      actionId,
      attemptId: row.attemptId,
      kind,
      overallDeadlineAt: deadline,
      requestHash: hash,
    },
    executionId: (database.prepare(
      "SELECT execution_id AS id FROM execution_attempts WHERE id=?",
    ).get(row.attemptId) as { id: string }).id,
    kind: "advance",
    operationId,
    projectId: row.projectId,
    requestHash: hash,
    responseSchema: anyResponseSchema,
    timestamp: new Date().toISOString(),
  });
  if ("body" in begun) throw new ExecutionError("OPERATION_CONFLICT", 409, "Operation replay changed.");
  return { actionId, actionIndex: begun.actionIndex };
}

function markAttemptActing(database: DatabaseSync, row: StateRow): void {
  const updated = database.prepare(`
    UPDATE execution_attempts SET status='acting'
    WHERE project_id=? AND id=? AND status='ready'
  `).run(row.projectId, row.attemptId);
  if (updated.changes !== 1 && row.attemptStatus !== "acting") {
    throw new ExecutionError("EXECUTION_STATE_CONFLICT", 409, "Execution attempt is not ready.");
  }
}

async function runModel(
  databasePath: string,
  database: DatabaseSync,
  executionId: string,
  row: StateRow,
  operationId: string,
  hash: string,
  dependencies: ExecutionOrchestratorDependencies,
): Promise<AdvanceResult> {
  let provider: ReturnType<typeof providerConnection>;
  try {
    provider = providerConnection(database, row.agentId);
  } catch (error) {
    if (!(error instanceof ExecutionError) || error.code !== "CREDENTIAL_UNAVAILABLE") {
      throw error;
    }
    const body = {
      error: {
        code: "CREDENTIAL_UNAVAILABLE",
        message: "Provider credential is unavailable.",
      },
    };
    transaction(database, () => {
      const updated = database.prepare(`
        UPDATE executions
        SET status='paused',resume_target='running',reason_code='CREDENTIAL_UNAVAILABLE',
            version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id=? AND version=? AND status IN ('queued','running')
      `).run(executionId, row.version);
      if (updated.changes !== 1) {
        throw new ExecutionError(
          "EXECUTION_STATE_CONFLICT",
          409,
          "Execution changed concurrently.",
        );
      }
      const timestamp = new Date().toISOString();
      database.prepare(`
        INSERT INTO execution_operations (
          id,project_id,execution_id,kind,request_hash,has_external_actions,
          action_count,final_action_index,status,http_status,response_json,created_at,updated_at
        ) VALUES (?, ?, ?, 'advance', ?, 0, 0, NULL, 'completed', 503, ?, ?, ?)
      `).run(
        operationId,
        row.projectId,
        executionId,
        hash,
        JSON.stringify(body),
        timestamp,
        timestamp,
      );
    });
    return { body, status: 503 };
  }
  markAttemptActing(database, row);
  const { actionId, actionIndex } = createAction(database, row, operationId, hash, "model");
  const acquired = acquireExecutionAction(database, {
    actionIndex,
    operationId,
    projectId: row.projectId,
  });
  if (acquired.affectedRows !== 1 || !acquired.leaseToken) {
    throw new ExecutionError("OPERATION_IN_PROGRESS", 409, "Model action is already in progress.");
  }
  dependencies.onModelStarted?.(executionId);
  const frozenInput = parseFrozenPrompt(row);
  frozenInput.priorToolResults = storedToolResults(database, executionId);
  const prompt = buildFrozenExecutionPrompt(frozenInput);
  const request: OpenAiChatRequest = {
    ...provider,
    messages: prompt.messages,
  };
  const result = await executeStructuredExecutionAction({
    actionId,
    businessRound: row.businessRound + 1,
    context: {
      attemptId: row.attemptId,
      correlationId: randomUUID(),
      runId: executionId,
    },
    database,
    leaseToken: acquired.leaseToken,
    modelFaultInjector: dependencies.modelFaultInjector,
    permissions: frozenInput.currentAgent.permissions,
    projectId: row.projectId,
    request,
  });
  const inputBoundary = staleExecutionIfFrozenInputChanged(database, executionId);
  if (inputBoundary.disposition === "stale") {
    return { body: inputBoundary.body, status: 409 };
  }
  if (result.status === "lease_lost") {
    return finalizeLateDiscard(database, databasePath, executionId, row, operationId, actionId);
  }
  const successful = result.status === "completed" && result.action !== null;
  const summary = result.action?.summary ?? result.pauseCategory ?? result.status;
  const body = publicResponse(
    databasePath,
    executionId,
    { ...row, attemptStatus: "acting" },
    "model",
    successful ? "succeeded" : "failed",
    summary,
  );
  const finalized = finalizeExecutionAction(database, {
    actionId,
    body,
    httpStatus: successful ? 200 : result.status === "provider_failed" ? 502 : 409,
    leaseToken: acquired.leaseToken,
    projectId: row.projectId,
    result: {
      nextAction: result.action?.action ?? null,
      summary,
    },
    status: successful ? "succeeded" : "failed",
  });
  if (finalized.affectedRows !== 1) {
    return finalizeLateDiscard(database, databasePath, executionId, row, operationId, actionId);
  }
  return { body, status: successful ? 200 : result.status === "provider_failed" ? 502 : 409 };
}

function finalizeLateDiscard(
  database: DatabaseSync,
  databasePath: string,
  executionId: string,
  row: StateRow,
  operationId: string,
  actionId: string,
): AdvanceResult {
  const body = {
    error: {
      code: "ACTION_LEASE_LOST",
      message: "The late action result was discarded.",
    },
  };
  transaction(database, () => {
    database.prepare(`
      UPDATE execution_model_calls SET status='discarded',error_category='late_result'
      WHERE action_id=? AND status IN ('calling','succeeded','provider_failed',
        'response_invalid','usage_invalid','interrupted')
    `).run(actionId);
    database.prepare(`
      UPDATE execution_actions
      SET status='discarded',lease_token=NULL,lease_expires_at=NULL,
          result_json=NULL,error_code='ACTION_LEASE_LOST',
          finished_at=coalesce(finished_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      WHERE id=? AND status='running'
    `).run(actionId);
    database.prepare(`
      UPDATE execution_operations
      SET status='completed',final_action_index=0,http_status=409,response_json=?,
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id=? AND project_id=? AND status='pending'
    `).run(JSON.stringify(body), operationId, row.projectId);
  });
  void databasePath;
  void executionId;
  return { body, status: 409 };
}

async function runFileTool(
  databasePath: string,
  database: DatabaseSync,
  executionId: string,
  row: StateRow,
  operationId: string,
  hash: string,
  pending: PendingModelAction,
  dependencies: ExecutionOrchestratorDependencies,
): Promise<AdvanceResult> {
  const kind = pending.action.type === "list"
    ? "file_list"
    : pending.action.type === "read"
      ? "file_read"
      : "file_write";
  const { actionId, actionIndex } = createAction(database, row, operationId, hash, kind);
  const common = {
    actionIndex,
    database,
    failureResponseBody: publicResponse(
      databasePath,
      executionId,
      row,
      kind,
      "failed",
      "SANDBOX_UNVERIFIABLE",
      row.version + 1,
      { reasonCode: "SANDBOX_UNVERIFIABLE", resumeTarget: "running", status: "paused" },
    ),
    fs: dependencies.fileAdapter,
    hardFailureResponseBody: publicResponse(
      databasePath,
      executionId,
      row,
      kind,
      "failed",
      "SANDBOX_UNVERIFIABLE",
      row.version + 1,
      { reasonCode: "SANDBOX_UNVERIFIABLE", resumeTarget: null, status: "failed" },
    ),
    operationId,
    projectId: row.projectId,
    responseBody: publicResponse(
      databasePath,
      executionId,
      row,
      kind,
      "succeeded",
      pending.summary,
      row.version + 1,
    ),
    sandboxRoot: row.sandboxRoot,
  };
  let result;
  try {
    result = pending.action.type === "list"
      ? await executeListToolAction({ ...common, path: pending.action.path })
      : pending.action.type === "read"
        ? await executeReadToolAction({
            ...common,
            path: pending.action.path,
            redaction: {
              masterKeyMarker: process.env.COCKPIT_MASTER_KEY,
              providerApiKey: providerConnection(database, row.agentId).apiKey,
            },
          })
        : pending.action.type === "write"
          ? await executeWriteToolAction({
              ...common,
              content: pending.action.content,
              expectedHash: pending.action.expectedHash,
              path: pending.action.path,
            })
          : null;
  } catch (error) {
    if ((error as { code?: unknown })?.code !== "SANDBOX_UNVERIFIABLE") throw error;
    const action = database.prepare(`
      SELECT a.lease_token AS leaseToken,a.started_at AS startedAt,
             e.next_event_sequence AS sequence
      FROM execution_actions a
      JOIN executions e ON e.project_id=a.project_id AND e.id=a.execution_id
      WHERE a.project_id=? AND a.id=? AND a.status='running'
    `).get(row.projectId, actionId) as
      | { leaseToken: string; sequence: number; startedAt: string }
      | undefined;
    if (!action?.leaseToken) {
      const receipt = readExecutionOperation(database, {
        kind: "advance",
        operationId,
        projectId: row.projectId,
        requestHash: hash,
        responseSchema: anyResponseSchema,
      });
      if (receipt) return receipt;
      throw error;
    }
    const writeState = (error as { mutationState?: unknown }).mutationState;
    const hardFailure = pending.action.type === "write"
      && (writeState === "post-replace-unverifiable" || writeState === "cleanup-unconfirmed");
    const body = publicResponse(
      databasePath,
      executionId,
      row,
      kind,
      "failed",
      "SANDBOX_UNVERIFIABLE",
      row.version + 1,
      hardFailure
        ? { reasonCode: "SANDBOX_UNVERIFIABLE", resumeTarget: null, status: "failed" }
        : { reasonCode: "SANDBOX_UNVERIFIABLE", resumeTarget: "running", status: "paused" },
    );
    if (!("path" in pending.action)) throw error;
    const request = pending.action.type === "write"
      ? {
          expectedHash: pending.action.expectedHash,
          path: pending.action.path,
          type: pending.action.type,
        }
      : { path: pending.action.path, type: pending.action.type };
    const toolCallId = randomUUID();
    const eventId = randomUUID();
    const finalized = finalizeExecutionActionWithEffects(database, {
      actionId,
      body,
      errorCode: "SANDBOX_UNVERIFIABLE",
      effects(currentDatabase) {
        currentDatabase.prepare(`
          INSERT INTO execution_tool_calls (
            id,project_id,execution_id,attempt_id,action_id,business_round,type,
            request_hash,status,public_request_json,public_result_json,
            before_sandbox_hash,after_sandbox_hash,started_at,finished_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'failed', ?, ?, NULL, NULL, ?,
            strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        `).run(
          toolCallId,
          row.projectId,
          executionId,
          row.attemptId,
          actionId,
          Math.max(1, row.businessRound),
          pending.action.type,
          hash,
          JSON.stringify(request),
          JSON.stringify({ code: "SANDBOX_UNVERIFIABLE" }),
          action.startedAt,
        );
        const execution = currentDatabase.prepare(`
          UPDATE executions
          SET status=?,resume_target=?,reason_code='SANDBOX_UNVERIFIABLE',
              tool_call_count=tool_call_count+1,next_event_sequence=next_event_sequence+1,
              version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE project_id=? AND id=? AND status='running' AND version=?
        `).run(
          hardFailure ? "failed" : "paused",
          hardFailure ? null : "running",
          row.projectId,
          executionId,
          action.sequence,
        );
        if (execution.changes !== 1) {
          throw new Error("Execution changed before the native failure could commit.");
        }
        if (hardFailure) {
          currentDatabase.prepare(`
            UPDATE execution_attempts
            SET status='failed',finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
            WHERE id=? AND status IN ('ready','acting')
          `).run(row.attemptId);
        }
        currentDatabase.prepare(`
          INSERT INTO execution_events (
            id,project_id,execution_id,sequence,attempt_no,type,actor_type,
            actor_id,payload_json,created_at
          ) VALUES (?, ?, ?, ?, ?, 'tool_failed', 'agent', NULL, ?,
            strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        `).run(
          eventId,
          row.projectId,
          executionId,
          row.version,
          row.attemptNo,
          JSON.stringify({
            code: "SANDBOX_UNVERIFIABLE",
            toolCallId,
            type: pending.action.type,
          }),
        );
      },
      httpStatus: 422,
      leaseToken: action.leaseToken,
      projectId: row.projectId,
      result: { code: "SANDBOX_UNVERIFIABLE" },
      status: "failed",
    });
    if (finalized.affectedRows !== 1) {
      throw new ExecutionError("ACTION_LEASE_LOST", 409, "The native failure was discarded.");
    }
    return { body, status: 422 };
  }
  if (!result || result.affectedRows !== 1) {
    throw new ExecutionError("ACTION_LEASE_LOST", 409, "The file action result was discarded.");
  }
  const inputBoundary = staleExecutionIfFrozenInputChanged(database, executionId);
  if (inputBoundary.disposition === "stale") {
    return { body: inputBoundary.body, status: 409 };
  }
  const receipt = readExecutionOperation(database, {
    kind: "advance",
    operationId,
    projectId: row.projectId,
    requestHash: hash,
    responseSchema: anyResponseSchema,
  });
  void databasePath;
  void executionId;
  return receipt ?? { body: { result: result.result }, status: 200 };
}

function resolveExecutable(executable: string) {
  const resolved = realpathSync(executable).replaceAll("\\", "/");
  const stat = statSync(resolved);
  if (!stat.isFile()) throw new ExecutionError("INVALID_INPUT", 400, "Executable is invalid.");
  return {
    executable: resolved,
    executableIdentity: createHash("sha256").update(JSON.stringify({
      dev: stat.dev.toString(),
      ino: stat.ino.toString(),
      path: resolved,
      size: stat.size,
    })).digest("hex"),
  };
}

async function runCommandRequest(
  databasePath: string,
  database: DatabaseSync,
  executionId: string,
  row: StateRow,
  operationId: string,
  operationRequestHash: string,
  pending: PendingModelAction,
): Promise<AdvanceResult> {
  if (pending.action.type !== "command") {
    throw new ExecutionError("INVALID_INPUT", 400, "Command action is invalid.");
  }
  const executable = resolveExecutable(pending.action.executable);
  const waitingBody = publicResponse(
    databasePath,
    executionId,
    row,
    "command",
    "succeeded",
    pending.summary,
    row.version + 1,
    {
      reasonCode: "COMMAND_APPROVAL_REQUIRED",
      resumeTarget: null,
      status: "waiting_approval",
    },
  );
  const deniedBody = publicResponse(
    databasePath,
    executionId,
    row,
    "command",
    "failed",
    "COMMAND_ABSOLUTELY_DENIED",
    row.version + 1,
    {
      reasonCode: "COMMAND_ABSOLUTELY_DENIED",
      resumeTarget: "running",
      status: "paused",
    },
  );
  const result = requestExecutionCommand({
    command: { ...pending.action, ...executable },
    completedResponseBody: waitingBody,
    contextHash: (database.prepare(
      "SELECT frozen_context_hash AS value FROM execution_attempts WHERE id=?",
    ).get(row.attemptId) as { value: string }).value,
    database,
    deniedResponseBody: deniedBody,
    executionId,
    expectedVersion: row.version,
    inputHash: canonicalRequestHash({
      actionId: pending.actionId,
      executionId,
      frozenInputHash: (database.prepare(
        "SELECT frozen_context_hash AS value FROM execution_attempts WHERE id=?",
      ).get(row.attemptId) as { value: string }).value,
      kind: "model_command",
    }),
    operationId,
    operationRequestHash,
    policyContext: {
      canonicalRoot: row.workspaceRoot,
      executionRoot: row.executionRoot,
      platform: process.platform === "win32" ? "win32" : "posix",
      sandboxRoot: row.sandboxRoot,
    },
    projectId: row.projectId,
  });
  if (result.decision === "standing_exact") {
    const commandBody = publicResponse(
      databasePath,
      executionId,
      row,
      "command",
      "succeeded",
      pending.summary,
      row.version + 2,
    );
    const executed = await executeCommandProcessAction({
      actionIndex: 0,
      authorizationSource: "standing_policy",
      database,
      operationId,
      projectId: row.projectId,
      responseBody: commandBody,
      secretValues: [
        providerConnection(database, row.agentId).apiKey,
        process.env.COCKPIT_MASTER_KEY ?? "",
      ].filter(Boolean),
    });
    if (executed.affectedRows !== 1) {
      throw new ExecutionError("ACTION_LEASE_LOST", 409, "Command result was discarded.");
    }
  }
  const inputBoundary = staleExecutionIfFrozenInputChanged(database, executionId);
  if (inputBoundary.disposition === "stale") {
    return { body: inputBoundary.body, status: 409 };
  }
  const receipt = readExecutionOperation(database, {
    kind: "advance",
    operationId,
    projectId: row.projectId,
    requestHash: operationRequestHash,
    responseSchema: anyResponseSchema,
  });
  return receipt ?? { body: result, status: result.decision === "denied" ? 403 : 200 };
}

function finalizeStageUnverifiable(
  database: DatabaseSync,
  executionId: string,
  operationId: string,
  row: StateRow,
): AdvanceResult {
  const action = database.prepare(`
    SELECT id,lease_token AS leaseToken
    FROM execution_actions
    WHERE project_id=? AND operation_id=? AND kind='stage_compute' AND status='running'
  `).get(row.projectId, operationId) as { id: string; leaseToken: string } | undefined;
  if (!action?.leaseToken) {
    throw new ExecutionError("ACTION_LEASE_LOST", 409, "Stage native failure lost its lease.");
  }
  const body = {
    error: {
      code: "SANDBOX_UNVERIFIABLE",
      message: "The staged snapshot could not be verified.",
    },
  };
  const finalized = finalizeExecutionActionWithEffects(database, {
    actionId: action.id,
    body,
    errorCode: "SANDBOX_UNVERIFIABLE",
    effects(currentDatabase) {
      const execution = currentDatabase.prepare(`
        UPDATE executions
        SET status='paused',resume_target='running',reason_code='SANDBOX_UNVERIFIABLE',
            version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE project_id=? AND id=? AND status='running' AND version=?
      `).run(row.projectId, executionId, row.version);
      if (execution.changes !== 1) {
        throw new Error("Execution changed before stage native failure could commit.");
      }
    },
    httpStatus: 422,
    leaseToken: action.leaseToken,
    projectId: row.projectId,
    result: { code: "SANDBOX_UNVERIFIABLE" },
    status: "failed",
  });
  if (finalized.affectedRows !== 1) {
    throw new ExecutionError("ACTION_LEASE_LOST", 409, "Stage native failure was discarded.");
  }
  return { body, status: 422 };
}

async function declareStaged(
  databasePath: string,
  database: DatabaseSync,
  executionId: string,
  row: StateRow,
  operationId: string,
  hash: string,
  stagingAdapter?: ExecutionStagingAdapter,
): Promise<AdvanceResult> {
  const manifest = database.prepare(`
    SELECT baseline_manifest_path AS baselinePath,baseline_manifest_hash AS baselineHash,
           sandbox_manifest_hash AS sandboxHash,frozen_context_hash AS contextHash,
           frozen_policy_revision_id AS policyRevisionId,frozen_policy_hash AS policyHash
    FROM execution_attempts WHERE id=?
  `).get(row.attemptId) as {
    baselineHash: string | null;
    baselinePath: string | null;
    contextHash: string;
    policyHash: string;
    policyRevisionId: string;
    sandboxHash: string | null;
  };
  let noChanges = !manifest.sandboxHash || manifest.sandboxHash === manifest.baselineHash;
  if (database.prepare(`
    SELECT 1 FROM execution_approvals
    WHERE execution_id=? AND status IN ('pending','approved')
  `).get(executionId)) {
    throw new ExecutionError("APPROVAL_STATE_CONFLICT", 409, "Pending approval blocks staging.");
  }
  if (database.prepare(`
    SELECT 1 FROM execution_actions
    WHERE execution_id=? AND status IN ('pending','running')
  `).get(executionId)) {
    throw new ExecutionError("OPERATION_IN_PROGRESS", 409, "Pending action blocks staging.");
  }
  const { actionId, actionIndex } = createAction(
    database,
    row,
    operationId,
    hash,
    "stage_compute",
  );
  const acquired = acquireExecutionAction(database, {
    actionIndex,
    operationId,
    projectId: row.projectId,
  });
  if (acquired.affectedRows !== 1 || !acquired.leaseToken) {
    throw new ExecutionError("OPERATION_IN_PROGRESS", 409, "Stage declaration is in progress.");
  }
  if (
    stagingAdapter
    && manifest.baselineHash
    && manifest.sandboxHash
    && !noChanges
  ) {
    const collectEntries = async (source: AsyncIterable<StagingEntry>): Promise<StagingEntry[]> => {
      const values: StagingEntry[] = [];
      for await (const value of source) values.push(value);
      return values;
    };
    const baselineEntries = await collectEntries(stagingAdapter.baselineEntries({
      attemptId: row.attemptId,
      baselineManifestPath: manifest.baselinePath,
      sandboxRoot: row.sandboxRoot,
    }));
    const sandboxEntries = await collectEntries(stagingAdapter.sandboxEntries({
      attemptId: row.attemptId,
      sandboxRoot: row.sandboxRoot,
    }));
    const asEntries = async function* (values: StagingEntry[]) {
      yield* values;
    };
    const requiredPolicyEntryIds = (database.prepare(`
      SELECT id FROM project_validation_policy_entries
      WHERE project_id=? AND revision_id=? AND required=1 ORDER BY position,id
    `).all(row.projectId, manifest.policyRevisionId) as Array<{ id: string }>).map(({ id }) => id);
    const requiredValidations = database.prepare(`
      SELECT policy_entry_id AS policyEntryId,sandbox_manifest_hash AS manifestHash,
             policy_revision_id AS policyRevisionId,required,exit_code AS exitCode,
             succeeded,stdout_sha256 AS stdoutSha256,stderr_sha256 AS stderrSha256,
             stdout_truncated AS stdoutTruncated,stderr_truncated AS stderrTruncated,
             finished_at AS finishedAt
      FROM execution_validation_results
      WHERE project_id=? AND execution_id=? AND attempt_id=?
        AND policy_revision_id=?
      ORDER BY finished_at,id
    `).all(
      row.projectId,
      executionId,
      row.attemptId,
      manifest.policyRevisionId,
    ) as Array<{
      exitCode: number;
      finishedAt: string;
      manifestHash: string;
      policyEntryId: string;
      policyRevisionId: string;
      required: number;
      stderrSha256: string;
      stderrTruncated: number;
      stdoutSha256: string;
      stdoutTruncated: number;
      succeeded: number;
    }>;
    const lastFileChange = database.prepare(`
      SELECT MAX(finished_at) AS value FROM execution_tool_calls
      WHERE project_id=? AND execution_id=? AND attempt_id=?
        AND finished_at IS NOT NULL
        AND (
          type='write'
          OR (
            before_sandbox_hash IS NOT NULL
            AND after_sandbox_hash IS NOT NULL
            AND before_sandbox_hash<>after_sandbox_hash
          )
        )
    `).get(row.projectId, executionId, row.attemptId) as { value: string | null };
    const snapshot = await computeStagedSnapshot({
      attemptId: row.attemptId,
      baseline: asEntries(baselineEntries),
      baselineManifestHash: manifest.baselineHash,
      contextHash: manifest.contextHash,
      lastFileChangeAt: lastFileChange.value,
      pendingApproval: false,
      pendingAction: false,
      policyHash: manifest.policyHash,
      policyRevisionId: manifest.policyRevisionId,
      requiredPolicyEntryIds,
      requiredValidations: requiredValidations.map((validation) => ({
        ...validation,
        required: validation.required === 1,
        stderrTruncated: validation.stderrTruncated === 1,
        stdoutTruncated: validation.stdoutTruncated === 1,
        succeeded: validation.succeeded === 1,
      })),
      sandbox: asEntries(sandboxEntries),
      sandboxManifestHash: manifest.sandboxHash,
    });
    if (snapshot.outcome === "ready") {
      if (stagingAdapter.canonicalEntries) {
        const canonicalEntries = await collectEntries(stagingAdapter.canonicalEntries({
          attemptId: row.attemptId,
          workspaceRoot: row.workspaceRoot,
        }));
        const readPaths = (database.prepare(`
          SELECT json_extract(public_request_json,'$.path') AS path
          FROM execution_tool_calls
          WHERE project_id=? AND execution_id=? AND attempt_id=?
            AND type IN ('read','write') AND json_type(public_request_json,'$.path')='text'
          ORDER BY id
        `).all(row.projectId, executionId, row.attemptId) as Array<{ path: string }>)
          .map(({ path }) => path);
        const canonicalBoundary = staleExecutionForCanonicalPathChanges(database, {
          attemptNo: row.attemptNo,
          current: canonicalEntries.map((entry) => ({
            exists: true,
            identity: entry.identity ?? null,
            path: entry.path,
            sha256: entry.sha256,
          })),
          executionId,
          frozen: baselineEntries.map((entry) => ({
            exists: true,
            identity: entry.identity ?? null,
            path: entry.path,
            sha256: entry.sha256,
          })),
          projectId: row.projectId,
          relevantPaths: [
            ...readPaths,
            ...snapshot.observations.map(({ path }) => path),
          ],
        });
        if (canonicalBoundary.disposition === "stale") {
          return {
            body: {
              error: {
                code: "STALE_EXECUTION",
                message: "Canonical workspace paths changed; retry from a new baseline.",
              },
            },
            status: 409,
          };
        }
      }
      const body = publicResponse(
        databasePath,
        executionId,
        row,
        "stage_compute",
        "succeeded",
        snapshot.classification,
        row.version + 1,
        { reasonCode: null, resumeTarget: null, status: "staged" },
      );
      const persisted = persistComputedStage(database, {
        actionId,
        baselineManifestHash: manifest.baselineHash,
        body,
        contextHash: manifest.contextHash,
        executionId,
        expectedVersion: row.version,
        leaseToken: acquired.leaseToken,
        policyHash: manifest.policyHash,
        projectId: row.projectId,
        sandboxManifestHash: manifest.sandboxHash,
        snapshot,
      });
      if (persisted.affectedRows !== 1) {
        throw new ExecutionError("ACTION_LEASE_LOST", 409, "Stage result was discarded.");
      }
      return { body, status: 200 };
    }
    noChanges = true;
  }
  const body = publicResponse(
    databasePath,
    executionId,
    row,
    "stage_compute",
    noChanges ? "failed" : "succeeded",
    noChanges ? "STAGED_NO_CHANGES" : "STAGED_PRECONDITIONS_VALID",
    noChanges ? row.version + 1 : row.version,
  );
  const finalized = finalizeExecutionActionWithEffects(database, {
    actionId,
    body,
    effects(currentDatabase) {
      if (!noChanges) return;
      const updated = currentDatabase.prepare(`
        UPDATE executions SET status='paused',resume_target='running',
          reason_code='STAGED_NO_CHANGES',version=version+1,
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id=? AND version=? AND status='running'
      `).run(executionId, row.version);
      if (updated.changes !== 1) throw new Error("Execution changed during stage declaration.");
    },
    httpStatus: noChanges ? 409 : 200,
    leaseToken: acquired.leaseToken,
    projectId: row.projectId,
    result: {
      baselineHash: manifest.baselineHash,
      code: noChanges ? "STAGED_NO_CHANGES" : null,
      sandboxHash: manifest.sandboxHash,
    },
    status: noChanges ? "failed" : "succeeded",
  });
  if (finalized.affectedRows !== 1) {
    throw new ExecutionError("ACTION_LEASE_LOST", 409, "Stage declaration result was discarded.");
  }
  const inputBoundary = staleExecutionIfFrozenInputChanged(database, executionId);
  if (inputBoundary.disposition === "stale") {
    return { body: inputBoundary.body, status: 409 };
  }
  return { body, status: noChanges ? 409 : 200 };
}

export async function advanceExecution(
  databasePath: string,
  executionId: string,
  rawInput: unknown,
  dependencies: ExecutionOrchestratorDependencies,
): Promise<AdvanceResult> {
  const parsed = advanceExecutionInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new ExecutionError("INVALID_INPUT", 400, "Advance input is invalid.");
  }
  const input = parsed.data;
  const hash = requestHash(executionId, input.expectedVersion);
  const database = openDatabase(databasePath);
  try {
    reconcileExpiredModelAction(database, executionId);
    const row = stateRow(database, executionId);
    const replay = readExecutionOperation(database, {
      kind: "advance",
      operationId: input.operationId,
      projectId: row.projectId,
      requestHash: hash,
      responseSchema: anyResponseSchema,
    });
    if (replay) return replay;
    assertManualRecoveryNotRequired(database, executionId);
    if (row.version !== input.expectedVersion) {
      throw new ExecutionError("EXECUTION_STATE_CONFLICT", 409, "Execution changed concurrently.");
    }
    if (row.status === "waiting_approval") {
      const inputBoundary = staleExecutionIfFrozenInputChanged(database, executionId);
      if (inputBoundary.disposition === "stale") {
        return { body: inputBoundary.body, status: 409 };
      }
      const consumed = consumeApprovedCommand({
        database,
        executionId,
        expectedVersion: input.expectedVersion,
        operationId: input.operationId,
        operationRequestHash: hash,
      });
      const body = publicResponse(
        databasePath,
        executionId,
        row,
        "command",
        "succeeded",
        "Approved command executed.",
        row.version + 2,
        { reasonCode: null, resumeTarget: null, status: "running" },
      );
      const executed = await executeCommandProcessAction({
        actionIndex: 0,
        authorizationSource: "one_shot",
        database,
        operationId: input.operationId,
        projectId: consumed.projectId,
        responseBody: body,
        secretValues: [
          providerConnection(database, row.agentId).apiKey,
          process.env.COCKPIT_MASTER_KEY ?? "",
        ].filter(Boolean),
      });
      if (executed.affectedRows !== 1) {
        throw new ExecutionError("ACTION_LEASE_LOST", 409, "Command result was discarded.");
      }
      return { body, status: 200 };
    }
    if (!["queued", "running"].includes(row.status)) {
      throw new ExecutionError("EXECUTION_STATE_CONFLICT", 409, "Execution cannot advance.");
    }
    if (database.prepare(
      "SELECT 1 FROM execution_actions WHERE execution_id=? AND status IN ('pending','running')",
    ).get(executionId)) {
      throw new ExecutionError("OPERATION_IN_PROGRESS", 409, "Execution already has an active action.");
    }
    const pending = pendingModelAction(database, executionId);
    const nextKind = !pending
      ? "model"
      : ["list", "read", "write", "command"].includes(pending.action.type)
        ? "tool"
        : "stage";
    const inputBoundary = staleExecutionIfFrozenInputChanged(database, executionId);
    if (inputBoundary.disposition === "stale") {
      return { body: inputBoundary.body, status: 409 };
    }
    const boundary = preExecutionBoundary(database, executionId, nextKind);
    if (boundary) {
      return pauseAtBudgetBoundary(
        databasePath,
        database,
        executionId,
        row,
        input.operationId,
        hash,
        boundary,
      );
    }
    if (!pending) {
      return await runModel(
        databasePath,
        database,
        executionId,
        row,
        input.operationId,
        hash,
        dependencies,
      );
    }
    if (["list", "read", "write"].includes(pending.action.type)) {
      return await runFileTool(
        databasePath,
        database,
        executionId,
        row,
        input.operationId,
        hash,
        pending,
        dependencies,
      );
    }
    if (pending.action.type === "command") {
      return await runCommandRequest(
        databasePath,
        database,
        executionId,
        row,
        input.operationId,
        hash,
        pending,
      );
    }
    try {
      return await declareStaged(
        databasePath,
        database,
        executionId,
        row,
        input.operationId,
        hash,
        dependencies.stagingAdapter,
      );
    } catch (error) {
      if ((error as { code?: unknown })?.code !== "SANDBOX_UNVERIFIABLE") throw error;
      const action = database.prepare(`
        SELECT id,lease_token AS leaseToken FROM execution_actions
        WHERE project_id=? AND operation_id=? AND kind='stage_compute' AND status='running'
      `).get(row.projectId, input.operationId) as
        | { id: string; leaseToken: string }
        | undefined;
      if (!action?.leaseToken) throw error;
      const body = publicResponse(
        databasePath,
        executionId,
        row,
        "stage_compute",
        "failed",
        "SANDBOX_UNVERIFIABLE",
        row.version + 1,
        { reasonCode: "SANDBOX_UNVERIFIABLE", resumeTarget: "running", status: "paused" },
      );
      const finalized = finalizeExecutionActionWithEffects(database, {
        actionId: action.id,
        body,
        errorCode: "SANDBOX_UNVERIFIABLE",
        effects(currentDatabase) {
          const updated = currentDatabase.prepare(`
            UPDATE executions
            SET status='paused',resume_target='running',reason_code='SANDBOX_UNVERIFIABLE',
                version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
            WHERE project_id=? AND id=? AND status='running' AND version=?
          `).run(row.projectId, executionId, row.version);
          if (updated.changes !== 1) {
            throw new Error("Execution changed before the stage failure could commit.");
          }
        },
        httpStatus: 422,
        leaseToken: action.leaseToken,
        projectId: row.projectId,
        result: { code: "SANDBOX_UNVERIFIABLE" },
        status: "failed",
      });
      if (finalized.affectedRows !== 1) {
        throw new ExecutionError("ACTION_LEASE_LOST", 409, "The stage failure was discarded.");
      }
      return { body, status: 422 };
    }
  } finally {
    database.close();
  }
}
