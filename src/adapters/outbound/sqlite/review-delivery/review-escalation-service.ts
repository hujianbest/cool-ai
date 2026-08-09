import { createHash, randomUUID as nodeRandomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type EscalationAction = "continue_review" | "rework" | "terminate_mission";

export type AnswerEscalationInput = {
  action: EscalationAction;
  answer: string;
  expectedHeadVersion: number;
  operationId: string;
};

export type AnswerEscalationResponse = {
  action: EscalationAction;
  answer: string;
  answerId: string;
  escalationId: string;
  next: "new_review_attempt" | "new_execution_result" | "mission_terminated";
  resultId: string;
  state: "pending_review" | "rework" | "owner_terminated";
  workItemId: string;
};

export type AnswerEscalationDependencies = {
  actorType?: "owner" | "agent";
  clock?: () => Date;
  randomUUID?: () => string;
};

export class ReviewEscalationError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ReviewEscalationError";
  }
}

type EscalationRow = {
  answer: string | null;
  answerAction: EscalationAction | null;
  answerId: string | null;
  answerOperationId: string | null;
  headVersion: number;
  missionId: string;
  projectId: string;
  resultId: string;
  state: string;
  workItemId: string;
};

function requestHash(escalationId: string, input: AnswerEscalationInput): string {
  return createHash("sha256").update(JSON.stringify({
    kind: "answer_escalation",
    escalationId,
    action: input.action,
    answer: input.answer.trim(),
    expectedHeadVersion: input.expectedHeadVersion,
  })).digest("hex");
}

function escalation(database: DatabaseSync, escalationId: string): EscalationRow {
  const row = database.prepare(`
    SELECT e.work_item_id AS workItemId,e.result_id AS resultId,
           a.project_id AS projectId,a.mission_id AS missionId,
           h.state,h.version AS headVersion,
           answer.id AS answerId,answer.operation_id AS answerOperationId,
           answer.answer,answer.action AS answerAction
    FROM review_escalations e
    JOIN review_decisions d ON d.id=e.decision_id
    JOIN review_attempts a ON a.id=d.attempt_id
    JOIN work_item_review_heads h ON h.work_item_id=e.work_item_id
    LEFT JOIN review_escalation_answers answer ON answer.escalation_id=e.id
    WHERE e.id=?
  `).get(escalationId) as EscalationRow | undefined;
  if (!row) {
    throw new ReviewEscalationError("ESCALATION_NOT_FOUND", 404, "Escalation issue was not found.");
  }
  return row;
}

function responseFor(
  escalationId: string,
  row: Pick<EscalationRow, "answer" | "answerAction" | "answerId" | "resultId" | "workItemId">,
): AnswerEscalationResponse {
  if (!row.answer || !row.answerAction || !row.answerId) {
    throw new ReviewEscalationError(
      "ESCALATION_ANSWER_INVARIANT",
      500,
      "Escalation answer is incomplete.",
    );
  }
  if (row.answerAction === "continue_review") {
    return {
      action: row.answerAction,
      answer: row.answer,
      answerId: row.answerId,
      escalationId,
      next: "new_review_attempt",
      resultId: row.resultId,
      state: "pending_review",
      workItemId: row.workItemId,
    };
  }
  if (row.answerAction === "rework") {
    return {
      action: row.answerAction,
      answer: row.answer,
      answerId: row.answerId,
      escalationId,
      next: "new_execution_result",
      resultId: row.resultId,
      state: "rework",
      workItemId: row.workItemId,
    };
  }
  return {
    action: row.answerAction,
    answer: row.answer,
    answerId: row.answerId,
    escalationId,
    next: "mission_terminated",
    resultId: row.resultId,
    state: "owner_terminated",
    workItemId: row.workItemId,
  };
}

function appendEvent(
  database: DatabaseSync,
  row: EscalationRow,
  type: string,
  payload: Record<string, unknown>,
  id: string,
  now: string,
): void {
  const eventHead = database.prepare(`
    SELECT next_event_sequence AS sequence FROM mission_delivery_heads
    WHERE mission_id=? AND project_id=?
  `).get(row.missionId, row.projectId) as { sequence: number } | undefined;
  if (!eventHead) {
    throw new ReviewEscalationError("REVIEW_STATE_CONFLICT", 409, "Mission head is missing.");
  }
  database.prepare(`
    INSERT INTO review_events(
      id,project_id,mission_id,sequence,type,actor_type,actor_id,payload_json,created_at
    ) VALUES (?, ?, ?, ?, ?, 'owner', NULL, ?, ?)
  `).run(
    id,
    row.projectId,
    row.missionId,
    eventHead.sequence,
    type,
    JSON.stringify(payload),
    now,
  );
  const advanced = database.prepare(`
    UPDATE mission_delivery_heads SET next_event_sequence=next_event_sequence+1,updated_at=?
    WHERE mission_id=? AND project_id=? AND next_event_sequence=?
  `).run(now, row.missionId, row.projectId, eventHead.sequence);
  if (advanced.changes !== 1) {
    throw new ReviewEscalationError("REVIEW_STATE_CONFLICT", 409, "Event sequence changed.");
  }
}

