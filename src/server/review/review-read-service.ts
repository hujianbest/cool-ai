import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { openDatabase } from "@/src/server/db";
import { ReviewApiError } from "@/src/server/review/review-errors";
import {
  reviewAttemptDetailDtoSchema,
  reviewAttemptDtoSchema,
  reviewEventDtoSchema,
  reviewOutputSchema,
  reviewWorkspaceDtoSchema,
  type StrictReviewAttemptDto,
  type StrictReviewWorkspaceDto,
} from "@/src/shared/review-contracts";

type ReadQuery = { after?: string; limit?: string };
type Page<T> = { items: T[]; nextCursor: string | null };
type CursorPayload = {
  expiresAt: number;
  key: Array<number | string>;
  parent: string;
  route: string;
  version: 1;
};

const CURSOR_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_LIST_BYTES = 512 * 1_024;
const MAX_DETAIL_BYTES = 256 * 1_024;
const ERROR_CATEGORIES = new Set([
  "auth", "rate_limit", "upstream", "network", "timeout", "schema",
  "usage", "redaction", "interrupted", "stale",
]);

function cursorKey(databasePath: string): Buffer {
  return createHash("sha256").update(`review-cursor:${databasePath}`, "utf8").digest();
}

function encodeCursor(databasePath: string, payload: CursorPayload): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", cursorKey(databasePath))
    .update(`v1.${encoded}`, "utf8")
    .digest("base64url");
  return `v1.${encoded}.${signature}`;
}

function decodeCursor(
  databasePath: string,
  value: string | undefined,
  route: string,
  parent: string,
): Array<number | string> | null {
  if (!value) return null;
  try {
    const parts = value.split(".");
    if (parts.length !== 3 || parts[0] !== "v1") throw new Error("shape");
    const expected = createHmac("sha256", cursorKey(databasePath))
      .update(`v1.${parts[1]}`, "utf8")
      .digest();
    const actual = Buffer.from(parts[2]!, "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new Error("signature");
    }
    const payload = JSON.parse(
      Buffer.from(parts[1]!, "base64url").toString("utf8"),
    ) as CursorPayload;
    if (
      payload.version !== 1
      || payload.route !== route
      || payload.parent !== parent
      || !Array.isArray(payload.key)
      || !Number.isFinite(payload.expiresAt)
      || payload.expiresAt <= Date.now()
    ) {
      throw new Error("scope");
    }
    return payload.key;
  } catch {
    throw new ReviewApiError("INVALID_INPUT");
  }
}

function parseLimit(value: string | undefined, maximum: number): number {
  if (value === undefined) return maximum;
  if (!/^[1-9]\d*$/u.test(value)) throw new ReviewApiError("INVALID_INPUT");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    throw new ReviewApiError("INVALID_INPUT");
  }
  return parsed;
}

function assertBytes(value: unknown, maximum: number): void {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > maximum) {
    throw new ReviewApiError("RESPONSE_LIMIT_EXCEEDED");
  }
}

function boundedPage<T>(
  databasePath: string,
  route: string,
  parent: string,
  rows: T[],
  requested: number,
  key: (row: T) => Array<number | string>,
): Page<T> {
  const hasMore = rows.length > requested;
  const items = rows.slice(0, requested);
  const last = items.at(-1);
  const page = {
    items,
    nextCursor: hasMore && last
      ? encodeCursor(databasePath, {
          expiresAt: Date.now() + CURSOR_TTL_MS,
          key: key(last),
          parent,
          route,
          version: 1,
        })
      : null,
  };
  assertBytes(page, MAX_LIST_BYTES);
  return page;
}

function failureFor(status: string, categoryValue: unknown) {
  if (status === "calling" || status === "succeeded") return null;
  const raw = typeof categoryValue === "string" ? categoryValue : "";
  const aliases: Record<string, string> = {
    provider_auth: "auth",
    provider_timeout: "timeout",
    provider_unreachable: "network",
    provider_upstream: "upstream",
    rate_limited: "rate_limit",
    response_invalid: "schema",
    structured_output_invalid: "schema",
  };
  const category = aliases[raw] ?? raw;
  if (!ERROR_CATEGORIES.has(category)) {
    throw new ReviewApiError("REVIEW_INVARIANT_FAILED");
  }
  const apiErrorCode = ({
    auth: "PROVIDER_AUTH",
    network: "PROVIDER_UNREACHABLE",
    rate_limit: "RATE_LIMITED",
    redaction: "REVIEW_OUTPUT_REDACTED",
    schema: "STRUCTURED_OUTPUT_INVALID",
    timeout: "PROVIDER_TIMEOUT",
    upstream: "PROVIDER_UPSTREAM",
  } as Record<string, string | undefined>)[category] ?? null;
  return { apiErrorCode, category };
}

