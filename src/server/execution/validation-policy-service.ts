import { createHash, randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

import { canonicalRequestHash } from "@/src/server/collaboration/operation-receipts";
import { openDatabase } from "@/src/server/db";
import {
  CLASSIFIER_VERSION,
  classifyPolicyEntry,
  commandTupleHash,
  normalizeRelativeWorkdir,
  type CommandPolicyContext,
} from "@/src/server/execution/command-policy";

const EMPTY_POLICY_HASH = "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945";
const MAX_POLICY_BYTES = 65_536;
const MAX_POLICY_ENTRIES = 50;

export type ValidationPolicyEntryInput = {
  args: string[];
  executable: string;
  required: boolean;
  workdir: string;
};

export type ValidationPolicyEntry = ValidationPolicyEntryInput & {
  executableIdentity: string;
  id: string;
  position: number;
  tupleHash: string;
};

export type ValidationPolicy = {
  classifierVersion: number;
  entries: ValidationPolicyEntry[];
  policyHash: string;
  projectId: string;
  revisionId: string;
  revisionNo: number;
  version: number;
  warningAccepted: boolean;
};

export class ValidationPolicyError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly currentVersion?: number,
  ) {
    super(message);
    this.name = "ValidationPolicyError";
  }
}

type ResolvedExecutable = {
  executable: string;
  executableIdentity: string;
};

type SaveInput = {
  entries: ValidationPolicyEntryInput[];
  expectedVersion: number;
  operationId: string;
  warningAccepted: boolean;
};

type SaveResult = {
  outcome: "rejected" | "saved";
  policy: ValidationPolicy;
  reasonCode: string | null;
};

type RevisionRow = {
  classifierVersion: number;
  id: string;
  policyHash: string;
  projectId: string;
  revisionNo: number;
  version: number;
  warningAccepted: number;
};

function transaction<T>(database: DatabaseSync, operation: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the stable policy error.
    }
    throw error;
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function defaultResolveExecutable(executable: string): ResolvedExecutable {
  const resolved = realpathSync(executable).replaceAll("\\", "/");
  const stat = statSync(resolved);
  if (!stat.isFile()) {
    throw new ValidationPolicyError("EXECUTABLE_INVALID", "Executable must resolve to a file.");
  }
  return {
    executable: resolved,
    executableIdentity: sha256(JSON.stringify({
      dev: stat.dev.toString(),
      ino: stat.ino.toString(),
      path: resolved,
      size: stat.size,
    })),
  };
}

function policyContext(executable: string): CommandPolicyContext {
  const windows = /^[a-zA-Z]:[/\\]/.test(executable);
  return windows
    ? {
        canonicalRoot: "C:/__cool_ai_canonical__",
        executionRoot: "C:/__cool_ai_executions__",
        platform: "win32",
        sandboxRoot: "C:/__cool_ai_executions__/project/execution/attempt/sandbox",
      }
    : {
        canonicalRoot: "/__cool_ai_canonical__",
        executionRoot: "/__cool_ai_executions__",
        platform: "posix",
        sandboxRoot: "/__cool_ai_executions__/project/execution/attempt/sandbox",
      };
}

function validateEntry(input: ValidationPolicyEntryInput): void {
  if (
    !input
    || typeof input.executable !== "string"
    || Buffer.byteLength(input.executable, "utf8") < 1
    || Buffer.byteLength(input.executable, "utf8") > 4096
    || !Array.isArray(input.args)
    || input.args.length > 64
    || typeof input.workdir !== "string"
    || typeof input.required !== "boolean"
  ) {
    throw new ValidationPolicyError("INVALID_INPUT", "Validation policy entry is invalid.");
  }
  let argumentBytes = 0;
  for (const argument of input.args) {
    if (typeof argument !== "string" || Buffer.byteLength(argument, "utf8") > 4096) {
      throw new ValidationPolicyError("INVALID_INPUT", "Validation policy argument is invalid.");
    }
    argumentBytes += Buffer.byteLength(argument, "utf8");
  }
  if (argumentBytes > 32_768) {
    throw new ValidationPolicyError("INVALID_INPUT", "Validation policy arguments are too large.");
  }
}

function entryRows(
  database: DatabaseSync,
  projectId: string,
  revisionId: string,
): ValidationPolicyEntry[] {
  return database.prepare(
    `SELECT id,position,executable,executable_identity AS executableIdentity,
            args_json AS argsJson,workdir,required,tuple_hash AS tupleHash
     FROM project_validation_policy_entries
     WHERE project_id=? AND revision_id=? ORDER BY position`,
  ).all(projectId, revisionId).map((row) => {
    const value = row as {
      argsJson: string;
      executable: string;
      executableIdentity: string;
      id: string;
      position: number;
      required: number;
      tupleHash: string;
      workdir: string;
    };
    return {
      args: JSON.parse(value.argsJson) as string[],
      executable: value.executable,
      executableIdentity: value.executableIdentity,
      id: value.id,
      position: value.position,
      required: value.required === 1,
      tupleHash: value.tupleHash,
      workdir: value.workdir,
    };
  });
}

