import "server-only";

import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute } from "node:path";

import type {
  SandboxDirectoryEntry,
  SandboxFileHandleAdapter,
  SandboxHandleIdentity,
} from "@/src/server/execution/file-tools";
import type {
  ExecutionStagingAdapter,
  StagingEntry,
} from "@/src/server/execution/stage-service";
import { ExecutionError } from "@/src/server/execution/execution-service";
import { createWindowsNativeReadAdapter } from "@/src/server/execution/windows-native-read-adapter";
import { createWindowsNativeWriteAdapter } from "@/src/server/execution/windows-native-write-adapter";

type NativeReadAdapter = ReturnType<typeof createWindowsNativeReadAdapter>;
type NativeHandle = ReturnType<NativeReadAdapter["openRootDirectory"]>;

export type WindowsVerifiedFileAdapter =
  SandboxFileHandleAdapter<NativeHandle> & {
    deleteNativeVerifiedFile(input: {
      expectedHash: string;
      pathSegments: string[];
      sandboxRoot: string;
    }): void;
    writeNativeVerifiedFile(input: {
      bytes: Uint8Array;
      expectedHash: string | null;
      pathSegments: string[];
      sandboxRoot: string;
    }): { hash: string; identity: string };
  };

function identityKey(identity: { fileId: string; volumeSerialNumber: string }): string {
  return `${identity.volumeSerialNumber}:${identity.fileId}`;
}

function toIdentity(
  native: NativeReadAdapter,
  handle: NativeHandle,
): SandboxHandleIdentity {
  const attributes = native.attributes(handle);
  return {
    finalPath: native.finalPath(handle),
    identity: identityKey(native.identity(handle)),
    kind: attributes.reparsePoint
      ? "reparse"
      : attributes.directory
        ? "directory"
        : "file",
    size: attributes.directory ? 0 : attributes.size,
  };
}

function createFileAdapter(): WindowsVerifiedFileAdapter {
  const read = createWindowsNativeReadAdapter();
  const write = createWindowsNativeWriteAdapter();
  return {
    async close(handle) {
      read.close(handle);
    },
    async currentIdentity(handle) {
      return toIdentity(read, handle);
    },
    async identity(handle) {
      return toIdentity(read, handle);
    },
    async list(handle): Promise<SandboxDirectoryEntry[]> {
      return read.list(handle).map((entry) => ({
        identity: identityKey(entry.identity),
        name: entry.name,
      }));
    },
    async openChildNoFollow(parent, name) {
      const entry = read.list(parent).find((candidate) => candidate.name === name);
      if (!entry || entry.attributes.reparsePoint) {
        throw new ExecutionError(
          "SANDBOX_UNVERIFIABLE",
          422,
          "A verified relative entry is unavailable.",
        );
      }
      return entry.attributes.directory
        ? read.openChildDirectoryNoFollow(parent, name)
        : read.openFileNoFollow(parent, name);
    },
    async openRootDirectory(root) {
      return read.openRootDirectory(root);
    },
    async readFromHandle(handle, maximumBytes) {
      return read.readFromHandle(handle, maximumBytes);
    },
    deleteNativeVerifiedFile(input) {
      write.deleteVerifiedFile(
        input.sandboxRoot,
        input.pathSegments,
        input.expectedHash,
      );
    },
    writeNativeVerifiedFile(input) {
      const result = write.writeVerifiedFile(
        input.sandboxRoot,
        input.pathSegments,
        input.bytes,
        input.expectedHash,
      );
      return {
        hash: result.hash,
        identity: identityKey(result.identity),
      };
    },
  };
}

function failStage(message: string): never {
  throw new ExecutionError("SANDBOX_UNVERIFIABLE", 422, message);
}

function stagingEntry(path: string, bytes: Uint8Array): StagingEntry {
  let content: string | undefined;
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!decoded.includes("\0")) content = decoded;
  } catch {
    // Binary content remains hashable but is never exposed as text.
  }
  return {
    ...(content === undefined ? {} : { content }),
    kind: content === undefined ? "binary" : "text",
    modeTag: "file",
    path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.byteLength,
  };
}

