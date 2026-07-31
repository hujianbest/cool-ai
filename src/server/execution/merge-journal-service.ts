import { createHash, randomUUID } from "node:crypto";
import { constants, statSync } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import {
  dirname,
  join,
  resolve,
  sep,
} from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { normalizeCanonicalRelativePath } from "@/src/server/execution/execution-conflicts";
import { staleExecutionIfFrozenInputChanged } from "@/src/server/execution/execution-frozen-input";
import {
  assertManualRecoveryNotRequired,
  ExecutionError,
} from "@/src/server/execution/execution-service";

export type MergeFaultPoint =
  | "before_prepare"
  | "after_old_read"
  | "after_backup"
  | "after_durable_new"
  | "after_journal_persist"
  | "before_apply_file"
  | "after_temp_write"
  | "before_replace"
  | "after_replace"
  | "after_file_mark"
  | "after_all_files"
  | "before_precommit_check"
  | "after_precommit_check"
  | "before_db_commit"
  | "after_db_commit"
  | "after_postcommit_check"
  | "before_cleanup"
  | "after_cleanup"
  | "before_finalize";

type MergeInput = {
  database: DatabaseSync;
  executionId: string;
  expectedVersion: number;
  hooks?: {
    point(input: { path: string | null; point: MergeFaultPoint }): void | Promise<void>;
  };
  journalBaseRoot: string;
  operationId: string;
  projectId: string;
  stagedHash: string;
  workspaceRoot: string;
};

type StagedFileRow = {
  baselineHash: string | null;
  kind: "added" | "modified";
  path: string;
  pathKey: string;
  position: number;
  size: number;
  stagedHash: string;
};

type PreparedFile = StagedFileRow & {
  backupHash: string | null;
  backupIdentity: string | null;
  backupPath: string | null;
  durableNewIdentity: string;
  durableNewPath: string;
  oldExists: boolean;
  oldHash: string | null;
  oldIdentity: string | null;
  parentIdentity: string;
  postIdentity: string;
  tempName: string;
};

type PathState = {
  bytes: Buffer;
  hash: string;
  identity: string;
};

type MergeResult = {
  actionId: string;
  journalId: string;
  oldManifestHash: string;
  postManifestHash: string;
};

type CommitResult = {
  body: {
    execution: {
      id: string;
      mergedAt: string;
      status: "merged";
      version: number;
    };
    result: {
      createdAt: string;
      executionId: string;
      id: string;
      mergeJournalId: string;
      stagedResultId: string;
      status: "awaiting_review";
    };
  };
  status: number;
};

type MergeOperationResult = {
  body: unknown;
  status: number;
};

type JournalRow = {
  actionId: string;
  attemptId: string;
  executionId: string;
  id: string;
  journalRoot: string;
  operationId: string;
  oldManifestHash: string;
  postManifestHash: string;
  projectId: string;
  stagedResultId: string;
  status: string;
};

type ObservedManifestEntry = {
  exists: boolean;
  hash: string | null;
  identity: string | null;
  path: string;
  pathKey: string;
  type?: "special";
};

type ManualResolutionAction = "recovered_old" | "recovered_new" | "abandon";

type JournalFileRow = {
  backupPath: string | null;
  durableNewPath: string;
  newHash: string;
  oldExists: number;
  oldHash: string | null;
  oldIdentity: string | null;
  ownedBackupHash: string | null;
  ownedBackupIdentity: string | null;
  ownedNewIdentity: string;
  path: string;
  pathKey: string;
  position: number;
  postIdentity: string;
};

const MAX_FILES = 100;
const MAX_FILE_BYTES = 1_048_576;
const MAX_BYTES = 10_485_760;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function compareUtf8(left: string, right: string): number {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

function identityOf(value: Awaited<ReturnType<FileHandle["stat"]>>): string {
  return `${value.dev}:${value.ino}`;
}

function comparablePath(value: string): string {
  const withoutDevicePrefix = process.platform === "win32" && value.startsWith("\\\\?\\")
    ? value.slice(4)
    : value;
  return resolve(withoutDevicePrefix);
}

function isWithin(root: string, candidate: string): boolean {
  const normalizedRoot = comparablePath(root);
  const normalizedCandidate = comparablePath(candidate);
  const rootKey = process.platform === "win32" ? normalizedRoot.toLowerCase() : normalizedRoot;
  const candidateKey = process.platform === "win32"
    ? normalizedCandidate.toLowerCase()
    : normalizedCandidate;
  return candidateKey === rootKey || candidateKey.startsWith(`${rootKey}${sep}`);
}

function transaction<T>(database: DatabaseSync, work: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Keep the original boundary error.
    }
    throw error;
  }
}

async function callHook(
  input: MergeInput,
  point: MergeFaultPoint,
  path: string | null = null,
): Promise<void> {
  await input.hooks?.point({ path, point });
}

