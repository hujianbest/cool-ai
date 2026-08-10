import type { DatabaseSync } from "node:sqlite";

export type AuditPayloadValue = string | number | boolean | null | readonly string[];

// Flat public scalar keys that already appear in the execution event contract
// (src/shared/execution-contracts.ts). Nested summaries (resultSummary,
// requestSummary, stdout/stderr) and every unknown key stay out of the audit
// trail, so prompts, credentials, hidden reasoning and host paths can never
// leak through a future payload field.
const PUBLIC_PAYLOAD_KEYS: ReadonlySet<string> = new Set([
  "action", "actionId", "actionIndex", "afterHash", "agentId", "approvalId",
  "attemptNo", "authorizationSource", "beforeHash", "blockReasons", "blockerCount",
  "boundary", "categories", "category", "classification", "code",
  "completionTokens", "copiedBytes", "decision", "direction", "durationMs",
  "excludedCount", "exitCode", "from", "guardCode", "itemCount", "journalId",
  "kind", "limit", "manifestHash", "mergeFileCount", "mergeFinalBytes",
  "mismatchPhase", "modelCallId", "observedFinalBytes", "observedManifestHash",
  "observedPathCount", "oldManifestHash", "operationId", "otherExecutionIds",
  "overallDeadlineAt", "pathCount", "policyEntryId", "postManifestHash",
  "promptTokens", "reasonCode", "recovery", "reported", "requestHash",
  "required", "resolution", "resultId", "resumeTarget", "riskReasons", "round",
  "sandboxManifestHash", "stagedHash", "stagedId", "status", "succeeded", "to",
  "toolCallId", "totalTokens", "truncated", "uncleanedOwnedPathCount",
  "validationId", "value", "workItemId",
]);

function isPublicValue(value: unknown): value is AuditPayloadValue {
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

export function extractExecutionAuditPayload(input: {
  actorId: string | null;
  actorType: string;
  attemptNo: number;
  eventType: string;
  executionId: string;
  occurredAt: string;
  sourcePayload: unknown;
}): Record<string, AuditPayloadValue> {
  const extracted: Record<string, AuditPayloadValue> = {};
  const source = input.sourcePayload;
  if (typeof source === "object" && source !== null && !Array.isArray(source)) {
    for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
      if (key === "type") {
        // The source payload's tool kind would collide with the event type.
        if (typeof value === "string") extracted.toolType = value;
        continue;
      }
      if (PUBLIC_PAYLOAD_KEYS.has(key) && isPublicValue(value)) {
        extracted[key] = value;
      }
    }
  }
  return {
    ...extracted,
    actorId: input.actorId,
    actorType: input.actorType,
    attemptNo: input.attemptNo,
    executionId: input.executionId,
    occurredAt: input.occurredAt,
    type: input.eventType,
  };
}

// Must run inside the caller's transaction: outbox_seq is allocated with
// MAX+1, which is only safe while the write transaction serializes writers.
export function appendExecutionAuditOutboxRow(
  database: DatabaseSync,
  input: {
    actorId: string | null;
    actorType: string;
    attemptNo: number;
    eventId: string;
    eventType: string;
    executionId: string;
    projectId: string;
    sourcePayload: unknown;
  },
): void {
  const occurredAt = new Date().toISOString();
  const payload = extractExecutionAuditPayload({
    actorId: input.actorId,
    actorType: input.actorType,
    attemptNo: input.attemptNo,
    eventType: input.eventType,
    executionId: input.executionId,
    occurredAt,
    sourcePayload: input.sourcePayload,
  });
  const next = (database.prepare(
    "SELECT COALESCE(MAX(outbox_seq),0)+1 AS nextSeq FROM audit_event_outbox",
  ).get() as { nextSeq: number }).nextSeq;
  database.prepare(`
    INSERT INTO audit_event_outbox (
      id,project_id,source,event_type,payload_json,occurred_at,outbox_seq
    ) VALUES (?,?,'safe_execution',?,?,?,?)
  `).run(
    input.eventId,
    input.projectId,
    input.eventType,
    JSON.stringify(payload),
    occurredAt,
    next,
  );
}
