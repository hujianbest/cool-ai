import "server-only";

import { release } from "node:os";
import { isAbsolute, resolve } from "node:path";

import * as koffi from "koffi";

type AbiLayout = {
  offsets: Record<string, number>;
  size: number;
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
  closeHandle: (handle: unknown) => boolean;
  createFileW: (
    path: string,
    desiredAccess: number,
    shareMode: number,
    securityAttributes: null,
    creationDisposition: number,
    flagsAndAttributes: number,
    templateFile: null,
  ) => unknown;
  getFileInformationByHandleEx: (
    handle: unknown,
    infoClass: number,
    output: Buffer,
    outputSize: number,
  ) => boolean;
  getFinalPathNameByHandleW: (
    handle: unknown,
    output: Buffer,
    outputCharacters: number,
    flags: number,
  ) => number;
  getVolumeInformationByHandleW: (
    handle: unknown,
    volumeName: null,
    volumeNameCharacters: number,
    serialNumber: Buffer,
    maximumComponentLength: Buffer,
    fileSystemFlags: Buffer,
    fileSystemName: Buffer,
    fileSystemNameCharacters: number,
  ) => boolean;
};

type NativeRootIdentity = {
  fileId: string;
  volumeSerialNumber: string;
};

type NativeRootAttributes = {
  directory: true;
  reparsePoint: false;
};

export class WindowsNativeError extends Error {
  readonly code = "SANDBOX_UNVERIFIABLE" as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WindowsNativeError";
  }
}

const FILE_ATTRIBUTE_DIRECTORY = 0x00000010;
const FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;
const INVALID_HANDLE_VALUE = 0xffffffffffffffffn;
const FINAL_PATH_BUFFER_CHARACTERS = 32_768;
const FILE_SYSTEM_NAME_CHARACTERS = 32;

export const WINDOWS_NATIVE_CONSTANTS = {
  access: {
    DELETE: 0x00010000,
    FILE_ADD_FILE: 0x00000002,
    FILE_LIST_DIRECTORY: 0x00000001,
    FILE_READ_ATTRIBUTES: 0x00000080,
    FILE_READ_DATA: 0x00000001,
    FILE_WRITE_ATTRIBUTES: 0x00000100,
    FILE_WRITE_DATA: 0x00000002,
    SYNCHRONIZE: 0x00100000,
  },
  attributes: {
    FILE_ATTRIBUTE_DIRECTORY,
    FILE_ATTRIBUTE_REPARSE_POINT,
  },
  createDisposition: {
    FILE_CREATE: 2,
    FILE_OPEN: 1,
    OPEN_EXISTING: 3,
  },
  createOptions: {
    FILE_DIRECTORY_FILE: 0x00000001,
    FILE_NON_DIRECTORY_FILE: 0x00000040,
    FILE_OPEN_REPARSE_POINT: 0x00200000,
    FILE_SYNCHRONOUS_IO_NONALERT: 0x00000020,
  },
  fileFlags: {
    FILE_DISPOSITION_FLAG_DELETE: 0x00000001,
    FILE_DISPOSITION_FLAG_POSIX_SEMANTICS: 0x00000002,
    FILE_FLAG_BACKUP_SEMANTICS: 0x02000000,
    FILE_FLAG_OPEN_REPARSE_POINT: 0x00200000,
    FILE_RENAME_FLAG_POSIX_SEMANTICS: 0x00000002,
    FILE_RENAME_FLAG_REPLACE_IF_EXISTS: 0x00000001,
  },
  infoClass: {
    FileBasicInfo: 0,
    FileStandardInfo: 1,
    FileIdInfo: 18,
    FileIdBothDirectoryInformation: 37,
    FileRenameInformationEx: 65,
    FileDispositionInformationEx: 64,
  },
  objectAttributes: {
    OBJ_CASE_INSENSITIVE: 0x00000040,
  },
  pathFlags: {
    FILE_NAME_NORMALIZED: 0,
    VOLUME_NAME_DOS: 0,
  },
  share: {
    FILE_SHARE_DELETE: 0x00000004,
    FILE_SHARE_READ: 0x00000001,
    FILE_SHARE_WRITE: 0x00000002,
  },
  symbols: {
    kernel32: [
      "CreateFileW",
      "CloseHandle",
      "GetFileInformationByHandleEx",
      "GetFinalPathNameByHandleW",
      "GetVolumeInformationByHandleW",
      "ReadFile",
      "WriteFile",
      "FlushFileBuffers",
    ],
    ntdll: [
      "NtCreateFile",
      "NtQueryDirectoryFile",
      "NtSetInformationFile",
    ],
  },
} as const;

