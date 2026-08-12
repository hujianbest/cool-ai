import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { assertPublicProjectionText } from "@/src/adapters/outbound/sqlite/public-collaboration/verified-source-projection";

export type MissionWorkAuditPayloadValue = string | number | boolean | null | readonly string[];

// Mission & Work event types worth an audit row (feature 035 selection): the
// owner-visible task lifecycle mirrored from task_events, mission creation,
// and work-item board creation/status transitions. Content edits (mission or
// work-item title/goal updates) and internal projection writes never enter
// the audit trail.
export const AUDITABLE_MISSION_WORK_EVENT_TYPES: ReadonlySet<string> = new Set([
  "mission_created",
  "task_completed",
  "task_created",
  "task_failed",
  "task_started",
  "work_item_created",
  "work_item_status_changed",
]);

// Flat public scalar keys allowed in a mission-work audit payload. Everything
// else (executor results, error details, descriptions) stays out, so secrets
// and hidden reasoning can never leak through a future payload field.
const PUBLIC_PAYLOAD_KEYS: ReadonlySet<string> = new Set([
  "assigneeAgentId", "fromStatus", "missionId", "status", "taskId",
  "toStatus", "workItemId",
]);

// Public conversation-grade text (task titles and status messages are already
// owner-visible in the task board UI). They enter the audit trail only as
// bounded, credential-classified excerpts.
const EXCERPT_TEXT_KEYS: ReadonlySet<string> = new Set(["message", "title"]);

export const MISSION_WORK_AUDIT_EXCERPT_MAX_GRAPHEMES = 200;
export const MISSION_WORK_AUDIT_EXCERPT_WITHHELD = "[redacted]";

const segmenter = new Intl.Segmenter("zh-CN", { granularity: "grapheme" });

function truncateGraphemes(value: string, maximum: number): string {
  const graphemes = Array.from(segmenter.segment(value), (part) => part.segment);
  if (graphemes.length <= maximum) return value;
  return `${graphemes.slice(0, maximum).join("")}…`;
}

function publicExcerpt(database: DatabaseSync, value: string): string {
  const excerpt = truncateGraphemes(value.trim(), MISSION_WORK_AUDIT_EXCERPT_MAX_GRAPHEMES);
  try {
    assertPublicProjectionText(database, excerpt);
  } catch {
    // Fail-closed without breaking the business write: when the public-text
    // seam rejects (or cannot verify) the text, the audit keeps a placeholder.
    return MISSION_WORK_AUDIT_EXCERPT_WITHHELD;
  }
  return excerpt;
}

function isPublicValue(value: unknown): value is MissionWorkAuditPayloadValue {
  if (value === null) return true;
  switch (typeof value) {
    case "string":
    case "boolean":
      return true;
    case "number":
      return Number.isFinite(value);
    default:
      return Array.isArray(value)
        && value.every((entry) => typeof entry === "string");
  }
}

// Task lifecycle statuses map to audit event types; any future task status
// stays out of the audit trail until explicitly selected above.
export function missionWorkTaskEventType(status: string): string | null {
  switch (status) {
    case "queued":
      return "task_created";
    case "running":
      return "task_started";
    case "completed":
      return "task_completed";
    case "failed":
      return "task_failed";
    default:
      return null;
  }
}

