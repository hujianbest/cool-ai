import { randomUUID as nodeRandomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { canonicalRequestHash } from "@/src/server/collaboration/operation-receipts";
import { createCredentialVault } from "@/src/modules/identity-capability/internal/credential-vault";
import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import {
  finalizeCheckpointedReview,
} from "@/src/server/review/review-finalizer";
import {
  freezeReviewMaterial,
  type FrozenPublicContent,
  type ReviewMaterialHead,
  type VersionRef,
} from "@/src/server/review/review-material";
import {
  ReviewOrchestratorError,
  runReviewOperation,
  type ReviewOperationInput,
  type ReviewOrchestratorDependencies,
} from "@/src/server/review/review-orchestrator";
import { buildReviewProviderRequest } from "@/src/server/review/review-schema";
import { ReviewSliceError } from "@/src/server/review/review-slice-service";
import {
  reviewOperationResponseSchema,
  startReviewInputSchema,
  type ReviewOperationResponse,
} from "@/src/shared/review-contracts";

type PublicReviewDependencies = Pick<
  ReviewOrchestratorDependencies,
  "beforeFinalizeStep" | "callProvider" | "clock" | "fault" | "randomUUID" | "scheduleHeartbeat"
> & {
  afterSnapshot?: (database: DatabaseSync) => void;
};

type SnapshotHead = ReviewMaterialHead & {
  executorAgentId: string;
  headVersion: number;
  state: string;
};

type ReviewerSnapshot = {
  agentVersion: number;
  apiKeyCipher: string;
  apiKeyIv: string;
  apiKeyTag: string;
  baseUrl: string;
  credentialGeneration: number;
  credentialVersion: 1;
  keyId: string;
  maxTokens: number;
  model: string;
  providerId: string;
  providerVersion: number;
  reviewerRole: string;
  reviewerSystemPrompt: string;
  verifiedAt: string;
};

type ExistingOperation = {
  projectId: string;
  requestHash: string;
  responseJson: string | null;
  status: string;
};

function transaction<T>(database: DatabaseSync, mode: "" | " IMMEDIATE", work: () => T): T {
  database.exec(`BEGIN${mode}`);
  try {
    const result = work();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the stable application error.
    }
    throw error;
  }
}

function publicTuple(
  workItemId: string,
  body: { expectedHeadVersion: number; resultId: string; reviewerAgentId: string },
): readonly [string, string, string, string, number] {
  return [
    "review.v1",
    workItemId,
    body.resultId,
    body.reviewerAgentId,
    body.expectedHeadVersion,
  ];
}

function projectForWorkItem(database: DatabaseSync, workItemId: string): string {
  const row = database.prepare(`
    SELECT mission.project_id AS projectId
    FROM work_items item JOIN missions mission ON mission.id=item.mission_id
    WHERE item.id=?
  `).get(workItemId) as { projectId: string } | undefined;
  if (!row) throw new ReviewSliceError("WORK_ITEM_NOT_FOUND", 404, "未找到对应的任务");
  return row.projectId;
}

function existingOperation(
  database: DatabaseSync,
  projectId: string,
  operationId: string,
): ExistingOperation | null {
  return (database.prepare(`
    SELECT project_id AS projectId,request_hash AS requestHash,status,
           response_json AS responseJson
    FROM review_operations
    WHERE project_id=? AND id=? AND kind='start_review'
  `).get(projectId, operationId) as ExistingOperation | undefined) ?? null;
}

function replayExisting(
  database: DatabaseSync,
  existing: ExistingOperation,
  expectedHash: string,
  operationId: string,
): ReviewOperationResponse {
  if (existing.requestHash !== expectedHash) {
    throw new ReviewOrchestratorError(
      "OPERATION_CONFLICT",
      409,
      "操作标识与原请求冲突",
    );
  }
  if (existing.status === "completed" && existing.responseJson) {
    return reviewOperationResponseSchema.parse(JSON.parse(existing.responseJson));
  }
  const attempt = database.prepare(`
    SELECT id,parsed_output_hash AS checkpointHash,status
    FROM review_attempts WHERE project_id=? AND operation_id=?
  `).get(existing.projectId, operationId) as {
    checkpointHash: string | null;
    id: string;
    status: string;
  } | undefined;
  if (attempt?.status === "finalizing" && attempt.checkpointHash) {
    return finalizeCheckpointedReview(database, {
      attemptId: attempt.id,
      checkpointHash: attempt.checkpointHash,
    });
  }
  throw new ReviewOrchestratorError(
    "OPERATION_IN_PROGRESS",
    409,
    "操作仍在进行",
  );
}