export const WINDOWS_NATIVE_ABI = {
  pointerSize: 8,
  structs: {
    UNICODE_STRING: {
      size: 16,
      offsets: { Length: 0, MaximumLength: 2, Buffer: 8 },
    },
    OBJECT_ATTRIBUTES: {
      size: 48,
      offsets: {
        Length: 0,
        RootDirectory: 8,
        ObjectName: 16,
        Attributes: 24,
        SecurityDescriptor: 32,
        SecurityQualityOfService: 40,
      },
    },
    IO_STATUS_BLOCK: {
      size: 16,
      offsets: { StatusOrPointer: 0, Information: 8 },
    },
    FILE_ID_INFO: {
      size: 24,
      offsets: { VolumeSerialNumber: 0, FileId: 8 },
    },
    FILE_BASIC_INFO: {
      size: 40,
      offsets: {
        CreationTime: 0,
        LastAccessTime: 8,
        LastWriteTime: 16,
        ChangeTime: 24,
        FileAttributes: 32,
      },
    },
    FILE_STANDARD_INFO: {
      size: 24,
      offsets: {
        AllocationSize: 0,
        EndOfFile: 8,
        NumberOfLinks: 16,
        DeletePending: 20,
        Directory: 21,
      },
    },
    FILE_ID_BOTH_DIR_INFORMATION: {
      size: 112,
      offsets: {
        NextEntryOffset: 0,
        FileIndex: 4,
        CreationTime: 8,
        LastAccessTime: 16,
        LastWriteTime: 24,
        ChangeTime: 32,
        EndOfFile: 40,
        AllocationSize: 48,
        FileAttributes: 56,
        FileNameLength: 60,
        EaSize: 64,
        ShortNameLength: 68,
        ShortName: 70,
        FileId: 96,
        FileName: 104,
      },
    },
    FILE_RENAME_INFORMATION_EX: {
      size: 24,
      offsets: {
        Flags: 0,
        RootDirectory: 8,
        FileNameLength: 16,
        FileName: 20,
      },
    },
    FILE_DISPOSITION_INFORMATION_EX: {
      size: 4,
      offsets: { Flags: 0 },
    },
  },
} as const satisfies { pointerSize: number; structs: Record<string, AbiLayout> };

type LoaderOptions = {
  arch?: string;
  closeHandle?: (handle: unknown) => boolean;
  expectedAbi?: {
    pointerSize?: number;
    structSizes?: Record<string, number>;
  };
  loadLibrary?: (name: string) => unknown;
  platform?: string;
};

function unverifiable(message: string, cause?: unknown): never {
  throw new WindowsNativeError(message, cause === undefined ? undefined : { cause });
}

function guardNative<T>(message: string, action: () => T): T {
  try {
    return action();
  } catch (error) {
    if (error instanceof WindowsNativeError) throw error;
    return unverifiable(message, error);
  }
}