// Must run inside the caller's transaction: outbox_seq is allocated with
// MAX+1, which is only safe while the write transaction serializes writers.
export function appendMissionWorkAuditOutboxRow(
  database: DatabaseSync,
  input: {
    actorId: string | null;
    actorType: string;
    eventId: string;
    eventType: string;
    occurredAt: string;
    projectId: string;
    sourcePayload: Record<string, unknown>;
  },
): void {
  if (!AUDITABLE_MISSION_WORK_EVENT_TYPES.has(input.eventType)) return;
  const extracted: Record<string, MissionWorkAuditPayloadValue> = {};
  for (const [key, value] of Object.entries(input.sourcePayload)) {
    if (EXCERPT_TEXT_KEYS.has(key) && typeof value === "string") {
      extracted[key] = publicExcerpt(database, value);
      continue;
    }
    if (PUBLIC_PAYLOAD_KEYS.has(key) && isPublicValue(value)) {
      extracted[key] = value;
    }
  }
  const payload = {
    ...extracted,
    actorId: input.actorId,
    actorType: input.actorType,
    occurredAt: input.occurredAt,
    type: input.eventType,
  };
  const next = (database.prepare(
    "SELECT COALESCE(MAX(outbox_seq),0)+1 AS nextSeq FROM audit_event_outbox",
  ).get() as { nextSeq: number }).nextSeq;
  database.prepare(`
    INSERT INTO audit_event_outbox (
      id,project_id,source,event_type,payload_json,occurred_at,outbox_seq
    ) VALUES (?,?,'mission_work',?,?,?,?)
  `).run(
    input.eventId,
    input.projectId,
    input.eventType,
    JSON.stringify(payload),
    input.occurredAt,
    next,
  );
}

// task_events mirror: the event row id is reused as the outbox row id so the
// audit trail points at the exact domain fact.
export function appendTaskEventAuditOutboxRow(
  database: DatabaseSync,
  input: {
    event: { createdAt: string; id: string; message: string; status: string };
    task: { goal: string; id: string; projectId: string };
  },
): void {
  const eventType = missionWorkTaskEventType(input.event.status);
  if (!eventType) return;
  appendMissionWorkAuditOutboxRow(database, {
    actorId: null,
    actorType: "owner",
    eventId: input.event.id,
    eventType,
    occurredAt: input.event.createdAt,
    projectId: input.task.projectId,
    sourcePayload: {
      message: input.event.message,
      status: input.event.status,
      taskId: input.task.id,
      title: input.task.goal,
    },
  });
}

export function appendMissionCreatedAuditOutboxRow(
  database: DatabaseSync,
  input: { missionId: string; occurredAt: string; projectId: string; title: string },
): void {
  appendMissionWorkAuditOutboxRow(database, {
    actorId: null,
    actorType: "owner",
    eventId: randomUUID(),
    eventType: "mission_created",
    occurredAt: input.occurredAt,
    projectId: input.projectId,
    sourcePayload: { missionId: input.missionId, title: input.title },
  });
}

export function appendWorkItemCreatedAuditOutboxRow(
  database: DatabaseSync,
  input: {
    actorId: string | null;
    actorType: string;
    missionId: string;
    occurredAt: string;
    projectId: string;
    title: string;
    workItemId: string;
  },
): void {
  appendMissionWorkAuditOutboxRow(database, {
    actorId: input.actorId,
    actorType: input.actorType,
    eventId: randomUUID(),
    eventType: "work_item_created",
    occurredAt: input.occurredAt,
    projectId: input.projectId,
    sourcePayload: {
      missionId: input.missionId,
      title: input.title,
      workItemId: input.workItemId,
    },
  });
}

// Status transitions resolve the project tuple through the mission join
// (tuple-scoped read) so the outbox row always carries the owning project.
export function appendWorkItemStatusAuditOutboxRow(
  database: DatabaseSync,
  input: {
    actorId: string | null;
    actorType: string;
    fromStatus: string;
    occurredAt: string;
    toStatus: string;
    workItemId: string;
  },
): void {
  const item = database
    .prepare(
      `SELECT w.mission_id AS missionId, w.title AS title, m.project_id AS projectId
       FROM work_items w JOIN missions m ON m.id = w.mission_id
       WHERE w.id = ?`,
    )
    .get(input.workItemId) as
    | { missionId: string; projectId: string; title: string }
    | undefined;
  if (!item) return;
  appendMissionWorkAuditOutboxRow(database, {
    actorId: input.actorId,
    actorType: input.actorType,
    eventId: randomUUID(),
    eventType: "work_item_status_changed",
    occurredAt: input.occurredAt,
    projectId: item.projectId,
    sourcePayload: {
      fromStatus: input.fromStatus,
      missionId: item.missionId,
      title: item.title,
      toStatus: input.toStatus,
      workItemId: input.workItemId,
    },
  });
}
