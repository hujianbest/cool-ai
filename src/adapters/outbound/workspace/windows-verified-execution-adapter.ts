import "server-only";

import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute } from "node:path";

import type {
  SandboxDirectoryEntry,
  SandboxFileHandleAdapter,
  SandboxHandleIdentity,
} from "@/src/adapters/outbound/workspace/file-tools";
import type {
  ExecutionStagingAdapter,
  StagingEntry,
} from "@/src/adapters/outbound/sqlite/safe-execution/stage-service";
import type {
  VerifiedSandboxManifest,
  VerifiedSandboxManifestEntry,
} from "@/src/adapters/outbound/workspace/sandbox-manifest-store";
export type {
  VerifiedSandboxManifest,
  VerifiedSandboxManifestEntry,
} from "@/src/adapters/outbound/workspace/sandbox-manifest-store";
import { ExecutionError } from "@/src/modules/safe-execution";
import { createWindowsNativeReadAdapter } from "@/src/adapters/outbound/workspace/windows-native-read-adapter";
import { createWindowsNativeWriteAdapter } from "@/src/adapters/outbound/workspace/windows-native-write-adapter";
import {
  createPosixNativeReadAdapter,
} from "@/src/adapters/outbound/workspace/posix-native-read-adapter";
import {
  createPosixNativeWriteAdapter,
} from "@/src/adapters/outbound/workspace/posix-native-write-adapter";

type NativeReadAdapter = ReturnType<typeof createWindowsNativeReadAdapter>;

/**
 * The verified execution surface is platform-neutral: it walks and manifests
 * through the structural read/write adapter contracts that the Windows and
 * macOS native layers both implement.
 */
export type VerifiedAdapterCore<Handle> = {
  identityKey(identity: { fileId: string; volumeSerialNumber: string }): string;
  read: {
    attributes(handle: Handle): {
      directory: boolean;
      reparsePoint: boolean;
      size: number;
    };
    close(handle: Handle): void;
    identity(handle: Handle): { fileId: string; volumeSerialNumber: string };
    list(handle: Handle): Array<{
      attributes: { directory: boolean; reparsePoint: boolean };
      identity: { fileId: string; volumeSerialNumber: string };
      name: string;
      size: number;
    }>;
    finalPath(handle: Handle): string;
    openChildDirectoryNoFollow(parent: Handle, name: string): Handle;
    openFileNoFollow(parent: Handle, name: string): Handle;
    openRootDirectory(root: string): Handle;
    readFromHandle(handle: Handle, maximumBytes: number): Uint8Array;
  };
  write: {
    deleteVerifiedFile(
      rootPath: string,
      segments: string[],
      expectedHash: string,
    ): void;
    writeVerifiedFile(
      rootPath: string,
      segments: string[],
      bytes: Uint8Array,
      expectedHash: string | null,
    ): { hash: string; identity: { fileId: string; volumeSerialNumber: string } };
  };
};

export type VerifiedFileAdapter =
  SandboxFileHandleAdapter<unknown> & {
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
    refreshSandboxManifest(input: {
      sandboxRoot: string;
    }): Promise<VerifiedSandboxManifest>;
  };

/** Back-compat alias: the verified file surface is platform-neutral. */
export type WindowsVerifiedFileAdapter = VerifiedFileAdapter;

function identityKey(identity: { fileId: string; volumeSerialNumber: string }): string {
  return `${identity.volumeSerialNumber}:${identity.fileId}`;
}

function toIdentity<Handle>(
  native: VerifiedAdapterCore<Handle>["read"],
  identityKeyOf: VerifiedAdapterCore<Handle>["identityKey"],
  handle: Handle,
): SandboxHandleIdentity {
  const attributes = native.attributes(handle);
  return {
    finalPath: native.finalPath(handle),
    identity: identityKeyOf(native.identity(handle)),
    kind: attributes.reparsePoint
      ? "reparse"
      : attributes.directory
        ? "directory"
        : "file",
    size: attributes.directory ? 0 : attributes.size,
  };
}

