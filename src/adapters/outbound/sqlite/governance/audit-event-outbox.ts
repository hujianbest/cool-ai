import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { assertPublicProjectionText } from "@/src/adapters/outbound/sqlite/public-collaboration/verified-source-projection";

export type GovernanceAuditPayloadValue = string | number | boolean | null;

// Governance event types worth an audit row (feature 037 selection): the five
// approval lifecycle state facts. Internal noise never enters the audit trail:
// read-side approval-card browsing, no-op expire/consume updates (changes=0),
// and per-row noise from batch expire loops (one row per call site, scope
// annotated).
export const AUDITABLE_GOVERNANCE_EVENT_TYPES: ReadonlySet<string> = new Set([
  "approval_approved",
  "approval_consumed",
  "approval_expired",
  "approval_rejected",
  "approval_requested",
]);

// Flat public scalar keys allowed in a governance audit payload: enum and
// identity facts only. approvalId/executionId ride along as the audit panel's
// navigation anchors (strictly validatable ids, same seam as 036 agentId).
// Command text, scripts, diffs, host paths, request/result JSON, and hashes
// never enter the payload.
const PUBLIC_PAYLOAD_KEYS: ReadonlySet<string> = new Set([
  "approvalId",
  "decision",
  "executionId",
  "kind",
  "riskLevel",
  "scope",
]);

export const GOVERNANCE_AUDIT_EXCERPT_MAX_GRAPHEMES = 200;
export const GOVERNANCE_AUDIT_EXCERPT_WITHHELD = "[redacted]";

const segmenter = new Intl.Segmenter("zh-CN", { granularity: "grapheme" });

function truncateGraphemes(value: string, maximum: number): string {
  const graphemes = Array.from(segmenter.segment(value), (part) => part.segment);
  if (graphemes.length <= maximum) return value;
  return `${graphemes.slice(0, maximum).join("")}…`;
}

function publicExcerpt(database: DatabaseSync, value: string): string {
  const excerpt = truncateGraphemes(value.trim(), GOVERNANCE_AUDIT_EXCERPT_MAX_GRAPHEMES);
  try {
    assertPublicProjectionText(database, excerpt);
  } catch {
    // Fail-closed without breaking the business write: when the public-text
    // seam rejects (or cannot verify) the text, the audit keeps a placeholder.
    return GOVERNANCE_AUDIT_EXCERPT_WITHHELD;
  }
  return excerpt;
}

function isPublicValue(value: unknown): value is GovernanceAuditPayloadValue {
  if (value === null) return true;
  switch (typeof value) {
    case "string":
    case "boolean":
      return true;
    case "number":
      return Number.isFinite(value);
    default:
      return false;
  }
}

// Must run inside the caller's transaction: outbox_seq is allocated with
// MAX+1, which is only safe while the write transaction serializes writers.
// Governance payloads carry only enum/identity values, but every string still
// passes the bounded credential-classified excerpt seam so a future free-text
// field cannot bypass truncation/classification by reusing a whitelisted key.
export function appendGovernanceAuditOutboxRow(
  database: DatabaseSync,
  input: {
    eventType: string;
    occurredAt?: string;
    projectId: string;
    sourcePayload: Record<string, unknown>;
  },
): void {
  if (!AUDITABLE_GOVERNANCE_EVENT_TYPES.has(input.eventType)) return;
  const occurredAt = input.occurredAt ?? new Date().toISOString();
  const extracted: Record<string, GovernanceAuditPayloadValue> = {};
  for (const [key, value] of Object.entries(input.sourcePayload)) {
    if (!PUBLIC_PAYLOAD_KEYS.has(key) || !isPublicValue(value)) continue;
    extracted[key] = typeof value === "string" ? publicExcerpt(database, value) : value;
  }
  const payload = {
    ...extracted,
    actorId: null,
    actorType: "owner",
    occurredAt,
    type: input.eventType,
  };
  const next = (database.prepare(
    "SELECT COALESCE(MAX(outbox_seq),0)+1 AS nextSeq FROM audit_event_outbox",
  ).get() as { nextSeq: number }).nextSeq;
  database.prepare(`
    INSERT INTO audit_event_outbox (
      id,project_id,source,event_type,payload_json,occurred_at,outbox_seq
    ) VALUES (?,?,'governance',?,?,?,?)
  `).run(
    randomUUID(),
    input.projectId,
    input.eventType,
    JSON.stringify(payload),
    occurredAt,
    next,
  );
}
