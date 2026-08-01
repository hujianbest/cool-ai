import { createHash, randomUUID as nodeRandomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { canonicalRequestHash } from "@/src/server/collaboration/operation-receipts";
import {
  callOpenAiChat,
  type OpenAiChatCallContext,
  type OpenAiChatRequest,
} from "@/src/server/collaboration/openai-chat-client";
import {
  parseReviewOutputContent,
  REVIEW_OUTPUT_SCHEMA_INSTRUCTIONS,
  reviewOutputContainsSensitiveText,
  validateReviewOutput,
  type ReviewOutputValidationContext,
  type ValidatedReviewOutput,
} from "@/src/server/review/review-schema";
import type { ModelCallResult, ModelCallUsage } from "@/src/shared/collaboration-contracts";
import {
  reviewOperationResponseSchema,
  type ReviewOperationResponse,
} from "@/src/shared/review-contracts";

export const REVIEW_PROVIDER_CALL_TIMEOUT_MILLISECONDS = 90_000;
export const REVIEW_HEARTBEAT_INTERVAL_MILLISECONDS = 30_000;
export const REVIEW_LEASE_MILLISECONDS = 120_000;

export class ReviewOrchestratorError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ReviewOrchestratorError";
  }
}

type ReviewCallKind = "primary" | "repair";
type ReviewCallTerminalStatus =
  | "succeeded"
  | "provider_failed"
  | "response_invalid"
  | "usage_invalid";

export type ReviewOperationInput = {
  attemptId: string;
  credentialGeneration: number;
  frozenMaterialHash: string;
  frozenMaterialJson: string;
  maxTokens: number;
  missionId: string;
  model: string;
  operationId: string;
  parentId: string;
  projectId: string;
  promptHash: string;
  providerId: string;
  providerRequest: OpenAiChatRequest;
  providerVersion: number;
  request: unknown;
  resultId: string;
  retryOfAttemptId?: string | null;
  reviewerAgentId: string;
  trustedTokens: number;
  validationContext: ReviewOutputValidationContext;
  verifiedAt: string;
  workItemId: string;
};

export type ReviewOrchestratorDependencies = {
  callProvider?: (
    request: OpenAiChatRequest,
    context: OpenAiChatCallContext,
    options: { timeoutMilliseconds: number },
  ) => Promise<ModelCallResult>;
  clock?: () => Date;
  localFinalize?: (
    database: DatabaseSync,
    checkpoint: {
      attemptId: string;
      checkpointHash: string;
      output: ValidatedReviewOutput;
    },
  ) => void;
  randomUUID?: () => string;
  scheduleHeartbeat?: (callback: () => void, milliseconds: number) => () => void;
};

type AttemptRow = {
  errorCategory: string | null;
  id: string;
  operationId: string;
  output: string | null;
  outputHash: string | null;
  status: string;
};

function transaction<T>(database: DatabaseSync, work: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the stable orchestration failure.
    }
    throw error;
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function leaseExpiry(now: Date): string {
  return new Date(now.getTime() + REVIEW_LEASE_MILLISECONDS).toISOString();
}

function operationAttempt(
  database: DatabaseSync,
  projectId: string,
  operationId: string,
): AttemptRow | null {
  return (database.prepare(`
    SELECT id,operation_id AS operationId,status,
           parsed_output_json AS output,parsed_output_hash AS outputHash,
           error_category AS errorCategory
    FROM review_attempts WHERE project_id=? AND operation_id=?
  `).get(projectId, operationId) as AttemptRow | undefined) ?? null;
}

function finalizingResponse(attempt: AttemptRow): ReviewOperationResponse {
  if (!attempt.outputHash) {
    throw new ReviewOrchestratorError(
      "REVIEW_CHECKPOINT_INVALID",
      500,
      "Finalizing review has no durable public-output checkpoint.",
    );
  }
  return reviewOperationResponseSchema.parse({
    attemptId: attempt.id,
    checkpointHash: attempt.outputHash,
    retry: {
      attemptId: attempt.id,
      checkpointHash: attempt.outputHash,
      kind: "local-finalize-only",
      providerCallRequired: false,
    },
    state: "finalizing",
  });
}