function createFileAdapter<Handle>(
  core: VerifiedAdapterCore<Handle>,
): VerifiedFileAdapter {
  const read = core.read;
  const write = core.write;
  const adapter: SandboxFileHandleAdapter<Handle> & {
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
    refreshSandboxManifest(input: { sandboxRoot: string }): Promise<VerifiedSandboxManifest>;
  } = {
    async close(handle) {
      read.close(handle);
    },
    async currentIdentity(handle) {
      return toIdentity(read, core.identityKey, handle);
    },
    async identity(handle) {
      return toIdentity(read, core.identityKey, handle);
    },
    async list(handle): Promise<SandboxDirectoryEntry[]> {
      return read.list(handle).map((entry) => ({
        identity: core.identityKey(entry.identity),
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
    async refreshSandboxManifest(input) {
      return refreshSandboxManifest({
        fileAdapter: this,
        sandboxRoot: input.sandboxRoot,
      });
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
        identity: core.identityKey(result.identity),
      };
    },
  };
  // Method bivariance makes the Handle-typed surface assignable to the
  // platform-neutral unknown-handle contract.
  return adapter;
}

function failStage(message: string): never {
  throw new ExecutionError("SANDBOX_UNVERIFIABLE", 422, message);
}

function stagingEntry(path: string, identity: string, bytes: Uint8Array): StagingEntry {
  let content: string | undefined;
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!decoded.includes("\0")) content = decoded;
  } catch {
    // Binary content remains hashable but is never exposed as text.
  }
  return {
    ...(content === undefined ? {} : { content }),
    identity,
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
  const owned: unknown[] = [rootHandle];
  try {
    const walk = async function* (
      directory: unknown,
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
          yield stagingEntry(path, opened.identity, bytes);
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

export async function refreshSandboxManifest(input: {
  fileAdapter: WindowsVerifiedFileAdapter;
  sandboxRoot: string;
}): Promise<VerifiedSandboxManifest> {
  const entries: VerifiedSandboxManifestEntry[] = [];
  const stagingEntries: StagingEntry[] = [];
  for await (const entry of walkVerifiedTree(input.fileAdapter, input.sandboxRoot)) {
    stagingEntries.push(entry);
    entries.push({
      identity: entry.identity!,
      modeTag: entry.modeTag,
      path: entry.path,
      sha256: entry.sha256,
      size: entry.size,
    });
  }
  entries.sort((left, right) =>
    Buffer.from(left.path, "utf8").compare(Buffer.from(right.path, "utf8")));
  return {
    entries,
    hash: createHash("sha256").update(JSON.stringify(
      entries.map(({ identity: _identity, ...entry }) => entry),
    )).digest("hex"),
    stagingEntries,
  };
}

async function* verifiedManifestEntries(
  fileAdapter: WindowsVerifiedFileAdapter,
  manifestPath: string | null,
  label: "baseline" | "current",
): AsyncIterable<StagingEntry> {
  if (!manifestPath || !isAbsolute(manifestPath)) {
    return failStage(`The ${label} manifest path is unavailable.`);
  }
  const bytes = await readVerifiedAbsoluteFile(fileAdapter, manifestPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return failStage(`The ${label} manifest is invalid.`);
  }
  const entries = (parsed as { entries?: unknown })?.entries;
  if (!Array.isArray(entries)) return failStage(`The ${label} manifest entries are unavailable.`);
  const record = parsed as Record<string, unknown>;
  if (
    !record
    || typeof record !== "object"
    || Array.isArray(record)
    || Object.keys(record).sort().join(",") !== "entries,hash"
    || typeof record.hash !== "string"
    || !/^[0-9a-f]{64}$/u.test(record.hash)
  ) return failStage(`The ${label} manifest envelope is invalid.`);
  const validated: VerifiedSandboxManifestEntry[] = [];
  for (const value of entries) {
    const file = value as Partial<StagingEntry>;
    if (
      !file
      || typeof file !== "object"
      || Array.isArray(file)
      || Object.keys(file).sort().join(",") !== "identity,modeTag,path,sha256,size"
      || typeof file.identity !== "string"
      || file.identity.length === 0
      || typeof file.modeTag !== "string"
      || typeof file.path !== "string"
      || typeof file.sha256 !== "string"
      || typeof file.size !== "number"
    ) return failStage(`A ${label} manifest entry is invalid.`);
    validated.push({
      identity: file.identity,
      modeTag: file.modeTag,
      path: file.path,
      sha256: file.sha256,
      size: file.size,
    });
  }
  const expectedHash = createHash("sha256").update(JSON.stringify(
    validated.map(({ identity: _identity, ...entry }) => entry),
  )).digest("hex");
  if ((parsed as { hash: string }).hash !== expectedHash) {
    return failStage(`The ${label} manifest hash is inconsistent.`);
  }
  for (const file of validated) {
    yield { ...file, kind: "text" };
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
  let file: unknown = null;
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

export function createVerifiedExecutionAdapters<Handle>(
  core: VerifiedAdapterCore<Handle>,
): {
  fileAdapter: VerifiedFileAdapter;
  stagingAdapter: ExecutionStagingAdapter;
} {
  const fileAdapter = createFileAdapter(core);
  const stagingAdapter: ExecutionStagingAdapter = {
    baselineEntries(input) {
      return verifiedManifestEntries(fileAdapter, input.baselineManifestPath, "baseline");
    },
    canonicalEntries(input) {
      return walkVerifiedTree(fileAdapter, input.workspaceRoot);
    },
    currentEntries(input) {
      return verifiedManifestEntries(fileAdapter, input.sandboxManifestPath, "current");
    },
    refreshSandboxManifest(input) {
      return refreshSandboxManifest({
        fileAdapter,
        sandboxRoot: input.sandboxRoot,
      });
    },
    sandboxEntries(input) {
      return walkVerifiedTree(fileAdapter, input.sandboxRoot);
    },
  };
  return { fileAdapter, stagingAdapter };
}

export function createWindowsVerifiedExecutionAdapters() {
  return createVerifiedExecutionAdapters({
    identityKey,
    read: createWindowsNativeReadAdapter(),
    write: createWindowsNativeWriteAdapter(),
  });
}

export function createPosixVerifiedExecutionAdapters() {
  return createVerifiedExecutionAdapters({
    identityKey,
    read: createPosixNativeReadAdapter(),
    write: createPosixNativeWriteAdapter(),
  });
}

/**
 * Platform router for the verified execution surface: macOS uses the posix
 * native layer; Windows keeps its own; other platforms fail closed inside the
 * native adapters with SANDBOX_UNVERIFIABLE.
 */
export function createPlatformVerifiedExecutionAdapters() {
  return process.platform === "darwin"
    ? createPosixVerifiedExecutionAdapters()
    : createWindowsVerifiedExecutionAdapters();
}