function finalizeProjection(row: Record<string, unknown>) {
  const checkpoint = row.parsedOutputHash && row.outputCheckpointedAt
    ? {
        checkpointedAt: row.outputCheckpointedAt,
        publicOutputHash: row.parsedOutputHash,
      }
    : null;
  const status = String(row.status);
  if (status === "calling") {
    return checkpoint
      ? { checkpoint, lastErrorCode: null, mode: "local-finalize-only", retryRequiresProvider: false }
      : { checkpoint: null, lastErrorCode: null, mode: "none", retryRequiresProvider: false };
  }
  if (status === "finalizing") {
    return {
      checkpoint,
      lastErrorCode: row.finalizeErrorCode ?? null,
      mode: "local-finalize-only",
      retryRequiresProvider: false,
    };
  }
  if (status === "failed") {
    if (!checkpoint) {
      return {
        checkpoint: null,
        lastErrorCode: row.errorCategory ?? null,
        mode: "new-provider-attempt",
        retryRequiresProvider: true,
      };
    }
    if (row.finalizeErrorCode) {
      return {
        checkpoint,
        lastErrorCode: row.finalizeErrorCode,
        mode: "local-finalize-only",
        retryRequiresProvider: false,
      };
    }
    return {
      checkpoint,
      lastErrorCode: row.errorCategory ?? null,
      mode: "none",
      retryRequiresProvider: false,
    };
  }
  if (status === "interrupted") {
    return {
      checkpoint: null,
      lastErrorCode: row.errorCategory ?? null,
      mode: "new-provider-attempt",
      retryRequiresProvider: true,
    };
  }
  return {
    checkpoint,
    lastErrorCode: null,
    mode: "none",
    retryRequiresProvider: false,
  };
}

function attemptDto(database: DatabaseSync, attemptId: string): StrictReviewAttemptDto {
  const row = database.prepare(`
    SELECT a.*,r.version AS resultVersion,g.name AS reviewerName,
      g.avatar_text AS avatarText,g.accent_token AS accentToken,
      p.name AS providerName
    FROM review_attempts a
    JOIN work_item_result_versions r ON r.id=a.result_id AND r.work_item_id=a.work_item_id
    JOIN agents g ON g.id=a.reviewer_agent_id
    JOIN providers p ON p.id=a.provider_id
    WHERE a.id=?
  `).get(attemptId) as Record<string, unknown> | undefined;
  if (!row) throw new ReviewApiError("REVIEW_NOT_FOUND");
  const calls = (database.prepare(`
    SELECT id,kind,call_index AS callIndex,status,prompt_tokens AS promptTokens,
      completion_tokens AS completionTokens,total_tokens AS totalTokens,
      error_category AS errorCategory,started_at AS startedAt,finished_at AS finishedAt
    FROM review_model_calls WHERE attempt_id=? ORDER BY call_index,id
  `).all(attemptId) as Array<Record<string, unknown>>).map((call) => ({
    callIndex: call.callIndex,
    failure: failureFor(String(call.status), call.errorCategory),
    finishedAt: call.finishedAt,
    id: call.id,
    kind: call.kind,
    startedAt: call.startedAt,
    status: call.status,
    usage: call.totalTokens === null
      ? {
          completionTokens: null,
          promptTokens: null,
          reported: false,
          totalTokens: null,
        }
      : {
          completionTokens: call.completionTokens,
          promptTokens: call.promptTokens,
          reported: true,
          totalTokens: call.totalTokens,
        },
  }));
  const decisionRow = database.prepare(`
    SELECT id,choice,public_summary AS publicSummary,findings_json AS findingsJson,
      evidence_refs_json AS evidenceRefsJson
    FROM review_decisions WHERE attempt_id=?
  `).get(attemptId) as Record<string, unknown> | undefined;
  const reported = calls.filter(({ usage }) => usage.reported);
  const value = {
    calls,
    decision: decisionRow
      ? {
          choice: decisionRow.choice,
          evidenceRefs: JSON.parse(String(decisionRow.evidenceRefsJson)),
          findings: JSON.parse(String(decisionRow.findingsJson)),
          id: decisionRow.id,
          publicSummary: decisionRow.publicSummary,
        }
      : null,
    errorCategory: row.error_category ?? null,
    finalize: finalizeProjection({
      errorCategory: row.error_category,
      finalizeErrorCode: row.finalize_error_code,
      outputCheckpointedAt: row.output_checkpointed_at,
      parsedOutputHash: row.parsed_output_hash,
      status: row.status,
    }),
    finishedAt: row.finished_at,
    id: row.id,
    material: {
      hash: row.frozen_material_hash,
      resultVersion: row.resultVersion,
      sourceCount: (
        JSON.parse(String(row.frozen_material_json)) as { sourceRefs?: unknown[] }
      ).sourceRefs?.length ?? 0,
    },
    provider: {
      id: row.provider_id,
      model: row.model,
      name: row.providerName,
      version: row.provider_version,
    },
    result: { id: row.result_id, version: row.resultVersion },
    reviewer: {
      accentToken: row.accentToken,
      avatarText: row.avatarText,
      id: row.reviewer_agent_id,
      name: row.reviewerName,
    },
    startedAt: row.started_at,
    status: row.status,
    usageTotal: {
      completionTokens: reported.reduce(
        (sum, call) => sum + Number(call.usage.completionTokens),
        0,
      ),
      promptTokens: reported.reduce(
        (sum, call) => sum + Number(call.usage.promptTokens),
        0,
      ),
      repairCalls: calls.filter(({ kind }) => kind === "repair").length,
      reportedCalls: reported.length,
      totalTokens: reported.reduce(
        (sum, call) => sum + Number(call.usage.totalTokens),
        0,
      ),
      unreportedCalls: calls.length - reported.length,
    },
  };
  const parsed = reviewAttemptDtoSchema.safeParse(value);
  if (!parsed.success) throw new ReviewApiError("REVIEW_INVARIANT_FAILED");
  return parsed.data;
}

