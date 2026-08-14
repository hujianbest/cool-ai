import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { assertPublicProjectionText } from "@/src/adapters/outbound/sqlite/public-collaboration/verified-source-projection";

export const RUNTIME_AUDIT_MODEL_MAX_GRAPHEMES = 200;
export const RUNTIME_AUDIT_TEXT_WITHHELD = "[redacted]";

const AUDITABLE_RUNTIME_EVENT_TYPES = new Set([
  "runtime_call_failed",
  "runtime_call_succeeded",
]);
type RuntimeSurface = "collaboration" | "execution" | "review";
const RUNTIME_SURFACES: ReadonlySet<string> = new Set([
  "collaboration",
  "execution",
  "review",
]);
const NAVIGATION_KEYS_BY_SURFACE = {
  collaboration: new Set(["runId", "threadId"]),
  execution: new Set(["executionId"]),
  review: new Set(["reviewAttemptId"]),
} satisfies Record<RuntimeSurface, ReadonlySet<string>>;
const NAVIGATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const ERROR_CATEGORY = /^[a-z][a-z0-9_]{0,99}$/u;
const segmenter = new Intl.Segmenter("zh-CN", { granularity: "grapheme" });

function truncateGraphemes(value: string): string {
  const graphemes = Array.from(segmenter.segment(value), (part) => part.segment);
  if (graphemes.length <= RUNTIME_AUDIT_MODEL_MAX_GRAPHEMES) return value;
  return `${graphemes.slice(0, RUNTIME_AUDIT_MODEL_MAX_GRAPHEMES).join("")}…`;
}

function publicModel(database: DatabaseSync, value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const model = value.trim();
  try {
    assertPublicProjectionText(database, model);
    return truncateGraphemes(model);
  } catch {
    return RUNTIME_AUDIT_TEXT_WITHHELD;
  }
}

function isRuntimeSurface(value: unknown): value is RuntimeSurface {
  return typeof value === "string" && RUNTIME_SURFACES.has(value);
}

function validNavigationId(value: unknown): value is string {
  return typeof value === "string" && NAVIGATION_ID.test(value);
}

export function appendRuntimeAuditOutboxRow(
  database: DatabaseSync,
  input: {
    eventType: string;
    occurredAt?: string;
    projectId: string;
    sourcePayload: Record<string, unknown>;
  },
): void {
  if (!AUDITABLE_RUNTIME_EVENT_TYPES.has(input.eventType)) return;
  const surface = input.sourcePayload.surface;
  if (!isRuntimeSurface(surface)) return;
  const model = publicModel(database, input.sourcePayload.model);
  if (model === null) return;

  const payload: Record<string, string | null> = {
    actorId: null,
    actorType: "owner",
    model,
  };
  const navigationKeys = NAVIGATION_KEYS_BY_SURFACE[surface];
  for (const key of navigationKeys) {
    const value = input.sourcePayload[key];
    if (validNavigationId(value)) payload[key] = value;
  }
  if (input.eventType === "runtime_call_failed") {
    const errorCategory = input.sourcePayload.errorCategory;
    if (typeof errorCategory !== "string" || !ERROR_CATEGORY.test(errorCategory)) return;
    payload.errorCategory = errorCategory;
  }

  const occurredAt = input.occurredAt ?? new Date().toISOString();
  payload.occurredAt = occurredAt;
  payload.surface = surface;
  payload.type = input.eventType;
  const next = (database.prepare(
    "SELECT COALESCE(MAX(outbox_seq),0)+1 AS nextSeq FROM audit_event_outbox",
  ).get() as { nextSeq: number }).nextSeq;
  database.prepare(`
    INSERT INTO audit_event_outbox(
      id,project_id,source,event_type,payload_json,occurred_at,outbox_seq
    ) VALUES (?,?,'runtime',?,?,?,?)
  `).run(
    randomUUID(),
    input.projectId,
    input.eventType,
    JSON.stringify(payload),
    occurredAt,
    next,
  );
}
