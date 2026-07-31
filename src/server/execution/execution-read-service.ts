import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

import { openDatabase } from "@/src/server/db";
import {
  assertNoMergeBarrier,
  recoverIncompleteMergeJournals,
} from "@/src/server/execution/merge-journal-service";
import {
  ExecutionError,
  executionDtoFromDatabase,
} from "@/src/server/execution/execution-service";
import {
  executionApprovalDtoSchema,
  executionDtoSchema,
} from "@/src/shared/execution-contracts";

type ReadQuery = {
  after?: string;
  limit?: string;
  offset?: string;
};

type CursorPayload = {
  expiresAt: number;
  key: Array<string | number>;
  parent: string;
  route: string;
  version: 1;
};

type CursorPage<T> = {
  items: T[];
  nextCursor: string | null;
};

const HASH = z.string().regex(/^[0-9a-f]{64}$/u);
const MAX_LIST_BYTES = 512 * 1024;
const MAX_DETAIL_BYTES = 256 * 1024;
const MAX_CHUNK_BYTES = 65_536;
const MAX_CHUNK_ENVELOPE_BYTES = 72 * 1024;
const MAX_BODY_BYTES = 1_048_576;
const CURSOR_TTL_MS = 24 * 60 * 60 * 1000;

const eventPayloadSchemas: Record<string, z.ZodType> = {
  action_finished: z.object({
    actionId: z.string(), actionIndex: z.number().int(), code: z.string().nullable(),
    kind: z.string(), operationId: z.string(), status: z.string(),
  }).strict(),
  action_reconciled: z.object({
    actionId: z.string(), actionIndex: z.number().int(), kind: z.string(),
    operationId: z.string(), resumeTarget: z.string().nullable(),
  }).strict(),
  action_started: z.object({
    actionId: z.string(), actionIndex: z.number().int(), attemptNo: z.number().int(),
    kind: z.string(), operationId: z.string(), overallDeadlineAt: z.string(),
  }).strict(),
  status_changed: z.object({
    from: z.string(), reasonCode: z.string().nullable(), to: z.string(),
  }).strict(),
};

const eventSchema = z.object({
  actorId: z.string().nullable(),
  actorType: z.enum(["owner", "agent", "system"]),
  attemptNo: z.number().int().positive(),
  createdAt: z.string(),
  id: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
  sequence: z.number().int().positive(),
  type: z.string().min(1),
}).strict().superRefine((event, context) => {
  const schema = eventPayloadSchemas[event.type];
  if (!schema) return;
  const parsed = schema.safeParse(event.payload);
  if (!parsed.success) {
    context.addIssue({ code: "custom", message: "Stored execution event is invalid." });
  }
});

const artifactSchema = z.object({
  contentBytes: z.number().int().min(0).max(MAX_BODY_BYTES),
  createdAt: z.string(),
  id: z.string().min(1),
  name: z.string().min(1),
  path: z.string().min(1),
  sha256: HASH,
  truncated: z.boolean(),
}).strict();

const textChunkSchema = z.object({
  byteLength: z.number().int().min(1).max(MAX_CHUNK_BYTES),
  byteOffset: z.number().int().min(0).max(MAX_BODY_BYTES - 1),
  chunkIndex: z.number().int().min(0).max(16),
  sha256: HASH,
  stream: z.enum(["stdout", "stderr", "artifact"]),
  text: z.string(),
}).strict();

const stagedObservationSchema = z.object({
  baselineHash: HASH.nullable(),
  diffBytes: z.number().int().min(0).max(262_144),
  diffTruncated: z.boolean(),
  finalSize: z.number().int().nonnegative(),
  id: z.string().min(1),
  kind: z.enum(["added", "modified", "deleted", "renamed", "binary", "permission", "special"]),
  observedHash: HASH.nullable(),
  path: z.string().min(1),
  position: z.number().int().min(0).max(99_999),
}).strict();

const stagedBlockerSchema = z.object({
  detailCode: z.string().min(1),
  kind: z.enum([
    "deleted", "renamed", "binary", "permission", "special",
    "file_size_limit", "file_count_limit", "byte_limit",
  ]),
  observationId: z.string().min(1),
  path: z.string().min(1),
  position: z.number().int().min(0).max(99_999),
  secondaryCodes: z.array(z.string()).max(8),
}).strict();

const stagedSummarySchema = z.object({
  blockReasons: z.array(z.string()),
  blockerCount: z.number().int().nonnegative(),
  blockerCounts: z.record(z.string(), z.number().int().nonnegative()),
  classification: z.enum(["auto_eligible", "approval_required", "blocked"]),
  id: z.string(),
  mergeFileCount: z.number().int().nonnegative(),
  mergeFinalBytes: z.number().int().nonnegative(),
  observedFinalBytes: z.number().int().nonnegative(),
  observedPathCount: z.number().int().nonnegative(),
  stagedHash: HASH,
}).strict();

