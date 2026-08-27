import { createHash, randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { connect, createServer } from "node:net";
import { basename } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { consumeApprovedApprovalById } from "@/src/adapters/outbound/sqlite/governance/approval-store";
import { canonicalRequestHash } from "@/src/adapters/outbound/sqlite/public-collaboration/operation-receipts";
import { requestExecutionCommand } from "@/src/adapters/outbound/sqlite/safe-execution/command-request";
import { appendExecutionAuditOutboxRow } from "@/src/adapters/outbound/sqlite/safe-execution/audit-event-outbox";
import {
  runDirectProcess,
  type DirectProcessResult,
  type ProcessOutput,
} from "@/src/adapters/outbound/workspace/process-runner";
import { ExecutionError } from "@/src/modules/safe-execution";
import {
  CLASSIFIER_VERSION,
  classifyExecutionCommand,
  commandTupleHash,
  type CommandInput,
  type CommandPolicyContext,
  type StandingPolicyEntry,
} from "@/src/modules/safe-execution/internal/command-policy";

export { reconcilePolicyProcesses } from "@/src/adapters/outbound/sqlite/safe-execution/policy-process-reconciliation";

type ExecutionPolicyRow = {
  attemptNo: number;
  classifierVersion: number;
  executionId: string;
  executionVersion: number;
  policyRevisionId: string;
  projectId: string;
  sandboxRoot: string;
  workspacePath: string;
};

type PolicyEntryRow = {
  argsJson: string;
  executable: string;
  executableIdentity: string;
  id: string;
  network: "loopback_only" | null;
  openPath: string | null;
  port: number | null;
  position: number;
  purpose: "preview" | "validation";
  required: number;
  timeoutSeconds: number;
  tupleHash: string;
  workdir: string;
};

type RunProcess = (input: {
  args: string[];
  authorizationSource: "one_shot" | "standing_policy";
  executable: string;
  heartbeat: () => boolean | Promise<boolean>;
  onOutputSnapshot?: (
    stream: "stderr" | "stdout",
    output: ProcessOutput,
  ) => void;
  registerTerminationRequest: (request: (() => void) | null) => void;
  sandboxRoot: string;
  timeoutMs: number;
  workdir: string;
}) => Promise<DirectProcessResult>;

const activeTerminationRequests = new Map<string, () => void>();
const stopRequested = new Set<string>();

function transaction<T>(
  database: ReturnType<typeof openDatabase>,
  operation: () => T,
): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the stable execution error.
    }
    throw error;
  }
}

function executionPolicyRow(
  database: ReturnType<typeof openDatabase>,
  executionId: string,
): ExecutionPolicyRow {
  const row = database.prepare(`
    SELECT e.id AS executionId,e.project_id AS projectId,e.version AS executionVersion,
           e.current_attempt_no AS attemptNo,
           attempt.frozen_policy_revision_id AS policyRevisionId,
           attempt.sandbox_root AS sandboxRoot,project.workspace_path AS workspacePath,
           revision.classifier_version AS classifierVersion
    FROM executions e
    JOIN projects project ON project.id=e.project_id
    JOIN execution_attempts attempt
      ON attempt.project_id=e.project_id AND attempt.execution_id=e.id
     AND attempt.attempt_no=e.current_attempt_no
    JOIN project_validation_policy_revisions revision
      ON revision.project_id=attempt.project_id
     AND revision.id=attempt.frozen_policy_revision_id
    WHERE e.id=? AND project.workspace_path IS NOT NULL
  `).get(executionId) as ExecutionPolicyRow | undefined;
  if (!row) {
    throw new ExecutionError("EXECUTION_NOT_FOUND", 404, "Execution policy context was not found.");
  }
  return row;
}

function appendPolicyProcessEvent(
  database: DatabaseSync,
  input: {
    actorType: "owner" | "system";
    executionId: string;
    payload: Record<string, unknown>;
    type: string;
  },
): void {
  const execution = database.prepare(`
    SELECT project_id AS projectId,current_attempt_no AS attemptNo,
           next_event_sequence AS sequence
    FROM executions WHERE id=?
  `).get(input.executionId) as {
    attemptNo: number;
    projectId: string;
    sequence: number;
  } | undefined;
  if (!execution) throw new ExecutionError("EXECUTION_NOT_FOUND", 404, "Execution was not found.");
  const eventId = randomUUID();
  database.prepare(`
    INSERT INTO execution_events (
      id,project_id,execution_id,sequence,attempt_no,type,actor_type,actor_id,
      payload_json,created_at
    ) VALUES (?,?,?,?,?,?,?,NULL,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  `).run(
    eventId,
    execution.projectId,
    input.executionId,
    execution.sequence,
    execution.attemptNo,
    input.type,
    input.actorType,
    JSON.stringify(input.payload),
  );
  appendExecutionAuditOutboxRow(database, {
    actorId: null,
    actorType: input.actorType,
    attemptNo: execution.attemptNo,
    eventId,
    eventType: input.type,
    executionId: input.executionId,
    projectId: execution.projectId,
    sourcePayload: input.payload,
  });
  const updated = database.prepare(`
    UPDATE executions SET next_event_sequence=next_event_sequence+1
    WHERE project_id=? AND id=? AND next_event_sequence=?
  `).run(execution.projectId, input.executionId, execution.sequence);
  if (updated.changes !== 1) {
    throw new ExecutionError("EXECUTION_STATE_CONFLICT", 409, "Execution event sequence changed.");
  }
}