function failedResponse(attemptId: string, errorCategory: string): ReviewOperationResponse {
  return reviewOperationResponseSchema.parse({
    attemptId,
    errorCategory,
    retry: {
      attemptId,
      kind: "new-provider-attempt",
      providerCallRequired: true,
    },
    state: "failed",
  });
}

function operationReplay(
  database: DatabaseSync,
  input: ReviewOperationInput,
  requestHash: string,
): ReviewOperationResponse | null {
  const operation = database.prepare(`
    SELECT kind,request_hash AS requestHash,status,http_status AS httpStatus,
           response_json AS responseJson
    FROM review_operations WHERE project_id=? AND id=?
  `).get(input.projectId, input.operationId) as {
    httpStatus: number | null;
    kind: string;
    requestHash: string;
    responseJson: string | null;
    status: string;
  } | undefined;
  if (!operation) return null;
  if (operation.kind !== "start_review" || operation.requestHash !== requestHash) {
    throw new ReviewOrchestratorError(
      "OPERATION_CONFLICT",
      409,
      "Operation id was already used for different review input.",
    );
  }
  if (operation.status === "completed" && operation.responseJson) {
    return reviewOperationResponseSchema.parse(JSON.parse(operation.responseJson));
  }
  const attempt = operationAttempt(database, input.projectId, input.operationId);
  if (attempt?.status === "finalizing") return finalizingResponse(attempt);
  throw new ReviewOrchestratorError(
    "OPERATION_IN_PROGRESS",
    409,
    "Review operation has no durable output checkpoint yet.",
  );
}

function acquire(
  database: DatabaseSync,
  input: ReviewOperationInput,
  requestHash: string,
  now: Date,
  leaseToken: string,
): void {
  if (
    !Number.isSafeInteger(input.trustedTokens)
    || !Number.isSafeInteger(input.maxTokens)
    || input.trustedTokens < 0
    || input.maxTokens < 0
  ) {
    throw new ReviewOrchestratorError("INVALID_INPUT", 400, "Token boundary input is invalid.");
  }
  if (input.trustedTokens >= input.maxTokens) {
    throw new ReviewOrchestratorError(
      "REVIEW_TOKEN_BOUNDARY",
      409,
      "Reviewer token boundary has been reached.",
    );
  }
  transaction(database, () => {
    if (input.retryOfAttemptId) {
      const prior = database.prepare(`
        SELECT status,parsed_output_hash AS outputHash,work_item_id AS workItemId
        FROM review_attempts WHERE id=? AND project_id=?
      `).get(input.retryOfAttemptId, input.projectId) as {
        outputHash: string | null;
        status: string;
        workItemId: string;
      } | undefined;
      if (
        !prior
        || prior.workItemId !== input.workItemId
        || prior.outputHash !== null
        || !["failed", "interrupted", "discarded"].includes(prior.status)
      ) {
        throw new ReviewOrchestratorError(
          "REVIEW_RETRY_CONFLICT",
          409,
          "A new provider attempt requires an explicit pre-checkpoint terminal attempt.",
        );
      }
    }
    const timestamp = now.toISOString();
    database.prepare(`
      INSERT INTO review_operations(
        id,project_id,kind,parent_id,request_hash,status,http_status,response_json,
        created_at,updated_at
      ) VALUES (?,?,'start_review',?,?,'pending',NULL,NULL,?,?)
    `).run(
      input.operationId,
      input.projectId,
      input.parentId,
      requestHash,
      timestamp,
      timestamp,
    );
    database.prepare(`
      INSERT INTO review_attempts(
        id,project_id,mission_id,work_item_id,result_id,reviewer_agent_id,
        operation_id,status,lease_token,lease_expires_at,frozen_material_json,
        frozen_material_hash,prompt_hash,provider_id,provider_version,
        credential_generation,verified_at,model,parsed_output_json,
        parsed_output_hash,output_checkpointed_at,finalize_error_code,
        error_category,started_at,finished_at
      ) VALUES (?,?,?,?,?,?,?,'calling',?,?,?,?,?,?,?,?,?,?,NULL,NULL,NULL,NULL,NULL,?,NULL)
    `).run(
      input.attemptId,
      input.projectId,
      input.missionId,
      input.workItemId,
      input.resultId,
      input.reviewerAgentId,
      input.operationId,
      leaseToken,
      leaseExpiry(now),
      input.frozenMaterialJson,
      input.frozenMaterialHash,
      input.promptHash,
      input.providerId,
      input.providerVersion,
      input.credentialGeneration,
      input.verifiedAt,
      input.model,
      timestamp,
    );
  });
}

