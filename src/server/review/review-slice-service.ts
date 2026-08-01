import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { createCredentialVault } from "@/src/server/credential-vault";
import { openDatabase } from "@/src/server/db";
import { callOpenAiChat } from "@/src/server/collaboration/openai-chat-client";
import {
  invalidateCompletionTx,
  projectPassedWorkItemTx,
} from "@/src/server/review/completion-gate";
import {
  reviewOutputSchema,
  startReviewInputSchema,
  type ReviewAttemptDto,
  type ReviewCandidateDto,
  type ReviewWorkspaceDto,
} from "@/src/shared/review-contracts";

export class ReviewSliceError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ReviewSliceError";
  }
}

type HeadRow = {
  currentAttemptId: string | null;
  executorAgentId: string;
  headVersion: number;
  missionId: string;
  projectId: string;
  resultId: string;
  resultVersion: number;
  state: "pending_review" | "reviewing" | "passed";
  workItemId: string;
  workItemTitle: string;
};

type ProviderRow = {
  apiKeyCipher: string;
  apiKeyIv: string;
  apiKeyTag: string;
  baseUrl: string;
  credentialVersion: 1;
  credentialGeneration: number;
  id: string;
  keyId: string;
  model: string;
  name: string;
  providerVersion: number;
  verifiedAt: string;
};

