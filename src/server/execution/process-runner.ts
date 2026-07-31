import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import {
  acquireExecutionAction,
  finalizeExecutionActionWithEffects,
  heartbeatExecutionAction,
} from "@/src/server/execution/execution-actions";

const HEARTBEAT_MS = 30_000;
const OVERALL_DEADLINE_MS = 120_000;
const STREAM_LIMIT_BYTES = 1_048_576;
const CHUNK_LIMIT_BYTES = 65_536;
const TRUNCATION_MARKER = "[TRUNCATED]";
const REDACTED_CREDENTIAL = "[REDACTED:CREDENTIAL]";
const processTerminationRequests = new Map<string, () => void>();

export function requestExecutionProcessTermination(actionId: string): boolean {
  const request = processTerminationRequests.get(actionId);
  if (!request) return false;
  request();
  return true;
}

type TimerHandle = ReturnType<typeof setTimeout>;

export type ProcessRunnerClock = {
  clearInterval(handle: unknown): void;
  clearTimeout(handle: unknown): void;
  now(): number;
  setInterval(callback: () => void, milliseconds: number): unknown;
  setTimeout(callback: () => void, milliseconds: number): unknown;
};

type SpawnOptions = {
  cwd: string;
  detached: boolean;
  env: Record<string, string>;
  shell: false;
  stdio: ["ignore", "pipe", "pipe"];
  windowsHide: true;
};

export type ProcessRunnerChild = NodeJS.EventEmitter & {
  pid?: number;
  stderr: NodeJS.ReadableStream;
  stdout: NodeJS.ReadableStream;
};

export type ProcessRunnerAdapter = {
  confirmTreeExited(pid: number): Promise<boolean>;
  spawn(executable: string, args: string[], options: SpawnOptions): ProcessRunnerChild;
  terminateTree(pid: number): Promise<boolean>;
};

export type ProcessOutputChunk = {
  byteLength: number;
  byteOffset: number;
  sha256: string;
  text: string;
};

export type ProcessOutput = {
  bytes: number;
  chunks: ProcessOutputChunk[];
  sha256: string;
  truncated: boolean;
};

export type DirectProcessResult = {
  authorizationSource: "one_shot" | "standing_policy";
  durationMs: number;
  exitCode: number | null;
  status: "completed" | "lease_lost" | "termination_unconfirmed" | "timed_out";
  stderr: ProcessOutput;
  stdout: ProcessOutput;
};

type CommandActionRow = {
  actionId: string;
  attemptId: string;
  attemptNo: number;
  executionId: string;
  publicRequestJson: string;
  requestHash: string;
  sandboxManifestHash: string | null;
  sandboxRoot: string;
  sequence: number;
  toolCallId: string;
};

type StoredCommandResult = {
  authorizationSource: "one_shot" | "standing_policy";
  durationMs: number;
  exitCode: number | null;
  status: DirectProcessResult["status"];
  stderr: Omit<ProcessOutput, "chunks"> & { chunkCount: number };
  stdout: Omit<ProcessOutput, "chunks"> & { chunkCount: number };
};

class BoundedStream {
  private bytes = 0;
  private readonly parts: Buffer[] = [];
  private truncated = false;

  append(value: Buffer | string): void {
    const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const available = Math.max(0, STREAM_LIMIT_BYTES - this.bytes);
    if (available > 0) {
      const retained = buffer.subarray(0, available);
      if (retained.length > 0) {
        this.parts.push(Buffer.from(retained));
        this.bytes += retained.length;
      }
    }
    if (buffer.length > available) this.truncated = true;
  }