function readHead(database: DatabaseSync, workItemId: string): SnapshotHead {
  const row = database.prepare(`
    SELECT head.work_item_id AS workItemId,head.project_id AS projectId,
           head.mission_id AS missionId,head.current_result_id AS resultId,
           head.state,head.version AS headVersion,result.version AS resultVersion,
           result.executor_agent_id AS executorAgentId
    FROM work_item_review_heads head
    JOIN work_item_result_versions result
      ON result.work_item_id=head.work_item_id AND result.id=head.current_result_id
    WHERE head.work_item_id=?
  `).get(workItemId) as SnapshotHead | undefined;
  if (!row) throw new ReviewSliceError("RESULT_NOT_FOUND", 404, "未找到待复核结果");
  return row;
}

function readReviewer(
  database: DatabaseSync,
  projectId: string,
  reviewerAgentId: string,
  executorAgentId: string,
): ReviewerSnapshot {
  const row = database.prepare(`
    SELECT agent.version AS agentVersion,agent.max_tokens AS maxTokens,
           agent.role AS reviewerRole,agent.system_prompt AS reviewerSystemPrompt,
           agent.model,provider.id AS providerId,provider.base_url AS baseUrl,
           provider.api_key_cipher AS apiKeyCipher,provider.api_key_iv AS apiKeyIv,
           provider.api_key_tag AS apiKeyTag,provider.key_id AS keyId,
           provider.credential_version AS credentialVersion,
           provider.credential_generation AS credentialGeneration,
           provider.version AS providerVersion,provider.verified_at AS verifiedAt
    FROM project_memberships membership
    JOIN agents agent ON agent.id=membership.agent_id
    JOIN providers provider ON provider.id=agent.provider_id
    WHERE membership.project_id=? AND agent.id=? AND agent.review_capable=1
      AND agent.id<>? AND provider.verified_at<>''
  `).get(projectId, reviewerAgentId, executorAgentId) as ReviewerSnapshot | undefined;
  if (!row) {
    throw new ReviewSliceError(
      "REVIEWER_INELIGIBLE",
      403,
      "所选 Agent 不具备独立复核资格",
    );
  }
  return row;
}

function skills(database: DatabaseSync, reviewerAgentId: string): string[] {
  return (database.prepare(`
    SELECT skill.instructions
    FROM agent_skills assignment JOIN skills skill ON skill.id=assignment.skill_id
    WHERE assignment.agent_id=?
    ORDER BY assignment.position,skill.id
  `).all(reviewerAgentId) as Array<{ instructions: string }>)
    .map((row) => row.instructions);
}

function reviewerIdentity(reviewer: ReviewerSnapshot, reviewerSkills: string[]): string {
  return canonicalRequestHash([
    reviewer.agentVersion,
    reviewer.providerId,
    reviewer.providerVersion,
    reviewer.credentialGeneration,
    reviewer.verifiedAt,
    reviewer.model,
    reviewer.reviewerRole,
    reviewer.reviewerSystemPrompt,
    reviewerSkills,
  ]);
}

function contentKey(ref: VersionRef): string {
  return JSON.stringify([ref.type, ref.id, ref.version]);
}

function validationSources(material: Record<string, any>): Array<{
  complete: boolean;
  hasVerifiedContent: boolean;
  ref: VersionRef;
}> {
  const status = new Map<string, { complete: boolean; hasVerifiedContent: boolean }>();
  const observe = (content: FrozenPublicContent) => {
    const value = {
      complete: content.status === "complete",
      hasVerifiedContent: content.originalBytes === 0 || content.chunks.length > 0,
    };
    const key = contentKey(content.source);
    const prior = status.get(key);
    status.set(key, prior
      ? {
          complete: prior.complete && value.complete,
          hasVerifiedContent: prior.hasVerifiedContent && value.hasVerifiedContent,
        }
      : value);
  };
  for (const observation of material.changes.observations) observe(observation.publicDiff);
  for (const validation of material.validations) {
    observe(validation.stdout);
    observe(validation.stderr);
  }
  for (const artifact of material.artifacts) observe(artifact.content);
  for (const event of material.auditEvents) observe(event.payload);
  return (material.sourceRefs as VersionRef[]).map((ref) => ({
    complete: status.get(contentKey(ref))?.complete ?? true,
    hasVerifiedContent: status.get(contentKey(ref))?.hasVerifiedContent ?? true,
    ref,
  }));
}