function heartbeat(
  database: DatabaseSync,
  attemptId: string,
  leaseToken: string,
  clock: () => Date,
): void {
  const now = clock();
  database.prepare(`
    UPDATE review_attempts SET lease_expires_at=?
    WHERE id=? AND status='calling' AND lease_token=? AND lease_expires_at>?
  `).run(leaseExpiry(now), attemptId, leaseToken, now.toISOString());
}

function insertCalling(
  database: DatabaseSync,
  input: ReviewOperationInput,
  callId: string,
  kind: ReviewCallKind,
  callIndex: 1 | 2,
  now: Date,
): void {
  transaction(database, () => {
    database.prepare(`
      INSERT INTO review_model_calls(
        id,attempt_id,kind,call_index,status,prompt_hash,prompt_tokens,
        completion_tokens,total_tokens,error_category,started_at,finished_at
      ) VALUES (?,?,?,?,'calling',?,NULL,NULL,NULL,NULL,?,NULL)
    `).run(callId, input.attemptId, kind, callIndex, input.promptHash, now.toISOString());
  });
}

function validUsage(result: ModelCallResult): ModelCallUsage | null {
  const usage = result.usage;
  if (
    !result.usageReported
    || !usage
    || !Number.isSafeInteger(usage.promptTokens)
    || !Number.isSafeInteger(usage.completionTokens)
    || !Number.isSafeInteger(usage.totalTokens)
    || usage.promptTokens < 0
    || usage.completionTokens < 0
    || usage.totalTokens !== usage.promptTokens + usage.completionTokens
  ) {
    return null;
  }
  return usage;
}

function terminalCall(
  database: DatabaseSync,
  input: ReviewOperationInput,
  callIndex: 1 | 2,
  status: ReviewCallTerminalStatus,
  result: ModelCallResult,
  errorCategory: string | null,
  now: Date,
): void {
  const usage = validUsage(result);
  transaction(database, () => {
    const updated = database.prepare(`
      UPDATE review_model_calls
      SET status=?,prompt_tokens=?,completion_tokens=?,total_tokens=?,
          error_category=?,finished_at=?
      WHERE attempt_id=? AND call_index=? AND status='calling'
    `).run(
      status,
      usage?.promptTokens ?? null,
      usage?.completionTokens ?? null,
      usage?.totalTokens ?? null,
      errorCategory,
      now.toISOString(),
      input.attemptId,
      callIndex,
    );
    if (updated.changes !== 1) {
      throw new ReviewOrchestratorError("REVIEW_CALL_CONFLICT", 409, "Review call changed.");
    }
  });
}

function completeFailure(
  database: DatabaseSync,
  input: ReviewOperationInput,
  category: string,
  now: Date,
): ReviewOperationResponse {
  const response = failedResponse(input.attemptId, category);
  transaction(database, () => {
    database.prepare(`
      UPDATE review_attempts
      SET status='failed',error_category=?,finished_at=?
      WHERE id=? AND status='calling'
    `).run(category, now.toISOString(), input.attemptId);
    database.prepare(`
      UPDATE review_operations
      SET status='completed',http_status=502,response_json=?,updated_at=?
      WHERE project_id=? AND id=? AND status='pending'
    `).run(
      JSON.stringify(response),
      now.toISOString(),
      input.projectId,
      input.operationId,
    );
  });
  return response;
}

function repairRequest(request: OpenAiChatRequest, invalidContent: string): OpenAiChatRequest {
  return {
    apiKey: request.apiKey,
    baseUrl: request.baseUrl,
    messages: [
      { role: "system", content: REVIEW_OUTPUT_SCHEMA_INSTRUCTIONS },
      {
        role: "user",
        content: `Rewrite only this invalid response as strict JSON:\n${invalidContent}`,
      },
    ],
    model: request.model,
  };
}

