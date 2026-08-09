import { createHash, randomUUID } from "node:crypto";
import { mkdir, rmdir } from "node:fs/promises";
import {
  dirname,
  join,
  resolve,
  sep,
} from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { consumeStagedMergeApproval } from "@/src/adapters/outbound/sqlite/governance/approval-store";
import { normalizeCanonicalRelativePath } from "@/src/server/execution/execution-conflicts";
import { staleExecutionIfFrozenInputChanged } from "@/src/server/execution/execution-frozen-input";
import {
  assertManualRecoveryNotRequired,
  ExecutionError,
} from "@/src/server/execution/execution-service";
import {
  createWindowsVerifiedMergeAdapter,
  type MergeVerifiedAdapter,
  type MergeVerifiedState,
} from "@/src/server/execution/merge-verified-adapter";
import type {
  ExpectedCanonicalFile,
  NativeMutationResult,
  VerifiedOwnedFileRef,
} from "@/src/server/execution/windows-native-merge-lifecycle";
import {
  recoveryMergeFileStatusSchema,
  type RecoveryMergeFileStatus,
} from "@/src/shared/execution-contracts";
import {
  advanceResultHeadTx,
  initializeFirstResultHeadTx,
} from "@/src/server/review/review-slice-service";

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
  fs?: MergeVerifiedAdapter;
  hooks?: {
    point(input: { path: string | null; point: MergeFaultPoint }): void | Promise<void>;
  };
  journalBaseRoot: string;
  operationId: string;
  projectId: string;
  stagedHash: string;
  workspaceRoot: string;
};

function mergeAdapter(input?: MergeVerifiedAdapter): MergeVerifiedAdapter {
  return input ?? createWindowsVerifiedMergeAdapter();
}

function sandboxRootForExecution(
  database: DatabaseSync,
  projectId: string,
  executionId: string,
): string {
  const row = database.prepare(`
    SELECT a.sandbox_root AS sandboxRoot
    FROM executions e
    JOIN execution_attempts a
      ON a.project_id=e.project_id AND a.execution_id=e.id
     AND a.attempt_no=e.current_attempt_no
    WHERE e.project_id=? AND e.id=?
  `).get(projectId, executionId) as { sandboxRoot: string } | undefined;
  if (!row) {
    throw new ExecutionError("EXECUTION_STATE_CONFLICT", 409, "Execution attempt is unavailable.");
  }
  return row.sandboxRoot;
}

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
  backupRef: VerifiedOwnedFileRef | null;
  durableNewRef: VerifiedOwnedFileRef;
  oldTarget: ExpectedCanonicalFile;
  postTarget: ExpectedCanonicalFile | null;
  tempLocator: {
    ownerId: string;
    relativePath: string[];
    rootKind: "canonical";
  };
  tempRef: VerifiedOwnedFileRef | null;
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
  backupRef: VerifiedOwnedFileRef | null;
  durableNewRef: VerifiedOwnedFileRef;
  oldTarget: ExpectedCanonicalFile;
  path: string;
  pathKey: string;
  position: number;
  postTarget: ExpectedCanonicalFile | null;
  status: RecoveryMergeFileStatus;
  tempLocator: {
    ownerId: string;
    relativePath: string[];
    rootKind: "canonical";
  };
  tempRef: VerifiedOwnedFileRef | null;
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

function pathSegments(path: string): string[] {
  return path.split("/").filter(Boolean);
}

function mutationValue<T>(
  result: NativeMutationResult<T>,
  message: string,
): T {
  if (result.kind === "succeeded") return result.value;
  throw new ExecutionError(
    "MERGE_RECOVERY_REQUIRED",
    409,
    result.kind === "mutation-uncertain"
      ? `${message} (${result.phase})`
      : `${message} (condition mismatch: ${JSON.stringify(result.observed)})`,
  );
}

function sameTarget(
  current: ExpectedCanonicalFile,
  expected: ExpectedCanonicalFile,
): boolean {
  return current.rootKind === expected.rootKind
    && current.relativePath.join("\0") === expected.relativePath.join("\0")
    && current.exists === expected.exists
    && current.parentIdentity === expected.parentIdentity
    && current.fileIdentity === expected.fileIdentity
    && current.sha256 === expected.sha256
    && current.size === expected.size;
}