async function syncDirectory(path: string): Promise<void> {
  let handle: FileHandle | null = null;
  try {
    handle = await open(path, constants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    if (process.platform !== "win32") throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function writeDurable(path: string, bytes: Uint8Array): Promise<PathState> {
  await mkdir(dirname(path), { recursive: true });
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const handle = await open(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | noFollow,
    0o600,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    const facts = await handle.stat();
    if (!facts.isFile() || Number(facts.size) !== bytes.byteLength) {
      throw new ExecutionError("MERGE_INVARIANT_FAILED", 500, "Durable merge file is incomplete.");
    }
    return {
      bytes: Buffer.from(bytes),
      hash: sha256(bytes),
      identity: identityOf(facts),
    };
  } finally {
    await handle.close();
  }
}

async function readOrdinary(path: string, maximumBytes = MAX_FILE_BYTES): Promise<PathState> {
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    const before = await handle.stat();
    if (!before.isFile() || Number(before.size) > maximumBytes) {
      throw new ExecutionError("STAGED_NOT_ELIGIBLE", 422, "Merge path is not an eligible file.");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      identityOf(before) !== identityOf(after)
      || before.size !== after.size
      || bytes.byteLength !== Number(before.size)
    ) {
      throw new ExecutionError("STALE_EXECUTION", 409, "Merge path changed while being read.");
    }
    return {
      bytes,
      hash: sha256(bytes),
      identity: identityOf(after),
    };
  } finally {
    await handle.close();
  }
}

async function readOptional(path: string): Promise<PathState | null> {
  try {
    return await readOrdinary(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function readCanonicalOptional(path: string): Promise<PathState | null> {
  try {
    return await readOptional(path);
  } catch (error) {
    throw new ExecutionError(
      "MERGE_RECOVERY_REQUIRED",
      409,
      `Canonical path is no longer an ordinary stable file: ${
        error instanceof Error ? error.message : "unknown mismatch"
      }`,
    );
  }
}

async function directoryIdentity(path: string, root: string): Promise<string> {
  const [resolved, resolvedRoot] = await Promise.all([realpath(path), realpath(root)]);
  if (!isWithin(resolvedRoot, resolved)) {
    throw new ExecutionError("MERGE_INVARIANT_FAILED", 500, "Merge parent escaped the workspace.");
  }
  const facts = await stat(path, { bigint: true });
  if (!facts.isDirectory()) {
    throw new ExecutionError("MERGE_INVARIANT_FAILED", 500, "Merge parent is not a directory.");
  }
  return `${facts.dev}:${facts.ino}`;
}

async function assertParentIdentity(file: PreparedFile, workspaceRoot: string): Promise<void> {
  const current = await directoryIdentity(dirname(join(workspaceRoot, file.path)), workspaceRoot);
  if (current !== file.parentIdentity) {
    throw new ExecutionError("MERGE_RECOVERY_REQUIRED", 409, "Merge parent identity changed.");
  }
}

function sameState(
  current: PathState | null,
  expected: { exists: boolean; hash: string | null; identity: string | null },
): boolean {
  return expected.exists
    ? current !== null
      && current.hash === expected.hash
      && current.identity === expected.identity
    : current === null;
}

function manifestHash(entries: unknown): string {
  return sha256(JSON.stringify(entries));
}

function assertExternalRoots(workspaceRoot: string, journalBaseRoot: string): void {
  const workspace = resolve(workspaceRoot);
  const journal = resolve(journalBaseRoot);
  if (isWithin(workspace, journal) || isWithin(journal, workspace)) {
    throw new ExecutionError(
      "MERGE_INVARIANT_FAILED",
      500,
      "Merge journal and canonical workspace roots must not overlap.",
    );
  }
}

function validateAndBegin(
  input: MergeInput,
  ids: { actionId: string; journalId: string; leaseToken: string },
): { attemptId: string; sandboxRoot: string; stagedId: string; files: StagedFileRow[] } {
  return transaction(input.database, () => {
    assertManualRecoveryNotRequired(input.database, input.executionId);
    const unresolved = input.database.prepare(`
      SELECT 1 FROM execution_merge_journals
      WHERE project_id=? AND status IN (
        'prepared','applying','db_committed','rolling_back','rolling_forward','manual_recovery'
      ) LIMIT 1
    `).get(input.projectId);
    if (unresolved) {
      throw new ExecutionError(
        "MERGE_RECOVERY_REQUIRED",
        409,
        "The project already has an unresolved merge journal.",
      );
    }
    const existingOperation = input.database.prepare(`
      SELECT kind,request_hash AS requestHash,status
      FROM execution_operations WHERE project_id=? AND id=?
    `).get(input.projectId, input.operationId) as {
      kind: string;
      requestHash: string;
      status: string;
    } | undefined;
    const requestHash = sha256(JSON.stringify({
      executionId: input.executionId,
      expectedVersion: input.expectedVersion,
      kind: "merge",
      stagedHash: input.stagedHash,
    }));
    if (existingOperation) {
      if (existingOperation.kind !== "merge" || existingOperation.requestHash !== requestHash) {
        throw new ExecutionError("OPERATION_CONFLICT", 409, "Operation id has different input.");
      }
      throw new ExecutionError("OPERATION_IN_PROGRESS", 409, "Merge operation is already pending.");
    }

    const staged = input.database.prepare(`
      SELECT e.status,e.version,e.manual_recovery_required AS manualRecoveryRequired,
             e.business_deadline_at AS deadline,a.id AS attemptId,a.sandbox_root AS sandboxRoot,
             a.baseline_manifest_hash AS attemptBaselineHash,
             a.sandbox_manifest_hash AS attemptSandboxHash,
             a.frozen_context_hash AS attemptContextHash,
             a.frozen_policy_hash AS attemptPolicyHash,
             a.frozen_policy_revision_id AS policyRevisionId,
             s.id AS stagedId,s.staged_hash AS stagedHash,
             s.baseline_manifest_hash AS baselineHash,
             s.sandbox_manifest_hash AS sandboxHash,s.context_hash AS contextHash,
             s.policy_hash AS policyHash,s.merge_file_count AS mergeFileCount,
             s.merge_final_bytes AS mergeFinalBytes,s.blocker_count AS blockerCount,
             s.classification
      FROM executions e
      JOIN execution_attempts a
        ON a.execution_id=e.id AND a.project_id=e.project_id
       AND a.attempt_no=e.current_attempt_no
      JOIN execution_staged_results s
        ON s.execution_id=e.id AND s.project_id=e.project_id AND s.attempt_id=a.id
      WHERE e.project_id=? AND e.id=? AND s.staged_hash=?
    `).get(input.projectId, input.executionId, input.stagedHash) as {
      attemptBaselineHash: string;
      attemptContextHash: string;
      attemptId: string;
      attemptPolicyHash: string;
      attemptSandboxHash: string;
      baselineHash: string;
      blockerCount: number;
      classification: string;
      contextHash: string;
      deadline: string;
      manualRecoveryRequired: number;
      mergeFileCount: number;
      mergeFinalBytes: number;
      policyHash: string;
      policyRevisionId: string;
      sandboxHash: string;
      sandboxRoot: string;
      stagedHash: string;
      stagedId: string;
      status: string;
      version: number;
    } | undefined;
    if (
      !staged
      || staged.status !== "staged"
      || staged.version !== input.expectedVersion
      || staged.manualRecoveryRequired !== 0
    ) {
      throw new ExecutionError("EXECUTION_STATE_CONFLICT", 409, "Execution is not mergeable.");
    }
    if (
      staged.attemptBaselineHash !== staged.baselineHash
      || staged.attemptSandboxHash !== staged.sandboxHash
      || staged.attemptContextHash !== staged.contextHash
      || staged.attemptPolicyHash !== staged.policyHash
    ) {
      throw new ExecutionError("STALE_EXECUTION", 409, "Staged context or baseline changed.");
    }
    if (
      staged.blockerCount !== 0
      || !["auto_eligible", "approval_required"].includes(staged.classification)
      || staged.mergeFileCount < 1
      || staged.mergeFileCount > MAX_FILES
      || staged.mergeFinalBytes > MAX_BYTES
    ) {
      throw new ExecutionError("STAGED_NOT_ELIGIBLE", 422, "Staged result is not merge eligible.");
    }
    const files = input.database.prepare(`
      SELECT position,path,path_key AS pathKey,kind,baseline_hash AS baselineHash,
             staged_hash AS stagedHash,size
      FROM execution_staged_files WHERE staged_result_id=? ORDER BY position
    `).all(staged.stagedId) as StagedFileRow[];
    const totalBytes = files.reduce((total, file) => total + file.size, 0);
    if (
      files.length !== staged.mergeFileCount
      || totalBytes !== staged.mergeFinalBytes
      || files.some((file, index) =>
        file.position !== index
        || file.size < 0
        || file.size > MAX_FILE_BYTES
        || !HASH_PATTERN.test(file.stagedHash)
        || (file.kind === "modified" && !HASH_PATTERN.test(file.baselineHash ?? "")))
    ) {
      throw new ExecutionError("STAGED_NOT_ELIGIBLE", 422, "Staged file rows are inconsistent.");
    }
    const sorted = [...files].sort((left, right) => compareUtf8(left.path, right.path));
    if (files.some((file, index) => file.path !== sorted[index].path)) {
      throw new ExecutionError("STAGED_NOT_ELIGIBLE", 422, "Staged files are not in stable order.");
    }
    for (const file of files) {
      const normalized = normalizeCanonicalRelativePath(file.path);
      if (normalized !== file.pathKey) {
        throw new ExecutionError("STAGED_NOT_ELIGIBLE", 422, "Staged path key is invalid.");
      }
    }
    const conflict = input.database.prepare(`
      SELECT 1
      FROM execution_staged_files mine
      JOIN execution_staged_files other ON other.path_key=mine.path_key
      JOIN execution_staged_results result ON result.id=other.staged_result_id
      JOIN executions execution ON execution.id=result.execution_id
      WHERE mine.staged_result_id=? AND result.execution_id<>?
        AND result.project_id=?
        AND execution.status IN ('queued','running','waiting_approval','paused','staged','conflicted')
      LIMIT 1
    `).get(staged.stagedId, input.executionId, input.projectId);
    if (conflict) {
      throw new ExecutionError("PATH_CONFLICT", 409, "Another execution owns a staged path.");
    }
    const requiredCount = Number((input.database.prepare(`
      SELECT count(*) AS count FROM project_validation_policy_entries
      WHERE project_id=? AND revision_id=? AND required=1
    `).get(input.projectId, staged.policyRevisionId) as { count: number }).count);
    const validCount = Number((input.database.prepare(`
      SELECT count(DISTINCT entry.id) AS count
      FROM project_validation_policy_entries entry
      JOIN execution_validation_results result
        ON result.project_id=entry.project_id
       AND result.policy_revision_id=entry.revision_id
       AND result.policy_entry_id=entry.id
      WHERE entry.project_id=? AND entry.revision_id=? AND entry.required=1
        AND result.execution_id=? AND result.attempt_id=?
        AND result.sandbox_manifest_hash=? AND result.succeeded=1 AND result.exit_code=0
    `).get(
      input.projectId,
      staged.policyRevisionId,
      input.executionId,
      staged.attemptId,
      staged.sandboxHash,
    ) as { count: number }).count);
    if (validCount !== requiredCount) {
      throw new ExecutionError("VALIDATION_REQUIRED", 422, "Required validation is not current.");
    }
    if (staged.classification === "approval_required") {
      const approval = input.database.prepare(`
        UPDATE execution_approvals
        SET status='consumed',consumed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE project_id=? AND execution_id=? AND attempt_id=? AND kind='staged_merge'
          AND status='approved' AND staged_hash=?
      `).run(input.projectId, input.executionId, staged.attemptId, input.stagedHash);
      if (approval.changes !== 1) {
        throw new ExecutionError("APPROVAL_STATE_CONFLICT", 409, "Staged merge approval is missing.");
      }
    }

    const now = new Date().toISOString();
    const leaseExpiresAt = new Date(Date.now() + 120_000).toISOString();
    input.database.prepare(`
      INSERT INTO execution_operations (
        id,project_id,execution_id,kind,request_hash,has_external_actions,action_count,
        final_action_index,status,http_status,response_json,created_at,updated_at
      ) VALUES (?, ?, ?, 'merge', ?, 1, 1, NULL, 'pending', NULL, NULL, ?, ?)
    `).run(
      input.operationId,
      input.projectId,
      input.executionId,
      requestHash,
      now,
      now,
    );
    input.database.prepare(`
      INSERT INTO execution_actions (
        id,project_id,execution_id,attempt_id,operation_id,action_index,kind,status,
        request_hash,lease_token,lease_expires_at,overall_deadline_at,last_heartbeat_at,
        result_json,error_code,created_at,started_at,finished_at
      ) VALUES (?, ?, ?, ?, ?, 0, 'merge_apply', 'running', ?, ?, ?, ?, ?,
        NULL, NULL, ?, ?, NULL)
    `).run(
      ids.actionId,
      input.projectId,
      input.executionId,
      staged.attemptId,
      input.operationId,
      requestHash,
      ids.leaseToken,
      leaseExpiresAt < staged.deadline ? leaseExpiresAt : staged.deadline,
      staged.deadline,
      now,
      now,
      now,
    );
    return {
      attemptId: staged.attemptId,
      files,
      sandboxRoot: staged.sandboxRoot,
      stagedId: staged.stagedId,
    };
  });
}

async function prepareFiles(
  input: MergeInput,
  actionId: string,
  journalRoot: string,
  sandboxRoot: string,
  rows: StagedFileRow[],
): Promise<PreparedFile[]> {
  await mkdir(join(journalRoot, "backups"), { recursive: true });
  await mkdir(join(journalRoot, "new"), { recursive: true });
  const prepared: PreparedFile[] = [];
  for (const row of rows) {
    const targetPath = join(input.workspaceRoot, row.path);
    const sourcePath = join(sandboxRoot, row.path);
    if (!isWithin(input.workspaceRoot, targetPath) || !isWithin(sandboxRoot, sourcePath)) {
      throw new ExecutionError("STAGED_NOT_ELIGIBLE", 422, "Merge path escaped a root.");
    }
    const parentPath = dirname(targetPath);
    const parentIdentity = await directoryIdentity(parentPath, input.workspaceRoot);
    const old = await readOptional(targetPath);
    await callHook(input, "after_old_read", row.path);
    if (
      row.kind === "modified"
        ? !old || old.hash !== row.baselineHash
        : old !== null || row.baselineHash !== null
    ) {
      throw new ExecutionError("STALE_EXECUTION", 409, "Canonical baseline changed before merge.");
    }

    let backupPath: string | null = null;
    let backup: PathState | null = null;
    if (old) {
      backupPath = join(journalRoot, "backups", `${row.position}.bin`);
      backup = await writeDurable(backupPath, old.bytes);
      await syncDirectory(dirname(backupPath));
    }
    await callHook(input, "after_backup", row.path);

    const source = await readOrdinary(sourcePath);
    if (source.hash !== row.stagedHash || source.bytes.byteLength !== row.size) {
      throw new ExecutionError("STALE_EXECUTION", 409, "Sandbox staged bytes changed before merge.");
    }
    const durableNewPath = join(journalRoot, "new", `${row.position}.bin`);
    const durableNew = await writeDurable(durableNewPath, source.bytes);
    await syncDirectory(dirname(durableNewPath));
    await callHook(input, "after_durable_new", row.path);

    const tempName = `.cool-ai-merge-${actionId}-${row.position}.tmp`;
    const tempPath = join(parentPath, tempName);
    const temp = await writeDurable(tempPath, source.bytes);
    await syncDirectory(parentPath);
    prepared.push({
      ...row,
      backupHash: backup?.hash ?? null,
      backupIdentity: backup?.identity ?? null,
      backupPath,
      durableNewIdentity: durableNew.identity,
      durableNewPath,
      oldExists: old !== null,
      oldHash: old?.hash ?? null,
      oldIdentity: old?.identity ?? null,
      parentIdentity,
      postIdentity: temp.identity,
      tempName,
    });
  }
  return prepared;
}

async function persistJournal(
  input: MergeInput,
  ids: { actionId: string; journalId: string },
  prepared: PreparedFile[],
  stagedId: string,
  attemptId: string,
  journalRoot: string,
): Promise<{ oldManifestHash: string; postManifestHash: string }> {
  const oldManifest = prepared.map((file) => ({
    exists: file.oldExists,
    hash: file.oldHash,
    identity: file.oldIdentity,
    path: file.path,
    pathKey: file.pathKey,
  }));
  const postManifest = prepared.map((file) => ({
    exists: true,
    hash: file.stagedHash,
    identity: file.postIdentity,
    path: file.path,
    pathKey: file.pathKey,
  }));
  const oldManifestBytes = Buffer.from(JSON.stringify(oldManifest), "utf8");
  const postManifestBytes = Buffer.from(JSON.stringify(postManifest), "utf8");
  const oldManifestHash = manifestHash(oldManifest);
  const postManifestHash = manifestHash(postManifest);
  await writeDurable(join(journalRoot, "old-manifest.json"), oldManifestBytes);
  await writeDurable(join(journalRoot, "post-manifest.json"), postManifestBytes);
  await syncDirectory(journalRoot);

  transaction(input.database, () => {
    input.database.prepare(`
      INSERT INTO execution_merge_journals (
        id,project_id,execution_id,attempt_id,staged_result_id,merge_action_id,
        operation_id,status,next_file_position,old_manifest_hash,post_manifest_hash,
        observed_manifest_hash,mismatch_phase,mismatch_path_key,journal_root,error_code,
        created_at,updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'prepared', 0, ?, ?, NULL, NULL, NULL, ?, NULL,
        strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    `).run(
      ids.journalId,
      input.projectId,
      input.executionId,
      attemptId,
      stagedId,
      ids.actionId,
      input.operationId,
      oldManifestHash,
      postManifestHash,
      journalRoot,
    );
    const insert = input.database.prepare(`
      INSERT INTO execution_merge_files (
        journal_id,position,path,path_key,old_exists,old_identity,old_hash,
        post_identity,new_hash,backup_path,durable_new_path,owned_backup_identity,
        owned_backup_hash,owned_new_identity,status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
    `);
    for (const file of prepared) {
      insert.run(
        ids.journalId,
        file.position,
        file.path,
        file.pathKey,
        file.oldExists ? 1 : 0,
        file.oldIdentity,
        file.oldHash,
        file.postIdentity,
        file.stagedHash,
        file.backupPath,
        file.durableNewPath,
        file.backupIdentity,
        file.backupHash,
        file.durableNewIdentity,
      );
    }
  });
  return { oldManifestHash, postManifestHash };
}

async function removeTempConditionally(
  input: MergeInput,
  file: PreparedFile,
): Promise<boolean> {
  const tempPath = join(dirname(join(input.workspaceRoot, file.path)), file.tempName);
  const current = await readOptional(tempPath);
  if (!sameState(current, {
    exists: true,
    hash: file.stagedHash,
    identity: file.postIdentity,
  })) return current === null;
  await unlink(tempPath);
  await syncDirectory(dirname(tempPath));
  return true;
}

async function rollbackApplied(
  input: MergeInput,
  journalId: string | null,
  files: PreparedFile[],
  applied: PreparedFile[],
): Promise<boolean> {
  let complete = true;
  for (const file of [...applied].reverse()) {
    const targetPath = join(input.workspaceRoot, file.path);
    try {
      await assertParentIdentity(file, input.workspaceRoot);
      const current = await readCanonicalOptional(targetPath);
      if (!sameState(current, {
        exists: true,
        hash: file.stagedHash,
        identity: file.postIdentity,
      })) {
        complete = false;
        continue;
      }
      if (!file.oldExists) {
        await unlink(targetPath);
        await syncDirectory(dirname(targetPath));
      } else {
        const backup = await readOrdinary(file.backupPath!);
        if (
          backup.hash !== file.backupHash
          || backup.identity !== file.backupIdentity
          || backup.hash !== file.oldHash
        ) {
          complete = false;
          continue;
        }
        const rollbackName = `.cool-ai-rollback-${randomUUID()}.tmp`;
        const rollbackPath = join(dirname(targetPath), rollbackName);
        await writeDurable(rollbackPath, backup.bytes);
        const beforeReplace = await readCanonicalOptional(targetPath);
        if (!sameState(beforeReplace, {
          exists: true,
          hash: file.stagedHash,
          identity: file.postIdentity,
        })) {
          await rm(rollbackPath, { force: true });
          complete = false;
          continue;
        }
        await rename(rollbackPath, targetPath);
        await syncDirectory(dirname(targetPath));
        const restored = await readCanonicalOptional(targetPath);
        if (!restored || restored.hash !== file.oldHash) complete = false;
      }
      if (journalId) {
        input.database.prepare(`
          UPDATE execution_merge_files SET status='rolled_back'
          WHERE journal_id=? AND position=?
        `).run(journalId, file.position);
      }
    } catch {
      complete = false;
    }
  }
  for (const file of files) {
    try {
      if (!(await removeTempConditionally(input, file))) complete = false;
    } catch {
      complete = false;
    }
  }
  return complete;
}

function failDurableOperation(
  input: MergeInput,
  actionId: string,
  journalId: string | null,
  code: string,
  message: string,
): void {
  transaction(input.database, () => {
    if (journalId) {
      input.database.prepare(`
        UPDATE execution_merge_journals
        SET status='rolling_back',error_code=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id=?
      `).run(code, journalId);
    }
    input.database.prepare(`
      UPDATE execution_actions
      SET status='failed',lease_token=NULL,lease_expires_at=NULL,error_code=?,
          result_json=?,finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id=? AND status='running'
    `).run(code, JSON.stringify({ code }), actionId);
    input.database.prepare(`
      UPDATE execution_operations
      SET status='completed',final_action_index=0,http_status=?,
          response_json=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE project_id=? AND id=? AND status='pending' AND action_count=1
    `).run(
      code === "MERGE_RECOVERY_REQUIRED" ? 409 : 500,
      JSON.stringify({ error: { code, message } }),
      input.projectId,
      input.operationId,
    );
  });
}

async function applyPrepared(
  input: MergeInput,
  journalId: string,
  prepared: PreparedFile[],
  applied: PreparedFile[],
): Promise<void> {
  input.database.prepare(`
    UPDATE execution_merge_journals
    SET status='applying',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id=? AND status='prepared'
  `).run(journalId);
  for (const file of prepared) {
    await callHook(input, "before_apply_file", file.path);
    await assertParentIdentity(file, input.workspaceRoot);
    const targetPath = join(input.workspaceRoot, file.path);
    const current = await readCanonicalOptional(targetPath);
    if (!sameState(current, {
      exists: file.oldExists,
      hash: file.oldHash,
      identity: file.oldIdentity,
    })) {
      throw new ExecutionError("STALE_EXECUTION", 409, "Canonical path changed before apply.");
    }
    const tempPath = join(dirname(targetPath), file.tempName);
    const temp = await readOrdinary(tempPath);
    if (temp.hash !== file.stagedHash || temp.identity !== file.postIdentity) {
      throw new ExecutionError("MERGE_INVARIANT_FAILED", 500, "Owned merge temp changed.");
    }
    await callHook(input, "after_temp_write", file.path);
    await assertParentIdentity(file, input.workspaceRoot);
    const immediatelyBefore = await readCanonicalOptional(targetPath);
    if (!sameState(immediatelyBefore, {
      exists: file.oldExists,
      hash: file.oldHash,
      identity: file.oldIdentity,
    })) {
      throw new ExecutionError("STALE_EXECUTION", 409, "Canonical path changed before replace.");
    }
    await callHook(input, "before_replace", file.path);
    const atReplace = await readCanonicalOptional(targetPath);
    if (!sameState(atReplace, {
      exists: file.oldExists,
      hash: file.oldHash,
      identity: file.oldIdentity,
    })) {
      throw new ExecutionError(
        "MERGE_RECOVERY_REQUIRED",
        409,
        "Canonical path changed in the replace window.",
      );
    }
    await rename(tempPath, targetPath);
    applied.push(file);
    await syncDirectory(dirname(targetPath));
    await callHook(input, "after_replace", file.path);
    await assertParentIdentity(file, input.workspaceRoot);
    const after = await readCanonicalOptional(targetPath);
    if (!sameState(after, {
      exists: true,
      hash: file.stagedHash,
      identity: file.postIdentity,
    })) {
      throw new ExecutionError("MERGE_RECOVERY_REQUIRED", 409, "Canonical path changed after replace.");
    }
    input.database.prepare(`
      UPDATE execution_merge_files SET status='applied'
      WHERE journal_id=? AND position=? AND status='pending'
    `).run(journalId, file.position);
    input.database.prepare(`
      UPDATE execution_merge_journals
      SET next_file_position=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id=? AND status='applying'
    `).run(file.position + 1, journalId);
    await callHook(input, "after_file_mark", file.path);
  }
  await callHook(input, "after_all_files");
}

function journalRow(database: DatabaseSync, journalId: string): JournalRow {
  const row = database.prepare(`
    SELECT id,project_id AS projectId,execution_id AS executionId,
           attempt_id AS attemptId,staged_result_id AS stagedResultId,
           merge_action_id AS actionId,operation_id AS operationId,status,
           old_manifest_hash AS oldManifestHash,post_manifest_hash AS postManifestHash,
           journal_root AS journalRoot
    FROM execution_merge_journals WHERE id=?
  `).get(journalId) as JournalRow | undefined;
  if (!row) {
    throw new ExecutionError("MERGE_INVARIANT_FAILED", 500, "Merge journal was not found.");
  }
  return row;
}

function journalFiles(database: DatabaseSync, journalId: string): JournalFileRow[] {
  return database.prepare(`
    SELECT position,path,path_key AS pathKey,old_exists AS oldExists,
           old_identity AS oldIdentity,old_hash AS oldHash,
           post_identity AS postIdentity,new_hash AS newHash,
           backup_path AS backupPath,durable_new_path AS durableNewPath,
           owned_backup_identity AS ownedBackupIdentity,
           owned_backup_hash AS ownedBackupHash,owned_new_identity AS ownedNewIdentity
    FROM execution_merge_files WHERE journal_id=? ORDER BY position
  `).all(journalId) as JournalFileRow[];
}

function workspaceFor(database: DatabaseSync, projectId: string): string {
  const row = database.prepare(
    "SELECT workspace_path AS workspaceRoot FROM projects WHERE id=?",
  ).get(projectId) as { workspaceRoot: string } | undefined;
  if (!row) throw new ExecutionError("PROJECT_NOT_FOUND", 404, "Project was not found.");
  return row.workspaceRoot;
}

function storedCommitResult(
  database: DatabaseSync,
  journal: JournalRow,
): MergeOperationResult | null {
  const operation = database.prepare(`
    SELECT status,http_status AS httpStatus,response_json AS responseJson
    FROM execution_operations WHERE project_id=? AND id=?
  `).get(journal.projectId, journal.operationId) as {
    httpStatus: number | null;
    responseJson: string | null;
    status: string;
  } | undefined;
  if (
    operation?.status !== "completed"
    || operation.httpStatus === null
    || operation.responseJson === null
  ) return null;
  return {
    body: JSON.parse(operation.responseJson) as unknown,
    status: operation.httpStatus,
  };
}

async function assertPostManifest(
  database: DatabaseSync,
  journal: JournalRow,
  workspaceRoot: string,
): Promise<void> {
  const files = journalFiles(database, journal.id);
  const manifest = files.map((file) => ({
    exists: true,
    hash: file.newHash,
    identity: file.postIdentity,
    path: file.path,
    pathKey: file.pathKey,
  }));
  if (manifestHash(manifest) !== journal.postManifestHash) {
    throw new ExecutionError("MERGE_INVARIANT_FAILED", 500, "Stored post manifest drifted.");
  }
  for (const file of files) {
    const current = await readCanonicalOptional(join(workspaceRoot, file.path));
    if (!sameState(current, {
      exists: true,
      hash: file.newHash,
      identity: file.postIdentity,
    })) {
      throw new ExecutionError(
        "MERGE_RECOVERY_REQUIRED",
        409,
        "Canonical path does not match the committed post manifest.",
      );
    }
  }
}

async function observeJournalManifest(
  database: DatabaseSync,
  journal: JournalRow,
  workspaceRoot: string,
): Promise<{ entries: ObservedManifestEntry[]; hash: string }> {
  const entries: ObservedManifestEntry[] = [];
  for (const file of journalFiles(database, journal.id)) {
    const path = join(workspaceRoot, file.path);
    try {
      const current = await readOptional(path);
      entries.push(current
        ? {
            exists: true,
            hash: current.hash,
            identity: current.identity,
            path: file.path,
            pathKey: file.pathKey,
          }
        : {
            exists: false,
            hash: null,
            identity: null,
            path: file.path,
            pathKey: file.pathKey,
          });
    } catch {
      try {
        const facts = await lstat(path, { bigint: true });
        entries.push({
          exists: true,
          hash: null,
          identity: `${facts.dev}:${facts.ino}`,
          path: file.path,
          pathKey: file.pathKey,
          type: "special",
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        entries.push({
          exists: false,
          hash: null,
          identity: null,
          path: file.path,
          pathKey: file.pathKey,
        });
      }
    }
  }
  return { entries, hash: manifestHash(entries) };
}

function expectedManifest(
  database: DatabaseSync,
  journal: JournalRow,
  target: "old" | "post",
): ObservedManifestEntry[] {
  return journalFiles(database, journal.id).map((file) => target === "old"
    ? {
        exists: file.oldExists === 1,
        hash: file.oldHash,
        identity: file.oldIdentity,
        path: file.path,
        pathKey: file.pathKey,
      }
    : {
        exists: true,
        hash: file.newHash,
        identity: file.postIdentity,
        path: file.path,
        pathKey: file.pathKey,
      });
}

async function enterManualRecovery(
  database: DatabaseSync,
  journal: JournalRow,
  mismatchPhase: string,
): Promise<{ entries: ObservedManifestEntry[]; hash: string }> {
  const workspaceRoot = workspaceFor(database, journal.projectId);
  const observed = await observeJournalManifest(database, journal, workspaceRoot);
  transaction(database, () => {
    database.prepare(
      "DELETE FROM work_item_execution_results WHERE merge_journal_id=?",
    ).run(journal.id);
    database.prepare(`
      UPDATE executions
      SET status='conflicted',manual_recovery_required=1,recovery_resolution=NULL,
          merged_at=NULL,reason_code='MANUAL_RECOVERY_REQUIRED',
          version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE project_id=? AND id=?
    `).run(journal.projectId, journal.executionId);
    database.prepare(`
      UPDATE execution_merge_journals
      SET status='manual_recovery',observed_manifest_hash=?,mismatch_phase=?,
          error_code='MANUAL_RECOVERY_REQUIRED',
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id=?
    `).run(observed.hash, mismatchPhase, journal.id);
    database.prepare(`
      UPDATE execution_actions
      SET status='failed',lease_token=NULL,lease_expires_at=NULL,
          error_code='MANUAL_RECOVERY_REQUIRED',
          result_json='{"code":"MANUAL_RECOVERY_REQUIRED"}',
          finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id=? AND status IN ('running','interrupted')
    `).run(journal.actionId);
    const body = JSON.stringify({
      error: {
        code: "MANUAL_RECOVERY_REQUIRED",
        message: "An external writer changed the canonical workspace.",
      },
    });
    database.prepare(`
      UPDATE execution_operations
      SET status='completed',final_action_index=0,http_status=409,response_json=?,
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE project_id=? AND id=? AND status='pending'
    `).run(body, journal.projectId, journal.operationId);
  });
  return observed;
}

async function cleanupOwnedJournal(
  database: DatabaseSync,
  journal: JournalRow,
): Promise<void> {
  if (!existsSyncCompat(journal.journalRoot)) return;
  for (const file of journalFiles(database, journal.id)) {
    const durableNew = await readOptional(file.durableNewPath);
    if (durableNew && !sameState(durableNew, {
      exists: true,
      hash: file.newHash,
      identity: file.ownedNewIdentity,
    })) {
      throw new ExecutionError("MERGE_RECOVERY_REQUIRED", 409, "Owned durable-new changed.");
    }
    if (file.backupPath) {
      const backup = await readOptional(file.backupPath);
      if (backup && !sameState(backup, {
        exists: true,
        hash: file.ownedBackupHash,
        identity: file.ownedBackupIdentity,
      })) {
        throw new ExecutionError("MERGE_RECOVERY_REQUIRED", 409, "Owned backup changed.");
      }
    }
  }
  await rm(journal.journalRoot, { force: true, recursive: true });
  await syncDirectory(dirname(journal.journalRoot));
}

function existsSyncCompat(path: string): boolean {
  try {
    statSyncCompat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function statSyncCompat(path: string): void {
  const handle = statSync(path);
  if (!handle.isDirectory()) {
    throw new ExecutionError("MERGE_RECOVERY_REQUIRED", 409, "Journal root changed type.");
  }
}

function insertEvent(
  database: DatabaseSync,
  input: {
    actorType: "system";
    attemptNo: number;
    executionId: string;
    payload: unknown;
    projectId: string;
    sequence: number;
    type: string;
  },
): void {
  database.prepare(`
    INSERT INTO execution_events (
      id,project_id,execution_id,sequence,attempt_no,type,actor_type,actor_id,
      payload_json,created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?,
      strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  `).run(
    randomUUID(),
    input.projectId,
    input.executionId,
    input.sequence,
    input.attemptNo,
    input.type,
    input.actorType,
    JSON.stringify(input.payload),
  );
}

function commitDatabaseFacts(
  database: DatabaseSync,
  journal: JournalRow,
  alreadyInTransaction = false,
): void {
  if (!alreadyInTransaction) database.exec("BEGIN IMMEDIATE");
  try {
    const execution = database.prepare(`
      SELECT mission_id AS missionId,work_item_id AS workItemId,
             current_attempt_no AS attemptNo,next_event_sequence AS nextSequence,
             status,version
      FROM executions WHERE project_id=? AND id=?
    `).get(journal.projectId, journal.executionId) as {
      attemptNo: number;
      missionId: string;
      nextSequence: number;
      status: string;
      version: number;
      workItemId: string;
    } | undefined;
    if (!execution || execution.status !== "staged") {
      throw new ExecutionError("EXECUTION_STATE_CONFLICT", 409, "Execution is not staged.");
    }
    const resultId = randomUUID();
    database.prepare(`
      INSERT INTO work_item_execution_results (
        id,project_id,mission_id,work_item_id,execution_id,staged_result_id,
        merge_journal_id,status,created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'awaiting_review',
        strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    `).run(
      resultId,
      journal.projectId,
      execution.missionId,
      execution.workItemId,
      journal.executionId,
      journal.stagedResultId,
      journal.id,
    );
    const updated = database.prepare(`
      UPDATE executions
      SET status='merged',merged_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
          version=version+1,next_event_sequence=next_event_sequence+2
      WHERE project_id=? AND id=? AND status='staged' AND version=?
    `).run(journal.projectId, journal.executionId, execution.version);
    if (updated.changes !== 1) {
      throw new ExecutionError("EXECUTION_STATE_CONFLICT", 409, "Merge commit lost execution CAS.");
    }
    database.prepare(`
      UPDATE execution_attempts
      SET status='completed',finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE project_id=? AND execution_id=? AND id=?
    `).run(journal.projectId, journal.executionId, journal.attemptId);
    insertEvent(database, {
      actorType: "system",
      attemptNo: execution.attemptNo,
      executionId: journal.executionId,
      payload: { from: "staged", reasonCode: null, to: "merged" },
      projectId: journal.projectId,
      sequence: execution.nextSequence,
      type: "status_changed",
    });
    insertEvent(database, {
      actorType: "system",
      attemptNo: execution.attemptNo,
      executionId: journal.executionId,
      payload: {
        journalId: journal.id,
        resultId,
        stagedHash: (database.prepare(
          "SELECT staged_hash AS stagedHash FROM execution_staged_results WHERE id=?",
        ).get(journal.stagedResultId) as { stagedHash: string }).stagedHash,
      },
      projectId: journal.projectId,
      sequence: execution.nextSequence + 1,
      type: "merged",
    });
    database.prepare(`
      UPDATE execution_merge_journals
      SET status='db_committed',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id=? AND status IN ('applying','rolling_forward')
    `).run(journal.id);
    if (!alreadyInTransaction) database.exec("COMMIT");
  } catch (error) {
    if (!alreadyInTransaction) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Preserve the commit boundary error.
      }
    }
    throw error;
  }
}

function publicCommitBody(database: DatabaseSync, journal: JournalRow): CommitResult["body"] {
  const row = database.prepare(`
    SELECT e.id AS executionId,e.status,e.version,e.merged_at AS mergedAt,
           r.id AS resultId,r.staged_result_id AS stagedResultId,
           r.merge_journal_id AS mergeJournalId,r.status AS resultStatus,
           r.created_at AS resultCreatedAt
    FROM executions e
    JOIN work_item_execution_results r ON r.execution_id=e.id
    WHERE e.project_id=? AND e.id=? AND r.merge_journal_id=?
  `).get(journal.projectId, journal.executionId, journal.id) as {
    executionId: string;
    mergeJournalId: string;
    mergedAt: string;
    resultCreatedAt: string;
    resultId: string;
    resultStatus: "awaiting_review";
    stagedResultId: string;
    status: "merged";
    version: number;
  } | undefined;
  if (!row || row.status !== "merged" || row.resultStatus !== "awaiting_review") {
    throw new ExecutionError("MERGE_INVARIANT_FAILED", 500, "Committed merge facts are incomplete.");
  }
  return {
    execution: {
      id: row.executionId,
      mergedAt: row.mergedAt,
      status: row.status,
      version: row.version,
    },
    result: {
      createdAt: row.resultCreatedAt,
      executionId: row.executionId,
      id: row.resultId,
      mergeJournalId: row.mergeJournalId,
      stagedResultId: row.stagedResultId,
      status: row.resultStatus,
    },
  };
}

function finalizeCommittedMerge(database: DatabaseSync, journal: JournalRow): CommitResult {
  const body = publicCommitBody(database, journal);
  const responseJson = JSON.stringify(body);
  transaction(database, () => {
    const execution = database.prepare(`
      SELECT current_attempt_no AS attemptNo,next_event_sequence AS nextSequence
      FROM executions WHERE project_id=? AND id=? AND status='merged'
    `).get(journal.projectId, journal.executionId) as {
      attemptNo: number;
      nextSequence: number;
    } | undefined;
    if (!execution) {
      throw new ExecutionError("MERGE_INVARIANT_FAILED", 500, "Merged execution disappeared.");
    }
    const action = database.prepare(
      "SELECT status FROM execution_actions WHERE id=?",
    ).get(journal.actionId) as { status: string } | undefined;
    if (action?.status === "running") {
      database.prepare(`
        UPDATE execution_merge_files SET status='verified' WHERE journal_id=?
      `).run(journal.id);
      database.prepare(`
        UPDATE execution_merge_journals
        SET status='completed',error_code=NULL,
            updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id=? AND status='db_committed'
      `).run(journal.id);
      database.prepare(`
        UPDATE execution_actions
        SET status='succeeded',lease_token=NULL,lease_expires_at=NULL,
            result_json=?,error_code=NULL,
            finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id=? AND status='running'
      `).run(JSON.stringify({ journalId: journal.id, status: "merged" }), journal.actionId);
      insertEvent(database, {
        actorType: "system",
        attemptNo: execution.attemptNo,
        executionId: journal.executionId,
        payload: {
          actionId: journal.actionId,
          actionIndex: 0,
          code: "MERGED",
          kind: "merge_apply",
          operationId: journal.operationId,
          status: "succeeded",
        },
        projectId: journal.projectId,
        sequence: execution.nextSequence,
        type: "action_finished",
      });
      database.prepare(`
        UPDATE executions SET next_event_sequence=next_event_sequence+1 WHERE id=?
      `).run(journal.executionId);
      const completed = database.prepare(`
        UPDATE execution_operations
        SET status='completed',final_action_index=0,http_status=200,response_json=?,
            updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE project_id=? AND id=? AND status='pending' AND action_count=1
      `).run(responseJson, journal.projectId, journal.operationId);
      if (completed.changes !== 1) {
        throw new ExecutionError("MERGE_INVARIANT_FAILED", 500, "Merge receipt did not complete.");
      }
    }
  });
  return { body, status: 200 };
}

async function callCommitHook(
  hooks: { point(input: { path: string | null; point: MergeFaultPoint }): void | Promise<void> } | undefined,
  point: MergeFaultPoint,
  path: string | null = null,
): Promise<void> {
  await hooks?.point({ path, point });
}

export async function executeMergeCommit(input: {
  database: DatabaseSync;
  hooks?: {
    point(input: { path: string | null; point: MergeFaultPoint }): void | Promise<void>;
  };
  journalId: string;
}): Promise<MergeOperationResult> {
  let journal = journalRow(input.database, input.journalId);
  const replay = storedCommitResult(input.database, journal);
  if (replay) return replay;
  const workspaceRoot = workspaceFor(input.database, journal.projectId);

  try {
    if (journal.status === "applying") {
    await callCommitHook(input.hooks, "before_precommit_check");
    await assertPostManifest(input.database, journal, workspaceRoot);
    await callCommitHook(input.hooks, "after_precommit_check");
    input.database.exec("BEGIN IMMEDIATE");
    try {
      await assertPostManifest(input.database, journal, workspaceRoot);
      await callCommitHook(input.hooks, "before_db_commit");
      commitDatabaseFacts(input.database, journal, true);
      input.database.exec("COMMIT");
    } catch (error) {
      try {
        input.database.exec("ROLLBACK");
      } catch {
        // Preserve the post-manifest or commit-point failure.
      }
      throw error;
    }
    await callCommitHook(input.hooks, "after_db_commit");
      journal = journalRow(input.database, input.journalId);
    }
    if (journal.status !== "db_committed") {
      throw new ExecutionError("MERGE_INVARIANT_FAILED", 500, "Journal is not commit-ready.");
    }
    await assertPostManifest(input.database, journal, workspaceRoot);
    await callCommitHook(input.hooks, "after_postcommit_check");
    await callCommitHook(input.hooks, "before_cleanup");
    await cleanupOwnedJournal(input.database, journal);
    await callCommitHook(input.hooks, "after_cleanup");
    await callCommitHook(input.hooks, "before_finalize");
    await assertPostManifest(input.database, journal, workspaceRoot);
    return finalizeCommittedMerge(input.database, journal);
  } catch (error) {
    if (error instanceof ExecutionError && error.code === "MERGE_RECOVERY_REQUIRED") {
      await enterManualRecovery(input.database, journal, journal.status === "db_committed"
        ? "postcheck"
        : "precommit");
      throw new ExecutionError(
        "MANUAL_RECOVERY_REQUIRED",
        409,
        "An external writer changed the canonical workspace.",
      );
    }
    throw error;
  }
}

async function restoreAllOld(database: DatabaseSync, journal: JournalRow): Promise<void> {
  const workspaceRoot = workspaceFor(database, journal.projectId);
  const files = journalFiles(database, journal.id);
  for (const file of [...files].reverse()) {
    const targetPath = join(workspaceRoot, file.path);
    const current = await readCanonicalOptional(targetPath);
    const isPost = sameState(current, {
      exists: true,
      hash: file.newHash,
      identity: file.postIdentity,
    });
    const isOld = file.oldExists === 1
      ? current !== null && current.hash === file.oldHash
      : current === null;
    if (isOld) continue;
    if (!isPost) {
      throw new ExecutionError("MERGE_RECOVERY_REQUIRED", 409, "Recovery found a path mismatch.");
    }
    if (file.oldExists === 0) {
      await unlink(targetPath);
      await syncDirectory(dirname(targetPath));
    } else {
      const backup = await readOrdinary(file.backupPath!);
      if (!sameState(backup, {
        exists: true,
        hash: file.ownedBackupHash,
        identity: file.ownedBackupIdentity,
      }) || backup.hash !== file.oldHash) {
        throw new ExecutionError("MERGE_RECOVERY_REQUIRED", 409, "Recovery backup changed.");
      }
      const rollbackPath = join(dirname(targetPath), `.cool-ai-rollback-${randomUUID()}.tmp`);
      await writeDurable(rollbackPath, backup.bytes);
      const before = await readCanonicalOptional(targetPath);
      if (!sameState(before, {
        exists: true,
        hash: file.newHash,
        identity: file.postIdentity,
      })) {
        await rm(rollbackPath, { force: true });
        throw new ExecutionError("MERGE_RECOVERY_REQUIRED", 409, "Recovery target changed.");
      }
      await rename(rollbackPath, targetPath);
      await syncDirectory(dirname(targetPath));
      const restored = await readCanonicalOptional(targetPath);
      if (!restored || restored.hash !== file.oldHash) {
        throw new ExecutionError("MERGE_RECOVERY_REQUIRED", 409, "Rollback verification failed.");
      }
    }
    database.prepare(`
      UPDATE execution_merge_files SET status='rolled_back'
      WHERE journal_id=? AND position=?
    `).run(journal.id, file.position);
  }
}

function finalizeRolledBack(database: DatabaseSync, journal: JournalRow): MergeOperationResult {
  const errorBody = {
    error: {
      code: "MERGE_ACTION_INTERRUPTED",
      message: "Merge crashed before its database commit and was rolled back.",
    },
  };
  transaction(database, () => {
    database.prepare(`
      UPDATE execution_merge_journals
      SET status='completed',error_code='MERGE_ACTION_INTERRUPTED',
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id=? AND status IN ('prepared','applying','rolling_back')
    `).run(journal.id);
    database.prepare(`
      UPDATE execution_actions
      SET status='interrupted',lease_token=NULL,lease_expires_at=NULL,
          result_json=?,error_code='MERGE_ACTION_INTERRUPTED',
          finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id=? AND status='running'
    `).run(JSON.stringify({ code: "MERGE_ACTION_INTERRUPTED" }), journal.actionId);
    database.prepare(`
      UPDATE execution_operations
      SET status='completed',final_action_index=0,http_status=409,response_json=?,
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE project_id=? AND id=? AND status='pending' AND action_count=1
    `).run(JSON.stringify(errorBody), journal.projectId, journal.operationId);
  });
  return { body: errorBody, status: 409 };
}

export function assertNoMergeBarrier(database: DatabaseSync, projectId: string): void {
  const unresolved = database.prepare(`
    SELECT 1 FROM execution_merge_journals
    WHERE project_id=? AND status IN (
      'prepared','applying','db_committed','rolling_back','rolling_forward','manual_recovery'
    ) LIMIT 1
  `).get(projectId);
  if (unresolved) {
    throw new ExecutionError(
      "MERGE_RECOVERY_REQUIRED",
      409,
      "Incomplete merge recovery blocks public project facts.",
    );
  }
}

export async function recoverIncompleteMergeJournals(input: {
  database: DatabaseSync;
  projectId: string;
}): Promise<MergeOperationResult[]> {
  const rows = input.database.prepare(`
    SELECT id FROM execution_merge_journals
    WHERE project_id=? AND status IN (
      'prepared','applying','db_committed','rolling_back','rolling_forward'
    ) ORDER BY created_at,id
  `).all(input.projectId) as Array<{ id: string }>;
  const recovered: MergeOperationResult[] = [];
  for (const { id } of rows) {
    const journal = journalRow(input.database, id);
    try {
      if (["db_committed", "rolling_forward"].includes(journal.status)) {
        recovered.push(await executeMergeCommit({ database: input.database, journalId: id }));
        continue;
      }
      input.database.prepare(`
        UPDATE execution_merge_journals SET status='rolling_back' WHERE id=?
      `).run(id);
      await restoreAllOld(input.database, journal);
      await cleanupOwnedJournal(input.database, journal);
      recovered.push(finalizeRolledBack(input.database, journal));
    } catch (error) {
      if (error instanceof ExecutionError && error.code === "MANUAL_RECOVERY_REQUIRED") {
        throw error;
      }
      if (
        error instanceof ExecutionError
        && error.code === "MERGE_RECOVERY_REQUIRED"
      ) {
        await enterManualRecovery(input.database, journal, journal.status === "db_committed"
          ? "restart_rollforward"
          : "restart_rollback");
        throw new ExecutionError(
          "MANUAL_RECOVERY_REQUIRED",
          409,
          "Restart recovery found an external writer mismatch.",
        );
      }
      throw error;
    }
  }
  assertNoMergeBarrier(input.database, input.projectId);
  return recovered;
}

export async function executeMergePrepare(input: MergeInput): Promise<MergeResult> {
  assertExternalRoots(input.workspaceRoot, input.journalBaseRoot);
  const configuredWorkspace = input.database.prepare(
    "SELECT workspace_path AS workspaceRoot FROM projects WHERE id=?",
  ).get(input.projectId) as { workspaceRoot: string } | undefined;
  if (!configuredWorkspace || resolve(configuredWorkspace.workspaceRoot) !== resolve(input.workspaceRoot)) {
    throw new ExecutionError("PROJECT_NOT_FOUND", 404, "Project workspace does not match.");
  }
  const context = staleExecutionIfFrozenInputChanged(input.database, input.executionId);
  if (context.disposition === "stale") {
    throw new ExecutionError("STALE_EXECUTION", 409, "Execution context changed before merge.");
  }
  const ids = {
    actionId: randomUUID(),
    journalId: randomUUID(),
    leaseToken: randomUUID(),
  };
  const durable = validateAndBegin(input, ids);
  const journalRoot = join(input.journalBaseRoot, ids.actionId);
  let prepared: PreparedFile[] = [];
  let journalPersisted = false;
  let applied: PreparedFile[] = [];
  try {
    await callHook(input, "before_prepare");
    await mkdir(journalRoot, { recursive: true });
    prepared = await prepareFiles(
      input,
      ids.actionId,
      journalRoot,
      durable.sandboxRoot,
      durable.files,
    );
    const manifests = await persistJournal(
      input,
      ids,
      prepared,
      durable.stagedId,
      durable.attemptId,
      journalRoot,
    );
    journalPersisted = true;
    await callHook(input, "after_journal_persist");
    try {
      await applyPrepared(input, ids.journalId, prepared, applied);
    } catch (error) {
      const persistedApplied = prepared.filter((file) => {
        const row = input.database.prepare(`
          SELECT status FROM execution_merge_files WHERE journal_id=? AND position=?
        `).get(ids.journalId, file.position) as { status: string } | undefined;
        return row?.status === "applied";
      });
      applied = [...new Set([...applied, ...persistedApplied])];
      // The replace may have happened before the row status was persisted.
      for (const file of prepared) {
        if (applied.includes(file)) continue;
        const current = await readOptional(join(input.workspaceRoot, file.path)).catch(() => null);
        if (sameState(current, {
          exists: true,
          hash: file.stagedHash,
          identity: file.postIdentity,
        })) applied.push(file);
      }
      throw error;
    }
    return {
      actionId: ids.actionId,
      journalId: ids.journalId,
      ...manifests,
    };
  } catch (error) {
    const rolledBack = await rollbackApplied(
      input,
      journalPersisted ? ids.journalId : null,
      prepared,
      applied,
    );
    const externalMismatch = !rolledBack || (
      error instanceof ExecutionError
      && ["STALE_EXECUTION", "MERGE_RECOVERY_REQUIRED"].includes(error.code)
    );
    if (journalPersisted && externalMismatch) {
      await enterManualRecovery(
        input.database,
        journalRow(input.database, ids.journalId),
        "apply_or_rollback",
      );
      const recovery = new ExecutionError(
        "MANUAL_RECOVERY_REQUIRED",
        409,
        "Conditional merge rollback found an external writer mismatch.",
      );
      throw recovery;
    }
    const code = error instanceof ExecutionError ? error.code : "MERGE_INVARIANT_FAILED";
    failDurableOperation(
      input,
      ids.actionId,
      journalPersisted ? ids.journalId : null,
      code,
      error instanceof Error ? error.message : "Merge prepare failed.",
    );
    if (!journalPersisted) {
      await rm(journalRoot, { force: true, recursive: true }).catch(() => undefined);
    }
    throw error;
  }
}

async function cleanupOwnedForAbandon(
  database: DatabaseSync,
  journal: JournalRow,
): Promise<string[]> {
  const uncleaned: string[] = [];
  const workspaceRoot = workspaceFor(database, journal.projectId);
  for (const file of journalFiles(database, journal.id)) {
    const candidates = [
      {
        expected: {
          exists: true,
          hash: file.newHash,
          identity: file.ownedNewIdentity,
        },
        path: file.durableNewPath,
      },
      ...(file.backupPath
        ? [{
            expected: {
              exists: true,
              hash: file.ownedBackupHash,
              identity: file.ownedBackupIdentity,
            },
            path: file.backupPath,
          }]
        : []),
      {
        expected: {
          exists: true,
          hash: file.newHash,
          identity: file.postIdentity,
        },
        path: join(
          dirname(join(workspaceRoot, file.path)),
          `.cool-ai-merge-${journal.actionId}-${file.position}.tmp`,
        ),
      },
    ];
    for (const candidate of candidates) {
      try {
        const current = await readOptional(candidate.path);
        if (!current) continue;
        if (!sameState(current, candidate.expected)) {
          uncleaned.push(candidate.path);
          continue;
        }
        await unlink(candidate.path);
        await syncDirectory(dirname(candidate.path));
      } catch {
        uncleaned.push(candidate.path);
      }
    }
  }
  return [...new Set(uncleaned)];
}

function readResolutionReceipt(
  database: DatabaseSync,
  projectId: string,
  operationId: string,
  requestHash: string,
): MergeOperationResult | null {
  const row = database.prepare(`
    SELECT kind,request_hash AS requestHash,status,http_status AS httpStatus,
           response_json AS responseJson
    FROM execution_operations WHERE project_id=? AND id=?
  `).get(projectId, operationId) as {
    httpStatus: number | null;
    kind: string;
    requestHash: string;
    responseJson: string | null;
    status: string;
  } | undefined;
  if (!row) return null;
  if (row.kind !== "resolve_manual" || row.requestHash !== requestHash) {
    throw new ExecutionError("OPERATION_CONFLICT", 409, "Operation id has different input.");
  }
  if (row.status !== "completed" || row.httpStatus === null || row.responseJson === null) {
    throw new ExecutionError("OPERATION_IN_PROGRESS", 409, "Resolution is in progress.");
  }
  return { body: JSON.parse(row.responseJson) as unknown, status: row.httpStatus };
}

function persistResolutionReceipt(
  database: DatabaseSync,
  input: {
    executionId: string;
    operationId: string;
    projectId: string;
    requestHash: string;
  },
  result: MergeOperationResult,
  actionStatus: "failed" | "succeeded",
): void {
  const now = new Date().toISOString();
  const actionId = randomUUID();
  database.prepare(`
    INSERT INTO execution_operations (
      id,project_id,execution_id,kind,request_hash,has_external_actions,action_count,
      final_action_index,status,http_status,response_json,created_at,updated_at
    ) VALUES (?, ?, ?, 'resolve_manual', ?, 1, 1, 0, 'completed', ?, ?, ?, ?)
  `).run(
    input.operationId,
    input.projectId,
    input.executionId,
    input.requestHash,
    result.status,
    JSON.stringify(result.body),
    now,
    now,
  );
  const attempt = database.prepare(`
    SELECT id FROM execution_attempts
    WHERE project_id=? AND execution_id=?
    ORDER BY attempt_no DESC LIMIT 1
  `).get(input.projectId, input.executionId) as { id: string };
  database.prepare(`
    INSERT INTO execution_actions (
      id,project_id,execution_id,attempt_id,operation_id,action_index,kind,status,
      request_hash,overall_deadline_at,result_json,error_code,created_at,started_at,finished_at
    ) VALUES (?, ?, ?, ?, ?, 0, 'manual_resolution', ?, ?,
      strftime('%Y-%m-%dT%H:%M:%fZ','now','+120 seconds'), ?, ?, ?, ?, ?)
  `).run(
    actionId,
    input.projectId,
    input.executionId,
    attempt.id,
    input.operationId,
    actionStatus,
    input.requestHash,
    JSON.stringify(result.body),
    actionStatus === "failed" ? "RECOVERY_MANIFEST_MISMATCH" : null,
    now,
    now,
    now,
  );
}

export async function resolveManualRecovery(input: {
  action: ManualResolutionAction;
  database: DatabaseSync;
  executionId: string;
  expectedVersion: number;
  observedManifestHash: string;
  operationId: string;
  projectId: string;
}): Promise<MergeOperationResult> {
  const requestHash = sha256(JSON.stringify({
    action: input.action,
    executionId: input.executionId,
    expectedVersion: input.expectedVersion,
    kind: "resolve_manual",
    observedManifestHash: input.observedManifestHash,
  }));
  const replay = readResolutionReceipt(
    input.database,
    input.projectId,
    input.operationId,
    requestHash,
  );
  if (replay) return replay;
  const row = input.database.prepare(`
    SELECT j.id
    FROM execution_merge_journals j
    JOIN executions e ON e.id=j.execution_id AND e.project_id=j.project_id
    WHERE j.project_id=? AND j.execution_id=? AND j.status='manual_recovery'
      AND e.status='conflicted' AND e.manual_recovery_required=1 AND e.version=?
  `).get(input.projectId, input.executionId, input.expectedVersion) as { id: string } | undefined;
  if (!row) {
    throw new ExecutionError("MANUAL_RECOVERY_REQUIRED", 409, "Manual recovery state changed.");
  }
  const journal = journalRow(input.database, row.id);
  const observed = await observeJournalManifest(
    input.database,
    journal,
    workspaceFor(input.database, input.projectId),
  );
  const target = input.action === "recovered_old"
    ? journal.oldManifestHash
    : input.action === "recovered_new"
      ? journal.postManifestHash
      : observed.hash;
  if (
    observed.hash !== input.observedManifestHash
    || input.observedManifestHash !== target
  ) {
    const result = {
      body: {
        error: {
          code: "RECOVERY_MANIFEST_MISMATCH",
          message: "The canonical manifest changed; refresh before resolving.",
        },
        recovery: {
          observedManifestHash: observed.hash,
          observedPathCount: observed.entries.length,
        },
      },
      status: 409,
    };
    transaction(input.database, () => {
      input.database.prepare(`
        UPDATE execution_merge_journals
        SET observed_manifest_hash=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id=? AND status='manual_recovery'
      `).run(observed.hash, journal.id);
      persistResolutionReceipt(input.database, { ...input, requestHash }, result, "failed");
    });
    return result;
  }

  const uncleanedOwnedPaths = input.action === "abandon"
    ? await cleanupOwnedForAbandon(input.database, journal)
    : [];
  let result!: MergeOperationResult;
  transaction(input.database, () => {
    const execution = input.database.prepare(`
      SELECT mission_id AS missionId,work_item_id AS workItemId
      FROM executions WHERE project_id=? AND id=?
    `).get(input.projectId, input.executionId) as {
      missionId: string;
      workItemId: string;
    };
    if (input.action === "recovered_new") {
      input.database.prepare(`
        INSERT INTO work_item_execution_results (
          id,project_id,mission_id,work_item_id,execution_id,staged_result_id,
          merge_journal_id,status,created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'awaiting_review',
          strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      `).run(
        randomUUID(),
        input.projectId,
        execution.missionId,
        execution.workItemId,
        input.executionId,
        journal.stagedResultId,
        journal.id,
      );
    }
    const executionStatus = input.action === "recovered_new"
      ? "merged"
      : input.action === "abandon"
        ? "stopped"
        : "conflicted";
    input.database.prepare(`
      UPDATE executions
      SET status=?,manual_recovery_required=0,recovery_resolution=?,
          reason_code=NULL,merged_at=${input.action === "recovered_new"
            ? "strftime('%Y-%m-%dT%H:%M:%fZ','now')"
            : "NULL"},
          version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE project_id=? AND id=? AND version=? AND manual_recovery_required=1
    `).run(
      executionStatus,
      input.action === "abandon" ? "abandoned" : input.action,
      input.projectId,
      input.executionId,
      input.expectedVersion,
    );
    const journalStatus = input.action === "recovered_old"
      ? "resolved_old"
      : input.action === "recovered_new"
        ? "resolved_new"
        : "abandoned";
    input.database.prepare(`
      UPDATE execution_merge_journals
      SET status=?,error_code=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id=? AND status='manual_recovery'
    `).run(journalStatus, journal.id);
    result = {
      body: {
        execution: {
          id: input.executionId,
          recoveryResolution: input.action === "abandon" ? "abandoned" : input.action,
          status: executionStatus,
        },
        recovery: {
          journalStatus,
          observedManifestHash: observed.hash,
        },
        uncleanedOwnedPathCount: uncleanedOwnedPaths.length,
        uncleanedOwnedPaths,
      },
      status: 200,
    };
    persistResolutionReceipt(input.database, { ...input, requestHash }, result, "succeeded");
  });
  return result;
}
