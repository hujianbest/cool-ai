import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type {
  ModelCallResult,
  ModelCallUsage,
} from "@/src/shared/collaboration-contracts";
import {
  callOpenAiChat,
  type OpenAiChatCallContext,
  type OpenAiChatRequest,
} from "@/src/adapters/outbound/model-runtime/openai-chat-client";
import {
  EXECUTION_ACTION_SCHEMA_INSTRUCTIONS,
  type ExecutionAction,
  type ExecutionActionParseResult,
  type ExecutionPermissions,
  parseExecutionActionContent,
} from "@/src/modules/safe-execution/internal/execution-action-schema";
import {
  commitPostCallTokenBoundary,
  recordUsageEvent,
} from "@/src/adapters/outbound/sqlite/safe-execution/execution-usage-budget";

const DB_NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const MODEL_CALL_TIMEOUT_SECONDS = 90;
const HEARTBEAT_INTERVAL_MILLISECONDS = 30_000;

type CallKind = "primary" | "repair";
type CallIndex = 1 | 2;
export type ExecutionStructuredFaultPoint =
  | "before_call_terminal_update"
  | "after_call_terminal_update"
  | "after_call_terminal_commit";

export type ExecutionStructuredCall = {
  callIndex: CallIndex;
  kind: CallKind;
  usage: ModelCallUsage | null;
};

export type ExecutionStructuredResult = {
  status: "completed" | "paused" | "provider_failed" | "lease_lost";
  action: ExecutionAction | null;
  pauseCategory: "structured_output_invalid" | "permission_denied" | null;
  calls: ExecutionStructuredCall[];
};

type ActionIdentity = {
  attemptId: string;
  executionId: string;
};

type StoredCall = {
  id: string;
  result: ModelCallResult;
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
      // Preserve the original database or state error.
    }
    throw error;
  }
}

function promptHash(request: OpenAiChatRequest): string {
  return createHash("sha256")
    .update(JSON.stringify({
      baseUrl: request.baseUrl,
      messages: request.messages,
      model: request.model,
    }))
    .digest("hex");
}

function repairRequest(
  request: OpenAiChatRequest,
  invalidContent: string,
): OpenAiChatRequest {
  return {
    apiKey: request.apiKey,
    baseUrl: request.baseUrl,
    model: request.model,
    messages: [
      {
        role: "system",
        content: EXECUTION_ACTION_SCHEMA_INSTRUCTIONS,
      },
      {
        role: "user",
        content: [
          "The following response was invalid.",
          "Rewrite only this content to satisfy the schema exactly:",
          invalidContent,
        ].join("\n"),
      },
    ],
  };
}

function insertCallingFact(
  database: DatabaseSync,
  input: {
    actionId: string;
    businessRound: number;
    callIndex: CallIndex;
    kind: CallKind;
    leaseToken: string;
    projectId: string;
    request: OpenAiChatRequest;
  },
): { callId: string; identity: ActionIdentity } | null {
  return transaction(database, () => {
    const identity = database.prepare(`
      SELECT a.execution_id AS executionId,a.attempt_id AS attemptId
      FROM execution_actions a
      JOIN executions e ON e.project_id=a.project_id AND e.id=a.execution_id
      WHERE a.project_id=? AND a.id=? AND a.kind='model'
        AND a.status='running' AND a.lease_token=?
        AND a.lease_expires_at>${DB_NOW}
        AND a.overall_deadline_at>${DB_NOW}
        AND e.status='running'
        AND e.business_deadline_at IS NOT NULL
        AND e.business_deadline_at>${DB_NOW}
    `).get(input.projectId, input.actionId, input.leaseToken) as
      | ActionIdentity
      | undefined;
    if (!identity) return null;

    const callId = randomUUID();
    database.prepare(`
      INSERT INTO execution_model_calls (
        id,project_id,execution_id,attempt_id,action_id,business_round,kind,call_index,
        status,prompt_hash,prompt_tokens,completion_tokens,total_tokens,error_category,
        call_started_at,call_deadline_at,finished_at,created_at
      ) VALUES (?,?,?,?,?,?,?,?,'calling',?,NULL,NULL,NULL,NULL,
        ${DB_NOW},
        strftime('%Y-%m-%dT%H:%M:%fZ','now','+${MODEL_CALL_TIMEOUT_SECONDS} seconds'),
        NULL,${DB_NOW})
    `).run(
      callId,
      input.projectId,
      identity.executionId,
      identity.attemptId,
      input.actionId,
      input.businessRound,
      input.kind,
      input.callIndex,
      promptHash(input.request),
    );
    return { callId, identity };
  });
}

