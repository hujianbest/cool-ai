import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  markWorkItemDoneTx,
  markWorkItemInProgressTx,
} from "@/src/adapters/outbound/sqlite/mission-work/work-item-status-effects";
import {
  CompletionGateError,
  type CompletionBlocker,
  type CompletionInvalidationReason,
} from "@/src/modules/review-delivery";

export {
  CompletionGateError,
  type CompletionBlocker,
  type CompletionInvalidationReason,
} from "@/src/modules/review-delivery";

type WorkItemRow = {
  missionId: string;
  projectId: string;
  status: "todo" | "in_progress" | "blocked" | "done";
  version: number;
};

function workItem(database: DatabaseSync, workItemId: string): WorkItemRow | undefined {
  return database.prepare(`
    SELECT w.mission_id AS missionId,m.project_id AS projectId,w.status,w.version
    FROM work_items w JOIN missions m ON m.id=w.mission_id
    WHERE w.id=?
  `).get(workItemId) as WorkItemRow | undefined;
}

function conflict(currentVersion?: number): CompletionGateError {
  return new CompletionGateError(
    "RESOURCE_CONFLICT",
    409,
    "Work item version is stale.",
    undefined,
    currentVersion,
  );
}

function appendEventTx(
  database: DatabaseSync,
  input: {
    missionId: string;
    payload: Record<string, unknown>;
    projectId: string;
    type: string;
  },
): void {
  const head = database.prepare(`
    SELECT next_event_sequence AS sequence FROM mission_delivery_heads
    WHERE mission_id=? AND project_id=?
  `).get(input.missionId, input.projectId) as { sequence: number } | undefined;
  if (!head) {
    throw new CompletionGateError(
      "REVIEW_STATE_CONFLICT",
      409,
      "Mission completion context is not initialized.",
    );
  }
  const now = new Date().toISOString();
  database.prepare(`
    INSERT INTO review_events(
      id,project_id,mission_id,sequence,type,actor_type,actor_id,payload_json,created_at
    ) VALUES (?, ?, ?, ?, ?, 'system', NULL, ?, ?)
  `).run(
    randomUUID(),
    input.projectId,
    input.missionId,
    head.sequence,
    input.type,
    JSON.stringify(input.payload),
    now,
  );
  const advanced = database.prepare(`
    UPDATE mission_delivery_heads
    SET next_event_sequence=next_event_sequence+1,updated_at=?
    WHERE mission_id=? AND project_id=? AND next_event_sequence=?
  `).run(now, input.missionId, input.projectId, head.sequence);
  if (advanced.changes !== 1) {
    throw new CompletionGateError(
      "REVIEW_STATE_CONFLICT",
      409,
      "Mission event sequence changed.",
    );
  }
}

function dependencyBlockers(database: DatabaseSync, workItemId: string): CompletionBlocker[] {
  return (database.prepare(`
    SELECT d.depends_on_id AS workItemId
    FROM work_item_dependencies d
    JOIN work_items prerequisite ON prerequisite.id=d.depends_on_id
    LEFT JOIN work_item_review_heads h ON h.work_item_id=prerequisite.id
    WHERE d.work_item_id=? AND (prerequisite.status<>'done' OR h.state IS NOT 'passed')
    ORDER BY prerequisite.created_at,prerequisite.id
  `).all(workItemId) as Array<{ workItemId: string }>).map(({ workItemId: id }) => ({
    code: "DEPENDENCY_NOT_PASSED",
    workItemId: id,
  }));
}

export function writeWorkItemStatusTx(
  database: DatabaseSync,
  input: {
    expectedVersion: number;
    toStatus: "done" | "in_progress";
    workItemId: string;
  },
): void {
  const current = workItem(database, input.workItemId);
  if (!current) {
    throw new CompletionGateError("WORK_ITEM_NOT_FOUND", 404, "Work item was not found.");
  }
  if (current.version !== input.expectedVersion) throw conflict(current.version);

  if (input.toStatus === "in_progress" && current.status === "done") {
    invalidateCompletionTx(database, {
      reason: "OWNER_REOPENED",
      workItemId: input.workItemId,
    });
    return;
  }
  if (input.toStatus !== "done") {
    throw new CompletionGateError(
      "INVALID_TRANSITION",
      409,
      "Work item transition is not allowed.",
    );
  }
  const head = database.prepare(`
    SELECT state FROM work_item_review_heads WHERE work_item_id=?
  `).get(input.workItemId) as { state: string } | undefined;
  if (head?.state !== "passed") {
    throw new CompletionGateError(
      "REVIEW_REQUIRED",
      409,
      "The current work item result has not passed independent review.",
      [{ code: head ? "REVIEW_REQUIRED" : "RESULT_MISSING", workItemId: input.workItemId }],
    );
  }
  const dependencies = dependencyBlockers(database, input.workItemId);
  if (dependencies.length > 0) {
    throw new CompletionGateError(
      "DEPENDENCY_NOT_READY",
      409,
      "Work item dependencies are not passed.",
      dependencies,
    );
  }
  if (current.status === "done") return;
  if (current.status !== "in_progress") {
    throw new CompletionGateError(
      "INVALID_TRANSITION",
      409,
      "Work item transition is not allowed.",
    );
  }
  const updated = markWorkItemDoneTx(database, {
    expectedVersion: input.expectedVersion,
    occurredAt: new Date().toISOString(),
    workItemId: input.workItemId,
  });
  if (updated.changes !== 1) throw conflict(workItem(database, input.workItemId)?.version);
}

