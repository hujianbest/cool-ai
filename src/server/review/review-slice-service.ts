import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { createCredentialVault } from "@/src/server/credential-vault";
import { openDatabase } from "@/src/server/db";
import { callOpenAiChat } from "@/src/server/collaboration/openai-chat-client";
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
  id: string;
  keyId: string;
  model: string;
  name: string;
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
           e.agent_id AS executorAgentId
    FROM work_item_review_heads h
    JOIN work_items w ON w.id=h.work_item_id
    JOIN work_item_execution_results r ON r.id=h.current_result_id
    JOIN executions e ON e.id=r.execution_id
    WHERE h.work_item_id=?
  `).get(workItemId) as HeadRow | undefined;
  if (!row) throw new ReviewSliceError("RESULT_NOT_FOUND", 404, "未找到待复核结果");
  return row;
}

function candidates(database: DatabaseSync, row: HeadRow): ReviewCandidateDto[] {
  return (database.prepare(`
    SELECT a.id,a.name,a.role,a.avatar_text AS avatarText,
           a.accent_token AS accentToken,p.id AS providerId,
           p.name AS providerName,a.model
    FROM project_memberships m
    JOIN agents a ON a.id=m.agent_id
    JOIN providers p ON p.id=a.provider_id
    WHERE m.project_id=? AND a.review_capable=1 AND a.id<>?
    ORDER BY a.created_at,a.id
  `).all(row.projectId, row.executorAgentId) as Array<{
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

export function initializeFirstResultReviewTx(
  database: DatabaseSync,
  input: {
    missionId: string;
    projectId: string;
    resultId: string;
    workItemId: string;
  },
): void {
  database.prepare(`
    INSERT INTO work_item_review_heads (
      work_item_id,project_id,mission_id,current_result_id,current_attempt_id,
      state,version,updated_at
    ) VALUES (?, ?, ?, ?, NULL, 'pending_review', 1,
      strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  `).run(input.workItemId, input.projectId, input.missionId, input.resultId);
}

export function readReviewWorkspace(
  databasePath: string,
  workItemId: string,
): ReviewWorkspaceDto {
  const database = openDatabase(databasePath);
  try {
    const row = head(database, workItemId);
    const eligible = candidates(database, row);
    return {
      blockers: eligible.length === 0 ? [{ code: "NO_INDEPENDENT_REVIEWER" }] : [],
      candidates: eligible,
      currentAttempt: attemptDto(database, row.currentAttemptId),
      effectiveStatus: row.state,
      headVersion: row.headVersion,
      result: {
        executorAgentId: row.executorAgentId,
        id: row.resultId,
        version: 1,
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
    FROM work_item_execution_results r
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
           p.credential_version AS credentialVersion
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
      const eligible = candidates(database, row);
      if (!eligible.some(({ agent }) => agent.id === parsed.data.reviewerAgentId)) {
        throw new ReviewSliceError("REVIEWER_INELIGIBLE", 403, "所选 Agent 不具备独立复核资格");
      }
      attemptId = randomUUID();
      material = freezeMaterial(database, row, attemptId);
      provider = providerFor(database, parsed.data.reviewerAgentId);
      database.prepare(`
        INSERT INTO review_attempts (
          id,project_id,mission_id,work_item_id,result_id,reviewer_agent_id,
          status,frozen_material_json,frozen_material_hash,provider_id,model,
          started_at,finished_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'calling', ?, ?, ?, ?,
          strftime('%Y-%m-%dT%H:%M:%fZ','now'),NULL)
      `).run(
        attemptId,
        row.projectId,
        row.missionId,
        row.workItemId,
        row.resultId,
        parsed.data.reviewerAgentId,
        material.json,
        material.hash,
        provider.id,
        provider.model,
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
            id,attempt_id,status,prompt_tokens,completion_tokens,total_tokens,
            started_at,finished_at
          ) VALUES (?, ?, 'failed', ?, ?, ?, ?, ?)
        `).run(
          callId,
          attemptId,
          call.usage?.promptTokens ?? null,
          call.usage?.completionTokens ?? null,
          call.usage?.totalTokens ?? null,
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
          id,attempt_id,status,prompt_tokens,completion_tokens,total_tokens,
          started_at,finished_at
        ) VALUES (?, ?, 'succeeded', ?, ?, ?, ?, ?)
      `).run(
        callId,
        attemptId,
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
      database.prepare(`
        UPDATE work_item_review_heads
        SET state='passed',version=version+1,updated_at=?
        WHERE work_item_id=? AND current_attempt_id=? AND state='reviewing'
      `).run(new Date().toISOString(), workItemId, attemptId);
    });
  } finally {
    database.close();
  }
  return readReviewWorkspace(databasePath, workItemId);
}
