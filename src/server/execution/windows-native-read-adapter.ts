import "server-only";

import { isAbsolute, resolve } from "node:path";

import * as koffi from "koffi";

import {
  WINDOWS_NATIVE_ABI,
  WINDOWS_NATIVE_CONSTANTS,
  WindowsNativeError,
} from "@/src/server/execution/windows-native-loader";

type NativeIdentity = {
  fileId: string;
  volumeSerialNumber: string;
};

type NativeAttributes = {
  directory: boolean;
  reparsePoint: boolean;
  size: number;
};

export type WindowsNativeDirectoryEntry = {
  attributes: Pick<NativeAttributes, "directory" | "reparsePoint">;
  identity: NativeIdentity;
  name: string;
  size: number;
};

type NativeHandle = {
  attributesAtOpen: NativeAttributes;
  closed: boolean;
  finalPathAtOpen: string;
  identityAtOpen: NativeIdentity;
  name: string;
  native: unknown;
  rootFinalPath: string;
};

type ReadAdapterHooks = {
  afterFileOpen?: (name: string) => void;
  afterFileRead?: (name: string) => void;
  beforeRelativeOpen?: (name: string, kind: "directory" | "file") => void;
  corruptDirectoryBuffer?: (buffer: Buffer, used: number) => void;
  maximumReadChunk?: number;
  onReadBytes?: (bytes: Uint8Array) => void;
};

type ReadAdapterOptions = {
  hooks?: ReadAdapterHooks;
};

type KoffiLibrary = {
  func(
    convention: string,
    name: string,
    result: string,
    parameters: unknown[],
  ): (...args: unknown[]) => unknown;
};

type NativeFunctions = {
  closeHandle(handle: unknown): boolean;
  createFileW(
    path: string,
    access: number,
    share: number,
    security: null,
    disposition: number,
    flags: number,
    template: null,
  ): unknown;
  getFileInformationByHandleEx(
    handle: unknown,
    infoClass: number,
    output: Buffer,
    outputSize: number,
  ): boolean;
  getFinalPathNameByHandleW(
    handle: unknown,
    output: Buffer,
    outputCharacters: number,
    flags: number,
  ): number;
  ntCreateFile(
    outputHandle: unknown[],
    access: number,
    objectAttributes: Record<string, unknown>,
    ioStatus: Record<string, unknown>,
    allocationSize: null,
    fileAttributes: number,
    share: number,
    disposition: number,
    options: number,
    eaBuffer: null,
    eaLength: number,
  ): number;
  ntQueryDirectoryFile(
    handle: unknown,
    event: null,
    apcRoutine: null,
    apcContext: null,
    ioStatus: Record<string, unknown>,
    output: Buffer,
    outputLength: number,
    infoClass: number,
    returnSingleEntry: boolean,
    fileName: null,
    restartScan: boolean,
  ): number;
  readFile(
    handle: unknown,
    output: Buffer,
    requested: number,
    bytesRead: number[],
    overlapped: null,
  ): boolean;
};

const FILE_ATTRIBUTE_DIRECTORY = 0x00000010;
const FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;
const INVALID_HANDLE_VALUE = 0xffffffffffffffffn;
const STATUS_NO_MORE_FILES = -2147483642;
const DIRECTORY_BUFFER_BYTES = 64 * 1024;
const FINAL_PATH_CHARACTERS = 32_768;
const DIRECTORY_FIXED_BYTES = 104;
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

function bind(
  library: KoffiLibrary,
  name: string,
  result: string,
  parameters: unknown[],
): (...args: unknown[]) => unknown {
  return library.func("__stdcall", name, result, parameters);
}