function toPolicy(database: DatabaseSync, row: RevisionRow): ValidationPolicy {
  return {
    classifierVersion: row.classifierVersion,
    entries: entryRows(database, row.projectId, row.id),
    policyHash: row.policyHash,
    projectId: row.projectId,
    revisionId: row.id,
    revisionNo: row.revisionNo,
    version: row.version,
    warningAccepted: row.warningAccepted === 1,
  };
}

function activeRow(database: DatabaseSync, projectId: string): RevisionRow {
  const row = database.prepare(
    `SELECT r.id,r.project_id AS projectId,r.revision_no AS revisionNo,
            r.policy_hash AS policyHash,r.classifier_version AS classifierVersion,
            r.warning_accepted AS warningAccepted,p.version
     FROM project_validation_policies p
     JOIN project_validation_policy_revisions r
       ON r.project_id=p.project_id AND r.id=p.active_revision_id
     WHERE p.project_id=?`,
  ).get(projectId) as RevisionRow | undefined;
  if (!row) {
    throw new ValidationPolicyError("POLICY_NOT_FOUND", "Validation policy was not found.");
  }
  return row;
}

export function initializeValidationPolicy(
  database: DatabaseSync,
  projectId: string,
  timestamp: string,
): void {
  const revisionId = `system-empty-policy:${projectId}`;
  database.prepare(
    `INSERT INTO project_validation_policy_revisions (
       id,project_id,created_operation_id,created_actor_type,revision_no,policy_hash,
       classifier_version,warning_accepted,canonical_bytes,entry_count,created_at
     ) VALUES (?, ?, NULL, 'system', 1, ?, ?, 0, 2, 0, ?)`,
  ).run(revisionId, projectId, EMPTY_POLICY_HASH, CLASSIFIER_VERSION, timestamp);
  database.prepare(
    `INSERT INTO project_validation_policies(project_id,active_revision_id,version,updated_at)
     VALUES (?, ?, 1, ?)`,
  ).run(projectId, revisionId, timestamp);
}

export function getValidationPolicy(databasePath: string, projectId: string): ValidationPolicy {
  const database = openDatabase(databasePath);
  try {
    return toPolicy(database, activeRow(database, projectId));
  } finally {
    database.close();
  }
}

export function listValidationPolicyRevisions(
  databasePath: string,
  projectId: string,
): ValidationPolicy[] {
  const database = openDatabase(databasePath);
  try {
    const active = activeRow(database, projectId);
    const rows = database.prepare(
      `SELECT id,project_id AS projectId,revision_no AS revisionNo,
              policy_hash AS policyHash,classifier_version AS classifierVersion,
              warning_accepted AS warningAccepted,? AS version
       FROM project_validation_policy_revisions
       WHERE project_id=? ORDER BY revision_no,id`,
    ).all(active.version, projectId) as RevisionRow[];
    return rows.map((row) => toPolicy(database, row));
  } finally {
    database.close();
  }
}

export function listValidationPolicyAudits(databasePath: string, projectId: string) {
  const database = openDatabase(databasePath);
  try {
    return database.prepare(
      `SELECT sequence,outcome,before_policy_hash AS beforePolicyHash,
              after_policy_hash AS afterPolicyHash,warning_accepted AS warningAccepted
       FROM project_validation_policy_audits
       WHERE project_id=? ORDER BY sequence,id`,
    ).all(projectId).map((row) => {
      const value = row as {
        afterPolicyHash: string | null;
        beforePolicyHash: string;
        outcome: "rejected" | "saved";
        sequence: number;
        warningAccepted: number;
      };
      return { ...value, warningAccepted: value.warningAccepted === 1 };
    });
  } finally {
    database.close();
  }
}