  finish(secretValues: string[]): ProcessOutput {
    let text = Buffer.concat(this.parts).toString("utf8");
    text = redactProcessOutput(text, secretValues);
    if (this.truncated) {
      text = fitUtf8(`${text}${TRUNCATION_MARKER}`, STREAM_LIMIT_BYTES);
      if (!text.endsWith(TRUNCATION_MARKER)) {
        const budget = STREAM_LIMIT_BYTES - Buffer.byteLength(TRUNCATION_MARKER);
        text = `${fitUtf8(text, budget)}${TRUNCATION_MARKER}`;
      }
    } else {
      text = fitUtf8(text, STREAM_LIMIT_BYTES);
    }
    const content = Buffer.from(text, "utf8");
    return {
      bytes: content.length,
      chunks: splitUtf8Chunks(text),
      sha256: sha256(content),
      truncated: this.truncated,
    };
  }
}

const systemClock: ProcessRunnerClock = {
  clearInterval(handle) {
    clearInterval(handle as TimerHandle);
  },
  clearTimeout(handle) {
    clearTimeout(handle as TimerHandle);
  },
  now: Date.now,
  setInterval,
  setTimeout,
};

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fitUtf8(value: string, maximumBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) return value;
  let bytes = 0;
  let output = "";
  for (const scalar of value) {
    const scalarBytes = Buffer.byteLength(scalar, "utf8");
    if (bytes + scalarBytes > maximumBytes) break;
    output += scalar;
    bytes += scalarBytes;
  }
  return output;
}

export function splitUtf8Chunks(value: string): ProcessOutputChunk[] {
  const chunks: ProcessOutputChunk[] = [];
  let current = "";
  let currentBytes = 0;
  let offset = 0;
  const flush = () => {
    if (currentBytes === 0) return;
    chunks.push({
      byteLength: currentBytes,
      byteOffset: offset,
      sha256: sha256(current),
      text: current,
    });
    offset += currentBytes;
    current = "";
    currentBytes = 0;
  };
  for (const scalar of value) {
    const scalarBytes = Buffer.byteLength(scalar, "utf8");
    if (currentBytes + scalarBytes > CHUNK_LIMIT_BYTES) flush();
    current += scalar;
    currentBytes += scalarBytes;
  }
  flush();
  return chunks;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function redactProcessOutput(value: string, secretValues: string[] = []): string {
  let redacted = value
    .replace(
      /(\bauthorization\s*:\s*)(?:bearer\s+)?[^\r\n]*/giu,
      `$1${REDACTED_CREDENTIAL}`,
    )
    .replace(
      /(\b(?:api[_-]?key(?:[_-]?(?:cipher|iv|tag))?|access[_-]?token|auth[_-]?token|bearer[_-]?token|client[_-]?secret|cockpit[_-]?master[_-]?key|master[_-]?key|password|passwd|secret|token)\b\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}\r\n]+)/giu,
      `$1${REDACTED_CREDENTIAL}`,
    )
    .replace(/\bbearer\s+[A-Za-z0-9._~+/-]+=*/giu, `Bearer ${REDACTED_CREDENTIAL}`);
  for (const secret of [...new Set(secretValues)].sort((left, right) => right.length - left.length)) {
    if (secret.length < 4) continue;
    redacted = redacted.replace(new RegExp(escapeRegExp(secret), "gu"), REDACTED_CREDENTIAL);
  }
  return redacted;
}