function persistedStatus(
  result: ModelCallResult,
  parsed: ExecutionActionParseResult | null,
): "succeeded" | "provider_failed" | "response_invalid" | "usage_invalid" {
  if (result.status !== "succeeded") return result.status;
  return parsed !== null && !parsed.success && parsed.reason === "invalid_schema"
    ? "response_invalid"
    : "succeeded";
}

function finishCallingFact(
  database: DatabaseSync,
  callId: string,
  result: ModelCallResult,
  parsed: ExecutionActionParseResult | null,
  faultInjector?: (point: ExecutionStructuredFaultPoint) => void,
): void {
  const status = persistedStatus(result, parsed);
  const usage = result.usage;
  faultInjector?.("before_call_terminal_update");
  transaction(database, () => {
    const updated = database.prepare(`
      UPDATE execution_model_calls
      SET status=?,prompt_tokens=?,completion_tokens=?,total_tokens=?,
          error_category=?,finished_at=${DB_NOW}
      WHERE id=? AND status='calling' AND finished_at IS NULL
    `).run(
      status,
      usage?.promptTokens ?? null,
      usage?.completionTokens ?? null,
      usage?.totalTokens ?? null,
      result.error?.category ?? (status === "response_invalid" ? "structured_output_invalid" : null),
      callId,
    );
    if (updated.changes !== 1) {
      throw new Error("MODEL_CALL_STATE_CONFLICT");
    }
    recordUsageEvent(database, callId, usage);
    faultInjector?.("after_call_terminal_update");
  });
  faultInjector?.("after_call_terminal_commit");
}

async function executeCall(
  database: DatabaseSync,
  input: {
    actionId: string;
    businessRound: number;
    callIndex: CallIndex;
    context: OpenAiChatCallContext;
    kind: CallKind;
    leaseToken: string;
    modelFaultInjector?: (point: ExecutionStructuredFaultPoint) => void;
    permissions: ExecutionPermissions;
    projectId: string;
    request: OpenAiChatRequest;
  },
): Promise<
  | { stored: null; parsed: null; content: null }
  | { stored: StoredCall; parsed: ExecutionActionParseResult | null; content: string | null }
> {
  const inserted = insertCallingFact(database, input);
  if (!inserted) return { stored: null, parsed: null, content: null };

  const result = await callOpenAiChat(input.request, input.context);
  const content = result.status === "succeeded" ? result.content : null;
  const parsed = content === null
    ? null
    : parseExecutionActionContent(content, input.permissions);
  finishCallingFact(database, inserted.callId, result, parsed, input.modelFaultInjector);
  return {
    stored: { id: inserted.callId, result },
    parsed,
    content,
  };
}

function publicCall(
  kind: CallKind,
  callIndex: CallIndex,
  stored: StoredCall,
): ExecutionStructuredCall {
  return {
    callIndex,
    kind,
    usage: stored.result.usage,
  };
}

function permissionReason(permission: "execute" | "read" | "write"): string {
  return `${permission.toUpperCase()}_PERMISSION_REQUIRED`;
}

function commitBusinessOutcome(
  database: DatabaseSync,
  input: {
    actionId: string;
    businessRound: number;
    leaseToken: string;
    pauseReason: string | null;
    projectId: string;
  },
): boolean {
  return transaction(database, () => {
    const updated = database.prepare(`
      UPDATE executions
      SET business_round_count=?,
          status=CASE WHEN ? IS NULL THEN status ELSE 'paused' END,
          resume_target=CASE WHEN ? IS NULL THEN resume_target ELSE 'running' END,
          reason_code=?,
          updated_at=${DB_NOW},
          version=version+1
      WHERE project_id=?
        AND id=(
          SELECT execution_id FROM execution_actions
          WHERE project_id=? AND id=? AND kind='model'
            AND status='running' AND lease_token=?
            AND lease_expires_at>${DB_NOW}
            AND overall_deadline_at>${DB_NOW}
        )
        AND status='running'
        AND business_deadline_at>${DB_NOW}
        AND business_round_count=?
    `).run(
      input.businessRound,
      input.pauseReason,
      input.pauseReason,
      input.pauseReason,
      input.projectId,
      input.projectId,
      input.actionId,
      input.leaseToken,
      input.businessRound - 1,
    );
    return updated.changes === 1;
  });
}

function providerFailureReason(result: ModelCallResult): string {
  return (result.error?.category ?? "provider_failed").toUpperCase();
}

