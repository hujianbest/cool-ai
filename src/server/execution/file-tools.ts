import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  acquireExecutionAction,
  finalizeExecutionActionWithEffects,
} from "@/src/server/execution/execution-actions";
import { validateSandboxRelativePath } from "@/src/server/execution/path-guard";

type EntryKind = "directory" | "file" | "link" | "reparse" | "special";

export type SandboxHandleIdentity = {
  finalPath: string;
  identity: string;
  kind: EntryKind;
  size: number;
};

export type SandboxDirectoryEntry = {
  identity: string;
  name: string;
};

export type SandboxDirectoryHandleAdapter<Handle = unknown> = {
  close(handle: Handle): Promise<void>;
  currentIdentity(handle: Handle): Promise<SandboxHandleIdentity>;
  identity(handle: Handle): Promise<SandboxHandleIdentity>;
  list(handle: Handle): Promise<SandboxDirectoryEntry[]>;
  openChildNoFollow(parent: Handle, name: string): Promise<Handle>;
  openRootDirectory(root: string): Promise<Handle>;
};

export type SandboxFileHandleAdapter<Handle = unknown> =
  SandboxDirectoryHandleAdapter<Handle> & {
    readFromHandle(handle: Handle, maximumBytes: number): Promise<Uint8Array>;
  };

export type SandboxWriteAdapter<Handle = unknown, Previous = unknown> =
  SandboxFileHandleAdapter<Handle> & {
    conditionalAtomicReplace(input: {
      expectedTarget: SandboxHandleIdentity | null;
      name: string;
      ownerId: string;
      parent: Handle;
      tempName: string;
    }): Promise<{
      previous: Previous | null;
      target: Handle;
      targetIdentity: SandboxHandleIdentity;
    } | null>;
    conditionalRemoveOwnedTemp(input: {
      expected: SandboxHandleIdentity;
      name: string;
      ownerId: string;
      parent: Handle;
    }): Promise<boolean>;
    conditionalRollback(input: {
      expectedCurrent: SandboxHandleIdentity;
      name: string;
      parent: Handle;
      previous: Previous | null;
    }): Promise<boolean>;
    createOwnedTemp(
      parent: Handle,
      ownerId: string,
    ): Promise<{ handle: Handle; name: string }>;
    fsyncDirectory(handle: Handle): Promise<boolean>;
    fsyncFile(handle: Handle): Promise<boolean>;
    writeAll(handle: Handle, bytes: Uint8Array): Promise<void>;
  };

export type SandboxNativeWriteAdapter<Handle = unknown> =
  SandboxFileHandleAdapter<Handle> & {
    writeNativeVerifiedFile(input: {
      bytes: Uint8Array;
      expectedHash: string | null;
      pathSegments: string[];
      sandboxRoot: string;
    }): { hash: string };
  };

type SandboxManifestRefresh = {
  refreshSandboxManifest?(input: {
    sandboxRoot: string;
  }): Promise<{
    entries: Array<{ modeTag: string; path: string; sha256: string; size: number }>;
    hash: string;
  }>;
};

type SandboxManifestSnapshot = {
  entries: Array<{ modeTag: string; path: string; sha256: string; size: number }>;
  hash: string;
};

export type SandboxExecutionFileAdapter<Handle = unknown, Previous = unknown> = (
  | SandboxWriteAdapter<Handle, Previous>
  | SandboxNativeWriteAdapter<Handle>
) & SandboxManifestRefresh;

export type PublicListEntry = {
  kind: "directory" | "file";
  name: string;
  size: number;
};

export type PublicListResult = {
  entries: PublicListEntry[];
  path: string;
  totalObserved: number;
  truncated: boolean;
};

export class SandboxListError extends Error {
  constructor(
    public readonly code: "SANDBOX_UNVERIFIABLE" | "SPECIAL_FILE_REJECTED",
    message: string,
  ) {
    super(message);
    this.name = "SandboxListError";
  }
}

type ReadGuardCategory = "credential_redacted";

export type ReadRedactionContext = {
  cipherValues?: string[];
  masterKeyMarker?: string;
  providerApiKey?: string;
};

export type PublicReadResult = {
  bytes: number;
  content: string;
  guardCategory: ReadGuardCategory | null;
  path: string;
  redacted: boolean;
  sha256: string;
};

type PublicReadSummary = Omit<PublicReadResult, "content">;

export class SandboxReadError extends Error {
  constructor(
    public readonly code:
      | "FILE_LIMIT_EXCEEDED"
      | "SANDBOX_UNVERIFIABLE"
      | "SPECIAL_FILE_REJECTED"
      | "TEXT_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "SandboxReadError";
  }
}

export type PublicWriteResult = {
  action: "created" | "replaced";
  afterHash: string;
  beforeHash: string | null;
  bytes: number;
  path: string;
};

export class SandboxWriteError extends Error {
  constructor(
    public readonly code:
      | "FILE_LIMIT_EXCEEDED"
      | "SANDBOX_FILE_CONFLICT"
      | "SANDBOX_UNVERIFIABLE"
      | "SPECIAL_FILE_REJECTED"
      | "TEXT_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "SandboxWriteError";
  }
}

const MAXIMUM_READ_BYTES = 1_048_576;
const MAXIMUM_WRITE_BYTES = 1_048_576;
const REDACTED_CREDENTIAL = "[REDACTED:CREDENTIAL]";
const CREDENTIAL_ASSIGNMENT =
  /(\b(?:api[_-]?key(?:[_-]?cipher)?|access[_-]?token|auth[_-]?token|bearer[_-]?token|client[_-]?secret|cockpit[_-]?master[_-]?key|master[_-]?key|password|passwd|secret|token)\b\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}\r\n]+)/giu;
const AUTHORIZATION_HEADER = /(\bauthorization\s*:\s*)[^\r\n]*/giu;

function unverifiable(message: string): never {
  throw new SandboxListError("SANDBOX_UNVERIFIABLE", message);
}

function readFailure(
  code: SandboxReadError["code"],
  message: string,
): never {
  throw new SandboxReadError(code, message);
}

function writeFailure(
  code: SandboxWriteError["code"],
  message: string,
): never {
  throw new SandboxWriteError(code, message);
}

function sameIdentity(
  left: SandboxHandleIdentity,
  right: SandboxHandleIdentity,
): boolean {
  return left.identity === right.identity
    && left.kind === right.kind
    && left.finalPath === right.finalPath
    && left.size === right.size;
}

function comparablePath(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/\/+$/u, "");
  return process.platform === "win32"
    ? normalized.toLocaleLowerCase("en-US")
    : normalized;
}

function isInsideRoot(path: string, root: string): boolean {
  const child = comparablePath(path);
  const parent = comparablePath(root);
  return child === parent || child.startsWith(`${parent}/`);
}

