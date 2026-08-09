import { createHash, randomUUID as nodeRandomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { reviewOutputSchema } from "@/src/shared/review-contracts";

export class ReviewPersistenceInvariantError extends Error {
  readonly code = "REVIEW_INVARIANT_FAILED";
  readonly status = 500;

  constructor(message: string) {
    super(message);
    this.name = "ReviewPersistenceInvariantError";
  }
}

function fail(message: string): never {
  throw new ReviewPersistenceInvariantError(message);
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
      // Preserve the fail-closed domain error.
    }
    throw error;
  }
}

function assertCheckpoint(outputJson: string, outputHash: string): void {
  if (createHash("sha256").update(outputJson, "utf8").digest("hex") !== outputHash) {
    fail("Review checkpoint hash is inconsistent.");
  }
  let value: unknown;
  try {
    value = JSON.parse(outputJson);
  } catch {
    fail("Review checkpoint is malformed.");
  }
  if (value === null || typeof value !== "object") fail("Review checkpoint is malformed.");
  const record = value as Record<string, unknown>;
  const memoryCandidates = Array.isArray(record.memoryCandidates)
    ? record.memoryCandidates.map((candidate) => {
        if (candidate === null || typeof candidate !== "object") return candidate;
        const { actor: _actor, ...publicCandidate } = candidate as Record<string, unknown>;
        return publicCandidate;
      })
    : record.memoryCandidates;
  if (!reviewOutputSchema.safeParse({ ...record, memoryCandidates }).success) {
    fail("Review checkpoint violates the strict output schema.");
  }
}

export function assertReviewPersistenceInvariants(database: DatabaseSync): void {
  const attempts = database.prepare(`
    SELECT a.id,a.status,a.result_id AS resultId,
           a.parsed_output_json AS outputJson,a.parsed_output_hash AS outputHash,
           a.output_checkpointed_at AS checkpointedAt,
           h.state AS headState,h.current_attempt_id AS headAttemptId,
           h.current_result_id AS headResultId,w.status AS workItemStatus,
           count(d.id) AS decisionCount,min(d.choice) AS decisionChoice
    FROM review_attempts a
    LEFT JOIN work_item_review_heads h ON h.work_item_id=a.work_item_id
    LEFT JOIN work_items w ON w.id=a.work_item_id
    LEFT JOIN review_decisions d ON d.attempt_id=a.id
    GROUP BY a.id ORDER BY a.id
  `).all() as Array<{
    checkpointedAt: string | null; decisionChoice: string | null; decisionCount: number;
    headAttemptId: string | null; headResultId: string | null; headState: string | null;
    id: string; outputHash: string | null; outputJson: string | null; resultId: string;
    status: string; workItemStatus: string | null;
  }>;
  for (const row of attempts) {
    const parts = [row.outputJson, row.outputHash, row.checkpointedAt];
    const checkpointed = parts.every((part) => part !== null);
    if (!checkpointed && !parts.every((part) => part === null)) fail(`Attempt ${row.id} has partial checkpoint.`);
    if (["finalizing", "rejected", "escalated", "passed"].includes(row.status) && !checkpointed) {
      fail(`Attempt ${row.id} is missing checkpoint.`);
    }
    if (checkpointed) assertCheckpoint(row.outputJson!, row.outputHash!);
    const choice = row.status === "rejected" ? "reject"
      : row.status === "escalated" ? "escalate"
      : row.status === "passed" ? "pass" : null;
    if (
      (choice !== null && (row.decisionCount !== 1 || row.decisionChoice !== choice))
      || (choice === null && row.decisionCount !== 0)
    ) fail(`Attempt ${row.id} has partial decision rows.`);
    if (
      ["calling", "finalizing"].includes(row.status)
      && (row.headState !== "reviewing" || row.headAttemptId !== row.id || row.headResultId !== row.resultId)
    ) fail(`Attempt ${row.id} is detached from its head.`);
    if (
      row.status === "passed"
      && (row.headState !== "passed" || row.headAttemptId !== row.id
        || row.headResultId !== row.resultId || row.workItemStatus !== "done")
    ) fail(`Attempt ${row.id} has partial pass projection.`);
  }
  if (database.prepare(`
    SELECT h.mission_id FROM mission_delivery_heads h
    LEFT JOIN mission_deliveries d ON d.mission_id=h.mission_id AND d.id=h.current_delivery_id
    WHERE (h.state='completed' AND d.id IS NULL)
       OR (h.state<>'completed' AND h.current_delivery_id IS NOT NULL) LIMIT 1
  `).get()) fail("Mission delivery head is inconsistent.");
  if (database.prepare(`
    SELECT h.mission_id FROM mission_delivery_heads h
    LEFT JOIN (
      SELECT mission_id,count(*) AS count,min(sequence) AS minimum,max(sequence) AS maximum
      FROM review_events GROUP BY mission_id
    ) e ON e.mission_id=h.mission_id
    WHERE coalesce(e.count,0)<>h.next_event_sequence-1
       OR (coalesce(e.count,0)>0 AND (e.minimum<>1 OR e.maximum<>e.count)) LIMIT 1
  `).get()) fail("Review event history is not contiguous.");
}