function existingSystemDirectory(value: string | undefined): value is string {
  if (!value || !isAbsolute(value)) return false;
  try {
    accessSync(value, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export function buildMinimalProcessEnvironment(input: {
  platform?: NodeJS.Platform;
  sandboxRoot: string;
  systemEnvironment?: NodeJS.ProcessEnv;
}): Record<string, string> {
  const home = join(input.sandboxRoot, ".cockpit-home");
  const temporary = join(input.sandboxRoot, ".cockpit-tmp");
  const environment: Record<string, string> = {
    CI: "1",
    HOME: home,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    NO_COLOR: "1",
    TEMP: temporary,
    TMP: temporary,
    TMPDIR: temporary,
    USERPROFILE: home,
  };
  if ((input.platform ?? process.platform) === "win32") {
    const source = input.systemEnvironment ?? process.env;
    for (const name of ["SystemRoot", "WINDIR"] as const) {
      if (existingSystemDirectory(source[name])) environment[name] = source[name]!;
    }
  }
  return environment;
}

function resolveWorkdir(sandboxRoot: string, workdir: string): string {
  if (!workdir || isAbsolute(workdir)) {
    throw new Error("Process workdir must be a sandbox-relative directory.");
  }
  const root = resolve(sandboxRoot);
  const cwd = resolve(root, workdir);
  const fromRoot = relative(root, cwd);
  if (fromRoot === ".." || fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error("Process workdir escapes the sandbox.");
  }
  return cwd;
}

function platformSpawnEnvironment(environment: Record<string, string>): Record<string, string> {
  if (process.platform !== "win32") return environment;
  // libuv may supply these process-launch variables from the parent when they are
  // absent. Explicit empty values prevent host command lookup/configuration from
  // becoming visible inside the child while the policy still uses an absolute
  // executable and shell:false.
  return {
    ...environment,
    COMSPEC: "",
    PATH: "",
    PATHEXT: "",
  };
}

function waitForExit(child: ProcessRunnerChild): Promise<{ code: number | null; signal: string | null }> {
  return new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("close", (code: number | null, signal: string | null) => {
      resolvePromise({ code, signal });
    });
  });
}

async function spawnAndWait(
  executable: string,
  args: string[],
  options: Omit<SpawnOptions, "stdio"> & { stdio: "ignore" },
): Promise<number> {
  return await new Promise((resolvePromise) => {
    const child = spawn(
      executable,
      args,
      {
        ...options,
        env: platformSpawnEnvironment(options.env),
      } as unknown as import("node:child_process").SpawnOptions,
    );
    child.once("error", () => resolvePromise(1));
    child.once("exit", (code: number | null) => resolvePromise(code ?? 1));
  });
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export const platformProcessAdapter: ProcessRunnerAdapter = {
  async confirmTreeExited(pid) {
    return !processExists(pid);
  },
  spawn(executable, args, options) {
    return spawn(
      executable,
      args,
      {
        ...options,
        env: platformSpawnEnvironment(options.env),
      } as unknown as import("node:child_process").SpawnOptions,
    ) as unknown as ProcessRunnerChild;
  },
  async terminateTree(pid) {
    if (process.platform === "win32") {
      const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
      if (!systemRoot) return false;
      const helper = join(systemRoot, "System32", "taskkill.exe");
      const exitCode = await spawnAndWait(
        helper,
        ["/PID", String(pid), "/T", "/F"],
        {
          cwd: systemRoot,
          detached: false,
          env: buildMinimalProcessEnvironment({ sandboxRoot: systemRoot }),
          shell: false,
          stdio: "ignore",
          windowsHide: true,
        },
      );
      return exitCode === 0 || !processExists(pid);
    }
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      return !processExists(pid);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // The process group already exited.
    }
    return true;
  },
};

export async function runDirectProcess(input: {
  args: string[];
  authorizationSource: "one_shot" | "standing_policy";
  clock?: ProcessRunnerClock;
  executable: string;
  heartbeat: () => boolean | Promise<boolean>;
  processAdapter?: ProcessRunnerAdapter;
  registerTerminationRequest?: (request: (() => void) | null) => void;
  sandboxRoot: string;
  secretValues?: string[];
  workdir: string;
}): Promise<DirectProcessResult> {
  if (!input.executable || !Array.isArray(input.args) || input.args.some((value) => typeof value !== "string")) {
    throw new Error("Executable and ordered arguments are required.");
  }
  const clock = input.clock ?? systemClock;
  const adapter = input.processAdapter ?? platformProcessAdapter;
  const startedAt = clock.now();
  const stdout = new BoundedStream();
  const stderr = new BoundedStream();
  const child = adapter.spawn(input.executable, [...input.args], {
    cwd: resolveWorkdir(input.sandboxRoot, input.workdir),
    detached: true,
    env: buildMinimalProcessEnvironment({ sandboxRoot: input.sandboxRoot }),
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.on("data", (chunk) => stdout.append(chunk as Buffer));
  child.stderr.on("data", (chunk) => stderr.append(chunk as Buffer));
  const exit = waitForExit(child);
  let stopping: Promise<DirectProcessResult> | null = null;
  let intervalHandle: unknown;
  let timeoutHandle: unknown;

  const result = (
    status: DirectProcessResult["status"],
    exitCode: number | null,
  ): DirectProcessResult => ({
    authorizationSource: input.authorizationSource,
    durationMs: Math.max(0, clock.now() - startedAt),
    exitCode,
    status,
    stderr: stderr.finish(input.secretValues ?? []),
    stdout: stdout.finish(input.secretValues ?? []),
  });

  const stop = (requestedStatus: "lease_lost" | "timed_out"): Promise<DirectProcessResult> => {
    if (stopping) return stopping;
    stopping = (async () => {
      if (!child.pid) return result("termination_unconfirmed", null);
      const terminated = await adapter.terminateTree(child.pid);
      if (!terminated) return result("termination_unconfirmed", null);
      await exit.catch(() => ({ code: null, signal: null }));
      const confirmed = await adapter.confirmTreeExited(child.pid);
      if (!confirmed) return result("termination_unconfirmed", null);
      return result(requestedStatus, null);
    })();
    return stopping;
  };
  input.registerTerminationRequest?.(() => {
    void stop("lease_lost");
  });

  intervalHandle = clock.setInterval(() => {
    void Promise.resolve(input.heartbeat()).then((alive) => {
      if (!alive) void stop("lease_lost");
    }).catch(() => {
      void stop("lease_lost");
    });
  }, HEARTBEAT_MS);
  const deadline = new Promise<DirectProcessResult>((resolvePromise) => {
    timeoutHandle = clock.setTimeout(() => {
      void stop("timed_out").then(resolvePromise);
    }, OVERALL_DEADLINE_MS);
  });

  try {
    return await Promise.race([
      exit.then(async ({ code }) => {
        if (stopping) return stopping;
        if (!child.pid || !await adapter.confirmTreeExited(child.pid)) {
          return result("termination_unconfirmed", null);
        }
        return result("completed", code);
      }),
      deadline,
      new Promise<DirectProcessResult>((resolvePromise) => {
        const observeStop = () => {
          if (stopping) {
            void stopping.then(resolvePromise);
            return;
          }
          setImmediate(observeStop);
        };
        observeStop();
      }),
    ]);
  } finally {
    input.registerTerminationRequest?.(null);
    clock.clearInterval(intervalHandle);
    clock.clearTimeout(timeoutHandle);
  }
}

function storedResult(result: DirectProcessResult): StoredCommandResult {
  const summarize = (stream: ProcessOutput) => ({
    bytes: stream.bytes,
    chunkCount: stream.chunks.length,
    sha256: stream.sha256,
    truncated: stream.truncated,
  });
  return {
    authorizationSource: result.authorizationSource,
    durationMs: result.durationMs,
    exitCode: result.exitCode,
    status: result.status,
    stderr: summarize(result.stderr),
    stdout: summarize(result.stdout),
  };
}

function insertOutputArtifact(
  database: DatabaseSync,
  input: {
    actionId: string;
    attemptId: string;
    executionId: string;
    name: "stderr" | "stdout";
    output: ProcessOutput;
    projectId: string;
  },
): void {
  const artifactId = randomUUID();
  database.prepare(`
    INSERT INTO execution_artifacts (
      id,project_id,execution_id,attempt_id,name,path,content_bytes,sha256,truncated,created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?,
      strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  `).run(
    artifactId,
    input.projectId,
    input.executionId,
    input.attemptId,
    input.name,
    `command/${input.actionId}/${input.name}`,
    input.output.bytes,
    input.output.sha256,
    input.output.truncated ? 1 : 0,
  );
  for (const [index, chunk] of input.output.chunks.entries()) {
    database.prepare(`
      INSERT INTO execution_artifact_chunks (
        artifact_id,chunk_index,byte_offset,byte_length,text,sha256
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      artifactId,
      index,
      chunk.byteOffset,
      chunk.byteLength,
      chunk.text,
      chunk.sha256,
    );
  }
}

function parseStoredCommandRequest(value: string): {
  args: string[];
  executable: string;
  executableIdentity: string | null;
  workdir: string;
} {
  let request: unknown;
  try {
    request = JSON.parse(value);
  } catch {
    throw new Error("Stored command request is invalid.");
  }
  if (
    !request
    || typeof request !== "object"
    || typeof (request as Record<string, unknown>).executable !== "string"
    || !Array.isArray((request as Record<string, unknown>).args)
    || !(request as { args: unknown[] }).args.every((argument) => typeof argument === "string")
    || typeof (request as Record<string, unknown>).workdir !== "string"
    || "stdin" in request
    || "env" in request
    || "shell" in request
  ) {
    throw new Error("Stored command request is invalid.");
  }
  return {
    args: [...(request as { args: string[] }).args],
    executable: (request as { executable: string }).executable,
    executableIdentity: typeof (request as Record<string, unknown>).executableIdentity === "string"
      ? (request as { executableIdentity: string }).executableIdentity
      : null,
    workdir: (request as { workdir: string }).workdir,
  };
}

function finalizeCommandManifestFailure(
  database: DatabaseSync,
  input: {
    leaseToken: string;
    postAction: boolean;
    preHash: string | null;
    projectId: string;
  },
  action: CommandActionRow,
): { affectedRows: 0 | 1; result: null } {
  const body = { error: { code: "SANDBOX_UNVERIFIABLE" } };
  const committed = finalizeExecutionActionWithEffects(database, {
    actionId: action.actionId,
    body,
    effects(currentDatabase) {
      const tool = currentDatabase.prepare(`
        UPDATE execution_tool_calls
        SET status='failed',error_code='SANDBOX_UNVERIFIABLE',
            public_result_json=?,before_sandbox_hash=?,after_sandbox_hash=NULL,
            finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE project_id=? AND id=? AND action_id=? AND status='requested'
      `).run(
        JSON.stringify({ code: "SANDBOX_UNVERIFIABLE" }),
        input.preHash,
        input.projectId,
        action.toolCallId,
        action.actionId,
      );
      const attempt = currentDatabase.prepare(`
        UPDATE execution_attempts
        SET status=?,finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE project_id=? AND id=? AND execution_id=? AND status IN ('ready','acting')
      `).run(
        input.postAction ? "failed" : "interrupted",
        input.projectId,
        action.attemptId,
        action.executionId,
      );
      const execution = currentDatabase.prepare(`
        UPDATE executions
        SET status=?,resume_target=?,reason_code='SANDBOX_UNVERIFIABLE',
            next_event_sequence=next_event_sequence+1,version=version+1,
            updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE project_id=? AND id=? AND status='running'
          AND current_attempt_no=? AND next_event_sequence=?
      `).run(
        input.postAction ? "failed" : "paused",
        input.postAction ? null : "running",
        input.projectId,
        action.executionId,
        action.attemptNo,
        action.sequence,
      );
      if (tool.changes !== 1 || attempt.changes !== 1 || execution.changes !== 1) {
        throw new Error("Manifest refresh failure lost its terminal CAS.");
      }
    },
    httpStatus: 422,
    leaseToken: input.leaseToken,
    projectId: input.projectId,
    result: { code: "SANDBOX_UNVERIFIABLE" },
    status: "failed",
  });
  return { affectedRows: committed.affectedRows, result: null };
}

export async function executeCommandProcessAction(input: {
  actionIndex: number;
  authorizationSource: "one_shot" | "standing_policy";
  clock?: ProcessRunnerClock;
  database: DatabaseSync;
  hooks?: { afterProcess?: () => void | Promise<void> };
  manifestAdapter?: {
    refreshSandboxManifest?(input: {
      sandboxRoot: string;
    }): Promise<{ hash: string }>;
  };
  operationId: string;
  processAdapter?: ProcessRunnerAdapter;
  projectId: string;
  responseBody?: unknown;
  secretValues?: string[];
}): Promise<{ affectedRows: 0 | 1; result: StoredCommandResult | null }> {
  const acquired = acquireExecutionAction(input.database, {
    actionIndex: input.actionIndex,
    operationId: input.operationId,
    projectId: input.projectId,
  });
  if (acquired.affectedRows !== 1 || !acquired.leaseToken) {
    return { affectedRows: 0, result: null };
  }
  const action = input.database.prepare(`
    SELECT a.id AS actionId,a.execution_id AS executionId,a.attempt_id AS attemptId,
           a.request_hash AS requestHash,t.id AS toolCallId,
           t.public_request_json AS publicRequestJson,attempts.sandbox_root AS sandboxRoot,
           attempts.sandbox_manifest_hash AS sandboxManifestHash,
           e.current_attempt_no AS attemptNo,e.next_event_sequence AS sequence
    FROM execution_actions a
    JOIN execution_tool_calls t
      ON t.project_id=a.project_id AND t.action_id=a.id AND t.request_hash=a.request_hash
    JOIN execution_attempts attempts
      ON attempts.project_id=a.project_id AND attempts.execution_id=a.execution_id
     AND attempts.id=a.attempt_id
    JOIN executions e ON e.project_id=a.project_id AND e.id=a.execution_id
    WHERE a.project_id=? AND a.operation_id=? AND a.action_index=?
      AND a.kind='command' AND a.status='running' AND a.lease_token=?
      AND t.type='command' AND t.status='requested'
      AND attempts.status IN ('ready','acting')
      AND e.status='running'
  `).get(
    input.projectId,
    input.operationId,
    input.actionIndex,
    acquired.leaseToken,
  ) as CommandActionRow | undefined;
  if (!action) return { affectedRows: 0, result: null };

  const approval = input.database.prepare(`
    SELECT status,request_hash AS requestHash
    FROM execution_approvals WHERE project_id=? AND tool_call_id=?
  `).get(input.projectId, action.toolCallId) as
    | { requestHash: string; status: string }
    | undefined;
  if (
    (input.authorizationSource === "standing_policy" && approval)
    || (
      input.authorizationSource === "one_shot"
      && (!approval || approval.status !== "approved" || approval.requestHash !== action.requestHash)
    )
  ) {
    throw new Error("Command authorization source is not backed by durable approval state.");
  }

  const request = parseStoredCommandRequest(action.publicRequestJson);
  const refreshManifest = input.manifestAdapter?.refreshSandboxManifest?.bind(
    input.manifestAdapter,
  );
  const manifestAdapter = action.sandboxManifestHash && refreshManifest
    ? refreshManifest
    : null;
  let preManifest: { hash: string } | null = null;
  try {
    preManifest = manifestAdapter
      ? await manifestAdapter({ sandboxRoot: action.sandboxRoot })
      : null;
  } catch {
    return finalizeCommandManifestFailure(input.database, {
      leaseToken: acquired.leaseToken,
      postAction: false,
      preHash: null,
      projectId: input.projectId,
    }, action);
  }
  if (preManifest && preManifest.hash !== action.sandboxManifestHash) {
    return finalizeCommandManifestFailure(input.database, {
      leaseToken: acquired.leaseToken,
      postAction: false,
      preHash: preManifest.hash,
      projectId: input.projectId,
    }, action);
  }
  const processResult = await runDirectProcess({
    args: request.args,
    authorizationSource: input.authorizationSource,
    clock: input.clock,
    executable: request.executable,
    heartbeat: () => heartbeatExecutionAction(input.database, {
      actionId: action.actionId,
      leaseToken: acquired.leaseToken!,
      projectId: input.projectId,
    }).affectedRows === 1,
    processAdapter: input.processAdapter,
    registerTerminationRequest(request) {
      if (request) processTerminationRequests.set(action.actionId, request);
      else processTerminationRequests.delete(action.actionId);
    },
    sandboxRoot: action.sandboxRoot,
    secretValues: input.secretValues,
    workdir: request.workdir,
  });
  let postManifest: { hash: string } | null = null;
  try {
    postManifest = manifestAdapter && processResult.status !== "termination_unconfirmed"
      ? await manifestAdapter({ sandboxRoot: action.sandboxRoot })
      : null;
  } catch {
    return finalizeCommandManifestFailure(input.database, {
      leaseToken: acquired.leaseToken,
      postAction: true,
      preHash: preManifest?.hash ?? null,
      projectId: input.projectId,
    }, action);
  }
  await input.hooks?.afterProcess?.();
  const result = storedResult(processResult);
  const terminationUnconfirmed = processResult.status === "termination_unconfirmed";
  const leaseLost = processResult.status === "lease_lost";
  const toolStatus = terminationUnconfirmed || leaseLost
    ? "interrupted"
    : processResult.status === "completed" && processResult.exitCode === 0
      ? "succeeded"
      : "failed";
  const httpStatus = terminationUnconfirmed ? 500 : 200;
  const committed = finalizeExecutionActionWithEffects(input.database, {
    actionId: action.actionId,
    body: input.responseBody ?? { result },
    effects(database) {
      const updatedTool = database.prepare(`
        UPDATE execution_tool_calls
        SET status=?,public_result_json=?,before_sandbox_hash=?,after_sandbox_hash=?,
            finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE project_id=? AND id=? AND action_id=? AND status='requested'
      `).run(
        toolStatus,
        JSON.stringify(result),
        preManifest?.hash ?? null,
        postManifest?.hash ?? null,
        input.projectId,
        action.toolCallId,
        action.actionId,
      );
      if (updatedTool.changes !== 1) throw new Error("Command tool call changed before commit.");
      const policyEntry = request.executableIdentity
        ? database.prepare(`
            SELECT entry.id,entry.required
            FROM execution_attempts attempt
            JOIN project_validation_policy_entries entry
              ON entry.project_id=attempt.project_id
             AND entry.revision_id=attempt.frozen_policy_revision_id
            WHERE attempt.project_id=? AND attempt.id=? AND attempt.execution_id=?
              AND entry.executable=? AND entry.executable_identity=?
              AND entry.args_json=? AND entry.workdir=?
          `).get(
            input.projectId,
            action.attemptId,
            action.executionId,
            request.executable,
            request.executableIdentity,
            JSON.stringify(request.args),
            request.workdir,
          ) as { id: string; required: number } | undefined
        : undefined;
      if (policyEntry && postManifest && processResult.exitCode !== null) {
        const validationId = randomUUID();
        database.prepare(`
          INSERT INTO execution_validation_results (
            id,project_id,execution_id,attempt_id,policy_revision_id,policy_entry_id,
            tool_call_id,sandbox_manifest_hash,required,exit_code,succeeded,
            stdout_bytes,stderr_bytes,stdout_sha256,stderr_sha256,
            stdout_truncated,stderr_truncated,finished_at
          )
          SELECT ?,?,?,?,frozen_policy_revision_id,?,?,?, ?,?,?, ?,?,?,?, ?,?,
            strftime('%Y-%m-%dT%H:%M:%fZ','now')
          FROM execution_attempts WHERE id=?
        `).run(
          validationId,
          input.projectId,
          action.executionId,
          action.attemptId,
          policyEntry.id,
          action.toolCallId,
          postManifest.hash,
          policyEntry.required,
          processResult.exitCode,
          toolStatus === "succeeded" ? 1 : 0,
          processResult.stdout.bytes,
          processResult.stderr.bytes,
          processResult.stdout.sha256,
          processResult.stderr.sha256,
          processResult.stdout.truncated ? 1 : 0,
          processResult.stderr.truncated ? 1 : 0,
          action.attemptId,
        );
        const insertChunk = database.prepare(`
          INSERT INTO execution_validation_output_chunks (
            validation_id,stream,chunk_index,byte_offset,byte_length,text,sha256
          ) VALUES (?,?,?,?,?,?,?)
        `);
        for (const [stream, output] of [
          ["stdout", processResult.stdout],
          ["stderr", processResult.stderr],
        ] as const) {
          for (const [index, chunk] of output.chunks.entries()) {
            insertChunk.run(
              validationId,
              stream,
              index,
              chunk.byteOffset,
              chunk.byteLength,
              chunk.text,
              chunk.sha256,
            );
          }
        }
      }
      if (preManifest && postManifest) {
        const attempt = database.prepare(`
          UPDATE execution_attempts SET sandbox_manifest_hash=?
          WHERE project_id=? AND id=? AND execution_id=?
            AND status IN ('ready','acting') AND sandbox_manifest_hash=?
        `).run(
          postManifest.hash,
          input.projectId,
          action.attemptId,
          action.executionId,
          preManifest.hash,
        );
        if (attempt.changes !== 1) {
          throw new Error("Sandbox manifest changed before the command result could commit.");
        }
      }
      insertOutputArtifact(database, {
        actionId: action.actionId,
        attemptId: action.attemptId,
        executionId: action.executionId,
        name: "stdout",
        output: processResult.stdout,
        projectId: input.projectId,
      });
      insertOutputArtifact(database, {
        actionId: action.actionId,
        attemptId: action.attemptId,
        executionId: action.executionId,
        name: "stderr",
        output: processResult.stderr,
        projectId: input.projectId,
      });
      if (terminationUnconfirmed) {
        const failedAttempt = database.prepare(`
          UPDATE execution_attempts
          SET status='failed',finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE project_id=? AND id=? AND execution_id=? AND status IN ('ready','acting')
        `).run(input.projectId, action.attemptId, action.executionId);
        const failedExecution = database.prepare(`
          UPDATE executions
          SET status='failed',resume_target=NULL,reason_code='PROCESS_TERMINATION_UNCONFIRMED',
              next_event_sequence=next_event_sequence+1,
              updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),version=version+1
          WHERE project_id=? AND id=? AND status='running'
            AND current_attempt_no=? AND next_event_sequence=?
        `).run(input.projectId, action.executionId, action.attemptNo, action.sequence);
        if (failedAttempt.changes !== 1 || failedExecution.changes !== 1) {
          throw new Error("Unconfirmed process termination could not fail closed.");
        }
      } else {
        const execution = database.prepare(`
          UPDATE executions
          SET next_event_sequence=next_event_sequence+1,
              updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),version=version+1
          WHERE project_id=? AND id=? AND status='running'
            AND current_attempt_no=? AND next_event_sequence=?
        `).run(input.projectId, action.executionId, action.attemptNo, action.sequence);
        if (execution.changes !== 1) throw new Error("Execution changed before command commit.");
      }
      database.prepare(`
        INSERT INTO execution_events (
          id,project_id,execution_id,sequence,attempt_no,type,actor_type,
          actor_id,payload_json,created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'agent', NULL, ?,
          strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      `).run(
        randomUUID(),
        input.projectId,
        action.executionId,
        action.sequence,
        action.attemptNo,
        toolStatus === "succeeded" ? "tool_succeeded" : "tool_failed",
        JSON.stringify({
          authorizationSource: result.authorizationSource,
          durationMs: result.durationMs,
          exitCode: result.exitCode,
          status: result.status,
          stderr: result.stderr,
          stdout: result.stdout,
          toolCallId: action.toolCallId,
          type: "command",
        }),
      );
    },
    httpStatus,
    leaseToken: acquired.leaseToken,
    projectId: input.projectId,
    result,
    status: toolStatus === "succeeded" ? "succeeded" : "failed",
  });
  return committed.affectedRows === 1
    ? { affectedRows: 1, result }
    : { affectedRows: 0, result: null };
}