function loadFunctions(): NativeFunctions {
  if (process.platform !== "win32" || process.arch !== "x64") {
    fail("The native read adapter requires Windows x64.");
  }

  const unicodeString = koffi.struct(null, {
    Length: "uint16_t",
    MaximumLength: "uint16_t",
    Buffer: "void *",
  });
  const objectAttributes = koffi.struct(null, {
    Length: "uint32_t",
    RootDirectory: "void *",
    ObjectName: koffi.pointer(unicodeString),
    Attributes: "uint32_t",
    SecurityDescriptor: "void *",
    SecurityQualityOfService: "void *",
  });
  const ioStatusBlock = koffi.struct(null, {
    StatusOrPointer: "uintptr_t",
    Information: "uintptr_t",
  });
  if (
    koffi.sizeof(unicodeString) !== WINDOWS_NATIVE_ABI.structs.UNICODE_STRING.size
    || koffi.sizeof(objectAttributes) !== WINDOWS_NATIVE_ABI.structs.OBJECT_ATTRIBUTES.size
    || koffi.sizeof(ioStatusBlock) !== WINDOWS_NATIVE_ABI.structs.IO_STATUS_BLOCK.size
  ) {
    fail("The native read adapter ABI is unavailable.");
  }

  const kernel32 = koffi.load("kernel32.dll") as KoffiLibrary;
  const ntdll = koffi.load("ntdll.dll") as KoffiLibrary;
  return {
    closeHandle: bind(kernel32, "CloseHandle", "bool", ["void *"]) as NativeFunctions["closeHandle"],
    createFileW: bind(kernel32, "CreateFileW", "void *", [
      "str16", "uint32_t", "uint32_t", "void *", "uint32_t", "uint32_t", "void *",
    ]) as NativeFunctions["createFileW"],
    getFileInformationByHandleEx: bind(
      kernel32,
      "GetFileInformationByHandleEx",
      "bool",
      ["void *", "int32_t", "void *", "uint32_t"],
    ) as NativeFunctions["getFileInformationByHandleEx"],
    getFinalPathNameByHandleW: bind(
      kernel32,
      "GetFinalPathNameByHandleW",
      "uint32_t",
      ["void *", "void *", "uint32_t", "uint32_t"],
    ) as NativeFunctions["getFinalPathNameByHandleW"],
    ntCreateFile: bind(ntdll, "NtCreateFile", "int32_t", [
      koffi.out(koffi.pointer("void *")),
      "uint32_t",
      koffi.pointer(objectAttributes),
      koffi.inout(koffi.pointer(ioStatusBlock)),
      "void *",
      "uint32_t",
      "uint32_t",
      "uint32_t",
      "uint32_t",
      "void *",
      "uint32_t",
    ]) as NativeFunctions["ntCreateFile"],
    ntQueryDirectoryFile: bind(ntdll, "NtQueryDirectoryFile", "int32_t", [
      "void *",
      "void *",
      "void *",
      "void *",
      koffi.inout(koffi.pointer(ioStatusBlock)),
      "void *",
      "uint32_t",
      "uint32_t",
      "bool",
      "void *",
      "bool",
    ]) as NativeFunctions["ntQueryDirectoryFile"],
    readFile: bind(kernel32, "ReadFile", "bool", [
      "void *", "void *", "uint32_t", koffi.out(koffi.pointer("uint32_t")), "void *",
    ]) as NativeFunctions["readFile"],
  };
}

function requireOpen(handle: NativeHandle): void {
  if (handle.closed) fail("The native handle is closed.");
}

function identityOf(functions: NativeFunctions, handle: NativeHandle): NativeIdentity {
  requireOpen(handle);
  const output = Buffer.alloc(WINDOWS_NATIVE_ABI.structs.FILE_ID_INFO.size);
  if (!functions.getFileInformationByHandleEx(
    handle.native,
    WINDOWS_NATIVE_CONSTANTS.infoClass.FileIdInfo,
    output,
    output.length,
  )) {
    fail("The native handle identity is unavailable.");
  }
  const fileId = output.readBigUInt64LE(8).toString(16).padStart(32, "0");
  if (/^0+$/.test(fileId)) fail("The native handle identity is invalid.");
  return {
    fileId,
    volumeSerialNumber: output.readBigUInt64LE(0).toString(16).padStart(16, "0"),
  };
}