function durableEventActor(
  database: DatabaseSync,
  row: Record<string, unknown>,
  payload: Record<string, unknown>,
): { actorId: string | null; actorType: "owner" | "agent" | "system" } {
  if (row.actorType !== "agent") {
    if (row.actorType === "owner" || row.actorType === "system") {
      return {
        actorId: typeof row.actorId === "string" ? row.actorId : null,
        actorType: row.actorType,
      };
    }
    throw new ReviewApiError("REVIEW_INVARIANT_FAILED");
  }
  const attemptId = typeof payload.attemptId === "string" ? payload.attemptId : null;
  const decisionId = typeof payload.decisionId === "string" ? payload.decisionId : null;
  const durable = attemptId
    ? database.prepare(`
        SELECT reviewer_agent_id AS actorId FROM review_attempts WHERE id=?
      `).get(attemptId)
    : decisionId
    ? database.prepare(`
        SELECT reviewer_agent_id AS actorId FROM review_decisions WHERE id=?
      `).get(decisionId)
    : undefined;
  const actor = durable as { actorId: string } | undefined;
  if (!actor || actor.actorId !== row.actorId) {
    throw new ReviewApiError("REVIEW_INVARIANT_FAILED");
  }
  return { actorId: actor.actorId, actorType: "agent" };
}

function schemaDataInvalid(): never {
  throw new ReviewApiError("SCHEMA_DATA_INVALID");
}

function exactPayload(
  payload: Record<string, unknown>,
  keys: readonly string[],
): void {
  const actual = Object.keys(payload).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    schemaDataInvalid();
  }
}

function recordPayload(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) schemaDataInvalid();
  return value as Record<string, unknown>;
}

const COMPLETION_REASONS = new Set([
  "DOWNSTREAM_REWORK_REQUESTED",
  "OWNER_REOPENED",
  "AGENT_REOPENED",
  "WORK_ITEM_MATERIAL_CHANGED",
]);

function completionReason(value: unknown): string {
  if (typeof value !== "string" || !COMPLETION_REASONS.has(value)) schemaDataInvalid();
  return value;
}

function eventIdentifier(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) schemaDataInvalid();
  return value;
}

function uniqueStartedFingerprint(
  database: DatabaseSync,
  missionId: string,
  sequence: number,
  operationId: unknown,
): string {
  if (typeof operationId !== "string" || operationId.length === 0) schemaDataInvalid();
  const rows = database.prepare(`
    SELECT payload_json AS payloadJson
    FROM review_events
    WHERE mission_id=? AND sequence<? AND type='delivery_generation_started'
      AND json_extract(payload_json,'$.operationId')=?
    ORDER BY sequence,id
  `).all(missionId, sequence, operationId) as Array<{ payloadJson: string }>;
  if (rows.length !== 1) schemaDataInvalid();
  let payload: Record<string, unknown>;
  try {
    payload = recordPayload(JSON.parse(rows[0]!.payloadJson));
  } catch {
    schemaDataInvalid();
  }
  exactPayload(payload!, ["operationId", "inputFingerprint"]);
  if (typeof payload!.inputFingerprint !== "string") schemaDataInvalid();
  return payload!.inputFingerprint;
}