export function answerEscalation(
  database: DatabaseSync,
  escalationId: string,
  input: AnswerEscalationInput,
  dependencies: AnswerEscalationDependencies = {},
): AnswerEscalationResponse {
  if ((dependencies.actorType ?? "owner") !== "owner") {
    throw new ReviewEscalationError("OWNER_REQUIRED", 403, "Only the Owner may answer.");
  }
  const answer = input.answer.trim();
  if (
    answer.length === 0
    || Array.from(answer).length > 5_000
    || !["continue_review", "rework", "terminate_mission"].includes(input.action)
    || !Number.isInteger(input.expectedHeadVersion)
    || input.expectedHeadVersion < 1
  ) {
    throw new ReviewEscalationError("INVALID_INPUT", 400, "Escalation answer is invalid.");
  }
  const clock = dependencies.clock ?? (() => new Date());
  const randomUUID = dependencies.randomUUID ?? nodeRandomUUID;
  const now = clock().toISOString();

  database.exec("BEGIN IMMEDIATE");
  try {
    const row = escalation(database, escalationId);
    const operation = database.prepare(`
      SELECT request_hash AS requestHash,status,response_json AS responseJson
      FROM review_operations WHERE project_id=? AND id=?
    `).get(row.projectId, input.operationId) as {
      requestHash: string;
      responseJson: string | null;
      status: string;
    } | undefined;
    const hash = requestHash(escalationId, { ...input, answer });
    if (operation) {
      if (operation.requestHash !== hash) {
        throw new ReviewEscalationError("OPERATION_CONFLICT", 409, "Operation body changed.");
      }
      if (operation.status === "completed" && operation.responseJson) {
        const replay = JSON.parse(operation.responseJson) as AnswerEscalationResponse;
        database.exec("COMMIT");
        return replay;
      }
      throw new ReviewEscalationError("OPERATION_IN_PROGRESS", 409, "Operation is in progress.");
    }
    if (row.answerId) {
      const existing = responseFor(escalationId, row);
      database.exec("COMMIT");
      return existing;
    }
    if (
      row.state !== "waiting_owner"
      || row.headVersion !== input.expectedHeadVersion
    ) {
      throw new ReviewEscalationError("REVIEW_STATE_CONFLICT", 409, "Escalation head changed.");
    }
    database.prepare(`
      INSERT INTO review_operations(
        id,project_id,kind,parent_id,request_hash,status,http_status,response_json,
        created_at,updated_at
      ) VALUES (?,?,'answer_escalation',?,?,'pending',NULL,NULL,?,?)
    `).run(input.operationId, row.projectId, escalationId, hash, now, now);
    const answerId = randomUUID();
    database.prepare(`
      INSERT INTO review_escalation_answers(
        id,escalation_id,operation_id,answer,action,created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(answerId, escalationId, input.operationId, answer, input.action, now);

    const nextHeadState = input.action === "continue_review" ? "pending_review" : "rework";
    if (input.action !== "terminate_mission") {
      const updated = database.prepare(`
        UPDATE work_item_review_heads
        SET state=?,current_attempt_id=NULL,version=version+1,updated_at=?
        WHERE work_item_id=? AND current_result_id=? AND state='waiting_owner'
          AND current_attempt_id IS NULL AND version=?
      `).run(
        nextHeadState,
        now,
        row.workItemId,
        row.resultId,
        input.expectedHeadVersion,
      );
      if (updated.changes !== 1) {
        throw new ReviewEscalationError("REVIEW_STATE_CONFLICT", 409, "Escalation answer CAS was lost.");
      }
    } else {
      const terminated = database.prepare(`
        UPDATE mission_delivery_heads
        SET state='owner_terminated',current_delivery_id=NULL,current_operation_id=NULL,
            generation_lease_token=NULL,generation_lease_expires_at=NULL,
            last_error_code=NULL,version=version+1,updated_at=?
        WHERE mission_id=? AND project_id=? AND state<>'owner_terminated'
      `).run(now, row.missionId, row.projectId);
      if (terminated.changes !== 1) {
        throw new ReviewEscalationError("REVIEW_STATE_CONFLICT", 409, "Mission cannot be terminated.");
      }
    }
    appendEvent(database, row, "escalation_answered", {
      action: input.action,
      answerId,
      escalationId,
    }, randomUUID(), now);
    if (input.action === "terminate_mission") {
      appendEvent(database, row, "mission_terminated", {
        reason: "owner_terminated",
      }, randomUUID(), now);
    }
    const response = responseFor(escalationId, {
      answer,
      answerAction: input.action,
      answerId,
      resultId: row.resultId,
      workItemId: row.workItemId,
    });
    database.prepare(`
      UPDATE review_operations
      SET status='completed',http_status=200,response_json=?,updated_at=?
      WHERE project_id=? AND id=? AND status='pending'
    `).run(JSON.stringify(response), now, row.projectId, input.operationId);
    database.exec("COMMIT");
    return response;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the original error.
    }
    throw error;
  }
}