const executionDetailSchema = z.object({
  counts: z.object({
    approvals: z.number().int().nonnegative(),
    artifacts: z.number().int().nonnegative(),
    events: z.number().int().nonnegative(),
    mergeFiles: z.number().int().nonnegative(),
    stagedBlockers: z.number().int().nonnegative(),
    stagedObservations: z.number().int().nonnegative(),
    validations: z.number().int().nonnegative(),
  }).strict(),
  execution: executionDtoSchema,
  frozen: z.object({
    agentVersion: z.number().int().positive(),
    baselineManifestHash: HASH,
    contextHash: HASH,
    memoryHash: HASH,
    missionVersion: z.number().int().positive(),
    permissionsHash: HASH,
    policyHash: HASH,
    policyRevisionId: z.string().min(1),
    policyVersion: z.number().int().positive(),
    providerVersion: z.number().int().positive(),
    rosterHash: HASH,
    skillsHash: HASH,
    taskVersion: z.number().int().positive(),
  }).strict(),
  recovery: z.object({
    allowedResolutions: z.array(z.enum(["recovered_old", "recovered_new", "abandon"])).max(3),
    journalStatus: z.string().nullable(),
    mismatchPhase: z.string().nullable(),
    observedManifestHash: HASH.nullable(),
    oldManifestHash: HASH.nullable(),
    postManifestHash: HASH.nullable(),
    required: z.boolean(),
  }).strict(),
  staged: stagedSummarySchema.nullable(),
}).strict();

function publicFailure(code = "INTERNAL_ERROR", status = 500): ExecutionError {
  return new ExecutionError(code, status, code === "INTERNAL_ERROR"
    ? "An unexpected error occurred."
    : "The read request is invalid.");
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function assertPayload(value: unknown, maximum: number): void {
  if (jsonBytes(value) > maximum) {
    throw new ExecutionError(
      "RESPONSE_LIMIT_EXCEEDED",
      413,
      "The response exceeds its public size limit.",
    );
  }
}

function cursorKey(databasePath: string): Buffer {
  return createHash("sha256")
    .update(process.env.COCKPIT_MASTER_KEY || `execution-cursor:${resolve(databasePath)}`, "utf8")
    .digest();
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
): Array<string | number> | null {
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
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as CursorPayload;
    if (
      payload.version !== 1
      || payload.route !== route
      || payload.parent !== parent
      || !Array.isArray(payload.key)
      || payload.expiresAt < Date.now()
    ) {
      throw new Error("scope");
    }
    return payload.key;
  } catch {
    throw new ExecutionError("INVALID_CURSOR", 400, "The pagination cursor is invalid.");
  }
}

function limit(value: string | undefined, maximum: number): number {
  const parsed = value === undefined ? maximum : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new ExecutionError("INVALID_INPUT", 400, "The pagination limit is invalid.");
  }
  return parsed;
}

function boundedPage<T>(
  databasePath: string,
  route: string,
  parent: string,
  rows: T[],
  requestedLimit: number,
  keyOf: (row: T) => Array<string | number>,
  schema: z.ZodType<T>,
  maximumBytes = MAX_LIST_BYTES,
): CursorPage<T> {
  const parsed: T[] = [];
  for (const row of rows.slice(0, requestedLimit)) {
    const item = schema.parse(row);
    if (jsonBytes({ items: [...parsed, item], nextCursor: null }) > maximumBytes) break;
    parsed.push(item);
  }
  if (rows.length > 0 && parsed.length === 0) {
    throw new ExecutionError("RESPONSE_LIMIT_EXCEEDED", 413, "A response item exceeds its size limit.");
  }
  const hasMore = parsed.length < rows.length;
  const nextCursor = hasMore
    ? encodeCursor(databasePath, {
        expiresAt: Date.now() + CURSOR_TTL_MS,
        key: keyOf(parsed.at(-1)!),
        parent,
        route,
        version: 1,
      })
    : null;
  const page = { items: parsed, nextCursor };
  assertPayload(page, maximumBytes);
  return page;
}