function attributesOf(functions: NativeFunctions, handle: NativeHandle): NativeAttributes {
  requireOpen(handle);
  const basic = Buffer.alloc(WINDOWS_NATIVE_ABI.structs.FILE_BASIC_INFO.size);
  const standard = Buffer.alloc(WINDOWS_NATIVE_ABI.structs.FILE_STANDARD_INFO.size);
  if (
    !functions.getFileInformationByHandleEx(
      handle.native,
      WINDOWS_NATIVE_CONSTANTS.infoClass.FileBasicInfo,
      basic,
      basic.length,
    )
    || !functions.getFileInformationByHandleEx(
      handle.native,
      WINDOWS_NATIVE_CONSTANTS.infoClass.FileStandardInfo,
      standard,
      standard.length,
    )
  ) {
    fail("The native handle attributes are unavailable.");
  }
  const flags = basic.readUInt32LE(32);
  const directory = standard.readUInt8(21) !== 0;
  const sizeValue = standard.readBigInt64LE(8);
  if (sizeValue < 0n || sizeValue > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail("The native handle size is invalid.");
  }
  return {
    directory,
    reparsePoint: (flags & FILE_ATTRIBUTE_REPARSE_POINT) !== 0,
    size: directory ? 0 : Number(sizeValue),
  };
}

function finalPathOf(functions: NativeFunctions, handle: NativeHandle): string {
  requireOpen(handle);
  const output = Buffer.alloc(FINAL_PATH_CHARACTERS * 2);
  const characters = functions.getFinalPathNameByHandleW(
    handle.native,
    output,
    FINAL_PATH_CHARACTERS,
    WINDOWS_NATIVE_CONSTANTS.pathFlags.FILE_NAME_NORMALIZED
      | WINDOWS_NATIVE_CONSTANTS.pathFlags.VOLUME_NAME_DOS,
  );
  if (!Number.isInteger(characters) || characters <= 0 || characters >= FINAL_PATH_CHARACTERS) {
    fail("The native handle final path is unavailable.");
  }
  const nativePath = output.toString("utf16le", 0, characters * 2);
  const normalized = nativePath.startsWith("\\\\?\\UNC\\")
    ? `\\\\${nativePath.slice(8)}`
    : nativePath.startsWith("\\\\?\\")
      ? nativePath.slice(4)
      : nativePath;
  if (!isAbsolute(normalized)) fail("The native handle final path is invalid.");
  return normalized;
}

function sameIdentity(left: NativeIdentity, right: NativeIdentity): boolean {
  return left.fileId === right.fileId
    && left.volumeSerialNumber === right.volumeSerialNumber;
}

function pathInsideRoot(root: string, candidate: string): boolean {
  const normalizedRoot = resolve(root).replace(/[\\/]+$/, "").toLocaleLowerCase("en-US");
  const normalizedCandidate = resolve(candidate).replace(/[\\/]+$/, "").toLocaleLowerCase("en-US");
  return normalizedCandidate === normalizedRoot
    || normalizedCandidate.startsWith(`${normalizedRoot}\\`);
}

function validateRelativeName(name: string): void {
  if (
    name.length === 0
    || name === "."
    || name === ".."
    || name.includes("\\")
    || name.includes("/")
    || name.includes("\0")
    || name.includes(":")
    || name.normalize("NFC") !== name
  ) {
    fail("The native relative name is invalid.");
  }
}

function createRootHandle(functions: NativeFunctions, rootPath: string): NativeHandle {
  if (!isAbsolute(rootPath)) fail("The native root path must be absolute.");
  const access = WINDOWS_NATIVE_CONSTANTS.access;
  const share = WINDOWS_NATIVE_CONSTANTS.share;
  const flags = WINDOWS_NATIVE_CONSTANTS.fileFlags;
  const native = functions.createFileW(
    resolve(rootPath),
    access.FILE_READ_ATTRIBUTES | access.FILE_READ_DATA | access.FILE_LIST_DIRECTORY,
    share.FILE_SHARE_READ | share.FILE_SHARE_WRITE | share.FILE_SHARE_DELETE,
    null,
    WINDOWS_NATIVE_CONSTANTS.createDisposition.OPEN_EXISTING,
    flags.FILE_FLAG_OPEN_REPARSE_POINT | flags.FILE_FLAG_BACKUP_SEMANTICS,
    null,
  );
  if (native == null || koffi.address(native) === INVALID_HANDLE_VALUE) {
    fail("The native root handle could not be opened.");
  }
  const provisional: NativeHandle = {
    attributesAtOpen: { directory: false, reparsePoint: true, size: 0 },
    closed: false,
    finalPathAtOpen: "",
    identityAtOpen: { fileId: "", volumeSerialNumber: "" },
    name: "",
    native,
    rootFinalPath: "",
  };
  try {
    provisional.attributesAtOpen = attributesOf(functions, provisional);
    if (!provisional.attributesAtOpen.directory || provisional.attributesAtOpen.reparsePoint) {
      fail("The native root is not an ordinary directory.");
    }
    provisional.identityAtOpen = identityOf(functions, provisional);
    provisional.finalPathAtOpen = finalPathOf(functions, provisional);
    provisional.rootFinalPath = provisional.finalPathAtOpen;
    return provisional;
  } catch (error) {
    functions.closeHandle(native);
    throw error;
  }
}