function checkedOutput(
  content: string,
  context: ReviewOutputValidationContext,
): {
  category: string | null;
  output: ValidatedReviewOutput | null;
  structurallyInvalid: boolean;
} {
  const parsed = parseReviewOutputContent(content);
  if (!parsed) {
    return { category: "structured_output_invalid", output: null, structurallyInvalid: true };
  }
  if (reviewOutputContainsSensitiveText(parsed, context.secretValues)) {
    return { category: "output_security_invalid", output: null, structurallyInvalid: false };
  }
  const validated = validateReviewOutput(parsed, context);
  return validated.success
    ? { category: null, output: validated.output, structurallyInvalid: false }
    : { category: validated.reason, output: null, structurallyInvalid: false };
}

function checkpoint(
  database: DatabaseSync,
  input: ReviewOperationInput,
  leaseToken: string,
  callIndex: 1 | 2,
  result: ModelCallResult,
  output: ValidatedReviewOutput,
  now: Date,
): ReviewOperationResponse {
  const usage = validUsage(result);
  if (!usage) {
    throw new ReviewOrchestratorError("USAGE_INVALID", 502, "Provider usage is invalid.");
  }
  const outputJson = canonicalJson(output);
  const outputHash = sha256(outputJson);
  transaction(database, () => {
    const terminal = database.prepare(`
      UPDATE review_model_calls
      SET status='succeeded',prompt_tokens=?,completion_tokens=?,total_tokens=?,
          error_category=NULL,finished_at=?
      WHERE attempt_id=? AND call_index=? AND status='calling'
    `).run(
      usage.promptTokens,
      usage.completionTokens,
      usage.totalTokens,
      now.toISOString(),
      input.attemptId,
      callIndex,
    );
    const attempt = database.prepare(`
      UPDATE review_attempts
      SET status='finalizing',parsed_output_json=?,parsed_output_hash=?,
          output_checkpointed_at=?,finalize_error_code=NULL
      WHERE id=? AND status='calling' AND lease_token=? AND lease_expires_at>?
    `).run(
      outputJson,
      outputHash,
      now.toISOString(),
      input.attemptId,
      leaseToken,
      now.toISOString(),
    );
    if (terminal.changes !== 1 || attempt.changes !== 1) {
      throw new ReviewOrchestratorError(
        "REVIEW_CHECKPOINT_CONFLICT",
        409,
        "Review output checkpoint lost its lease or call CAS.",
      );
    }
  });
  return finalizingResponse({
    errorCategory: null,
    id: input.attemptId,
    operationId: input.operationId,
    output: outputJson,
    outputHash,
    status: "finalizing",
  });
}

function invokeLocalFinalize(
  database: DatabaseSync,
  response: ReviewOperationResponse,
  dependencies: ReviewOrchestratorDependencies,
): void {
  if (response.state !== "finalizing" || !dependencies.localFinalize) return;
  const row = database.prepare(`
    SELECT parsed_output_json AS output FROM review_attempts
    WHERE id=? AND status='finalizing' AND parsed_output_hash=?
  `).get(response.attemptId, response.checkpointHash) as { output: string } | undefined;
  if (!row) {
    throw new ReviewOrchestratorError(
      "REVIEW_CHECKPOINT_INVALID",
      500,
      "Durable review output cannot be read for local finalize.",
    );
  }
  try {
    dependencies.localFinalize(database, {
      attemptId: response.attemptId,
      checkpointHash: response.checkpointHash,
      output: JSON.parse(row.output) as ValidatedReviewOutput,
    });
  } catch {
    database.prepare(`
      UPDATE review_attempts SET finalize_error_code='LOCAL_FINALIZE_FAILED'
      WHERE id=? AND status='finalizing' AND parsed_output_hash=?
    `).run(response.attemptId, response.checkpointHash);
  }
}

