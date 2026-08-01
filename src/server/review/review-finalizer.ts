import { createHash, randomUUID as nodeRandomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { ValidatedReviewOutput } from "@/src/server/review/review-schema";
import {
  reviewOperationResponseSchema,
  type ReviewOperationResponse,
} from "@/src/shared/review-contracts";

export type ReviewFinalizeStep =
  | "decision"
  | "memory-candidates"
  | "head"
  | "board"
  | "events"
  | "attempt"
  | "receipt";

export type ReviewFinalizeDependencies = {
  beforeStep?: (step: ReviewFinalizeStep) => void;
  clock?: () => Date;
  randomUUID?: () => string;
};

export class ReviewFinalizeError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ReviewFinalizeError";
  }
}

type AttemptRow = {
  attemptId: string;
  missionId: string;
  operationId: string;
  outputHash: string | null;
  outputJson: string | null;
  projectId: string;
  resultId: string;
  reviewerAgentId: string;
  status: string;
  workItemId: string;
};

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function attempt(database: DatabaseSync, attemptId: string): AttemptRow | undefined {
  return database.prepare(`
    SELECT id AS attemptId,project_id AS projectId,mission_id AS missionId,
           work_item_id AS workItemId,result_id AS resultId,
           reviewer_agent_id AS reviewerAgentId,operation_id AS operationId,
           status,parsed_output_json AS outputJson,
           parsed_output_hash AS outputHash
    FROM review_attempts WHERE id=?
  `).get(attemptId) as AttemptRow | undefined;
}

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
      // Preserve the business-finalize failure.
    }
    throw error;
  }
}

function terminalReplay(
  database: DatabaseSync,
  row: AttemptRow,
  checkpointHash: string,
): ReviewOperationResponse | null {
  if (row.outputHash !== checkpointHash) {
    throw new ReviewFinalizeError(
      "REVIEW_CHECKPOINT_CONFLICT",
      409,
      "Review checkpoint hash changed.",
    );
  }
  if (!["rejected", "passed"].includes(row.status)) return null;
  const operation = database.prepare(`
    SELECT status,response_json AS responseJson
    FROM review_operations WHERE project_id=? AND id=?
  `).get(row.projectId, row.operationId) as {
    responseJson: string | null;
    status: string;
  } | undefined;
  if (operation?.status !== "completed" || !operation.responseJson) {
    throw new ReviewFinalizeError(
      "REVIEW_FINALIZE_INVARIANT",
      500,
      "Terminal review has no completed operation receipt.",
    );
  }
  return reviewOperationResponseSchema.parse(JSON.parse(operation.responseJson));
}

function appendEvent(
  database: DatabaseSync,
  row: AttemptRow,
  type: string,
  payload: Record<string, unknown>,
  id: string,
  now: string,
): void {
  const head = database.prepare(`
    SELECT next_event_sequence AS sequence FROM mission_delivery_heads
    WHERE mission_id=? AND project_id=?
  `).get(row.missionId, row.projectId) as { sequence: number } | undefined;
  if (!head) {
    throw new ReviewFinalizeError(
      "REVIEW_STATE_CONFLICT",
      409,
      "Mission review event head is missing.",
    );
  }
  database.prepare(`
    INSERT INTO review_events(
      id,project_id,mission_id,sequence,type,actor_type,actor_id,payload_json,created_at
    ) VALUES (?, ?, ?, ?, ?, 'agent', ?, ?, ?)
  `).run(
    id,
    row.projectId,
    row.missionId,
    head.sequence,
    type,
    row.reviewerAgentId,
    JSON.stringify(payload),
    now,
  );
  const advanced = database.prepare(`
    UPDATE mission_delivery_heads
    SET next_event_sequence=next_event_sequence+1,updated_at=?
    WHERE mission_id=? AND project_id=? AND next_event_sequence=?
  `).run(now, row.missionId, row.projectId, head.sequence);
  if (advanced.changes !== 1) {
    throw new ReviewFinalizeError(
      "REVIEW_STATE_CONFLICT",
      409,
      "Review event sequence CAS was lost.",
    );
  }
}

