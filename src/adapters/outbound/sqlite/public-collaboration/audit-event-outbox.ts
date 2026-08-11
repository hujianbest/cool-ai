import type { DatabaseSync } from "node:sqlite";

import { assertPublicProjectionText } from "@/src/adapters/outbound/sqlite/public-collaboration/verified-source-projection";

export type CollaborationAuditPayloadValue = string | number | boolean | null | readonly string[];

// Collaboration event types worth an audit row (feature 030 selection). The
// high-frequency noise types (model_call_started/succeeded/failed,
// usage_recorded, attempt_interrupted) never enter the audit trail.
export const AUDITABLE_COLLABORATION_EVENT_TYPES: ReadonlySet<string> = new Set([
  "action_rejected",
  "agent_message",
  "boundary_paused",
  "context_changed",
  "decision_answered",
  "decision_requested",
  "handoff",
  "owner_message",
  "run_paused",
  "run_planned",
  "run_resumed",
  "run_retried",
  "run_started",
  "run_stopped",
  "task_claimed",
  "tasks_created",
  "thread_deleted",
  "thread_purged",
  "thread_restored",
]);

// Flat public scalar keys that already appear in the collaboration event
// contract (timelinePayloadSchemas in src/shared/collaboration-contracts.ts).
// Nested structures (tasks_created.items) and every unknown key stay out of
// the audit trail, so prompts, credentials, hidden reasoning and host paths
// can never leak through a future payload field.
const PUBLIC_PAYLOAD_KEYS: ReadonlySet<string> = new Set([
  "agentDisplayName", "agentId", "attemptId", "boundary", "category",
  "currentAgentId", "decisionId", "fromAgentId", "limit", "mentionAgentId",
  "mentionDisplayName", "messageId", "messageSequence", "missing",
  "nextAgentId", "overriddenByMention", "toAgentId", "turnId", "value",
  "workItemId",
]);

// Public conversation text keys (already owner-visible in the thread UI). They
// enter the audit trail only as bounded, credential-classified excerpts.
const EXCERPT_TEXT_KEYS: ReadonlySet<string> = new Set([
  "answer", "question", "reason", "summary", "title",
]);

export const AUDIT_EXCERPT_MAX_GRAPHEMES = 200;
export const AUDIT_EXCERPT_WITHHELD = "[redacted]";

const segmenter = new Intl.Segmenter("zh-CN", { granularity: "grapheme" });

function truncateGraphemes(value: string, maximum: number): string {
  const graphemes = Array.from(segmenter.segment(value), (part) => part.segment);
  if (graphemes.length <= maximum) return value;
  return `${graphemes.slice(0, maximum).join("")}…`;
}

function publicExcerpt(database: DatabaseSync, value: string): string {
  const excerpt = truncateGraphemes(value.trim(), AUDIT_EXCERPT_MAX_GRAPHEMES);
  try {
    assertPublicProjectionText(database, excerpt);
  } catch {
    // Fail-closed without breaking the business write: when the public-text
    // seam rejects (or cannot verify) the text, the audit keeps a placeholder.
    return AUDIT_EXCERPT_WITHHELD;
  }
  return excerpt;
}

function isPublicValue(value: unknown): value is CollaborationAuditPayloadValue {
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

function messageExcerpt(
  database: DatabaseSync,
  input: { projectId: string; threadId: string },
  messageId: unknown,
): string | null {
  if (typeof messageId !== "string") return null;
  const row = database
    .prepare(
      `SELECT content FROM collaboration_messages
       WHERE project_id=? AND thread_id=? AND id=?`,
    )
    .get(input.projectId, input.threadId, messageId) as { content: string } | undefined;
  if (!row) return null;
  return publicExcerpt(database, row.content);
}

export function extractCollaborationAuditPayload(
  database: DatabaseSync,
  input: {
    actorId: string | null;
    actorType: string;
    eventType: string;
    occurredAt: string;
    projectId: string;
    runId: string | null;
    threadId: string;
    sourcePayload: unknown;
  },
): Record<string, CollaborationAuditPayloadValue> {
  const extracted: Record<string, CollaborationAuditPayloadValue> = {};
  const source = input.sourcePayload;
  if (typeof source === "object" && source !== null && !Array.isArray(source)) {
    const entries = Object.entries(source as Record<string, unknown>);
    for (const [key, value] of entries) {
      if (EXCERPT_TEXT_KEYS.has(key) && typeof value === "string") {
        extracted[key] = publicExcerpt(database, value);
        continue;
      }
      if (
        key === "options"
        && Array.isArray(value)
        && value.every((entry) => typeof entry === "string")
      ) {
        extracted.options = value.map((entry) => publicExcerpt(database, entry));
        continue;
      }
      if (key === "items" && Array.isArray(value)) {
        // tasks_created carries nested item objects; the audit keeps the count.
        extracted.taskCount = value.length;
        continue;
      }
      if (PUBLIC_PAYLOAD_KEYS.has(key) && isPublicValue(value)) {
        extracted[key] = value;
      }
    }
    if (input.eventType === "owner_message" || input.eventType === "agent_message") {
      const excerpt = messageExcerpt(
        database,
        { projectId: input.projectId, threadId: input.threadId },
        (source as Record<string, unknown>).messageId,
      );
      if (excerpt !== null) extracted.messageExcerpt = excerpt;
    }
  }
  return {
    ...extracted,
    actorId: input.actorId,
    actorType: input.actorType,
    occurredAt: input.occurredAt,
    runId: input.runId,
    threadId: input.threadId,
    type: input.eventType,
  };
}

// Must run inside the caller's transaction: outbox_seq is allocated with
// MAX+1, which is only safe while the write transaction serializes writers.
export function appendCollaborationAuditOutboxRow(
  database: DatabaseSync,
  input: {
    actorId: string | null;
    actorType: string;
    eventId: string;
    eventType: string;
    projectId: string;
    runId: string | null;
    threadId: string;
    sourcePayload: unknown;
  },
): void {
  if (!AUDITABLE_COLLABORATION_EVENT_TYPES.has(input.eventType)) return;
  const occurredAt = new Date().toISOString();
  const payload = extractCollaborationAuditPayload(database, {
    actorId: input.actorId,
    actorType: input.actorType,
    eventType: input.eventType,
    occurredAt,
    projectId: input.projectId,
    runId: input.runId,
    threadId: input.threadId,
    sourcePayload: input.sourcePayload,
  });
  const next = (database.prepare(
    "SELECT COALESCE(MAX(outbox_seq),0)+1 AS nextSeq FROM audit_event_outbox",
  ).get() as { nextSeq: number }).nextSeq;
  database.prepare(`
    INSERT INTO audit_event_outbox (
      id,project_id,source,event_type,payload_json,occurred_at,outbox_seq
    ) VALUES (?,?,'public_collaboration',?,?,?,?)
  `).run(
    input.eventId,
    input.projectId,
    input.eventType,
    JSON.stringify(payload),
    occurredAt,
    next,
  );
}
