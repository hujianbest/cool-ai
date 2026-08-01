import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { openDatabase } from "@/src/server/db";
import { completionBlockersTx } from "@/src/server/review/completion-gate";
import { ReviewApiError } from "@/src/server/review/review-errors";
import {
  deliveryVersionDtoSchema,
  missionCompletionDtoSchema,
  type DeliveryVersionDto,
  type MissionCompletionDto,
} from "@/src/shared/review-contracts";

type ReadQuery = { after?: string; limit?: string };
type CursorPayload = {
  expiresAt: number;
  key: [number, string];
  missionId: string;
  route: "delivery-history";
  version: 1;
};

const CURSOR_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_LIST_BYTES = 512 * 1024;
const MAX_DETAIL_BYTES = 256 * 1024;

function key(databasePath: string): Buffer {
  return createHash("sha256").update(`delivery-cursor:${databasePath}`, "utf8").digest();
}

function encodeCursor(databasePath: string, payload: CursorPayload): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", key(databasePath))
    .update(`v1.${encoded}`, "utf8")
    .digest("base64url");
  return `v1.${encoded}.${signature}`;
}

function decodeCursor(
  databasePath: string,
  value: string | undefined,
  missionId: string,
): [number, string] | null {
  if (!value) return null;
  try {
    const parts = value.split(".");
    if (parts.length !== 3 || parts[0] !== "v1") throw new Error("shape");
    const expected = createHmac("sha256", key(databasePath))
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
      || payload.route !== "delivery-history"
      || payload.missionId !== missionId
      || payload.expiresAt <= Date.now()
      || !Array.isArray(payload.key)
      || payload.key.length !== 2
      || !Number.isInteger(payload.key[0])
      || typeof payload.key[1] !== "string"
    ) throw new Error("scope");
    return payload.key;
  } catch {
    throw new ReviewApiError("INVALID_INPUT");
  }
}

function parseLimit(value: string | undefined): number {
  if (value === undefined) return 20;
  if (!/^[1-9]\d*$/u.test(value)) throw new ReviewApiError("INVALID_INPUT");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > 20) throw new ReviewApiError("INVALID_INPUT");
  return parsed;
}

function assertBytes(value: unknown, maximum: number): void {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > maximum) {
    throw new ReviewApiError("RESPONSE_LIMIT_EXCEEDED");
  }
}

function parseObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("shape");
    return parsed as Record<string, unknown>;
  } catch {
    throw new ReviewApiError("DELIVERY_INVARIANT_FAILED");
  }
}

function invalidationFor(
  database: DatabaseSync,
  missionId: string,
  deliveryId: string,
): { reason: string | null; workItemIds: string[] } {
  const rows = database.prepare(`
    SELECT payload_json AS payloadJson FROM review_events
    WHERE mission_id=? AND type IN ('delivery_invalidated','mission_delivery_invalidated')
    ORDER BY sequence,id
  `).all(missionId) as Array<{ payloadJson: string }>;
  let result = { reason: null as string | null, workItemIds: [] as string[] };
  for (const row of rows) {
    const payload = parseObject(row.payloadJson);
    if (payload.deliveryId !== deliveryId) continue;
    const reason = payload.reasonCode ?? payload.reason;
    const workItemIds = Array.isArray(payload.workItemIds)
      ? payload.workItemIds
      : typeof payload.workItemId === "string"
      ? [payload.workItemId]
      : [];
    if (
      typeof reason !== "string"
      || workItemIds.some((id) => typeof id !== "string")
    ) throw new ReviewApiError("DELIVERY_INVARIANT_FAILED");
    result = { reason, workItemIds: workItemIds as string[] };
  }
  return result;
}

function deliveryDto(
  database: DatabaseSync,
  row: Record<string, unknown>,
  currentDeliveryId: string | null,
): DeliveryVersionDto {
  const invalidation = invalidationFor(database, String(row.missionId), String(row.id));
  const bundle = {
    blockers: [],
    inputFingerprint: row.inputFingerprint,
    manifest: parseObject(String(row.manifestJson)),
    summary: parseObject(String(row.summaryJson)),
  };
  const value = {
    bundle,
    createdAt: row.createdAt,
    id: row.id,
    invalidatedReason: invalidation.reason,
    invalidatedWorkItemIds: invalidation.workItemIds,
    state: row.id === currentDeliveryId && !invalidation.reason ? "completed" : "invalidated",
    version: row.version,
  };
  const parsed = deliveryVersionDtoSchema.safeParse(value);
  if (!parsed.success) throw new ReviewApiError("DELIVERY_INVARIANT_FAILED");
  return parsed.data;
}