export function projectPassedWorkItemTx(
  database: DatabaseSync,
  input: { expectedHeadVersion: number; workItemId: string },
): void {
  const head = database.prepare(`
    SELECT state,version FROM work_item_review_heads WHERE work_item_id=?
  `).get(input.workItemId) as { state: string; version: number } | undefined;
  if (!head || head.version !== input.expectedHeadVersion || head.state !== "passed") {
    throw new CompletionGateError(
      "REVIEW_STATE_CONFLICT",
      409,
      "Passed review projection changed.",
    );
  }
  const current = workItem(database, input.workItemId);
  if (!current) {
    throw new CompletionGateError("WORK_ITEM_NOT_FOUND", 404, "Work item was not found.");
  }
  writeWorkItemStatusTx(database, {
    expectedVersion: current.version,
    toStatus: "done",
    workItemId: input.workItemId,
  });
  appendEventTx(database, {
    missionId: current.missionId,
    payload: {
      headVersion: input.expectedHeadVersion,
      workItemId: input.workItemId,
    },
    projectId: current.projectId,
    type: "legacy_work_item_review_passed",
  });
}

export function completionBlockersTx(
  database: DatabaseSync,
  missionId: string,
): CompletionBlocker[] {
  const items = database.prepare(`
    SELECT w.id,w.status,h.state,h.current_result_id AS resultId
    FROM work_items w
    LEFT JOIN work_item_review_heads h ON h.work_item_id=w.id
    WHERE w.mission_id=?
    ORDER BY w.created_at,w.id
  `).all(missionId) as Array<{
    id: string;
    resultId: string | null;
    state: string | null;
    status: string;
  }>;
  if (items.length === 0) return [{ code: "MISSION_EMPTY", workItemId: null }];

  const blockers: CompletionBlocker[] = [];
  for (const item of items) {
    if (!item.state) {
      blockers.push({ code: "RESULT_MISSING", workItemId: item.id });
      continue;
    }
    if (item.state !== "passed") {
      blockers.push({ code: "REVIEW_REQUIRED", workItemId: item.id });
      continue;
    }
    if (!item.resultId) {
      blockers.push({ code: "RESULT_MISSING", workItemId: item.id });
      continue;
    }
    if (item.status !== "done") {
      blockers.push({ code: "BOARD_PROJECTION_INVALID", workItemId: item.id });
      continue;
    }
    blockers.push(...dependencyBlockers(database, item.id));
    const unresolved = database.prepare(`
      SELECT 1
      FROM review_escalations e
      JOIN review_decisions d ON d.id=e.decision_id
      JOIN review_attempts a ON a.id=d.attempt_id
      WHERE e.work_item_id=? AND NOT EXISTS(
        SELECT 1 FROM review_escalation_answers answer WHERE answer.escalation_id=e.id
      ) LIMIT 1
    `).get(item.id);
    if (unresolved) {
      blockers.push({ code: "OPEN_REVIEW_ISSUE", workItemId: item.id });
    }
    const missingAssociation = database.prepare(`
      SELECT 1
      FROM work_item_review_heads h
      JOIN review_attempts a ON a.id=h.current_attempt_id
      JOIN review_memory_candidates candidate ON candidate.attempt_id=a.id
      LEFT JOIN review_memory_associations association
        ON association.candidate_id=candidate.id
      WHERE h.work_item_id=? AND association.candidate_id IS NULL
      LIMIT 1
    `).get(item.id);
    if (missingAssociation) {
      blockers.push({ code: "MEMORY_ASSOCIATION_MISSING", workItemId: item.id });
    }
  }
  return blockers;
}