function policyEntryRows(
  database: ReturnType<typeof openDatabase>,
  row: ExecutionPolicyRow,
): PolicyEntryRow[] {
  return database.prepare(`
    SELECT id,position,executable,executable_identity AS executableIdentity,
           args_json AS argsJson,workdir,required,purpose,
           timeout_seconds AS timeoutSeconds,network,preview_port AS port,
           preview_open_path AS openPath,tuple_hash AS tupleHash
    FROM project_validation_policy_entries
    WHERE project_id=? AND revision_id=?
    ORDER BY position,id
  `).all(row.projectId, row.policyRevisionId) as PolicyEntryRow[];
}

function parseArgs(value: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || !parsed.every((argument) => typeof argument === "string")) {
    throw new ExecutionError("POLICY_INVALID", 409, "Frozen policy arguments are invalid.");
  }
  return parsed;
}

function standingEntries(
  rows: PolicyEntryRow[],
  classifierVersion: number,
): StandingPolicyEntry[] {
  if (classifierVersion !== CLASSIFIER_VERSION) return [];
  return rows.flatMap((row) => {
    const entry: StandingPolicyEntry = {
      args: parseArgs(row.argsJson),
      executable: row.executable,
      executableIdentity: row.executableIdentity,
      required: row.required === 1,
      tupleHash: row.tupleHash,
      workdir: row.workdir,
    };
    return commandTupleHash(entry) === entry.tupleHash ? [entry] : [];
  });
}

function executableLabel(value: string): string {
  return basename(value.replaceAll("\\", "/"));
}

function hasExecutableIdentity(executable: string, expectedIdentity: string): boolean {
  try {
    const resolved = realpathSync(executable).replaceAll("\\", "/");
    const stat = statSync(resolved);
    if (!stat.isFile()) return false;
    const identity = createHash("sha256").update(JSON.stringify({
      dev: stat.dev.toString(),
      ino: stat.ino.toString(),
      path: resolved,
      size: stat.size,
    })).digest("hex");
    return resolved === executable.replaceAll("\\", "/") && identity === expectedIdentity;
  } catch {
    return false;
  }
}

export function listExecutionPolicyCommands(
  databasePath: string,
  executionId: string,
): {
  commands: Array<{
    args: string[];
    entryId: string;
    executable: string;
    network: "loopback_only" | null;
    openPath: string | null;
    port: number | null;
    purpose: "preview" | "validation";
    required: boolean;
    timeoutSeconds: number;
    workdir: string;
  }>;
  currentProcess: {
    id: string;
    previewUrl: string | null;
    status: PolicyProcessRow["status"];
  } | null;
  executionId: string;
  executionVersion: number;
  policyRevisionId: string;
  projectId: string;
} {
  const database = openDatabase(databasePath);
  try {
    const execution = executionPolicyRow(database, executionId);
    const commands = policyEntryRows(database, execution).map((entry) => ({
      args: parseArgs(entry.argsJson),
      entryId: entry.id,
      executable: executableLabel(entry.executable),
      network: entry.network,
      openPath: entry.openPath,
      port: entry.port,
      purpose: entry.purpose,
      required: entry.required === 1,
      timeoutSeconds: entry.timeoutSeconds,
      workdir: entry.workdir,
    }));
    const current = database.prepare(`
      SELECT id FROM execution_policy_processes
      WHERE project_id=? AND execution_id=?
      ORDER BY
        CASE WHEN status IN ('starting','running','ready','stopping') THEN 0 ELSE 1 END,
        created_at DESC,id DESC
      LIMIT 1
    `).get(execution.projectId, executionId) as { id: string } | undefined;
    const currentProcess = current
      ? getPolicyProcess(databasePath, executionId, current.id)
      : null;
    return {
      commands,
      currentProcess: currentProcess
        ? {
          id: currentProcess.id,
          previewUrl: currentProcess.previewUrl,
          status: currentProcess.status,
        }
        : null,
      executionId: execution.executionId,
      executionVersion: execution.executionVersion,
      policyRevisionId: execution.policyRevisionId,
      projectId: execution.projectId,
    };
  } finally {
    database.close();
  }
}

export function classifyPolicyProcessCommand(
  databasePath: string,
  executionId: string,
  command: CommandInput,
  context: CommandPolicyContext,
): {
  decision: "denied" | "one_shot" | "standing_exact";
  reasonCode: string | null;
} {
  const database = openDatabase(databasePath);
  try {
    const execution = executionPolicyRow(database, executionId);
    if (
      context.sandboxRoot.replaceAll("\\", "/") !== execution.sandboxRoot.replaceAll("\\", "/")
      || context.canonicalRoot.replaceAll("\\", "/") !== execution.workspacePath.replaceAll("\\", "/")
    ) {
      throw new ExecutionError("EXECUTION_CONTEXT_MISMATCH", 409, "Execution process context changed.");
    }
    const classification = classifyExecutionCommand(
      command,
      standingEntries(policyEntryRows(database, execution), execution.classifierVersion),
      context,
    );
    return {
      decision: classification.decision === "deny"
        ? "denied"
        : classification.decision === "standing_exact"
          ? "standing_exact"
          : "one_shot",
      reasonCode: classification.code,
    };
  } finally {
    database.close();
  }
}