function transaction<T>(database: DatabaseSync, work: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function head(database: DatabaseSync, workItemId: string): HeadRow {
  const row = database.prepare(`
    SELECT h.work_item_id AS workItemId,h.project_id AS projectId,
           h.mission_id AS missionId,h.current_result_id AS resultId,
           h.current_attempt_id AS currentAttemptId,h.state,
           h.version AS headVersion,w.title AS workItemTitle,
           r.version AS resultVersion,e.agent_id AS executorAgentId
    FROM work_item_review_heads h
    JOIN work_items w ON w.id=h.work_item_id
    JOIN work_item_result_versions r ON r.id=h.current_result_id
    JOIN executions e ON e.id=r.execution_id
    WHERE h.work_item_id=?
  `).get(workItemId) as HeadRow | undefined;
  if (!row) throw new ReviewSliceError("RESULT_NOT_FOUND", 404, "未找到待复核结果");
  return row;
}

function qualifiedCandidates(
  database: DatabaseSync,
  projectId: string,
  executorAgentId: string,
): ReviewCandidateDto[] {
  return (database.prepare(`
    SELECT a.id,a.name,a.role,a.avatar_text AS avatarText,
           a.accent_token AS accentToken,p.id AS providerId,
           p.name AS providerName,a.model
    FROM project_memberships m
    JOIN agents a ON a.id=m.agent_id
    JOIN providers p ON p.id=a.provider_id
    WHERE m.project_id=? AND a.review_capable=1 AND a.id<>?
    ORDER BY a.created_at,a.id
  `).all(projectId, executorAgentId) as Array<{
    accentToken: string;
    avatarText: string;
    id: string;
    model: string;
    name: string;
    providerId: string;
    providerName: string;
    role: string;
  }>).map((candidate) => ({
    agent: {
      accentToken: candidate.accentToken,
      avatarText: candidate.avatarText,
      id: candidate.id,
      name: candidate.name,
      role: candidate.role,
    },
    provider: {
      id: candidate.providerId,
      model: candidate.model,
      name: candidate.providerName,
    },
    qualification: ["current_member", "review_capable", "not_executor"],
  }));
}

export function listReviewCandidatesTx(
  database: DatabaseSync,
  workItemId: string,
  resultId: string,
): {
  blockers: Array<{ code: string }>;
  candidates: ReviewCandidateDto[];
  selectedReviewerAgentId: null;
} {
  const current = database.prepare(`
    SELECT h.project_id AS projectId,h.current_result_id AS resultId,h.state,
           r.executor_agent_id AS executorAgentId
    FROM work_item_review_heads h
    JOIN work_item_result_versions r
      ON r.work_item_id=h.work_item_id AND r.id=h.current_result_id
    WHERE h.work_item_id=?
  `).get(workItemId) as {
    executorAgentId: string;
    projectId: string;
    resultId: string;
    state: string;
  } | undefined;
  if (
    !current
    || current.state !== "pending_review"
    || current.resultId !== resultId
  ) {
    throw new ReviewSliceError(
      "REVIEW_STATE_CONFLICT",
      409,
      "复核结果或状态已变化",
    );
  }
  const candidates = qualifiedCandidates(
    database,
    current.projectId,
    current.executorAgentId,
  );
  return {
    blockers: candidates.length === 0
      ? [{ code: "NO_INDEPENDENT_REVIEWER" }]
      : [],
    candidates,
    selectedReviewerAgentId: null,
  };
}

function attemptDto(database: DatabaseSync, attemptId: string | null): ReviewAttemptDto | null {
  if (!attemptId) return null;
  const attempt = database.prepare(`
    SELECT a.id,a.status,a.frozen_material_hash AS materialHash,
           a.frozen_material_json AS materialJson,a.reviewer_agent_id AS reviewerId,
           g.name AS reviewerName,g.avatar_text AS avatarText,
           g.accent_token AS accentToken,a.provider_id AS providerId,
           p.name AS providerName,a.model
    FROM review_attempts a
    JOIN agents g ON g.id=a.reviewer_agent_id
    JOIN providers p ON p.id=a.provider_id
    WHERE a.id=?
  `).get(attemptId) as {
    accentToken: string;
    avatarText: string;
    id: string;
    materialHash: string;
    materialJson: string;
    model: string;
    providerId: string;
    providerName: string;
    reviewerId: string;
    reviewerName: string;
    status: ReviewAttemptDto["status"];
  } | undefined;
  if (!attempt) return null;
  const calls = database.prepare(`
    SELECT id,status,prompt_tokens AS promptTokens,
           completion_tokens AS completionTokens,total_tokens AS totalTokens
    FROM review_model_calls WHERE attempt_id=? ORDER BY started_at,id
  `).all(attemptId) as Array<{
    completionTokens: number | null;
    id: string;
    promptTokens: number | null;
    status: "succeeded" | "failed";
    totalTokens: number | null;
  }>;
  const decision = database.prepare(`
    SELECT id,choice,public_summary AS publicSummary
    FROM review_decisions WHERE attempt_id=?
  `).get(attemptId) as ReviewAttemptDto["decision"] | undefined;
  const promptTokens = calls.reduce((sum, call) => sum + (call.promptTokens ?? 0), 0);
  const completionTokens = calls.reduce((sum, call) => sum + (call.completionTokens ?? 0), 0);
  return {
    calls: calls.map((call) => ({
      id: call.id,
      status: call.status,
      usage: {
        completionTokens: call.completionTokens,
        promptTokens: call.promptTokens,
        reported: call.totalTokens !== null,
        totalTokens: call.totalTokens,
      },
    })),
    decision: decision ?? null,
    id: attempt.id,
    material: {
      hash: attempt.materialHash,
      sourceCount: (JSON.parse(attempt.materialJson) as { sourceRefs: unknown[] }).sourceRefs.length,
    },
    provider: { id: attempt.providerId, model: attempt.model, name: attempt.providerName },
    reviewer: {
      accentToken: attempt.accentToken,
      avatarText: attempt.avatarText,
      id: attempt.reviewerId,
      name: attempt.reviewerName,
    },
    status: attempt.status,
    usageTotal: {
      completionTokens,
      promptTokens,
      reportedCalls: calls.filter((call) => call.totalTokens !== null).length,
      totalTokens: promptTokens + completionTokens,
    },
  };
}

type ResultVersionInput = {
  executionId: string;
  executorAgentId: string;
  mergeJournalId: string;
  missionId: string;
  projectId: string;
  resultId: string;
  stagedResultId: string;
  workItemId: string;
};

function appendResultEventTx(
  database: DatabaseSync,
  input: {
    missionId: string;
    payload: Record<string, unknown>;
    projectId: string;
    type: "result_version_created" | "rework_requested";
  },
): void {
  const now = new Date().toISOString();
  const deliveryHead = database.prepare(`
    SELECT next_event_sequence AS sequence
    FROM mission_delivery_heads
    WHERE mission_id=? AND project_id=?
  `).get(input.missionId, input.projectId) as { sequence: number } | undefined;
  if (!deliveryHead) {
    throw new ReviewSliceError(
      "REVIEW_STATE_CONFLICT",
      409,
      "Mission review context is not initialized.",
    );
  }
  database.prepare(`
    INSERT INTO review_events(
      id,project_id,mission_id,sequence,type,actor_type,actor_id,payload_json,created_at
    ) VALUES (?, ?, ?, ?, ?, 'system', NULL, ?, ?)
  `).run(
    randomUUID(),
    input.projectId,
    input.missionId,
    deliveryHead.sequence,
    input.type,
    JSON.stringify(input.payload),
    now,
  );
  const advanced = database.prepare(`
    UPDATE mission_delivery_heads
    SET next_event_sequence=next_event_sequence+1,updated_at=?
    WHERE mission_id=? AND project_id=? AND next_event_sequence=?
  `).run(now, input.missionId, input.projectId, deliveryHead.sequence);
  if (advanced.changes !== 1) {
    throw new ReviewSliceError("REVIEW_STATE_CONFLICT", 409, "Review event sequence changed.");
  }
}

function insertResultVersionTx(
  database: DatabaseSync,
  input: ResultVersionInput,
  version: number,
  supersedesResultId: string | null,
): void {
  database.prepare(`
    INSERT INTO work_item_result_versions (
      id,project_id,mission_id,work_item_id,version,execution_id,staged_result_id,
      merge_journal_id,supersedes_result_id,executor_agent_id,created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  `).run(
    input.resultId,
    input.projectId,
    input.missionId,
    input.workItemId,
    version,
    input.executionId,
    input.stagedResultId,
    input.mergeJournalId,
    supersedesResultId,
    input.executorAgentId,
  );
}

export function initializeFirstResultHeadTx(
  database: DatabaseSync,
  input: ResultVersionInput,
): { resultId: string; version: number } {
  const existing = database.prepare(`
    SELECT
      (SELECT COUNT(*) FROM work_item_result_versions WHERE work_item_id=?) AS results,
      (SELECT COUNT(*) FROM work_item_review_heads WHERE work_item_id=?) AS heads
  `).get(input.workItemId, input.workItemId) as { heads: number; results: number };
  if (existing.heads !== 0 || existing.results !== 0) {
    throw new ReviewSliceError(
      "REVIEW_STATE_CONFLICT",
      409,
      "The first result head already exists.",
    );
  }
  insertResultVersionTx(database, input, 1, null);
  database.prepare(`
    INSERT INTO work_item_review_heads (
      work_item_id,project_id,mission_id,current_result_id,current_attempt_id,
      state,version,updated_at
    ) VALUES (?, ?, ?, ?, NULL, 'pending_review', 1,
      strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  `).run(input.workItemId, input.projectId, input.missionId, input.resultId);
  appendResultEventTx(database, {
    missionId: input.missionId,
    payload: { resultId: input.resultId, resultVersion: 1, workItemId: input.workItemId },
    projectId: input.projectId,
    type: "result_version_created",
  });
  return { resultId: input.resultId, version: 1 };
}

export function advanceResultHeadTx(
  database: DatabaseSync,
  input: ResultVersionInput & {
    expectedHeadVersion: number;
    expectedResultId: string;
  },
): { resultId: string; version: number } {
  const current = database.prepare(`
    SELECT h.project_id AS projectId,h.mission_id AS missionId,
           h.current_result_id AS resultId,h.current_attempt_id AS attemptId,
           h.state,h.version AS headVersion,r.version AS resultVersion
    FROM work_item_review_heads h
    JOIN work_item_result_versions r
      ON r.work_item_id=h.work_item_id AND r.id=h.current_result_id
    WHERE h.work_item_id=?
  `).get(input.workItemId) as {
    attemptId: string | null;
    headVersion: number;
    missionId: string;
    projectId: string;
    resultId: string;
    resultVersion: number;
    state: string;
  } | undefined;
  if (
    !current
    || current.projectId !== input.projectId
    || current.missionId !== input.missionId
    || current.resultId !== input.expectedResultId
    || current.headVersion !== input.expectedHeadVersion
    || current.state !== "rework"
    || current.attemptId !== null
  ) {
    throw new ReviewSliceError("REVIEW_STATE_CONFLICT", 409, "Result head changed before merge.");
  }
  const nextVersion = current.resultVersion + 1;
  insertResultVersionTx(database, input, nextVersion, current.resultId);
  const updated = database.prepare(`
    UPDATE work_item_review_heads
    SET current_result_id=?,current_attempt_id=NULL,state='pending_review',
        version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE work_item_id=? AND project_id=? AND mission_id=?
      AND current_result_id=? AND current_attempt_id IS NULL
      AND state='rework' AND version=?
  `).run(
    input.resultId,
    input.workItemId,
    input.projectId,
    input.missionId,
    current.resultId,
    current.headVersion,
  );
  if (updated.changes !== 1) {
    throw new ReviewSliceError("REVIEW_STATE_CONFLICT", 409, "Result head merge CAS was lost.");
  }
  appendResultEventTx(database, {
    missionId: input.missionId,
    payload: {
      resultId: input.resultId,
      resultVersion: nextVersion,
      supersedesResultId: current.resultId,
      workItemId: input.workItemId,
    },
    projectId: input.projectId,
    type: "result_version_created",
  });
  return { resultId: input.resultId, version: nextVersion };
}

export function requestResultReworkTx(
  database: DatabaseSync,
  input: {
    expectedAttemptId: string | null;
    expectedHeadVersion: number;
    expectedResultId: string;
    workItemId: string;
  },
): void {
  const current = database.prepare(`
    SELECT project_id AS projectId,mission_id AS missionId,
           current_result_id AS resultId,current_attempt_id AS attemptId,state,version
    FROM work_item_review_heads WHERE work_item_id=?
  `).get(input.workItemId) as {
    attemptId: string | null;
    missionId: string;
    projectId: string;
    resultId: string;
    state: string;
    version: number;
  } | undefined;
  const validSource = current && (
    (current.state === "reviewing"
      && input.expectedAttemptId !== null
      && current.attemptId === input.expectedAttemptId)
    || (current.state === "waiting_owner"
      && input.expectedAttemptId === null
      && current.attemptId === null)
    || (current.state === "passed"
      && input.expectedAttemptId === null)
  );
  if (
    !validSource
    || current.resultId !== input.expectedResultId
    || current.version !== input.expectedHeadVersion
  ) {
    throw new ReviewSliceError("REVIEW_STATE_CONFLICT", 409, "Stale rework request.");
  }
  if (current.state === "passed") {
    invalidateCompletionTx(database, {
      reason: "DOWNSTREAM_REWORK_REQUESTED",
      workItemId: input.workItemId,
    });
    return;
  }
  const updated = database.prepare(`
    UPDATE work_item_review_heads
    SET state='rework',current_attempt_id=NULL,version=version+1,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE work_item_id=? AND current_result_id=? AND version=? AND state=?
      AND current_attempt_id IS ?
  `).run(
    input.workItemId,
    input.expectedResultId,
    input.expectedHeadVersion,
    current.state,
    input.expectedAttemptId,
  );
  if (updated.changes !== 1) {
    throw new ReviewSliceError("REVIEW_STATE_CONFLICT", 409, "Rework head CAS was lost.");
  }
  appendResultEventTx(database, {
    missionId: current.missionId,
    payload: { resultId: current.resultId, workItemId: input.workItemId },
    projectId: current.projectId,
    type: "rework_requested",
  });
}

export function readReviewWorkspace(
  databasePath: string,
  workItemId: string,
): ReviewWorkspaceDto {
  const database = openDatabase(databasePath);
  try {
    const row = head(database, workItemId);
    const eligible = qualifiedCandidates(database, row.projectId, row.executorAgentId);
    return {
      blockers: eligible.length === 0 ? [{ code: "NO_INDEPENDENT_REVIEWER" }] : [],
      candidates: eligible,
      currentAttempt: attemptDto(database, row.currentAttemptId),
      effectiveStatus: row.state,
      headVersion: row.headVersion,
      result: {
        executorAgentId: row.executorAgentId,
        id: row.resultId,
        version: row.resultVersion,
      },
      workItem: { id: row.workItemId, title: row.workItemTitle },
    };
  } finally {
    database.close();
  }
}

function freezeMaterial(database: DatabaseSync, row: HeadRow, attemptId: string) {
  const result = database.prepare(`
    SELECT r.id,r.execution_id AS executionId,r.staged_result_id AS stagedResultId,
           s.staged_hash AS stagedHash
    FROM work_item_result_versions r
    JOIN execution_staged_results s ON s.id=r.staged_result_id
    WHERE r.id=?
  `).get(row.resultId) as {
    executionId: string;
    id: string;
    stagedHash: string;
    stagedResultId: string;
  };
  const changes = database.prepare(`
    SELECT id,path,diff_text AS text FROM execution_staged_observations
    WHERE staged_result_id=? AND diff_text IS NOT NULL AND diff_bytes>0
    ORDER BY position,id
  `).all(result.stagedResultId) as Array<{ id: string; path: string; text: string }>;
  const validations = database.prepare(`
    SELECT id,exit_code AS exitCode,succeeded,sandbox_manifest_hash AS version
    FROM execution_validation_results
    WHERE execution_id=? AND required=1 ORDER BY finished_at,id
  `).all(result.executionId) as Array<{
    exitCode: number;
    id: string;
    succeeded: number;
    version: string;
  }>;
  const withOutput = validations.map((validation) => {
    const chunks = database.prepare(`
      SELECT stream,text FROM execution_validation_output_chunks
      WHERE validation_id=? ORDER BY stream,chunk_index
    `).all(validation.id) as Array<{ stream: "stderr" | "stdout"; text: string }>;
    return {
      ...validation,
      stderr: chunks.filter(({ stream }) => stream === "stderr").map(({ text }) => text).join(""),
      stdout: chunks.filter(({ stream }) => stream === "stdout").map(({ text }) => text).join(""),
    };
  });
  if (changes.length === 0 || withOutput.length === 0 || withOutput.some(({ succeeded }) => succeeded !== 1)) {
    throw new ReviewSliceError("REVIEW_MATERIAL_INVALID", 422, "公开复核材料无效");
  }
  const material = {
    changes,
    result: { id: row.resultId, stagedHash: result.stagedHash, version: 1 },
    review: { attemptId, version: "1" },
    sourceRefs: [
      { id: row.workItemId, type: "task", version: "1" },
      { id: row.resultId, type: "result", version: "1" },
      ...withOutput.map(({ id, version }) => ({ id, type: "validation", version })),
    ],
    validations: withOutput,
  };
  const json = JSON.stringify(material);
  return { hash: createHash("sha256").update(json).digest("hex"), json };
}

function providerFor(database: DatabaseSync, reviewerId: string): ProviderRow {
  const row = database.prepare(`
    SELECT p.id,p.name,p.base_url AS baseUrl,a.model,p.api_key_cipher AS apiKeyCipher,
           p.api_key_iv AS apiKeyIv,p.api_key_tag AS apiKeyTag,p.key_id AS keyId,
           p.credential_version AS credentialVersion,
           p.credential_generation AS credentialGeneration,p.version AS providerVersion,
           p.verified_at AS verifiedAt
    FROM agents a JOIN providers p ON p.id=a.provider_id
    WHERE a.id=? AND p.verified_at IS NOT NULL
  `).get(reviewerId) as ProviderRow | undefined;
  if (!row) throw new ReviewSliceError("CREDENTIAL_UNAVAILABLE", 503, "复核凭据暂不可用");
  return row;
}

export async function startReview(
  databasePath: string,
  workItemId: string,
  input: unknown,
): Promise<ReviewWorkspaceDto> {
  const parsed = startReviewInputSchema.safeParse(input);
  if (!parsed.success) throw new ReviewSliceError("INVALID_INPUT", 400, "输入不符合约束");
  const database = openDatabase(databasePath);
  let attemptId = "";
  let material = { hash: "", json: "" };
  let provider!: ProviderRow;
  try {
    const acquired = transaction(database, () => {
      const row = head(database, workItemId);
      if (
        row.state !== "pending_review"
        || row.resultId !== parsed.data.resultId
        || row.headVersion !== parsed.data.expectedHeadVersion
      ) {
        throw new ReviewSliceError("REVIEW_STATE_CONFLICT", 409, "复核状态已变化");
      }
      const eligible = listReviewCandidatesTx(
        database,
        workItemId,
        parsed.data.resultId,
      ).candidates;
      if (!eligible.some(({ agent }) => agent.id === parsed.data.reviewerAgentId)) {
        throw new ReviewSliceError("REVIEWER_INELIGIBLE", 403, "所选 Agent 不具备独立复核资格");
      }
      attemptId = randomUUID();
      material = freezeMaterial(database, row, attemptId);
      provider = providerFor(database, parsed.data.reviewerAgentId);
      const startedAt = new Date().toISOString();
      const leaseExpiresAt = new Date(Date.now() + 120_000).toISOString();
      const requestHash = createHash("sha256")
        .update(JSON.stringify(parsed.data))
        .digest("hex");
      database.prepare(`
        INSERT INTO review_operations(
          id,project_id,kind,parent_id,request_hash,status,http_status,response_json,created_at,updated_at
        ) VALUES (?,?,'start_review',?,?,'pending',NULL,NULL,?,?)
      `).run(parsed.data.operationId, row.projectId, row.workItemId, requestHash, startedAt, startedAt);
      database.prepare(`
        INSERT INTO review_attempts (
          id,project_id,mission_id,work_item_id,result_id,reviewer_agent_id,
          operation_id,status,lease_token,lease_expires_at,
          frozen_material_json,frozen_material_hash,prompt_hash,
          provider_id,provider_version,credential_generation,verified_at,model,
          started_at,finished_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'calling', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ?,NULL)
      `).run(
        attemptId,
        row.projectId,
        row.missionId,
        row.workItemId,
        row.resultId,
        parsed.data.reviewerAgentId,
        parsed.data.operationId,
        randomUUID(),
        leaseExpiresAt,
        material.json,
        material.hash,
        material.hash,
        provider.id,
        provider.providerVersion,
        provider.credentialGeneration,
        provider.verifiedAt,
        provider.model,
        startedAt,
      );
      database.prepare(`
        UPDATE work_item_review_heads
        SET state='reviewing',current_attempt_id=?,version=version+1,
            updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE work_item_id=? AND version=?
      `).run(attemptId, workItemId, row.headVersion);
      return row;
    });
    const apiKey = createCredentialVault().decrypt(provider.id, {
      apiKeyCipher: provider.apiKeyCipher,
      apiKeyIv: provider.apiKeyIv,
      apiKeyMask: "hidden",
      apiKeyTag: provider.apiKeyTag,
      credentialVersion: provider.credentialVersion,
      keyId: provider.keyId,
    });
    const callStartedAt = new Date().toISOString();
    const call = await callOpenAiChat({
      apiKey,
      baseUrl: provider.baseUrl,
      model: provider.model,
      messages: [
        { role: "system", content: "你是独立复核 Agent。只返回 strict JSON 公开结论，不输出隐藏思维链。" },
        { role: "system", content: material.json },
        { role: "user", content: "基于冻结 diff 与 required validation 正文，返回且仅返回一个 reject、escalate 或 pass 裁决。" },
      ],
    }, {
      attemptId,
      correlationId: randomUUID(),
      runId: acquired.missionId,
    });
    const callId = randomUUID();
    if (call.status !== "succeeded" || !call.content || !call.usage) {
      transaction(database, () => {
        database.prepare(`
          INSERT INTO review_model_calls (
            id,attempt_id,kind,call_index,status,prompt_hash,
            prompt_tokens,completion_tokens,total_tokens,error_category,started_at,finished_at
          ) VALUES (?, ?,'primary',1,'provider_failed',?, ?, ?, ?, ?, ?, ?)
        `).run(
          callId,
          attemptId,
          material.hash,
          call.usage?.promptTokens ?? null,
          call.usage?.completionTokens ?? null,
          call.usage?.totalTokens ?? null,
          call.error?.code ?? "provider_failed",
          callStartedAt,
          new Date().toISOString(),
        );
        database.prepare(
          "UPDATE review_attempts SET status='failed',finished_at=? WHERE id=?",
        ).run(new Date().toISOString(), attemptId);
        database.prepare(`
          UPDATE work_item_review_heads
          SET state='pending_review',current_attempt_id=?,version=version+1,updated_at=?
          WHERE work_item_id=? AND current_attempt_id=?
        `).run(attemptId, new Date().toISOString(), workItemId, attemptId);
      });
      throw new ReviewSliceError(call.error?.code ?? "PROVIDER_RESPONSE_INVALID", 502, "Provider 服务暂时异常");
    }
    let output: unknown;
    try {
      output = JSON.parse(call.content);
    } catch {
      output = null;
    }
    const reviewed = reviewOutputSchema.safeParse(output);
    if (!reviewed.success) {
      throw new ReviewSliceError("STRUCTURED_OUTPUT_INVALID", 400, "复核输出格式无效");
    }
    const usage = call.usage;
    transaction(database, () => {
      database.prepare(`
        INSERT INTO review_model_calls (
          id,attempt_id,kind,call_index,status,prompt_hash,
          prompt_tokens,completion_tokens,total_tokens,error_category,started_at,finished_at
        ) VALUES (?, ?,'primary',1,'succeeded',?, ?, ?, ?, NULL, ?, ?)
      `).run(
        callId,
        attemptId,
        material.hash,
        usage.promptTokens,
        usage.completionTokens,
        usage.totalTokens,
        callStartedAt,
        new Date().toISOString(),
      );
      database.prepare(`
        INSERT INTO review_decisions (
          id,attempt_id,result_id,reviewer_agent_id,choice,public_summary,
          findings_json,evidence_refs_json,limitations_json,created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?,
          strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      `).run(
        randomUUID(),
        attemptId,
        acquired.resultId,
        parsed.data.reviewerAgentId,
        reviewed.data.decision.choice,
        reviewed.data.publicSummary,
        JSON.stringify(reviewed.data.findings),
        JSON.stringify(reviewed.data.evidenceRefs),
        JSON.stringify(reviewed.data.limitations),
      );
      database.prepare(
        "UPDATE review_attempts SET status='passed',finished_at=? WHERE id=? AND status='calling'",
      ).run(new Date().toISOString(), attemptId);
      const projectedHead = database.prepare(`
        UPDATE work_item_review_heads
        SET state='passed',version=version+1,updated_at=?
        WHERE work_item_id=? AND current_attempt_id=? AND state='reviewing'
      `).run(new Date().toISOString(), workItemId, attemptId);
      if (projectedHead.changes !== 1) {
        throw new ReviewSliceError(
          "REVIEW_STATE_CONFLICT",
          409,
          "Review pass lost its completion-head CAS.",
        );
      }
      projectPassedWorkItemTx(database, {
        expectedHeadVersion: acquired.headVersion + 2,
        workItemId,
      });
    });
  } finally {
    database.close();
  }
  return readReviewWorkspace(databasePath, workItemId);
}
