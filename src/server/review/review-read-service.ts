import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { openDatabase } from "@/src/server/db";
import { ReviewApiError } from "@/src/server/review/review-errors";
import {
  reviewAttemptDetailDtoSchema,
  reviewAttemptDtoSchema,
  reviewEventDtoSchema,
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
        r.id AS resultId,r.version AS resultVersion,
        r.executor_agent_id AS executorAgentId,r.created_at AS resultCreatedAt
      FROM work_item_review_heads h
      JOIN work_items w ON w.id=h.work_item_id
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
    const value = {
      blockers: eligible.length === 0 && row.resultId
        ? [{ code: "NO_INDEPENDENT_REVIEWER", refId: null }]
        : [],
      candidates: eligible,
      currentAttempt: row.currentAttemptId
        ? attemptDto(database, String(row.currentAttemptId))
        : null,
      effectiveStatus: row.state,
      escalation: null,
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
      SELECT e.id,e.question,e.options_json AS optionsJson,e.created_at AS createdAt
      FROM review_escalations e
      JOIN review_decisions d ON d.id=e.decision_id
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
      candidateAssociations: associations,
      escalation: escalation
        ? {
            createdAt: escalation.createdAt,
            id: escalation.id,
            options: JSON.parse(String(escalation.optionsJson)),
            question: escalation.question,
          }
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

export function listReviewEvents(
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
  const database = openDatabase(databasePath);
  try {
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
      const payload = JSON.parse(String(payloadJson)) as Record<string, unknown>;
      return reviewEventDtoSchema.parse({
        ...row,
        ...durableEventActor(database, row, payload),
        payload,
      });
    });
    return boundedPage(
      databasePath,
      "review-events",
      missionId,
      values,
      requested,
      ({ id: eventId, sequence: eventSequence }) => [eventSequence, eventId],
    );
  } catch (error) {
    if (error instanceof ReviewApiError) throw error;
    throw new ReviewApiError("REVIEW_INVARIANT_FAILED");
  } finally {
    database.close();
  }
}