function adaptStoredEvent(
  database: DatabaseSync,
  missionId: string,
  row: Record<string, unknown>,
  unsafePayload: unknown,
) {
  const payload = recordPayload(unsafePayload);
  const type = String(row.type);
  let canonicalType = type;
  let canonicalPayload: Record<string, unknown> = payload;

  switch (type) {
    case "work_item_review_passed":
      exactPayload(payload, ["headVersion", "workItemId"]);
      canonicalType = "legacy_work_item_review_passed";
      break;
    case "work_item_passed":
      if (!("reasonCode" in payload)) {
        exactPayload(payload, ["decisionId", "resultId", "workItemId"]);
        canonicalPayload = { ...payload, reasonCode: "review_passed" };
      }
      break;
    case "work_item_completion_invalidated":
      exactPayload(payload, ["reason", "workItemId"]);
      canonicalType = "legacy_work_item_completion_invalidated";
      canonicalPayload = {
        reasonCode: completionReason(payload.reason),
        workItemId: payload.workItemId,
      };
      break;
    case "review_escalated":
      exactPayload(payload, ["escalationId", "decisionId", "resultId", "workItemId"]);
      canonicalType = "escalation_opened";
      break;
    case "escalation_answered":
      if ("resultId" in payload || "workItemId" in payload) {
        exactPayload(payload, [
          "escalationId", "answerId", "action", "resultId", "workItemId",
        ]);
        const durable = database.prepare(`
          SELECT e.work_item_id AS workItemId,e.result_id AS resultId,
                 answer.id AS answerId,answer.action
          FROM review_escalations e
          JOIN review_escalation_answers answer ON answer.escalation_id=e.id
          WHERE e.id=?
        `).get(eventIdentifier(payload.escalationId)) as Record<string, unknown> | undefined;
        if (
          !durable
          || durable.workItemId !== payload.workItemId
          || durable.resultId !== payload.resultId
          || durable.answerId !== payload.answerId
          || durable.action !== payload.action
        ) schemaDataInvalid();
        canonicalPayload = {
          action: payload.action,
          answerId: payload.answerId,
          escalationId: payload.escalationId,
        };
      }
      break;
    case "mission_owner_terminated": {
      exactPayload(payload, ["escalationId", "missionId"]);
      if (payload.missionId !== missionId) schemaDataInvalid();
      const durable = database.prepare(`
        SELECT 1
        FROM review_escalations escalation
        JOIN review_escalation_answers answer ON answer.escalation_id=escalation.id
        JOIN review_decisions decision ON decision.id=escalation.decision_id
        JOIN review_attempts attempt ON attempt.id=decision.attempt_id
        WHERE escalation.id=? AND attempt.mission_id=?
          AND answer.action='terminate_mission'
      `).get(eventIdentifier(payload.escalationId), missionId);
      if (!durable) schemaDataInvalid();
      canonicalType = "mission_terminated";
      canonicalPayload = { reason: "owner_terminated" };
      break;
    }
    case "review_attempt_discarded":
      if ("reason" in payload || "workItemId" in payload) {
        exactPayload(payload, ["attemptId", "reason", "workItemId"]);
        if (payload.reason !== "MISSION_CONTEXT_CHANGED") schemaDataInvalid();
        const durable = database.prepare(`
          SELECT work_item_id AS workItemId,mission_id AS missionId
          FROM review_attempts WHERE id=?
        `).get(eventIdentifier(payload.attemptId)) as Record<string, unknown> | undefined;
        if (
          !durable
          || durable.workItemId !== payload.workItemId
          || durable.missionId !== missionId
        ) schemaDataInvalid();
        canonicalPayload = { attemptId: payload.attemptId, category: "context_changed" };
      }
      break;
    case "delivery_generation_failed":
    case "delivery_generation_interrupted":
      if ("errorCode" in payload) {
        exactPayload(payload, ["errorCode", "operationId"]);
        const interrupted = type === "delivery_generation_interrupted";
        if (
          payload.errorCode
          !== (interrupted
            ? "DELIVERY_GENERATION_INTERRUPTED"
            : "DELIVERY_GENERATION_FAILED")
        ) schemaDataInvalid();
        canonicalType = "delivery_generation_failed";
        canonicalPayload = {
          category: interrupted ? "interrupted" : "generation_failed",
          inputFingerprint: uniqueStartedFingerprint(
            database,
            missionId,
            Number(row.sequence),
            payload.operationId,
          ),
          operationId: payload.operationId,
        };
      }
      break;
    case "delivery_generation_completed": {
      exactPayload(payload, ["deliveryId", "inputFingerprint", "reused", "version"]);
      if (
        typeof payload.reused !== "boolean"
        || !Number.isInteger(payload.version)
        || Number(payload.version) < 1
      ) schemaDataInvalid();
      const durable = database.prepare(`
        SELECT 1 FROM mission_deliveries
        WHERE id=? AND mission_id=? AND version=? AND input_fingerprint=?
      `).get(
        eventIdentifier(payload.deliveryId),
        missionId,
        Number(payload.version),
        eventIdentifier(payload.inputFingerprint),
      );
      if (!durable) schemaDataInvalid();
      canonicalType = "delivery_completed";
      canonicalPayload = {
        deliveryId: payload.deliveryId,
        deliveryVersion: payload.version,
        inputFingerprint: payload.inputFingerprint,
      };
      break;
    }
    case "mission_delivery_invalidated":
      if ("workItemId" in payload) {
        exactPayload(payload, ["deliveryId", "reason", "workItemId"]);
        canonicalPayload = {
          deliveryId: payload.deliveryId,
          reasonCode: completionReason(payload.reason),
          workItemIds: [payload.workItemId],
        };
      } else {
        exactPayload(payload, ["deliveryId", "operationId", "reason"]);
        if (payload.reason !== "MISSION_CONTEXT_CHANGED") schemaDataInvalid();
        const durable = database.prepare(`
          SELECT 1 FROM review_operations
          WHERE id=? AND kind='generate_delivery' AND parent_id=?
        `).get(eventIdentifier(payload.operationId), missionId);
        if (!durable) schemaDataInvalid();
        canonicalPayload = {
          deliveryId: payload.deliveryId,
          reasonCode: payload.reason,
          workItemIds: [],
        };
      }
      canonicalType = "delivery_invalidated";
      break;
  }

  const parsed = reviewEventDtoSchema.safeParse({
    ...row,
    ...durableEventActor(database, row, canonicalPayload),
    payload: canonicalPayload,
    type: canonicalType,
  });
  if (!parsed.success) schemaDataInvalid();
  return parsed.data;
}