export function requestPolicyProcessApproval(
  databasePath: string,
  executionId: string,
  input: {
    command: CommandInput;
    expectedExecutionVersion: number;
    operationId: string;
  },
  context: CommandPolicyContext,
): {
  approvalId: string | null;
  decision: "denied" | "one_shot" | "standing_exact";
  reasonCode: string | null;
} {
  const classification = classifyPolicyProcessCommand(
    databasePath,
    executionId,
    input.command,
    context,
  );
  if (classification.decision === "denied") {
    const database = openDatabase(databasePath);
    try {
      transaction(database, () => appendPolicyProcessEvent(database, {
        actorType: "owner",
        executionId,
        payload: {
          operationId: input.operationId,
          reasonCode: classification.reasonCode,
          status: "denied",
        },
        type: "policy_process_denied",
      }));
    } finally {
      database.close();
    }
    return { approvalId: null, ...classification };
  }
  if (classification.decision !== "one_shot") {
    return { approvalId: null, ...classification };
  }
  const database = openDatabase(databasePath);
  try {
    const row = database.prepare(`
      SELECT e.project_id AS projectId,a.frozen_context_hash AS contextHash
      FROM executions e
      JOIN execution_attempts a
        ON a.project_id=e.project_id AND a.execution_id=e.id
       AND a.attempt_no=e.current_attempt_no
      WHERE e.id=?
    `).get(executionId) as { contextHash: string; projectId: string } | undefined;
    if (!row) throw new ExecutionError("EXECUTION_NOT_FOUND", 404, "Execution was not found.");
    const result = requestExecutionCommand({
      actorType: "owner",
      command: {
        ...input.command,
        expectedEffect: "Run one owner-requested policy process.",
      },
      contextHash: row.contextHash,
      consumer: "policy_process",
      database,
      executionId,
      expectedVersion: input.expectedExecutionVersion,
      operationId: input.operationId,
      policyContext: context,
      projectId: row.projectId,
    });
    return {
      approvalId: result.approvalId,
      decision: result.decision,
      reasonCode: result.reasonCode,
    };
  } finally {
    database.close();
  }
}

export function requestLabeledPolicyProcessApproval(
  databasePath: string,
  executionId: string,
  input: {
    command: { args: string[]; executable: string; workdir: string };
    expectedExecutionVersion: number;
    operationId: string;
  },
  executionRoot: string,
): ReturnType<typeof requestPolicyProcessApproval> {
  const database = openDatabase(databasePath);
  let command: CommandInput;
  let context: CommandPolicyContext;
  try {
    const execution = executionPolicyRow(database, executionId);
    const candidates = policyEntryRows(database, execution)
      .filter((entry) => executableLabel(entry.executable) === input.command.executable);
    const identities = new Set(candidates.map((entry) =>
      `${entry.executable}\0${entry.executableIdentity}`));
    if (identities.size !== 1) {
      transaction(database, () => appendPolicyProcessEvent(database, {
        actorType: "owner",
        executionId,
        payload: {
          operationId: input.operationId,
          reasonCode: "EXECUTABLE_NOT_VERIFIED",
          status: "denied",
        },
        type: "policy_process_denied",
      }));
      return {
        approvalId: null,
        decision: "denied",
        reasonCode: "EXECUTABLE_NOT_VERIFIED",
      };
    }
    const [entry] = candidates;
    if (!entry) throw new ExecutionError("POLICY_INVALID", 409, "Policy executable is invalid.");
    command = {
      args: input.command.args,
      executable: entry.executable,
      executableIdentity: entry.executableIdentity,
      workdir: input.command.workdir,
    };
    context = {
      canonicalRoot: execution.workspacePath,
      executionRoot,
      platform: process.platform === "win32" ? "win32" : "posix",
      sandboxRoot: execution.sandboxRoot,
    };
  } finally {
    database.close();
  }
  return requestPolicyProcessApproval(databasePath, executionId, {
    command,
    expectedExecutionVersion: input.expectedExecutionVersion,
    operationId: input.operationId,
  }, context);
}

type PolicyProcessRow = {
  authorizationSource: "one_shot" | "standing_policy";
  exitCode: number | null;
  id: string;
  operationId: string;
  publicRequestJson: string;
  reasonCode: string | null;
  requestHash: string;
  status:
    | "completed"
    | "failed"
    | "interrupted"
    | "ready"
    | "running"
    | "starting"
    | "stopped"
    | "stopping"
    | "termination_unconfirmed"
    | "timed_out";
  stderrBytes: number | null;
  stderrTruncated: number | null;
  stdoutBytes: number | null;
  stdoutTruncated: number | null;
  version: number;
};

function policyProcessRow(
  database: ReturnType<typeof openDatabase>,
  executionId: string,
  processId: string,
): PolicyProcessRow {
  const row = database.prepare(`
    SELECT id,operation_id AS operationId,request_hash AS requestHash,
           authorization_source AS authorizationSource,status,exit_code AS exitCode,
           reason_code AS reasonCode,stdout_bytes AS stdoutBytes,
           stderr_bytes AS stderrBytes,stdout_truncated AS stdoutTruncated,
           stderr_truncated AS stderrTruncated,public_request_json AS publicRequestJson,
           version
    FROM execution_policy_processes
    WHERE execution_id=? AND id=?
  `).get(executionId, processId) as PolicyProcessRow | undefined;
  if (!row) throw new ExecutionError("POLICY_PROCESS_NOT_FOUND", 404, "Policy process was not found.");
  return row;
}

function outputText(
  database: ReturnType<typeof openDatabase>,
  processId: string,
  stream: "stderr" | "stdout",
): string {
  return (database.prepare(`
    SELECT text FROM execution_policy_process_output_chunks
    WHERE process_id=? AND stream=? ORDER BY chunk_index
  `).all(processId, stream) as Array<{ text: string }>).map(({ text }) => text).join("");
}