function assertDirectory(
  identity: SandboxHandleIdentity,
  rootFinalPath: string,
  label: string,
): void {
  if (
    identity.kind !== "directory"
    || !identity.identity
    || !identity.finalPath
    || !isInsideRoot(identity.finalPath, rootFinalPath)
  ) {
    unverifiable(`${label} is not a verified ordinary sandbox directory.`);
  }
}

async function inspectStable<Handle>(
  fs: SandboxDirectoryHandleAdapter<Handle>,
  handle: Handle,
  rootFinalPath: string,
  label: string,
): Promise<SandboxHandleIdentity> {
  const opened = await fs.identity(handle).catch(() => null);
  const current = await fs.currentIdentity(handle).catch(() => null);
  if (
    !opened
    || !current
    || !sameIdentity(opened, current)
    || !opened.identity
    || !opened.finalPath
    || !isInsideRoot(opened.finalPath, rootFinalPath)
  ) {
    return unverifiable(`${label} changed identity during traversal.`);
  }
  return opened;
}

async function closeAll<Handle>(
  fs: SandboxDirectoryHandleAdapter<Handle>,
  handles: Handle[],
): Promise<void> {
  await Promise.allSettled(handles.reverse().map((handle) => fs.close(handle)));
}

function replaceLiteral(text: string, value: string): { changed: boolean; text: string } {
  if (value.length === 0 || !text.includes(value)) return { changed: false, text };
  return {
    changed: true,
    text: text.split(value).join(REDACTED_CREDENTIAL),
  };
}