function trustedUsage(
  database: DatabaseSync,
  projectId: string,
  reviewerAgentId: string,
  executionId: string,
): number {
  const source = database.prepare(`
    SELECT source_collaboration_run_id AS runId
    FROM executions WHERE id=? AND project_id=?
  `).get(executionId, projectId) as { runId: string } | undefined;
  const review = database.prepare(`
    SELECT COALESCE(SUM(call.total_tokens),0) AS total
    FROM review_model_calls call
    JOIN review_attempts attempt ON attempt.id=call.attempt_id
    WHERE attempt.project_id=? AND attempt.reviewer_agent_id=?
      AND call.total_tokens IS NOT NULL
  `).get(projectId, reviewerAgentId) as { total: number };
  if (!source) return Number(review.total);
  const collaboration = database.prepare(`
    SELECT COALESCE(SUM(call.total_tokens),0) AS total
    FROM collaboration_model_calls call
    JOIN collaboration_attempts attempt ON attempt.id=call.attempt_id
    WHERE attempt.project_id=? AND attempt.run_id=? AND attempt.agent_id=?
      AND call.total_tokens IS NOT NULL
  `).get(projectId, source.runId, reviewerAgentId) as { total: number };
  const execution = database.prepare(`
    SELECT COALESCE(SUM(call.total_tokens),0) AS total
    FROM execution_model_calls call
    JOIN executions execution ON execution.id=call.execution_id
    WHERE execution.project_id=? AND execution.source_collaboration_run_id=?
      AND execution.agent_id=? AND call.total_tokens IS NOT NULL
  `).get(projectId, source.runId, reviewerAgentId) as { total: number };
  return Number(review.total) + Number(collaboration.total) + Number(execution.total);
}

