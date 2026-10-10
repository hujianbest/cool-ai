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

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  createPosixNativeReadAdapter,
} from "@/src/adapters/outbound/workspace/posix-native-read-adapter";
import { WindowsNativeError } from "@/src/modules/safe-execution";

const describePosix = process.platform === "darwin" ? describe : describe.skip;

function temporaryWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "cool-ai-posix-read-"));
}

describePosix("posix native read adapter", () => {
  it("proves root identity, attributes, final path, and close on a real root", () => {
    const root = temporaryWorkspace();
    const adapter = createPosixNativeReadAdapter();
    try {
      const handle = adapter.openRootDirectory(root);
      expect(handle.canonicalPathAtOpen).toBe(realpathSync(root));
      const identity = adapter.identity(handle);
      expect(identity.fileId).toMatch(/^[0-9a-f]{32}$/);
      expect(identity.volumeSerialNumber).toMatch(/^[0-9a-f]+$/);
      expect(adapter.attributes(handle)).toEqual({
        directory: true,
        reparsePoint: false,
        size: 0,
      });
      expect(adapter.finalPath(handle)).toBe(handle.canonicalPathAtOpen);
      adapter.close(handle);
      expect(() => adapter.identity(handle)).toThrow(WindowsNativeError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("lists entries with authoritative cross-checked identities", () => {
    const root = temporaryWorkspace();
    mkdirSync(join(root, "nested"));
    writeFileSync(join(root, "file.txt"), "hello");
    const adapter = createPosixNativeReadAdapter();
    try {
      const handle = adapter.openRootDirectory(root);
      const entries = adapter.list(handle);
      expect(entries.map((entry) => entry.name)).toEqual(["file.txt", "nested"]);
      const file = entries.find((entry) => entry.name === "file.txt")!;
      expect(file.attributes).toEqual({ directory: false, reparsePoint: false });
      expect(file.size).toBe(5);
      const nested = entries.find((entry) => entry.name === "nested")!;
      expect(nested.attributes.directory).toBe(true);

      const openedFile = adapter.openFileNoFollow(handle, "file.txt");
      expect(adapter.identity(openedFile).fileId).toBe(file.identity.fileId);
      expect(adapter.finalPath(openedFile)).toBe(join(handle.canonicalPathAtOpen, "file.txt"));
      const openedDir = adapter.openChildDirectoryNoFollow(handle, "nested");
      expect(adapter.finalPath(openedDir)).toBe(join(handle.canonicalPathAtOpen, "nested"));
      adapter.close(openedFile);
      adapter.close(openedDir);
      adapter.close(handle);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects symlinked children as reparse-equivalent entries", () => {
    const root = temporaryWorkspace();
    writeFileSync(join(root, "target.txt"), "x");
    symlinkSync("target.txt", join(root, "link.txt"));
    const adapter = createPosixNativeReadAdapter();
    try {
      const handle = adapter.openRootDirectory(root);
      const link = adapter.list(handle).find((entry) => entry.name === "link.txt")!;
      expect(link.attributes.reparsePoint).toBe(true);
      expect(() => adapter.openFileNoFollow(handle, "link.txt"))
        .toThrow(WindowsNativeError);
      expect(() => adapter.openChildDirectoryNoFollow(handle, "link.txt"))
        .toThrow(WindowsNativeError);
      adapter.close(handle);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a symlinked root and missing or invalid names", () => {
    const outer = temporaryWorkspace();
    const root = join(outer, "real");
    mkdirSync(root);
    symlinkSync(root, join(outer, "root-link"));
    const adapter = createPosixNativeReadAdapter();
    try {
      expect(() => adapter.openRootDirectory(join(outer, "root-link")))
        .toThrow(WindowsNativeError);
      const handle = adapter.openRootDirectory(root);
      for (const invalid of ["", ".", "..", "a/b", "missing", "a\0b"]) {
        expect(() => adapter.openFileNoFollow(handle, invalid)).toThrow(WindowsNativeError);
      }
      adapter.close(handle);
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  });

  it("reads a verified file through the verified chain and proves stability", () => {
    const root = temporaryWorkspace();
    mkdirSync(join(root, "nested"));
    writeFileSync(join(root, "nested", "file.txt"), "hello world");
    const adapter = createPosixNativeReadAdapter();
    try {
      const bytes = adapter.readVerifiedFile(root, ["nested", "file.txt"], 1024);
      expect(new TextDecoder().decode(bytes)).toBe("hello world");
      const entries = adapter.listVerifiedDirectory(root, ["nested"]);
      expect(entries.map((entry) => entry.name)).toEqual(["file.txt"]);
      expect(() => adapter.readVerifiedFile(root, ["nested", "missing.txt"], 1024))
        .toThrow(WindowsNativeError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("detects an entry swapped between list and relative open", () => {
    const root = temporaryWorkspace();
    writeFileSync(join(root, "file.txt"), "first");
    writeFileSync(join(root, "swap.txt"), "replaced content");
    const adapter = createPosixNativeReadAdapter({
      hooks: {
        beforeRelativeOpen(name) {
          if (name === "file.txt") {
            renameSync(join(root, "swap.txt"), join(root, "file.txt"));
          }
        },
      },
    });
    try {
      const handle = adapter.openRootDirectory(root);
      const listed = adapter.list(handle).find((entry) => entry.name === "file.txt")!;
      const opened = adapter.openFileNoFollow(handle, "file.txt");
      // The atomic rename swap installs a different inode, so the identity
      // observed at open disagrees with the listed identity.
      expect(opened.identityAtOpen.fileId).not.toBe(listed.identity.fileId);
      expect(adapter.attributes(opened).size).toBe(16);
      adapter.close(opened);
      adapter.close(handle);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