function parseCheckpoint(row: AttemptRow, checkpointHash: string): ValidatedReviewOutput {
  if (
    row.status !== "finalizing"
    || !row.outputJson
    || row.outputHash !== checkpointHash
    || sha256(row.outputJson) !== checkpointHash
  ) {
    throw new ReviewFinalizeError(
      "REVIEW_CHECKPOINT_CONFLICT",
      409,
      "Review is not at the requested durable checkpoint.",
    );
  }
  let output: ValidatedReviewOutput;
  try {
    output = JSON.parse(row.outputJson) as ValidatedReviewOutput;
  } catch {
    throw new ReviewFinalizeError(
      "REVIEW_CHECKPOINT_INVALID",
      500,
      "Durable review checkpoint is invalid.",
    );
  }
  if (!["reject", "escalate", "pass"].includes(output.decision?.choice)) {
    throw new ReviewFinalizeError(
      "REVIEW_CHECKPOINT_INVALID",
      500,
      "Durable review checkpoint has an invalid decision.",
    );
  }
  if (output.decision.choice === "escalate") {
    throw new ReviewFinalizeError(
      "REVIEW_ESCALATION_NOT_IMPLEMENTED",
      409,
      "Escalation finalization is reserved for T-10.",
    );
  }
  return output;
}

function assertCurrentIdentity(database: DatabaseSync, row: AttemptRow): number {
  const current = database.prepare(`
    SELECT h.version,h.state,h.current_result_id AS resultId,
           h.current_attempt_id AS attemptId,r.executor_agent_id AS executorAgentId,
           m.state AS missionState,
           EXISTS(
             SELECT 1 FROM project_memberships membership
             JOIN agents agent ON agent.id=membership.agent_id
             WHERE membership.project_id=h.project_id
               AND membership.agent_id=? AND agent.review_capable=1
           ) AS reviewerQualified
    FROM work_item_review_heads h
    JOIN work_item_result_versions r
      ON r.work_item_id=h.work_item_id AND r.id=h.current_result_id
    JOIN mission_delivery_heads m
      ON m.mission_id=h.mission_id AND m.project_id=h.project_id
    WHERE h.work_item_id=? AND h.project_id=? AND h.mission_id=?
  `).get(
    row.reviewerAgentId,
    row.workItemId,
    row.projectId,
    row.missionId,
  ) as {
    attemptId: string | null;
    executorAgentId: string;
    missionState: string;
    resultId: string;
    reviewerQualified: number;
    state: string;
    version: number;
  } | undefined;
  if (
    !current
    || current.state !== "reviewing"
    || current.attemptId !== row.attemptId
    || current.resultId !== row.resultId
    || current.reviewerQualified !== 1
    || current.executorAgentId === row.reviewerAgentId
    || current.missionState === "owner_terminated"
  ) {
    throw new ReviewFinalizeError(
      "REVIEW_STATE_CONFLICT",
      409,
      "Review head, result, reviewer, or mission changed before finalize.",
    );
  }
  return current.version;
}