export async function startPublicReview(
  databasePath: string,
  workItemId: string,
  input: unknown,
  dependencies: PublicReviewDependencies = {},
): Promise<ReviewOperationResponse> {
  const parsed = startReviewInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new ReviewSliceError(
      "REVIEW_MATERIAL_INVALID",
      422,
      "公开复核请求仅允许 operationId、resultId、reviewerAgentId、expectedHeadVersion",
    );
  }
  const requestTuple = publicTuple(workItemId, parsed.data);
  const requestHash = canonicalRequestHash(requestTuple);
  const database = openDatabase(databasePath);
  try {
    const projectId = projectForWorkItem(database, workItemId);
    const existing = existingOperation(database, projectId, parsed.data.operationId);
    if (existing) {
      return replayExisting(database, existing, requestHash, parsed.data.operationId);
    }

    const randomUUID = dependencies.randomUUID ?? nodeRandomUUID;
    const attemptId = randomUUID();
    const snapshot = transaction(database, "", () => {
      const current = readHead(database, workItemId);
      if (
        current.state !== "pending_review"
        || current.resultId !== parsed.data.resultId
        || current.headVersion !== parsed.data.expectedHeadVersion
      ) {
        throw new ReviewSliceError("REVIEW_STATE_CONFLICT", 409, "复核状态已变化");
      }
      const reviewer = readReviewer(
        database,
        current.projectId,
        parsed.data.reviewerAgentId,
        current.executorAgentId,
      );
      const reviewerSkills = skills(database, parsed.data.reviewerAgentId);
      const material = freezeReviewMaterial(database, current, attemptId);
      const execution = database.prepare(`
        SELECT execution_id AS executionId
        FROM work_item_result_versions WHERE id=? AND work_item_id=?
      `).get(current.resultId, current.workItemId) as { executionId: string };
      return {
        current,
        material,
        reviewer,
        reviewerIdentity: reviewerIdentity(reviewer, reviewerSkills),
        reviewerSkills,
        trustedTokens: trustedUsage(
          database,
          current.projectId,
          parsed.data.reviewerAgentId,
          execution.executionId,
        ),
      };
    });

    dependencies.afterSnapshot?.(database);

    let apiKey: string;
    try {
      apiKey = createCredentialVault().decrypt(snapshot.reviewer.providerId, {
        apiKeyCipher: snapshot.reviewer.apiKeyCipher,
        apiKeyIv: snapshot.reviewer.apiKeyIv,
        apiKeyMask: "hidden",
        apiKeyTag: snapshot.reviewer.apiKeyTag,
        credentialVersion: snapshot.reviewer.credentialVersion,
        keyId: snapshot.reviewer.keyId,
      });
    } catch {
      throw new ReviewSliceError("CREDENTIAL_UNAVAILABLE", 503, "复核凭据暂不可用");
    }
    const prompt = buildReviewProviderRequest({
      material: snapshot.material.material,
      reviewer: {
        id: parsed.data.reviewerAgentId,
        role: snapshot.reviewer.reviewerRole,
        skills: snapshot.reviewerSkills,
        systemPrompt: snapshot.reviewer.reviewerSystemPrompt,
      },
    });
    const operationInput: ReviewOperationInput = {
      attemptId,
      credentialGeneration: snapshot.reviewer.credentialGeneration,
      frozenMaterialHash: snapshot.material.hash,
      frozenMaterialJson: snapshot.material.json,
      maxTokens: snapshot.reviewer.maxTokens,
      missionId: snapshot.current.missionId,
      model: snapshot.reviewer.model,
      operationId: parsed.data.operationId,
      parentId: workItemId,
      projectId: snapshot.current.projectId,
      promptHash: canonicalRequestHash(prompt.messages),
      providerId: snapshot.reviewer.providerId,
      providerRequest: {
        apiKey,
        baseUrl: snapshot.reviewer.baseUrl,
        messages: prompt.messages,
        model: snapshot.reviewer.model,
      },
      providerVersion: snapshot.reviewer.providerVersion,
      request: requestTuple,
      resultId: parsed.data.resultId,
      reviewerAgentId: parsed.data.reviewerAgentId,
      trustedTokens: snapshot.trustedTokens,
      validationContext: {
        candidateActor: { agentId: parsed.data.reviewerAgentId, type: "agent" },
        secretValues: [apiKey],
        sources: validationSources(snapshot.material.material),
      },
      verifiedAt: snapshot.reviewer.verifiedAt,
      workItemId,
    };
    return await runReviewOperation(database, operationInput, {
      ...dependencies,
      acquireContext: (acquireDatabase) => {
        const current = readHead(acquireDatabase, workItemId);
        const reviewer = readReviewer(
          acquireDatabase,
          current.projectId,
          parsed.data.reviewerAgentId,
          current.executorAgentId,
        );
        const reviewerSkills = skills(acquireDatabase, parsed.data.reviewerAgentId);
        const material = freezeReviewMaterial(acquireDatabase, current, attemptId);
        if (
          current.state !== "pending_review"
          || current.headVersion !== snapshot.current.headVersion
          || current.resultId !== snapshot.current.resultId
          || material.hash !== snapshot.material.hash
          || reviewerIdentity(reviewer, reviewerSkills) !== snapshot.reviewerIdentity
        ) {
          throw new ReviewOrchestratorError(
            "REVIEW_CONTEXT_STALE",
            409,
            "复核上下文已变化，请基于最新内容重试",
          );
        }
        const acquired = acquireDatabase.prepare(`
          UPDATE work_item_review_heads
          SET state='reviewing',current_attempt_id=?,version=version+1,updated_at=?
          WHERE work_item_id=? AND state='pending_review' AND current_attempt_id IS NULL
            AND current_result_id=? AND version=?
        `).run(
          attemptId,
          (dependencies.clock?.() ?? new Date()).toISOString(),
          workItemId,
          snapshot.current.resultId,
          snapshot.current.headVersion,
        );
        if (acquired.changes !== 1) {
          throw new ReviewOrchestratorError(
            "REVIEW_CONTEXT_STALE",
            409,
            "复核上下文已变化，请基于最新内容重试",
          );
        }
        return current.headVersion + 1;
      },
    });
  } finally {
    database.close();
  }
}
