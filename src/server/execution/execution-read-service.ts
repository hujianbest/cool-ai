import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

import { openDatabase } from "@/src/server/db";
import { normalizeCanonicalRelativePath } from "@/src/server/execution/execution-conflicts";
import {
  ExecutionError,
  executionDtoFromDatabase,
} from "@/src/server/execution/execution-service";
import {
  executionApprovalDtoSchema,
  executionDtoSchema,
  executionEventDtoSchema,
  recoveryFileDtoSchema,
  recoveryMergeFileStatusSchema,
  type RecoveryFileDto,
} from "@/src/shared/execution-contracts";
import { SchemaMigrationError } from "@/src/server/migrations";

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

type ManualBarrier = {
  executionId: string;
  journalId: string;
};

function classifyMergeBarrier(
  database: DatabaseSync,
  projectId: string,
  executionId?: string,
): { kind: "incomplete" } | { kind: "manual"; value: ManualBarrier } | { kind: "none" } {
  const rows = database.prepare(`
    SELECT j.id AS journalId,j.execution_id AS executionId,j.status,
           e.manual_recovery_required AS manualRecoveryRequired
    FROM execution_merge_journals j
    JOIN executions e ON e.id=j.execution_id AND e.project_id=j.project_id
    WHERE j.project_id=? AND j.status IN (
      'prepared','applying','db_committed','rolling_back','rolling_forward','manual_recovery'
    ) ORDER BY j.created_at,j.id LIMIT 2
  `).all(projectId) as Array<{
    executionId: string;
    journalId: string;
    manualRecoveryRequired: number;
    status: string;
  }>;
  if (rows.length > 1) {
    throw new ExecutionError("MERGE_INVARIANT_FAILED", 500, "Merge barrier facts are inconsistent.");
  }
  const target = executionId
    ? database.prepare(`
        SELECT manual_recovery_required AS manualRecoveryRequired
        FROM executions WHERE project_id=? AND id=?
      `).get(projectId, executionId) as { manualRecoveryRequired: number } | undefined
    : undefined;
  const row = rows[0];
  if (!row) {
    if (target?.manualRecoveryRequired === 1) {
      throw new ExecutionError("MERGE_INVARIANT_FAILED", 500, "Manual recovery journal is missing.");
    }
    return { kind: "none" };
  }
  if (row.status !== "manual_recovery") return { kind: "incomplete" };
  if (row.manualRecoveryRequired !== 1) {
    throw new ExecutionError("MERGE_INVARIANT_FAILED", 500, "Manual recovery facts are inconsistent.");
  }
  if (executionId !== undefined && row.executionId === executionId) {
    return {
      kind: "manual",
      value: { executionId: row.executionId, journalId: row.journalId },
    };
  }
  return {
    kind: "manual",
    value: { executionId: row.executionId, journalId: row.journalId },
  };
}

async function recoverMergeBarrier(
  database: DatabaseSync,
  projectId: string,
  executionId?: string,
  allowExactManual = false,
): Promise<ManualBarrier | null> {
  let barrier = classifyMergeBarrier(database, projectId, executionId);
  if (barrier.kind === "none") return null;
  if (barrier.kind === "manual") {
    if (allowExactManual && barrier.value.executionId === executionId) return barrier.value;
    throw new ExecutionError(
      "MERGE_RECOVERY_REQUIRED",
      409,
      "Incomplete merge recovery blocks public project facts.",
    );
  }
  const merge = await import("@/src/server/execution/merge-journal-service");
  try {
    await merge.recoverIncompleteMergeJournals({ database, projectId });
  } catch (error) {
    if (!(error instanceof ExecutionError) || error.code !== "MANUAL_RECOVERY_REQUIRED") {
      throw error;
    }
  }
  barrier = classifyMergeBarrier(database, projectId, executionId);
  if (barrier.kind === "none") return null;
  if (
    barrier.kind === "manual"
    && allowExactManual
    && barrier.value.executionId === executionId
  ) {
    return barrier.value;
  }
  if (barrier.kind === "incomplete") {
    throw new ExecutionError("MERGE_INVARIANT_FAILED", 500, "Merge recovery did not reach a durable state.");
  }
  throw new ExecutionError(
    "MERGE_RECOVERY_REQUIRED",
    409,
    "Incomplete merge recovery blocks public project facts.",
  );
}