export function reconcileReviewPersistence(
  database: DatabaseSync,
  dependencies: { clock?: () => Date; randomUUID?: () => string } = {},
): { interruptedAttemptIds: string[] } {
  assertReviewPersistenceInvariants(database);
  const now = (dependencies.clock ?? (() => new Date()))().toISOString();
  const randomUUID = dependencies.randomUUID ?? nodeRandomUUID;
  const expired = database.prepare(`
    SELECT id,project_id AS projectId,mission_id AS missionId,
           work_item_id AS workItemId,operation_id AS operationId
    FROM review_attempts WHERE status='calling' AND lease_expires_at<=? ORDER BY id
  `).all(now) as Array<{
    id: string; missionId: string; operationId: string; projectId: string; workItemId: string;
  }>;
  const interruptedAttemptIds: string[] = [];
  for (const row of expired) {
    const changed = transaction(database, () => {
      const attempt = database.prepare(`
        UPDATE review_attempts SET status='interrupted',error_category='interrupted',finished_at=?
        WHERE id=? AND status='calling' AND lease_expires_at<=?
      `).run(now, row.id, now);
      if (attempt.changes !== 1) return false;
      database.prepare(`
        UPDATE review_model_calls SET status='interrupted',error_category='interrupted',finished_at=?
        WHERE attempt_id=? AND status='calling'
      `).run(now, row.id);
      if (database.prepare(`
        UPDATE work_item_review_heads
        SET state='pending_review',current_attempt_id=NULL,version=version+1,updated_at=?
        WHERE work_item_id=? AND current_attempt_id=? AND state='reviewing'
      `).run(now, row.workItemId, row.id).changes !== 1) fail("Interrupted attempt lost its review head.");
      const response = JSON.stringify({
        attemptId: row.id, errorCategory: "interrupted",
        retry: { attemptId: row.id, kind: "new-provider-attempt", providerCallRequired: true },
        state: "failed",
      });
      if (database.prepare(`
        UPDATE review_operations SET status='completed',http_status=409,response_json=?,updated_at=?
        WHERE project_id=? AND id=? AND status='pending'
      `).run(response, now, row.projectId, row.operationId).changes !== 1) {
        fail("Interrupted attempt lost its receipt.");
      }
      const eventHead = database.prepare(`
        SELECT next_event_sequence AS sequence FROM mission_delivery_heads
        WHERE mission_id=? AND project_id=?
      `).get(row.missionId, row.projectId) as { sequence: number } | undefined;
      if (!eventHead) fail("Interrupted attempt has no event head.");
      database.prepare(`
        INSERT INTO review_events(
          id,project_id,mission_id,sequence,type,actor_type,actor_id,payload_json,created_at
        ) VALUES (?, ?, ?, ?, 'review_attempt_interrupted', 'system', NULL, ?, ?)
      `).run(randomUUID(), row.projectId, row.missionId, eventHead.sequence,
        JSON.stringify({ attemptId: row.id, category: "interrupted" }), now);
      if (database.prepare(`
        UPDATE mission_delivery_heads SET next_event_sequence=next_event_sequence+1,updated_at=?
        WHERE mission_id=? AND project_id=? AND next_event_sequence=?
      `).run(now, row.missionId, row.projectId, eventHead.sequence).changes !== 1) {
        fail("Review event sequence CAS was lost.");
      }
      return true;
    });
    if (changed) interruptedAttemptIds.push(row.id);
  }
  assertReviewPersistenceInvariants(database);
  return { interruptedAttemptIds };
}