function candidates(database: DatabaseSync, projectId: string, executorAgentId: string) {
  return (database.prepare(`
    SELECT a.id,a.name,a.role,a.avatar_text AS avatarText,
      a.accent_token AS accentToken,p.id AS providerId,p.name AS providerName,a.model
    FROM project_memberships m
    JOIN agents a ON a.id=m.agent_id
    JOIN providers p ON p.id=a.provider_id
    WHERE m.project_id=? AND a.review_capable=1 AND a.id<>?
    ORDER BY a.created_at,a.id
  `).all(projectId, executorAgentId) as Array<Record<string, unknown>>).map((row) => ({
    agent: {
      accentToken: row.accentToken,
      avatarText: row.avatarText,
      id: row.id,
      name: row.name,
      role: row.role,
    },
    provider: { id: row.providerId, model: row.model, name: row.providerName },
    qualification: ["current_member", "review_capable", "not_executor"] as const,
  }));
}

function escalationRows(database: DatabaseSync, resultId: string) {
  return database.prepare(`
    SELECT escalation.id AS escalationId,escalation.result_id AS resultId,
           decision.attempt_id AS attemptId,escalation.question,
           escalation.options_json AS optionsJson,escalation.created_at AS createdAt,
           answer.id AS answerId,answer.action,answer.answer,
           answer.created_at AS answerCreatedAt
    FROM review_escalations escalation
    JOIN review_decisions decision ON decision.id=escalation.decision_id
    LEFT JOIN review_escalation_answers answer
      ON answer.escalation_id=escalation.id
    WHERE escalation.result_id=?
    ORDER BY escalation.created_at,escalation.id
  `).all(resultId) as Array<Record<string, unknown>>;
}

function openEscalation(row: Record<string, unknown>) {
  return {
    attemptId: row.attemptId,
    createdAt: row.createdAt,
    escalationId: row.escalationId,
    options: JSON.parse(String(row.optionsJson)),
    question: row.question,
    resultId: row.resultId,
  };
}

function answeredEscalation(row: Record<string, unknown>) {
  return {
    answer: {
      action: row.action,
      answer: row.answer,
      answerId: row.answerId,
      answerVersion: 1 as const,
      createdAt: row.answerCreatedAt,
    },
    attemptId: row.attemptId,
    escalationId: row.escalationId,
    resultId: row.resultId,
  };
}

export function readReviewWorkspace(
  databasePath: string,
  workItemId: string,
): StrictReviewWorkspaceDto {
  const database = openDatabase(databasePath);
  try {
    const row = database.prepare(`
      SELECT h.project_id AS projectId,h.state,h.version AS headVersion,
        h.current_attempt_id AS currentAttemptId,w.id AS workItemId,w.title,
        w.version AS workItemVersion,w.status AS boardStatus,
        mission_head.state AS missionState,
        r.id AS resultId,r.version AS resultVersion,
        r.executor_agent_id AS executorAgentId,r.created_at AS resultCreatedAt
      FROM work_item_review_heads h
      JOIN work_items w ON w.id=h.work_item_id
      JOIN mission_delivery_heads mission_head ON mission_head.mission_id=h.mission_id
      LEFT JOIN work_item_result_versions r ON r.id=h.current_result_id
      WHERE h.work_item_id=?
    `).get(workItemId) as Record<string, unknown> | undefined;
    if (!row) throw new ReviewApiError("WORK_ITEM_NOT_FOUND");
    const eligible = row.executorAgentId
      ? candidates(database, String(row.projectId), String(row.executorAgentId))
      : [];
    const history = database.prepare(
      "SELECT COUNT(*) AS count FROM review_attempts WHERE work_item_id=?",
    ).get(workItemId) as { count: number };
    const escalations = row.resultId
      ? escalationRows(database, String(row.resultId))
      : [];
    const open = escalations.filter(({ answerId }) => answerId === null);
    if (
      (row.state === "waiting_owner"
        && row.missionState !== "owner_terminated"
        && open.length !== 1)
      || (row.state !== "waiting_owner" && open.length !== 0)
    ) {
      throw new ReviewApiError("REVIEW_INVARIANT_FAILED");
    }
    const value = {
      answeredEscalations: escalations
        .filter(({ answerId }) => answerId !== null)
        .sort((left, right) =>
          String(left.answerCreatedAt).localeCompare(String(right.answerCreatedAt))
          || String(left.answerId).localeCompare(String(right.answerId)))
        .map(answeredEscalation),
      blockers: eligible.length === 0 && row.resultId
        ? [{ code: "NO_INDEPENDENT_REVIEWER", refId: null }]
        : [],
      candidates: eligible,
      currentAttempt: row.currentAttemptId
        ? attemptDto(database, String(row.currentAttemptId))
        : null,
      currentEscalation: open[0] ? openEscalation(open[0]) : null,
      effectiveStatus: row.state,
      headVersion: row.headVersion,
      historyCount: history.count,
      result: row.resultId
        ? {
            createdAt: row.resultCreatedAt,
            executorAgentId: row.executorAgentId,
            id: row.resultId,
            version: row.resultVersion,
          }
        : null,
      workItem: {
        boardStatus: row.boardStatus,
        id: row.workItemId,
        title: row.title,
        version: row.workItemVersion,
      },
    };
    const parsed = reviewWorkspaceDtoSchema.safeParse(value);
    if (!parsed.success) throw new ReviewApiError("REVIEW_INVARIANT_FAILED");
    assertBytes(parsed.data, MAX_DETAIL_BYTES);
    return parsed.data;
  } catch (error) {
    if (error instanceof ReviewApiError) throw error;
    throw new ReviewApiError("REVIEW_INVARIANT_FAILED");
  } finally {
    database.close();
  }
}