function hasCompletionTables(database: DatabaseSync): boolean {
  const names = new Set((database.prepare(`
    SELECT name FROM sqlite_master WHERE type='table' AND name IN (
      'work_items','work_item_review_heads','work_item_dependencies',
      'review_escalations','review_decisions','review_attempts',
      'review_memory_candidates','review_memory_associations'
    )
  `).all() as Array<{ name: string }>).map(({ name }) => name));
  return names.size === 8;
}

export function readMissionDelivery(
  databasePath: string,
  missionId: string,
): MissionCompletionDto {
  const database = openDatabase(databasePath);
  try {
    const row = database.prepare(`
      SELECT h.state,h.current_delivery_id AS currentDeliveryId,
             h.last_error_code AS lastErrorCode,h.version
      FROM mission_delivery_heads h
      JOIN missions mission ON mission.id=h.mission_id AND mission.project_id=h.project_id
      WHERE h.mission_id=?
    `).get(missionId) as Record<string, unknown> | undefined;
    if (!row) throw new ReviewApiError("PROJECT_NOT_FOUND");
    const deliveryRow = row.currentDeliveryId
      ? database.prepare(`
          SELECT id,mission_id AS missionId,version,input_fingerprint AS inputFingerprint,
                 summary_json AS summaryJson,evidence_manifest_json AS manifestJson,
                 created_at AS createdAt
          FROM mission_deliveries WHERE mission_id=? AND id=?
        `).get(missionId, String(row.currentDeliveryId)) as Record<string, unknown> | undefined
      : undefined;
    if (row.currentDeliveryId && !deliveryRow) {
      throw new ReviewApiError("DELIVERY_INVARIANT_FAILED");
    }
    const blockers = hasCompletionTables(database)
      ? completionBlockersTx(database, missionId).map((blocker) => ({
          ...blocker,
          refId: null,
        }))
      : [];
    const value = {
      blockers,
      currentDelivery: deliveryRow
        ? deliveryDto(database, deliveryRow, String(row.currentDeliveryId))
        : null,
      currentDeliveryId: row.currentDeliveryId,
      lastErrorCode: row.lastErrorCode,
      missionId,
      retry: row.lastErrorCode ? { kind: "explicit-owner-retry" } : null,
      state: row.state,
      version: row.version,
    };
    const parsed = missionCompletionDtoSchema.safeParse(value);
    if (!parsed.success) throw new ReviewApiError("DELIVERY_INVARIANT_FAILED");
    assertBytes(parsed.data, MAX_DETAIL_BYTES);
    return parsed.data;
  } catch (error) {
    if (error instanceof ReviewApiError) throw error;
    throw new ReviewApiError("DELIVERY_INVARIANT_FAILED");
  } finally {
    database.close();
  }
}

export function listMissionDeliveries(
  databasePath: string,
  missionId: string,
  query: ReadQuery,
): { items: DeliveryVersionDto[]; nextCursor: string | null } {
  const limit = parseLimit(query.limit);
  const cursor = decodeCursor(databasePath, query.after, missionId);
  const database = openDatabase(databasePath);
  try {
    const head = database.prepare(`
      SELECT current_delivery_id AS currentDeliveryId
      FROM mission_delivery_heads WHERE mission_id=?
    `).get(missionId) as { currentDeliveryId: string | null } | undefined;
    if (!head) throw new ReviewApiError("PROJECT_NOT_FOUND");
    const rows = database.prepare(`
      SELECT id,mission_id AS missionId,version,input_fingerprint AS inputFingerprint,
             summary_json AS summaryJson,evidence_manifest_json AS manifestJson,
             created_at AS createdAt
      FROM mission_deliveries WHERE mission_id=?
        AND (? IS NULL OR version<? OR (version=? AND id<?))
      ORDER BY version DESC,id DESC LIMIT ?
    `).all(
      missionId,
      cursor?.[0] ?? null,
      cursor?.[0] ?? null,
      cursor?.[0] ?? null,
      cursor?.[1] ?? null,
      limit + 1,
    ) as Array<Record<string, unknown>>;
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit)
      .map((row) => deliveryDto(database, row, head.currentDeliveryId));
    const last = items.at(-1);
    const result = {
      items,
      nextCursor: hasMore && last
        ? encodeCursor(databasePath, {
            expiresAt: Date.now() + CURSOR_TTL_MS,
            key: [last.version, last.id],
            missionId,
            route: "delivery-history",
            version: 1,
          })
        : null,
    };
    assertBytes(result, MAX_LIST_BYTES);
    return result;
  } catch (error) {
    if (error instanceof ReviewApiError) throw error;
    throw new ReviewApiError("DELIVERY_INVARIANT_FAILED");
  } finally {
    database.close();
  }
}
