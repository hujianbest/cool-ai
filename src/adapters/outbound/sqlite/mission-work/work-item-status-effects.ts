import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { appendWorkItemStatusAuditOutboxRow } from "@/src/adapters/outbound/sqlite/mission-work/audit-event-outbox";
import type {
  MarkReviewedWorkItemDoneInput,
  MarkWorkItemDoneInput,
  MarkWorkItemInProgressInput,
  WorkItemStatusWriteResult,
} from "@/src/modules/mission-work";

/**
 * mission-work owner 的 work_items 看板状态写能力（T-11 提取自 src/server/review/）。
 * SQL 文本、参数绑定顺序与调用处并发语义与原实现逐字一致：
 * - markWorkItemDoneTx：完成门禁的 version-CAS 完成投影（原 completion-gate.ts
 *   writeWorkItemStatusTx 内联 UPDATE）；
 * - markReviewedWorkItemDoneTx：复核通过的 mission 元组作用域完成投影
 *  （原 review-finalizer.ts 定稿事务内联 UPDATE）；
 * - markWorkItemInProgressTx：完成失效的重开投影（原 completion-gate.ts
 *   invalidateCompletionTx 内联 UPDATE）。
 */
export function markWorkItemDoneTx(
  database: DatabaseSync,
  input: MarkWorkItemDoneInput,
): WorkItemStatusWriteResult {
  const updated = database.prepare(`
    UPDATE work_items SET status='done',version=version+1,updated_at=?,
      lease_token=NULL,lease_expires_at=NULL,last_heartbeat_at=NULL
    WHERE id=? AND version=? AND status='in_progress'
  `).run(input.occurredAt, input.workItemId, input.expectedVersion);
  if (updated.changes === 1) {
    appendWorkItemStatusAuditOutboxRow(database, {
      actorId: null,
      actorType: "system",
      fromStatus: "in_progress",
      occurredAt: input.occurredAt,
      toStatus: "done",
      workItemId: input.workItemId,
    });
  }
  return updated;
}

export function markReviewedWorkItemDoneTx(
  database: DatabaseSync,
  input: MarkReviewedWorkItemDoneInput,
): WorkItemStatusWriteResult {
  const updated = database.prepare(`
        UPDATE work_items SET status='done',version=version+1,updated_at=?,
          lease_token=NULL,lease_expires_at=NULL,last_heartbeat_at=NULL
        WHERE id=? AND mission_id=? AND status='in_progress'
      `).run(input.occurredAt, input.workItemId, input.missionId);
  if (updated.changes === 1) {
    appendWorkItemStatusAuditOutboxRow(database, {
      actorId: null,
      actorType: "system",
      fromStatus: "in_progress",
      occurredAt: input.occurredAt,
      toStatus: "done",
      workItemId: input.workItemId,
    });
  }
  return updated;
}

export function markWorkItemInProgressTx(
  database: DatabaseSync,
  input: MarkWorkItemInProgressInput,
): WorkItemStatusWriteResult {
  const leaseExpiresAt = new Date(
    Date.parse(input.occurredAt) + 15 * 60 * 1000,
  ).toISOString();
  const updated = database.prepare(`
      UPDATE work_items SET status='in_progress',version=version+1,updated_at=?,
        lease_token=CASE WHEN assignee_agent_id IS NOT NULL THEN ? ELSE NULL END,
        lease_expires_at=CASE WHEN assignee_agent_id IS NOT NULL THEN ? ELSE NULL END,
        last_heartbeat_at=CASE WHEN assignee_agent_id IS NOT NULL THEN ? ELSE NULL END
      WHERE id=? AND status='done'
    `).run(
    input.occurredAt,
    randomUUID(),
    leaseExpiresAt,
    input.occurredAt,
    input.workItemId,
  );
  if (updated.changes === 1) {
    appendWorkItemStatusAuditOutboxRow(database, {
      actorId: null,
      actorType: "system",
      fromStatus: "done",
      occurredAt: input.occurredAt,
      toStatus: "in_progress",
      workItemId: input.workItemId,
    });
  }
  return updated;
}