export function getPolicyProcess(
  databasePath: string,
  executionId: string,
  processId: string,
): {
  authorizationSource: "one_shot" | "standing_policy";
  exitCode: number | null;
  id: string;
  reasonCode: string | null;
  previewUrl: string | null;
  status: PolicyProcessRow["status"];
  stderr: { bytes: number; text: string; truncated: boolean };
  stdout: { bytes: number; text: string; truncated: boolean };
  version: number;
} {
  const database = openDatabase(databasePath);
  try {
    const row = policyProcessRow(database, executionId, processId);
    const request = JSON.parse(row.publicRequestJson) as {
      openPath?: unknown;
      port?: unknown;
      purpose?: unknown;
    };
    const previewUrl = row.status === "ready"
      && request.purpose === "preview"
      && Number.isInteger(request.port)
      && typeof request.openPath === "string"
      ? `http://127.0.0.1:${String(request.port)}${request.openPath}`
      : null;
    return {
      authorizationSource: row.authorizationSource,
      exitCode: row.exitCode,
      id: row.id,
      previewUrl,
      reasonCode: row.reasonCode,
      status: row.status,
      stderr: {
        bytes: row.stderrBytes ?? 0,
        text: outputText(database, row.id, "stderr"),
        truncated: row.stderrTruncated === 1,
      },
      stdout: {
        bytes: row.stdoutBytes ?? 0,
        text: outputText(database, row.id, "stdout"),
        truncated: row.stdoutTruncated === 1,
      },
      version: row.version,
    };
  } finally {
    database.close();
  }
}

async function loopbackPortAvailable(port: number): Promise<boolean> {
  return await new Promise((resolvePromise) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolvePromise(false));
    server.listen({ host: "127.0.0.1", port }, () => {
      server.close(() => resolvePromise(true));
    });
  });
}

async function loopbackReady(port: number): Promise<boolean> {
  return await new Promise((resolvePromise) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.unref();
    socket.setTimeout(500);
    socket.once("connect", () => {
      socket.destroy();
      resolvePromise(true);
    });
    socket.once("error", () => resolvePromise(false));
    socket.once("timeout", () => {
      socket.destroy();
      resolvePromise(false);
    });
  });
}

