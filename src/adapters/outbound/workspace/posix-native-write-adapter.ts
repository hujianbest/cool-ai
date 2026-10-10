import "server-only";

import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  realpathSync,
  readSync,
  writeSync,
} from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { WindowsNativeError, WindowsNativeWriteFailure } from "@/src/modules/safe-execution";
import {
  getPosixNativeKoffiFunctions,
  isPosixSupportedRuntime,
  posixErrno,
  POSIX_NATIVE_CONSTANTS,
  type PosixNativeKoffiFunctions,
} from "@/src/adapters/outbound/workspace/posix-native-koffi";
import type {
  PosixNativeAttributes,
  PosixNativeDirectoryEntry,
  PosixNativeHandle,
  PosixNativeIdentity,
} from "@/src/adapters/outbound/workspace/posix-native-read-adapter";

export { WindowsNativeWriteFailure } from "@/src/modules/safe-execution";

export type PosixNativeMutationStep =
  | "create-temp"
  | "write"
  | "flush-file"
  | "pre-target-open"
  | "pre-parent-check"
  | "rename"
  | "post-target-open"
  | "post-parent-check"
  | "flush-directory"
  | "delete";

export type PosixNativeWriteAdapterOptions = {
  functions?: PosixNativeKoffiFunctions;
  hooks?: {
    afterReplace?: (name: string) => void;
    beforeNativeStep?: (step: PosixNativeMutationStep, name: string) => void;
    beforeReplace?: (name: string) => void;
    maximumWriteChunk?: number;
    onWriteBytes?: (bytes: Uint8Array) => void;
  };
};

export type VerifiedOwnedFileRef = {
  rootKind: "journal" | "canonical";
  relativePath: string[];
  ownerId: string;
  parentIdentity: string;
  fileIdentity: string;
  finalPath: string;
  sha256: string;
  size: number;
};

export type ExpectedCanonicalFile = {
  rootKind: "canonical";
  relativePath: string[];
  exists: boolean;
  parentIdentity: string;
  fileIdentity: string | null;
  sha256: string | null;
  size: number | null;
};

export type NativeMutationResult<T> =
  | { kind: "succeeded"; value: T }
  | { kind: "condition-mismatch"; observed: ExpectedCanonicalFile }
  | { kind: "mutation-uncertain"; phase: string };

export type PosixNativeMergeLifecycleStep =
  | "open-root"
  | "open-parent"
  | "open-file"
  | "identity"
  | "final-path"
  | "read"
  | "create"
  | "write"
  | "flush-file"
  | "rename"
  | "delete"
  | "flush-directory"
  | "close";

export type PosixNativeMergeLifecycleOptions = {
  functions?: PosixNativeKoffiFunctions;
  hooks?: {
    beforeMutation?: (
      operation: "replace" | "delete" | "cleanup",
      name: string,
    ) => void;
    beforeNativeStep?: (step: PosixNativeMergeLifecycleStep, name: string) => void;
    onClose?: (name: string, handle: unknown) => void;
    onWriteBytes?: (bytes: Uint8Array) => void;
  };
};

const FINAL_PATH_CHARACTERS = 32_768;
const MAXIMUM_TRANSFER = 64 * 1024;
const MAXIMUM_FILE_BYTES = 1024 * 1024;

function fail(message: string, cause?: unknown): never {
  throw new WindowsNativeError(message, cause === undefined ? undefined : { cause });
}

function guarded<T>(message: string, action: () => T): T {
  try {
    return action();
  } catch (error) {
    if (error instanceof WindowsNativeError) throw error;
    return fail(message, error);
  }
}

function loadFunctions(options?: { functions?: PosixNativeKoffiFunctions }) {
  if (options?.functions) return options.functions;
  if (!isPosixSupportedRuntime()) {
    fail("The native sandbox adapter requires macOS.");
  }
  return getPosixNativeKoffiFunctions();
}

function identityFromStat(stat: {
  dev: number | bigint;
  ino: number | bigint;
}): PosixNativeIdentity {
  const fileId = BigInt(stat.ino).toString(16).padStart(32, "0");
  if (/^0+$/.test(fileId)) fail("The native handle identity is invalid.");
  return {
    fileId,
    volumeSerialNumber: BigInt(stat.dev).toString(16).padStart(16, "0"),
  };
}

function attributesFromModeAndSize(
  mode: number,
  size: number,
): PosixNativeAttributes {
  const { S_IFDIR, S_IFREG, S_IFMT } = POSIX_NATIVE_CONSTANTS.stat;
  const kind = mode & S_IFMT;
  if (kind !== S_IFDIR && kind !== S_IFREG) {
    fail("The native handle is not an ordinary file or directory.");
  }
  if (!Number.isSafeInteger(size) || size < 0) {
    fail("The native handle size is invalid.");
  }
  return {
    directory: kind === S_IFDIR,
    reparsePoint: false,
    size: kind === S_IFDIR ? 0 : size,
  };
}