function defineStructs(): Record<string, koffi.TypeObject> {
  const pointer = "void *";
  return {
    UNICODE_STRING: koffi.struct(null, {
      Length: "uint16_t",
      MaximumLength: "uint16_t",
      Buffer: pointer,
    }),
    OBJECT_ATTRIBUTES: koffi.struct(null, {
      Length: "uint32_t",
      RootDirectory: pointer,
      ObjectName: pointer,
      Attributes: "uint32_t",
      SecurityDescriptor: pointer,
      SecurityQualityOfService: pointer,
    }),
    IO_STATUS_BLOCK: koffi.struct(null, {
      StatusOrPointer: "uintptr_t",
      Information: "uintptr_t",
    }),
    FILE_ID_INFO: koffi.struct(null, {
      VolumeSerialNumber: "uint64_t",
      FileId: koffi.array("uint8_t", 16),
    }),
    FILE_BASIC_INFO: koffi.struct(null, {
      CreationTime: "int64_t",
      LastAccessTime: "int64_t",
      LastWriteTime: "int64_t",
      ChangeTime: "int64_t",
      FileAttributes: "uint32_t",
    }),
    FILE_STANDARD_INFO: koffi.struct(null, {
      AllocationSize: "int64_t",
      EndOfFile: "int64_t",
      NumberOfLinks: "uint32_t",
      DeletePending: "uint8_t",
      Directory: "uint8_t",
    }),
    FILE_ID_BOTH_DIR_INFORMATION: koffi.struct(null, {
      NextEntryOffset: "uint32_t",
      FileIndex: "uint32_t",
      CreationTime: "int64_t",
      LastAccessTime: "int64_t",
      LastWriteTime: "int64_t",
      ChangeTime: "int64_t",
      EndOfFile: "int64_t",
      AllocationSize: "int64_t",
      FileAttributes: "uint32_t",
      FileNameLength: "uint32_t",
      EaSize: "uint32_t",
      ShortNameLength: "uint8_t",
      ShortName: koffi.array("uint16_t", 12),
      FileId: "int64_t",
      FileName: koffi.array("uint16_t", 1),
    }),
    FILE_RENAME_INFORMATION_EX: koffi.struct(null, {
      Flags: "uint32_t",
      RootDirectory: pointer,
      FileNameLength: "uint32_t",
      FileName: koffi.array("uint16_t", 1),
    }),
    FILE_DISPOSITION_INFORMATION_EX: koffi.struct(null, {
      Flags: "uint32_t",
    }),
  };
}

function assertAbi(options: LoaderOptions): void {
  const observedPointerSize = options.expectedAbi?.pointerSize ?? koffi.sizeof("uintptr_t");
  if (observedPointerSize !== WINDOWS_NATIVE_ABI.pointerSize) {
    unverifiable("The native pointer ABI is not Windows x64.");
  }

  const structs = guardNative("The Koffi ABI descriptor could not be created.", defineStructs);
  for (const [name, expected] of Object.entries(WINDOWS_NATIVE_ABI.structs)) {
    const type = structs[name];
    const observedSize = options.expectedAbi?.structSizes?.[name] ?? koffi.sizeof(type);
    if (observedSize !== expected.size) {
      unverifiable(`${name} has an unexpected native size.`);
    }
    for (const [member, offset] of Object.entries(expected.offsets)) {
      if (koffi.offsetof(type, member) !== offset) {
        unverifiable(`${name}.${member} has an unexpected native offset.`);
      }
    }
  }
}

function requireSupportedRuntime(options: LoaderOptions): void {
  if ((options.platform ?? process.platform) !== "win32") {
    unverifiable("The native sandbox adapter requires Windows.");
  }
  if ((options.arch ?? process.arch) !== "x64") {
    unverifiable("The native sandbox adapter requires x64 Node.");
  }
  const majorVersion = Number.parseInt(release().split(".")[0] ?? "", 10);
  if (!Number.isInteger(majorVersion) || majorVersion < 10) {
    unverifiable("The native sandbox adapter requires Windows 10 or Server 2016.");
  }
}

function bindSymbol(
  library: KoffiLibrary,
  name: string,
  result: string,
  parameters: unknown[],
): (...args: unknown[]) => unknown {
  return library.func("__stdcall", name, result, parameters);
}