async function monitorPreviewReadiness(
  databasePath: string,
  executionId: string,
  processId: string,
  port: number,
  probeReady: (port: number) => Promise<boolean> = loopbackReady,
): Promise<void> {
  while (true) {
    const process = getPolicyProcess(databasePath, executionId, processId);
    if (process.status !== "running") return;
    if (await probeReady(port)) {
      const database = openDatabase(databasePath);
      try {
        transaction(database, () => {
          const updated = database.prepare(`
            UPDATE execution_policy_processes
            SET status='ready',preview_ready_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                version=version+1,
                updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
            WHERE execution_id=? AND id=? AND status='running'
          `).run(executionId, processId);
          if (updated.changes === 1) {
            appendPolicyProcessEvent(database, {
              actorType: "system",
              executionId,
              payload: { processId, status: "ready" },
              type: "policy_process_ready",
            });
          }
        });
      } finally {
        database.close();
      }
      return;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
}

export function getPolicyProcessOutput(
  databasePath: string,
  executionId: string,
  processId: string,
  cursors: { stderr: number; stdout: number },
): {
  status: PolicyProcessRow["status"];
  stderr: { chunks: Array<{ cursor: number; text: string }>; nextCursor: number };
  stdout: { chunks: Array<{ cursor: number; text: string }>; nextCursor: number };
} {
  const database = openDatabase(databasePath);
  try {
    const row = policyProcessRow(database, executionId, processId);
    const read = (stream: "stderr" | "stdout", cursor: number) => {
      const chunks = database.prepare(`
        SELECT chunk_index AS cursor,text
        FROM execution_policy_process_output_chunks
        WHERE process_id=? AND stream=? AND chunk_index>=?
        ORDER BY chunk_index LIMIT 256
      `).all(processId, stream, cursor) as Array<{ cursor: number; text: string }>;
      return {
        chunks,
        nextCursor: chunks.length === 0 ? cursor : chunks[chunks.length - 1]!.cursor + 1,
      };
    };
    return {
      status: row.status,
      stderr: read("stderr", cursors.stderr),
      stdout: read("stdout", cursors.stdout),
    };
  } finally {
    database.close();
  }
}

export function stopPolicyProcess(
  databasePath: string,
  executionId: string,
  processId: string,
  expectedVersion: number,
): ReturnType<typeof getPolicyProcess> {
  const database = openDatabase(databasePath);
  let requested = false;
  try {
    const row = policyProcessRow(database, executionId, processId);
    if (!["starting", "running", "ready", "stopping"].includes(row.status)) {
      return getPolicyProcess(databasePath, executionId, processId);
    }
    if (row.version !== expectedVersion) {
      throw new ExecutionError("POLICY_PROCESS_STATE_CONFLICT", 409, "Policy process changed.");
    }
    transaction(database, () => {
      const updated = database.prepare(`
        UPDATE execution_policy_processes
        SET status='stopping',version=version+1,
            updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE execution_id=? AND id=? AND status IN ('starting','running','ready')
      `).run(executionId, processId);
      requested = updated.changes === 1;
      if (requested) {
        appendPolicyProcessEvent(database, {
          actorType: "owner",
          executionId,
          payload: { processId, status: "stopping" },
          type: "policy_process_stop_requested",
        });
      }
    });
  } finally {
    database.close();
  }
  if (requested) {
    stopRequested.add(processId);
    activeTerminationRequests.get(processId)?.();
  }
  return getPolicyProcess(databasePath, executionId, processId);
}

function finishPolicyProcess(
  databasePath: string,
  executionId: string,
  processId: string,
  result: DirectProcessResult,
): void {
  activeTerminationRequests.delete(processId);
  const stopped = stopRequested.delete(processId);
  const status: PolicyProcessRow["status"] = stopped
    ? "stopped"
    : result.status === "timed_out"
      ? "timed_out"
      : result.status === "termination_unconfirmed"
        ? "termination_unconfirmed"
        : result.status === "lease_lost"
          ? "interrupted"
          : result.exitCode === 0
            ? "completed"
            : "failed";
  const reasonCode = status === "completed" || status === "stopped"
    ? null
    : status.toUpperCase();
  const database = openDatabase(databasePath);
  try {
    transaction(database, () => {
      const current = policyProcessRow(database, executionId, processId);
      if (!["starting", "running", "ready", "stopping"].includes(current.status)) return;
      const insert = database.prepare(`
        INSERT INTO execution_policy_process_output_chunks (
          process_id,stream,chunk_index,byte_offset,byte_length,text,sha256
        ) VALUES (?,?,?,?,?,?,?)
      `);
      database.prepare(`
        DELETE FROM execution_policy_process_output_chunks WHERE process_id=?
      `).run(processId);
      for (const [stream, output] of [
        ["stdout", result.stdout],
        ["stderr", result.stderr],
      ] as const) {
        output.chunks.forEach((chunk, index) => {
          insert.run(
            processId,
            stream,
            index,
            chunk.byteOffset,
            chunk.byteLength,
            chunk.text,
            chunk.sha256,
          );
        });
      }
      const updated = database.prepare(`
        UPDATE execution_policy_processes
        SET status=?,exit_code=?,reason_code=?,
            stdout_bytes=?,stderr_bytes=?,stdout_sha256=?,stderr_sha256=?,
            stdout_truncated=?,stderr_truncated=?,version=version+1,
            updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE execution_id=? AND id=? AND status IN ('starting','running','ready','stopping')
      `).run(
        status,
        result.exitCode,
        reasonCode,
        result.stdout.bytes,
        result.stderr.bytes,
        result.stdout.sha256,
        result.stderr.sha256,
        result.stdout.truncated ? 1 : 0,
        result.stderr.truncated ? 1 : 0,
        executionId,
        processId,
      );
      if (updated.changes !== 1) {
        throw new ExecutionError("POLICY_PROCESS_STATE_CONFLICT", 409, "Policy process changed.");
      }
      if (current.authorizationSource === "one_shot") {
        database.prepare(`
          UPDATE execution_tool_calls
          SET status=?,public_result_json=?,
              finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id=(
            SELECT approval.tool_call_id
            FROM execution_policy_processes process
            JOIN execution_approvals approval ON approval.id=process.approval_id
            WHERE process.id=?
          ) AND status='waiting_approval'
        `).run(
          status === "completed" ? "succeeded" : "failed",
          JSON.stringify({ exitCode: result.exitCode, reasonCode, status }),
          processId,
        );
      }
      appendPolicyProcessEvent(database, {
        actorType: "system",
        executionId,
        payload: {
          authorizationSource: current.authorizationSource,
          exitCode: result.exitCode,
          processId,
          reasonCode,
          status,
          truncated: result.stdout.truncated || result.stderr.truncated,
        },
        type: "policy_process_finished",
      });
    });
  } finally {
    database.close();
  }
}

function failPolicyProcess(
  databasePath: string,
  executionId: string,
  processId: string,
): void {
  activeTerminationRequests.delete(processId);
  stopRequested.delete(processId);
  const database = openDatabase(databasePath);
  try {
    transaction(database, () => {
      const current = policyProcessRow(database, executionId, processId);
      const updated = database.prepare(`
        UPDATE execution_policy_processes
        SET status='failed',reason_code='COMMAND_PROCESS_FAILED',version=version+1,
            updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE execution_id=? AND id=? AND status IN ('starting','running','ready','stopping')
      `).run(executionId, processId);
      if (updated.changes === 1) {
        if (current.authorizationSource === "one_shot") {
          database.prepare(`
            UPDATE execution_tool_calls
            SET status='failed',public_result_json=?,
                finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
            WHERE id=(
              SELECT approval.tool_call_id
              FROM execution_policy_processes process
              JOIN execution_approvals approval ON approval.id=process.approval_id
              WHERE process.id=?
            ) AND status='waiting_approval'
          `).run(JSON.stringify({
            reasonCode: "COMMAND_PROCESS_FAILED",
            status: "failed",
          }), processId);
        }
        appendPolicyProcessEvent(database, {
          actorType: "system",
          executionId,
          payload: {
            processId,
            reasonCode: "COMMAND_PROCESS_FAILED",
            status: "failed",
          },
          type: "policy_process_finished",
        });
      }
    });
  } finally {
    database.close();
  }
}

function checkpointPolicyProcessOutput(
  databasePath: string,
  executionId: string,
  processId: string,
  stream: "stderr" | "stdout",
  output: ProcessOutput,
): void {
  const database = openDatabase(databasePath);
  try {
    transaction(database, () => {
      const current = policyProcessRow(database, executionId, processId);
      if (!["starting", "running", "ready"].includes(current.status)) return;
      database.prepare(`
        DELETE FROM execution_policy_process_output_chunks
        WHERE process_id=? AND stream=?
      `).run(processId, stream);
      const insert = database.prepare(`
        INSERT INTO execution_policy_process_output_chunks (
          process_id,stream,chunk_index,byte_offset,byte_length,text,sha256
        ) VALUES (?,?,?,?,?,?,?)
      `);
      output.chunks.forEach((chunk, index) => {
        insert.run(
          processId,
          stream,
          index,
          chunk.byteOffset,
          chunk.byteLength,
          chunk.text,
          chunk.sha256,
        );
      });
      if (stream === "stdout") {
        database.prepare(`
          UPDATE execution_policy_processes
          SET stdout_bytes=?,stdout_sha256=?,stdout_truncated=?,
              updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE execution_id=? AND id=? AND status IN ('starting','running','ready')
        `).run(
          output.bytes,
          output.sha256,
          output.truncated ? 1 : 0,
          executionId,
          processId,
        );
      } else {
        database.prepare(`
          UPDATE execution_policy_processes
          SET stderr_bytes=?,stderr_sha256=?,stderr_truncated=?,
              updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE execution_id=? AND id=? AND status IN ('starting','running','ready')
        `).run(
          output.bytes,
          output.sha256,
          output.truncated ? 1 : 0,
          executionId,
          processId,
        );
      }
    });
  } finally {
    database.close();
  }
}

function launchPolicyProcess(
  databasePath: string,
  executionId: string,
  input: {
    args: string[];
    authorizationSource: "one_shot" | "standing_policy";
    executable: string;
    processId: string;
    runProcess?: RunProcess;
    sandboxRoot: string;
    timeoutMs: number;
    workdir: string;
  },
): ReturnType<typeof getPolicyProcess> {
  const runProcess = input.runProcess ?? ((runInput) => runDirectProcess({
    ...runInput,
    timeoutMs: runInput.timeoutMs,
  }));
  let pending: Promise<DirectProcessResult>;
  try {
    pending = runProcess({
      args: input.args,
      authorizationSource: input.authorizationSource,
      executable: input.executable,
      heartbeat: () => {
        const heartbeatDatabase = openDatabase(databasePath);
        try {
          const row = policyProcessRow(heartbeatDatabase, executionId, input.processId);
          return ["running", "ready"].includes(row.status);
        } finally {
          heartbeatDatabase.close();
        }
      },
      onOutputSnapshot: (stream, output) => {
        checkpointPolicyProcessOutput(
          databasePath,
          executionId,
          input.processId,
          stream,
          output,
        );
      },
      registerTerminationRequest(request) {
        if (request) activeTerminationRequests.set(input.processId, request);
        else activeTerminationRequests.delete(input.processId);
      },
      sandboxRoot: input.sandboxRoot,
      timeoutMs: input.timeoutMs,
      workdir: input.workdir,
    });
  } catch {
    failPolicyProcess(databasePath, executionId, input.processId);
    return getPolicyProcess(databasePath, executionId, input.processId);
  }
  const runningDatabase = openDatabase(databasePath);
  try {
    runningDatabase.prepare(`
      UPDATE execution_policy_processes
      SET status='running',version=version+1,
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE execution_id=? AND id=? AND status='starting'
    `).run(executionId, input.processId);
  } finally {
    runningDatabase.close();
  }
  void pending
    .then((result) => finishPolicyProcess(databasePath, executionId, input.processId, result))
    .catch(() => failPolicyProcess(databasePath, executionId, input.processId));
  return getPolicyProcess(databasePath, executionId, input.processId);
}

export function startPolicyProcess(
  databasePath: string,
  executionId: string,
  input: {
    entryId: string;
    expectedExecutionVersion: number;
    operationId: string;
  },
  options: {
    runProcess?: RunProcess;
    verifyExecutableIdentity?: (executable: string, expectedIdentity: string) => boolean;
  } = {},
): ReturnType<typeof getPolicyProcess> {
  const database = openDatabase(databasePath);
  let processId: string;
  let executable: string;
  let args: string[];
  let sandboxRoot: string;
  let workdir: string;
  let timeoutMs: number;
  try {
    const execution = executionPolicyRow(database, executionId);
    const entry = policyEntryRows(database, execution).find(({ id }) => id === input.entryId);
    if (!entry) {
      throw new ExecutionError("POLICY_ENTRY_NOT_FROZEN", 409, "Policy entry is not frozen for execution.");
    }
    const standing = standingEntries([entry], execution.classifierVersion);
    if (standing.length !== 1) {
      throw new ExecutionError("POLICY_ENTRY_INVALID", 409, "Frozen policy entry is invalid.");
    }
    const requestHash = canonicalRequestHash({
      entryId: input.entryId,
      executionId,
      expectedExecutionVersion: input.expectedExecutionVersion,
      kind: "policy_process_start",
    });
    const existing = database.prepare(`
      SELECT id,request_hash AS requestHash FROM execution_policy_processes
      WHERE project_id=? AND operation_id=?
    `).get(execution.projectId, input.operationId) as {
      id: string;
      requestHash: string;
    } | undefined;
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new ExecutionError("OPERATION_CONFLICT", 409, "Operation id was reused.");
      }
      return getPolicyProcess(databasePath, executionId, existing.id);
    }
    const verifyExecutableIdentity = options.verifyExecutableIdentity ?? hasExecutableIdentity;
    if (!verifyExecutableIdentity(entry.executable, entry.executableIdentity)) {
      throw new ExecutionError(
        "EXECUTABLE_IDENTITY_CHANGED",
        409,
        "The frozen executable identity changed.",
      );
    }
    const state = database.prepare(`
      SELECT e.status,e.version,a.id AS attemptId,a.status AS attemptStatus,
             a.sandbox_manifest_hash AS sandboxManifestHash
      FROM executions e
      JOIN execution_attempts a
        ON a.project_id=e.project_id AND a.execution_id=e.id
       AND a.attempt_no=e.current_attempt_no
      WHERE e.id=?
    `).get(executionId) as {
      attemptId: string;
      attemptStatus: string;
      sandboxManifestHash: string | null;
      status: string;
      version: number;
    };
    if (
      state.status !== "running"
      || !["acting", "ready"].includes(state.attemptStatus)
      || state.version !== input.expectedExecutionVersion
      || !state.sandboxManifestHash
    ) {
      throw new ExecutionError("EXECUTION_STATE_CONFLICT", 409, "Execution cannot run a policy process.");
    }
    const activeAction = database.prepare(`
      SELECT 1 FROM execution_actions
      WHERE execution_id=? AND status IN ('pending','running') LIMIT 1
    `).get(executionId);
    if (activeAction) {
      throw new ExecutionError("OPERATION_IN_PROGRESS", 409, "Execution already has an active action.");
    }
    if (database.prepare(`
      SELECT 1 FROM execution_policy_processes
      WHERE execution_id=? AND status IN ('starting','running','ready','stopping')
      LIMIT 1
    `).get(executionId)) {
      throw new ExecutionError(
        "POLICY_PROCESS_IN_PROGRESS",
        409,
        "Execution already has an active policy process.",
      );
    }
    processId = randomUUID();
    executable = entry.executable;
    args = parseArgs(entry.argsJson);
    sandboxRoot = execution.sandboxRoot;
    workdir = entry.workdir;
    timeoutMs = entry.timeoutSeconds * 1000;
    const now = new Date();
    const deadline = new Date(now.getTime() + timeoutMs).toISOString();
    transaction(database, () => {
      database.prepare(`
        INSERT INTO execution_policy_processes (
          id,project_id,execution_id,attempt_id,policy_revision_id,policy_entry_id,
          operation_id,request_hash,executable_identity,authorization_source,status,public_request_json,
          sandbox_manifest_hash,deadline_at,created_at,updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,'starting',?,?,?,?,?)
      `).run(
        processId,
        execution.projectId,
        executionId,
        state.attemptId,
        execution.policyRevisionId,
        entry.id,
        input.operationId,
        requestHash,
        entry.executableIdentity,
        "standing_policy",
        JSON.stringify({
          args,
          executable: executableLabel(executable),
          network: entry.network,
          openPath: entry.openPath,
          port: entry.port,
          purpose: entry.purpose,
          timeoutSeconds: entry.timeoutSeconds,
          workdir,
        }),
        state.sandboxManifestHash,
        deadline,
        now.toISOString(),
        now.toISOString(),
      );
      appendPolicyProcessEvent(database, {
        actorType: "owner",
        executionId,
        payload: {
          authorizationSource: "standing_policy",
          operationId: input.operationId,
          policyEntryId: entry.id,
          processId,
          status: "starting",
        },
        type: "policy_process_started",
      });
    });
  } finally {
    database.close();
  }

  return launchPolicyProcess(databasePath, executionId, {
    args,
    authorizationSource: "standing_policy",
    executable,
    processId,
    runProcess: options.runProcess,
    sandboxRoot,
    timeoutMs,
    workdir,
  });
}

