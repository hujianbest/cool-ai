import "server-only";

import * as koffi from "koffi";

import { WindowsNativeError } from "@/src/modules/safe-execution";
import {
  WINDOWS_NATIVE_ABI,
} from "@/src/adapters/outbound/workspace/windows-native-loader";

type KoffiLibrary = {
  func(
    convention: string,
    name: string,
    result: string,
    parameters: unknown[],
  ): (...args: unknown[]) => unknown;
};

export type WindowsNativeKoffiFunctions = {
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

function fail(message: string): never {
  throw new WindowsNativeError(message);
}

function bind(
  library: KoffiLibrary,
  name: string,
  result: string,
  parameters: unknown[],
): (...args: unknown[]) => unknown {
  return library.func("__stdcall", name, result, parameters);
}

function loadFunctions(): WindowsNativeKoffiFunctions {
  if (process.platform !== "win32" || process.arch !== "x64") {
    fail("The native adapter requires Windows x64.");
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
    fail("The native adapter ABI is unavailable.");
  }

  const kernel32 = koffi.load("kernel32.dll") as KoffiLibrary;
  const ntdll = koffi.load("ntdll.dll") as KoffiLibrary;
  return {
    closeHandle: bind(kernel32, "CloseHandle", "bool", ["void *"]) as
      WindowsNativeKoffiFunctions["closeHandle"],
    createFileW: bind(kernel32, "CreateFileW", "void *", [
      "str16", "uint32_t", "uint32_t", "void *", "uint32_t", "uint32_t", "void *",
    ]) as WindowsNativeKoffiFunctions["createFileW"],
    flushFileBuffers: bind(
      kernel32,
      "FlushFileBuffers",
      "bool",
      ["void *"],
    ) as WindowsNativeKoffiFunctions["flushFileBuffers"],
    getFileInformationByHandleEx: bind(
      kernel32,
      "GetFileInformationByHandleEx",
      "bool",
      ["void *", "int32_t", "void *", "uint32_t"],
    ) as WindowsNativeKoffiFunctions["getFileInformationByHandleEx"],
    getFinalPathNameByHandleW: bind(
      kernel32,
      "GetFinalPathNameByHandleW",
      "uint32_t",
      ["void *", "void *", "uint32_t", "uint32_t"],
    ) as WindowsNativeKoffiFunctions["getFinalPathNameByHandleW"],
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
    ]) as WindowsNativeKoffiFunctions["ntCreateFile"],
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
    ]) as WindowsNativeKoffiFunctions["ntQueryDirectoryFile"],
    ntSetInformationFile: bind(ntdll, "NtSetInformationFile", "int32_t", [
      "void *",
      koffi.inout(koffi.pointer(ioStatusBlock)),
      "void *",
      "uint32_t",
      "uint32_t",
    ]) as WindowsNativeKoffiFunctions["ntSetInformationFile"],
    readFile: bind(kernel32, "ReadFile", "bool", [
      "void *", "void *", "uint32_t", koffi.out(koffi.pointer("uint32_t")), "void *",
    ]) as WindowsNativeKoffiFunctions["readFile"],
    writeFile: bind(kernel32, "WriteFile", "bool", [
      "void *", "void *", "uint32_t", koffi.out(koffi.pointer("uint32_t")), "void *",
    ]) as WindowsNativeKoffiFunctions["writeFile"],
  };
}

let cached: WindowsNativeKoffiFunctions | undefined;

export function getWindowsNativeKoffiFunctions(): WindowsNativeKoffiFunctions {
  cached ??= loadFunctions();
  return cached;
}
