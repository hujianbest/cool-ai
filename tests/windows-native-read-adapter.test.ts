import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

type NativeFailure = Error & { code?: string };
type Entry = {
  attributes: { directory: boolean; reparsePoint: boolean };
  identity: { fileId: string; volumeSerialNumber: string };
  name: string;
  size: number;
};
type AdapterOptions = {
  hooks?: {
    afterFileOpen?: (name: string) => void;
    afterFileRead?: (name: string) => void;
    beforeRelativeOpen?: (name: string, kind: "directory" | "file") => void;
    corruptDirectoryBuffer?: (buffer: Buffer, used: number) => void;
    maximumReadChunk?: number;
    onReadBytes?: (bytes: Uint8Array) => void;
  };
};
type ReadAdapter = {
  close(handle: unknown): void;
  finalPath(handle: unknown): string;
  identity(handle: unknown): Entry["identity"];
  list(handle: unknown): Entry[];
  listVerifiedDirectory(rootPath: string, segments: string[]): Entry[];
  openChildDirectoryNoFollow(parent: unknown, name: string): unknown;
  openFileNoFollow(parent: unknown, name: string): unknown;
  openRootDirectory(path: string): unknown;
  readFromHandle(handle: unknown, maximumBytes: number): Uint8Array;
  readVerifiedFile(rootPath: string, segments: string[], maximumBytes: number): Uint8Array;
};
type NativeModule = {
  createWindowsNativeReadAdapter(options?: AdapterOptions): ReadAdapter;
};

let directory: string;
let native: NativeModule;

function expectUnverifiable(run: () => unknown): void {
  try {
    run();
    expect.fail("Expected the native read adapter to fail closed.");
  } catch (error) {
    expect((error as NativeFailure).code).toBe("SANDBOX_UNVERIFIABLE");
  }
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "cool-ai-native-read-"));
  const moduleId = "@/src/server/execution/windows-native-read-adapter";
  try {
    native = await import(/* @vite-ignore */ moduleId) as NativeModule;
  } catch {
    expect.fail("The Windows handle-relative read adapter is unavailable.");
  }
});

afterEach(() => {
  rmSync(directory, { force: true, recursive: true });
});