function normalizeEntries(
  inputs: ValidationPolicyEntryInput[],
  resolveExecutable: (executable: string) => ResolvedExecutable,
): {
  canonical: string;
  denialCode: string | null;
  entries: Array<Omit<ValidationPolicyEntry, "id" | "position">>;
} {
  const entries = inputs.map((input) => {
    validateEntry(input);
    const resolved = resolveExecutable(input.executable);
    if (!/^[0-9a-f]{64}$/.test(resolved.executableIdentity)) {
      throw new ValidationPolicyError("EXECUTABLE_INVALID", "Executable identity is invalid.");
    }
    const normalized = {
      args: [...input.args],
      executable: resolved.executable.replaceAll("\\", "/"),
      executableIdentity: resolved.executableIdentity,
      required: input.required,
      workdir: normalizeRelativeWorkdir(input.workdir),
    };
    const classification = classifyPolicyEntry(normalized, policyContext(normalized.executable));
    return {
      classification,
      value: {
        ...normalized,
        tupleHash: commandTupleHash(normalized),
      },
    };
  });
  const canonical = JSON.stringify(entries.map(({ value }) => ({
    args: value.args,
    classifierVersion: CLASSIFIER_VERSION,
    executable: value.executable,
    executableIdentity: value.executableIdentity,
    required: value.required,
    workdir: value.workdir,
  })));
  return {
    canonical,
    denialCode: entries.find(({ classification }) => classification.decision === "deny")
      ?.classification.code ?? null,
    entries: entries.map(({ value }) => value),
  };
}

function operationRow(database: DatabaseSync, projectId: string, operationId: string) {
  return database.prepare(
    `SELECT kind,request_hash AS requestHash,status,http_status AS httpStatus,
            response_json AS responseJson
     FROM execution_operations WHERE project_id=? AND id=?`,
  ).get(projectId, operationId) as {
    httpStatus: number;
    kind: string;
    requestHash: string;
    responseJson: string;
    status: string;
  } | undefined;
}

function persistCompletedOperation(
  database: DatabaseSync,
  projectId: string,
  operationId: string,
  requestHash: string,
  response: SaveResult,
  timestamp: string,
): void {
  database.prepare(
    `INSERT INTO execution_operations (
       id,project_id,execution_id,kind,request_hash,has_external_actions,action_count,
       final_action_index,status,http_status,response_json,created_at,updated_at
     ) VALUES (?, ?, NULL, 'policy_update', ?, 0, 0, NULL, 'completed', 200, ?, ?, ?)`,
  ).run(operationId, projectId, requestHash, JSON.stringify(response), timestamp, timestamp);
}