async function* walkVerifiedTree(
  fileAdapter: WindowsVerifiedFileAdapter,
  root: string,
): AsyncIterable<StagingEntry> {
  const rootHandle = await fileAdapter.openRootDirectory(root).catch(() => null);
  if (!rootHandle) return failStage("The staged root could not be opened.");
  const owned: NativeHandle[] = [rootHandle];
  try {
    const walk = async function* (
      directory: NativeHandle,
      relativeDirectory: string,
    ): AsyncIterable<StagingEntry> {
      const before = await fileAdapter.currentIdentity(directory);
      const entries = await fileAdapter.list(directory);
      for (const entry of entries) {
        const child = await fileAdapter.openChildNoFollow(directory, entry.name);
        owned.push(child);
        const opened = await fileAdapter.identity(child);
        if (opened.identity !== entry.identity) {
          return failStage("A staged entry changed between list and relative open.");
        }
        const path = relativeDirectory
          ? `${relativeDirectory}/${entry.name}`
          : entry.name;
        if (opened.kind === "directory") {
          yield* walk(child, path);
        } else if (opened.kind === "file") {
          const bytes = await fileAdapter.readFromHandle(child, 1_048_577);
          const after = await fileAdapter.currentIdentity(child);
          if (
            after.identity !== opened.identity
            || after.finalPath !== opened.finalPath
            || after.size !== opened.size
            || bytes.byteLength !== opened.size
          ) {
            return failStage("A staged file changed during verified reading.");
          }
          yield stagingEntry(path, bytes);
        } else {
          return failStage("A staged entry is not an ordinary file or directory.");
        }
      }
      const after = await fileAdapter.currentIdentity(directory);
      if (
        after.identity !== before.identity
        || after.finalPath !== before.finalPath
      ) {
        return failStage("A staged directory changed during enumeration.");
      }
    };
    yield* walk(rootHandle, "");
  } finally {
    let closeFailure = false;
    for (const handle of owned.reverse()) {
      try {
        await fileAdapter.close(handle);
      } catch {
        closeFailure = true;
      }
    }
    if (closeFailure) failStage("A staged verified handle could not be closed.");
  }
}

async function* baselineManifestEntries(
  fileAdapter: WindowsVerifiedFileAdapter,
  manifestPath: string | null,
): AsyncIterable<StagingEntry> {
  if (!manifestPath || !isAbsolute(manifestPath)) {
    return failStage("The baseline manifest path is unavailable.");
  }
  const bytes = await readVerifiedAbsoluteFile(fileAdapter, manifestPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return failStage("The baseline manifest is invalid.");
  }
  const files = (parsed as { files?: unknown })?.files;
  if (!Array.isArray(files)) return failStage("The baseline manifest files are unavailable.");
  for (const value of files) {
    const file = value as Partial<StagingEntry>;
    if (
      typeof file.path !== "string"
      || typeof file.sha256 !== "string"
      || typeof file.size !== "number"
    ) return failStage("A baseline manifest entry is invalid.");
    yield {
      kind: "text",
      modeTag: typeof file.modeTag === "string" ? file.modeTag : "file",
      path: file.path,
      sha256: file.sha256,
      size: file.size,
    };
  }
}

async function readVerifiedAbsoluteFile(
  fileAdapter: WindowsVerifiedFileAdapter,
  path: string,
): Promise<Uint8Array> {
  const root = dirname(path);
  const name = basename(path);
  const parent = await fileAdapter.openRootDirectory(root).catch(() => null);
  if (!parent) return failStage("A verified manifest parent could not be opened.");
  let file: NativeHandle | null = null;
  try {
    const listed = await fileAdapter.list(parent);
    const expected = listed.find((entry) => entry.name === name);
    if (!expected) return failStage("A verified manifest file is missing.");
    file = await fileAdapter.openChildNoFollow(parent, name);
    const before = await fileAdapter.identity(file);
    if (before.kind !== "file" || before.identity !== expected.identity) {
      return failStage("The verified manifest identity does not match.");
    }
    const bytes = await fileAdapter.readFromHandle(file, 16 * 1024 * 1024);
    const after = await fileAdapter.currentIdentity(file);
    if (
      before.identity !== after.identity
      || before.finalPath !== after.finalPath
      || before.size !== after.size
      || bytes.byteLength !== before.size
    ) return failStage("The verified manifest changed during reading.");
    return bytes;
  } finally {
    if (file) await fileAdapter.close(file).catch(() => failStage("The manifest handle close failed."));
    await fileAdapter.close(parent).catch(() => failStage("The manifest parent close failed."));
  }
}

export function createWindowsVerifiedExecutionAdapters(): {
  fileAdapter: WindowsVerifiedFileAdapter;
  stagingAdapter: ExecutionStagingAdapter;
} {
  const fileAdapter = createFileAdapter();
  const stagingAdapter: ExecutionStagingAdapter = {
    baselineEntries(input) {
      return baselineManifestEntries(fileAdapter, input.baselineManifestPath);
    },
    canonicalEntries(input) {
      return walkVerifiedTree(fileAdapter, input.workspaceRoot);
    },
    sandboxEntries(input) {
      return walkVerifiedTree(fileAdapter, input.sandboxRoot);
    },
  };
  return { fileAdapter, stagingAdapter };
}
