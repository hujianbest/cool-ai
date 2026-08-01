import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { canonicalRequestHash } from "@/src/server/collaboration/operation-receipts";
import { openDatabase } from "@/src/server/db";
import {
  acquireDeliveryGeneration,
  buildDeliveryBundle,
  DeliveryGenerationError,
  finalizeDeliveryGeneration,
  type DeliveryBuildInput,
  type DeliveryContentStatus,
} from "@/src/server/review/delivery-service";
import { readMissionDelivery } from "@/src/server/review/delivery-read-service";
import { ReviewApiError } from "@/src/server/review/review-errors";
import {
  generateDeliveryInputSchema,
  type DeliveryVersionDto,
  type GenerateDeliveryInput,
  type MissionCompletionDto,
} from "@/src/shared/review-contracts";

type Dependencies = {
  afterSnapshot?: (database: DatabaseSync) => void;
  clock?: () => Date;
  fault?: (point: "before_insert" | "after_insert" | "before_head_cas") => void;
  randomUUID?: () => string;
};

export type GeneratePublicDeliveryResponse = {
  delivery: DeliveryVersionDto;
  missionCompletion: MissionCompletionDto;
};

type Snapshot = {
  buildInput: DeliveryBuildInput;
  fingerprint: string;
  projectId: string;
};

function href(path: string, version: string | number): string {
  return `${path}?version=${encodeURIComponent(String(version))}`;
}