export function startApprovedPolicyProcess(
  databasePath: string,
  executionId: string,
  input: {
    approvalId: string;
    expectedExecutionVersion: number;
    operationId: string;
  },
  executionRoot: string,
  options: {
    runProcess?: RunProcess;
    verifyExecutableIdentity?: (executable: string, expectedIdentity: string) => boolean;
  } = {},
): ReturnType<typeof getPolicyProcess> {
  const database = openDatabase(databasePath);
  let args: string[];
  let executable: string;
  let processId: string;
  let sandboxRoot: string;
  let workdir: string;
  const timeoutMs = 120_000;
  try {
    const requestHash = canonicalRequestHash({
      approvalId: input.approvalId,
      executionId,
      expectedExecutionVersion: input.expectedExecutionVersion,
      kind: "approved_policy_process_start",
    });
    const existing = database.prepare(`
      SELECT id,request_hash AS requestHash FROM execution_policy_processes
      WHERE operation_id=?
    `).get(input.operationId) as { id: string; requestHash: string } | undefined;
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new ExecutionError("OPERATION_CONFLICT", 409, "Operation id was reused.");
      }
      return getPolicyProcess(databasePath, executionId, existing.id);
    }
    const row = database.prepare(`
      SELECT approval.project_id AS projectId,approval.attempt_id AS attemptId,
             approval.request_hash AS approvalRequestHash,
             approval.input_hash AS approvalInputHash,approval.status AS approvalStatus,
             tool.id AS toolCallId,tool.request_hash AS toolRequestHash,
             tool.before_sandbox_hash AS toolInputHash,tool.public_request_json AS requestJson,
             tool.status AS toolStatus,execution.status AS executionStatus,
             execution.version AS executionVersion,execution.current_attempt_no AS attemptNo,
             attempt.sandbox_root AS sandboxRoot,
             attempt.sandbox_manifest_hash AS sandboxManifestHash,
             attempt.frozen_policy_revision_id AS policyRevisionId,
             project.workspace_path AS workspacePath
      FROM execution_approvals approval
      JOIN execution_tool_calls tool
        ON tool.project_id=approval.project_id AND tool.execution_id=approval.execution_id
       AND tool.attempt_id=approval.attempt_id AND tool.id=approval.tool_call_id
      JOIN executions execution
        ON execution.project_id=approval.project_id AND execution.id=approval.execution_id
      JOIN execution_attempts attempt
        ON attempt.project_id=approval.project_id AND attempt.execution_id=approval.execution_id
       AND attempt.id=approval.attempt_id
      JOIN projects project ON project.id=approval.project_id
      WHERE approval.id=? AND approval.execution_id=? AND approval.kind='command'
    `).get(input.approvalId, executionId) as {
      approvalInputHash: string;
      approvalRequestHash: string;
      approvalStatus: string;
      attemptId: string;
      attemptNo: number;
      executionStatus: string;
      executionVersion: number;
      policyRevisionId: string;
      projectId: string;
      requestJson: string;
      sandboxManifestHash: string;
      sandboxRoot: string;
      toolCallId: string;
      toolInputHash: string;
      toolRequestHash: string;
      toolStatus: string;
      workspacePath: string;
    } | undefined;
    if (
      !row
      || row.approvalStatus !== "approved"
      || row.toolStatus !== "waiting_approval"
      || row.executionStatus !== "waiting_approval"
      || row.executionVersion !== input.expectedExecutionVersion
      || row.approvalRequestHash !== row.toolRequestHash
      || row.approvalInputHash !== row.toolInputHash
      || row.approvalInputHash !== row.sandboxManifestHash
    ) {
      throw new ExecutionError("APPROVAL_STALE", 409, "Policy process approval is stale.");
    }
    const parsed = JSON.parse(row.requestJson) as Record<string, unknown>;
    if (
      parsed.consumer !== "policy_process"
      || typeof parsed.executable !== "string"
      || typeof parsed.executableIdentity !== "string"
      || typeof parsed.workdir !== "string"
      || !Array.isArray(parsed.args)
      || !parsed.args.every((argument) => typeof argument === "string")
    ) {
      throw new ExecutionError("APPROVAL_STALE", 409, "Policy process approval is malformed.");
    }
    executable = parsed.executable;
    args = [...parsed.args] as string[];
    workdir = parsed.workdir;
    const executableIdentity = parsed.executableIdentity;
    const classification = classifyExecutionCommand({
      args,
      executable,
      executableIdentity,
      workdir,
    }, [], {
      canonicalRoot: row.workspacePath,
      executionRoot,
      platform: process.platform === "win32" ? "win32" : "posix",
      sandboxRoot: row.sandboxRoot,
    });
    if (classification.decision !== "one_shot") {
      throw new ExecutionError("APPROVAL_STALE", 409, "Policy process approval changed.");
    }
    const verifyExecutableIdentity = options.verifyExecutableIdentity ?? hasExecutableIdentity;
    if (!verifyExecutableIdentity(executable, executableIdentity)) {
      throw new ExecutionError(
        "EXECUTABLE_IDENTITY_CHANGED",
        409,
        "The approved executable identity changed.",
      );
    }
    if (database.prepare(`
      SELECT 1 FROM execution_actions
      WHERE execution_id=? AND status IN ('pending','running') LIMIT 1
    `).get(executionId)) {
      throw new ExecutionError("OPERATION_IN_PROGRESS", 409, "Execution already has an active action.");
    }
    if (database.prepare(`
      SELECT 1 FROM execution_policy_processes
      WHERE execution_id=? AND status IN ('starting','running','ready','stopping')
      LIMIT 1
    `).get(executionId)) {
      throw new ExecutionError(
        "POLICY_PROCESS_IN_PROGRESS",
        409,
        "Execution already has an active policy process.",
      );
    }
    processId = randomUUID();
    sandboxRoot = row.sandboxRoot;
    const now = new Date();
    transaction(database, () => {
      const consumed = consumeApprovedApprovalById(database, input.approvalId);
      const execution = database.prepare(`
        UPDATE executions
        SET status='running',reason_code=NULL,version=version+1,
            updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id=? AND version=? AND status='waiting_approval'
      `).run(executionId, input.expectedExecutionVersion);
      if (consumed.changes !== 1 || execution.changes !== 1) {
        throw new ExecutionError("APPROVAL_STATE_CONFLICT", 409, "Approval changed.");
      }
      database.prepare(`
        INSERT INTO execution_policy_processes (
          id,project_id,execution_id,attempt_id,policy_revision_id,policy_entry_id,
          approval_id,operation_id,request_hash,executable_identity,
          authorization_source,status,public_request_json,sandbox_manifest_hash,
          deadline_at,created_at,updated_at
        ) VALUES (?,?,?,?,?,NULL,?,?,?,?,?,'starting',?,?,?,?,?)
      `).run(
        processId,
        row.projectId,
        executionId,
        row.attemptId,
        row.policyRevisionId,
        input.approvalId,
        input.operationId,
        requestHash,
        executableIdentity,
        "one_shot",
        JSON.stringify({
          args,
          executable: executableLabel(executable),
          network: null,
          openPath: null,
          port: null,
          purpose: "validation",
          timeoutSeconds: 120,
          workdir,
        }),
        row.sandboxManifestHash,
        new Date(now.getTime() + timeoutMs).toISOString(),
        now.toISOString(),
        now.toISOString(),
      );
      appendPolicyProcessEvent(database, {
        actorType: "owner",
        executionId,
        payload: {
          approvalId: input.approvalId,
          authorizationSource: "one_shot",
          operationId: input.operationId,
          processId,
          status: "starting",
        },
        type: "policy_process_started",
      });
    });
  } finally {
    database.close();
  }
  return launchPolicyProcess(databasePath, executionId, {
    args,
    authorizationSource: "one_shot",
    executable,
    processId,
    runProcess: options.runProcess,
    sandboxRoot,
    timeoutMs,
    workdir,
  });
}