function createRelativeHandle(
  functions: NativeFunctions,
  parent: NativeHandle,
  name: string,
  kind: "directory" | "file",
): NativeHandle {
  requireOpen(parent);
  validateRelativeName(name);
  const nameBytes = Buffer.from(`${name}\0`, "utf16le");
  const unicode = {
    Length: nameBytes.length - 2,
    MaximumLength: nameBytes.length,
    Buffer: nameBytes,
  };
  const objectAttributes = {
    Length: WINDOWS_NATIVE_ABI.structs.OBJECT_ATTRIBUTES.size,
    RootDirectory: parent.native,
    ObjectName: unicode,
    Attributes: WINDOWS_NATIVE_CONSTANTS.objectAttributes.OBJ_CASE_INSENSITIVE,
    SecurityDescriptor: null,
    SecurityQualityOfService: null,
  };
  const ioStatus = { StatusOrPointer: 0, Information: 0 };
  const output: unknown[] = [null];
  const access = WINDOWS_NATIVE_CONSTANTS.access;
  const share = WINDOWS_NATIVE_CONSTANTS.share;
  const options = WINDOWS_NATIVE_CONSTANTS.createOptions;
  const status = functions.ntCreateFile(
    output,
    (kind === "directory" ? access.FILE_LIST_DIRECTORY : access.FILE_READ_DATA)
      | access.FILE_READ_ATTRIBUTES
      | access.SYNCHRONIZE,
    objectAttributes,
    ioStatus,
    null,
    0,
    share.FILE_SHARE_READ | share.FILE_SHARE_WRITE | share.FILE_SHARE_DELETE,
    WINDOWS_NATIVE_CONSTANTS.createDisposition.FILE_OPEN,
    (kind === "directory" ? options.FILE_DIRECTORY_FILE : options.FILE_NON_DIRECTORY_FILE)
      | options.FILE_OPEN_REPARSE_POINT
      | options.FILE_SYNCHRONOUS_IO_NONALERT,
    null,
    0,
  );
  const native = output[0];
  if (status !== 0 || native == null) {
    fail(`NtCreateFile could not open the relative ${kind}.`);
  }
  const provisional: NativeHandle = {
    attributesAtOpen: { directory: false, reparsePoint: true, size: 0 },
    closed: false,
    finalPathAtOpen: "",
    identityAtOpen: { fileId: "", volumeSerialNumber: "" },
    name,
    native,
    rootFinalPath: parent.rootFinalPath,
  };
  try {
    provisional.attributesAtOpen = attributesOf(functions, provisional);
    if (
      provisional.attributesAtOpen.reparsePoint
      || provisional.attributesAtOpen.directory !== (kind === "directory")
    ) {
      fail(`The relative ${kind} is a reparse point or special object.`);
    }
    provisional.identityAtOpen = identityOf(functions, provisional);
    provisional.finalPathAtOpen = finalPathOf(functions, provisional);
    if (!pathInsideRoot(parent.rootFinalPath, provisional.finalPathAtOpen)) {
      fail(`The relative ${kind} escaped the verified root.`);
    }
    return provisional;
  } catch (error) {
    functions.closeHandle(native);
    throw error;
  }
}