describe("Windows handle-relative read adapter", () => {
  it("lists with NtQueryDirectoryFile and reads every short ReadFile transfer", () => {
    mkdirSync(join(directory, "folder"));
    writeFileSync(join(directory, "folder", "alpha.txt"), "abcdefghij");
    writeFileSync(join(directory, "folder", "beta.txt"), "beta");
    const chunks: number[] = [];
    const adapter = native.createWindowsNativeReadAdapter({
      hooks: {
        maximumReadChunk: 3,
        onReadBytes: (bytes) => chunks.push(bytes.byteLength),
      },
    });

    const root = adapter.openRootDirectory(directory);
    const folder = adapter.openChildDirectoryNoFollow(root, "folder");
    const entries = adapter.list(folder);
    expect(entries.map((entry) => entry.name)).toEqual(["alpha.txt", "beta.txt"]);
    expect(entries.every((entry) => /^[0-9a-f]{32}$/.test(entry.identity.fileId))).toBe(true);

    const file = adapter.openFileNoFollow(folder, "alpha.txt");
    expect(Buffer.from(adapter.readFromHandle(file, 64)).toString()).toBe("abcdefghij");
    expect(chunks).toEqual([3, 3, 3, 1]);
    expect(adapter.finalPath(file).toLocaleLowerCase("en-US"))
      .toBe(realpathSync.native(join(directory, "folder", "alpha.txt")).toLocaleLowerCase("en-US"));
    adapter.close(file);
    adapter.close(folder);
    adapter.close(root);
    expectUnverifiable(() => adapter.identity(file));
  });

  it("rejects junctions, reparse points, and non-file targets", () => {
    mkdirSync(join(directory, "outside"));
    writeFileSync(join(directory, "outside", "secret.txt"), "secret");
    symlinkSync(join(directory, "outside"), join(directory, "junction"), "junction");
    const adapter = native.createWindowsNativeReadAdapter();
    const root = adapter.openRootDirectory(directory);

    expectUnverifiable(() => adapter.openChildDirectoryNoFollow(root, "junction"));
    expectUnverifiable(() => adapter.openFileNoFollow(root, "junction"));
    expectUnverifiable(() => adapter.openFileNoFollow(root, "outside"));
    adapter.close(root);
  });

  it("rechecks parent and file identity before reading replacement bytes", () => {
    mkdirSync(join(directory, "parent"));
    writeFileSync(join(directory, "parent", "safe.txt"), "public");
    writeFileSync(join(directory, "secret.txt"), "SECRET-BYTES");
    let secretBytesRead = 0;
    const adapter = native.createWindowsNativeReadAdapter({
      hooks: {
        beforeRelativeOpen(name, kind) {
          if (name === "safe.txt" && kind === "file") {
            rmSync(join(directory, "parent", "safe.txt"));
            renameSync(join(directory, "secret.txt"), join(directory, "parent", "safe.txt"));
          }
        },
        onReadBytes(bytes) {
          if (Buffer.from(bytes).includes(Buffer.from("SECRET-BYTES"))) {
            secretBytesRead += bytes.byteLength;
          }
        },
      },
    });

    expectUnverifiable(() =>
      adapter.readVerifiedFile(directory, ["parent", "safe.txt"], 1024));
    expect(secretBytesRead).toBe(0);
  });

  it("rejects parent rename and file replacement races while retaining ancestor handles", () => {
    mkdirSync(join(directory, "parent"));
    writeFileSync(join(directory, "parent", "safe.txt"), "public");
    let renamed = false;
    const adapter = native.createWindowsNativeReadAdapter({
      hooks: {
        beforeRelativeOpen(name, kind) {
          if (!renamed && name === "safe.txt" && kind === "file") {
            renamed = true;
            renameSync(join(directory, "parent"), join(directory, "moved"));
            mkdirSync(join(directory, "parent"));
            writeFileSync(join(directory, "parent", "safe.txt"), "SECRET-BYTES");
          }
        },
      },
    });

    expectUnverifiable(() =>
      adapter.readVerifiedFile(directory, ["parent", "safe.txt"], 1024));
  });

  it("rejects malformed native directory buffers and closes every owned handle once", () => {
    mkdirSync(join(directory, "folder"));
    writeFileSync(join(directory, "folder", "safe.txt"), "safe");
    const adapter = native.createWindowsNativeReadAdapter({
      hooks: {
        corruptDirectoryBuffer(buffer, used) {
          if (used >= 4) buffer.writeUInt32LE(used + 8, 0);
        },
      },
    });
    const root = adapter.openRootDirectory(directory);
    const folder = adapter.openChildDirectoryNoFollow(root, "folder");

    expectUnverifiable(() => adapter.list(folder));
    expect(() => adapter.close(folder)).not.toThrow();
    expectUnverifiable(() => adapter.close(folder));
    expect(() => adapter.close(root)).not.toThrow();
  });

  it("rechecks file and ancestors after EOF and closes high-level owned handles on failure", () => {
    mkdirSync(join(directory, "parent"));
    writeFileSync(join(directory, "parent", "safe.txt"), "public");
    let replaced = false;
    const adapter = native.createWindowsNativeReadAdapter({
      hooks: {
        afterFileRead(name) {
          if (!replaced && name === "safe.txt") {
            replaced = true;
            renameSync(
              join(directory, "parent", "safe.txt"),
              join(directory, "parent", "moved.txt"),
            );
          }
        },
      },
    });

    expectUnverifiable(() =>
      adapter.readVerifiedFile(directory, ["parent", "safe.txt"], 1024));
  });
});
