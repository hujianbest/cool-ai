import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";

import * as koffi from "koffi";

import { WindowsNativeError, WindowsNativeWriteFailure } from "@/src/modules/safe-execution";
import {
  WINDOWS_NATIVE_ABI,
  WINDOWS_NATIVE_CONSTANTS,
} from "@/src/adapters/outbound/workspace/windows-native-loader";

export { WindowsNativeWriteFailure } from "@/src/modules/safe-execution";

type NativeIdentity = {
  fileId: string;
  volumeSerialNumber: string;
};

type NativeAttributes = {
  directory: boolean;
  reparsePoint: boolean;
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

export type WindowsNativeMutationStep =
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

export type WindowsNativeWriteAdapterOptions = {
  hooks?: {
    afterReplace?: (name: string) => void;
    beforeNativeStep?: (step: WindowsNativeMutationStep, name: string) => void;
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

export type WindowsNativeMergeLifecycleStep =
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

export type WindowsNativeMergeLifecycleOptions = {
  hooks?: {
    beforeMutation?: (
      operation: "replace" | "delete" | "cleanup",
      name: string,
    ) => void;
    beforeNativeStep?: (step: WindowsNativeMergeLifecycleStep, name: string) => void;
    onClose?: (name: string, handle: unknown) => void;
    onWriteBytes?: (bytes: Uint8Array) => void;
  };
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
  flushFileBuffers(handle: unknown): boolean;
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
  ntSetInformationFile(
    handle: unknown,
    ioStatus: Record<string, unknown>,
    information: Buffer,
    informationLength: number,
    infoClass: number,
  ): number;
  readFile(
    handle: unknown,
    output: Buffer,
    requested: number,
    bytesRead: number[],
    overlapped: null,
  ): boolean;
  writeFile(
    handle: unknown,
    input: Uint8Array,
    requested: number,
    bytesWritten: number[],
    overlapped: null,
  ): boolean;
};

const FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;
const INVALID_HANDLE_VALUE = 0xffffffffffffffffn;
const STATUS_OBJECT_NAME_NOT_FOUND = -1073741772;
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
    fail("The native write adapter requires Windows x64.");
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
    fail("The native write adapter ABI is unavailable.");
  }

  const kernel32 = koffi.load("kernel32.dll") as KoffiLibrary;
  const ntdll = koffi.load("ntdll.dll") as KoffiLibrary;
  return {
    closeHandle: bind(kernel32, "CloseHandle", "bool", ["void *"]) as NativeFunctions["closeHandle"],
    createFileW: bind(kernel32, "CreateFileW", "void *", [
      "str16", "uint32_t", "uint32_t", "void *", "uint32_t", "uint32_t", "void *",
    ]) as NativeFunctions["createFileW"],
    flushFileBuffers: bind(
      kernel32,
      "FlushFileBuffers",
      "bool",
      ["void *"],
    ) as NativeFunctions["flushFileBuffers"],
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
    ntSetInformationFile: bind(ntdll, "NtSetInformationFile", "int32_t", [
      "void *",
      koffi.inout(koffi.pointer(ioStatusBlock)),
      "void *",
      "uint32_t",
      "uint32_t",
    ]) as NativeFunctions["ntSetInformationFile"],
    readFile: bind(kernel32, "ReadFile", "bool", [
      "void *", "void *", "uint32_t", koffi.out(koffi.pointer("uint32_t")), "void *",
    ]) as NativeFunctions["readFile"],
    writeFile: bind(kernel32, "WriteFile", "bool", [
      "void *", "void *", "uint32_t", koffi.out(koffi.pointer("uint32_t")), "void *",
    ]) as NativeFunctions["writeFile"],
  };
}

function requireOpen(handle: NativeHandle): void {
  if (handle.closed) fail("The native handle is closed.");
}

function sameIdentity(left: NativeIdentity, right: NativeIdentity): boolean {
  return left.fileId === right.fileId
    && left.volumeSerialNumber === right.volumeSerialNumber;
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
  const size = standard.readBigInt64LE(8);
  if (size < 0n || size > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail("The native handle size is invalid.");
  }
  return {
    directory: standard.readUInt8(21) !== 0,
    reparsePoint: (basic.readUInt32LE(32) & FILE_ATTRIBUTE_REPARSE_POINT) !== 0,
    size: Number(size),
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

function provisional(native: unknown, name: string, rootFinalPath = ""): NativeHandle {
  return {
    attributesAtOpen: { directory: false, reparsePoint: true, size: 0 },
    closed: false,
    finalPathAtOpen: "",
    identityAtOpen: { fileId: "", volumeSerialNumber: "" },
    name,
    native,
    rootFinalPath,
  };
}

function finishHandle(
  functions: NativeFunctions,
  handle: NativeHandle,
  expectedKind: "directory" | "file",
): NativeHandle {
  try {
    handle.attributesAtOpen = attributesOf(functions, handle);
    if (
      handle.attributesAtOpen.reparsePoint
      || handle.attributesAtOpen.directory !== (expectedKind === "directory")
    ) {
      fail("The native handle is a reparse point or special object.");
    }
    handle.identityAtOpen = identityOf(functions, handle);
    handle.finalPathAtOpen = finalPathOf(functions, handle);
    if (
      handle.rootFinalPath
      && !pathInsideRoot(handle.rootFinalPath, handle.finalPathAtOpen)
    ) {
      fail("The native handle escaped the verified root.");
    }
    return handle;
  } catch (error) {
    functions.closeHandle(handle.native);
    handle.closed = true;
    throw error;
  }
}

function createRootHandle(functions: NativeFunctions, rootPath: string): NativeHandle {
  if (!isAbsolute(rootPath)) fail("The native root path must be absolute.");
  const access = WINDOWS_NATIVE_CONSTANTS.access;
  const share = WINDOWS_NATIVE_CONSTANTS.share;
  const flags = WINDOWS_NATIVE_CONSTANTS.fileFlags;
  const native = functions.createFileW(
    resolve(rootPath),
    access.FILE_READ_ATTRIBUTES
      | access.FILE_READ_DATA
      | access.FILE_LIST_DIRECTORY
      | access.FILE_WRITE_ATTRIBUTES
      | access.FILE_ADD_FILE
      | access.DELETE,
    share.FILE_SHARE_READ | share.FILE_SHARE_WRITE | share.FILE_SHARE_DELETE,
    null,
    WINDOWS_NATIVE_CONSTANTS.createDisposition.OPEN_EXISTING,
    flags.FILE_FLAG_OPEN_REPARSE_POINT | flags.FILE_FLAG_BACKUP_SEMANTICS,
    null,
  );
  if (native == null || koffi.address(native) === INVALID_HANDLE_VALUE) {
    fail("The native root handle could not be opened.");
  }
  const handle = finishHandle(functions, provisional(native, ""), "directory");
  handle.rootFinalPath = handle.finalPathAtOpen;
  return handle;
}

function relativeObjectAttributes(parent: NativeHandle, name: string) {
  validateRelativeName(name);
  const nameBytes = Buffer.from(`${name}\0`, "utf16le");
  return {
    nameBytes,
    value: {
      Length: WINDOWS_NATIVE_ABI.structs.OBJECT_ATTRIBUTES.size,
      RootDirectory: parent.native,
      ObjectName: {
        Length: nameBytes.length - 2,
        MaximumLength: nameBytes.length,
        Buffer: nameBytes,
      },
      Attributes: WINDOWS_NATIVE_CONSTANTS.objectAttributes.OBJ_CASE_INSENSITIVE,
      SecurityDescriptor: null,
      SecurityQualityOfService: null,
    },
  };
}

function createRelativeHandle(
  functions: NativeFunctions,
  parent: NativeHandle,
  name: string,
  kind: "directory" | "file" | "temp",
  allowMissing = false,
): NativeHandle | null {
  requireOpen(parent);
  const objectAttributes = relativeObjectAttributes(parent, name);
  const ioStatus = { StatusOrPointer: 0, Information: 0 };
  const output: unknown[] = [null];
  const access = WINDOWS_NATIVE_CONSTANTS.access;
  const share = WINDOWS_NATIVE_CONSTANTS.share;
  const options = WINDOWS_NATIVE_CONSTANTS.createOptions;
  const directory = kind === "directory";
  const temp = kind === "temp";
  const status = functions.ntCreateFile(
    output,
    (directory ? access.FILE_LIST_DIRECTORY | access.FILE_ADD_FILE | access.FILE_WRITE_ATTRIBUTES
      : access.FILE_READ_DATA | (temp
        ? access.FILE_WRITE_DATA | access.FILE_WRITE_ATTRIBUTES | access.DELETE
        : access.DELETE))
      | access.FILE_READ_ATTRIBUTES
      | access.SYNCHRONIZE,
    objectAttributes.value,
    ioStatus,
    null,
    0,
    share.FILE_SHARE_READ | share.FILE_SHARE_WRITE | share.FILE_SHARE_DELETE,
    temp
      ? WINDOWS_NATIVE_CONSTANTS.createDisposition.FILE_CREATE
      : WINDOWS_NATIVE_CONSTANTS.createDisposition.FILE_OPEN,
    (directory ? options.FILE_DIRECTORY_FILE : options.FILE_NON_DIRECTORY_FILE)
      | options.FILE_OPEN_REPARSE_POINT
      | options.FILE_SYNCHRONOUS_IO_NONALERT,
    null,
    0,
  );
  if (allowMissing && status === STATUS_OBJECT_NAME_NOT_FOUND) return null;
  if (status !== 0 || output[0] == null) {
    fail(`NtCreateFile could not ${temp ? "create" : "open"} the relative object.`);
  }
  return finishHandle(
    functions,
    provisional(output[0], name, parent.rootFinalPath),
    directory ? "directory" : "file",
  );
}

function assertStable(functions: NativeFunctions, handle: NativeHandle): void {
  const currentPath = finalPathOf(functions, handle);
  if (
    !sameIdentity(handle.identityAtOpen, identityOf(functions, handle))
    || currentPath.toLocaleLowerCase("en-US")
      !== handle.finalPathAtOpen.toLocaleLowerCase("en-US")
    || !pathInsideRoot(handle.rootFinalPath, currentPath)
  ) {
    fail("A retained native handle changed during mutation.");
  }
}

function readAll(functions: NativeFunctions, handle: NativeHandle): Buffer {
  const attributes = attributesOf(functions, handle);
  if (attributes.directory || attributes.reparsePoint || attributes.size > MAXIMUM_FILE_BYTES) {
    fail("The mutation target cannot be verified as a bounded ordinary file.");
  }
  const output = Buffer.alloc(attributes.size);
  let offset = 0;
  while (offset < output.length) {
    const requested = Math.min(output.length - offset, MAXIMUM_TRANSFER);
    const chunk = output.subarray(offset, offset + requested);
    const transferred = [0];
    if (!functions.readFile(handle.native, chunk, requested, transferred, null)) {
      fail("ReadFile returned an uncertain result.");
    }
    if (
      !Number.isInteger(transferred[0])
      || transferred[0] <= 0
      || transferred[0] > requested
    ) {
      fail("ReadFile returned an invalid transfer count.");
    }
    offset += transferred[0];
  }
  if (
    attributesOf(functions, handle).size !== attributes.size
    || !sameIdentity(handle.identityAtOpen, identityOf(functions, handle))
  ) {
    fail("The mutation target changed while hashing.");
  }
  return output;
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function closeHandle(functions: NativeFunctions, handle: NativeHandle): void {
  requireOpen(handle);
  handle.closed = true;
  if (!functions.closeHandle(handle.native)) fail("The native handle close failed.");
}

function closeOwned(
  functions: NativeFunctions,
  handles: NativeHandle[],
  previous?: unknown,
): never | void {
  let failure = previous;
  for (const handle of handles.reverse()) {
    if (handle.closed) continue;
    try {
      closeHandle(functions, handle);
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure !== undefined) throw failure;
}

function markDelete(functions: NativeFunctions, handle: NativeHandle): void {
  const information = Buffer.alloc(WINDOWS_NATIVE_ABI.structs.FILE_DISPOSITION_INFORMATION_EX.size);
  information.writeUInt32LE(
    WINDOWS_NATIVE_CONSTANTS.fileFlags.FILE_DISPOSITION_FLAG_DELETE
      | WINDOWS_NATIVE_CONSTANTS.fileFlags.FILE_DISPOSITION_FLAG_POSIX_SEMANTICS,
  );
  const ioStatus = { StatusOrPointer: 0, Information: 0 };
  const status = functions.ntSetInformationFile(
    handle.native,
    ioStatus,
    information,
    information.length,
    WINDOWS_NATIVE_CONSTANTS.infoClass.FileDispositionInformationEx,
  );
  if (status !== 0) fail("NtSetInformationFile delete returned an uncertain status.");
}

function renameRelative(
  functions: NativeFunctions,
  handle: NativeHandle,
  parent: NativeHandle,
  name: string,
): void {
  validateRelativeName(name);
  const nameBytes = Buffer.from(name, "utf16le");
  const information = Buffer.alloc(20 + nameBytes.length);
  information.writeUInt32LE(
    WINDOWS_NATIVE_CONSTANTS.fileFlags.FILE_RENAME_FLAG_REPLACE_IF_EXISTS
      | WINDOWS_NATIVE_CONSTANTS.fileFlags.FILE_RENAME_FLAG_POSIX_SEMANTICS,
    0,
  );
  information.writeBigUInt64LE(koffi.address(parent.native), 8);
  information.writeUInt32LE(nameBytes.length, 16);
  nameBytes.copy(information, 20);
  const ioStatus = { StatusOrPointer: 0, Information: 0 };
  const status = functions.ntSetInformationFile(
    handle.native,
    ioStatus,
    information,
    information.length,
    WINDOWS_NATIVE_CONSTANTS.infoClass.FileRenameInformationEx,
  );
  if (status !== 0) {
    fail(`NtSetInformationFile rename returned status 0x${(status >>> 0).toString(16)}.`);
  }
}

export function createWindowsNativeWriteAdapter(
  options: WindowsNativeWriteAdapterOptions = {},
) {
  const functions = guarded("The fixed Windows write symbols are unavailable.", loadFunctions);
  const hooks = options.hooks ?? {};

  function step(value: WindowsNativeMutationStep, name: string): void {
    guarded(`The ${value} fault hook failed.`, () => hooks.beforeNativeStep?.(value, name));
  }

  function openParent(rootPath: string, segments: string[], owned: NativeHandle[]): NativeHandle {
    let parent = createRootHandle(functions, rootPath);
    owned.push(parent);
    for (const segment of segments) {
      const child = createRelativeHandle(functions, parent, segment, "directory");
      if (child == null) fail("The verified parent is missing.");
      owned.push(child);
      assertStable(functions, parent);
      parent = child;
    }
    return parent;
  }

  function openTarget(
    parent: NativeHandle,
    name: string,
    expectedHash: string | null,
    owned: NativeHandle[],
  ): NativeHandle | null {
    const target = createRelativeHandle(functions, parent, name, "file", expectedHash === null);
    if (target == null) {
      if (expectedHash !== null) fail("The expected mutation target is missing.");
      return null;
    }
    owned.push(target);
    if (expectedHash === null || digest(readAll(functions, target)) !== expectedHash) {
      fail("The mutation target identity or hash did not match.");
    }
    return target;
  }

  function verifyNamedTarget(
    parent: NativeHandle,
    name: string,
    identity: NativeIdentity,
    expectedHash: string,
  ): NativeHandle {
    const current = createRelativeHandle(functions, parent, name, "file");
    if (current == null) fail("The mutation target disappeared.");
    try {
      if (
        !sameIdentity(identity, current.identityAtOpen)
        || digest(readAll(functions, current)) !== expectedHash
      ) {
        fail("The named mutation target changed.");
      }
      return current;
    } catch (error) {
      closeOwned(functions, [current], error);
      throw error;
    }
  }

  function flushDirectory(parent: NativeHandle, name: string): void {
    step("flush-directory", name);
    if (!functions.flushFileBuffers(parent.native)) {
      fail("FlushFileBuffers returned an uncertain directory result.");
    }
  }

  function writeVerifiedFile(
    rootPath: string,
    segments: string[],
    bytes: Uint8Array,
    expectedHash: string | null,
  ): { hash: string; identity: NativeIdentity } {
    if (
      segments.length === 0
      || bytes.byteLength > MAXIMUM_FILE_BYTES
      || (expectedHash !== null && !/^[0-9a-f]{64}$/.test(expectedHash))
    ) {
      fail("The write request is invalid.");
    }
    const owned: NativeHandle[] = [];
    let temp: NativeHandle | undefined;
    let renamed = false;
    const name = segments.at(-1)!;
    try {
      const parent = openParent(rootPath, segments.slice(0, -1), owned);
      step("pre-target-open", name);
      const previous = openTarget(parent, name, expectedHash, owned);
      step("pre-parent-check", name);
      assertStable(functions, parent);

      const tempName = `.cool-ai-${randomUUID()}.tmp`;
      step("create-temp", name);
      temp = createRelativeHandle(functions, parent, tempName, "temp") ?? undefined;
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
        const chunk = bytes.subarray(offset, offset + requested);
        const transferred = [0];
        if (!functions.writeFile(temp.native, chunk, requested, transferred, null)) {
          fail("WriteFile returned an uncertain result.");
        }
        if (
          !Number.isInteger(transferred[0])
          || transferred[0] <= 0
          || transferred[0] > requested
        ) {
          fail("WriteFile returned an invalid transfer count.");
        }
        guarded("The write-observation hook failed.", () =>
          hooks.onWriteBytes?.(chunk.subarray(0, transferred[0])));
        offset += transferred[0];
      }
      step("flush-file", name);
      if (!functions.flushFileBuffers(temp.native)) {
        fail("FlushFileBuffers returned an uncertain file result.");
      }
      const writtenHash = digest(bytes);
      if (
        attributesOf(functions, temp).size !== bytes.byteLength
        || !sameIdentity(temp.identityAtOpen, identityOf(functions, temp))
      ) {
        fail("The owned temp size or identity did not match after flush.");
      }

      guarded("The pre-replace race hook failed.", () => hooks.beforeReplace?.(name));
      step("rename", name);
      assertStable(functions, parent);
      if (previous) {
        const check = verifyNamedTarget(
          parent,
          name,
          previous.identityAtOpen,
          expectedHash!,
        );
        closeHandle(functions, check);
      } else {
        const absent = createRelativeHandle(functions, parent, name, "file", true);
        if (absent) {
          closeHandle(functions, absent);
          fail("The create target appeared before atomic rename.");
        }
      }
      renameRelative(functions, temp, parent, name);
      renamed = true;
      closeHandle(functions, temp);
      guarded("The post-replace race hook failed.", () => hooks.afterReplace?.(name));

      step("post-target-open", name);
      const result = createRelativeHandle(functions, parent, name, "file");
      if (!result) fail("The replaced target could not be reopened.");
      owned.push(result);
      if (
        !sameIdentity(temp.identityAtOpen, result.identityAtOpen)
        || digest(readAll(functions, result)) !== writtenHash
      ) {
        fail("The post-replace identity or hash did not match.");
      }
      step("post-parent-check", name);
      assertStable(functions, parent);
      flushDirectory(parent, name);
      const output = { hash: writtenHash, identity: result.identityAtOpen };
      closeOwned(functions, owned);
      return output;
    } catch (error) {
      let cleanupConfirmed = true;
      if (temp && !temp.closed && !renamed) {
        try {
          if (sameIdentity(temp.identityAtOpen, identityOf(functions, temp))) {
            markDelete(functions, temp);
          } else {
            cleanupConfirmed = false;
          }
        } catch {
          cleanupConfirmed = false;
        }
      }
      try {
        closeOwned(functions, owned);
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
    const owned: NativeHandle[] = [];
    const name = segments.at(-1)!;
    try {
      const parent = openParent(rootPath, segments.slice(0, -1), owned);
      step("pre-target-open", name);
      const target = openTarget(parent, name, expectedHash, owned);
      if (!target) fail("The delete target is missing.");
      step("pre-parent-check", name);
      assertStable(functions, parent);
      step("delete", name);
      const check = verifyNamedTarget(parent, name, target.identityAtOpen, expectedHash);
      closeHandle(functions, check);
      assertStable(functions, parent);
      markDelete(functions, target);
      closeHandle(functions, target);
      flushDirectory(parent, name);
      closeOwned(functions, owned);
    } catch (error) {
      closeOwned(functions, owned, error);
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

function identityKey(identity: NativeIdentity): string {
  return `${identity.volumeSerialNumber}:${identity.fileId}`;
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

export function createWindowsNativeMergeLifecycleAdapter(
  options: WindowsNativeMergeLifecycleOptions = {},
) {
  const functions = guarded("The fixed Windows merge lifecycle symbols are unavailable.", loadFunctions);
  const hooks = options.hooks ?? {};
  let phase = "initialize";

  function step(value: WindowsNativeMergeLifecycleStep, name: string): void {
    phase = value;
    guarded(`The ${value} merge lifecycle fault hook failed.`, () =>
      hooks.beforeNativeStep?.(value, name));
  }

  function closeOne(handle: NativeHandle): void {
    if (handle.closed) return;
    phase = "close";
    handle.closed = true;
    let hookFailure: unknown;
    try {
      hooks.beforeNativeStep?.("close", handle.name);
    } catch (error) {
      hookFailure = error;
    }
    const closed = functions.closeHandle(handle.native);
    guarded("The merge close-observation hook failed.", () =>
      hooks.onClose?.(handle.name, handle.native));
    if (!closed) fail("The native merge handle close failed.");
    if (hookFailure !== undefined) fail("The close merge lifecycle fault hook failed.", hookFailure);
  }

  function closeAll(handles: NativeHandle[], previous?: unknown): void {
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
    owned: NativeHandle[],
    name: string,
  ): NativeHandle {
    step("open-root", name);
    step("identity", name);
    step("final-path", name);
    let parent = createRootHandle(functions, root);
    owned.push(parent);
    for (const segment of segments) {
      step("open-parent", segment);
      const child = createRelativeHandle(functions, parent, segment, "directory");
      if (!child) fail("The merge parent is missing.");
      owned.push(child);
      step("identity", segment);
      step("final-path", segment);
      assertStable(functions, parent);
      parent = child;
    }
    return parent;
  }

  function readFileBytes(handle: NativeHandle): Buffer {
    step("read", handle.name);
    return readAll(functions, handle);
  }

  function descriptor(
    rootKind: "journal" | "canonical",
    relativePath: string[],
    ownerId: string,
    parent: NativeHandle,
    file: NativeHandle,
    bytes: Uint8Array,
  ): VerifiedOwnedFileRef {
    step("identity", file.name);
    const fileIdentity = identityOf(functions, file);
    const parentIdentity = identityOf(functions, parent);
    step("final-path", file.name);
    const finalPath = finalPathOf(functions, file);
    if (
      !sameIdentity(file.identityAtOpen, fileIdentity)
      || !sameIdentity(parent.identityAtOpen, parentIdentity)
      || finalPath.toLocaleLowerCase("en-US")
        !== file.finalPathAtOpen.toLocaleLowerCase("en-US")
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
    parent: NativeHandle,
    relativePath: string[],
    owned: NativeHandle[],
  ): ExpectedCanonicalFile {
    const name = relativePath.at(-1)!;
    step("open-file", name);
    const file = createRelativeHandle(functions, parent, name, "file", true);
    const parentIdentity = identityKey(identityOf(functions, parent));
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
      fileIdentity: identityKey(identityOf(functions, file)),
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
    owned: NativeHandle[],
  ): { bytes: Buffer; file: NativeHandle; parent: NativeHandle } {
    validateRef(ref);
    const name = ref.relativePath.at(-1)!;
    const parent = openParentPath(
      rootFor(roots, ref.rootKind),
      ref.relativePath.slice(0, -1),
      owned,
      name,
    );
    step("open-file", name);
    const file = createRelativeHandle(functions, parent, name, "file", true);
    if (!file) {
      return mismatch({
        rootKind: "canonical",
        relativePath: [...ref.relativePath],
        exists: false,
        parentIdentity: identityKey(identityOf(functions, parent)),
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
      || current.finalPath.toLocaleLowerCase("en-US")
        !== ref.finalPath.toLocaleLowerCase("en-US")
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
      const owned: NativeHandle[] = [];
      try {
        const parent = openParentPath(root, parentSegments, owned, name);
        step("create", name);
        const file = createRelativeHandle(functions, parent, name, "temp");
        if (!file) fail("The exclusive owned merge file was not created.");
        owned.push(file);
        let offset = 0;
        while (offset < bytes.byteLength) {
          step("write", name);
          const requested = Math.min(MAXIMUM_TRANSFER, bytes.byteLength - offset);
          const chunk = bytes.subarray(offset, offset + requested);
          const transferred = [0];
          if (!functions.writeFile(file.native, chunk, requested, transferred, null)) {
            fail("WriteFile returned an uncertain owned merge result.");
          }
          if (transferred[0] <= 0 || transferred[0] > requested) {
            fail("WriteFile returned an invalid owned merge transfer.");
          }
          guarded("The merge write-observation hook failed.", () =>
            hooks.onWriteBytes?.(chunk.subarray(0, transferred[0])));
          offset += transferred[0];
        }
        step("flush-file", name);
        if (!functions.flushFileBuffers(file.native)) {
          fail("The owned merge file flush was uncertain.");
        }
        const result = descriptor(
          rootKind,
          [...parentSegments, name],
          ownerId,
          parent,
          file,
          bytes,
        );
        step("flush-directory", name);
        if (!functions.flushFileBuffers(parent.native)) {
          fail("The owned merge parent flush was uncertain.");
        }
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
      const owned: NativeHandle[] = [];
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
    const owned: NativeHandle[] = [];
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
      const owned: NativeHandle[] = [];
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
        const temp = reopen(roots, preparedCanonicalTemp, owned).file;
        guarded("The replace race hook failed.", () =>
          hooks.beforeMutation?.("replace", targetName));
        const checked = observed(parent, expectedTarget.relativePath, owned);
        if (!sameExpected(checked, expectedTarget)) mismatch(checked);
        const tempChecked = reopen(roots, preparedCanonicalTemp, owned);
        step("rename", targetName);
        renameRelative(functions, tempChecked.file, parent, targetName);
        closeOne(tempChecked.file);
        const post = observed(parent, expectedTarget.relativePath, owned);
        if (
          !post.exists
          || post.fileIdentity !== preparedCanonicalTemp.fileIdentity
          || post.sha256 !== preparedCanonicalTemp.sha256
          || post.size !== preparedCanonicalTemp.size
        ) fail("The conditional replace post-state was uncertain.");
        step("flush-directory", targetName);
        if (!functions.flushFileBuffers(parent.native)) {
          fail("The conditional replace directory flush was uncertain.");
        }
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
      const owned: NativeHandle[] = [];
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
        const target = createRelativeHandle(functions, parent, name, "file");
        if (!target) mismatch(checked);
        owned.push(target);
        step("delete", name);
        markDelete(functions, target);
        closeOne(target);
        step("flush-directory", name);
        if (!functions.flushFileBuffers(parent.native)) {
          fail("The conditional delete directory flush was uncertain.");
        }
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
      const owned: NativeHandle[] = [];
      const name = ref.relativePath.at(-1) ?? "";
      try {
        reopen(roots, ref, owned);
        guarded("The cleanup race hook failed.", () =>
          hooks.beforeMutation?.("cleanup", name));
        const checked = reopen(roots, ref, owned);
        step("delete", name);
        markDelete(functions, checked.file);
        closeOne(checked.file);
        step("flush-directory", name);
        if (!functions.flushFileBuffers(checked.parent.native)) {
          fail("The owned cleanup directory flush was uncertain.");
        }
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