const HASH = z.string().regex(/^[0-9a-f]{64}$/u);
const MAX_LIST_BYTES = 512 * 1024;
const MAX_DETAIL_BYTES = 256 * 1024;
const MAX_CHUNK_BYTES = 65_536;
const MAX_CHUNK_ENVELOPE_BYTES = 72 * 1024;
const MAX_BODY_BYTES = 1_048_576;
const CURSOR_TTL_MS = 24 * 60 * 60 * 1000;

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
  activeApproval: executionApprovalDtoSchema.nullable(),
  blockReasons: z.array(z.string()),
  blockerCount: z.number().int().nonnegative(),
  blockerCounts: z.record(z.string(), z.number().int().nonnegative()),
  classification: z.enum(["auto_eligible", "approval_required", "blocked"]),
  id: z.string(),
  mergeFileCount: z.number().int().nonnegative(),
  mergeFinalBytes: z.number().int().nonnegative(),
  observedFinalBytes: z.number().int().nonnegative(),
  observedPathCount: z.number().int().nonnegative(),
  requiredValidations: z.object({
    ready: z.boolean(),
    requiredCount: z.number().int().min(0).max(50),
    validCount: z.number().int().min(0).max(50),
  }).strict(),
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
    journalId: z.string().nullable(),
    journalStatus: z.string().nullable(),
    mismatchPathKey: z.string().nullable(),
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
    if (
      actual.toString("base64url") !== parts[2]
      || actual.length !== expected.length
      || !timingSafeEqual(actual, expected)
    ) {
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
    await recoverMergeBarrier(database, projectId);
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
): Promise<{
  database: DatabaseSync;
  manual: ManualBarrier | null;
  projectId: string;
  readTransaction: boolean;
}> {
  const database = openDatabase(databasePath);
  try {
    const execution = database.prepare(
      "SELECT project_id AS projectId FROM executions WHERE id=?",
    ).get(executionId) as { projectId: string } | undefined;
    if (!execution) {
      throw new ExecutionError("EXECUTION_NOT_FOUND", 404, "Execution was not found.");
    }
    let manual = await recoverMergeBarrier(
      database,
      execution.projectId,
      executionId,
      allowManualRecovery,
    );
    if (!manual) {
      return {
        database,
        manual: null,
        projectId: execution.projectId,
        readTransaction: false,
      };
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      database.exec("BEGIN");
      const snapshot = classifyMergeBarrier(database, execution.projectId, executionId);
      if (snapshot.kind === "none") {
        return {
          database,
          manual: null,
          projectId: execution.projectId,
          readTransaction: true,
        };
      }
      if (snapshot.kind === "manual") {
        if (snapshot.value.executionId !== executionId) {
          database.exec("ROLLBACK");
          throw new ExecutionError(
            "MERGE_RECOVERY_REQUIRED",
            409,
            "Incomplete merge recovery blocks public project facts.",
          );
        }
        return {
          database,
          manual: snapshot.value,
          projectId: execution.projectId,
          readTransaction: true,
        };
      }
      database.exec("ROLLBACK");
      manual = await recoverMergeBarrier(
        database,
        execution.projectId,
        executionId,
        allowManualRecovery,
      );
      if (!manual) {
        return {
          database,
          manual: null,
          projectId: execution.projectId,
          readTransaction: false,
        };
      }
    }
    throw new ExecutionError(
      "MERGE_INVARIANT_FAILED",
      500,
      "Merge barrier could not produce a stable read snapshot.",
    );
  } catch (error) {
    database.close();
    throw error;
  }
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function approvalDtoFromRow(
  row: Record<string, unknown>,
): z.infer<typeof executionApprovalDtoSchema> {
  const { publicRequestJson, ...approval } = row;
  const request = row.kind === "command"
    ? JSON.parse(publicRequestJson as string) as Record<string, unknown>
    : null;
  return executionApprovalDtoSchema.parse({
    ...approval,
    command: request
      ? {
          args: request.args,
          executable: request.executable,
          expectedEffect: request.expectedEffect,
          permission: "execute",
          riskReasons: request.riskReasons,
          workdir: request.workdir,
        }
      : null,
  });
}

function stagedSummary(database: DatabaseSync, executionId: string) {
  const row = database.prepare(`
    SELECT s.id,s.staged_hash AS stagedHash,s.classification,
           s.block_reasons_json AS blockReasonsJson,
           observed_path_count AS observedPathCount,observed_final_bytes AS observedFinalBytes,
           merge_file_count AS mergeFileCount,merge_final_bytes AS mergeFinalBytes,
           blocker_count AS blockerCount,s.project_id AS projectId,s.attempt_id AS attemptId,
           s.sandbox_manifest_hash AS sandboxManifestHash,
           a.frozen_policy_revision_id AS policyRevisionId
    FROM execution_staged_results s
    JOIN execution_attempts a
      ON a.project_id=s.project_id AND a.execution_id=s.execution_id AND a.id=s.attempt_id
    WHERE s.execution_id=? ORDER BY s.created_at DESC,s.id DESC LIMIT 1
  `).get(executionId) as Record<string, unknown> | undefined;
  if (!row) return null;
  const {
    attemptId,
    blockReasonsJson,
    policyRevisionId,
    projectId,
    sandboxManifestHash,
    ...summaryRow
  } = row;
  const stagedAttemptId = String(attemptId);
  const stagedPolicyRevisionId = String(policyRevisionId);
  const stagedProjectId = String(projectId);
  const stagedSandboxManifestHash = String(sandboxManifestHash);
  const activeApprovalRow = database.prepare(`
    SELECT id,kind,status,request_hash AS requestHash,input_hash AS inputHash,
           staged_hash AS stagedHash,public_request_json AS publicRequestJson,
           created_at AS createdAt,decided_at AS decidedAt,consumed_at AS consumedAt
    FROM execution_approvals
    WHERE execution_id=? AND attempt_id=? AND kind='staged_merge'
      AND status IN ('pending','approved') AND staged_hash=?
    LIMIT 1
  `).get(
    executionId,
    stagedAttemptId,
    String(summaryRow.stagedHash),
  ) as Record<string, unknown> | undefined;
  const counts = database.prepare(`
    SELECT kind,COUNT(*) AS count FROM execution_staged_blockers
    WHERE staged_result_id=? GROUP BY kind ORDER BY kind
  `).all(row.id as string) as Array<{ count: number; kind: string }>;
  const requiredCount = Number((database.prepare(`
    SELECT COUNT(*) AS count
    FROM project_validation_policy_entries
    WHERE project_id=? AND revision_id=? AND required=1
  `).get(stagedProjectId, stagedPolicyRevisionId) as { count: number }).count);
  const validCount = Number((database.prepare(`
    SELECT COUNT(DISTINCT entry.id) AS count
    FROM project_validation_policy_entries entry
    JOIN execution_validation_results result
      ON result.project_id=entry.project_id
     AND result.policy_revision_id=entry.revision_id
     AND result.policy_entry_id=entry.id
    WHERE entry.project_id=? AND entry.revision_id=? AND entry.required=1
      AND result.execution_id=? AND result.attempt_id=?
      AND result.sandbox_manifest_hash=?
      AND result.required=1 AND result.succeeded=1 AND result.exit_code=0
  `).get(
    stagedProjectId,
    stagedPolicyRevisionId,
    executionId,
    stagedAttemptId,
    stagedSandboxManifestHash,
  ) as { count: number }).count);
  return stagedSummarySchema.parse({
    ...summaryRow,
    activeApproval: activeApprovalRow ? approvalDtoFromRow(activeApprovalRow) : null,
    blockReasons: JSON.parse(blockReasonsJson as string),
    blockerCounts: Object.fromEntries(counts.map((item) => [item.kind, item.count])),
    requiredValidations: {
      ready: validCount === requiredCount,
      requiredCount,
      validCount,
    },
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
  const {
    database,
    manual,
    projectId,
    readTransaction,
  } = await openForExecution(databasePath, executionId, true);
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
      SELECT id,project_id AS projectId,execution_id AS executionId,status,
             old_manifest_hash AS oldManifestHash,post_manifest_hash AS postManifestHash,
             observed_manifest_hash AS observedManifestHash,mismatch_phase AS mismatchPhase,
             mismatch_path_key AS mismatchPathKey
      FROM execution_merge_journals WHERE project_id=? AND execution_id=?
      ORDER BY created_at DESC,id DESC LIMIT 1
    `).get(projectId, executionId) as Record<string, unknown> | undefined;
    const execution = executionDtoFromDatabase(database, executionId);
    if (
      manual
      && (
        !journal
        || journal.id !== manual.journalId
        || journal.projectId !== projectId
        || journal.executionId !== executionId
        || journal.status !== "manual_recovery"
        || !execution.manualRecoveryRequired
      )
    ) {
      throw new ExecutionError(
        "MERGE_INVARIANT_FAILED",
        500,
        "Manual recovery detail facts are inconsistent.",
      );
    }
    if (!manual && execution.manualRecoveryRequired) {
      throw new ExecutionError("MERGE_INVARIANT_FAILED", 500, "Manual recovery journal is missing.");
    }
    if (journal?.mismatchPathKey !== null && journal?.mismatchPathKey !== undefined) {
      const mismatchPathKey = String(journal.mismatchPathKey);
      const path = database.prepare(`
        SELECT path FROM execution_merge_files WHERE journal_id=? AND path_key=?
      `).get(String(journal.id), mismatchPathKey) as { path: string } | undefined;
      if (
        !path
        || normalizeCanonicalRelativePath(path.path) !== mismatchPathKey
      ) {
        throw new ExecutionError(
          "MERGE_INVARIANT_FAILED",
          500,
          "Manual recovery mismatch path is invalid.",
        );
      }
    }
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
      execution,
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
        journalId: journal?.id ?? null,
        journalStatus: journal?.status ?? null,
        mismatchPathKey: journal?.mismatchPathKey ?? null,
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
    if (readTransaction) database.exec("COMMIT");
    database.close();
  }
}

export async function listExecutionEvents(
  databasePath: string,
  executionId: string,
  query: ReadQuery,
): Promise<CursorPage<z.infer<typeof executionEventDtoSchema>>> {
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
    const items = rows.map(({ payloadJson, ...row }) =>
      executionEventDtoSchema.parse({
        ...row,
        payload: JSON.parse(payloadJson as string),
      }));
    return boundedPage(
      databasePath,
      "events",
      executionId,
      items,
      requested,
      (row) => [row.sequence, row.id],
      executionEventDtoSchema,
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
  ) throw publicFailure("SCHEMA_DATA_INVALID");
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
    ) throw publicFailure("SCHEMA_DATA_INVALID");
    offset += bytes.length;
    hasher.update(bytes);
  }
  if (
    offset !== header.bytes
    || (header.bytes === 0 ? rows.length !== 0 : rows.length === 0)
    || hasher.digest("hex") !== header.sha256
  ) throw publicFailure("SCHEMA_DATA_INVALID");
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
    const items = rows.map(approvalDtoFromRow);
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

export async function listRecoveryFiles(
  databasePath: string,
  executionId: string,
  query: ReadQuery,
): Promise<CursorPage<RecoveryFileDto>> {
  const requested = limit(query.limit, 20);
  let opened: Awaited<ReturnType<typeof openForExecution>>;
  try {
    opened = await openForExecution(databasePath, executionId, true);
  } catch (error) {
    if (error instanceof SchemaMigrationError) {
      throw new ExecutionError(
        "INTERNAL_ERROR",
        500,
        "Recovery file storage facts are invalid.",
      );
    }
    throw error;
  }
  const { database, manual, projectId, readTransaction } = opened;
  try {
    if (!manual) {
      throw new ExecutionError("MERGE_RECOVERY_REQUIRED", 409, "Manual recovery files are unavailable.");
    }
    const journal = database.prepare(`
      SELECT j.id,j.status,j.mismatch_path_key AS mismatchPathKey,
             e.manual_recovery_required AS manualRecoveryRequired
      FROM execution_merge_journals j
      JOIN executions e ON e.project_id=j.project_id AND e.id=j.execution_id
      WHERE j.project_id=? AND j.execution_id=? AND j.id=?
    `).get(projectId, executionId, manual.journalId) as {
      id: string;
      manualRecoveryRequired: number;
      mismatchPathKey: string | null;
      status: string;
    } | undefined;
    if (
      !journal
      || journal.status !== "manual_recovery"
      || journal.manualRecoveryRequired !== 1
    ) {
      throw new ExecutionError("MERGE_INVARIANT_FAILED", 500, "Manual recovery files are inconsistent.");
    }
    const parent = `${executionId}:${journal.id}`;
    const key = decodeCursor(databasePath, query.after, "recovery-files", parent);
    const position = key?.[0];
    const pathKey = key?.[1];
    if (key && (key.length !== 2 || !Number.isInteger(position) || typeof pathKey !== "string")) {
      throw new ExecutionError("INVALID_CURSOR", 400, "The pagination cursor is invalid.");
    }
    const count = database.prepare(
      "SELECT COUNT(*) AS count FROM execution_merge_files WHERE journal_id=?",
    ).get(journal.id) as { count: number };
    if (Number(count.count) > 100) {
      throw new ExecutionError("MERGE_INVARIANT_FAILED", 500, "Recovery file count is invalid.");
    }
    const rows = database.prepare(`
      SELECT f.position,f.path,f.path_key AS pathKey,
             json_extract(f.old_target_ref_json,'$.exists') AS oldExists,
             json_extract(f.old_target_ref_json,'$.sha256') AS oldHash,
             json_extract(f.durable_new_ref_json,'$.sha256') AS durablePostHash,
             json_extract(f.post_target_ref_json,'$.sha256') AS targetPostHash,
             o.observed_hash AS stagedPostHash,f.status
      FROM execution_merge_files f
      JOIN execution_merge_journals j ON j.id=f.journal_id
      JOIN execution_staged_observations o
        ON o.staged_result_id=j.staged_result_id AND o.path_key=f.path_key
      WHERE f.journal_id=?
        AND (? IS NULL OR f.position>? OR (f.position=? AND f.path_key>?))
      ORDER BY f.position,f.path_key LIMIT ?
    `).all(
      journal.id, position ?? null, position ?? null, position ?? null,
      pathKey ?? null, requested + 1,
    ) as Array<Record<string, unknown>>;
    const items = rows.map((row) => {
      const status = recoveryMergeFileStatusSchema.parse(row.status);
      const path = row.path;
      const storedPathKey = row.pathKey;
      const postHash = row.durablePostHash;
      if (
        typeof path !== "string"
        || typeof storedPathKey !== "string"
        || !Number.isInteger(row.position)
        || (row.oldExists !== 0 && row.oldExists !== 1)
        || (row.oldExists === 1
          ? !HASH.safeParse(row.oldHash).success
          : row.oldHash !== null)
        || !HASH.safeParse(postHash).success
        || Buffer.byteLength(path, "utf8") > 4096
        || normalizeCanonicalRelativePath(path) !== storedPathKey
        || row.stagedPostHash !== postHash
        || (status === "pending"
          ? row.targetPostHash !== null
          : row.targetPostHash !== postHash)
      ) {
        throw new ExecutionError(
          "MERGE_INVARIANT_FAILED",
          500,
          "Stored recovery file facts are inconsistent.",
        );
      }
      return {
        isMismatch: journal.mismatchPathKey !== null
          && storedPathKey === journal.mismatchPathKey,
        oldExists: row.oldExists === 1,
        oldHash: row.oldHash,
        path,
        pathKey: storedPathKey,
        position: row.position,
        postHash,
        status,
      };
    }) as RecoveryFileDto[];
    return boundedPage(
      databasePath, "recovery-files", parent,
      items,
      requested, (row) => [row.position, row.pathKey], recoveryFileDtoSchema,
    );
  } finally {
    if (readTransaction) database.exec("COMMIT");
    database.close();
  }
}