export function writeMissionCompletionTx(
  database: DatabaseSync,
  input: { missionId: string; toState: "completed" },
): void {
  const head = database.prepare(`
    SELECT state,current_delivery_id AS deliveryId FROM mission_delivery_heads
    WHERE mission_id=?
  `).get(input.missionId) as { deliveryId: string | null; state: string } | undefined;
  if (!head) {
    throw new CompletionGateError("MISSION_NOT_FOUND", 404, "Mission was not found.");
  }
  if (head.state === "completed" && head.deliveryId) return;
  const blockers = completionBlockersTx(database, input.missionId);
  if (blockers.length === 0) {
    blockers.push({ code: "DELIVERY_NOT_GENERATED", workItemId: null });
  }
  throw new CompletionGateError(
    "MISSION_COMPLETION_BLOCKED",
    409,
    "Mission completion requires a generated current delivery.",
    blockers,
  );
}

export function invalidateCompletionTx(
  database: DatabaseSync,
  input: { reason: CompletionInvalidationReason; workItemId: string },
): { invalidatedWorkItemIds: string[] } {
  const root = workItem(database, input.workItemId);
  if (!root) {
    throw new CompletionGateError("WORK_ITEM_NOT_FOUND", 404, "Work item was not found.");
  }
  const affected = database.prepare(`
    WITH RECURSIVE downstream(id,depth) AS (
      SELECT ?,0
      UNION ALL
      SELECT dependency.work_item_id,downstream.depth+1
      FROM work_item_dependencies dependency
      JOIN downstream ON dependency.depends_on_id=downstream.id
    )
    SELECT id,MIN(depth) AS depth FROM downstream
    GROUP BY id ORDER BY depth,id
  `).all(input.workItemId) as Array<{ depth: number; id: string }>;
  const invalidatedWorkItemIds: string[] = [];
  const now = new Date().toISOString();

  for (const { id } of affected) {
    const head = database.prepare(`
      SELECT state,version FROM work_item_review_heads WHERE work_item_id=?
    `).get(id) as { state: string; version: number } | undefined;
    if (head?.state !== "passed") continue;
    const changed = database.prepare(`
      UPDATE work_item_review_heads
      SET state='rework',current_attempt_id=NULL,version=version+1,updated_at=?
      WHERE work_item_id=? AND state='passed' AND version=?
    `).run(now, id, head.version);
    if (changed.changes !== 1) {
      throw new CompletionGateError(
        "REVIEW_STATE_CONFLICT",
        409,
        "Completion invalidation lost its review-head CAS.",
      );
    }
    markWorkItemInProgressTx(database, { occurredAt: now, workItemId: id });
    invalidatedWorkItemIds.push(id);
    appendEventTx(database, {
      missionId: root.missionId,
      payload: { reasonCode: input.reason, workItemId: id },
      projectId: root.projectId,
      type: "legacy_work_item_completion_invalidated",
    });
  }

  const delivery = database.prepare(`
    SELECT state,current_delivery_id AS deliveryId,
           current_operation_id AS operationId,version
    FROM mission_delivery_heads WHERE mission_id=? AND project_id=?
  `).get(root.missionId, root.projectId) as {
    deliveryId: string | null;
    operationId: string | null;
    state: string;
    version: number;
  };
  if (delivery.state === "completed" || delivery.state === "generating") {
    if (delivery.state === "generating" && delivery.operationId) {
      database.prepare(`
        UPDATE review_operations
        SET status='completed',http_status=409,response_json=?,updated_at=?
        WHERE project_id=? AND id=? AND kind='generate_delivery' AND status='pending'
      `).run(
        JSON.stringify({
          error: { code: "DELIVERY_CONTEXT_CHANGED" },
          ok: false,
        }),
        now,
        root.projectId,
        delivery.operationId,
      );
    }
    const changed = database.prepare(`
      UPDATE mission_delivery_heads
      SET state='ongoing',current_delivery_id=NULL,current_operation_id=NULL,
          generation_lease_token=NULL,generation_lease_expires_at=NULL,
          last_error_code=NULL,version=version+1,updated_at=?
      WHERE mission_id=? AND project_id=? AND version=?
    `).run(now, root.missionId, root.projectId, delivery.version);
    if (changed.changes !== 1) {
      throw new CompletionGateError(
        "REVIEW_STATE_CONFLICT",
        409,
        "Delivery invalidation lost its head CAS.",
      );
    }
    appendEventTx(database, {
      missionId: root.missionId,
      payload: {
        deliveryId: delivery.deliveryId,
        reasonCode: input.reason,
        workItemIds: [input.workItemId],
      },
      projectId: root.projectId,
      type: "delivery_invalidated",
    });
  }
  return { invalidatedWorkItemIds };
}