export function finalizeCheckpointedReview(
  database: DatabaseSync,
  input: { attemptId: string; checkpointHash: string },
  dependencies: ReviewFinalizeDependencies = {},
): ReviewOperationResponse {
  const initial = attempt(database, input.attemptId);
  if (!initial) {
    throw new ReviewFinalizeError("REVIEW_ATTEMPT_NOT_FOUND", 404, "Review attempt was not found.");
  }
  const replay = terminalReplay(database, initial, input.checkpointHash);
  if (replay) return replay;
  const output = parseCheckpoint(initial, input.checkpointHash);
  const clock = dependencies.clock ?? (() => new Date());
  const randomUUID = dependencies.randomUUID ?? nodeRandomUUID;
  const before = dependencies.beforeStep ?? (() => undefined);

  return transaction(database, () => {
    const row = attempt(database, input.attemptId);
    if (!row) {
      throw new ReviewFinalizeError(
        "REVIEW_ATTEMPT_NOT_FOUND",
        404,
        "Review attempt was not found.",
      );
    }
    const won = terminalReplay(database, row, input.checkpointHash);
    if (won) return won;
    parseCheckpoint(row, input.checkpointHash);
    const headVersion = assertCurrentIdentity(database, row);
    const now = clock().toISOString();
    const decisionId = randomUUID();
    const terminalStatus = output.decision.choice === "reject" ? "rejected" : "passed";

    before("decision");
    database.prepare(`
      INSERT INTO review_decisions(
        id,attempt_id,result_id,reviewer_agent_id,choice,public_summary,
        findings_json,evidence_refs_json,limitations_json,created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      decisionId,
      row.attemptId,
      row.resultId,
      row.reviewerAgentId,
      output.decision.choice,
      output.publicSummary,
      JSON.stringify(output.findings),
      JSON.stringify(output.evidenceRefs),
      JSON.stringify(output.limitations),
      now,
    );

    before("memory-candidates");
    if (output.decision.choice === "pass") {
      output.memoryCandidates.forEach((candidate, position) => {
        database.prepare(`
          INSERT INTO review_memory_candidates(
            id,attempt_id,position,type,content,source_type,source_id,
            source_version,supersedes_memory_id,created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          randomUUID(),
          row.attemptId,
          position,
          candidate.type,
          candidate.content.trim(),
          candidate.source.type,
          candidate.source.id,
          candidate.source.version,
          candidate.supersedesMemoryId,
          now,
        );
      });
    }

    before("head");
    const head = database.prepare(`
      UPDATE work_item_review_heads
      SET state=?,current_attempt_id=?,version=version+1,updated_at=?
      WHERE work_item_id=? AND project_id=? AND mission_id=?
        AND current_result_id=? AND current_attempt_id=?
        AND state='reviewing' AND version=?
    `).run(
      output.decision.choice === "reject" ? "rework" : "passed",
      output.decision.choice === "reject" ? null : row.attemptId,
      now,
      row.workItemId,
      row.projectId,
      row.missionId,
      row.resultId,
      row.attemptId,
      headVersion,
    );
    if (head.changes !== 1) {
      throw new ReviewFinalizeError(
        "REVIEW_STATE_CONFLICT",
        409,
        "Review head finalize CAS was lost.",
      );
    }

    before("board");
    if (output.decision.choice === "pass") {
      const board = database.prepare(`
        UPDATE work_items SET status='done',version=version+1,updated_at=?
        WHERE id=? AND mission_id=? AND status='in_progress'
      `).run(now, row.workItemId, row.missionId);
      if (board.changes !== 1) {
        throw new ReviewFinalizeError(
          "REVIEW_STATE_CONFLICT",
          409,
          "Work item completion projection changed.",
        );
      }
    } else {
      const board = database.prepare(
        "SELECT status FROM work_items WHERE id=? AND mission_id=?",
      ).get(row.workItemId, row.missionId) as { status: string } | undefined;
      if (board?.status !== "in_progress") {
        throw new ReviewFinalizeError(
          "REVIEW_STATE_CONFLICT",
          409,
          "Rejected work item is not in progress.",
        );
      }
    }

    before("events");
    appendEvent(database, row, "review_decided", {
      attemptId: row.attemptId,
      choice: output.decision.choice,
      decisionId,
      resultId: row.resultId,
    }, randomUUID(), now);
    appendEvent(
      database,
      row,
      output.decision.choice === "reject" ? "rework_requested" : "work_item_passed",
      {
        decisionId,
        resultId: row.resultId,
        workItemId: row.workItemId,
      },
      randomUUID(),
      now,
    );

    before("attempt");
    const finalized = database.prepare(`
      UPDATE review_attempts
      SET status=?,finalize_error_code=NULL,finished_at=?
      WHERE id=? AND status='finalizing' AND parsed_output_hash=?
    `).run(terminalStatus, now, row.attemptId, input.checkpointHash);
    if (finalized.changes !== 1) {
      throw new ReviewFinalizeError(
        "REVIEW_STATE_CONFLICT",
        409,
        "Review attempt finalize CAS was lost.",
      );
    }

    const response = reviewOperationResponseSchema.parse({
      attemptId: row.attemptId,
      checkpointHash: input.checkpointHash,
      decisionId,
      retry: { kind: "none", providerCallRequired: false },
      state: terminalStatus,
    });
    before("receipt");
    const receipt = database.prepare(`
      UPDATE review_operations
      SET status='completed',http_status=200,response_json=?,updated_at=?
      WHERE project_id=? AND id=? AND status='pending'
    `).run(
      JSON.stringify(response),
      now,
      row.projectId,
      row.operationId,
    );
    if (receipt.changes !== 1) {
      throw new ReviewFinalizeError(
        "REVIEW_STATE_CONFLICT",
        409,
        "Review operation receipt CAS was lost.",
      );
    }
    return response;
  });
}