function redactReadText(
  input: string,
  context: ReadRedactionContext | undefined,
): {
  content: string;
  guardCategory: ReadGuardCategory | null;
  redacted: boolean;
} {
  let content = input;
  let redacted = false;
  const configuredValues = [
    context?.providerApiKey,
    context?.masterKeyMarker,
    ...(context?.cipherValues ?? []),
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  for (const value of configuredValues) {
    const replacement = replaceLiteral(content, value);
    content = replacement.text;
    redacted ||= replacement.changed;
  }

  content = content.replace(AUTHORIZATION_HEADER, (match, prefix: string) => {
    const replacement = `${prefix}${REDACTED_CREDENTIAL}`;
    if (match !== replacement) redacted = true;
    return replacement;
  });
  content = content.replace(CREDENTIAL_ASSIGNMENT, (match, prefix: string) => {
    const replacement = `${prefix}${REDACTED_CREDENTIAL}`;
    if (match !== replacement) redacted = true;
    return replacement;
  });
  return {
    content,
    guardCategory: redacted ? "credential_redacted" : null,
    redacted,
  };
}

function readSummary(result: PublicReadResult): PublicReadSummary {
  return {
    bytes: result.bytes,
    guardCategory: result.guardCategory,
    path: result.path,
    redacted: result.redacted,
    sha256: result.sha256,
  };
}

export async function readVerifiedFile<Handle>(input: {
  fs: SandboxFileHandleAdapter<Handle>;
  path: string;
  redaction?: ReadRedactionContext;
  sandboxRoot: string;
}): Promise<PublicReadResult> {
  const validated = validateSandboxRelativePath(input.path);
  const handles: Handle[] = [];
  try {
    const root = await input.fs.openRootDirectory(input.sandboxRoot).catch(() => null);
    if (!root) return readFailure("SANDBOX_UNVERIFIABLE", "The sandbox root could not be opened.");
    handles.push(root);
    const rootIdentity = await input.fs.identity(root).catch(() => null);
    const rootCurrent = await input.fs.currentIdentity(root).catch(() => null);
    if (
      !rootIdentity
      || !rootCurrent
      || rootIdentity.kind !== "directory"
      || !rootIdentity.identity
      || !rootIdentity.finalPath
      || !sameIdentity(rootIdentity, rootCurrent)
    ) {
      return readFailure(
        "SANDBOX_UNVERIFIABLE",
        "The sandbox root identity is unavailable or unstable.",
      );
    }

    let parent = root;
    for (const segment of validated.segments.slice(0, -1)) {
      const parentBefore = await inspectStable(
        input.fs,
        parent,
        rootIdentity.finalPath,
        "A sandbox ancestor",
      ).catch(() => null);
      const listed = await input.fs.list(parent).catch(() => null);
      const entry = listed?.find((candidate) => candidate.name === segment);
      if (!parentBefore || !entry?.identity) {
        return readFailure("SANDBOX_UNVERIFIABLE", "A requested sandbox ancestor is missing.");
      }
      const child = await input.fs.openChildNoFollow(parent, segment).catch(() => null);
      if (!child) {
        return readFailure(
          "SANDBOX_UNVERIFIABLE",
          "A sandbox ancestor could not be opened without following.",
        );
      }
      handles.push(child);
      const childIdentity = await inspectStable(
        input.fs,
        child,
        rootIdentity.finalPath,
        "A sandbox directory",
      ).catch(() => null);
      const parentAfter = await input.fs.currentIdentity(parent).catch(() => null);
      if (
        !childIdentity
        || childIdentity.identity !== entry.identity
        || childIdentity.kind !== "directory"
        || !parentAfter
        || !sameIdentity(parentBefore, parentAfter)
      ) {
        return readFailure(
          "SANDBOX_UNVERIFIABLE",
          "A sandbox ancestor changed during traversal.",
        );
      }
      parent = child;
    }

    const name = validated.segments.at(-1);
    if (!name) return readFailure("SANDBOX_UNVERIFIABLE", "The requested file is missing.");
    const parentBefore = await inspectStable(
      input.fs,
      parent,
      rootIdentity.finalPath,
      "The file parent",
    ).catch(() => null);
    const listed = await input.fs.list(parent).catch(() => null);
    const entry = listed?.find((candidate) => candidate.name === name);
    if (!parentBefore || !entry?.identity) {
      return readFailure("SANDBOX_UNVERIFIABLE", "The requested file is missing.");
    }
    const file = await input.fs.openChildNoFollow(parent, name).catch(() => null);
    if (!file) {
      return readFailure(
        "SANDBOX_UNVERIFIABLE",
        "The requested file could not be opened without following.",
      );
    }
    handles.push(file);
    const before = await input.fs.identity(file).catch(() => null);
    const current = await input.fs.currentIdentity(file).catch(() => null);
    const parentAfterOpen = await input.fs.currentIdentity(parent).catch(() => null);
    if (
      !before
      || !current
      || !sameIdentity(before, current)
      || before.identity !== entry.identity
      || !before.identity
      || !before.finalPath
      || !isInsideRoot(before.finalPath, rootIdentity.finalPath)
      || !parentAfterOpen
      || !sameIdentity(parentBefore, parentAfterOpen)
    ) {
      return readFailure("SANDBOX_UNVERIFIABLE", "The requested file changed while opening.");
    }
    if (before.kind !== "file") {
      return readFailure("SPECIAL_FILE_REJECTED", "Read accepts only ordinary files.");
    }
    if (!Number.isSafeInteger(before.size) || before.size < 0) {
      return readFailure("SANDBOX_UNVERIFIABLE", "The requested file size is invalid.");
    }
    if (before.size > MAXIMUM_READ_BYTES) {
      return readFailure("FILE_LIMIT_EXCEEDED", "Read accepts at most 1048576 bytes.");
    }

    const bytes = await input.fs.readFromHandle(file, MAXIMUM_READ_BYTES + 1).catch(() => null);
    if (!bytes) {
      return readFailure("SANDBOX_UNVERIFIABLE", "The requested file could not be read.");
    }
    if (bytes.byteLength > MAXIMUM_READ_BYTES) {
      return readFailure("FILE_LIMIT_EXCEEDED", "Read accepts at most 1048576 bytes.");
    }
    const after = await input.fs.currentIdentity(file).catch(() => null);
    if (
      !after
      || !sameIdentity(before, after)
      || bytes.byteLength !== before.size
    ) {
      return readFailure("SANDBOX_UNVERIFIABLE", "The requested file changed during reading.");
    }
    for (const handle of handles.slice(0, -1)) {
      const stable = await inspectStable(
        input.fs,
        handle,
        rootIdentity.finalPath,
        "A sandbox ancestor",
      ).catch(() => null);
      if (!stable) {
        return readFailure("SANDBOX_UNVERIFIABLE", "A sandbox ancestor changed during reading.");
      }
    }

    let decoded: string;
    try {
      decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return readFailure("TEXT_INVALID", "Read accepts only strict UTF-8 text.");
    }
    if (decoded.includes("\0")) {
      return readFailure("TEXT_INVALID", "Read text cannot contain NUL.");
    }
    const redacted = redactReadText(decoded, input.redaction);
    return {
      bytes: bytes.byteLength,
      content: redacted.content,
      guardCategory: redacted.guardCategory,
      path: validated.path,
      redacted: redacted.redacted,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  } finally {
    await closeAll(input.fs, handles);
  }
}

export async function listVerifiedDirectory<Handle>(input: {
  fs: SandboxDirectoryHandleAdapter<Handle>;
  path: string;
  sandboxRoot: string;
}): Promise<PublicListResult> {
  const validated = validateSandboxRelativePath(input.path);
  const handles: Handle[] = [];
  let rootIdentity: SandboxHandleIdentity | null = null;
  try {
    const root = await input.fs.openRootDirectory(input.sandboxRoot).catch(() => null);
    if (!root) return unverifiable("The sandbox root could not be opened.");
    handles.push(root);
    rootIdentity = await input.fs.identity(root).catch(() => null);
    if (
      !rootIdentity
      || rootIdentity.kind !== "directory"
      || !rootIdentity.identity
      || !rootIdentity.finalPath
    ) {
      return unverifiable("The sandbox root identity is unavailable.");
    }
    const rootCurrent = await input.fs.currentIdentity(root).catch(() => null);
    if (!rootCurrent || !sameIdentity(rootIdentity, rootCurrent)) {
      return unverifiable("The sandbox root changed while it was opened.");
    }

    let directory = root;
    for (const segment of validated.segments) {
      const beforeParent = await inspectStable(
        input.fs,
        directory,
        rootIdentity.finalPath,
        "A sandbox ancestor",
      );
      const listed = await input.fs.list(directory).catch(() => null);
      const entry = listed?.find((candidate) => candidate.name === segment);
      if (!entry || !entry.identity) {
        return unverifiable("A requested sandbox directory segment is missing.");
      }
      const child = await input.fs.openChildNoFollow(directory, segment).catch(() => null);
      if (!child) return unverifiable("A sandbox directory could not be opened without following.");
      handles.push(child);
      const childIdentity = await inspectStable(
        input.fs,
        child,
        rootIdentity.finalPath,
        "A sandbox directory",
      );
      if (childIdentity.identity !== entry.identity) {
        return unverifiable("A sandbox directory no longer matches its listed identity.");
      }
      assertDirectory(childIdentity, rootIdentity.finalPath, "A sandbox path segment");
      const afterParent = await input.fs.currentIdentity(directory).catch(() => null);
      if (!afterParent || !sameIdentity(beforeParent, afterParent)) {
        return unverifiable("A sandbox ancestor changed during child open.");
      }
      directory = child;
    }

    const directoryBefore = await inspectStable(
      input.fs,
      directory,
      rootIdentity.finalPath,
      "The listed directory",
    );
    const listed = await input.fs.list(directory).catch(() => null);
    if (!listed) return unverifiable("The directory could not be enumerated.");
    const observed: PublicListEntry[] = [];
    const names = new Set<string>();
    for (const entry of listed) {
      if (
        names.has(entry.name)
        || !entry.identity
        || entry.name.length === 0
        || entry.name === "."
        || entry.name === ".."
        || entry.name.includes("/")
        || entry.name.includes("\\")
      ) {
        return unverifiable("Directory enumeration returned an invalid or duplicate name.");
      }
      names.add(entry.name);
      validateSandboxRelativePath(entry.name);
      const child = await input.fs.openChildNoFollow(directory, entry.name).catch(() => null);
      if (!child) return unverifiable("A listed child could not be opened without following.");
      try {
        const childIdentity = await input.fs.identity(child).catch(() => null);
        const childCurrent = await input.fs.currentIdentity(child).catch(() => null);
        if (!childIdentity || !childCurrent || !sameIdentity(childIdentity, childCurrent)) {
          return unverifiable("A listed child changed while it was opened.");
        }
        if (childIdentity.identity !== entry.identity) {
          return unverifiable("A listed child changed before it was opened.");
        }
        if (childIdentity.kind !== "directory" && childIdentity.kind !== "file") {
          throw new SandboxListError(
            "SPECIAL_FILE_REJECTED",
            "Directory listing accepts only ordinary files and directories.",
          );
        }
        if (
          !childIdentity.finalPath
          || !isInsideRoot(childIdentity.finalPath, rootIdentity.finalPath)
        ) {
          return unverifiable("A listed child escaped the sandbox root.");
        }
        observed.push({
          kind: childIdentity.kind,
          name: entry.name.normalize("NFC"),
          size: childIdentity.kind === "file" ? childIdentity.size : 0,
        });
      } finally {
        await input.fs.close(child).catch(() => undefined);
      }
    }

    const directoryAfter = await input.fs.currentIdentity(directory).catch(() => null);
    if (!directoryAfter || !sameIdentity(directoryBefore, directoryAfter)) {
      return unverifiable("The listed directory changed during enumeration.");
    }
    for (const handle of handles) {
      await inspectStable(input.fs, handle, rootIdentity.finalPath, "A sandbox ancestor");
    }
    observed.sort((left, right) =>
      Buffer.from(left.name, "utf8").compare(Buffer.from(right.name, "utf8")));
    return {
      entries: observed.slice(0, 1000),
      path: validated.path,
      totalObserved: observed.length,
      truncated: observed.length > 1000,
    };
  } finally {
    await closeAll(input.fs, handles);
  }
}

type ActionRow = {
  actionId: string;
  attemptId: string;
  attemptNo: number;
  businessRound: number;
  executionId: string;
  requestHash: string;
  sequence: number;
  startedAt: string;
};

function finalizeUnverifiableToolFailure(input: {
  action: ActionRow;
  database: DatabaseSync;
  hardFailure?: boolean;
  leaseToken: string;
  projectId: string;
  publicRequest: unknown;
  responseBody?: unknown;
  type: "list" | "read" | "write";
}): void {
  const toolCallId = randomUUID();
  const eventId = randomUUID();
  const result = { code: "SANDBOX_UNVERIFIABLE" };
  const committed = finalizeExecutionActionWithEffects(input.database, {
    actionId: input.action.actionId,
    body: input.responseBody ?? { error: result },
    errorCode: "SANDBOX_UNVERIFIABLE",
    effects(database) {
      database.prepare(`
        INSERT INTO execution_tool_calls (
          id,project_id,execution_id,attempt_id,action_id,business_round,type,
          request_hash,status,error_code,public_request_json,public_result_json,
          before_sandbox_hash,after_sandbox_hash,started_at,finished_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'failed', 'SANDBOX_UNVERIFIABLE', ?, ?, NULL, NULL, ?,
          strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      `).run(
        toolCallId,
        input.projectId,
        input.action.executionId,
        input.action.attemptId,
        input.action.actionId,
        Math.max(1, input.action.businessRound),
        input.type,
        input.action.requestHash,
        JSON.stringify(input.publicRequest),
        JSON.stringify(result),
        input.action.startedAt,
      );
      const execution = database.prepare(`
        UPDATE executions
        SET status=?,resume_target=?,reason_code='SANDBOX_UNVERIFIABLE',
            tool_call_count=tool_call_count+1,
            next_event_sequence=next_event_sequence+1,
            updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            version=version+1
        WHERE project_id=? AND id=? AND status='running'
          AND current_attempt_no=? AND next_event_sequence=?
      `).run(
        input.hardFailure ? "failed" : "paused",
        input.hardFailure ? null : "running",
        input.projectId,
        input.action.executionId,
        input.action.attemptNo,
        input.action.sequence,
      );
      if (execution.changes !== 1) {
        throw new Error("Execution changed before the native failure could commit.");
      }
      if (input.hardFailure) {
        database.prepare(`
          UPDATE execution_attempts
          SET status='failed',finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id=? AND status IN ('ready','acting')
        `).run(input.action.attemptId);
      }
      database.prepare(`
        INSERT INTO execution_events (
          id,project_id,execution_id,sequence,attempt_no,type,actor_type,
          actor_id,payload_json,created_at
        ) VALUES (?, ?, ?, ?, ?, 'tool_failed', 'agent', NULL, ?,
          strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      `).run(
        eventId,
        input.projectId,
        input.action.executionId,
        input.action.sequence,
        input.action.attemptNo,
        JSON.stringify({ code: result.code, toolCallId, type: input.type }),
      );
    },
    httpStatus: 422,
    leaseToken: input.leaseToken,
    projectId: input.projectId,
    result,
    status: "failed",
  });
  if (committed.affectedRows !== 1) {
    throw new Error("The native failure could not be durably finalized.");
  }
}

export async function executeListToolAction<Handle>(input: {
  actionIndex: number;
  database: DatabaseSync;
  fs: SandboxDirectoryHandleAdapter<Handle>;
  failureResponseBody?: unknown;
  hooks?: { afterList?: () => void | Promise<void> };
  operationId: string;
  path: string;
  projectId: string;
  responseBody?: unknown;
  sandboxRoot: string;
}): Promise<{ affectedRows: 0 | 1; result: PublicListResult | null }> {
  const validated = validateSandboxRelativePath(input.path);
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
           a.request_hash AS requestHash,a.started_at AS startedAt,
           e.current_attempt_no AS attemptNo,e.business_round_count AS businessRound,
           e.next_event_sequence AS sequence
    FROM execution_actions a
    JOIN executions e ON e.project_id=a.project_id AND e.id=a.execution_id
    WHERE a.project_id=? AND a.operation_id=? AND a.action_index=?
      AND a.kind='file_list' AND a.status='running' AND a.lease_token=?
  `).get(
    input.projectId,
    input.operationId,
    input.actionIndex,
    acquired.leaseToken,
  ) as ActionRow | undefined;
  if (!action) return { affectedRows: 0, result: null };

  let result: PublicListResult;
  try {
    result = await listVerifiedDirectory({
      fs: input.fs,
      path: validated.path,
      sandboxRoot: input.sandboxRoot,
    });
  } catch (error) {
    if ((error as { code?: unknown })?.code === "SANDBOX_UNVERIFIABLE") {
      finalizeUnverifiableToolFailure({
        action,
        database: input.database,
        leaseToken: acquired.leaseToken,
        projectId: input.projectId,
        publicRequest: { path: validated.path, type: "list" },
        responseBody: input.failureResponseBody,
        type: "list",
      });
    }
    throw error;
  }
  await input.hooks?.afterList?.();

  const toolCallId = randomUUID();
  const eventId = randomUUID();
  const publicRequest = JSON.stringify({ path: validated.path, type: "list" });
  const publicResult = JSON.stringify(result);
  const committed = finalizeExecutionActionWithEffects(input.database, {
    actionId: action.actionId,
    body: input.responseBody ?? { result },
    effects(database) {
      database.prepare(`
        INSERT INTO execution_tool_calls (
          id,project_id,execution_id,attempt_id,action_id,business_round,type,
          request_hash,status,public_request_json,public_result_json,
          before_sandbox_hash,after_sandbox_hash,started_at,finished_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'list', ?, 'succeeded', ?, ?, NULL, NULL, ?,
          strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      `).run(
        toolCallId,
        input.projectId,
        action.executionId,
        action.attemptId,
        action.actionId,
        Math.max(1, action.businessRound),
        action.requestHash,
        publicRequest,
        publicResult,
        action.startedAt,
      );
      const execution = database.prepare(`
        UPDATE executions
        SET tool_call_count=tool_call_count+1,
            next_event_sequence=next_event_sequence+1,
            updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            version=version+1
        WHERE project_id=? AND id=? AND status='running'
          AND current_attempt_no=? AND next_event_sequence=?
      `).run(
        input.projectId,
        action.executionId,
        action.attemptNo,
        action.sequence,
      );
      if (execution.changes !== 1) {
        throw new Error("Execution changed before the list result could commit.");
      }
      database.prepare(`
        INSERT INTO execution_events (
          id,project_id,execution_id,sequence,attempt_no,type,actor_type,
          actor_id,payload_json,created_at
        ) VALUES (?, ?, ?, ?, ?, 'tool_succeeded', 'agent', NULL, ?,
          strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      `).run(
        eventId,
        input.projectId,
        action.executionId,
        action.sequence,
        action.attemptNo,
        JSON.stringify({
          afterHash: null,
          beforeHash: null,
          resultSummary: {
            entryCount: result.entries.length,
            path: result.path,
            totalObserved: result.totalObserved,
            truncated: result.truncated,
          },
          toolCallId,
          type: "list",
        }),
      );
    },
    httpStatus: 200,
    leaseToken: acquired.leaseToken,
    projectId: input.projectId,
    result,
    status: "succeeded",
  });
  return {
    affectedRows: committed.affectedRows,
    result: committed.affectedRows === 1 ? result : null,
  };
}

export async function executeReadToolAction<Handle>(input: {
  actionIndex: number;
  database: DatabaseSync;
  fs: SandboxFileHandleAdapter<Handle>;
  failureResponseBody?: unknown;
  hooks?: { afterRead?: () => void | Promise<void> };
  operationId: string;
  path: string;
  projectId: string;
  redaction?: ReadRedactionContext;
  responseBody?: unknown;
  sandboxRoot: string;
}): Promise<{ affectedRows: 0 | 1; result: PublicReadResult | null }> {
  const validated = validateSandboxRelativePath(input.path);
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
           a.request_hash AS requestHash,a.started_at AS startedAt,
           e.current_attempt_no AS attemptNo,e.business_round_count AS businessRound,
           e.next_event_sequence AS sequence
    FROM execution_actions a
    JOIN executions e ON e.project_id=a.project_id AND e.id=a.execution_id
    WHERE a.project_id=? AND a.operation_id=? AND a.action_index=?
      AND a.kind='file_read' AND a.status='running' AND a.lease_token=?
  `).get(
    input.projectId,
    input.operationId,
    input.actionIndex,
    acquired.leaseToken,
  ) as ActionRow | undefined;
  if (!action) return { affectedRows: 0, result: null };

  let result: PublicReadResult;
  try {
    result = await readVerifiedFile({
      fs: input.fs,
      path: validated.path,
      redaction: input.redaction,
      sandboxRoot: input.sandboxRoot,
    });
  } catch (error) {
    if ((error as { code?: unknown })?.code === "SANDBOX_UNVERIFIABLE") {
      finalizeUnverifiableToolFailure({
        action,
        database: input.database,
        leaseToken: acquired.leaseToken,
        projectId: input.projectId,
        publicRequest: { path: validated.path, type: "read" },
        responseBody: input.failureResponseBody,
        type: "read",
      });
    }
    throw error;
  }
  await input.hooks?.afterRead?.();

  const summary = readSummary(result);
  const toolCallId = randomUUID();
  const eventId = randomUUID();
  const publicRequest = JSON.stringify({ path: validated.path, type: "read" });
  const publicResult = JSON.stringify(result);
  if (Buffer.byteLength(publicResult, "utf8") > 2_097_152) {
    throw new SandboxReadError(
      "FILE_LIMIT_EXCEEDED",
      "The redacted read result exceeds its storage boundary.",
    );
  }
  const committed = finalizeExecutionActionWithEffects(input.database, {
    actionId: action.actionId,
    body: input.responseBody ?? { result: summary },
    effects(database) {
      database.prepare(`
        INSERT INTO execution_tool_calls (
          id,project_id,execution_id,attempt_id,action_id,business_round,type,
          request_hash,status,public_request_json,public_result_json,
          before_sandbox_hash,after_sandbox_hash,started_at,finished_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'read', ?, 'succeeded', ?, ?, NULL, NULL, ?,
          strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      `).run(
        toolCallId,
        input.projectId,
        action.executionId,
        action.attemptId,
        action.actionId,
        Math.max(1, action.businessRound),
        action.requestHash,
        publicRequest,
        publicResult,
        action.startedAt,
      );
      const execution = database.prepare(`
        UPDATE executions
        SET tool_call_count=tool_call_count+1,
            next_event_sequence=next_event_sequence+1,
            updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            version=version+1
        WHERE project_id=? AND id=? AND status='running'
          AND current_attempt_no=? AND next_event_sequence=?
      `).run(
        input.projectId,
        action.executionId,
        action.attemptNo,
        action.sequence,
      );
      if (execution.changes !== 1) {
        throw new Error("Execution changed before the read result could commit.");
      }
      database.prepare(`
        INSERT INTO execution_events (
          id,project_id,execution_id,sequence,attempt_no,type,actor_type,
          actor_id,payload_json,created_at
        ) VALUES (?, ?, ?, ?, ?, 'tool_succeeded', 'agent', NULL, ?,
          strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      `).run(
        eventId,
        input.projectId,
        action.executionId,
        action.sequence,
        action.attemptNo,
        JSON.stringify({
          afterHash: null,
          beforeHash: null,
          resultSummary: summary,
          toolCallId,
          type: "read",
        }),
      );
    },
    httpStatus: 200,
    leaseToken: acquired.leaseToken,
    projectId: input.projectId,
    result: summary,
    status: "succeeded",
  });
  return {
    affectedRows: committed.affectedRows,
    result: committed.affectedRows === 1 ? result : null,
  };
}

type ReversibleWriteResult = PublicWriteResult & {
  release(): Promise<void>;
  rollback(): Promise<boolean>;
};

function encodeWriteContent(content: string): Uint8Array {
  if (
    typeof content !== "string"
    || content.includes("\0")
    || /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u.test(content)
  ) {
    return writeFailure("TEXT_INVALID", "Write accepts only valid UTF-8 text without NUL.");
  }
  const bytes = Buffer.from(content, "utf8");
  if (bytes.byteLength > MAXIMUM_WRITE_BYTES) {
    return writeFailure("FILE_LIMIT_EXCEEDED", "Write accepts at most 1048576 UTF-8 bytes.");
  }
  return bytes;
}

function validExpectedHash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

async function verifiedBytes<Handle>(
  fs: SandboxFileHandleAdapter<Handle>,
  handle: Handle,
  expected: SandboxHandleIdentity,
): Promise<{ bytes: Uint8Array; hash: string }> {
  if (expected.kind !== "file") {
    return writeFailure("SPECIAL_FILE_REJECTED", "Write accepts only ordinary target files.");
  }
  if (!Number.isSafeInteger(expected.size) || expected.size < 0) {
    return writeFailure("SANDBOX_UNVERIFIABLE", "A write file has an invalid size.");
  }
  if (expected.size > MAXIMUM_WRITE_BYTES) {
    return writeFailure("FILE_LIMIT_EXCEEDED", "Write accepts at most 1048576-byte files.");
  }
  const bytes = await fs.readFromHandle(handle, MAXIMUM_WRITE_BYTES + 1).catch(() => null);
  const after = await fs.currentIdentity(handle).catch(() => null);
  if (
    !bytes
    || bytes.byteLength > MAXIMUM_WRITE_BYTES
    || bytes.byteLength !== expected.size
    || !after
    || !sameIdentity(expected, after)
  ) {
    return writeFailure("SANDBOX_UNVERIFIABLE", "A write file changed while being verified.");
  }
  return {
    bytes,
    hash: createHash("sha256").update(bytes).digest("hex"),
  };
}

export async function writeVerifiedFile<Handle, Previous>(input: {
  content: string;
  expectedHash: string | null | undefined;
  fs: SandboxWriteAdapter<Handle, Previous>;
  ownerId: string;
  path: string;
  sandboxRoot: string;
}): Promise<ReversibleWriteResult> {
  const validated = validateSandboxRelativePath(input.path);
  const bytes = encodeWriteContent(input.content);
  if (input.expectedHash !== null && !validExpectedHash(input.expectedHash)) {
    return writeFailure(
      "SANDBOX_FILE_CONFLICT",
      "Create requires a null expectation and replace requires a lowercase SHA-256 hash.",
    );
  }

  const handles: Handle[] = [];
  let parent: Handle | null = null;
  let temp: { handle: Handle; name: string } | null = null;
  let tempIdentity: SandboxHandleIdentity | null = null;
  let replacement:
    | { previous: Previous | null; target: Handle; targetIdentity: SandboxHandleIdentity }
    | null = null;
  let released = false;
  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    await closeAll(input.fs, handles);
  };
  const rollback = async (): Promise<boolean> => {
    if (!replacement || !parent) {
      await release();
      return true;
    }
    const restored = await input.fs.conditionalRollback({
      expectedCurrent: replacement.targetIdentity,
      name: validated.segments.at(-1)!,
      parent,
      previous: replacement.previous,
    }).catch(() => false);
    const durable = restored
      ? await input.fs.fsyncDirectory(parent).catch(() => false)
      : false;
    await release();
    return restored && durable;
  };

  try {
    const root = await input.fs.openRootDirectory(input.sandboxRoot).catch(() => null);
    if (!root) return writeFailure("SANDBOX_UNVERIFIABLE", "The sandbox root could not be opened.");
    handles.push(root);
    const rootIdentity = await input.fs.identity(root).catch(() => null);
    const rootCurrent = await input.fs.currentIdentity(root).catch(() => null);
    if (
      !rootIdentity
      || !rootCurrent
      || rootIdentity.kind !== "directory"
      || !rootIdentity.identity
      || !rootIdentity.finalPath
      || !sameIdentity(rootIdentity, rootCurrent)
    ) {
      return writeFailure("SANDBOX_UNVERIFIABLE", "The sandbox root is not stable.");
    }

    let verifiedParent: Handle = root;
    parent = verifiedParent;
    for (const segment of validated.segments.slice(0, -1)) {
      const parentBefore = await inspectStable(
        input.fs,
        verifiedParent,
        rootIdentity.finalPath,
        "A write ancestor",
      ).catch(() => null);
      const listed = await input.fs.list(verifiedParent).catch(() => null);
      const entry = listed?.find((candidate) => candidate.name === segment);
      if (!parentBefore || !entry?.identity) {
        return writeFailure("SANDBOX_UNVERIFIABLE", "A write ancestor is missing.");
      }
      const child: Handle | null = await input.fs.openChildNoFollow(
        verifiedParent,
        segment,
      ).catch(() => null);
      if (!child) {
        return writeFailure("SANDBOX_UNVERIFIABLE", "A write ancestor could not be opened.");
      }
      handles.push(child);
      const childIdentity = await inspectStable(
        input.fs,
        child,
        rootIdentity.finalPath,
        "A write directory",
      ).catch(() => null);
      const parentAfter = await input.fs.currentIdentity(verifiedParent).catch(() => null);
      if (
        !childIdentity
        || childIdentity.kind !== "directory"
        || childIdentity.identity !== entry.identity
        || !parentAfter
        || !sameIdentity(parentBefore, parentAfter)
      ) {
        return writeFailure("SANDBOX_UNVERIFIABLE", "A write ancestor changed during traversal.");
      }
      verifiedParent = child;
      parent = verifiedParent;
    }

    const name = validated.segments.at(-1);
    if (!name) return writeFailure("SANDBOX_UNVERIFIABLE", "The write target is missing.");
    const parentBefore = await inspectStable(
      input.fs,
      verifiedParent,
      rootIdentity.finalPath,
      "The write parent",
    ).catch(() => null);
    const listed = await input.fs.list(verifiedParent).catch(() => null);
    if (!parentBefore || !listed) {
      return writeFailure("SANDBOX_UNVERIFIABLE", "The write parent cannot be verified.");
    }
    const entry = listed.find((candidate) => candidate.name === name);
    let targetIdentity: SandboxHandleIdentity | null = null;
    let beforeHash: string | null = null;
    if (entry) {
      if (!validExpectedHash(input.expectedHash)) {
        return writeFailure("SANDBOX_FILE_CONFLICT", "An existing file requires expectedHash.");
      }
      const target = await input.fs.openChildNoFollow(verifiedParent, name).catch(() => null);
      if (!target) {
        return writeFailure("SANDBOX_FILE_CONFLICT", "The expected target no longer exists.");
      }
      handles.push(target);
      const opened = await input.fs.identity(target).catch(() => null);
      const current = await input.fs.currentIdentity(target).catch(() => null);
      const parentAfterOpen = await input.fs.currentIdentity(verifiedParent).catch(() => null);
      if (
        !opened
        || !current
        || !sameIdentity(opened, current)
        || opened.identity !== entry.identity
        || !opened.finalPath
        || !isInsideRoot(opened.finalPath, rootIdentity.finalPath)
        || !parentAfterOpen
        || !sameIdentity(parentBefore, parentAfterOpen)
      ) {
        return writeFailure("SANDBOX_UNVERIFIABLE", "The write target changed while opening.");
      }
      const verified = await verifiedBytes(input.fs, target, opened);
      if (verified.hash !== input.expectedHash) {
        return writeFailure("SANDBOX_FILE_CONFLICT", "The existing file hash does not match.");
      }
      targetIdentity = opened;
      beforeHash = verified.hash;
    } else if (input.expectedHash !== null) {
      return writeFailure("SANDBOX_FILE_CONFLICT", "A new file requires expectedHash null.");
    }

    temp = await input.fs.createOwnedTemp(verifiedParent, input.ownerId).catch(() => null);
    if (!temp) {
      return writeFailure("SANDBOX_UNVERIFIABLE", "An owned write temp could not be created.");
    }
    handles.push(temp.handle);
    tempIdentity = await input.fs.currentIdentity(temp.handle).catch(() => null);
    if (!tempIdentity || tempIdentity.kind !== "file") {
      return writeFailure("SANDBOX_UNVERIFIABLE", "The owned temp identity is unavailable.");
    }
    await input.fs.writeAll(temp.handle, bytes).catch(() =>
      writeFailure("SANDBOX_UNVERIFIABLE", "The complete temp bytes could not be written."));
    if (!await input.fs.fsyncFile(temp.handle).catch(() => false)) {
      return writeFailure("SANDBOX_UNVERIFIABLE", "The write temp could not be made durable.");
    }
    tempIdentity = await input.fs.currentIdentity(temp.handle).catch(() => null);
    if (!tempIdentity || tempIdentity.kind !== "file" || tempIdentity.size !== bytes.byteLength) {
      return writeFailure("SANDBOX_UNVERIFIABLE", "The durable temp identity is unavailable.");
    }
    const verifiedTemp = await verifiedBytes(input.fs, temp.handle, tempIdentity);
    const afterHash = createHash("sha256").update(bytes).digest("hex");
    if (verifiedTemp.hash !== afterHash) {
      return writeFailure("SANDBOX_UNVERIFIABLE", "The durable temp bytes are incomplete.");
    }
    for (const ancestor of handles.filter((candidate) => candidate !== temp!.handle)) {
      const stable = await inspectStable(
        input.fs,
        ancestor,
        rootIdentity.finalPath,
        "A write ancestor",
      ).catch(() => null);
      if (!stable) {
        return writeFailure("SANDBOX_UNVERIFIABLE", "A write ancestor changed before replace.");
      }
    }

    const moved = await input.fs.conditionalAtomicReplace({
      expectedTarget: targetIdentity,
      name,
      ownerId: input.ownerId,
      parent: verifiedParent,
      tempName: temp.name,
    }).catch(() => null);
    if (!moved) {
      return writeFailure("SANDBOX_FILE_CONFLICT", "The write target changed before replace.");
    }
    replacement = {
      previous: moved.previous,
      target: moved.target,
      targetIdentity: moved.targetIdentity,
    };
    handles.push(moved.target);
    const postOpened = await input.fs.identity(moved.target).catch(() => null);
    const postCurrent = await input.fs.currentIdentity(moved.target).catch(() => null);
    const parentAfterReplace = await input.fs.currentIdentity(verifiedParent).catch(() => null);
    if (
      !postOpened
      || !postCurrent
      || !sameIdentity(postOpened, postCurrent)
      || !sameIdentity(postOpened, moved.targetIdentity)
      || postOpened.kind !== "file"
      || postOpened.size !== bytes.byteLength
      || !postOpened.finalPath
      || !isInsideRoot(postOpened.finalPath, rootIdentity.finalPath)
      || !parentAfterReplace
      || !sameIdentity(parentBefore, parentAfterReplace)
    ) {
      return writeFailure("SANDBOX_UNVERIFIABLE", "The replaced target cannot be verified.");
    }
    const post = await verifiedBytes(input.fs, moved.target, postOpened);
    if (post.hash !== afterHash) {
      return writeFailure("SANDBOX_UNVERIFIABLE", "The replaced target bytes are incomplete.");
    }
    for (const ancestor of handles.filter(
      (candidate) => candidate !== temp!.handle && candidate !== moved.target,
    )) {
      const stable = await inspectStable(
        input.fs,
        ancestor,
        rootIdentity.finalPath,
        "A write ancestor",
      ).catch(() => null);
      if (!stable) {
        return writeFailure("SANDBOX_UNVERIFIABLE", "A write ancestor changed after replace.");
      }
    }
    if (!await input.fs.fsyncDirectory(verifiedParent).catch(() => false)) {
      return writeFailure(
        "SANDBOX_UNVERIFIABLE",
        "The adapter cannot prove directory durability for the write.",
      );
    }
    return {
      action: targetIdentity ? "replaced" : "created",
      afterHash,
      beforeHash,
      bytes: bytes.byteLength,
      path: validated.path,
      release,
      rollback,
    };
  } catch (error) {
    if (replacement && !await rollback()) {
      throw new SandboxWriteError(
        "SANDBOX_UNVERIFIABLE",
        "The failed write could not be conditionally rolled back.",
      );
    }
    if (error instanceof SandboxWriteError) throw error;
    throw error;
  } finally {
    if (!replacement && temp && tempIdentity && parent) {
      await input.fs.conditionalRemoveOwnedTemp({
        expected: tempIdentity,
        name: temp.name,
        ownerId: input.ownerId,
        parent,
      }).catch(() => false);
    }
    if (!replacement) await release();
  }
}

export async function executeWriteToolAction<Handle, Previous>(input: {
  actionIndex: number;
  content: string;
  database: DatabaseSync;
  expectedHash: string | null | undefined;
  fs: SandboxExecutionFileAdapter<Handle, Previous>;
  failureResponseBody?: unknown;
  hardFailureResponseBody?: unknown;
  hooks?: { afterWrite?: () => void | Promise<void> };
  operationId: string;
  path: string;
  projectId: string;
  responseBody?: unknown;
  sandboxRoot: string;
}): Promise<{ affectedRows: 0 | 1; result: PublicWriteResult | null }> {
  const validated = validateSandboxRelativePath(input.path);
  const permission = input.database.prepare(`
    SELECT agents.can_write AS canWrite
    FROM execution_actions actions
    JOIN executions executions
      ON executions.project_id=actions.project_id AND executions.id=actions.execution_id
    JOIN agents ON agents.id=executions.agent_id
    WHERE actions.project_id=? AND actions.operation_id=? AND actions.action_index=?
      AND actions.kind='file_write'
  `).get(input.projectId, input.operationId, input.actionIndex) as
    | { canWrite: number }
    | undefined;
  if (permission?.canWrite !== 1) {
    const { ExecutionError } = await import("@/src/server/execution/execution-service");
    throw new ExecutionError(
      "AGENT_WRITE_FORBIDDEN",
      403,
      "The assigned Agent does not have write permission.",
    );
  }

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
           a.request_hash AS requestHash,a.started_at AS startedAt,
           e.current_attempt_no AS attemptNo,e.business_round_count AS businessRound,
           e.next_event_sequence AS sequence
    FROM execution_actions a
    JOIN executions e ON e.project_id=a.project_id AND e.id=a.execution_id
    WHERE a.project_id=? AND a.operation_id=? AND a.action_index=?
      AND a.kind='file_write' AND a.status='running' AND a.lease_token=?
  `).get(
    input.projectId,
    input.operationId,
    input.actionIndex,
    acquired.leaseToken,
  ) as ActionRow | undefined;
  if (!action) return { affectedRows: 0, result: null };

  let written: ReversibleWriteResult;
  let preManifest: SandboxManifestSnapshot | null = null;
  let postManifest: SandboxManifestSnapshot | null = null;
  try {
    if (input.fs.refreshSandboxManifest) {
      preManifest = await input.fs.refreshSandboxManifest({ sandboxRoot: input.sandboxRoot });
      const current = input.database.prepare(`
        SELECT sandbox_manifest_hash AS hash,status
        FROM execution_attempts
        WHERE project_id=? AND id=? AND execution_id=?
      `).get(input.projectId, action.attemptId, action.executionId) as
        | { hash: string | null; status: string }
        | undefined;
      if (
        !current
        || !["ready", "acting"].includes(current.status)
        || current.hash !== preManifest.hash
      ) {
        throw new SandboxWriteError(
          "SANDBOX_UNVERIFIABLE",
          "The verified sandbox manifest changed before write.",
        );
      }
    }
    written = "writeNativeVerifiedFile" in input.fs
      ? (() => {
        const bytes = encodeWriteContent(input.content);
        if (input.expectedHash !== null && !validExpectedHash(input.expectedHash)) {
          return writeFailure(
            "SANDBOX_FILE_CONFLICT",
            "Create requires a null expectation and replace requires a lowercase SHA-256 hash.",
          );
        }
        const native = input.fs.writeNativeVerifiedFile({
          bytes,
          expectedHash: input.expectedHash,
          pathSegments: validated.segments,
          sandboxRoot: input.sandboxRoot,
        });
        const afterHash = createHash("sha256").update(bytes).digest("hex");
        if (native.hash !== afterHash) {
          return writeFailure("SANDBOX_UNVERIFIABLE", "The native write hash is unverifiable.");
        }
        return {
          action: input.expectedHash === null ? "created" : "replaced",
          afterHash,
          beforeHash: input.expectedHash,
          bytes: bytes.byteLength,
          path: validated.path,
          async release() {},
          async rollback() {
            return false;
          },
        };
        })()
      : await writeVerifiedFile({
          content: input.content,
          expectedHash: input.expectedHash,
          fs: input.fs,
          ownerId: action.actionId,
          path: validated.path,
          sandboxRoot: input.sandboxRoot,
        });
    if (input.fs.refreshSandboxManifest) {
      postManifest = await input.fs.refreshSandboxManifest({ sandboxRoot: input.sandboxRoot });
    }
  } catch (error) {
    if ((error as { code?: unknown })?.code === "SANDBOX_UNVERIFIABLE") {
      const mutationState = (error as { mutationState?: unknown }).mutationState;
      finalizeUnverifiableToolFailure({
        action,
        database: input.database,
        hardFailure: mutationState === "post-replace-unverifiable"
          || mutationState === "cleanup-unconfirmed",
        leaseToken: acquired.leaseToken,
        projectId: input.projectId,
        publicRequest: {
          expectedHash: input.expectedHash,
          path: validated.path,
          type: "write",
        },
        responseBody: mutationState === "post-replace-unverifiable"
          || mutationState === "cleanup-unconfirmed"
          ? input.hardFailureResponseBody
          : input.failureResponseBody,
        type: "write",
      });
    }
    throw error;
  }
  const result: PublicWriteResult = {
    action: written.action,
    afterHash: written.afterHash,
    beforeHash: written.beforeHash,
    bytes: written.bytes,
    path: written.path,
  };
  try {
    await input.hooks?.afterWrite?.();
    const toolCallId = randomUUID();
    const eventId = randomUUID();
    const publicRequest = JSON.stringify({
      expectedHash: input.expectedHash,
      path: validated.path,
      type: "write",
    });
    const publicResult = JSON.stringify(result);
    const committed = finalizeExecutionActionWithEffects(input.database, {
      actionId: action.actionId,
      body: input.responseBody ?? { result },
      effects(database) {
        const stillAllowed = database.prepare(`
          SELECT 1
          FROM executions JOIN agents ON agents.id=executions.agent_id
          WHERE executions.project_id=? AND executions.id=? AND agents.can_write=1
        `).get(input.projectId, action.executionId);
        if (!stillAllowed) throw new Error("Agent write permission changed before commit.");
        database.prepare(`
          INSERT INTO execution_tool_calls (
            id,project_id,execution_id,attempt_id,action_id,business_round,type,
            request_hash,status,public_request_json,public_result_json,
            before_sandbox_hash,after_sandbox_hash,started_at,finished_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'write', ?, 'succeeded', ?, ?, ?, ?, ?,
            strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        `).run(
          toolCallId,
          input.projectId,
          action.executionId,
          action.attemptId,
          action.actionId,
          Math.max(1, action.businessRound),
          action.requestHash,
          publicRequest,
          publicResult,
          preManifest?.hash ?? result.beforeHash,
          postManifest?.hash ?? result.afterHash,
          action.startedAt,
        );
        if (preManifest && postManifest) {
          const attempt = database.prepare(`
            UPDATE execution_attempts
            SET sandbox_manifest_hash=?
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
            throw new Error("Sandbox manifest changed before the write result could commit.");
          }
        }
        const execution = database.prepare(`
          UPDATE executions
          SET tool_call_count=tool_call_count+1,
              next_event_sequence=next_event_sequence+1,
              updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
              version=version+1
          WHERE project_id=? AND id=? AND status='running'
            AND current_attempt_no=? AND next_event_sequence=?
        `).run(
          input.projectId,
          action.executionId,
          action.attemptNo,
          action.sequence,
        );
        if (execution.changes !== 1) {
          throw new Error("Execution changed before the write result could commit.");
        }
        database.prepare(`
          INSERT INTO execution_events (
            id,project_id,execution_id,sequence,attempt_no,type,actor_type,
            actor_id,payload_json,created_at
          ) VALUES (?, ?, ?, ?, ?, 'tool_succeeded', 'agent', NULL, ?,
            strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        `).run(
          eventId,
          input.projectId,
          action.executionId,
          action.sequence,
          action.attemptNo,
          JSON.stringify({
            afterHash: result.afterHash,
            beforeHash: result.beforeHash,
            resultSummary: result,
            toolCallId,
            type: "write",
          }),
        );
      },
      httpStatus: 200,
      leaseToken: acquired.leaseToken,
      projectId: input.projectId,
      result,
      status: "succeeded",
    });
    if (committed.affectedRows !== 1) {
      if (!await written.rollback()) {
        throw new SandboxWriteError(
          "SANDBOX_UNVERIFIABLE",
          "A late write result could not be conditionally rolled back.",
        );
      }
      return { affectedRows: 0, result: null };
    }
    await written.release();
    return { affectedRows: 1, result };
  } catch (error) {
    if (!await written.rollback()) {
      throw new SandboxWriteError(
        "SANDBOX_UNVERIFIABLE",
        "A failed write could not be conditionally rolled back.",
      );
    }
    throw error;
  }
}
