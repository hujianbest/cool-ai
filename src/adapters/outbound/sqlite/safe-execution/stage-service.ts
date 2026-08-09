import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { finalizeExecutionActionWithEffects } from "@/src/adapters/outbound/sqlite/safe-execution/execution-actions";
import { createStagedMergeApproval } from "@/src/adapters/outbound/sqlite/safe-execution/execution-approval-service";
import { reserveExecutionStagedPaths } from "@/src/adapters/outbound/sqlite/safe-execution/execution-conflicts";
import { ExecutionError } from "@/src/modules/safe-execution";

const MAX_OBSERVATIONS = 100_000;
const MAX_MERGE_FILES = 100;
const MAX_FILE_BYTES = 1_048_576;
const MAX_MERGE_BYTES = 10_485_760;
const MAX_TEXT_BYTES = 1_048_576;
const MAX_CHUNK_BYTES = 65_536;
const MAX_DIFF_BYTES = 262_144;

export type StagingEntry = {
  content?: string;
  identity?: string;
  kind: "binary" | "link" | "special" | "text";
  modeTag: string;
  path: string;
  sha256: string;
  size: number;
};

export type ExecutionStagingAdapter = {
  baselineEntries(input: {
    attemptId: string;
    baselineManifestPath: string | null;
    sandboxRoot: string;
  }): AsyncIterable<StagingEntry>;
  canonicalEntries?(input: {
    attemptId: string;
    workspaceRoot: string;
  }): AsyncIterable<StagingEntry>;
  currentEntries?(input: {
    attemptId: string;
    sandboxManifestPath: string | null;
    sandboxRoot: string;
  }): AsyncIterable<StagingEntry>;
  refreshSandboxManifest?(input: {
    attemptId: string;
    sandboxRoot: string;
  }): Promise<{
    entries: Array<{
      identity: string;
      modeTag: string;
      path: string;
      sha256: string;
      size: number;
    }>;
    hash: string;
    stagingEntries?: StagingEntry[];
  }>;
  sandboxEntries(input: {
    attemptId: string;
    sandboxRoot: string;
  }): AsyncIterable<StagingEntry>;
};

export type TextChunk = {
  byteLength: number;
  byteOffset: number;
  sha256: string;
  text: string;
};

export type BoundedText = {
  bytes: number;
  chunks: TextChunk[];
  sha256: string;
  truncated: boolean;
};

export type StagedObservationKind =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "binary"
  | "permission"
  | "special";

export type StagedBlockerKind =
  | "deleted"
  | "renamed"
  | "binary"
  | "permission"
  | "special"
  | "file_size_limit"
  | "file_count_limit"
  | "byte_limit";

export type ComputedStagedObservation = {
  baselineHash: string | null;
  diffBytes: number;
  diffText: string | null;
  diffTruncated: boolean;
  finalSize: number;
  id: string;
  kind: StagedObservationKind;
  modeTag: string;
  observedHash: string | null;
  path: string;
  pathKey: string;
  position: number;
};

export type ComputedStagedBlocker = {
  detailCode: string;
  kind: StagedBlockerKind;
  observationId: string;
  path: string;
  position: number;
  secondaryCodes: string[];
};

export type ComputedStagedSnapshot = {
  blockReasons: string[];
  blockers: ComputedStagedBlocker[];
  classification: "approval_required" | "auto_eligible" | "blocked";
  mergeFiles: StagingEntry[];
  observations: ComputedStagedObservation[];
  outcome: "no_changes" | "ready";
  stagedHash: string | null;
  totals: {
    blockerCount: number;
    mergeFileCount: number;
    mergeFinalBytes: number;
    observedFinalBytes: number;
    observedPathCount: number;
  };
};

type ValidationSnapshot = {
  exitCode: number;
  finishedAt: string;
  manifestHash: string;
  policyEntryId: string;
  policyRevisionId: string;
  required: boolean;
  stderrSha256: string;
  stderrTruncated: boolean;
  stdoutSha256: string;
  stdoutTruncated: boolean;
  succeeded: boolean;
};

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]));
  }
  return value;
}