export function listReviewAttempts(
  databasePath: string,
  workItemId: string,
  query: ReadQuery,
): Page<StrictReviewAttemptDto> {
  const requested = parseLimit(query.limit, 20);
  const key = decodeCursor(databasePath, query.after, "review-history", workItemId);
  const startedAt = key?.[0];
  const id = key?.[1];
  if (key && (key.length !== 2 || typeof startedAt !== "string" || typeof id !== "string")) {
    throw new ReviewApiError("INVALID_INPUT");
  }
  const database = openDatabase(databasePath);
  try {
    const exists = database.prepare(
      "SELECT 1 FROM work_item_review_heads WHERE work_item_id=?",
    ).get(workItemId);
    if (!exists) throw new ReviewApiError("WORK_ITEM_NOT_FOUND");
    const rows = database.prepare(`
      SELECT id,started_at AS startedAt FROM review_attempts
      WHERE work_item_id=?
        AND (? IS NULL OR started_at>? OR (started_at=? AND id>?))
      ORDER BY started_at,id LIMIT ?
    `).all(
      workItemId,
      startedAt ?? null,
      startedAt ?? null,
      startedAt ?? null,
      id ?? null,
      requested + 1,
    ) as Array<{ id: string; startedAt: string }>;
    const values = rows.map(({ id: attemptId }) => attemptDto(database, attemptId));
    return boundedPage(
      databasePath,
      "review-history",
      workItemId,
      values,
      requested,
      ({ id: attemptId, startedAt: started }) => [started, attemptId],
    );
  } catch (error) {
    if (error instanceof ReviewApiError) throw error;
    throw new ReviewApiError("REVIEW_INVARIANT_FAILED");
  } finally {
    database.close();
  }
}

export function readReviewAttemptDetail(databasePath: string, attemptId: string) {
  const database = openDatabase(databasePath);
  try {
    const attempt = attemptDto(database, attemptId);
    const row = database.prepare(`
      SELECT frozen_material_json AS frozenMaterialJson
      FROM review_attempts WHERE id=?
    `).get(attemptId) as { frozenMaterialJson: string };
    const escalation = database.prepare(`
      SELECT e.id AS escalationId,e.result_id AS resultId,
             d.attempt_id AS attemptId,e.question,e.options_json AS optionsJson,
             e.created_at AS createdAt,answer.id AS answerId,answer.action,
             answer.answer,answer.created_at AS answerCreatedAt
      FROM review_escalations e
      JOIN review_decisions d ON d.id=e.decision_id
      LEFT JOIN review_escalation_answers answer ON answer.escalation_id=e.id
      WHERE d.attempt_id=?
    `).get(attemptId) as Record<string, unknown> | undefined;
    const associations = database.prepare(`
      SELECT a.candidate_id AS candidateId,a.decision_id AS decisionId,
        a.memory_id AS memoryId,a.outcome,m.version AS memoryVersion
      FROM review_memory_associations a
      JOIN review_memory_candidates c ON c.id=a.candidate_id
      JOIN memory_entries m ON m.id=a.memory_id
      WHERE c.attempt_id=? ORDER BY c.position,c.id
    `).all(attemptId);
    const value = {
      ...attempt,
      answeredEscalations: escalation?.answerId
        ? [answeredEscalation(escalation)]
        : [],
      candidateAssociations: associations,
      currentEscalation: escalation && !escalation.answerId
        ? openEscalation(escalation)
        : null,
      frozenMaterial: JSON.parse(row.frozenMaterialJson),
    };
    const parsed = reviewAttemptDetailDtoSchema.safeParse(value);
    if (!parsed.success) throw new ReviewApiError("REVIEW_INVARIANT_FAILED");
    assertBytes(parsed.data, MAX_DETAIL_BYTES);
    return parsed.data;
  } catch (error) {
    if (error instanceof ReviewApiError) throw error;
    throw new ReviewApiError("REVIEW_INVARIANT_FAILED");
  } finally {
    database.close();
  }
}