function parseDirectoryBuffer(
  buffer: Buffer,
  used: number,
  volumeSerialNumber: string,
): WindowsNativeDirectoryEntry[] {
  if (!Number.isSafeInteger(used) || used <= 0 || used > buffer.length) {
    fail("NtQueryDirectoryFile returned an invalid byte count.");
  }
  const entries: WindowsNativeDirectoryEntry[] = [];
  let offset = 0;
  while (true) {
    if (offset + DIRECTORY_FIXED_BYTES > used) {
      fail("NtQueryDirectoryFile returned a truncated record.");
    }
    const next = buffer.readUInt32LE(offset);
    const attributes = buffer.readUInt32LE(offset + 56);
    const nameBytes = buffer.readUInt32LE(offset + 60);
    if (
      nameBytes === 0
      || (nameBytes & 1) !== 0
      || offset + DIRECTORY_FIXED_BYTES + nameBytes > used
    ) {
      fail("NtQueryDirectoryFile returned an invalid name boundary.");
    }
    const name = buffer.toString(
      "utf16le",
      offset + DIRECTORY_FIXED_BYTES,
      offset + DIRECTORY_FIXED_BYTES + nameBytes,
    );
    if (name.normalize("NFC") !== name || name.includes("\0")) {
      fail("NtQueryDirectoryFile returned an invalid name.");
    }
    if (name !== "." && name !== "..") {
      const size = buffer.readBigInt64LE(offset + 40);
      if (size < 0n || size > BigInt(Number.MAX_SAFE_INTEGER)) {
        fail("NtQueryDirectoryFile returned an invalid size.");
      }
      entries.push({
        attributes: {
          directory: (attributes & FILE_ATTRIBUTE_DIRECTORY) !== 0,
          reparsePoint: (attributes & FILE_ATTRIBUTE_REPARSE_POINT) !== 0,
        },
        identity: {
          fileId: buffer.readBigUInt64LE(offset + 96).toString(16).padStart(32, "0"),
          volumeSerialNumber,
        },
        name,
        size: Number(size),
      });
    }
    if (next === 0) break;
    if ((next & 7) !== 0 || next < DIRECTORY_FIXED_BYTES || offset + next >= used) {
      fail("NtQueryDirectoryFile returned an invalid next offset.");
    }
    offset += next;
  }
  return entries;
}