function loadFunctions(options: LoaderOptions): NativeFunctions {
  const loadLibrary = options.loadLibrary ?? koffi.load;
  const kernel32 = loadLibrary("kernel32.dll") as KoffiLibrary;
  const ntdll = loadLibrary("ntdll.dll") as KoffiLibrary;

  const createFileW = bindSymbol(kernel32, "CreateFileW", "void *", [
    "str16", "uint32_t", "uint32_t", "void *", "uint32_t", "uint32_t", "void *",
  ]);
  const closeHandle = bindSymbol(kernel32, "CloseHandle", "bool", ["void *"]);
  const getFileInformationByHandleEx = bindSymbol(
    kernel32,
    "GetFileInformationByHandleEx",
    "bool",
    ["void *", "int32_t", "void *", "uint32_t"],
  );
  const getFinalPathNameByHandleW = bindSymbol(
    kernel32,
    "GetFinalPathNameByHandleW",
    "uint32_t",
    ["void *", "void *", "uint32_t", "uint32_t"],
  );
  const getVolumeInformationByHandleW = bindSymbol(
    kernel32,
    "GetVolumeInformationByHandleW",
    "bool",
    ["void *", "void *", "uint32_t", "void *", "void *", "void *", "void *", "uint32_t"],
  );
  bindSymbol(kernel32, "ReadFile", "bool", [
    "void *", "void *", "uint32_t", "void *", "void *",
  ]);
  bindSymbol(kernel32, "WriteFile", "bool", [
    "void *", "void *", "uint32_t", "void *", "void *",
  ]);
  bindSymbol(kernel32, "FlushFileBuffers", "bool", ["void *"]);
  bindSymbol(ntdll, "NtCreateFile", "int32_t", [
    "void *", "uint32_t", "void *", "void *", "void *", "uint32_t",
    "uint32_t", "uint32_t", "uint32_t", "void *", "uint32_t",
  ]);
  bindSymbol(ntdll, "NtQueryDirectoryFile", "int32_t", [
    "void *", "void *", "void *", "void *", "void *", "void *",
    "uint32_t", "uint32_t", "bool", "void *", "bool",
  ]);
  bindSymbol(ntdll, "NtSetInformationFile", "int32_t", [
    "void *", "void *", "void *", "uint32_t", "uint32_t",
  ]);

  return {
    closeHandle: (options.closeHandle ?? closeHandle) as NativeFunctions["closeHandle"],
    createFileW: createFileW as NativeFunctions["createFileW"],
    getFileInformationByHandleEx:
      getFileInformationByHandleEx as NativeFunctions["getFileInformationByHandleEx"],
    getFinalPathNameByHandleW:
      getFinalPathNameByHandleW as NativeFunctions["getFinalPathNameByHandleW"],
    getVolumeInformationByHandleW:
      getVolumeInformationByHandleW as NativeFunctions["getVolumeInformationByHandleW"],
  };
}