async function readVerified(
  fs: MergeVerifiedAdapter,
  root: string,
  path: string,
  maximumBytes = MAX_FILE_BYTES,
): Promise<MergeVerifiedState> {
  return fs.readFile({
    maximumBytes,
    pathSegments: pathSegments(path),
    root,
  });
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
      const approval = consumeStagedMergeApproval(input.database, {
        attemptId: staged.attemptId,
        executionId: input.executionId,
        projectId: input.projectId,
        stagedHash: input.stagedHash,
      });
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
  fs: MergeVerifiedAdapter,
  actionId: string,
  journalRoot: string,
  sandboxRoot: string,
  rows: StagedFileRow[],
): Promise<PreparedFile[]> {
  await mkdir(join(journalRoot, "backups"), { recursive: true });
  await mkdir(join(journalRoot, "new"), { recursive: true });
  const prepared: PreparedFile[] = [];
  for (const row of rows) {
    const segments = pathSegments(row.path);
    const old = await readVerified(fs, input.workspaceRoot, row.path);
    await callHook(input, "after_old_read", row.path);
    if (
      row.kind === "modified"
        ? !old.target.exists || old.target.sha256 !== row.baselineHash
        : old.target.exists || row.baselineHash !== null
    ) {
      throw new ExecutionError("STALE_EXECUTION", 409, "Canonical baseline changed before merge.");
    }

    let backupRef: VerifiedOwnedFileRef | null = null;
    if (old.bytes) {
      backupRef = mutationValue(
        fs.prepareOwnedFile(
          "journal",
          journalRoot,
          ["backups"],
          `${actionId}-${row.position}.bin`,
          actionId,
          old.bytes,
        ),
        "The merge backup could not be prepared.",
      );
    }
    await callHook(input, "after_backup", row.path);

    const source = await readVerified(fs, sandboxRoot, row.path);
    if (
      !source.bytes
      || source.target.sha256 !== row.stagedHash
      || source.bytes.byteLength !== row.size
    ) {
      throw new ExecutionError("STALE_EXECUTION", 409, "Sandbox staged bytes changed before merge.");
    }
    const durableNewRef = mutationValue(
      fs.prepareOwnedFile(
        "journal",
        journalRoot,
        ["new"],
        `${actionId}-${row.position}.bin`,
        actionId,
        source.bytes,
      ),
      "The durable merge source could not be prepared.",
    );
    await callHook(input, "after_durable_new", row.path);

    const tempName = `.cool-ai-merge-${actionId}-${row.position}.tmp`;
    prepared.push({
      ...row,
      backupRef,
      durableNewRef,
      oldTarget: old.target,
      postTarget: null,
      tempLocator: {
        rootKind: "canonical",
        relativePath: [...segments.slice(0, -1), tempName],
        ownerId: actionId,
      },
      tempRef: null,
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
    exists: file.oldTarget.exists,
    hash: file.oldTarget.sha256,
    identity: file.oldTarget.fileIdentity,
    path: file.path,
    pathKey: file.pathKey,
  }));
  const postManifest = prepared.map((file) => ({
    exists: true,
    hash: file.stagedHash,
    identity: null,
    path: file.path,
    pathKey: file.pathKey,
  }));
  const oldManifestHash = manifestHash(oldManifest);
  const postManifestHash = manifestHash(postManifest);

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
        journal_id,position,path,path_key,old_target_ref_json,post_target_ref_json,
        backup_ref_json,durable_new_ref_json,canonical_temp_locator_json,
        canonical_temp_ref_json,status
      ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, 'pending')
    `);
    for (const file of prepared) {
      insert.run(
        ids.journalId,
        file.position,
        file.path,
        file.pathKey,
        JSON.stringify(file.oldTarget),
        file.backupRef ? JSON.stringify(file.backupRef) : null,
        JSON.stringify(file.durableNewRef),
        JSON.stringify(file.tempLocator),
      );
    }
  });
  return { oldManifestHash, postManifestHash };
}

async function rollbackApplied(
  input: MergeInput,
  fs: MergeVerifiedAdapter,
  journalRoot: string,
  journalId: string | null,
  files: PreparedFile[],
  applied: PreparedFile[],
): Promise<boolean> {
  const roots = { canonical: input.workspaceRoot, journal: journalRoot };
  let complete = true;
  for (const file of [...applied].reverse()) {
    try {
      if (!file.postTarget || !file.tempRef) {
        complete = false;
        continue;
      }
      if (!file.oldTarget.exists) {
        if (fs.conditionalDelete(roots, file.postTarget).kind !== "succeeded") {
          complete = false;
          continue;
        }
      } else {
        if (!file.backupRef) {
          complete = false;
          continue;
        }
        const rollbackTemp = fs.prepareCanonicalTempFromOwned(
          roots,
          file.backupRef,
          file.oldTarget.relativePath.slice(0, -1),
          `.cool-ai-rollback-${input.operationId}-${file.position}.tmp`,
          input.operationId,
        );
        if (rollbackTemp.kind !== "succeeded") {
          complete = false;
          continue;
        }
        const restored = fs.conditionalReplacePrepared(
          roots,
          file.postTarget,
          rollbackTemp.value,
        );
        if (
          restored.kind !== "succeeded"
          || restored.value.sha256 !== file.oldTarget.sha256
          || restored.value.size !== file.oldTarget.size
        ) complete = false;
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
    for (const ref of [
      ...(file.tempRef ? [file.tempRef] : []),
      ...(journalId ? [] : [
        file.durableNewRef,
        ...(file.backupRef ? [file.backupRef] : []),
      ]),
    ]) {
      try {
        const cleaned = fs.conditionalCleanupOwned(roots, ref);
        if (
          cleaned.kind === "mutation-uncertain"
          || (cleaned.kind === "condition-mismatch" && cleaned.observed.exists)
        ) complete = false;
      } catch {
        complete = false;
      }
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
  fs: MergeVerifiedAdapter,
  journalRoot: string,
  journalId: string,
  prepared: PreparedFile[],
  applied: PreparedFile[],
): Promise<void> {
  const roots = { canonical: input.workspaceRoot, journal: journalRoot };
  input.database.prepare(`
    UPDATE execution_merge_journals
    SET status='applying',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id=? AND status='prepared'
  `).run(journalId);
  for (const file of prepared) {
    const tempRef = mutationValue(
      fs.prepareCanonicalTempFromOwned(
        roots,
        file.durableNewRef,
        file.tempLocator.relativePath.slice(0, -1),
        file.tempLocator.relativePath.at(-1)!,
        file.tempLocator.ownerId,
      ),
      "The canonical merge temp could not be prepared.",
    );
    const postTarget: ExpectedCanonicalFile = {
      rootKind: "canonical",
      relativePath: file.oldTarget.relativePath,
      exists: true,
      parentIdentity: tempRef.parentIdentity,
      fileIdentity: tempRef.fileIdentity,
      sha256: tempRef.sha256,
      size: tempRef.size,
    };
    transaction(input.database, () => {
      const updated = input.database.prepare(`
        UPDATE execution_merge_files
        SET post_target_ref_json=?,canonical_temp_ref_json=?,status='temp_ready'
        WHERE journal_id=? AND position=? AND status='pending'
      `).run(
        JSON.stringify(postTarget),
        JSON.stringify(tempRef),
        journalId,
        file.position,
      );
      if (updated.changes !== 1) {
        throw new ExecutionError(
          "MERGE_RECOVERY_REQUIRED",
          409,
          "The canonical temp descriptor was not durably registered.",
        );
      }
    });
    file.postTarget = postTarget;
    file.tempRef = tempRef;
  }
  const postManifest = prepared.map((file) => ({
    exists: true,
    hash: file.postTarget!.sha256,
    identity: file.postTarget!.fileIdentity,
    path: file.path,
    pathKey: file.pathKey,
  }));
  input.database.prepare(`
    UPDATE execution_merge_journals
    SET post_manifest_hash=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id=? AND status='applying'
  `).run(manifestHash(postManifest), journalId);
  for (const file of prepared) {
    if (!file.postTarget || !file.tempRef) {
      throw new ExecutionError("MERGE_RECOVERY_REQUIRED", 409, "Merge temp is not registered.");
    }
    await callHook(input, "before_apply_file", file.path);
    mutationValue(
      fs.reopenOwnedFile(roots, file.durableNewRef),
      "The durable merge source changed before apply.",
    );
    mutationValue(
      fs.reopenOwnedFile(roots, file.tempRef),
      "The canonical merge temp changed before apply.",
    );
    await callHook(input, "after_temp_write", file.path);
    await callHook(input, "before_replace", file.path);
    const post = mutationValue(
      fs.conditionalReplacePrepared(roots, file.oldTarget, file.tempRef),
      `The conditional canonical replace did not complete for ${JSON.stringify(file.oldTarget)}.`,
    );
    if (!sameTarget(post, file.postTarget)) {
      throw new ExecutionError(
        "MERGE_RECOVERY_REQUIRED",
        409,
        "The conditional canonical replace produced an unexpected descriptor.",
      );
    }
    applied.push(file);
    await callHook(input, "after_replace", file.path);
    input.database.prepare(`
      UPDATE execution_merge_files SET status='applied'
      WHERE journal_id=? AND position=? AND status='temp_ready'
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