function publicTuple(
  missionId: string,
  input: GenerateDeliveryInput,
): readonly [string, string, number] {
  return ["delivery.v1", missionId, input.expectedHeadVersion];
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function jsonArray(value: unknown): unknown[] {
  try {
    const parsed = JSON.parse(String(value)) as unknown;
    if (!Array.isArray(parsed)) throw new Error("shape");
    return parsed;
  } catch {
    throw new ReviewApiError("DELIVERY_INVARIANT_FAILED");
  }
}

function contentStatus(truncated: unknown, bytes: unknown): DeliveryContentStatus {
  if (Number(truncated) === 1) return "truncated";
  return Number(bytes) >= 0 ? "complete" : "unreadable";
}

function buildInput(database: DatabaseSync, missionId: string): {
  input: DeliveryBuildInput;
  projectId: string;
} {
  const mission = database.prepare(`
    SELECT mission.id,mission.project_id AS projectId,mission.title,mission.goal,
           mission.version,head.context_version AS contextVersion
    FROM missions mission
    JOIN mission_delivery_heads head
      ON head.mission_id=mission.id AND head.project_id=mission.project_id
    WHERE mission.id=?
  `).get(missionId) as Record<string, unknown> | undefined;
  if (!mission) throw new ReviewApiError("PROJECT_NOT_FOUND");

  const tasks = database.prepare(`
    SELECT item.id AS workItemId,item.title,item.version AS workItemVersion,
           result.id AS resultId,result.version AS resultVersion,
           result.execution_id AS executionId,result.staged_result_id AS stagedResultId,
           result.executor_agent_id AS executorAgentId,
           staged.staged_hash AS stagedHash,staged.merge_file_count AS mergeFileCount,
           staged.merge_final_bytes AS mergeFinalBytes,
           attempt.id AS attemptId,attempt.reviewer_agent_id AS reviewerAgentId,
           attempt.parsed_output_hash AS checkpointHash,
           decision.id AS decisionId,decision.public_summary AS publicSummary,
           decision.limitations_json AS limitationsJson,
           decision.evidence_refs_json AS evidenceRefsJson,
           executor.name AS executorName,reviewer.name AS reviewerName
    FROM work_items item
    JOIN work_item_review_heads head ON head.work_item_id=item.id
    JOIN work_item_result_versions result
      ON result.id=head.current_result_id AND result.work_item_id=item.id
    JOIN execution_staged_results staged ON staged.id=result.staged_result_id
    JOIN review_attempts attempt ON attempt.id=head.current_attempt_id
    JOIN review_decisions decision ON decision.attempt_id=attempt.id AND decision.choice='pass'
    JOIN agents executor ON executor.id=result.executor_agent_id
    JOIN agents reviewer ON reviewer.id=attempt.reviewer_agent_id
    WHERE item.mission_id=? AND item.status='done' AND head.state='passed'
    ORDER BY item.created_at,item.id
  `).all(missionId) as Array<Record<string, unknown>>;

  const total = database.prepare(
    "SELECT count(*) AS count FROM work_items WHERE mission_id=?",
  ).get(missionId) as { count: number };
  if (tasks.length === 0 || tasks.length !== Number(total.count)) {
    throw new ReviewApiError("MISSION_COMPLETION_BLOCKED");
  }

  const assembled: DeliveryBuildInput["tasks"] = tasks.map((task) => {
    const evidenceReferences = jsonArray(task.evidenceRefsJson) as Array<Record<string, unknown>>;
    const referenced = new Set(evidenceReferences.map((ref) =>
      `${String(ref.type)}:${String(ref.id)}:${String(ref.version)}`));
    const evidence: DeliveryBuildInput["tasks"][number]["evidence"] = [
      {
        contentStatus: "complete",
        href: href(`/api/work-items/${task.workItemId}/review`, String(task.resultVersion)),
        id: String(task.resultId),
        kind: "result",
        sha256: String(task.stagedHash),
        version: String(task.resultVersion),
      },
      {
        contentStatus: "complete",
        href: href(`/api/reviews/${task.attemptId}`, String(task.checkpointHash)),
        id: String(task.attemptId),
        kind: "review",
        sha256: String(task.checkpointHash),
        version: String(task.checkpointHash),
      },
      {
        contentStatus: "complete",
        href: href(
          `/api/executions/${task.executionId}/staged/${task.stagedResultId}/observations`,
          String(task.stagedHash),
        ),
        id: String(task.stagedResultId),
        kind: "diff",
        sha256: String(task.stagedHash),
        version: String(task.stagedHash),
      },
    ];

    const validations = database.prepare(`
      SELECT id,required,succeeded,exit_code AS exitCode,
             sandbox_manifest_hash AS version,stdout_bytes AS stdoutBytes,
             stderr_bytes AS stderrBytes,stdout_truncated AS stdoutTruncated,
             stderr_truncated AS stderrTruncated
      FROM execution_validation_results WHERE execution_id=?
      ORDER BY finished_at,id
    `).all(String(task.executionId)) as Array<Record<string, unknown>>;
    for (const validation of validations) {
      const status = Number(validation.stdoutTruncated) === 1
        || Number(validation.stderrTruncated) === 1
        ? "truncated"
        : contentStatus(
            0,
            Number(validation.stdoutBytes) + Number(validation.stderrBytes),
          );
      evidence.push({
        contentStatus: status,
        href: href(
          `/api/executions/${task.executionId}/validations/${validation.id}`,
          String(validation.version),
        ),
        id: String(validation.id),
        kind: "validation",
        policyRequired: Number(validation.required) === 1,
        sha256: sha256([
          validation.id,
          validation.version,
          validation.stdoutBytes,
          validation.stderrBytes,
        ].join(":")),
        succeeded: Number(validation.succeeded) === 1 && Number(validation.exitCode) === 0,
        version: String(validation.version),
      });
    }

    const artifacts = database.prepare(`
      SELECT id,sha256,truncated,content_bytes AS contentBytes
      FROM execution_artifacts WHERE execution_id=? ORDER BY created_at,id
    `).all(String(task.executionId)) as Array<Record<string, unknown>>;
    for (const artifact of artifacts) {
      const version = String(artifact.sha256);
      evidence.push({
        contentStatus: contentStatus(artifact.truncated, artifact.contentBytes),
        href: href(
          `/api/executions/${task.executionId}/artifacts/${artifact.id}`,
          version,
        ),
        id: String(artifact.id),
        kind: "artifact",
        referencedByDecisionOrMemory: referenced.has(`artifact:${artifact.id}:${version}`),
        sha256: version,
        version,
      });
    }

    const memories = database.prepare(`
      SELECT memory.id,memory.version,memory.dedupe_hash AS sha256,
             CASE WHEN child.id IS NULL THEN 1 ELSE 0 END AS associationCurrent
      FROM review_memory_associations association
      JOIN review_memory_candidates candidate ON candidate.id=association.candidate_id
      JOIN memory_entries memory ON memory.id=association.memory_id
      LEFT JOIN memory_entries child ON child.supersedes_id=memory.id
      WHERE association.decision_id=?
      ORDER BY memory.type,memory.chain_id,memory.version,memory.id
    `).all(String(task.decisionId)) as Array<Record<string, unknown>>;
    for (const memory of memories) {
      evidence.push({
        associationCurrent: Number(memory.associationCurrent) === 1,
        href: href(`/api/projects/${mission.projectId}/memories`, String(memory.version)),
        id: String(memory.id),
        kind: "memory",
        sha256: String(memory.sha256),
        version: String(memory.version),
      });
    }

    return {
      decision: {
        choice: "pass",
        id: String(task.decisionId),
        limitations: jsonArray(task.limitationsJson).map(String),
        publicSummary: String(task.publicSummary),
      },
      evidence,
      execution: {
        id: String(task.executionId),
        mergeFileCount: Number(task.mergeFileCount),
        mergeFinalBytes: Number(task.mergeFinalBytes),
        stagedHash: String(task.stagedHash),
      },
      executor: { agentId: String(task.executorAgentId), name: String(task.executorName) },
      result: { id: String(task.resultId), version: Number(task.resultVersion) },
      review: {
        attemptId: String(task.attemptId),
        reviewerAgentId: String(task.reviewerAgentId),
      },
      reviewer: { agentId: String(task.reviewerAgentId), name: String(task.reviewerName) },
      workItem: {
        id: String(task.workItemId),
        title: String(task.title),
        version: Number(task.workItemVersion),
      },
    };
  });

  return {
    input: {
      mission: {
        contextVersion: Number(mission.contextVersion),
        goal: String(mission.goal),
        id: String(mission.id),
        title: String(mission.title),
        version: Number(mission.version),
      },
      schemaVersion: 1,
      tasks: assembled,
    },
    projectId: String(mission.projectId),
  };
}

function snapshot(database: DatabaseSync, missionId: string, completedAt: string): Snapshot {
  const assembled = buildInput(database, missionId);
  return {
    buildInput: assembled.input,
    fingerprint: buildDeliveryBundle(assembled.input, completedAt).inputFingerprint,
    projectId: assembled.projectId,
  };
}

function replay(
  database: DatabaseSync,
  databasePath: string,
  missionId: string,
  projectId: string,
  operationId: string,
  requestHash: string,
): GeneratePublicDeliveryResponse | null {
  const row = database.prepare(`
    SELECT kind,request_hash AS requestHash,status,response_json AS responseJson
    FROM review_operations WHERE project_id=? AND id=?
  `).get(projectId, operationId) as Record<string, unknown> | undefined;
  if (!row) return null;
  if (row.kind !== "generate_delivery" || row.requestHash !== requestHash) {
    throw new ReviewApiError("OPERATION_CONFLICT");
  }
  if (row.status === "completed" && row.responseJson) {
    try {
      const response = JSON.parse(String(row.responseJson)) as GeneratePublicDeliveryResponse;
      if (response.delivery && response.missionCompletion) return response;
      const missionCompletion = readMissionDelivery(databasePath, missionId);
      if (missionCompletion.currentDelivery) {
        const reconstructed = {
          delivery: missionCompletion.currentDelivery,
          missionCompletion,
        };
        database.prepare(`
          UPDATE review_operations SET response_json=?
          WHERE project_id=? AND id=? AND kind='generate_delivery'
            AND request_hash=? AND status='completed'
        `).run(JSON.stringify(reconstructed), projectId, operationId, requestHash);
        return reconstructed;
      }
    } catch {
      throw new ReviewApiError("DELIVERY_INVARIANT_FAILED");
    }
  }
  return null;
}

export async function generatePublicDelivery(
  databasePath: string,
  missionId: string,
  unsafeInput: unknown,
  dependencies: Dependencies = {},
): Promise<GeneratePublicDeliveryResponse> {
  const parsed = generateDeliveryInputSchema.safeParse(unsafeInput);
  if (!parsed.success) throw new ReviewApiError("INVALID_INPUT");
  const clock = dependencies.clock ?? (() => new Date());
  const completedAt = clock().toISOString();
  const database = openDatabase(databasePath);
  try {
    const mission = database.prepare(
      "SELECT project_id AS projectId FROM missions WHERE id=?",
    ).get(missionId) as { projectId: string } | undefined;
    if (!mission) throw new ReviewApiError("PROJECT_NOT_FOUND");
    const requestHash = canonicalRequestHash(publicTuple(missionId, parsed.data));
    const existing = replay(
      database,
      databasePath,
      missionId,
      mission.projectId,
      parsed.data.operationId,
      requestHash,
    );
    if (existing) return existing;

    const frozen = snapshot(database, missionId, completedAt);
    dependencies.afterSnapshot?.(database);
    const acquired = acquireDeliveryGeneration(database, {
      buildInput: frozen.buildInput,
      expectedHeadVersion: parsed.data.expectedHeadVersion,
      missionId,
      operationId: parsed.data.operationId,
      projectId: frozen.projectId,
      requestHash,
    }, {
      clock,
      randomUUID: dependencies.randomUUID,
      verifySnapshot: (acquireDatabase, inputFingerprint) => {
        const current = snapshot(acquireDatabase, missionId, completedAt);
        if (
          current.projectId !== frozen.projectId
          || current.fingerprint !== frozen.fingerprint
          || inputFingerprint !== frozen.fingerprint
        ) {
          throw new DeliveryGenerationError(
            "DELIVERY_CONTEXT_CHANGED",
            409,
            "使命上下文已变化，请基于最新内容重试",
          );
        }
      },
    });
    const finalized = finalizeDeliveryGeneration(database, acquired, {
      clock,
      fault: dependencies.fault,
      randomUUID: dependencies.randomUUID,
    });
    if (finalized.state === "failed") {
      throw new ReviewApiError("DELIVERY_INTERRUPTED");
    }
    const missionCompletion = readMissionDelivery(databasePath, missionId);
    if (!missionCompletion.currentDelivery) {
      throw new ReviewApiError("DELIVERY_INVARIANT_FAILED");
    }
    const response = {
      delivery: missionCompletion.currentDelivery,
      missionCompletion,
    };
    const saved = database.prepare(`
      UPDATE review_operations SET response_json=?,updated_at=?
      WHERE project_id=? AND id=? AND kind='generate_delivery'
        AND request_hash=? AND status='completed'
    `).run(
      JSON.stringify(response),
      clock().toISOString(),
      frozen.projectId,
      parsed.data.operationId,
      requestHash,
    );
    if (saved.changes !== 1) throw new ReviewApiError("DELIVERY_INVARIANT_FAILED");
    return response;
  } catch (error) {
    if (error instanceof DeliveryGenerationError) {
      if (error.code === "DELIVERY_STATE_CONFLICT") {
        throw new ReviewApiError("DELIVERY_CONTEXT_CHANGED");
      }
      if (error.code === "DELIVERY_INPUT_INVALID") {
        throw new ReviewApiError("INVALID_INPUT");
      }
    }
    if (
      error instanceof ReviewApiError
      || error instanceof DeliveryGenerationError
      || (error && typeof error === "object" && "code" in error)
    ) throw error;
    throw new ReviewApiError("DELIVERY_INVARIANT_FAILED");
  } finally {
    database.close();
  }
}