export async function executeStructuredExecutionAction(input: {
  actionId: string;
  businessRound: number;
  database: DatabaseSync;
  leaseToken: string;
  permissions: ExecutionPermissions;
  projectId: string;
  request: OpenAiChatRequest;
  context: OpenAiChatCallContext;
  modelFaultInjector?: (point: ExecutionStructuredFaultPoint) => void;
}): Promise<ExecutionStructuredResult> {
  const heartbeat = setInterval(() => {
    try {
      const updated = input.database.prepare(`
        UPDATE execution_actions
        SET lease_expires_at=min(
              strftime('%Y-%m-%dT%H:%M:%fZ','now','+120 seconds'),
              overall_deadline_at
            ),
            last_heartbeat_at=${DB_NOW}
        WHERE project_id=? AND id=? AND kind='model'
          AND status='running' AND lease_token=?
          AND lease_expires_at>${DB_NOW}
          AND overall_deadline_at>${DB_NOW}
      `).run(input.projectId, input.actionId, input.leaseToken);
      if (updated.changes !== 1) clearInterval(heartbeat);
    } catch {
      clearInterval(heartbeat);
    }
  }, HEARTBEAT_INTERVAL_MILLISECONDS);
  heartbeat.unref?.();

  try {
    const primary = await executeCall(input.database, {
      ...input,
      callIndex: 1,
      kind: "primary",
    });
    if (!primary.stored) {
      return { status: "lease_lost", action: null, pauseCategory: null, calls: [] };
    }
    const calls = [publicCall("primary", 1, primary.stored)];
    if (commitPostCallTokenBoundary(input.database, input)) {
      return {
        status: "paused",
        action: null,
        pauseCategory: null,
        calls,
      };
    }

    if (primary.stored.result.status !== "succeeded" || primary.content === null) {
      const committed = commitBusinessOutcome(input.database, {
        ...input,
        pauseReason: providerFailureReason(primary.stored.result),
      });
      return {
        status: committed ? "provider_failed" : "lease_lost",
        action: null,
        pauseCategory: null,
        calls,
      };
    }

    if (primary.parsed?.success) {
      const committed = commitBusinessOutcome(input.database, {
        ...input,
        pauseReason: null,
      });
      return {
        status: committed ? "completed" : "lease_lost",
        action: committed ? primary.parsed.action : null,
        pauseCategory: null,
        calls,
      };
    }

    if (
      primary.parsed?.reason === "permission_denied"
      && primary.parsed.permission !== null
    ) {
      const committed = commitBusinessOutcome(input.database, {
        ...input,
        pauseReason: permissionReason(primary.parsed.permission),
      });
      return {
        status: committed ? "paused" : "lease_lost",
        action: null,
        pauseCategory: committed ? "permission_denied" : null,
        calls,
      };
    }

    const repair = await executeCall(input.database, {
      ...input,
      callIndex: 2,
      kind: "repair",
      request: repairRequest(input.request, primary.content),
    });
    if (!repair.stored) {
      return { status: "lease_lost", action: null, pauseCategory: null, calls };
    }
    calls.push(publicCall("repair", 2, repair.stored));
    if (commitPostCallTokenBoundary(input.database, input)) {
      return {
        status: "paused",
        action: null,
        pauseCategory: null,
        calls,
      };
    }

    if (repair.stored.result.status !== "succeeded" || repair.content === null) {
      const committed = commitBusinessOutcome(input.database, {
        ...input,
        pauseReason: providerFailureReason(repair.stored.result),
      });
      return {
        status: committed ? "provider_failed" : "lease_lost",
        action: null,
        pauseCategory: null,
        calls,
      };
    }

    if (repair.parsed?.success) {
      const committed = commitBusinessOutcome(input.database, {
        ...input,
        pauseReason: null,
      });
      return {
        status: committed ? "completed" : "lease_lost",
        action: committed ? repair.parsed.action : null,
        pauseCategory: null,
        calls,
      };
    }

    const pauseReason = repair.parsed?.reason === "permission_denied"
      && repair.parsed.permission !== null
      ? permissionReason(repair.parsed.permission)
      : "STRUCTURED_OUTPUT_INVALID";
    const pauseCategory = repair.parsed?.reason === "permission_denied"
      ? "permission_denied"
      : "structured_output_invalid";
    const committed = commitBusinessOutcome(input.database, {
      ...input,
      pauseReason,
    });
    return {
      status: committed ? "paused" : "lease_lost",
      action: null,
      pauseCategory: committed ? pauseCategory : null,
      calls,
    };
  } finally {
    clearInterval(heartbeat);
  }
}