export function createWindowsNativeReadAdapter(options: ReadAdapterOptions = {}) {
  const functions = guarded("The fixed Windows read symbols are unavailable.", loadFunctions);
  const hooks = options.hooks ?? {};

  function close(handle: NativeHandle): void {
    requireOpen(handle);
    // CloseHandle failure leaves ownership uncertain, so never issue a second close.
    handle.closed = true;
    if (!guarded("The native handle close failed.", () =>
      functions.closeHandle(handle.native))) {
      fail("The native handle close failed.");
    }
  }

  function identity(handle: NativeHandle): NativeIdentity {
    return guarded("The native handle identity is unavailable.", () =>
      identityOf(functions, handle));
  }

  function attributes(handle: NativeHandle): NativeAttributes {
    return guarded("The native handle attributes are unavailable.", () =>
      attributesOf(functions, handle));
  }

  function finalPath(handle: NativeHandle): string {
    return guarded("The native handle final path is unavailable.", () =>
      finalPathOf(functions, handle));
  }

  function openRootDirectory(rootPath: string): NativeHandle {
    return guarded("The native root handle could not be opened.", () =>
      createRootHandle(functions, rootPath));
  }

  function openRelative(
    parent: NativeHandle,
    name: string,
    kind: "directory" | "file",
  ): NativeHandle {
    guarded("The relative-open verification hook failed.", () =>
      hooks.beforeRelativeOpen?.(name, kind));
    return guarded(`The relative ${kind} could not be opened.`, () =>
      createRelativeHandle(functions, parent, name, kind));
  }

  function openChildDirectoryNoFollow(parent: NativeHandle, name: string): NativeHandle {
    return openRelative(parent, name, "directory");
  }

  function openFileNoFollow(parent: NativeHandle, name: string): NativeHandle {
    const handle = openRelative(parent, name, "file");
    guarded("The post-open verification hook failed.", () =>
      hooks.afterFileOpen?.(name));
    return handle;
  }

  function list(handle: NativeHandle): WindowsNativeDirectoryEntry[] {
    requireOpen(handle);
    const currentAttributes = attributes(handle);
    if (!currentAttributes.directory || currentAttributes.reparsePoint) {
      fail("Only an ordinary directory handle can be listed.");
    }
    const output: WindowsNativeDirectoryEntry[] = [];
    let restart = true;
    while (true) {
      const buffer = Buffer.alloc(DIRECTORY_BUFFER_BYTES);
      const ioStatus = { StatusOrPointer: 0, Information: 0 };
      const status = guarded("NtQueryDirectoryFile failed.", () =>
        functions.ntQueryDirectoryFile(
          handle.native,
          null,
          null,
          null,
          ioStatus,
          buffer,
          buffer.length,
          WINDOWS_NATIVE_CONSTANTS.infoClass.FileIdBothDirectoryInformation,
          false,
          null,
          restart,
        ));
      restart = false;
      if (status === STATUS_NO_MORE_FILES) break;
      if (status !== 0) fail("NtQueryDirectoryFile returned an uncertain status.");
      const used = Number(ioStatus.Information);
      guarded("The directory-buffer verification hook failed.", () =>
        hooks.corruptDirectoryBuffer?.(buffer, used));
      output.push(...parseDirectoryBuffer(
        buffer,
        used,
        handle.identityAtOpen.volumeSerialNumber,
      ));
    }
    return output.sort((left, right) =>
      Buffer.from(left.name, "utf8").compare(Buffer.from(right.name, "utf8")));
  }

  function readFromHandle(handle: NativeHandle, maximumBytes: number): Uint8Array {
    requireOpen(handle);
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
      fail("The maximum read size is invalid.");
    }
    const current = attributes(handle);
    if (current.directory || current.reparsePoint) {
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
      const chunk = output.subarray(offset, offset + requested);
      const bytesRead = [0];
      if (!guarded("ReadFile failed.", () =>
        functions.readFile(handle.native, chunk, requested, bytesRead, null))) {
        fail("ReadFile returned an uncertain result.");
      }
      const transferred = bytesRead[0];
      if (!Number.isInteger(transferred) || transferred < 0 || transferred > requested) {
        fail("ReadFile returned an invalid transfer count.");
      }
      if (transferred === 0) break;
      guarded("The read-observation hook failed.", () =>
        hooks.onReadBytes?.(chunk.subarray(0, transferred)));
      offset += transferred;
    }
    guarded("The post-read verification hook failed.", () =>
      hooks.afterFileRead?.(handle.name));
    return output.subarray(0, offset);
  }

  function assertStable(handle: NativeHandle): void {
    const currentFinalPath = finalPath(handle);
    if (
      !sameIdentity(handle.identityAtOpen, identity(handle))
      || currentFinalPath.toLocaleLowerCase("en-US")
        !== handle.finalPathAtOpen.toLocaleLowerCase("en-US")
      || !pathInsideRoot(handle.rootFinalPath, currentFinalPath)
    ) {
      fail("A retained native handle changed during the operation.");
    }
  }

  function listedEntry(parent: NativeHandle, name: string): WindowsNativeDirectoryEntry {
    const entry = list(parent).find((candidate) => candidate.name === name);
    if (!entry || entry.attributes.reparsePoint) {
      fail("The relative entry is missing or reparse-backed.");
    }
    return entry;
  }

  function closeOwned(handles: NativeHandle[], previous?: unknown): never | void {
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
    owned: NativeHandle[],
  ): NativeHandle {
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
  ): WindowsNativeDirectoryEntry[] {
    const owned: NativeHandle[] = [];
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
    const owned: NativeHandle[] = [];
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
    attributes,
    close,
    finalPath,
    identity,
    list,
    listVerifiedDirectory,
    openChildDirectoryNoFollow,
    openFileNoFollow,
    openRootDirectory,
    readFromHandle,
    readVerifiedFile,
  };
}
