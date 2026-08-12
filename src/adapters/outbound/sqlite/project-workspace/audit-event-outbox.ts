import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { assertPublicProjectionText } from "@/src/adapters/outbound/sqlite/public-collaboration/verified-source-projection";

export type ProjectWorkspaceAuditPayloadValue = string | number | boolean | null | readonly string[];

// Project & Workspace event types worth an audit row (feature 036 selection):
// project creation, workspace bind/rebind, membership join/remove, and saved
// validation-policy changes (mirrored from project_validation_policy_audits).
// Internal noise never enters the audit trail: the system-seeded empty policy
// revision, same-workspace re-asserts, rejected policy saves, and read-side
// browse operations.
export const AUDITABLE_PROJECT_WORKSPACE_EVENT_TYPES: ReadonlySet<string> = new Set([
  "member_joined",
  "member_removed",
  "project_created",
  "validation_policy_changed",
  "workspace_bound",
  "workspace_rebound",
]);

// Flat public scalar keys allowed in a project-workspace audit payload.
// Workspace binding paths are host absolute paths and never enter the payload;
// policy entry executables/workdirs and every unknown key stay out, so host
// paths and secrets can never leak through a future payload field.
const PUBLIC_PAYLOAD_KEYS: ReadonlySet<string> = new Set([
  "agentDisplayName", "agentId", "entryCount", "policyHash", "revisionNo",
  "warningAccepted",
]);

// Public owner-visible text (project names, member display names are already
// visible in the cockpit UI; workspace names are redacted path basenames).
// They enter the audit trail only as bounded, credential-classified excerpts.
const EXCERPT_TEXT_KEYS: ReadonlySet<string> = new Set([
  "previousWorkspaceName", "projectName", "workspaceName",
]);

export const PROJECT_WORKSPACE_AUDIT_EXCERPT_MAX_GRAPHEMES = 200;
export const PROJECT_WORKSPACE_AUDIT_EXCERPT_WITHHELD = "[redacted]";

const segmenter = new Intl.Segmenter("zh-CN", { granularity: "grapheme" });

function truncateGraphemes(value: string, maximum: number): string {
  const graphemes = Array.from(segmenter.segment(value), (part) => part.segment);
  if (graphemes.length <= maximum) return value;
  return `${graphemes.slice(0, maximum).join("")}…`;
}

function publicExcerpt(database: DatabaseSync, value: string): string {
  const excerpt = truncateGraphemes(value.trim(), PROJECT_WORKSPACE_AUDIT_EXCERPT_MAX_GRAPHEMES);
  try {
    assertPublicProjectionText(database, excerpt);
  } catch {
    // Fail-closed without breaking the business write: when the public-text
    // seam rejects (or cannot verify) the text, the audit keeps a placeholder.
    return PROJECT_WORKSPACE_AUDIT_EXCERPT_WITHHELD;
  }
  return excerpt;
}

// Host absolute paths never enter the audit trail: only the final path
// segment (the workspace directory name) survives, and even it goes through
// the bounded credential-classified excerpt seam. Both Windows and POSIX
// separators are handled; a path without any segment degrades to the
// placeholder instead of leaking raw input.
function workspacePathName(canonicalPath: string): string {
  const segments = canonicalPath.split(/[\\/]+/u).filter((segment) => segment.length > 0);
  return segments.at(-1) ?? PROJECT_WORKSPACE_AUDIT_EXCERPT_WITHHELD;
}

function isPublicValue(value: unknown): value is ProjectWorkspaceAuditPayloadValue {
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

// Must run inside the caller's transaction: outbox_seq is allocated with
// MAX+1, which is only safe while the write transaction serializes writers.
export function appendProjectWorkspaceAuditOutboxRow(
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
  if (!AUDITABLE_PROJECT_WORKSPACE_EVENT_TYPES.has(input.eventType)) return;
  const extracted: Record<string, ProjectWorkspaceAuditPayloadValue> = {};
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
    ) VALUES (?,?,'project_workspace',?,?,?,?)
  `).run(
    input.eventId,
    input.projectId,
    input.eventType,
    JSON.stringify(payload),
    input.occurredAt,
    next,
  );
}

export function appendProjectCreatedAuditOutboxRow(
  database: DatabaseSync,
  input: { occurredAt: string; projectId: string; projectName: string },
): void {
  appendProjectWorkspaceAuditOutboxRow(database, {
    actorId: null,
    actorType: "owner",
    eventId: randomUUID(),
    eventType: "project_created",
    occurredAt: input.occurredAt,
    projectId: input.projectId,
    sourcePayload: { projectName: input.projectName },
  });
}

export function appendWorkspaceBindingAuditOutboxRow(
  database: DatabaseSync,
  input: {
    eventType: "workspace_bound" | "workspace_rebound";
    occurredAt: string;
    previousWorkspacePath: string | null;
    projectId: string;
    workspacePath: string;
  },
): void {
  const sourcePayload: Record<string, unknown> = {
    workspaceName: workspacePathName(input.workspacePath),
  };
  if (input.eventType === "workspace_rebound" && input.previousWorkspacePath !== null) {
    sourcePayload.previousWorkspaceName = workspacePathName(input.previousWorkspacePath);
  }
  appendProjectWorkspaceAuditOutboxRow(database, {
    actorId: null,
    actorType: "owner",
    eventId: randomUUID(),
    eventType: input.eventType,
    occurredAt: input.occurredAt,
    projectId: input.projectId,
    sourcePayload,
  });
}

export function appendMemberChangeAuditOutboxRow(
  database: DatabaseSync,
  input: {
    agentDisplayName: string;
    agentId: string;
    eventType: "member_joined" | "member_removed";
    occurredAt: string;
    projectId: string;
  },
): void {
  appendProjectWorkspaceAuditOutboxRow(database, {
    actorId: null,
    actorType: "owner",
    eventId: randomUUID(),
    eventType: input.eventType,
    occurredAt: input.occurredAt,
    projectId: input.projectId,
    sourcePayload: {
      agentDisplayName: input.agentDisplayName,
      agentId: input.agentId,
    },
  });
}

// project_validation_policy_audits mirror: the audit row id is reused as the
// outbox row id so the audit trail points at the exact domain fact. Only
// saved policy changes enter the feed; rejected attempts stay noise. Policy
// entry executables/workdirs (host paths) never enter the payload — only the
// public hash, revision number, and entry count.
export function appendValidationPolicyChangedAuditOutboxRow(
  database: DatabaseSync,
  input: {
    auditId: string;
    entryCount: number;
    occurredAt: string;
    policyHash: string;
    projectId: string;
    revisionNo: number;
    warningAccepted: boolean;
  },
): void {
  appendProjectWorkspaceAuditOutboxRow(database, {
    actorId: null,
    actorType: "owner",
    eventId: input.auditId,
    eventType: "validation_policy_changed",
    occurredAt: input.occurredAt,
    projectId: input.projectId,
    sourcePayload: {
      entryCount: input.entryCount,
      policyHash: input.policyHash,
      revisionNo: input.revisionNo,
      warningAccepted: input.warningAccepted,
    },
  });
}