function canonicalHash(value: unknown): string {
  return sha256(JSON.stringify(canonicalize(value)));
}

function inSavepoint<T>(database: DatabaseSync, work: () => T): T {
  const name = `stage_${randomUUID().replaceAll("-", "")}`;
  database.exec(`SAVEPOINT ${name}`);
  try {
    const result = work();
    database.exec(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (error) {
    database.exec(`ROLLBACK TO SAVEPOINT ${name}`);
    database.exec(`RELEASE SAVEPOINT ${name}`);
    throw error;
  }
}

function comparePath(left: string, right: string): number {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

function pathKey(path: string): string {
  const normalized = path.normalize("NFC");
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

function assertEntry(entry: StagingEntry): void {
  if (
    !entry.path
    || Buffer.byteLength(entry.path, "utf8") > 4096
    || !Number.isSafeInteger(entry.size)
    || entry.size < 0
    || !/^[0-9a-f]{64}$/u.test(entry.sha256)
    || !entry.modeTag
  ) {
    throw new ExecutionError("STAGED_LIMIT_EXCEEDED", 413, "A staged manifest entry is invalid.");
  }
  if (
    entry.kind === "text"
    && entry.content !== undefined
    && Buffer.byteLength(entry.content, "utf8") !== entry.size
  ) {
    throw new ExecutionError("TEXT_INVALID", 400, "A staged text entry is inconsistent.");
  }
}

async function collect(source: AsyncIterable<StagingEntry>): Promise<Map<string, StagingEntry>> {
  const result = new Map<string, StagingEntry>();
  for await (const entry of source) {
    assertEntry(entry);
    const key = pathKey(entry.path);
    if (result.has(key)) {
      throw new ExecutionError("STAGED_LIMIT_EXCEEDED", 413, "Staged paths collide.");
    }
    result.set(key, { ...entry, path: entry.path.normalize("NFC") });
    if (result.size > MAX_OBSERVATIONS) {
      throw new ExecutionError("STAGED_LIMIT_EXCEEDED", 413, "Staged observations exceed 100000.");
    }
  }
  return result;
}

function fitUtf8(value: string, maximumBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) return value;
  let result = "";
  let bytes = 0;
  for (const scalar of value) {
    const scalarBytes = Buffer.byteLength(scalar, "utf8");
    if (bytes + scalarBytes > maximumBytes) break;
    result += scalar;
    bytes += scalarBytes;
  }
  return result;
}

export function createBoundedUtf8Text(value: string): BoundedText {
  const originalBytes = Buffer.byteLength(value, "utf8");
  const text = fitUtf8(value, MAX_TEXT_BYTES);
  const chunks: TextChunk[] = [];
  let current = "";
  let currentBytes = 0;
  let byteOffset = 0;
  const flush = () => {
    if (currentBytes === 0) return;
    chunks.push({
      byteLength: currentBytes,
      byteOffset,
      sha256: sha256(current),
      text: current,
    });
    byteOffset += currentBytes;
    current = "";
    currentBytes = 0;
  };
  for (const scalar of text) {
    const scalarBytes = Buffer.byteLength(scalar, "utf8");
    if (currentBytes + scalarBytes > MAX_CHUNK_BYTES) flush();
    current += scalar;
    currentBytes += scalarBytes;
  }
  flush();
  const bytes = Buffer.byteLength(text, "utf8");
  const result = {
    bytes,
    chunks,
    sha256: sha256(text),
    truncated: originalBytes > bytes,
  };
  assertTextChunkInvariants(result, chunks);
  return result;
}

export function assertTextChunkInvariants(
  header: { bytes: number; sha256: string },
  chunks: TextChunk[],
): void {
  if (chunks.length > 17) throw new Error("Chunk index exceeds the 0..16 range.");
  let offset = 0;
  let text = "";
  for (const [index, chunk] of chunks.entries()) {
    if (chunk.byteOffset !== offset) throw new Error(`Chunk offset gap at index ${index}.`);
    const bytes = Buffer.byteLength(chunk.text, "utf8");
    if (bytes !== chunk.byteLength || bytes < 1 || bytes > MAX_CHUNK_BYTES) {
      throw new Error(`Chunk byte length is invalid at index ${index}.`);
    }
    if (sha256(chunk.text) !== chunk.sha256) throw new Error(`Chunk hash is invalid at index ${index}.`);
    text += chunk.text;
    offset += bytes;
  }
  if (offset !== header.bytes) throw new Error("Chunk total bytes do not match the header.");
  if (sha256(text) !== header.sha256) throw new Error("Chunk whole-value hash does not match the header.");
  if (header.bytes === 0 && chunks.length !== 0) throw new Error("Empty text must have zero chunks.");
  if (header.bytes > 0 && chunks.length === 0) throw new Error("Non-empty text must have chunks.");
}

function displayDiff(before: StagingEntry | undefined, after: StagingEntry | undefined) {
  if (after?.kind !== "text" || after.content === undefined) {
    return { bytes: 0, text: null, truncated: false };
  }
  const raw = [
    `--- ${before?.path ?? "/dev/null"}`,
    `+++ ${after.path}`,
    ...(before?.content === undefined ? [] : before.content.split(/\r?\n/u).map((line) => `-${line}`)),
    ...after.content!.split(/\r?\n/u).map((line) => `+${line}`),
  ].join("\n");
  const text = fitUtf8(raw, MAX_DIFF_BYTES);
  return {
    bytes: Buffer.byteLength(text, "utf8"),
    text,
    truncated: text.length !== raw.length,
  };
}

function exactValidations(
  requiredPolicyEntryIds: string[],
  validations: ValidationSnapshot[],
  sandboxManifestHash: string,
  policyRevisionId: string,
  lastFileChangeAt: string | null,
): boolean {
  return requiredPolicyEntryIds.every((policyEntryId) =>
    validations.some((validation) =>
      validation.policyEntryId === policyEntryId
      && validation.policyRevisionId === policyRevisionId
      && validation.manifestHash === sandboxManifestHash
      && validation.required
      && validation.exitCode === 0
      && validation.succeeded
      && (lastFileChangeAt === null || validation.finishedAt > lastFileChangeAt)));
}

const BLOCKER_PRIORITY: StagedBlockerKind[] = [
  "special",
  "binary",
  "renamed",
  "deleted",
  "permission",
  "file_size_limit",
  "file_count_limit",
  "byte_limit",
];

function blockerFor(
  observation: ComputedStagedObservation,
  position: number,
  cumulativeBytes: number,
): ComputedStagedBlocker | null {
  const codes: StagedBlockerKind[] = [];
  if (["special", "binary", "renamed", "deleted", "permission"].includes(observation.kind)) {
    codes.push(observation.kind as StagedBlockerKind);
  }
  if (observation.finalSize > MAX_FILE_BYTES) codes.push("file_size_limit");
  if (position >= MAX_MERGE_FILES) codes.push("file_count_limit");
  if (cumulativeBytes > MAX_MERGE_BYTES) codes.push("byte_limit");
  codes.sort((left, right) => BLOCKER_PRIORITY.indexOf(left) - BLOCKER_PRIORITY.indexOf(right));
  const [kind, ...secondaryCodes] = codes;
  return kind
    ? {
        detailCode: kind.toUpperCase(),
        kind,
        observationId: observation.id,
        path: observation.path,
        position,
        secondaryCodes,
      }
    : null;
}

export async function computeStagedSnapshot(input: {
  attemptId: string;
  baseline: AsyncIterable<StagingEntry>;
  baselineManifestHash: string;
  contextHash: string;
  lastFileChangeAt?: string | null;
  pendingApproval: boolean;
  pendingAction?: boolean;
  policyHash: string;
  policyRevisionId: string;
  requiredValidations: ValidationSnapshot[];
  requiredPolicyEntryIds: string[];
  sandbox: AsyncIterable<StagingEntry>;
  sandboxManifestHash: string;
}): Promise<ComputedStagedSnapshot> {
  if (input.pendingApproval) {
    throw new ExecutionError("APPROVAL_STATE_CONFLICT", 409, "Pending approval blocks staging.");
  }
  if (input.pendingAction) {
    throw new ExecutionError("OPERATION_IN_PROGRESS", 409, "Pending action blocks staging.");
  }
  const [baseline, sandbox] = await Promise.all([collect(input.baseline), collect(input.sandbox)]);
  const keys = [...new Set([...baseline.keys(), ...sandbox.keys()])]
    .sort((left, right) => comparePath(
      sandbox.get(left)?.path ?? baseline.get(left)!.path,
      sandbox.get(right)?.path ?? baseline.get(right)!.path,
    ));
  const deletedByHash = new Map<string, string[]>();
  const addedByHash = new Map<string, string[]>();
  for (const key of keys) {
    const before = baseline.get(key);
    const after = sandbox.get(key);
    if (before && !after) {
      const deleted = deletedByHash.get(before.sha256);
      if (deleted) deleted.push(key);
      else deletedByHash.set(before.sha256, [key]);
    }
    if (!before && after) {
      const added = addedByHash.get(after.sha256);
      if (added) added.push(key);
      else addedByHash.set(after.sha256, [key]);
    }
  }
  const stableRenameKeys = new Set<string>();
  for (const [entryHash, deleted] of deletedByHash) {
    const added = addedByHash.get(entryHash) ?? [];
    if (deleted.length === 1 && added.length === 1) {
      stableRenameKeys.add(deleted[0]);
      stableRenameKeys.add(added[0]);
    }
  }

  const observations: ComputedStagedObservation[] = [];
  for (const key of keys) {
    const before = baseline.get(key);
    const after = sandbox.get(key);
    if (
      before
      && after
      && before.sha256 === after.sha256
      && before.size === after.size
      && before.modeTag === after.modeTag
      && before.kind === after.kind
    ) continue;
    let kind: StagedObservationKind;
    if (stableRenameKeys.has(key)) kind = "renamed";
    else if (!after) kind = "deleted";
    else if (after.kind === "link" || after.kind === "special") kind = "special";
    else if (after.kind === "binary") kind = "binary";
    else if (before && before.sha256 === after.sha256 && before.modeTag !== after.modeTag) {
      kind = "permission";
    } else if (!before) kind = "added";
    else kind = "modified";
    const diff = keys.length <= MAX_MERGE_FILES
      ? displayDiff(before, after)
      : { bytes: 0, text: null, truncated: false };
    observations.push({
      baselineHash: before?.sha256 ?? null,
      diffBytes: diff.bytes,
      diffText: diff.text,
      diffTruncated: diff.truncated,
      finalSize: after?.size ?? 0,
      id: `${input.attemptId}:observation:${observations.length}`,
      kind,
      modeTag: after?.modeTag ?? before?.modeTag ?? "",
      observedHash: after?.sha256 ?? null,
      path: after?.path ?? before!.path,
      pathKey: key,
      position: observations.length,
    });
    if (observations.length > MAX_OBSERVATIONS) {
      throw new ExecutionError("STAGED_LIMIT_EXCEEDED", 413, "Changed paths exceed 100000.");
    }
  }

  if (observations.length === 0) {
    return {
      blockReasons: ["STAGED_NO_CHANGES"],
      blockers: [],
      classification: "blocked",
      mergeFiles: [],
      observations: [],
      outcome: "no_changes",
      stagedHash: null,
      totals: {
        blockerCount: 0,
        mergeFileCount: 0,
        mergeFinalBytes: 0,
        observedFinalBytes: 0,
        observedPathCount: 0,
      },
    };
  }

  let cumulativeBytes = 0;
  const blockers: ComputedStagedBlocker[] = [];
  for (const observation of observations) {
    cumulativeBytes += observation.finalSize;
    const blocker = blockerFor(observation, observation.position, cumulativeBytes);
    if (blocker) blockers.push(blocker);
  }
  const validationsCurrent = exactValidations(
    input.requiredPolicyEntryIds,
    input.requiredValidations,
    input.sandboxManifestHash,
    input.policyRevisionId,
    input.lastFileChangeAt ?? null,
  );
  const blockReasons = [
    ...(blockers.length > 0 ? ["STAGED_FILES_BLOCKED"] : []),
    ...(!validationsCurrent ? ["VALIDATION_REQUIRED"] : []),
  ];
  const globallyEligible = blockers.length === 0 && validationsCurrent;
  const mergeFiles = globallyEligible
    ? observations.map((observation) => sandbox.get(observation.pathKey)!)
    : [];
  const classification = !globallyEligible
    ? "blocked"
    : input.requiredPolicyEntryIds.length === 0
      ? "approval_required"
      : "auto_eligible";
  const mergeFinalBytes = mergeFiles.reduce((total, file) => total + file.size, 0);
  const hashInput = {
    attemptId: input.attemptId,
    baselineManifestHash: input.baselineManifestHash,
    blockers: blockers.map(({ detailCode: _detailCode, ...blocker }) => blocker),
    contextHash: input.contextHash,
    mergeFiles: mergeFiles.map(({ content: _content, ...file }) => file),
    observations: observations.map(({ diffText, id: _id, ...observation }) => ({
      ...observation,
      diffHash: diffText === null ? null : sha256(diffText),
    })),
    observedTotals: {
      finalBytes: cumulativeBytes,
      pathCount: observations.length,
    },
    policyHash: input.policyHash,
    policyRevisionId: input.policyRevisionId,
    sandboxManifestHash: input.sandboxManifestHash,
    validations: input.requiredValidations,
  };
  return {
    blockReasons,
    blockers,
    classification,
    mergeFiles,
    observations,
    outcome: "ready",
    stagedHash: canonicalHash(hashInput),
    totals: {
      blockerCount: blockers.length,
      mergeFileCount: mergeFiles.length,
      mergeFinalBytes,
      observedFinalBytes: cumulativeBytes,
      observedPathCount: observations.length,
    },
  };
}

export function persistArtifactOutput(
  database: DatabaseSync,
  input: {
    attemptId: string;
    executionId: string;
    name: string;
    output: BoundedText;
    path: string;
    projectId: string;
  },
): string {
  assertTextChunkInvariants(input.output, input.output.chunks);
  const id = randomUUID();
  return inSavepoint(database, () => {
    database.prepare(`
      INSERT INTO execution_artifacts (
        id,project_id,execution_id,attempt_id,name,path,content_bytes,sha256,truncated,created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?,
        strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    `).run(
      id,
      input.projectId,
      input.executionId,
      input.attemptId,
      input.name,
      input.path,
      input.output.bytes,
      input.output.sha256,
      input.output.truncated ? 1 : 0,
    );
    for (const [index, chunk] of input.output.chunks.entries()) {
      database.prepare(`
        INSERT INTO execution_artifact_chunks (
          artifact_id,chunk_index,byte_offset,byte_length,text,sha256
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(id, index, chunk.byteOffset, chunk.byteLength, chunk.text, chunk.sha256);
    }
    return id;
  });
}

export function persistValidationOutput(
  database: DatabaseSync,
  input: {
    attemptId: string;
    executionId: string;
    exitCode: number;
    policyEntryId: string;
    policyRevisionId: string;
    projectId: string;
    required: boolean;
    sandboxManifestHash: string;
    stderr: BoundedText;
    stdout: BoundedText;
    succeeded: boolean;
    toolCallId: string;
  },
): string {
  assertTextChunkInvariants(input.stdout, input.stdout.chunks);
  assertTextChunkInvariants(input.stderr, input.stderr.chunks);
  const id = randomUUID();
  return inSavepoint(database, () => {
    database.prepare(`
      INSERT INTO execution_validation_results (
        id,project_id,execution_id,attempt_id,policy_revision_id,policy_entry_id,
        tool_call_id,sandbox_manifest_hash,required,exit_code,succeeded,
        stdout_bytes,stderr_bytes,stdout_sha256,stderr_sha256,
        stdout_truncated,stderr_truncated,finished_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    `).run(
      id,
      input.projectId,
      input.executionId,
      input.attemptId,
      input.policyRevisionId,
      input.policyEntryId,
      input.toolCallId,
      input.sandboxManifestHash,
      input.required ? 1 : 0,
      input.exitCode,
      input.succeeded ? 1 : 0,
      input.stdout.bytes,
      input.stderr.bytes,
      input.stdout.sha256,
      input.stderr.sha256,
      input.stdout.truncated ? 1 : 0,
      input.stderr.truncated ? 1 : 0,
    );
    const insert = database.prepare(`
      INSERT INTO execution_validation_output_chunks (
        validation_id,stream,chunk_index,byte_offset,byte_length,text,sha256
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const [stream, output] of [["stdout", input.stdout], ["stderr", input.stderr]] as const) {
      for (const [index, chunk] of output.chunks.entries()) {
        insert.run(id, stream, index, chunk.byteOffset, chunk.byteLength, chunk.text, chunk.sha256);
      }
    }
    return id;
  });
}

export function persistComputedStage(
  database: DatabaseSync,
  input: {
    actionId: string;
    baselineManifestHash: string;
    body: unknown;
    contextHash: string;
    executionId: string;
    expectedSandboxManifestHash?: string;
    expectedVersion: number;
    leaseToken: string;
    policyHash: string;
    projectId: string;
    sandboxManifestHash: string;
    sandboxManifestPath?: string;
    snapshot: ComputedStagedSnapshot;
  },
): { affectedRows: 0 | 1; stagedResultId: string | null } {
  if (input.snapshot.outcome !== "ready" || !input.snapshot.stagedHash) {
    throw new Error("Only a completed staged snapshot can be persisted.");
  }
  const stagedResultId = randomUUID();
  const finalized = finalizeExecutionActionWithEffects(database, {
    actionId: input.actionId,
    body: input.body,
    effects(currentDatabase) {
      const current = currentDatabase.prepare(`
        SELECT e.status,e.version,a.baseline_manifest_hash AS baselineHash,
               a.sandbox_manifest_hash AS sandboxHash,a.frozen_context_hash AS contextHash,
               a.frozen_policy_hash AS policyHash
        FROM executions e JOIN execution_attempts a
          ON a.execution_id=e.id AND a.attempt_no=e.current_attempt_no
        WHERE e.project_id=? AND e.id=? AND a.id=(
          SELECT attempt_id FROM execution_actions WHERE id=?
        )
      `).get(input.projectId, input.executionId, input.actionId) as {
        baselineHash: string;
        contextHash: string;
        policyHash: string;
        sandboxHash: string;
        status: string;
        version: number;
      } | undefined;
      if (
        !current
        || current.status !== "running"
        || current.version !== input.expectedVersion
        || current.baselineHash !== input.baselineManifestHash
        || current.sandboxHash !== (
          input.expectedSandboxManifestHash ?? input.sandboxManifestHash
        )
        || current.contextHash !== input.contextHash
        || current.policyHash !== input.policyHash
      ) throw new ExecutionError("STALE_EXECUTION", 409, "Stage input changed before commit.");
      const previousSandboxHash = input.expectedSandboxManifestHash ?? input.sandboxManifestHash;
      const refreshed = currentDatabase.prepare(`
        UPDATE execution_attempts
        SET status='completed',sandbox_manifest_path=?,sandbox_manifest_hash=?,
            finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id=(SELECT attempt_id FROM execution_actions WHERE id=?)
          AND status IN ('ready','acting') AND sandbox_manifest_hash=?
      `).run(
        input.sandboxManifestPath ?? null,
        input.sandboxManifestHash,
        input.actionId,
        previousSandboxHash,
      );
      if (refreshed.changes !== 1) {
        throw new ExecutionError("STALE_EXECUTION", 409, "Stage manifest changed before commit.");
      }
      if (currentDatabase.prepare(`
        SELECT 1 FROM execution_approvals
        WHERE execution_id=? AND status IN ('pending','approved')
      `).get(input.executionId)) {
        throw new ExecutionError("APPROVAL_STATE_CONFLICT", 409, "Approval changed before stage commit.");
      }
      const attempt = currentDatabase.prepare(`
        SELECT action.attempt_id AS id,attempt.attempt_no AS attemptNo
        FROM execution_actions action
        JOIN execution_attempts attempt ON attempt.id=action.attempt_id
        WHERE action.id=?
      `).get(input.actionId) as { attemptNo: number; id: string };
      currentDatabase.prepare(`
        INSERT INTO execution_staged_results (
          id,project_id,execution_id,attempt_id,action_id,baseline_manifest_hash,
          sandbox_manifest_hash,context_hash,policy_hash,staged_hash,
          observed_path_count,observed_final_bytes,merge_file_count,merge_final_bytes,
          blocker_count,classification,block_reasons_json,created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      `).run(
        stagedResultId,
        input.projectId,
        input.executionId,
        attempt.id,
        input.actionId,
        input.baselineManifestHash,
        input.sandboxManifestHash,
        input.contextHash,
        input.policyHash,
        input.snapshot.stagedHash,
        input.snapshot.totals.observedPathCount,
        input.snapshot.totals.observedFinalBytes,
        input.snapshot.totals.mergeFileCount,
        input.snapshot.totals.mergeFinalBytes,
        input.snapshot.totals.blockerCount,
        input.snapshot.classification,
        JSON.stringify(input.snapshot.blockReasons),
      );
      if (input.snapshot.classification === "approval_required") {
        createStagedMergeApproval({
          attemptId: attempt.id,
          contextHash: input.contextHash,
          database: currentDatabase,
          executionId: input.executionId,
          inputHash: input.sandboxManifestHash,
          projectId: input.projectId,
          stagedHash: input.snapshot.stagedHash!,
        });
      }
      const insertObservation = currentDatabase.prepare(`
        INSERT INTO execution_staged_observations (
          id,staged_result_id,position,path,path_key,kind,baseline_hash,observed_hash,
          final_size,diff_text,diff_bytes,diff_truncated
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const observation of input.snapshot.observations) {
        insertObservation.run(
          observation.id,
          stagedResultId,
          observation.position,
          observation.path,
          observation.pathKey,
          observation.kind,
          observation.baselineHash,
          observation.observedHash,
          observation.finalSize,
          observation.diffText,
          observation.diffBytes,
          observation.diffTruncated ? 1 : 0,
        );
      }
      const insertBlocker = currentDatabase.prepare(`
        INSERT INTO execution_staged_blockers (
          staged_result_id,observation_id,position,path,kind,detail_json
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const blocker of input.snapshot.blockers) {
        insertBlocker.run(
          stagedResultId,
          blocker.observationId,
          blocker.position,
          blocker.path,
          blocker.kind,
          JSON.stringify({
            detailCode: blocker.detailCode,
            secondaryCodes: blocker.secondaryCodes,
          }),
        );
      }
      const byPath = new Map(input.snapshot.observations.map((item) => [item.pathKey, item]));
      const insertFile = currentDatabase.prepare(`
        INSERT INTO execution_staged_files (
          id,staged_result_id,observation_id,position,path,path_key,kind,
          baseline_hash,staged_hash,size
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const [position, file] of input.snapshot.mergeFiles.entries()) {
        const observation = byPath.get(pathKey(file.path))!;
        insertFile.run(
          randomUUID(),
          stagedResultId,
          observation.id,
          position,
          file.path,
          observation.pathKey,
          observation.kind,
          observation.baselineHash,
          file.sha256,
          file.size,
        );
      }
      const execution = currentDatabase.prepare(`
        UPDATE executions SET status='staged',reason_code=NULL,resume_target=NULL,
          version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE project_id=? AND id=? AND version=? AND status='running'
      `).run(input.projectId, input.executionId, input.expectedVersion);
      if (execution.changes !== 1) {
        throw new ExecutionError("EXECUTION_STATE_CONFLICT", 409, "Execution changed during stage commit.");
      }
      reserveExecutionStagedPaths(currentDatabase, {
        attemptNo: attempt.attemptNo,
        executionId: input.executionId,
        paths: input.snapshot.mergeFiles.map(({ path }) => path),
        projectId: input.projectId,
      });
    },
    httpStatus: 200,
    leaseToken: input.leaseToken,
    projectId: input.projectId,
    result: { stagedHash: input.snapshot.stagedHash, stagedResultId },
    status: "succeeded",
  });
  return {
    affectedRows: finalized.affectedRows,
    stagedResultId: finalized.affectedRows === 1 ? stagedResultId : null,
  };
}