async function openForProject(
  databasePath: string,
  projectId: string,
): Promise<DatabaseSync> {
  const database = openDatabase(databasePath);
  try {
    if (!database.prepare("SELECT 1 FROM projects WHERE id=?").get(projectId)) {
      throw new ExecutionError("PROJECT_NOT_FOUND", 404, "Project was not found.");
    }
    await recoverIncompleteMergeJournals({ database, projectId });
    assertNoMergeBarrier(database, projectId);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

async function openForExecution(
  databasePath: string,
  executionId: string,
  allowManualRecovery = false,
): Promise<{ database: DatabaseSync; projectId: string }> {
  const database = openDatabase(databasePath);
  try {
    const execution = database.prepare(
      "SELECT project_id AS projectId FROM executions WHERE id=?",
    ).get(executionId) as { projectId: string } | undefined;
    if (!execution) {
      throw new ExecutionError("EXECUTION_NOT_FOUND", 404, "Execution was not found.");
    }
    await recoverIncompleteMergeJournals({ database, projectId: execution.projectId });
    if (!allowManualRecovery) assertNoMergeBarrier(database, execution.projectId);
    return { database, projectId: execution.projectId };
  } catch (error) {
    database.close();
    throw error;
  }
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function stagedSummary(database: DatabaseSync, executionId: string) {
  const row = database.prepare(`
    SELECT id,staged_hash AS stagedHash,classification,block_reasons_json AS blockReasonsJson,
           observed_path_count AS observedPathCount,observed_final_bytes AS observedFinalBytes,
           merge_file_count AS mergeFileCount,merge_final_bytes AS mergeFinalBytes,
           blocker_count AS blockerCount
    FROM execution_staged_results WHERE execution_id=? ORDER BY created_at DESC,id DESC LIMIT 1
  `).get(executionId) as Record<string, unknown> | undefined;
  if (!row) return null;
  const { blockReasonsJson, ...summaryRow } = row;
  const counts = database.prepare(`
    SELECT kind,COUNT(*) AS count FROM execution_staged_blockers
    WHERE staged_result_id=? GROUP BY kind ORDER BY kind
  `).all(row.id as string) as Array<{ count: number; kind: string }>;
  return stagedSummarySchema.parse({
    ...summaryRow,
    blockReasons: JSON.parse(blockReasonsJson as string),
    blockerCounts: Object.fromEntries(counts.map((item) => [item.kind, item.count])),
  });
}

export async function listProjectExecutions(
  databasePath: string,
  projectId: string,
  query: ReadQuery,
): Promise<CursorPage<z.infer<typeof executionDtoSchema>>> {
  const requested = limit(query.limit, 50);
  const key = decodeCursor(databasePath, query.after, "executions", projectId);
  const afterCreatedAt = key?.[0];
  const afterId = key?.[1];
  if (
    key
    && (key.length !== 2 || typeof afterCreatedAt !== "string" || typeof afterId !== "string")
  ) throw new ExecutionError("INVALID_CURSOR", 400, "The pagination cursor is invalid.");
  const database = await openForProject(databasePath, projectId);
  try {
    const rows = database.prepare(`
      SELECT id,created_at AS createdAt FROM executions
      WHERE project_id=? AND (? IS NULL OR created_at>? OR (created_at=? AND id>?))
      ORDER BY created_at,id LIMIT ?
    `).all(
      projectId,
      afterCreatedAt ?? null,
      afterCreatedAt ?? null,
      afterCreatedAt ?? null,
      afterId ?? null,
      requested + 1,
    ) as Array<{ createdAt: string; id: string }>;
    const createdAtById = new Map(rows.map((row) => [row.id, row.createdAt]));
    return boundedPage(
      databasePath,
      "executions",
      projectId,
      rows.map((row) => executionDtoFromDatabase(database, row.id)),
      requested,
      (row) => [createdAtById.get(row.id)!, row.id],
      executionDtoSchema,
    );
  } finally {
    database.close();
  }
}

export async function readExecutionDetail(
  databasePath: string,
  executionId: string,
): Promise<z.infer<typeof executionDetailSchema>> {
  const { database } = await openForExecution(databasePath, executionId);
  try {
    const attempt = database.prepare(`
      SELECT frozen_public_json AS publicJson,frozen_private_json AS privateJson,
             frozen_context_hash AS contextHash,frozen_policy_revision_id AS policyRevisionId,
             frozen_policy_version AS policyVersion,frozen_policy_hash AS policyHash,
             baseline_manifest_hash AS baselineManifestHash
      FROM execution_attempts WHERE execution_id=?
      ORDER BY attempt_no DESC LIMIT 1
    `).get(executionId) as Record<string, unknown> | undefined;
    if (!attempt) throw publicFailure();
    const publicEnvelope = JSON.parse(attempt.publicJson as string) as { facts?: Record<string, any> };
    const privateEnvelope = JSON.parse(attempt.privateJson as string) as { facts?: Record<string, any> };
    const facts = publicEnvelope.facts ?? {};
    const privateFacts = privateEnvelope.facts ?? {};
    const count = (table: string, where: string, ...parameters: unknown[]) =>
      Number((database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`)
        .get(...parameters as any[]) as { count: number }).count);
    const staged = stagedSummary(database, executionId);
    const journal = database.prepare(`
      SELECT status,old_manifest_hash AS oldManifestHash,post_manifest_hash AS postManifestHash,
             observed_manifest_hash AS observedManifestHash,mismatch_phase AS mismatchPhase
      FROM execution_merge_journals WHERE execution_id=?
      ORDER BY created_at DESC,id DESC LIMIT 1
    `).get(executionId) as Record<string, unknown> | undefined;
    const detail = executionDetailSchema.parse({
      counts: {
        approvals: count("execution_approvals", "execution_id=?", executionId),
        artifacts: count("execution_artifacts", "execution_id=?", executionId),
        events: count("execution_events", "execution_id=?", executionId),
        mergeFiles: journal
          ? count("execution_merge_files", "journal_id=(SELECT id FROM execution_merge_journals WHERE execution_id=? ORDER BY created_at DESC,id DESC LIMIT 1)", executionId)
          : 0,
        stagedBlockers: staged
          ? count("execution_staged_blockers", "staged_result_id=?", staged.id)
          : 0,
        stagedObservations: staged
          ? count("execution_staged_observations", "staged_result_id=?", staged.id)
          : 0,
        validations: count("execution_validation_results", "execution_id=?", executionId),
      },
      execution: executionDtoFromDatabase(database, executionId),
      frozen: {
        agentVersion: Number(privateFacts.currentAgent?.version ?? facts.task?.version ?? 1),
        baselineManifestHash: attempt.baselineManifestHash ?? facts.workspaceBaselineHash ?? HASH.parse("0".repeat(64)),
        contextHash: attempt.contextHash,
        memoryHash: hashJson(facts.sharedMemory ?? []),
        missionVersion: Number(facts.mission?.version ?? 1),
        permissionsHash: hashJson(privateFacts.currentAgent?.permissions ?? {}),
        policyHash: attempt.policyHash,
        policyRevisionId: attempt.policyRevisionId,
        policyVersion: attempt.policyVersion,
        providerVersion: Number(facts.provider?.version ?? 1),
        rosterHash: hashJson(facts.members ?? []),
        skillsHash: hashJson(privateFacts.currentAgent?.skills ?? []),
        taskVersion: Number(facts.task?.version ?? 1),
      },
      recovery: {
        allowedResolutions: journal?.status === "manual_recovery"
          ? ["recovered_old", "recovered_new", "abandon"]
          : [],
        journalStatus: journal?.status ?? null,
        mismatchPhase: journal?.mismatchPhase ?? null,
        observedManifestHash: journal?.observedManifestHash ?? null,
        oldManifestHash: journal?.oldManifestHash ?? null,
        postManifestHash: journal?.postManifestHash ?? null,
        required: journal?.status === "manual_recovery",
      },
      staged,
    });
    assertPayload(detail, MAX_DETAIL_BYTES);
    return detail;
  } catch (error) {
    if (error instanceof ExecutionError) throw error;
    throw publicFailure();
  } finally {
    database.close();
  }
}

export async function listExecutionEvents(
  databasePath: string,
  executionId: string,
  query: ReadQuery,
): Promise<CursorPage<z.infer<typeof eventSchema>>> {
  const requested = limit(query.limit, 100);
  const key = decodeCursor(databasePath, query.after, "events", executionId);
  const sequence = key?.[0];
  const id = key?.[1];
  if (key && (key.length !== 2 || !Number.isInteger(sequence) || typeof id !== "string")) {
    throw new ExecutionError("INVALID_CURSOR", 400, "The pagination cursor is invalid.");
  }
  const { database } = await openForExecution(databasePath, executionId);
  try {
    const rows = database.prepare(`
      SELECT id,sequence,attempt_no AS attemptNo,type,actor_type AS actorType,
             actor_id AS actorId,payload_json AS payloadJson,created_at AS createdAt
      FROM execution_events WHERE execution_id=?
        AND (? IS NULL OR sequence>? OR (sequence=? AND id>?))
      ORDER BY sequence,id LIMIT ?
    `).all(
      executionId,
      sequence ?? null,
      sequence ?? null,
      sequence ?? null,
      id ?? null,
      requested + 1,
    ) as Array<Record<string, unknown>>;
    const items = rows.map(({ payloadJson, ...row }) => ({
      ...row,
      payload: JSON.parse(payloadJson as string),
    })) as Array<z.infer<typeof eventSchema>>;
    return boundedPage(
      databasePath,
      "events",
      executionId,
      items,
      requested,
      (row) => [row.sequence, row.id],
      eventSchema,
    );
  } catch (error) {
    if (error instanceof ExecutionError) throw error;
    throw publicFailure();
  } finally {
    database.close();
  }
}

export async function listExecutionArtifacts(
  databasePath: string,
  executionId: string,
  query: ReadQuery,
): Promise<CursorPage<z.infer<typeof artifactSchema>>> {
  const requested = limit(query.limit, 20);
  const key = decodeCursor(databasePath, query.after, "artifacts", executionId);
  const createdAt = key?.[0];
  const id = key?.[1];
  if (key && (key.length !== 2 || typeof createdAt !== "string" || typeof id !== "string")) {
    throw new ExecutionError("INVALID_CURSOR", 400, "The pagination cursor is invalid.");
  }
  const { database } = await openForExecution(databasePath, executionId);
  try {
    const rows = database.prepare(`
      SELECT id,name,path,content_bytes AS contentBytes,sha256,truncated,
             created_at AS createdAt
      FROM execution_artifacts WHERE execution_id=?
        AND (? IS NULL OR created_at>? OR (created_at=? AND id>?))
      ORDER BY created_at,id LIMIT ?
    `).all(
      executionId, createdAt ?? null, createdAt ?? null, createdAt ?? null,
      id ?? null, requested + 1,
    ) as Array<Record<string, unknown>>;
    const items = rows.map((row) => ({
      ...row,
      truncated: row.truncated === 1,
    })) as Array<z.infer<typeof artifactSchema>>;
    return boundedPage(
      databasePath, "artifacts", executionId,
      items,
      requested, (row) => [row.createdAt, row.id], artifactSchema,
    );
  } finally {
    database.close();
  }
}

function validatedChunks(
  header: { bytes: number; sha256: string },
  rows: Array<{ byteLength: number; byteOffset: number; chunkIndex: number; sha256: string; text: string }>,
): void {
  if (
    !Number.isInteger(header.bytes)
    || header.bytes < 0
    || header.bytes > MAX_BODY_BYTES
    || !/^[0-9a-f]{64}$/u.test(header.sha256)
    || rows.length > 17
  ) throw publicFailure();
  let offset = 0;
  const hasher = createHash("sha256");
  for (const [index, row] of rows.entries()) {
    const bytes = Buffer.from(row.text, "utf8");
    if (
      row.chunkIndex !== index
      || row.byteOffset !== offset
      || row.byteLength !== bytes.length
      || row.byteLength < 1
      || row.byteLength > MAX_CHUNK_BYTES
      || createHash("sha256").update(bytes).digest("hex") !== row.sha256
    ) throw publicFailure();
    offset += bytes.length;
    hasher.update(bytes);
  }
  if (
    offset !== header.bytes
    || (header.bytes === 0 ? rows.length !== 0 : rows.length === 0)
    || hasher.digest("hex") !== header.sha256
  ) throw publicFailure();
}

export async function listArtifactChunks(
  databasePath: string,
  executionId: string,
  artifactId: string,
  query: ReadQuery,
): Promise<CursorPage<z.infer<typeof textChunkSchema>>> {
  limit(query.limit, 1);
  const key = decodeCursor(databasePath, query.after, "artifact-chunks", `${executionId}:${artifactId}`);
  const afterIndex = key?.[0];
  if (key && (key.length !== 1 || !Number.isInteger(afterIndex))) {
    throw new ExecutionError("INVALID_CURSOR", 400, "The pagination cursor is invalid.");
  }
  const { database } = await openForExecution(databasePath, executionId);
  try {
    const header = database.prepare(`
      SELECT content_bytes AS bytes,sha256 FROM execution_artifacts
      WHERE id=? AND execution_id=?
    `).get(artifactId, executionId) as { bytes: number; sha256: string } | undefined;
    if (!header) throw new ExecutionError("ARTIFACT_NOT_FOUND", 404, "Artifact was not found.");
    const rows = database.prepare(`
      SELECT chunk_index AS chunkIndex,byte_offset AS byteOffset,
             byte_length AS byteLength,text,sha256
      FROM execution_artifact_chunks WHERE artifact_id=? ORDER BY chunk_index
    `).all(artifactId) as Array<{
      byteLength: number; byteOffset: number; chunkIndex: number; sha256: string; text: string;
    }>;
    validatedChunks(header, rows);
    const remaining = rows.filter((row) => row.chunkIndex > Number(afterIndex ?? -1));
    return boundedPage(
      databasePath, "artifact-chunks", `${executionId}:${artifactId}`,
      remaining.map((row) => ({ ...row, stream: "artifact" as const })),
      1, (row) => [row.chunkIndex], textChunkSchema, MAX_CHUNK_ENVELOPE_BYTES,
    );
  } finally {
    database.close();
  }
}

export async function listStagedObservations(
  databasePath: string,
  executionId: string,
  stagedId: string,
  query: ReadQuery,
): Promise<CursorPage<z.infer<typeof stagedObservationSchema>>> {
  const requested = limit(query.limit, 20);
  const parent = `${executionId}:${stagedId}`;
  const key = decodeCursor(databasePath, query.after, "staged-observations", parent);
  const position = key?.[0];
  const id = key?.[1];
  if (key && (key.length !== 2 || !Number.isInteger(position) || typeof id !== "string")) {
    throw new ExecutionError("INVALID_CURSOR", 400, "The pagination cursor is invalid.");
  }
  const { database } = await openForExecution(databasePath, executionId);
  try {
    if (!database.prepare(
      "SELECT 1 FROM execution_staged_results WHERE id=? AND execution_id=?",
    ).get(stagedId, executionId)) {
      throw new ExecutionError("STAGED_OBSERVATION_NOT_FOUND", 404, "Staged result was not found.");
    }
    const rows = database.prepare(`
      SELECT id,position,path,kind,baseline_hash AS baselineHash,observed_hash AS observedHash,
             final_size AS finalSize,diff_bytes AS diffBytes,diff_truncated AS diffTruncated
      FROM execution_staged_observations WHERE staged_result_id=?
        AND (? IS NULL OR position>? OR (position=? AND id>?))
      ORDER BY position,id LIMIT ?
    `).all(
      stagedId, position ?? null, position ?? null, position ?? null, id ?? null, requested + 1,
    ) as Array<Record<string, unknown>>;
    const items = rows.map((row) => ({
      ...row,
      diffTruncated: row.diffTruncated === 1,
    })) as Array<z.infer<typeof stagedObservationSchema>>;
    return boundedPage(
      databasePath, "staged-observations", parent,
      items,
      requested, (row) => [row.position, row.id], stagedObservationSchema,
    );
  } finally {
    database.close();
  }
}

export async function listStagedBlockers(
  databasePath: string,
  executionId: string,
  stagedId: string,
  query: ReadQuery,
): Promise<CursorPage<z.infer<typeof stagedBlockerSchema>>> {
  const requested = limit(query.limit, 20);
  const parent = `${executionId}:${stagedId}`;
  const key = decodeCursor(databasePath, query.after, "staged-blockers", parent);
  const position = key?.[0];
  const observationId = key?.[1];
  if (key && (
    key.length !== 2 || !Number.isInteger(position) || typeof observationId !== "string"
  )) throw new ExecutionError("INVALID_CURSOR", 400, "The pagination cursor is invalid.");
  const { database } = await openForExecution(databasePath, executionId);
  try {
    if (!database.prepare(
      "SELECT 1 FROM execution_staged_results WHERE id=? AND execution_id=?",
    ).get(stagedId, executionId)) {
      throw new ExecutionError("STAGED_OBSERVATION_NOT_FOUND", 404, "Staged result was not found.");
    }
    const rows = database.prepare(`
      SELECT position,observation_id AS observationId,path,kind,detail_json AS detailJson
      FROM execution_staged_blockers WHERE staged_result_id=?
        AND (? IS NULL OR position>? OR (position=? AND observation_id>?))
      ORDER BY position,observation_id LIMIT ?
    `).all(
      stagedId, position ?? null, position ?? null, position ?? null,
      observationId ?? null, requested + 1,
    ) as Array<Record<string, unknown>>;
    return boundedPage(
      databasePath, "staged-blockers", parent,
      rows.map(({ detailJson, ...row }) => ({ ...row, ...JSON.parse(detailJson as string) })),
      requested, (row) => [row.position, row.observationId], stagedBlockerSchema,
    );
  } finally {
    database.close();
  }
}

function boundedUtf8Slice(text: string, offset: number, maximum: number): {
  nextOffset: number | null;
  text: string;
} {
  const bytes = Buffer.from(text, "utf8");
  if (offset < 0 || offset > bytes.length) throw new ExecutionError("INVALID_INPUT", 400, "Diff offset is invalid.");
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, offset));
  } catch {
    throw new ExecutionError("INVALID_INPUT", 400, "Diff offset is not a scalar boundary.");
  }
  let end = Math.min(bytes.length, offset + maximum);
  let decoded = "";
  while (end >= offset) {
    try {
      decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(offset, end));
      break;
    } catch {
      end -= 1;
    }
  }
  return { nextOffset: end < bytes.length ? end : null, text: decoded };
}

export async function readObservationDiff(
  databasePath: string,
  executionId: string,
  stagedId: string,
  observationId: string,
  query: ReadQuery,
): Promise<{
  nextOffset: number | null;
  observationId: string;
  offset: number;
  sha256: string;
  text: string;
  totalBytes: number;
}> {
  if (query.after !== undefined) throw new ExecutionError("INVALID_INPUT", 400, "Diff cursor is invalid.");
  const requested = limit(query.limit, MAX_CHUNK_BYTES);
  const offset = query.offset === undefined ? 0 : Number(query.offset);
  if (!Number.isInteger(offset) || offset < 0 || offset > 262_143) {
    throw new ExecutionError("INVALID_INPUT", 400, "Diff offset is invalid.");
  }
  const { database } = await openForExecution(databasePath, executionId);
  try {
    const row = database.prepare(`
      SELECT o.diff_text AS text,o.diff_bytes AS totalBytes
      FROM execution_staged_observations o
      JOIN execution_staged_results s ON s.id=o.staged_result_id
      WHERE o.id=? AND o.staged_result_id=? AND s.execution_id=?
    `).get(observationId, stagedId, executionId) as { text: string | null; totalBytes: number } | undefined;
    if (!row || row.text === null) {
      throw new ExecutionError("STAGED_OBSERVATION_NOT_FOUND", 404, "Staged observation was not found.");
    }
    if (Buffer.byteLength(row.text, "utf8") !== row.totalBytes) throw publicFailure();
    const chunk = boundedUtf8Slice(row.text, offset, requested);
    const body = {
      nextOffset: chunk.nextOffset,
      observationId,
      offset,
      sha256: createHash("sha256").update(chunk.text, "utf8").digest("hex"),
      text: chunk.text,
      totalBytes: row.totalBytes,
    };
    assertPayload(body, MAX_CHUNK_ENVELOPE_BYTES);
    return body;
  } finally {
    database.close();
  }
}

export async function listExecutionApprovals(
  databasePath: string,
  executionId: string,
  query: ReadQuery,
): Promise<CursorPage<z.infer<typeof executionApprovalDtoSchema>>> {
  const requested = limit(query.limit, 10);
  const key = decodeCursor(databasePath, query.after, "approvals", executionId);
  const createdAt = key?.[0];
  const id = key?.[1];
  if (key && (key.length !== 2 || typeof createdAt !== "string" || typeof id !== "string")) {
    throw new ExecutionError("INVALID_CURSOR", 400, "The pagination cursor is invalid.");
  }
  const { database } = await openForExecution(databasePath, executionId);
  try {
    const rows = database.prepare(`
      SELECT id,kind,status,request_hash AS requestHash,input_hash AS inputHash,
             staged_hash AS stagedHash,public_request_json AS publicRequestJson,
             created_at AS createdAt,decided_at AS decidedAt,consumed_at AS consumedAt
      FROM execution_approvals WHERE execution_id=?
        AND (? IS NULL OR created_at>? OR (created_at=? AND id>?))
      ORDER BY created_at,id LIMIT ?
    `).all(
      executionId, createdAt ?? null, createdAt ?? null, createdAt ?? null,
      id ?? null, requested + 1,
    ) as Array<Record<string, unknown>>;
    const items = rows.map(({ publicRequestJson, ...row }) => {
      const request = JSON.parse(publicRequestJson as string) as Record<string, unknown>;
      return {
        ...row,
        command: row.kind === "command"
          ? {
              args: request.args,
              executable: request.executable,
              expectedEffect: request.expectedEffect,
              permission: "execute",
              riskReasons: request.riskReasons,
              workdir: request.workdir,
            }
          : null,
      };
    }) as Array<z.infer<typeof executionApprovalDtoSchema>>;
    return boundedPage(
      databasePath, "approvals", executionId, items, requested,
      (row) => [row.createdAt, row.id], executionApprovalDtoSchema,
    );
  } catch (error) {
    if (error instanceof ExecutionError) throw error;
    throw publicFailure();
  } finally {
    database.close();
  }
}

const validationSchema = z.object({
  afterLastWrite: z.boolean(),
  exitCode: z.number().int(),
  finishedAt: z.string(),
  id: z.string(),
  policyEntryId: z.string(),
  required: z.boolean(),
  stderr: z.object({ bytes: z.number().int(), sha256: HASH, truncated: z.boolean() }).strict(),
  stdout: z.object({ bytes: z.number().int(), sha256: HASH, truncated: z.boolean() }).strict(),
  succeeded: z.boolean(),
}).strict();

export async function listExecutionValidations(
  databasePath: string,
  executionId: string,
  query: ReadQuery,
): Promise<CursorPage<z.infer<typeof validationSchema>>> {
  const requested = limit(query.limit, 20);
  const key = decodeCursor(databasePath, query.after, "validations", executionId);
  const finishedAt = key?.[0];
  const id = key?.[1];
  if (key && (key.length !== 2 || typeof finishedAt !== "string" || typeof id !== "string")) {
    throw new ExecutionError("INVALID_CURSOR", 400, "The pagination cursor is invalid.");
  }
  const { database } = await openForExecution(databasePath, executionId);
  try {
    const rows = database.prepare(`
      SELECT v.id,v.policy_entry_id AS policyEntryId,v.required,v.exit_code AS exitCode,
             v.succeeded,v.stdout_bytes AS stdoutBytes,v.stdout_sha256 AS stdoutSha256,
             v.stdout_truncated AS stdoutTruncated,v.stderr_bytes AS stderrBytes,
             v.stderr_sha256 AS stderrSha256,v.stderr_truncated AS stderrTruncated,
             v.finished_at AS finishedAt,
             NOT EXISTS (
               SELECT 1 FROM execution_tool_calls t
               WHERE t.execution_id=v.execution_id AND t.type IN ('write','command')
                 AND t.finished_at>v.finished_at
             ) AS afterLastWrite
      FROM execution_validation_results v WHERE v.execution_id=?
        AND (? IS NULL OR v.finished_at>? OR (v.finished_at=? AND v.id>?))
      ORDER BY v.finished_at,v.id LIMIT ?
    `).all(
      executionId, finishedAt ?? null, finishedAt ?? null, finishedAt ?? null,
      id ?? null, requested + 1,
    ) as Array<Record<string, unknown>>;
    const items = rows.map((row) => ({
      afterLastWrite: row.afterLastWrite === 1,
      exitCode: Number(row.exitCode),
      finishedAt: String(row.finishedAt),
      id: String(row.id),
      policyEntryId: String(row.policyEntryId),
      required: row.required === 1,
      stderr: {
        bytes: Number(row.stderrBytes),
        sha256: String(row.stderrSha256),
        truncated: row.stderrTruncated === 1,
      },
      stdout: {
        bytes: Number(row.stdoutBytes),
        sha256: String(row.stdoutSha256),
        truncated: row.stdoutTruncated === 1,
      },
      succeeded: row.succeeded === 1,
    })) as Array<z.infer<typeof validationSchema>>;
    return boundedPage(
      databasePath, "validations", executionId, items, requested,
      (row) => [row.finishedAt, row.id], validationSchema,
    );
  } finally {
    database.close();
  }
}

export async function listValidationChunks(
  databasePath: string,
  executionId: string,
  validationId: string,
  stream: "stdout" | "stderr",
  query: ReadQuery,
): Promise<CursorPage<z.infer<typeof textChunkSchema>>> {
  limit(query.limit, 1);
  const parent = `${executionId}:${validationId}:${stream}`;
  const key = decodeCursor(databasePath, query.after, "validation-chunks", parent);
  const afterIndex = key?.[0];
  if (key && (key.length !== 1 || !Number.isInteger(afterIndex))) {
    throw new ExecutionError("INVALID_CURSOR", 400, "The pagination cursor is invalid.");
  }
  const { database } = await openForExecution(databasePath, executionId);
  try {
    const row = database.prepare(`
      SELECT stdout_bytes AS stdoutBytes,stdout_sha256 AS stdoutSha256,
             stderr_bytes AS stderrBytes,stderr_sha256 AS stderrSha256
      FROM execution_validation_results WHERE id=? AND execution_id=?
    `).get(validationId, executionId) as Record<string, unknown> | undefined;
    if (!row) throw new ExecutionError("VALIDATION_NOT_FOUND", 404, "Validation was not found.");
    const rows = database.prepare(`
      SELECT chunk_index AS chunkIndex,byte_offset AS byteOffset,
             byte_length AS byteLength,text,sha256
      FROM execution_validation_output_chunks
      WHERE validation_id=? AND stream=? ORDER BY chunk_index
    `).all(validationId, stream) as Array<{
      byteLength: number; byteOffset: number; chunkIndex: number; sha256: string; text: string;
    }>;
    validatedChunks({
      bytes: Number(row[`${stream}Bytes`]),
      sha256: String(row[`${stream}Sha256`]),
    }, rows);
    return boundedPage(
      databasePath, "validation-chunks", parent,
      rows.filter((item) => item.chunkIndex > Number(afterIndex ?? -1))
        .map((item) => ({ ...item, stream })),
      1, (item) => [item.chunkIndex], textChunkSchema, MAX_CHUNK_ENVELOPE_BYTES,
    );
  } finally {
    database.close();
  }
}

const recoveryFileSchema = z.object({
  newHash: HASH,
  oldExists: z.boolean(),
  oldHash: HASH.nullable(),
  path: z.string().min(1),
  pathKey: z.string().min(1),
  position: z.number().int().nonnegative(),
  status: z.enum(["pending", "applied", "rolled_back", "rolled_forward", "verified"]),
}).strict();

export async function listRecoveryFiles(
  databasePath: string,
  executionId: string,
  query: ReadQuery,
): Promise<CursorPage<z.infer<typeof recoveryFileSchema>>> {
  const requested = limit(query.limit, 20);
  const key = decodeCursor(databasePath, query.after, "recovery-files", executionId);
  const position = key?.[0];
  const pathKey = key?.[1];
  if (key && (key.length !== 2 || !Number.isInteger(position) || typeof pathKey !== "string")) {
    throw new ExecutionError("INVALID_CURSOR", 400, "The pagination cursor is invalid.");
  }
  const { database } = await openForExecution(databasePath, executionId, true);
  try {
    const journal = database.prepare(`
      SELECT id,status FROM execution_merge_journals WHERE execution_id=?
      ORDER BY created_at DESC,id DESC LIMIT 1
    `).get(executionId) as { id: string; status: string } | undefined;
    if (!journal || journal.status !== "manual_recovery") {
      throw new ExecutionError("MERGE_RECOVERY_REQUIRED", 409, "Manual recovery files are unavailable.");
    }
    const rows = database.prepare(`
      SELECT position,path,path_key AS pathKey,
             json_extract(old_target_ref_json,'$.exists') AS oldExists,
             json_extract(old_target_ref_json,'$.sha256') AS oldHash,
             json_extract(post_target_ref_json,'$.sha256') AS newHash,status
      FROM execution_merge_files WHERE journal_id=?
        AND (? IS NULL OR position>? OR (position=? AND path_key>?))
      ORDER BY position,path_key LIMIT ?
    `).all(
      journal.id, position ?? null, position ?? null, position ?? null,
      pathKey ?? null, requested + 1,
    ) as Array<Record<string, unknown>>;
    const items = rows.map((row) => ({
      ...row,
      oldExists: row.oldExists === 1,
    })) as Array<z.infer<typeof recoveryFileSchema>>;
    return boundedPage(
      databasePath, "recovery-files", executionId,
      items,
      requested, (row) => [row.position, row.pathKey], recoveryFileSchema,
    );
  } finally {
    database.close();
  }
}