export function listReviewEventsFromDatabase(
  database: DatabaseSync,
  databasePath: string,
  missionId: string,
  query: ReadQuery,
) {
  const requested = parseLimit(query.limit, 100);
  const key = decodeCursor(databasePath, query.after, "review-events", missionId);
  const sequence = key?.[0];
  const id = key?.[1];
  if (key && (key.length !== 2 || !Number.isInteger(sequence) || typeof id !== "string")) {
    throw new ReviewApiError("INVALID_INPUT");
  }
  const exists = database.prepare("SELECT 1 FROM missions WHERE id=?").get(missionId);
  if (!exists) throw new ReviewApiError("PROJECT_NOT_FOUND");
  const rows = database.prepare(`
    SELECT id,sequence,type,actor_type AS actorType,actor_id AS actorId,
      payload_json AS payloadJson,created_at AS createdAt
    FROM review_events WHERE mission_id=?
      AND (? IS NULL OR sequence>? OR (sequence=? AND id>?))
    ORDER BY sequence,id LIMIT ?
  `).all(
    missionId,
    sequence ?? null,
    sequence ?? null,
    sequence ?? null,
    id ?? null,
    requested + 1,
  ) as Array<Record<string, unknown>>;
  const values = rows.map(({ payloadJson, ...row }) => {
    let payload: unknown;
    try {
      payload = JSON.parse(String(payloadJson));
    } catch {
      schemaDataInvalid();
    }
    return adaptStoredEvent(database, missionId, row, payload);
  });
  return boundedPage(
    databasePath,
    "review-events",
    missionId,
    values,
    requested,
    ({ id: eventId, sequence: eventSequence }) => [eventSequence, eventId],
  );
}

export function listReviewEvents(
  databasePath: string,
  missionId: string,
  query: ReadQuery,
) {
  const database = openDatabase(databasePath);
  try {
    return listReviewEventsFromDatabase(database, databasePath, missionId, query);
  } catch (error) {
    if (error instanceof ReviewApiError) throw error;
    throw new ReviewApiError("SCHEMA_DATA_INVALID");
  } finally {
    database.close();
  }
}

export class ReviewPersistenceInvariantError extends Error {
  readonly code = "REVIEW_INVARIANT_FAILED";
  readonly status = 500;
}

function persistenceInvariant(value: unknown, message: string): asserts value {
  if (!value) throw new ReviewPersistenceInvariantError(message);
}

export function assertReviewPersistenceInvariants(database: DatabaseSync): void {
  const attempts = database.prepare(`
    SELECT a.id,a.status,a.result_id AS resultId,a.parsed_output_json AS output,
           a.parsed_output_hash AS outputHash,a.output_checkpointed_at AS checkpointedAt,
           h.state AS headState,h.current_attempt_id AS headAttemptId,
           h.current_result_id AS headResultId,w.status AS board,
           count(d.id) AS decisions,min(d.choice) AS choice
    FROM review_attempts a
    LEFT JOIN work_item_review_heads h ON h.work_item_id=a.work_item_id
    LEFT JOIN work_items w ON w.id=a.work_item_id
    LEFT JOIN review_decisions d ON d.attempt_id=a.id
    GROUP BY a.id ORDER BY a.id
  `).all() as Array<Record<string, unknown>>;
  for (const row of attempts) {
    const parts = [row.output, row.outputHash, row.checkpointedAt];
    const checkpointed = parts.every((value) => value !== null);
    persistenceInvariant(
      checkpointed || parts.every((value) => value === null),
      `Attempt ${row.id} has a partial checkpoint.`,
    );
    if (checkpointed) {
      persistenceInvariant(
        createHash("sha256").update(String(row.output), "utf8").digest("hex") === row.outputHash,
        `Attempt ${row.id} has an invalid checkpoint hash.`,
      );
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(row.output));
      } catch {
        throw new ReviewPersistenceInvariantError(`Attempt ${row.id} has invalid checkpoint JSON.`);
      }
      persistenceInvariant(
        reviewOutputSchema.safeParse(parsed).success,
        `Attempt ${row.id} has invalid checkpoint content.`,
      );
    }
    persistenceInvariant(
      !["finalizing", "rejected", "escalated", "passed"].includes(String(row.status))
        || checkpointed,
      `Attempt ${row.id} has no checkpoint.`,
    );
    if (["calling", "finalizing"].includes(String(row.status))) {
      persistenceInvariant(
        row.headState === "reviewing"
          && row.headAttemptId === row.id
          && row.headResultId === row.resultId,
        `Attempt ${row.id} is detached from its active head.`,
      );
    }
    const choice = row.status === "rejected"
      ? "reject"
      : row.status === "escalated"
      ? "escalate"
      : row.status === "passed"
      ? "pass"
      : null;
    persistenceInvariant(
      choice === null
        ? Number(row.decisions) === 0
        : Number(row.decisions) === 1 && row.choice === choice,
      `Attempt ${row.id} has partial decision rows.`,
    );
    if (row.status === "passed") {
      persistenceInvariant(
        row.headState === "passed" && row.headAttemptId === row.id && row.board === "done",
        `Attempt ${row.id} has a drifted pass projection.`,
      );
    }
    persistenceInvariant(
      row.board !== "done" || (row.status === "passed" && row.headState === "passed"),
      `Attempt ${row.id} has an unreviewed done projection.`,
    );
  }
  persistenceInvariant(!database.prepare(`
    SELECT h.mission_id FROM mission_delivery_heads h
    LEFT JOIN mission_deliveries d
      ON d.mission_id=h.mission_id AND d.id=h.current_delivery_id
    WHERE (h.state='completed' AND d.id IS NULL)
       OR (h.state<>'completed' AND h.current_delivery_id IS NOT NULL)
    LIMIT 1
  `).get(), "Delivery head has drifted.");
  persistenceInvariant(!database.prepare(`
    SELECT h.mission_id FROM mission_delivery_heads h
    WHERE h.next_event_sequence<>(SELECT count(*)+1 FROM review_events e
                                  WHERE e.mission_id=h.mission_id)
    LIMIT 1
  `).get(), "Review event history has drifted.");
}