function openRoot(functions: NativeFunctions, rootPath: string): unknown {
  if (!isAbsolute(rootPath)) unverifiable("The native root path must be absolute.");
  const access = WINDOWS_NATIVE_CONSTANTS.access;
  const share = WINDOWS_NATIVE_CONSTANTS.share;
  const flags = WINDOWS_NATIVE_CONSTANTS.fileFlags;
  const handle = functions.createFileW(
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
  if (handle == null || koffi.address(handle) === INVALID_HANDLE_VALUE) {
    unverifiable("The native root handle could not be opened.");
  }
  return handle;
}

function readIdentity(functions: NativeFunctions, handle: unknown): NativeRootIdentity {
  const output = Buffer.alloc(WINDOWS_NATIVE_ABI.structs.FILE_ID_INFO.size);
  if (!functions.getFileInformationByHandleEx(
    handle,
    WINDOWS_NATIVE_CONSTANTS.infoClass.FileIdInfo,
    output,
    output.length,
  )) {
    unverifiable("The native root identity is unavailable.");
  }
  const volumeSerialNumber = output.readBigUInt64LE(0)
    .toString(16)
    .padStart(16, "0");
  const fileId = output.subarray(8, 24).toString("hex");
  if (/^0+$/.test(fileId)) unverifiable("The native root file id is invalid.");
  return { fileId, volumeSerialNumber };
}

function readAttributes(functions: NativeFunctions, handle: unknown): NativeRootAttributes {
  const output = Buffer.alloc(WINDOWS_NATIVE_ABI.structs.FILE_BASIC_INFO.size);
  if (!functions.getFileInformationByHandleEx(
    handle,
    WINDOWS_NATIVE_CONSTANTS.infoClass.FileBasicInfo,
    output,
    output.length,
  )) {
    unverifiable("The native root attributes are unavailable.");
  }
  const attributes = output.readUInt32LE(32);
  if (
    (attributes & FILE_ATTRIBUTE_DIRECTORY) === 0
    || (attributes & FILE_ATTRIBUTE_REPARSE_POINT) !== 0
  ) {
    unverifiable("The native root is not an ordinary non-reparse directory.");
  }
  return { directory: true, reparsePoint: false };
}

function readFinalPath(functions: NativeFunctions, handle: unknown): string {
  const output = Buffer.alloc(FINAL_PATH_BUFFER_CHARACTERS * 2);
  const characters = functions.getFinalPathNameByHandleW(
    handle,
    output,
    FINAL_PATH_BUFFER_CHARACTERS,
    WINDOWS_NATIVE_CONSTANTS.pathFlags.FILE_NAME_NORMALIZED
      | WINDOWS_NATIVE_CONSTANTS.pathFlags.VOLUME_NAME_DOS,
  );
  if (
    !Number.isInteger(characters)
    || characters <= 0
    || characters >= FINAL_PATH_BUFFER_CHARACTERS
  ) {
    unverifiable("The native root final path is unavailable.");
  }
  const nativePath = output.toString("utf16le", 0, characters * 2);
  const normalized = nativePath.startsWith("\\\\?\\UNC\\")
    ? `\\\\${nativePath.slice(8)}`
    : nativePath.startsWith("\\\\?\\")
      ? nativePath.slice(4)
      : nativePath;
  if (!isAbsolute(normalized)) unverifiable("The native root final path is invalid.");
  return normalized;
}

function readFileSystem(
  functions: NativeFunctions,
  handle: unknown,
): "NTFS" | "ReFS" {
  const serialNumber = Buffer.alloc(4);
  const maximumComponentLength = Buffer.alloc(4);
  const fileSystemFlags = Buffer.alloc(4);
  const fileSystemName = Buffer.alloc(FILE_SYSTEM_NAME_CHARACTERS * 2);
  if (!functions.getVolumeInformationByHandleW(
    handle,
    null,
    0,
    serialNumber,
    maximumComponentLength,
    fileSystemFlags,
    fileSystemName,
    FILE_SYSTEM_NAME_CHARACTERS,
  )) {
    unverifiable("The root volume filesystem cannot be verified.");
  }
  let byteLength = fileSystemName.length;
  for (let offset = 0; offset < fileSystemName.length; offset += 2) {
    if (fileSystemName.readUInt16LE(offset) === 0) {
      byteLength = offset;
      break;
    }
  }
  const value = fileSystemName.toString("utf16le", 0, byteLength);
  if (value !== "NTFS" && value !== "ReFS") {
    unverifiable("The root volume filesystem is unsupported.");
  }
  return value;
}

export function createWindowsNativeLoader(options: LoaderOptions = {}) {
  let functions: NativeFunctions | undefined;

  function ensureFunctions(): NativeFunctions {
    requireSupportedRuntime(options);
    assertAbi(options);
    functions ??= guardNative("The fixed Windows native symbols are unavailable.", () =>
      loadFunctions(options));
    return functions;
  }

  function withTemporaryRoot<T>(rootPath: string, action: (
    nativeFunctions: NativeFunctions,
    handle: unknown,
  ) => T): T {
    const nativeFunctions = ensureFunctions();
    const handle = guardNative("The native root handle could not be opened.", () =>
      openRoot(nativeFunctions, rootPath));
    try {
      return action(nativeFunctions, handle);
    } finally {
      if (!guardNative("The native root handle close failed.", () =>
        nativeFunctions.closeHandle(handle))) {
        unverifiable("The native root handle close failed.");
      }
    }
  }

  return {
    capability(rootPath: string) {
      return withTemporaryRoot(rootPath, (nativeFunctions, handle) => {
        readIdentity(nativeFunctions, handle);
        readAttributes(nativeFunctions, handle);
        readFinalPath(nativeFunctions, handle);
        return {
          supported: true as const,
          fileSystem: readFileSystem(nativeFunctions, handle),
        };
      });
    },
    openRootDirectory(rootPath: string) {
      const nativeFunctions = ensureFunctions();
      const handle = guardNative("The native root handle could not be opened.", () =>
        openRoot(nativeFunctions, rootPath));
      let closed = false;

      function requireOpen(): void {
        if (closed) unverifiable("The native root handle is closed.");
      }

      return {
        attributes() {
          requireOpen();
          return guardNative("The native root attributes are unavailable.", () =>
            readAttributes(nativeFunctions, handle));
        },
        close() {
          requireOpen();
          if (!guardNative("The native root handle close failed.", () =>
            nativeFunctions.closeHandle(handle))) {
            unverifiable("The native root handle close failed.");
          }
          closed = true;
        },
        finalPath() {
          requireOpen();
          return guardNative("The native root final path is unavailable.", () =>
            readFinalPath(nativeFunctions, handle));
        },
        identity() {
          requireOpen();
          return guardNative("The native root identity is unavailable.", () =>
            readIdentity(nativeFunctions, handle));
        },
      };
    },
  };
}
