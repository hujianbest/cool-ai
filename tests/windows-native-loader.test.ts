import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

type NativeFailure = Error & { code?: string };

type AbiLayout = {
  offsets: Record<string, number>;
  size: number;
};

type WindowsNativeModule = {
  WINDOWS_NATIVE_ABI: {
    pointerSize: number;
    structs: Record<string, AbiLayout>;
  };
  WINDOWS_NATIVE_CONSTANTS: {
    access: Record<string, number>;
    attributes: Record<string, number>;
    createDisposition: Record<string, number>;
    createOptions: Record<string, number>;
    fileFlags: Record<string, number>;
    infoClass: Record<string, number>;
    objectAttributes: Record<string, number>;
    pathFlags: Record<string, number>;
    share: Record<string, number>;
    symbols: Record<string, readonly string[]>;
  };
  createWindowsNativeLoader(options?: {
    arch?: string;
    platform?: string;
    loadLibrary?: (name: string) => unknown;
    expectedAbi?: {
      pointerSize?: number;
      structSizes?: Record<string, number>;
    };
    closeHandle?: (handle: unknown) => boolean;
  }): {
    capability(rootPath: string): {
      fileSystem: "NTFS" | "ReFS";
      supported: true;
    };
    openRootDirectory(rootPath: string): {
      attributes(): {
        directory: true;
        reparsePoint: false;
      };
      close(): void;
      finalPath(): string;
      identity(): {
        fileId: string;
        volumeSerialNumber: string;
      };
    };
  };
};

let directory: string;
let native: WindowsNativeModule;

function expectUnverifiable(run: () => unknown): void {
  try {
    run();
    expect.fail("Expected the native boundary to fail closed.");
  } catch (error) {
    expect((error as NativeFailure).code).toBe("SANDBOX_UNVERIFIABLE");
  }
}

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "cool-ai-native-root-"));
  mkdirSync(join(directory, "child"));
  const moduleId = "@/src/server/execution/windows-native-loader";
  try {
    native = await import(/* @vite-ignore */ moduleId) as WindowsNativeModule;
  } catch {
    expect.fail("The Windows x64 native loader capability is unavailable.");
  }
});

afterAll(() => {
  rmSync(directory, { force: true, recursive: true });
});

describe("Windows x64 native loader ABI", () => {
  it("pins every D-2 symbol, info class, flag, struct size, and offset", () => {
    expect(native.WINDOWS_NATIVE_CONSTANTS).toEqual(expect.objectContaining({
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
      infoClass: {
        FileBasicInfo: 0,
        FileStandardInfo: 1,
        FileIdInfo: 18,
        FileIdBothDirectoryInformation: 37,
        FileRenameInformationEx: 65,
        FileDispositionInformationEx: 64,
      },
      pathFlags: {
        FILE_NAME_NORMALIZED: 0,
        VOLUME_NAME_DOS: 0,
      },
    }));
    expect(native.WINDOWS_NATIVE_ABI).toEqual({
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
    });
  });
});

describe("Windows root handle capability", () => {
  it("opens a real supported root and proves identity, attributes, final path, and close", () => {
    const loader = native.createWindowsNativeLoader();
    expect(loader.capability(directory)).toEqual({
      supported: true,
      fileSystem: expect.stringMatching(/^(NTFS|ReFS)$/),
    });

    const root = loader.openRootDirectory(directory);
    expect(root.identity()).toEqual({
      volumeSerialNumber: expect.stringMatching(/^[0-9a-f]{16}$/),
      fileId: expect.stringMatching(/^[0-9a-f]{32}$/),
    });
    expect(root.attributes()).toEqual({
      directory: true,
      reparsePoint: false,
    });
    expect(root.finalPath().toLocaleLowerCase("en-US"))
      .toBe(realpathSync.native(directory).toLocaleLowerCase("en-US"));
    expect(() => root.close()).not.toThrow();
    expectUnverifiable(() => root.identity());
  });

  it("rejects unsupported platform, architecture, and filesystem without path fallback", () => {
    expectUnverifiable(() =>
      native.createWindowsNativeLoader({ platform: "linux" }).capability(directory));
    expectUnverifiable(() =>
      native.createWindowsNativeLoader({ arch: "arm64" }).capability(directory));
    expectUnverifiable(() =>
      native.createWindowsNativeLoader({
        loadLibrary: () => {
          throw new Error("native load disabled");
        },
      }).capability(directory));
  });

  it("maps symbol, ABI, struct, and close failures to SANDBOX_UNVERIFIABLE", () => {
    expectUnverifiable(() =>
      native.createWindowsNativeLoader({
        loadLibrary: () => ({ func: () => { throw new Error("missing symbol"); } }),
      }).capability(directory));
    expectUnverifiable(() =>
      native.createWindowsNativeLoader({
        expectedAbi: { pointerSize: 4 },
      }).capability(directory));
    expectUnverifiable(() =>
      native.createWindowsNativeLoader({
        expectedAbi: { structSizes: { FILE_ID_INFO: 16 } },
      }).capability(directory));

    const root = native.createWindowsNativeLoader({
      closeHandle: () => false,
    }).openRootDirectory(directory);
    expectUnverifiable(() => root.close());
  });
});