async function providerCall(
  database: DatabaseSync,
  input: ReviewOperationInput,
  dependencies: Required<Pick<ReviewOrchestratorDependencies, "callProvider" | "clock" | "randomUUID">>
    & Pick<ReviewOrchestratorDependencies, "scheduleHeartbeat">,
  leaseToken: string,
  request: OpenAiChatRequest,
  kind: ReviewCallKind,
  callIndex: 1 | 2,
): Promise<ModelCallResult> {
  insertCalling(
    database,
    input,
    dependencies.randomUUID(),
    kind,
    callIndex,
    dependencies.clock(),
  );
  const stopHeartbeat = (dependencies.scheduleHeartbeat ?? ((callback, milliseconds) => {
    const timer = setInterval(callback, milliseconds);
    timer.unref();
    return () => clearInterval(timer);
  }))(
    () => heartbeat(database, input.attemptId, leaseToken, dependencies.clock),
    REVIEW_HEARTBEAT_INTERVAL_MILLISECONDS,
  );
  try {
    return await dependencies.callProvider(
      request,
      {
        attemptId: input.attemptId,
        correlationId: dependencies.randomUUID(),
        runId: input.missionId,
      },
      { timeoutMilliseconds: REVIEW_PROVIDER_CALL_TIMEOUT_MILLISECONDS },
    );
  } finally {
    stopHeartbeat();
  }
}

export async function runReviewOperation(
  database: DatabaseSync,
  input: ReviewOperationInput,
  dependencies: ReviewOrchestratorDependencies = {},
): Promise<ReviewOperationResponse> {
  const requestHash = canonicalRequestHash(input.request);
  const replay = operationReplay(database, input, requestHash);
  if (replay) {
    invokeLocalFinalize(database, replay, dependencies);
    return replay;
  }

  const clock = dependencies.clock ?? (() => new Date());
  const randomUUID = dependencies.randomUUID ?? nodeRandomUUID;
  const callProvider = dependencies.callProvider ?? callOpenAiChat;
  const leaseToken = randomUUID();
  acquire(database, input, requestHash, clock(), leaseToken);
  const callDependencies = {
    callProvider,
    clock,
    randomUUID,
    scheduleHeartbeat: dependencies.scheduleHeartbeat,
  };

  const primary = await providerCall(
    database,
    input,
    callDependencies,
    leaseToken,
    input.providerRequest,
    "primary",
    1,
  );
  const primaryUsage = validUsage(primary);
  if (primary.status !== "succeeded" || primary.content === null || !primaryUsage) {
    const status = primary.status === "succeeded" || primary.status === "usage_invalid"
      ? "usage_invalid"
      : "provider_failed";
    const category = primary.error?.category ?? status;
    terminalCall(database, input, 1, status, primary, category, clock());
    return completeFailure(database, input, category, clock());
  }

  let checked = checkedOutput(primary.content, input.validationContext);
  if (checked.structurallyInvalid) {
    terminalCall(
      database,
      input,
      1,
      "response_invalid",
      primary,
      "structured_output_invalid",
      clock(),
    );
    const repair = await providerCall(
      database,
      input,
      callDependencies,
      leaseToken,
      repairRequest(input.providerRequest, primary.content),
      "repair",
      2,
    );
    const repairUsage = validUsage(repair);
    if (repair.status !== "succeeded" || repair.content === null || !repairUsage) {
      const status = repair.status === "succeeded" || repair.status === "usage_invalid"
        ? "usage_invalid"
        : "provider_failed";
      const category = repair.error?.category ?? status;
      terminalCall(database, input, 2, status, repair, category, clock());
      return completeFailure(database, input, category, clock());
    }
    checked = checkedOutput(repair.content, input.validationContext);
    if (!checked.output) {
      terminalCall(
        database,
        input,
        2,
        checked.structurallyInvalid ? "response_invalid" : "succeeded",
        repair,
        checked.category,
        clock(),
      );
      return completeFailure(
        database,
        input,
        checked.category ?? "structured_output_invalid",
        clock(),
      );
    }
    const response = checkpoint(
      database,
      input,
      leaseToken,
      2,
      repair,
      checked.output,
      clock(),
    );
    invokeLocalFinalize(database, response, dependencies);
    return response;
  }

  if (!checked.output) {
    terminalCall(database, input, 1, "succeeded", primary, checked.category, clock());
    return completeFailure(
      database,
      input,
      checked.category ?? "structured_output_invalid",
      clock(),
    );
  }
  const response = checkpoint(
    database,
    input,
    leaseToken,
    1,
    primary,
    checked.output,
    clock(),
  );
  invokeLocalFinalize(database, response, dependencies);
  return response;
}
