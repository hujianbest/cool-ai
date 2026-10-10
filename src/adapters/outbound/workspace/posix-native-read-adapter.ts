import "server-only";

import { closeSync, fstatSync, readSync, realpathSync, lstatSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { WindowsNativeError } from "@/src/modules/safe-execution";
import {
  getPosixNativeKoffiFunctions,
  posixErrno,
  POSIX_NATIVE_CONSTANTS,
  type PosixNativeKoffiFunctions,
} from "@/src/adapters/outbound/workspace/posix-native-koffi";

export type PosixNativeIdentity = {
  fileId: string;
  volumeSerialNumber: string;
};

export type PosixNativeAttributes = {
  directory: boolean;
  reparsePoint: boolean;
  size: number;
};

export type PosixNativeDirectoryEntry = {
  attributes: Pick<PosixNativeAttributes, "directory" | "reparsePoint">;
  identity: PosixNativeIdentity;
  name: string;
  size: number;
};

export type PosixNativeHandle = {
  attributesAtOpen: PosixNativeAttributes;
  closed: boolean;
  canonicalPathAtOpen: string;
  fd: number;
  identityAtOpen: PosixNativeIdentity;
  name: string;
  rootCanonicalPath: string;
};

type ReadAdapterHooks = {
  afterFileOpen?: (name: string) => void;
  afterFileRead?: (name: string) => void;
  beforeRelativeOpen?: (name: string, kind: "directory" | "file") => void;
  maximumReadChunk?: number;
  onReadBytes?: (bytes: Uint8Array) => void;
};

type ReadAdapterOptions = {
  functions?: PosixNativeKoffiFunctions;
  hooks?: ReadAdapterHooks;
};

const DIRECTORY_BUFFER_BYTES = 64 * 1024;
const MAXIMUM_NATIVE_READ = 64 * 1024;

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

function parseDirentBuffer(
  buffer: Buffer,
  used: number,
): Array<{ dtype: number; name: string }> {
  const { direntLayout } = POSIX_NATIVE_CONSTANTS;
  if (!Number.isSafeInteger(used) || used <= 0 || used > buffer.length) {
    fail("getdirentries returned an invalid byte count.");
  }
  const entries: Array<{ dtype: number; name: string }> = [];
  let offset = 0;
  while (offset < used) {
    if (offset + direntLayout.fixedBytes > used) {
      fail("getdirentries returned a truncated record.");
    }
    const reclen = buffer.readUInt16LE(offset + direntLayout.reclenOffset);
    const dtype = buffer.readUInt8(offset + direntLayout.typeOffset);
    const namlen = buffer.readUInt8(offset + direntLayout.namlenOffset);
    if (
      reclen < direntLayout.fixedBytes
      || namlen === 0
      || namlen > direntLayout.maxNameBytes
      || offset + direntLayout.fixedBytes + namlen > used
    ) {
      fail("getdirentries returned an invalid record boundary.");
    }
    const name = buffer.toString(
      "utf8",
      offset + direntLayout.nameOffset,
      offset + direntLayout.nameOffset + namlen,
    );
    if (name.normalize("NFC") !== name || name.includes("\0")) {
      fail("getdirentries returned an invalid name.");
    }
    if (name !== "." && name !== "..") entries.push({ dtype, name });
    offset += reclen;
  }
  return entries;
}

function fstatatEntry(
  functions: PosixNativeKoffiFunctions,
  parentFd: number,
  name: string,
): { attributes: PosixNativeAttributes; identity: PosixNativeIdentity } {
  const { statLayout } = POSIX_NATIVE_CONSTANTS;
  const output = Buffer.alloc(statLayout.statSize);
  const status = functions.fstatat(
    parentFd,
    name,
    output,
    POSIX_NATIVE_CONSTANTS.at.AT_SYMLINK_NOFOLLOW,
  );
  if (status !== 0) {
    fail("fstatat could not resolve a directory entry.");
  }
  const mode = output.readUInt16LE(statLayout.stModeOffset);
  const sizeValue = output.readBigInt64LE(statLayout.stSizeOffset);
  const identity = identityFromStat({
    dev: output.readUInt32LE(statLayout.stDevOffset),
    ino: output.readBigUInt64LE(statLayout.stInoOffset),
  });
  const { S_IFDIR, S_IFLNK, S_IFMT, S_IFREG } = POSIX_NATIVE_CONSTANTS.stat;
  const kind = mode & S_IFMT;
  if (kind === S_IFLNK) {
    return { attributes: { directory: false, reparsePoint: true, size: 0 }, identity };
  }
  const attributes = attributesFromModeAndSize(mode, Number(sizeValue));
  return { attributes, identity };
}

export function createPosixNativeReadAdapter(options: ReadAdapterOptions = {}) {
  const functions = options.functions ?? getPosixNativeKoffiFunctions();
  const hooks = options.hooks ?? {};

  function close(handle: PosixNativeHandle): void {
    requireOpen(handle);
    // closeSync failure leaves ownership uncertain, so never issue a second close.
    handle.closed = true;
    guarded("The native handle close failed.", () => closeSync(handle.fd));
  }

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
    if (!isAbsolute(handle.canonicalPathAtOpen)) {
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
      close(handle);
      throw error;
    }
  }

  function openRootDirectory(rootPath: string): PosixNativeHandle {
    if (!isAbsolute(rootPath)) fail("The native root path must be absolute.");
    const resolved = resolve(rootPath);
    const { open, at } = POSIX_NATIVE_CONSTANTS;
    const fd = guarded("The native root handle could not be opened.", () =>
      functions.openat(
        at.AT_FDCWD,
        resolved,
        open.O_RDONLY | open.O_NOFOLLOW | open.O_DIRECTORY,
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
      const canonical = guarded("The native root canonical path is unavailable.", () =>
        realpathSync(resolved));
      const canonicalStat = guarded(
        "The native root canonical identity is unavailable.",
        () => lstatSync(canonical),
      );
      if (!canonicalStat.isDirectory() || !isAbsolute(canonical)) {
        fail("The native root canonical path is invalid.");
      }
      const canonicalIdentity = identityFromStat(canonicalStat);
      handle.identityAtOpen = identity(handle);
      if (!sameIdentity(canonicalIdentity, handle.identityAtOpen)) {
        fail("The native root canonical path names a different object.");
      }
      handle.canonicalPathAtOpen = canonical;
      handle.rootCanonicalPath = canonical;
      return handle;
    } catch (error) {
      close(handle);
      throw error;
    }
  }

  function openRelative(
    parent: PosixNativeHandle,
    name: string,
    kind: "directory" | "file",
  ): PosixNativeHandle {
    requireOpen(parent);
    validateRelativeName(name);
    guarded("The relative-open verification hook failed.", () =>
      hooks.beforeRelativeOpen?.(name, kind));
    const { open } = POSIX_NATIVE_CONSTANTS;
    const flags = open.O_RDONLY | open.O_NOFOLLOW
      | (kind === "directory" ? open.O_DIRECTORY : open.O_NONBLOCK);
    const fd = guarded(`The relative ${kind} could not be opened.`, () =>
      functions.openat(parent.fd, name, flags));
    if (fd < 0) {
      const absence = classifyAbsence(parent, name);
      if (absence === "symlink") {
        fail(`The relative ${kind} is a symlink or special object.`);
      }
      if (absence === "absent") {
        fail(`The relative ${kind} is missing (best-effort errno ${posixErrno()}).`);
      }
      fail(`The relative ${kind} could not be opened (best-effort errno ${posixErrno()}).`);
    }
    const handle: PosixNativeHandle = {
      attributesAtOpen: { directory: false, reparsePoint: true, size: 0 },
      canonicalPathAtOpen: `${parent.canonicalPathAtOpen}/${name}`,
      closed: false,
      fd,
      identityAtOpen: { fileId: "", volumeSerialNumber: "" },
      name,
      rootCanonicalPath: parent.rootCanonicalPath,
    };
    const finished = guarded(
      `The relative ${kind} failed verification.`,
      () => finishHandle(handle, kind),
    );
    if (kind === "file") {
      guarded("The post-open verification hook failed.", () => hooks.afterFileOpen?.(name));
    }
    return finished;
  }

  function openChildDirectoryNoFollow(
    parent: PosixNativeHandle,
    name: string,
  ): PosixNativeHandle {
    return openRelative(parent, name, "directory");
  }

  function openFileNoFollow(parent: PosixNativeHandle, name: string): PosixNativeHandle {
    return openRelative(parent, name, "file");
  }

  function list(handle: PosixNativeHandle): PosixNativeDirectoryEntry[] {
    requireOpen(handle);
    const currentAttributes = attributes(handle);
    if (!currentAttributes.directory) {
      fail("Only an ordinary directory handle can be listed.");
    }
    const buffer = Buffer.alloc(DIRECTORY_BUFFER_BYTES);
    const basep = Buffer.alloc(8);
    const output: PosixNativeDirectoryEntry[] = [];
    // getdirentries advances a per-fd directory cookie: rewind it so repeated
    // listings of a retained handle see the whole directory (the Windows
    // adapter passes restartScan for the same reason).
    const rewound = guarded("The directory rewind failed.", () =>
      functions.lseek(handle.fd, 0, POSIX_NATIVE_CONSTANTS.whence.SEEK_SET));
    if (rewound !== 0) fail("The directory rewind returned an uncertain result.");
    while (true) {
      const used = guarded("getdirentries failed.", () =>
        functions.getdirentries(handle.fd, buffer, buffer.length, basep));
      if (used === 0) break;
      if (used < 0) fail("getdirentries returned an uncertain result.");
      for (const { dtype, name } of parseDirentBuffer(buffer, used)) {
        const { direntType } = POSIX_NATIVE_CONSTANTS;
        if (dtype === direntType.DT_UNKNOWN) {
          // Resolve the type through the authoritative fstatat below.
        } else if (dtype === direntType.DT_LNK) {
          const entry = fstatatEntry(functions, handle.fd, name);
          if (!entry.attributes.reparsePoint) {
            fail("The directory entry type and its stat disagree.");
          }
          output.push({
            attributes: { directory: false, reparsePoint: true },
            identity: entry.identity,
            name,
            size: 0,
          });
          continue;
        } else if (
          dtype !== direntType.DT_DIR && dtype !== direntType.DT_REG
        ) {
          // FIFOs, devices, sockets and whiteouts are special objects.
          const entry = fstatatEntry(functions, handle.fd, name);
          output.push({
            attributes: { directory: false, reparsePoint: true },
            identity: entry.identity,
            name,
            size: 0,
          });
          continue;
        }
        const entry = fstatatEntry(functions, handle.fd, name);
        if (entry.attributes.reparsePoint) {
          fail("The directory entry type and its stat disagree.");
        }
        if (dtype !== POSIX_NATIVE_CONSTANTS.direntType.DT_UNKNOWN) {
          const expectDirectory = dtype === POSIX_NATIVE_CONSTANTS.direntType.DT_DIR;
          if (entry.attributes.directory !== expectDirectory) {
            fail("The directory entry type and its stat disagree.");
          }
        }
        output.push({
          attributes: {
            directory: entry.attributes.directory,
            reparsePoint: false,
          },
          identity: entry.identity,
          name,
          size: entry.attributes.directory ? 0 : entry.attributes.size,
        });
      }
    }
    return output.sort((left, right) =>
      Buffer.from(left.name, "utf8").compare(Buffer.from(right.name, "utf8")));
  }

  function readFromHandle(handle: PosixNativeHandle, maximumBytes: number): Uint8Array {
    requireOpen(handle);
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
      fail("The maximum read size is invalid.");
    }
    const current = attributes(handle);
    if (current.directory) {
      fail("Only an ordinary file handle can be read.");
    }
    const target = Math.min(current.size, maximumBytes);
    const output = Buffer.alloc(target);
    let offset = 0;
    while (offset < target) {
      const requested = Math.min(
        target - offset,
        MAXIMUM_NATIVE_READ,
        hooks.maximumReadChunk ?? MAXIMUM_NATIVE_READ,
      );
      if (!Number.isSafeInteger(requested) || requested <= 0) {
        fail("The native read chunk size is invalid.");
      }
      const transferred = guarded("The native read failed.", () =>
        readSync(handle.fd, output, offset, requested, null));
      if (!Number.isInteger(transferred) || transferred < 0 || transferred > requested) {
        fail("The native read returned an invalid transfer count.");
      }
      if (transferred === 0) break;
      guarded("The read-observation hook failed.", () =>
        hooks.onReadBytes?.(output.subarray(offset, offset + transferred)));
      offset += transferred;
    }
    guarded("The post-read verification hook failed.", () =>
      hooks.afterFileRead?.(handle.name));
    return output.subarray(0, offset);
  }

  function assertStable(handle: PosixNativeHandle): void {
    requireOpen(handle);
    // macOS has no usable fd-to-path (F_GETPATH is unreliable on current
    // systems), so retained-handle stability is proven at identity level; the
    // canonical path is reconstructed from the verified nofollow chain.
    if (!sameIdentity(handle.identityAtOpen, identity(handle))) {
      fail("A retained native handle changed during the operation.");
    }
  }

  function listedEntry(
    parent: PosixNativeHandle,
    name: string,
  ): PosixNativeDirectoryEntry {
    const entry = list(parent).find((candidate) => candidate.name === name);
    if (!entry || entry.attributes.reparsePoint) {
      fail("The relative entry is missing or symlink-backed.");
    }
    return entry;
  }

  function closeOwned(
    handles: PosixNativeHandle[],
    previous?: unknown,
  ): never | void {
    let failure = previous;
    for (const handle of handles.reverse()) {
      if (handle.closed) continue;
      try {
        close(handle);
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure !== undefined) throw failure;
  }

  function openVerifiedDirectoryChain(
    rootPath: string,
    segments: string[],
    owned: PosixNativeHandle[],
  ): PosixNativeHandle {
    let parent = openRootDirectory(rootPath);
    owned.push(parent);
    for (const segment of segments) {
      const expected = listedEntry(parent, segment);
      if (!expected.attributes.directory) fail("A traversal segment is not a directory.");
      const child = openChildDirectoryNoFollow(parent, segment);
      owned.push(child);
      if (!sameIdentity(expected.identity, child.identityAtOpen)) {
        fail("A directory changed between list and relative open.");
      }
      assertStable(parent);
      parent = child;
    }
    return parent;
  }

  function listVerifiedDirectory(
    rootPath: string,
    segments: string[],
  ): PosixNativeDirectoryEntry[] {
    const owned: PosixNativeHandle[] = [];
    try {
      const directory = openVerifiedDirectoryChain(rootPath, segments, owned);
      const entries = list(directory);
      for (const ancestor of owned) assertStable(ancestor);
      closeOwned(owned);
      return entries;
    } catch (error) {
      closeOwned(owned, error);
      throw error;
    }
  }

  function readVerifiedFile(
    rootPath: string,
    segments: string[],
    maximumBytes: number,
  ): Uint8Array {
    if (segments.length === 0) fail("A file path is required.");
    const owned: PosixNativeHandle[] = [];
    try {
      const parent = openVerifiedDirectoryChain(rootPath, segments.slice(0, -1), owned);
      const name = segments.at(-1)!;
      const expected = listedEntry(parent, name);
      if (expected.attributes.directory) fail("The read target is not a file.");
      const file = openFileNoFollow(parent, name);
      owned.push(file);
      if (!sameIdentity(expected.identity, file.identityAtOpen)) {
        fail("A file changed between list and relative open.");
      }
      assertStable(parent);
      const before = attributes(file);
      const bytes = readFromHandle(file, maximumBytes);
      const after = attributes(file);
      if (
        before.size !== after.size
        || !sameIdentity(file.identityAtOpen, identity(file))
        || bytes.byteLength !== Math.min(before.size, maximumBytes)
      ) {
        fail("The file changed while it was being read.");
      }
      for (const ancestor of owned) assertStable(ancestor);
      closeOwned(owned);
      return bytes;
    } catch (error) {
      closeOwned(owned, error);
      throw error;
    }
  }

  return {
    assertStable,
    attributes,
    close,
    finalPath,
    identity,
    list,
    listVerifiedDirectory,
    openChildDirectoryNoFollow,
    openFileNoFollow,
    openRelative,
    openRootDirectory,
    readFromHandle,
    readVerifiedFile,
  };
}