function parseJsonObject(value: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ExecutionError("SCHEMA_DATA_INVALID", 500, `${label} is not valid JSON.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ExecutionError("SCHEMA_DATA_INVALID", 500, `${label} is not a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function validRefSegments(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length > 0
    && value.every((segment) =>
      typeof segment === "string"
      && segment.length > 0
      && segment !== "."
      && segment !== ".."
      && !/[\\/\0]/u.test(segment));
}

function parseOwnedRef(value: string, label: string): VerifiedOwnedFileRef {
  const parsed = parseJsonObject(value, label);
  if (
    !["journal", "canonical"].includes(String(parsed.rootKind))
    || !validRefSegments(parsed.relativePath)
    || typeof parsed.ownerId !== "string"
    || !parsed.ownerId
    || typeof parsed.parentIdentity !== "string"
    || !parsed.parentIdentity
    || typeof parsed.fileIdentity !== "string"
    || !parsed.fileIdentity
    || typeof parsed.finalPath !== "string"
    || !parsed.finalPath
    || typeof parsed.sha256 !== "string"
    || !HASH_PATTERN.test(parsed.sha256)
    || !Number.isInteger(parsed.size)
    || Number(parsed.size) < 0
  ) {
    throw new ExecutionError("SCHEMA_DATA_INVALID", 500, `${label} is not a valid owned ref.`);
  }
  return parsed as VerifiedOwnedFileRef;
}

function parseExpectedTarget(value: string, label: string): ExpectedCanonicalFile {
  const parsed = parseJsonObject(value, label);
  const exists = parsed.exists === true;
  if (
    parsed.rootKind !== "canonical"
    || !validRefSegments(parsed.relativePath)
    || typeof parsed.exists !== "boolean"
    || typeof parsed.parentIdentity !== "string"
    || !parsed.parentIdentity
    || (exists
      ? typeof parsed.fileIdentity !== "string"
        || !parsed.fileIdentity
        || typeof parsed.sha256 !== "string"
        || !HASH_PATTERN.test(parsed.sha256)
        || !Number.isInteger(parsed.size)
        || Number(parsed.size) < 0
      : parsed.fileIdentity !== null || parsed.sha256 !== null || parsed.size !== null)
  ) {
    throw new ExecutionError("SCHEMA_DATA_INVALID", 500, `${label} is not a valid target ref.`);
  }
  return parsed as ExpectedCanonicalFile;
}

function parseTempLocator(value: string): JournalFileRow["tempLocator"] {
  const parsed = parseJsonObject(value, "merge canonical_temp_locator_json");
  if (
    parsed.rootKind !== "canonical"
    || !validRefSegments(parsed.relativePath)
    || typeof parsed.ownerId !== "string"
    || !parsed.ownerId
  ) {
    throw new ExecutionError(
      "SCHEMA_DATA_INVALID",
      500,
      "merge canonical_temp_locator_json is invalid.",
    );
  }
  return parsed as JournalFileRow["tempLocator"];
}

function journalFiles(database: DatabaseSync, journalId: string): JournalFileRow[] {
  const rows = database.prepare(`
    SELECT position,path,path_key AS pathKey,old_target_ref_json AS oldTargetJson,
           post_target_ref_json AS postTargetJson,backup_ref_json AS backupRefJson,
           durable_new_ref_json AS durableNewRefJson,
           canonical_temp_locator_json AS tempLocatorJson,
           canonical_temp_ref_json AS tempRefJson,status
    FROM execution_merge_files WHERE journal_id=? ORDER BY position
  `).all(journalId) as Array<{
    backupRefJson: string | null;
    durableNewRefJson: string;
    oldTargetJson: string;
    path: string;
    pathKey: string;
    position: number;
    postTargetJson: string | null;
    status: string;
    tempLocatorJson: string;
    tempRefJson: string | null;
  }>;
  return rows.map((row) => ({
    backupRef: row.backupRefJson
      ? parseOwnedRef(row.backupRefJson, "merge backup_ref_json")
      : null,
    durableNewRef: parseOwnedRef(row.durableNewRefJson, "merge durable_new_ref_json"),
    oldTarget: parseExpectedTarget(row.oldTargetJson, "merge old_target_json"),
    path: row.path,
    pathKey: row.pathKey,
    position: row.position,
    postTarget: row.postTargetJson
      ? parseExpectedTarget(row.postTargetJson, "merge post_target_ref_json")
      : null,
    status: recoveryMergeFileStatusSchema.parse(row.status),
    tempLocator: parseTempLocator(row.tempLocatorJson),
    tempRef: row.tempRefJson
      ? parseOwnedRef(row.tempRefJson, "merge canonical_temp_ref_json")
      : null,
  }));
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
  fs: MergeVerifiedAdapter,
): Promise<void> {
  const files = journalFiles(database, journal.id);
  if (files.some((file) => !file.postTarget)) {
    throw new ExecutionError("MERGE_RECOVERY_REQUIRED", 409, "Stored post refs are incomplete.");
  }
  const manifest = files.map((file) => ({
    exists: true,
    hash: file.postTarget!.sha256,
    identity: file.postTarget!.fileIdentity,
    path: file.path,
    pathKey: file.pathKey,
  }));
  if (manifestHash(manifest) !== journal.postManifestHash) {
    throw new ExecutionError("MERGE_INVARIANT_FAILED", 500, "Stored post manifest drifted.");
  }
  for (const file of files) {
    const current = await readVerified(fs, workspaceRoot, file.path);
    if (!sameTarget(current.target, file.postTarget!)) {
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
  fs?: MergeVerifiedAdapter,
): Promise<{ entries: ObservedManifestEntry[]; hash: string }> {
  const entries: ObservedManifestEntry[] = [];
  for (const file of journalFiles(database, journal.id)) {
    try {
      if (!fs) throw new Error("native merge adapter unavailable");
      const current = await readVerified(fs, workspaceRoot, file.path);
      entries.push(current.target.exists
        ? {
            exists: true,
            hash: current.target.sha256,
            identity: current.target.fileIdentity,
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
      entries.push({
        exists: true,
        hash: null,
        identity: null,
        path: file.path,
        pathKey: file.pathKey,
        type: "special",
      });
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
        exists: file.oldTarget.exists,
        hash: file.oldTarget.sha256,
        identity: file.oldTarget.fileIdentity,
        path: file.path,
        pathKey: file.pathKey,
      }
    : {
        exists: true,
        hash: file.postTarget?.sha256 ?? null,
        identity: file.postTarget?.fileIdentity ?? null,
        path: file.path,
        pathKey: file.pathKey,
      });
}

async function enterManualRecovery(
  database: DatabaseSync,
  journal: JournalRow,
  mismatchPhase: string,
  fs?: MergeVerifiedAdapter,
): Promise<{ entries: ObservedManifestEntry[]; hash: string }> {
  const workspaceRoot = workspaceFor(database, journal.projectId);
  const observed = await observeJournalManifest(database, journal, workspaceRoot, fs);
  const files = journalFiles(database, journal.id);
  const pathMismatches = observed.entries.filter((entry) => {
    if (entry.type === "special") return false;
    const file = files.find(({ pathKey }) => pathKey === entry.pathKey);
    if (!file) return false;
    const matches = (target: ExpectedCanonicalFile | null) => {
      if (!target) return false;
      if (entry.exists !== target.exists) return false;
      return !entry.exists || (
        entry.hash === target.sha256
        && entry.identity === target.fileIdentity
      );
    };
    return !matches(file.oldTarget) && !matches(file.postTarget);
  });
  const mismatchPathKey = pathMismatches.length === 1
    ? pathMismatches[0]!.pathKey
    : null;
  transaction(database, () => {
    database.prepare(
      "DELETE FROM work_item_review_heads WHERE current_result_id IN (SELECT id FROM work_item_result_versions WHERE merge_journal_id=?)",
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
          mismatch_path_key=?,error_code='MANUAL_RECOVERY_REQUIRED',
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id=?
    `).run(observed.hash, mismatchPhase, mismatchPathKey, journal.id);
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
  fs: MergeVerifiedAdapter,
): Promise<void> {
  const files = journalFiles(database, journal.id);
  if (files.length > 0 && files.every((file) => file.status === "verified")) return;
  const roots = {
    canonical: workspaceFor(database, journal.projectId),
    journal: journal.journalRoot,
  };
  for (const file of files) {
    for (const ref of [
      file.durableNewRef,
      ...(file.backupRef ? [file.backupRef] : []),
      ...(file.tempRef ? [file.tempRef] : []),
    ]) {
      const result = fs.conditionalCleanupOwned(roots, ref);
      if (
        result.kind === "mutation-uncertain"
        || (result.kind === "condition-mismatch" && result.observed.exists)
      ) {
        throw new ExecutionError(
          "MERGE_RECOVERY_REQUIRED",
          409,
          "Owned merge cleanup could not be proven.",
        );
      }
    }
  }
  for (const path of [
    join(journal.journalRoot, "backups"),
    join(journal.journalRoot, "new"),
    journal.journalRoot,
  ]) {
    try {
      await rmdir(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new ExecutionError(
          "MERGE_RECOVERY_REQUIRED",
          409,
          "Owned merge directory cleanup could not be proven.",
        );
      }
    }
  }
  database.prepare(
    "UPDATE execution_merge_files SET status='verified' WHERE journal_id=? AND status<>'pending'",
  ).run(journal.id);
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
      SELECT mission_id AS missionId,work_item_id AS workItemId,agent_id AS agentId,
             current_attempt_no AS attemptNo,next_event_sequence AS nextSequence,
             status,version
      FROM executions WHERE project_id=? AND id=?
    `).get(journal.projectId, journal.executionId) as {
      agentId: string;
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
    const resultInput = {
      executionId: journal.executionId,
      executorAgentId: execution.agentId,
      mergeJournalId: journal.id,
      missionId: execution.missionId,
      projectId: journal.projectId,
      resultId,
      stagedResultId: journal.stagedResultId,
      workItemId: execution.workItemId,
    };
    const currentHead = database.prepare(`
      SELECT current_result_id AS resultId,state,version
      FROM work_item_review_heads WHERE work_item_id=?
    `).get(execution.workItemId) as {
      resultId: string;
      state: string;
      version: number;
    } | undefined;
    if (!currentHead) {
      initializeFirstResultHeadTx(database, resultInput);
    } else {
      if (currentHead.state !== "rework") {
        throw new ExecutionError(
          "REVIEW_STATE_CONFLICT",
          409,
          "The review head is not ready for a replacement result.",
        );
      }
      advanceResultHeadTx(database, {
        ...resultInput,
        expectedHeadVersion: currentHead.version,
        expectedResultId: currentHead.resultId,
      });
    }
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
           r.merge_journal_id AS mergeJournalId,'awaiting_review' AS resultStatus,
           r.created_at AS resultCreatedAt
    FROM executions e
    JOIN work_item_result_versions r ON r.execution_id=e.id
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
  fs?: MergeVerifiedAdapter;
  hooks?: {
    point(input: { path: string | null; point: MergeFaultPoint }): void | Promise<void>;
  };
  journalId: string;
  recovery?: boolean;
}): Promise<MergeOperationResult> {
  let journal = journalRow(input.database, input.journalId);
  const replay = storedCommitResult(input.database, journal);
  if (replay) return replay;
  const workspaceRoot = workspaceFor(input.database, journal.projectId);
  let fs: MergeVerifiedAdapter | undefined;

  try {
    fs = mergeAdapter(input.fs);
    await fs.assertCapability({
      journalBaseRoot: dirname(journal.journalRoot),
      sandboxRoot: sandboxRootForExecution(
        input.database,
        journal.projectId,
        journal.executionId,
      ),
      workspaceRoot,
    });
    if (
      input.recovery
      && ["db_committed", "rolling_forward"].includes(journal.status)
    ) {
      input.database.prepare(
        "UPDATE execution_merge_journals SET status='rolling_forward' WHERE id=?",
      ).run(journal.id);
      await restoreAllPost(input.database, journal, fs);
      journal = journalRow(input.database, input.journalId);
    }
    if (journal.status === "applying") {
    await callCommitHook(input.hooks, "before_precommit_check");
    await assertPostManifest(input.database, journal, workspaceRoot, fs);
    await callCommitHook(input.hooks, "after_precommit_check");
    input.database.exec("BEGIN IMMEDIATE");
    try {
      await assertPostManifest(input.database, journal, workspaceRoot, fs);
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
    if (!["db_committed", "rolling_forward"].includes(journal.status)) {
      throw new ExecutionError("MERGE_INVARIANT_FAILED", 500, "Journal is not commit-ready.");
    }
    await assertPostManifest(input.database, journal, workspaceRoot, fs);
    await callCommitHook(input.hooks, "after_postcommit_check");
    await callCommitHook(input.hooks, "before_cleanup");
    await cleanupOwnedJournal(input.database, journal, fs);
    await callCommitHook(input.hooks, "after_cleanup");
    await callCommitHook(input.hooks, "before_finalize");
    await assertPostManifest(input.database, journal, workspaceRoot, fs);
    return finalizeCommittedMerge(input.database, journal);
  } catch (error) {
    if (
      !fs
      || (error instanceof ExecutionError
        && ["MERGE_RECOVERY_REQUIRED", "SANDBOX_UNVERIFIABLE"].includes(error.code))
    ) {
      await enterManualRecovery(input.database, journal, journal.status === "db_committed"
        ? "postcheck"
        : "precommit", fs);
      throw new ExecutionError(
        "MANUAL_RECOVERY_REQUIRED",
        409,
        "An external writer changed the canonical workspace.",
      );
    }
    throw error;
  }
}

async function restoreAllOld(
  database: DatabaseSync,
  journal: JournalRow,
  fs: MergeVerifiedAdapter,
): Promise<void> {
  const workspaceRoot = workspaceFor(database, journal.projectId);
  const roots = { canonical: workspaceRoot, journal: journal.journalRoot };
  const files = journalFiles(database, journal.id);
  for (const file of [...files].reverse()) {
    const current = await readVerified(fs, workspaceRoot, file.path);
    const isPost = file.postTarget !== null && sameTarget(current.target, file.postTarget);
    const isOld = sameTarget(current.target, file.oldTarget);
    if (isOld) continue;
    if (!isPost) {
      throw new ExecutionError("MERGE_RECOVERY_REQUIRED", 409, "Recovery found a path mismatch.");
    }
    if (!file.postTarget) {
      throw new ExecutionError("MERGE_RECOVERY_REQUIRED", 409, "Recovery post ref is missing.");
    }
    if (!file.oldTarget.exists) {
      mutationValue(
        fs.conditionalDelete(roots, file.postTarget),
        "Added-file rollback was uncertain.",
      );
    } else {
      if (!file.backupRef) {
        throw new ExecutionError("MERGE_RECOVERY_REQUIRED", 409, "Recovery backup changed.");
      }
      const rollbackTemp = mutationValue(
        fs.prepareCanonicalTempFromOwned(
          roots,
          file.backupRef,
          file.oldTarget.relativePath.slice(0, -1),
          `.cool-ai-rollback-${journal.actionId}-${file.position}.tmp`,
          journal.actionId,
        ),
        "Recovery rollback temp was uncertain.",
      );
      const restored = mutationValue(
        fs.conditionalReplacePrepared(roots, file.postTarget, rollbackTemp),
        "Recovery rollback replace was uncertain.",
      );
      if (
        restored.sha256 !== file.oldTarget.sha256
        || restored.size !== file.oldTarget.size
      ) {
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

async function restoreAllPost(
  database: DatabaseSync,
  journal: JournalRow,
  fs: MergeVerifiedAdapter,
): Promise<void> {
  const workspaceRoot = workspaceFor(database, journal.projectId);
  const roots = { canonical: workspaceRoot, journal: journal.journalRoot };
  for (const file of journalFiles(database, journal.id)) {
    if (!file.postTarget) {
      throw new ExecutionError("MERGE_RECOVERY_REQUIRED", 409, "Roll-forward post ref is missing.");
    }
    const current = await readVerified(fs, workspaceRoot, file.path);
    if (sameTarget(current.target, file.postTarget)) continue;
    if (!sameTarget(current.target, file.oldTarget)) {
      throw new ExecutionError("MERGE_RECOVERY_REQUIRED", 409, "Roll-forward found a path mismatch.");
    }
    let tempRef = file.tempRef;
    const reopened = tempRef ? fs.reopenOwnedFile(roots, tempRef) : null;
    if (!tempRef || reopened?.kind !== "succeeded") {
      tempRef = mutationValue(
        fs.prepareCanonicalTempFromOwned(
          roots,
          file.durableNewRef,
          file.oldTarget.relativePath.slice(0, -1),
          `.cool-ai-rollforward-${journal.actionId}-${file.position}.tmp`,
          journal.actionId,
        ),
        "Roll-forward temp preparation was uncertain.",
      );
    }
    const postTarget = mutationValue(
      fs.conditionalReplacePrepared(roots, file.oldTarget, tempRef),
      "Roll-forward replace was uncertain.",
    );
    database.prepare(`
      UPDATE execution_merge_files
      SET post_target_ref_json=?,canonical_temp_ref_json=?,status='rolled_forward'
      WHERE journal_id=? AND position=?
    `).run(
      JSON.stringify(postTarget),
      JSON.stringify(tempRef),
      journal.id,
      file.position,
    );
  }
  const postManifest = journalFiles(database, journal.id).map((file) => ({
    exists: true,
    hash: file.postTarget!.sha256,
    identity: file.postTarget!.fileIdentity,
    path: file.path,
    pathKey: file.pathKey,
  }));
  database.prepare(`
    UPDATE execution_merge_journals
    SET post_manifest_hash=?,status='db_committed',
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id=?
  `).run(manifestHash(postManifest), journal.id);
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
  fs?: MergeVerifiedAdapter;
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
    let fs: MergeVerifiedAdapter | undefined;
    try {
      fs = mergeAdapter(input.fs);
      await fs.assertCapability({
        journalBaseRoot: dirname(journal.journalRoot),
        sandboxRoot: sandboxRootForExecution(
          input.database,
          journal.projectId,
          journal.executionId,
        ),
        workspaceRoot: workspaceFor(input.database, journal.projectId),
      });
      if (["db_committed", "rolling_forward"].includes(journal.status)) {
        recovered.push(await executeMergeCommit({
          database: input.database,
          fs,
          journalId: id,
          recovery: true,
        }));
        continue;
      }
      input.database.prepare(`
        UPDATE execution_merge_journals SET status='rolling_back' WHERE id=?
      `).run(id);
      await restoreAllOld(input.database, journal, fs);
      await cleanupOwnedJournal(input.database, journal, fs);
      recovered.push(finalizeRolledBack(input.database, journal));
    } catch (error) {
      if (error instanceof ExecutionError && error.code === "MANUAL_RECOVERY_REQUIRED") {
        throw error;
      }
      if (
        !fs
        || (error instanceof ExecutionError
          && ["MERGE_RECOVERY_REQUIRED", "SANDBOX_UNVERIFIABLE"].includes(error.code))
      ) {
        await enterManualRecovery(input.database, journal, journal.status === "db_committed"
          ? "restart_rollforward"
          : "restart_rollback", fs);
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
  const fs = mergeAdapter(input.fs);
  await fs.assertCapability({
    journalBaseRoot: input.journalBaseRoot,
    sandboxRoot: sandboxRootForExecution(
      input.database,
      input.projectId,
      input.executionId,
    ),
    workspaceRoot: input.workspaceRoot,
  });
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
      fs,
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
      await applyPrepared(input, fs, journalRoot, ids.journalId, prepared, applied);
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
        const current = await readVerified(fs, input.workspaceRoot, file.path).catch(() => null);
        if (current && file.postTarget && sameTarget(current.target, file.postTarget)) {
          applied.push(file);
        }
      }
      throw error;
    }
    return {
      actionId: ids.actionId,
      journalId: ids.journalId,
      oldManifestHash: manifests.oldManifestHash,
      postManifestHash: journalRow(input.database, ids.journalId).postManifestHash,
    };
  } catch (error) {
    const rolledBack = await rollbackApplied(
      input,
      fs,
      journalRoot,
      journalPersisted ? ids.journalId : null,
      prepared,
      applied,
    );
    const externalMismatch = !rolledBack || (
      error instanceof ExecutionError
      && ["STALE_EXECUTION", "MERGE_RECOVERY_REQUIRED", "SANDBOX_UNVERIFIABLE"]
        .includes(error.code)
    );
    if (journalPersisted && externalMismatch) {
      await enterManualRecovery(
        input.database,
        journalRow(input.database, ids.journalId),
        "apply_or_rollback",
        fs,
      );
      const recovery = new ExecutionError(
        "MANUAL_RECOVERY_REQUIRED",
        409,
        `Conditional merge rollback found an external writer mismatch: ${
          error instanceof Error ? error.message : "unknown native failure"
        }`,
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
    throw error;
  }
}

async function cleanupOwnedForAbandon(
  database: DatabaseSync,
  journal: JournalRow,
  fs: MergeVerifiedAdapter,
): Promise<string[]> {
  const uncleaned: string[] = [];
  const workspaceRoot = workspaceFor(database, journal.projectId);
  const roots = { canonical: workspaceRoot, journal: journal.journalRoot };
  for (const file of journalFiles(database, journal.id)) {
    const candidates = [
      file.durableNewRef,
      ...(file.backupRef ? [file.backupRef] : []),
      ...(file.tempRef ? [file.tempRef] : []),
    ];
    if (!file.tempRef) {
      uncleaned.push(
        `${file.tempLocator.rootKind}:${file.tempLocator.relativePath.join("/")}`,
      );
    }
    for (const ref of candidates) {
      const label = `${ref.rootKind}:${ref.relativePath.join("/")}`;
      try {
        const result = fs.conditionalCleanupOwned(roots, ref);
        if (
          result.kind === "mutation-uncertain"
          || (result.kind === "condition-mismatch" && result.observed.exists)
        ) uncleaned.push(label);
      } catch {
        uncleaned.push(label);
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
  fs?: MergeVerifiedAdapter;
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
  const fs = mergeAdapter(input.fs);
  await fs.assertCapability({
    journalBaseRoot: dirname(journal.journalRoot),
    sandboxRoot: sandboxRootForExecution(
      input.database,
      journal.projectId,
      journal.executionId,
    ),
    workspaceRoot: workspaceFor(input.database, input.projectId),
  });
  const observed = await observeJournalManifest(
    input.database,
    journal,
    workspaceFor(input.database, input.projectId),
    fs,
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
    ? await cleanupOwnedForAbandon(input.database, journal, fs)
    : [];
  let result!: MergeOperationResult;
  transaction(input.database, () => {
    const current = input.database.prepare(`
      SELECT j.id
      FROM execution_merge_journals j
      JOIN executions e ON e.project_id=j.project_id AND e.id=j.execution_id
      WHERE j.project_id=? AND j.execution_id=? AND j.id=?
        AND j.status='manual_recovery'
        AND e.status='conflicted' AND e.manual_recovery_required=1 AND e.version=?
    `).get(
      input.projectId,
      input.executionId,
      journal.id,
      input.expectedVersion,
    ) as { id: string } | undefined;
    if (!current) {
      throw new ExecutionError(
        "MANUAL_RECOVERY_REQUIRED",
        409,
        "Manual recovery state changed before resolution commit.",
      );
    }
    const execution = input.database.prepare(`
      SELECT mission_id AS missionId,work_item_id AS workItemId,agent_id AS agentId
      FROM executions WHERE project_id=? AND id=?
    `).get(input.projectId, input.executionId) as {
      agentId: string;
      missionId: string;
      workItemId: string;
    };
    if (input.action === "recovered_new") {
      const existingResult = input.database.prepare(`
        SELECT id FROM work_item_result_versions
        WHERE project_id=? AND execution_id=? AND merge_journal_id=?
      `).get(input.projectId, input.executionId, journal.id) as { id: string } | undefined;
      if (!existingResult) {
        const resultInput = {
          executionId: input.executionId,
          executorAgentId: execution.agentId,
          mergeJournalId: journal.id,
          missionId: execution.missionId,
          projectId: input.projectId,
          resultId: randomUUID(),
          stagedResultId: journal.stagedResultId,
          workItemId: execution.workItemId,
        };
        const currentHead = input.database.prepare(`
          SELECT current_result_id AS resultId,state,version
          FROM work_item_review_heads WHERE work_item_id=?
        `).get(execution.workItemId) as {
          resultId: string;
          state: string;
          version: number;
        } | undefined;
        if (!currentHead) {
          initializeFirstResultHeadTx(input.database, resultInput);
        } else {
          if (currentHead.state !== "rework") {
            throw new ExecutionError(
              "REVIEW_STATE_CONFLICT",
              409,
              "The review head is not ready for recovered result.",
            );
          }
          advanceResultHeadTx(input.database, {
            ...resultInput,
            expectedHeadVersion: currentHead.version,
            expectedResultId: currentHead.resultId,
          });
        }
      }
    }
    const executionStatus = input.action === "recovered_new"
      ? "merged"
      : input.action === "abandon"
        ? "stopped"
        : "conflicted";
    const executionUpdate = input.database.prepare(`
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
    if (executionUpdate.changes !== 1) {
      throw new ExecutionError(
        "MANUAL_RECOVERY_REQUIRED",
        409,
        "Manual recovery execution changed before resolution commit.",
      );
    }
    const journalStatus = input.action === "recovered_old"
      ? "resolved_old"
      : input.action === "recovered_new"
        ? "resolved_new"
        : "abandoned";
    const journalUpdate = input.database.prepare(`
      UPDATE execution_merge_journals
      SET status=?,error_code=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id=? AND status='manual_recovery'
    `).run(journalStatus, journal.id);
    if (journalUpdate.changes !== 1) {
      throw new ExecutionError(
        "MANUAL_RECOVERY_REQUIRED",
        409,
        "Manual recovery journal changed before resolution commit.",
      );
    }
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