export function reconcileReviewPersistence(
  database: DatabaseSync,
  dependencies: { clock?: () => Date; randomUUID?: () => string } = {},
): { interruptedAttemptIds: string[] } {
  assertReviewPersistenceInvariants(database);
  const now = (dependencies.clock ?? (() => new Date()))().toISOString();
  const ids = database.prepare(`
    SELECT id FROM review_attempts
    WHERE status='calling' AND lease_expires_at<=? ORDER BY id
  `).all(now) as Array<{ id: string }>;
  const interruptedAttemptIds: string[] = [];
  for (const { id } of ids) {
    database.exec("BEGIN IMMEDIATE");
    try {
      const row = database.prepare(`
        SELECT project_id AS projectId,mission_id AS missionId,
               work_item_id AS workItemId,operation_id AS operationId
        FROM review_attempts WHERE id=? AND status='calling' AND lease_expires_at<=?
      `).get(id, now) as Record<string, string> | undefined;
      if (!row) {
        database.exec("COMMIT");
        continue;
      }
      database.prepare(`
        UPDATE review_attempts SET status='interrupted',error_category='interrupted',finished_at=?
        WHERE id=? AND status='calling'
      `).run(now, id);
      database.prepare(`
        UPDATE review_model_calls SET status='interrupted',error_category='interrupted',finished_at=?
        WHERE attempt_id=? AND status='calling'
      `).run(now, id);
      persistenceInvariant(database.prepare(`
        UPDATE work_item_review_heads
        SET state='pending_review',current_attempt_id=NULL,version=version+1,updated_at=?
        WHERE work_item_id=? AND current_attempt_id=? AND state='reviewing'
      `).run(now, row.workItemId, id).changes === 1, "Interrupted attempt lost its head.");
      const response = JSON.stringify({
        attemptId: id,
        errorCategory: "interrupted",
        retry: { attemptId: id, kind: "new-provider-attempt", providerCallRequired: true },
        state: "failed",
      });
      persistenceInvariant(database.prepare(`
        UPDATE review_operations SET status='completed',http_status=409,response_json=?,updated_at=?
        WHERE project_id=? AND id=? AND status='pending'
      `).run(response, now, row.projectId, row.operationId).changes === 1,
      "Interrupted attempt lost its receipt.");
      const eventHead = database.prepare(`
        SELECT next_event_sequence AS sequence FROM mission_delivery_heads
        WHERE project_id=? AND mission_id=?
      `).get(row.projectId, row.missionId) as { sequence: number } | undefined;
      persistenceInvariant(eventHead, "Interrupted attempt lost its event head.");
      database.prepare(`
        INSERT INTO review_events(
          id,project_id,mission_id,sequence,type,actor_type,actor_id,payload_json,created_at
        ) VALUES (?, ?, ?, ?, 'review_attempt_interrupted','system',NULL,?,?)
      `).run(
        (dependencies.randomUUID ?? randomUUID)(),
        row.projectId,
        row.missionId,
        eventHead.sequence,
        JSON.stringify({ attemptId: id, category: "interrupted" }),
        now,
      );
      persistenceInvariant(database.prepare(`
        UPDATE mission_delivery_heads
        SET next_event_sequence=next_event_sequence+1,updated_at=?
        WHERE project_id=? AND mission_id=? AND next_event_sequence=?
      `).run(now, row.projectId, row.missionId, eventHead.sequence).changes === 1,
      "Interrupted attempt lost its event sequence.");
      database.exec("COMMIT");
      interruptedAttemptIds.push(id);
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Preserve the fail-closed recovery error.
      }
      throw error;
    }
  }
  assertReviewPersistenceInvariants(database);
  return { interruptedAttemptIds };
}