function appendAudit(
  database: DatabaseSync,
  input: {
    afterPolicyHash: string | null;
    afterRevisionId: string | null;
    before: ValidationPolicy;
    operationId: string;
    outcome: "rejected" | "saved";
    projectId: string;
    timestamp: string;
    warningAccepted: boolean;
  },
): void {
  const sequence = Number((database.prepare(
    `SELECT COALESCE(MAX(sequence),0)+1 AS sequence
     FROM project_validation_policy_audits WHERE project_id=?`,
  ).get(input.projectId) as { sequence: number }).sequence);
  const publicChange = JSON.stringify({
    afterPolicyHash: input.afterPolicyHash,
    beforePolicyHash: input.before.policyHash,
    classifierVersion: CLASSIFIER_VERSION,
    outcome: input.outcome,
  });
  database.prepare(
    `INSERT INTO project_validation_policy_audits (
       id,project_id,operation_id,sequence,actor_type,outcome,before_revision_id,
       after_revision_id,before_policy_hash,after_policy_hash,public_change_json,
       warning_accepted,created_at
     ) VALUES (?, ?, ?, ?, 'owner', ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    input.projectId,
    input.operationId,
    sequence,
    input.outcome,
    input.before.revisionId,
    input.afterRevisionId,
    input.before.policyHash,
    input.afterPolicyHash,
    publicChange,
    input.warningAccepted ? 1 : 0,
    input.timestamp,
  );
}

export function saveValidationPolicy(
  databasePath: string,
  projectId: string,
  input: SaveInput,
  options: {
    resolveExecutable?: (executable: string) => ResolvedExecutable;
  } = {},
): SaveResult {
  if (
    !input
    || !Array.isArray(input.entries)
    || !Number.isInteger(input.expectedVersion)
    || input.expectedVersion < 1
    || typeof input.operationId !== "string"
    || typeof input.warningAccepted !== "boolean"
  ) {
    throw new ValidationPolicyError("INVALID_INPUT", "Validation policy input is invalid.");
  }
  if (input.entries.length > MAX_POLICY_ENTRIES) {
    throw new ValidationPolicyError(
      "POLICY_ENTRY_LIMIT_EXCEEDED",
      `Validation policy accepts at most ${MAX_POLICY_ENTRIES} entries.`,
    );
  }
  input.entries.forEach(validateEntry);
  const normalized = input.warningAccepted
    ? normalizeEntries(input.entries, options.resolveExecutable ?? defaultResolveExecutable)
    : null;
  const canonicalBytes = normalized ? Buffer.byteLength(normalized.canonical, "utf8") : 0;
  if (normalized && canonicalBytes > MAX_POLICY_BYTES) {
    throw new ValidationPolicyError(
      "POLICY_SIZE_LIMIT_EXCEEDED",
      `Validation policy accepts at most ${MAX_POLICY_BYTES} canonical bytes.`,
    );
  }
  const requestHash = canonicalRequestHash({
    entries: input.entries,
    expectedVersion: input.expectedVersion,
    kind: "policy_update",
    projectId,
    warningAccepted: input.warningAccepted,
  });
  const database = openDatabase(databasePath);
  try {
    return transaction(database, () => {
      const replay = operationRow(database, projectId, input.operationId);
      if (replay) {
        if (replay.kind !== "policy_update" || replay.requestHash !== requestHash) {
          throw new ValidationPolicyError(
            "OPERATION_CONFLICT",
            "Operation id was already used for different policy input.",
          );
        }
        return JSON.parse(replay.responseJson) as SaveResult;
      }
      const before = toPolicy(database, activeRow(database, projectId));
      if (before.version !== input.expectedVersion) {
        throw new ValidationPolicyError(
          "POLICY_VERSION_CONFLICT",
          "Validation policy changed concurrently.",
          before.version,
        );
      }
      const rejectionCode = !input.warningAccepted
        ? "WARNING_REQUIRED"
        : normalized!.denialCode;
      const timestamp = new Date().toISOString();
      if (rejectionCode) {
        const result: SaveResult = {
          outcome: "rejected",
          policy: before,
          reasonCode: rejectionCode,
        };
        persistCompletedOperation(
          database,
          projectId,
          input.operationId,
          requestHash,
          result,
          timestamp,
        );
        appendAudit(database, {
          afterPolicyHash: null,
          afterRevisionId: null,
          before,
          operationId: input.operationId,
          outcome: "rejected",
          projectId,
          timestamp,
          warningAccepted: input.warningAccepted,
        });
        return result;
      }

      const revisionId = randomUUID();
      const revisionNo = before.version + 1;
      const policyHash = sha256(normalized!.canonical);
      database.prepare(
        `INSERT INTO execution_operations (
           id,project_id,execution_id,kind,request_hash,has_external_actions,action_count,
           final_action_index,status,http_status,response_json,created_at,updated_at
         ) VALUES (?, ?, NULL, 'policy_update', ?, 0, 0, NULL, 'completed', 200, '{}', ?, ?)`,
      ).run(input.operationId, projectId, requestHash, timestamp, timestamp);
      database.prepare(
        `INSERT INTO project_validation_policy_revisions (
           id,project_id,created_operation_id,created_actor_type,revision_no,policy_hash,
           classifier_version,warning_accepted,canonical_bytes,entry_count,created_at
         ) VALUES (?, ?, ?, 'owner', ?, ?, ?, 1, ?, ?, ?)`,
      ).run(
        revisionId,
        projectId,
        input.operationId,
        revisionNo,
        policyHash,
        CLASSIFIER_VERSION,
        canonicalBytes,
        normalized!.entries.length,
        timestamp,
      );
      const insertEntry = database.prepare(
        `INSERT INTO project_validation_policy_entries (
           id,project_id,revision_id,position,executable,executable_identity,args_json,
           workdir,required,tuple_hash
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      normalized!.entries.forEach((entry, position) => {
        insertEntry.run(
          randomUUID(),
          projectId,
          revisionId,
          position,
          entry.executable,
          entry.executableIdentity,
          JSON.stringify(entry.args),
          entry.workdir,
          entry.required ? 1 : 0,
          entry.tupleHash,
        );
      });
      const moved = database.prepare(
        `UPDATE project_validation_policies
         SET active_revision_id=?,version=version+1,updated_at=?
         WHERE project_id=? AND version=?`,
      ).run(revisionId, timestamp, projectId, input.expectedVersion);
      if (moved.changes !== 1) {
        throw new ValidationPolicyError(
          "POLICY_VERSION_CONFLICT",
          "Validation policy changed concurrently.",
          before.version,
        );
      }
      const saved = toPolicy(database, activeRow(database, projectId));
      const result: SaveResult = { outcome: "saved", policy: saved, reasonCode: null };
      database.prepare(
        `UPDATE execution_operations SET response_json=?,updated_at=?
         WHERE project_id=? AND id=?`,
      ).run(JSON.stringify(result), timestamp, projectId, input.operationId);
      appendAudit(database, {
        afterPolicyHash: saved.policyHash,
        afterRevisionId: saved.revisionId,
        before,
        operationId: input.operationId,
        outcome: "saved",
        projectId,
        timestamp,
        warningAccepted: true,
      });
      return result;
    });
  } finally {
    database.close();
  }
}