export async function startPolicyProcessSession(
  databasePath: string,
  executionId: string,
  input: {
    entryId: string;
    expectedExecutionVersion: number;
    operationId: string;
  },
  options: {
    checkPortAvailable?: (port: number) => Promise<boolean>;
    probeReady?: (port: number) => Promise<boolean>;
    runProcess?: RunProcess;
    verifyExecutableIdentity?: (executable: string, expectedIdentity: string) => boolean;
  } = {},
): Promise<ReturnType<typeof getPolicyProcess>> {
  const database = openDatabase(databasePath);
  let previewPort: number | null = null;
  try {
    const execution = executionPolicyRow(database, executionId);
    const entry = policyEntryRows(database, execution).find(({ id }) => id === input.entryId);
    if (entry?.purpose === "preview") {
      previewPort = entry.port;
      const checkPortAvailable = options.checkPortAvailable ?? loopbackPortAvailable;
      if (previewPort === null || !await checkPortAvailable(previewPort)) {
        throw new ExecutionError(
          "PREVIEW_PORT_UNAVAILABLE",
          409,
          "The frozen preview port is unavailable.",
        );
      }
    }
  } finally {
    database.close();
  }
  const process = startPolicyProcess(databasePath, executionId, input, options);
  if (previewPort !== null && process.status === "running") {
    void monitorPreviewReadiness(
      databasePath,
      executionId,
      process.id,
      previewPort,
      options.probeReady,
    );
  }
  return process;
}