function requireOpen(handle: PosixNativeHandle): void {
  if (handle.closed) fail("The native handle is closed.");
}

function sameIdentity(
  left: PosixNativeIdentity,
  right: PosixNativeIdentity,
): boolean {
  return left.fileId === right.fileId
    && left.volumeSerialNumber === right.volumeSerialNumber;
}

function identityKey(identity: PosixNativeIdentity): string {
  return `${identity.volumeSerialNumber}:${identity.fileId}`;
}

function pathInsideRoot(root: string, candidate: string): boolean {
  const normalizedRoot = root.endsWith("/") && root !== "/" ? root.slice(0, -1) : root;
  return candidate === normalizedRoot
    || candidate.startsWith(`${normalizedRoot}/`);
}

function validateRelativeName(name: string): void {
  if (
    name.length === 0
    || name === "."
    || name === ".."
    || name.includes("/")
    || name.includes("\0")
    || name.normalize("NFC") !== name
  ) {
    fail("The native relative name is invalid.");
  }
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function classifyAbsence(
  parent: PosixNativeHandle,
  name: string,
): "absent" | "symlink" | "present" {
  // errno after a failed openat can be clobbered by intermediate JS syscalls,
  // so classify through Node's own lstat on the maintained canonical path.
  try {
    const stat = lstatSync(`${parent.canonicalPathAtOpen}/${name}`);
    if (stat.isSymbolicLink()) return "symlink";
    return "present";
  } catch {
    return "absent";
  }
}

function closeHandle(handle: PosixNativeHandle): void {
  requireOpen(handle);
  handle.closed = true;
  guarded("The native handle close failed.", () => closeSync(handle.fd));
}

function closeOwned(
  handles: PosixNativeHandle[],
  previous?: unknown,
): never | void {
  let failure = previous;
  for (const handle of handles.reverse()) {
    if (handle.closed) continue;
    try {
      closeHandle(handle);
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure !== undefined) throw failure;
}

function createVerifiedWriteCore(functions: PosixNativeKoffiFunctions) {
  const { open: openFlags, at } = POSIX_NATIVE_CONSTANTS;

  function identity(handle: PosixNativeHandle): PosixNativeIdentity {
    requireOpen(handle);
    return guarded("The native handle identity is unavailable.", () =>
      identityFromStat(fstatSync(handle.fd)));
  }

  function attributes(handle: PosixNativeHandle): PosixNativeAttributes {
    requireOpen(handle);
    return guarded("The native handle attributes are unavailable.", () => {
      const stat = fstatSync(handle.fd);
      return attributesFromModeAndSize(stat.mode, stat.size);
    });
  }

  function finalPath(handle: PosixNativeHandle): string {
    requireOpen(handle);
    if (!isAbsolute(handle.canonicalPathAtOpen) || handle.canonicalPathAtOpen.length > FINAL_PATH_CHARACTERS) {
      fail("The native handle final path is invalid.");
    }
    return handle.canonicalPathAtOpen;
  }

  function finishHandle(
    handle: PosixNativeHandle,
    expectedKind: "directory" | "file",
  ): PosixNativeHandle {
    try {
      handle.attributesAtOpen = attributes(handle);
      if (handle.attributesAtOpen.directory !== (expectedKind === "directory")) {
        fail("The relative object is not the expected kind.");
      }
      handle.identityAtOpen = identity(handle);
      if (
        handle.rootCanonicalPath
        && !pathInsideRoot(handle.rootCanonicalPath, handle.canonicalPathAtOpen)
      ) {
        fail("The relative object escaped the verified root.");
      }
      return handle;
    } catch (error) {
      closeHandle(handle);
      throw error;
    }
  }

  function createRootHandle(rootPath: string): PosixNativeHandle {
    if (!isAbsolute(rootPath)) fail("The native root path must be absolute.");
    const resolved = resolve(rootPath);
    const fd = guarded("The native root handle could not be opened.", () =>
      functions.openat(
        at.AT_FDCWD,
        resolved,
        openFlags.O_RDONLY | openFlags.O_NOFOLLOW | openFlags.O_DIRECTORY,
      ));
    if (fd < 0) {
      fail(`The native root handle could not be opened (errno ${posixErrno()}).`);
    }
    const handle: PosixNativeHandle = {
      attributesAtOpen: { directory: false, reparsePoint: true, size: 0 },
      canonicalPathAtOpen: resolved,
      closed: false,
      fd,
      identityAtOpen: { fileId: "", volumeSerialNumber: "" },
      name: "",
      rootCanonicalPath: "",
    };
    try {
      handle.attributesAtOpen = attributes(handle);
      if (!handle.attributesAtOpen.directory) {
        fail("The native root is not an ordinary directory.");
      }
      const canonical = guarded(
        "The native root canonical path is unavailable.",
        () => realpathSync(resolved),
      );
      const canonicalStat = guarded(
        "The native root canonical identity is unavailable.",
        () => lstatSync(canonical),
      );
      if (!canonicalStat.isDirectory()) {
        fail("The native root canonical path is invalid.");
      }
      handle.identityAtOpen = identity(handle);
      if (!sameIdentity(identityFromStat(canonicalStat), handle.identityAtOpen)) {
        fail("The native root canonical path names a different object.");
      }
      handle.canonicalPathAtOpen = canonical;
      handle.rootCanonicalPath = canonical;
      return handle;
    } catch (error) {
      closeHandle(handle);
      throw error;
    }
  }

  function createRelativeHandle(
    parent: PosixNativeHandle,
    name: string,
    kind: "directory" | "file" | "temp",
    allowMissing = false,
  ): PosixNativeHandle | null {
    requireOpen(parent);
    validateRelativeName(name);
    const directory = kind === "directory";
    const temp = kind === "temp";
    const flags = temp
      ? openFlags.O_WRONLY
        | openFlags.O_CREAT
        | openFlags.O_EXCL
        | openFlags.O_NOFOLLOW
      : openFlags.O_RDONLY
        | openFlags.O_NOFOLLOW
        | (directory ? openFlags.O_DIRECTORY : openFlags.O_NONBLOCK);
    const fd = guarded(
      `openat could not ${temp ? "create" : "open"} the relative ${kind}.`,
      () => (temp
        ? functions.openat(parent.fd, name, flags, "int", 0o600)
        : functions.openat(parent.fd, name, flags)),
    );
    if (fd < 0) {
      const absence = classifyAbsence(parent, name);
      if (absence === "symlink") {
        fail(`The relative ${kind} is a symlink or special object.`);
      }
      if (absence === "absent") {
        if (allowMissing) return null;
        fail(`The relative ${kind} is missing (best-effort errno ${posixErrno()}).`);
      }
      fail(
        `openat could not ${temp ? "create" : "open"} the relative ${kind}`
        + ` (best-effort errno ${posixErrno()}).`,
      );
    }
    return finishHandle(
      {
        attributesAtOpen: { directory: false, reparsePoint: true, size: 0 },
        canonicalPathAtOpen: `${parent.canonicalPathAtOpen}/${name}`,
        closed: false,
        fd,
        identityAtOpen: { fileId: "", volumeSerialNumber: "" },
        name,
        rootCanonicalPath: parent.rootCanonicalPath,
      },
      directory ? "directory" : "file",
    );
  }

  function assertStable(handle: PosixNativeHandle): void {
    requireOpen(handle);
    // Identity-level stability; the canonical path is reconstructed from the
    // verified nofollow chain (macOS exposes no reliable fd-to-path).
    if (!sameIdentity(handle.identityAtOpen, identity(handle))) {
      fail("A retained native handle changed during mutation.");
    }
  }

  function renameRelative(
    handle: PosixNativeHandle,
    parent: PosixNativeHandle,
    name: string,
  ): void {
    requireOpen(handle);
    requireOpen(parent);
    validateRelativeName(name);
    const status = guarded("renameat failed.", () =>
      functions.renameat(parent.fd, handle.name, parent.fd, name));
    if (status !== 0) {
      fail(`renameat returned errno ${posixErrno()}.`);
    }
    handle.canonicalPathAtOpen = `${parent.canonicalPathAtOpen}/${name}`;
    handle.name = name;
  }

  function unlinkOwned(handle: PosixNativeHandle, parent: PosixNativeHandle): void {
    requireOpen(handle);
    requireOpen(parent);
    const status = guarded("unlinkat failed.", () =>
      functions.unlinkat(parent.fd, handle.name, 0));
    if (status !== 0) {
      fail(`unlinkat returned errno ${posixErrno()}.`);
    }
  }

  function readFileChunk(handle: PosixNativeHandle, output: Buffer, offset: number, requested: number): number {
    const transferred = guarded("The native read failed.", () =>
      readSync(handle.fd, output, offset, requested, null));
    if (
      !Number.isInteger(transferred)
      || transferred < 0
      || transferred > requested
    ) {
      fail("The native read returned an invalid transfer count.");
    }
    return transferred;
  }

  function writeFileChunk(handle: PosixNativeHandle, chunk: Buffer): number {
    const transferred = guarded("The native write failed.", () =>
      writeSync(handle.fd, chunk));
    if (!Number.isInteger(transferred) || transferred <= 0 || transferred > chunk.byteLength) {
      fail("The native write returned an invalid transfer count.");
    }
    return transferred;
  }

  function flushFile(handle: PosixNativeHandle): void {
    requireOpen(handle);
    guarded("The native file flush was uncertain.", () => fsyncSync(handle.fd));
  }

  function readAll(handle: PosixNativeHandle): Buffer {
    const current = attributes(handle);
    if (current.directory || current.size > MAXIMUM_FILE_BYTES) {
      fail("The mutation target cannot be verified as a bounded ordinary file.");
    }
    const output = Buffer.alloc(current.size);
    let offset = 0;
    while (offset < output.length) {
      const requested = Math.min(output.length - offset, MAXIMUM_TRANSFER);
      const transferred = readFileChunk(handle, output, offset, requested);
      if (transferred === 0) break;
      offset += transferred;
    }
    if (
      attributes(handle).size !== current.size
      || !sameIdentity(handle.identityAtOpen, identity(handle))
    ) {
      fail("The mutation target changed while hashing.");
    }
    return output;
  }

  return {
    assertStable,
    attributes,
    createRelativeHandle,
    createRootHandle,
    finalPath,
    flushFile,
    identity,
    openRootDirectory: createRootHandle,
    readAll,
    readFileChunk,
    renameRelative,
    unlinkOwned,
    writeFileChunk,
  };
}

export function createPosixNativeWriteAdapter(
  options: PosixNativeWriteAdapterOptions = {},
) {
  const functions = loadFunctions({ functions: options.functions });
  const core = createVerifiedWriteCore(functions);
  const hooks = options.hooks ?? {};

  function step(value: PosixNativeMutationStep, name: string): void {
    guarded(`The ${value} fault hook failed.`, () => hooks.beforeNativeStep?.(value, name));
  }

  function openParent(rootPath: string, segments: string[], owned: PosixNativeHandle[]): PosixNativeHandle {
    let parent = core.createRootHandle(rootPath);
    owned.push(parent);
    for (const segment of segments) {
      const child = core.createRelativeHandle(parent, segment, "directory");
      if (child == null) fail("The verified parent is missing.");
      owned.push(child);
      core.assertStable(parent);
      parent = child;
    }
    return parent;
  }

  function openTarget(
    parent: PosixNativeHandle,
    name: string,
    expectedHash: string | null,
    owned: PosixNativeHandle[],
  ): PosixNativeHandle | null {
    const target = core.createRelativeHandle(parent, name, "file", expectedHash === null);
    if (target == null) {
      if (expectedHash !== null) fail("The expected mutation target is missing.");
      return null;
    }
    owned.push(target);
    if (expectedHash === null || digest(core.readAll(target)) !== expectedHash) {
      fail("The mutation target identity or hash did not match.");
    }
    return target;
  }

  function verifyNamedTarget(
    parent: PosixNativeHandle,
    name: string,
    identity: PosixNativeIdentity,
    expectedHash: string,
  ): PosixNativeHandle {
    const current = core.createRelativeHandle(parent, name, "file");
    if (current == null) fail("The mutation target disappeared.");
    try {
      if (
        !sameIdentity(identity, current.identityAtOpen)
        || digest(core.readAll(current)) !== expectedHash
      ) {
        fail("The named mutation target changed.");
      }
      return current;
    } catch (error) {
      closeOwned([current], error);
      throw error;
    }
  }

  function flushDirectory(parent: PosixNativeHandle, name: string): void {
    step("flush-directory", name);
    guarded("The native directory flush was uncertain.", () => fsyncSync(parent.fd));
  }

  function writeVerifiedFile(
    rootPath: string,
    segments: string[],
    bytes: Uint8Array,
    expectedHash: string | null,
  ): { hash: string; identity: PosixNativeIdentity } {
    if (
      segments.length === 0
      || bytes.byteLength > MAXIMUM_FILE_BYTES
      || (expectedHash !== null && !/^[0-9a-f]{64}$/.test(expectedHash))
    ) {
      fail("The write request is invalid.");
    }
    const owned: PosixNativeHandle[] = [];
    let parent: PosixNativeHandle | undefined;
    let temp: PosixNativeHandle | undefined;
    let renamed = false;
    const name = segments.at(-1)!;
    try {
      parent = openParent(rootPath, segments.slice(0, -1), owned);
      step("pre-target-open", name);
      const previous = openTarget(parent, name, expectedHash, owned);
      step("pre-parent-check", name);
      core.assertStable(parent);

      const tempName = `.cool-ai-${randomUUID()}.tmp`;
      step("create-temp", name);
      temp = core.createRelativeHandle(parent, tempName, "temp") ?? undefined;
      if (!temp) fail("The exclusive owned temp was not created.");
      owned.push(temp);
      let offset = 0;
      while (offset < bytes.byteLength) {
        const requested = Math.min(
          bytes.byteLength - offset,
          MAXIMUM_TRANSFER,
          hooks.maximumWriteChunk ?? MAXIMUM_TRANSFER,
        );
        if (!Number.isSafeInteger(requested) || requested <= 0) {
          fail("The native write chunk size is invalid.");
        }
        step("write", name);
        const chunk = Buffer.from(bytes.buffer, bytes.byteOffset + offset, requested);
        const transferred = core.writeFileChunk(temp, chunk);
        guarded("The write-observation hook failed.", () =>
          hooks.onWriteBytes?.(chunk.subarray(0, transferred)));
        offset += transferred;
      }
      step("flush-file", name);
      core.flushFile(temp);
      const writtenHash = digest(bytes);
      if (
        core.attributes(temp).size !== bytes.byteLength
        || !sameIdentity(temp.identityAtOpen, core.identity(temp))
      ) {
        fail("The owned temp size or identity did not match after flush.");
      }

      guarded("The pre-replace race hook failed.", () => hooks.beforeReplace?.(name));
      step("rename", name);
      core.assertStable(parent);
      if (previous) {
        const check = verifyNamedTarget(
          parent,
          name,
          previous.identityAtOpen,
          expectedHash!,
        );
        closeHandle(check);
        closeHandle(previous);
      } else {
        const absent = core.createRelativeHandle(parent, name, "file", true);
        if (absent) {
          closeHandle(absent);
          fail("The create target appeared before atomic rename.");
        }
      }
      core.renameRelative(temp, parent, name);
      renamed = true;
      closeHandle(temp);
      guarded("The post-replace race hook failed.", () => hooks.afterReplace?.(name));

      step("post-target-open", name);
      const result = core.createRelativeHandle(parent, name, "file");
      if (!result) fail("The replaced target could not be reopened.");
      owned.push(result);
      if (
        !sameIdentity(temp.identityAtOpen, result.identityAtOpen)
        || digest(core.readAll(result)) !== writtenHash
      ) {
        fail("The post-replace identity or hash did not match.");
      }
      step("post-parent-check", name);
      core.assertStable(parent);
      flushDirectory(parent, name);
      const output = { hash: writtenHash, identity: result.identityAtOpen };
      closeOwned(owned);
      return output;
    } catch (error) {
      let cleanupConfirmed = true;
      if (temp && !temp.closed && !renamed && parent && !parent.closed) {
        try {
          if (sameIdentity(temp.identityAtOpen, core.identity(temp))) {
            core.unlinkOwned(temp, parent);
          } else {
            cleanupConfirmed = false;
          }
        } catch {
          cleanupConfirmed = false;
        }
      }
      try {
        closeOwned(owned);
      } catch {
        cleanupConfirmed = false;
      }
      throw new WindowsNativeWriteFailure(
        renamed
          ? "post-replace-unverifiable"
          : cleanupConfirmed
            ? "cleanup-confirmed"
            : "cleanup-unconfirmed",
        "The verified native write failed.",
        { cause: error },
      );
    }
  }

  function deleteVerifiedFile(
    rootPath: string,
    segments: string[],
    expectedHash: string,
  ): void {
    if (segments.length === 0 || !/^[0-9a-f]{64}$/.test(expectedHash)) {
      fail("The delete request is invalid.");
    }
    const owned: PosixNativeHandle[] = [];
    const name = segments.at(-1)!;
    try {
      const parent = openParent(rootPath, segments.slice(0, -1), owned);
      step("pre-target-open", name);
      const target = openTarget(parent, name, expectedHash, owned);
      if (!target) fail("The delete target is missing.");
      step("pre-parent-check", name);
      core.assertStable(parent);
      step("delete", name);
      const check = verifyNamedTarget(parent, name, target.identityAtOpen, expectedHash);
      closeHandle(check);
      core.assertStable(parent);
      core.unlinkOwned(target, parent);
      closeHandle(target);
      flushDirectory(parent, name);
      closeOwned(owned);
    } catch (error) {
      closeOwned(owned, error);
      throw error;
    }
  }

  return { deleteVerifiedFile, writeVerifiedFile };
}

class NativeConditionMismatch extends Error {
  constructor(readonly observed: ExpectedCanonicalFile) {
    super("The native mutation condition did not match.");
  }
}

function validSegments(segments: string[]): boolean {
  return segments.length > 0 && segments.every((segment) => {
    try {
      validateRelativeName(segment);
      return true;
    } catch {
      return false;
    }
  });
}

export function createPosixNativeMergeLifecycleAdapter(
  options: PosixNativeMergeLifecycleOptions = {},
) {
  const functions = loadFunctions({ functions: options.functions });
  const core = createVerifiedWriteCore(functions);
  const hooks = options.hooks ?? {};
  let phase = "initialize";

  function step(value: PosixNativeMergeLifecycleStep, name: string): void {
    phase = value;
    guarded(`The ${value} merge lifecycle fault hook failed.`, () =>
      hooks.beforeNativeStep?.(value, name));
  }

  function closeOne(handle: PosixNativeHandle): void {
    if (handle.closed) return;
    phase = "close";
    handle.closed = true;
    let hookFailure: unknown;
    try {
      hooks.beforeNativeStep?.("close", handle.name);
    } catch (error) {
      hookFailure = error;
    }
    guarded("The merge close-observation hook failed.", () =>
      hooks.onClose?.(handle.name, handle));
    guarded("The native merge handle close failed.", () => closeSync(handle.fd));
    if (hookFailure !== undefined) fail("The close merge lifecycle fault hook failed.", hookFailure);
  }

  function closeAll(handles: PosixNativeHandle[], previous?: unknown): void {
    let failure = previous;
    for (const handle of [...handles].reverse()) {
      if (handle.closed) continue;
      try {
        closeOne(handle);
      } catch (error) {
        if (failure === undefined || failure instanceof NativeConditionMismatch) {
          failure = error;
        }
      }
    }
    if (failure !== undefined) throw failure;
  }

  function openParentPath(
    root: string,
    segments: string[],
    owned: PosixNativeHandle[],
    name: string,
  ): PosixNativeHandle {
    step("open-root", name);
    step("identity", name);
    step("final-path", name);
    let parent = core.createRootHandle(root);
    owned.push(parent);
    for (const segment of segments) {
      step("open-parent", segment);
      const child = core.createRelativeHandle(parent, segment, "directory");
      if (!child) fail("The merge parent is missing.");
      owned.push(child);
      step("identity", segment);
      step("final-path", segment);
      core.assertStable(parent);
      parent = child;
    }
    return parent;
  }

  function readFileBytes(handle: PosixNativeHandle): Buffer {
    step("read", handle.name);
    return core.readAll(handle);
  }

  function descriptor(
    rootKind: "journal" | "canonical",
    relativePath: string[],
    ownerId: string,
    parent: PosixNativeHandle,
    file: PosixNativeHandle,
    bytes: Uint8Array,
  ): VerifiedOwnedFileRef {
    step("identity", file.name);
    const fileIdentity = core.identity(file);
    const parentIdentity = core.identity(parent);
    step("final-path", file.name);
    const finalPath = core.finalPath(file);
    if (
      !sameIdentity(file.identityAtOpen, fileIdentity)
      || !sameIdentity(parent.identityAtOpen, parentIdentity)
      || finalPath !== file.canonicalPathAtOpen
    ) {
      fail("The owned merge descriptor changed while it was produced.");
    }
    return {
      rootKind,
      relativePath: [...relativePath],
      ownerId,
      parentIdentity: identityKey(parentIdentity),
      fileIdentity: identityKey(fileIdentity),
      finalPath,
      sha256: digest(bytes),
      size: bytes.byteLength,
    };
  }

  function rootFor(
    roots: { journal: string; canonical: string },
    kind: "journal" | "canonical",
  ): string {
    return kind === "journal" ? roots.journal : roots.canonical;
  }

  function observed(
    parent: PosixNativeHandle,
    relativePath: string[],
    owned: PosixNativeHandle[],
  ): ExpectedCanonicalFile {
    const name = relativePath.at(-1)!;
    step("open-file", name);
    const file = core.createRelativeHandle(parent, name, "file", true);
    const parentIdentity = identityKey(core.identity(parent));
    if (!file) {
      return {
        rootKind: "canonical",
        relativePath: [...relativePath],
        exists: false,
        parentIdentity,
        fileIdentity: null,
        sha256: null,
        size: null,
      };
    }
    owned.push(file);
    const bytes = readFileBytes(file);
    return {
      rootKind: "canonical",
      relativePath: [...relativePath],
      exists: true,
      parentIdentity,
      fileIdentity: identityKey(core.identity(file)),
      sha256: digest(bytes),
      size: bytes.byteLength,
    };
  }

  function sameExpected(
    left: ExpectedCanonicalFile,
    right: ExpectedCanonicalFile,
  ): boolean {
    return left.exists === right.exists
      && left.parentIdentity === right.parentIdentity
      && left.fileIdentity === right.fileIdentity
      && left.sha256 === right.sha256
      && left.size === right.size;
  }

  function mismatch(value: ExpectedCanonicalFile): never {
    throw new NativeConditionMismatch(value);
  }

  function execute<T>(operation: () => T): NativeMutationResult<T> {
    phase = "validate";
    try {
      return { kind: "succeeded", value: operation() };
    } catch (error) {
      if (error instanceof NativeConditionMismatch) {
        return { kind: "condition-mismatch", observed: error.observed };
      }
      return { kind: "mutation-uncertain", phase };
    }
  }

  function validateRef(ref: VerifiedOwnedFileRef): void {
    if (
      !validSegments(ref.relativePath)
      || !ref.ownerId
      || !ref.relativePath.at(-1)!.includes(ref.ownerId)
      || !/^[0-9a-f]+:[0-9a-f]{32}$/.test(ref.parentIdentity)
      || !/^[0-9a-f]+:[0-9a-f]{32}$/.test(ref.fileIdentity)
      || !/^[0-9a-f]{64}$/.test(ref.sha256)
      || !Number.isSafeInteger(ref.size)
      || ref.size < 0
      || !isAbsolute(ref.finalPath)
    ) fail("The owned merge descriptor is invalid.");
  }

  function reopen(
    roots: { journal: string; canonical: string },
    ref: VerifiedOwnedFileRef,
    owned: PosixNativeHandle[],
  ): { bytes: Buffer; file: PosixNativeHandle; parent: PosixNativeHandle } {
    validateRef(ref);
    const name = ref.relativePath.at(-1)!;
    const parent = openParentPath(
      rootFor(roots, ref.rootKind),
      ref.relativePath.slice(0, -1),
      owned,
      name,
    );
    step("open-file", name);
    const file = core.createRelativeHandle(parent, name, "file", true);
    if (!file) {
      return mismatch({
        rootKind: "canonical",
        relativePath: [...ref.relativePath],
        exists: false,
        parentIdentity: identityKey(core.identity(parent)),
        fileIdentity: null,
        sha256: null,
        size: null,
      });
    }
    owned.push(file);
    const bytes = readFileBytes(file);
    const current = descriptor(
      ref.rootKind,
      ref.relativePath,
      ref.ownerId,
      parent,
      file,
      bytes,
    );
    if (
      current.ownerId !== ref.ownerId
      || current.parentIdentity !== ref.parentIdentity
      || current.fileIdentity !== ref.fileIdentity
      || current.finalPath !== ref.finalPath
      || current.sha256 !== ref.sha256
      || current.size !== ref.size
    ) {
      return mismatch({
        rootKind: "canonical",
        relativePath: [...ref.relativePath],
        exists: true,
        parentIdentity: current.parentIdentity,
        fileIdentity: current.fileIdentity,
        sha256: current.sha256,
        size: current.size,
      });
    }
    return { bytes, file, parent };
  }

  function prepareOwnedFile(
    rootKind: "journal" | "canonical",
    root: string,
    parentSegments: string[],
    name: string,
    ownerId: string,
    bytes: Uint8Array,
  ): NativeMutationResult<VerifiedOwnedFileRef> {
    return execute(() => {
      validateRelativeName(name);
      if (
        !validSegments([...parentSegments, name])
        || !ownerId
        || !name.includes(ownerId)
        || bytes.byteLength > MAXIMUM_FILE_BYTES
      ) fail("The owned merge prepare request is invalid.");
      const owned: PosixNativeHandle[] = [];
      try {
        const parent = openParentPath(root, parentSegments, owned, name);
        step("create", name);
        const file = core.createRelativeHandle(parent, name, "temp");
        if (!file) fail("The exclusive owned merge file was not created.");
        owned.push(file);
        let offset = 0;
        while (offset < bytes.byteLength) {
          step("write", name);
          const requested = Math.min(MAXIMUM_TRANSFER, bytes.byteLength - offset);
          const chunk = Buffer.from(bytes.buffer, bytes.byteOffset + offset, requested);
          const transferred = core.writeFileChunk(file, chunk);
          guarded("The merge write-observation hook failed.", () =>
            hooks.onWriteBytes?.(chunk.subarray(0, transferred)));
          offset += transferred;
        }
        step("flush-file", name);
        core.flushFile(file);
        const result = descriptor(
          rootKind,
          [...parentSegments, name],
          ownerId,
          parent,
          file,
          bytes,
        );
        step("flush-directory", name);
        guarded("The owned merge parent flush was uncertain.", () =>
          fsyncSync(parent.fd));
        closeAll(owned);
        return result;
      } catch (error) {
        closeAll(owned, error);
        throw error;
      }
    });
  }

  function reopenOwnedFile(
    roots: { journal: string; canonical: string },
    ref: VerifiedOwnedFileRef,
  ): NativeMutationResult<VerifiedOwnedFileRef> {
    return execute(() => {
      const owned: PosixNativeHandle[] = [];
      try {
        const current = reopen(roots, ref, owned);
        const result = descriptor(
          ref.rootKind,
          ref.relativePath,
          ref.ownerId,
          current.parent,
          current.file,
          current.bytes,
        );
        closeAll(owned);
        return result;
      } catch (error) {
        closeAll(owned, error);
        throw error;
      }
    });
  }

  function prepareCanonicalTempFromOwned(
    roots: { journal: string; canonical: string },
    sourceRef: VerifiedOwnedFileRef,
    targetParentSegments: string[],
    tempName: string,
    ownerId: string,
  ): NativeMutationResult<VerifiedOwnedFileRef> {
    const source = reopenOwnedFile(roots, sourceRef);
    if (source.kind !== "succeeded") return source;
    const owned: PosixNativeHandle[] = [];
    const bytesResult = execute(() => {
      try {
        return reopen(roots, sourceRef, owned).bytes;
      } finally {
        closeAll(owned);
      }
    });
    if (bytesResult.kind !== "succeeded") return bytesResult;
    return prepareOwnedFile(
      "canonical",
      roots.canonical,
      targetParentSegments,
      tempName,
      ownerId,
      bytesResult.value,
    );
  }

  function conditionalReplacePrepared(
    roots: { journal: string; canonical: string },
    expectedTarget: ExpectedCanonicalFile,
    preparedCanonicalTemp: VerifiedOwnedFileRef,
  ): NativeMutationResult<ExpectedCanonicalFile> {
    return execute(() => {
      if (
        expectedTarget.rootKind !== "canonical"
        || preparedCanonicalTemp.rootKind !== "canonical"
        || !validSegments(expectedTarget.relativePath)
        || expectedTarget.relativePath.slice(0, -1).join("\0")
          !== preparedCanonicalTemp.relativePath.slice(0, -1).join("\0")
      ) fail("The conditional replace request is invalid.");
      const owned: PosixNativeHandle[] = [];
      const targetName = expectedTarget.relativePath.at(-1)!;
      try {
        const parent = openParentPath(
          roots.canonical,
          expectedTarget.relativePath.slice(0, -1),
          owned,
          targetName,
        );
        const before = observed(parent, expectedTarget.relativePath, owned);
        if (!sameExpected(before, expectedTarget)) mismatch(before);
        // 预检：prepared temp 必须在替换前仍然可验证（结果在后续 rename 前复读）。
        reopen(roots, preparedCanonicalTemp, owned);
        guarded("The replace race hook failed.", () =>
          hooks.beforeMutation?.("replace", targetName));
        const checked = observed(parent, expectedTarget.relativePath, owned);
        if (!sameExpected(checked, expectedTarget)) mismatch(checked);
        const tempChecked = reopen(roots, preparedCanonicalTemp, owned);
        step("rename", targetName);
        core.renameRelative(tempChecked.file, parent, targetName);
        closeOne(tempChecked.file);
        const post = observed(parent, expectedTarget.relativePath, owned);
        if (
          !post.exists
          || post.fileIdentity !== preparedCanonicalTemp.fileIdentity
          || post.sha256 !== preparedCanonicalTemp.sha256
          || post.size !== preparedCanonicalTemp.size
        ) fail("The conditional replace post-state was uncertain.");
        step("flush-directory", targetName);
        guarded("The conditional replace directory flush was uncertain.", () =>
          fsyncSync(parent.fd));
        closeAll(owned);
        return post;
      } catch (error) {
        closeAll(owned, error);
        throw error;
      }
    });
  }

  function conditionalDelete(
    roots: { journal: string; canonical: string },
    expectedTarget: ExpectedCanonicalFile,
  ): NativeMutationResult<{ deleted: true }> {
    return execute(() => {
      if (!expectedTarget.exists || !validSegments(expectedTarget.relativePath)) {
        fail("The conditional delete request is invalid.");
      }
      const owned: PosixNativeHandle[] = [];
      const name = expectedTarget.relativePath.at(-1)!;
      try {
        const parent = openParentPath(
          roots.canonical,
          expectedTarget.relativePath.slice(0, -1),
          owned,
          name,
        );
        const before = observed(parent, expectedTarget.relativePath, owned);
        if (!sameExpected(before, expectedTarget)) mismatch(before);
        guarded("The delete race hook failed.", () => hooks.beforeMutation?.("delete", name));
        const checked = observed(parent, expectedTarget.relativePath, owned);
        if (!sameExpected(checked, expectedTarget)) mismatch(checked);
        const target = core.createRelativeHandle(parent, name, "file");
        if (!target) mismatch(checked);
        owned.push(target);
        step("delete", name);
        core.unlinkOwned(target, parent);
        closeOne(target);
        step("flush-directory", name);
        guarded("The conditional delete directory flush was uncertain.", () =>
          fsyncSync(parent.fd));
        closeAll(owned);
        return { deleted: true as const };
      } catch (error) {
        closeAll(owned, error);
        throw error;
      }
    });
  }

  function conditionalCleanupOwned(
    roots: { journal: string; canonical: string },
    ref: VerifiedOwnedFileRef,
  ): NativeMutationResult<{ deleted: true }> {
    return execute(() => {
      const owned: PosixNativeHandle[] = [];
      const name = ref.relativePath.at(-1) ?? "";
      try {
        reopen(roots, ref, owned);
        guarded("The cleanup race hook failed.", () => hooks.beforeMutation?.("cleanup", name));
        const checked = reopen(roots, ref, owned);
        step("delete", name);
        core.unlinkOwned(checked.file, checked.parent);
        closeOne(checked.file);
        step("flush-directory", name);
        guarded("The owned cleanup directory flush was uncertain.", () =>
          fsyncSync(checked.parent.fd));
        closeAll(owned);
        return { deleted: true as const };
      } catch (error) {
        closeAll(owned, error);
        throw error;
      }
    });
  }

  return {
    conditionalCleanupOwned,
    conditionalDelete,
    conditionalReplacePrepared,
    prepareCanonicalTempFromOwned,
    prepareOwnedFile,
    reopenOwnedFile,
  };
}
