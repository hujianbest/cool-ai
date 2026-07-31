import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  mkdir,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { once } from "node:events";

import {
  SANDBOX_MAX_BYTES,
  SANDBOX_MAX_ENTRIES,
  createDefaultSandboxFsAdapter,
  type SandboxFsAdapter,
  type SandboxListedEntry,
  type SandboxPreflightEntry,
  type SandboxPreflightResult,
} from "@/src/server/execution/sandbox-preflight";

export type SandboxSnapshotPlatformAdapter = SandboxFsAdapter;

export type SandboxSnapshotPhase =
  | "parents-verified"
  | "before-source-open"
  | "source-opened"
  | "source-read"
  | "source-reverified"
  | "destination-synced"
  | "sandbox-renamed";

export type SandboxSnapshotHooks = {
  onPhase?: (phase: SandboxSnapshotPhase, path?: string) => void | Promise<void>;
};

export type SandboxSnapshotFile = {
  identity: string;
  modeTag: string;
  path: string;
  sha256: string;
  size: number;
};

export type SandboxSnapshotResult = {
  files: SandboxSnapshotFile[];
  itemCount: number;
  manifestHash: string;
  rootIdentity: string;
  sandboxFiles: SandboxSnapshotFile[];
  totalBytes: number;
};

export class SandboxSnapshotError extends Error {
  constructor(
    public readonly code:
      | "SANDBOX_DESTINATION_EXISTS"
      | "SANDBOX_LIMIT_EXCEEDED"
      | "SANDBOX_SOURCE_MISMATCH"
      | "SANDBOX_UNVERIFIABLE",
    message: string,
  ) {
    super(message);
    this.name = "SandboxSnapshotError";
  }
}

function mismatch(message: string): never {
  throw new SandboxSnapshotError("SANDBOX_SOURCE_MISMATCH", message);
}

function unverifiable(message: string): never {
  throw new SandboxSnapshotError("SANDBOX_UNVERIFIABLE", message);
}

function identityKey(identity: unknown): string {
  if (typeof identity === "string" && identity.length > 0) return identity;
  if (
    identity
    && typeof identity === "object"
    && typeof (identity as { fileId?: unknown }).fileId === "string"
    && typeof (identity as { volumeSerialNumber?: unknown }).volumeSerialNumber === "string"
  ) {
    const value = identity as { fileId: string; volumeSerialNumber: string };
    if (value.fileId && value.volumeSerialNumber) {
      return `${value.volumeSerialNumber}:${value.fileId}`;
    }
  }
  return unverifiable("The verified adapter returned an invalid identity.");
}

function comparablePath(path: string): string {
  const normalized = resolve(path).replace(/[\\/]+$/, "");
  return process.platform === "win32"
    ? normalized.toLocaleLowerCase("en-US")
    : normalized;
}

function isWithinRoot(path: string, root: string): boolean {
  const child = comparablePath(path);
  const ancestor = comparablePath(root);
  return child === ancestor || child.startsWith(`${ancestor}${sep}`);
}

async function adapterCall<T>(message: string, action: () => T | Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof SandboxSnapshotError) throw error;
    return unverifiable(message);
  }
}

async function closeHandle(platform: SandboxFsAdapter, handle: unknown): Promise<void> {
  await adapterCall("A verified handle could not be closed.", () => platform.close(handle));
}

async function inspectHandle(
  platform: SandboxFsAdapter,
  handle: unknown,
  kind: "directory" | "file",
  rootFinalPath: string,
): Promise<{ finalPath: string; identity: string; size: number }> {
  return adapterCall("A verified handle could not be inspected.", async () => {
    const attributes = await platform.attributes(handle);
    const finalPath = await platform.finalPath(handle);
    const identity = identityKey(await platform.identity(handle));
    if (
      attributes.reparsePoint
      || attributes.directory !== (kind === "directory")
      || !Number.isSafeInteger(attributes.size)
      || attributes.size < 0
      || !isWithinRoot(finalPath, rootFinalPath)
    ) {
      mismatch("A verified source object is no longer ordinary or inside its root.");
    }
    return { finalPath, identity, size: kind === "file" ? attributes.size : 0 };
  });
}

function nativeRelative(relativePath: string): string {
  return relativePath.split("/").join(sep);
}

function expectedIdentityMap(preflight: SandboxPreflightResult) {
  const expected = new Map<string, SandboxPreflightEntry>();
  expected.set("", {
    identity: preflight.rootIdentity,
    kind: "directory",
    path: "",
    size: 0,
  });
  for (const entry of preflight.entries) expected.set(entry.path, entry);
  return expected;
}

function listedIdentity(entry: SandboxListedEntry): string {
  if (entry.attributes.reparsePoint) mismatch("A listed source entry became a reparse point.");
  return identityKey(entry.identity);
}

async function openVerifiedPath(input: {
  expected: Map<string, SandboxPreflightEntry>;
  platform: SandboxFsAdapter;
  relativePath: string;
  rootHandle: unknown;
  rootFinalPath: string;
}): Promise<{ handles: unknown[]; target: unknown }> {
  const { expected, platform, relativePath, rootHandle, rootFinalPath } = input;
  const handles: unknown[] = [];
  let parent = rootHandle;
  let currentPath = "";
  try {
    const segments = relativePath.split("/").filter(Boolean);
    for (let index = 0; index < segments.length; index += 1) {
      const name = segments[index]!;
      const path = currentPath ? `${currentPath}/${name}` : name;
      const manifestEntry = expected.get(path);
      if (!manifestEntry) mismatch("The preflight manifest is missing a source entry.");
      const listed = await adapterCall(
        "A verified source parent could not be listed.",
        () => platform.list(parent),
      );
      const directoryEntry = listed.find((entry) => entry.name === name);
      if (!directoryEntry || listedIdentity(directoryEntry) !== manifestEntry.identity) {
        mismatch("A source entry changed between preflight and snapshot.");
      }
      const isTarget = index === segments.length - 1;
      const kind = isTarget ? manifestEntry.kind : "directory";
      let child: unknown;
      child = await adapterCall(
        "A source entry could not be opened relative to its verified parent.",
        () => kind === "directory"
          ? platform.openChildDirectoryNoFollow(parent, name)
          : platform.openFileNoFollow(parent, name),
      );
      handles.push(child);
      const actual = await inspectHandle(platform, child, kind, rootFinalPath);
      if (
        actual.identity !== manifestEntry.identity
        || (kind === "file" && actual.size !== manifestEntry.size)
      ) {
        mismatch("A source entry changed after relative open.");
      }
      parent = child;
      currentPath = path;
    }
    return { handles, target: parent };
  } catch (error) {
    for (const handle of handles.reverse()) {
      await closeHandle(platform, handle).catch(() => undefined);
    }
    throw error;
  }
}

async function closePathHandles(platform: SandboxFsAdapter, handles: unknown[]): Promise<void> {
  let failure: unknown;
  while (handles.length > 0) {
    const handle = handles.pop()!;
    try {
      await closeHandle(platform, handle);
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure) throw failure;
}

async function runHook(
  hooks: SandboxSnapshotHooks | undefined,
  phase: SandboxSnapshotPhase,
  path?: string,
): Promise<void> {
  await hooks?.onPhase?.(phase, path);
}

async function writeVerifiedSource(input: {
  destinationPath: string;
  entry: SandboxPreflightEntry;
  expected: Map<string, SandboxPreflightEntry>;
  hooks?: SandboxSnapshotHooks;
  platform: SandboxFsAdapter;
  rootHandle: unknown;
  rootFinalPath: string;
}): Promise<SandboxSnapshotFile> {
  const { destinationPath, entry, expected, hooks, platform, rootHandle, rootFinalPath } = input;
  if (!platform.readFromHandle) unverifiable("The verified adapter cannot read from handles.");
  await runHook(hooks, "parents-verified", entry.path);
  await runHook(hooks, "before-source-open", entry.path);
  const opened = await openVerifiedPath({
    expected,
    platform,
    relativePath: entry.path,
    rootFinalPath,
    rootHandle,
  });
  await runHook(hooks, "source-opened", entry.path);
  const temporaryPath = `${destinationPath}.tmp-${randomUUID()}`;
  let stream: ReturnType<typeof createWriteStream> | undefined;
  try {
    await mkdir(dirname(destinationPath), { recursive: true });
    stream = createWriteStream(temporaryPath, { flags: "wx", mode: 0o600 });
    await once(stream, "open");
    const digest = createHash("sha256");
    let total = 0;
    while (true) {
      const bytes = await adapterCall(
        "ReadFile failed while copying the verified source handle.",
        () => platform.readFromHandle!(opened.target, 64 * 1024),
      );
      if (bytes.byteLength === 0) break;
      total += bytes.byteLength;
      if (total > entry.size || total > SANDBOX_MAX_BYTES) {
        mismatch("A source file exceeded its preflight size.");
      }
      digest.update(bytes);
      if (!stream.write(bytes)) await once(stream, "drain");
    }
    stream.end();
    await once(stream, "close");
    stream = undefined;
    await runHook(hooks, "source-read", entry.path);
    if (total !== entry.size) mismatch("A source file size changed while reading.");
    const after = await inspectHandle(platform, opened.target, "file", rootFinalPath);
    if (after.identity !== entry.identity || after.size !== entry.size) {
      mismatch("A source file changed while being copied.");
    }
    await runHook(hooks, "source-reverified", entry.path);
    await closePathHandles(platform, opened.handles);
    await rename(temporaryPath, destinationPath);
    await runHook(hooks, "destination-synced", entry.path);
    return {
      identity: entry.identity,
      modeTag: "file",
      path: entry.path,
      sha256: digest.digest("hex"),
      size: total,
    };
  } finally {
    stream?.destroy();
    await closePathHandles(platform, opened.handles).catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function verifyBuildingManifest(input: {
  expectedEntryCount: number;
  expectedFiles: SandboxSnapshotFile[];
  platform: SandboxFsAdapter;
  rootPath: string;
  totalBytes: number;
}): Promise<SandboxSnapshotFile[]> {
  const { expectedEntryCount, expectedFiles, platform, rootPath, totalBytes } = input;
  let rootHandle: unknown;
  try {
    rootHandle = await platform.openRootDirectory(rootPath);
  } catch {
    return unverifiable("The building root could not be opened for manifest verification.");
  }
  const rootFinalPath = await adapterCall(
    "The building root final path is unavailable.",
    () => platform.finalPath(rootHandle),
  );
  const manifestEntries = new Map<string, SandboxPreflightEntry>();
  manifestEntries.set("", {
    identity: identityKey(await platform.identity(rootHandle)),
    kind: "directory",
    path: "",
    size: 0,
  });
  let observedItems = 0;
  let observedBytes = 0;
  const sandboxFiles: SandboxSnapshotFile[] = [];

  async function walk(handle: unknown, relativeDirectory: string): Promise<void> {
    const entries = await adapterCall(
      "The building manifest could not be listed.",
      () => platform.list(handle),
    );
    for (const entry of entries) {
      observedItems += 1;
      if (observedItems > expectedEntryCount || entry.attributes.reparsePoint) {
        mismatch("The building manifest contains an unexpected entry.");
      }
      const path = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      manifestEntries.set(path, {
        identity: identityKey(entry.identity),
        kind: entry.attributes.directory ? "directory" : "file",
        path,
        size: entry.attributes.directory ? 0 : entry.size,
      });
      if (entry.attributes.directory) {
        const child = await adapterCall(
          "A building directory could not be opened relative to its parent.",
          () => platform.openChildDirectoryNoFollow(handle, entry.name),
        );
        try {
          await walk(child, path);
        } finally {
          await closeHandle(platform, child);
        }
      }
    }
  }

  try {
    await walk(rootHandle, "");
    const expected = new Map(expectedFiles.map((file) => [file.path, file]));
    for (const file of expectedFiles) {
      const opened = await openVerifiedPath({
        expected: manifestEntries,
        platform,
        relativePath: file.path,
        rootFinalPath,
        rootHandle,
      });
      try {
        const digest = createHash("sha256");
        let size = 0;
        while (true) {
          const bytes = await adapterCall(
            "The building file could not be read through its verified handle.",
            () => platform.readFromHandle!(opened.target, 64 * 1024),
          );
          if (bytes.byteLength === 0) break;
          size += bytes.byteLength;
          digest.update(bytes);
        }
        if (size !== file.size || digest.digest("hex") !== file.sha256) {
          mismatch("The copied file does not match its verified source bytes.");
        }
        observedBytes += size;
        sandboxFiles.push({
          ...file,
          identity: manifestEntries.get(file.path)!.identity,
        });
        expected.delete(file.path);
      } finally {
        await closePathHandles(platform, opened.handles);
      }
    }
    if (
      observedItems !== expectedEntryCount
      || observedBytes !== totalBytes
      || expected.size !== 0
    ) {
      mismatch("The building manifest does not match the preflight manifest.");
    }
    return sandboxFiles;
  } finally {
    await closeHandle(platform, rootHandle);
  }
}

export async function buildSandboxSnapshot(input: {
  hooks?: SandboxSnapshotHooks;
  platform?: SandboxSnapshotPlatformAdapter;
  preflight: SandboxPreflightResult;
  sandboxRoot: string;
  sourceRoot: string;
}): Promise<SandboxSnapshotResult> {
  const sourceRoot = resolve(input.sourceRoot);
  const sandboxRoot = resolve(input.sandboxRoot);
  const buildingRoot = `${sandboxRoot}.building`;
  if (
    input.preflight.itemCount > SANDBOX_MAX_ENTRIES
    || input.preflight.entries.length > SANDBOX_MAX_ENTRIES
    || input.preflight.totalBytes > SANDBOX_MAX_BYTES
  ) {
    throw new SandboxSnapshotError("SANDBOX_LIMIT_EXCEEDED", "The preflight manifest exceeds sandbox limits.");
  }
  const platform = input.platform ?? await createDefaultSandboxFsAdapter();
  let sourceHandle: unknown;
  try {
    sourceHandle = await platform.openRootDirectory(sourceRoot);
  } catch {
    return unverifiable("The source root could not be opened through the verified adapter.");
  }
  const rootFinalPath = await adapterCall(
    "The source root final path is unavailable.",
    () => platform.finalPath(sourceHandle),
  );
  const rootIdentity = identityKey(await adapterCall(
    "The source root identity is unavailable.",
    () => platform.identity(sourceHandle),
  ));
  if (rootIdentity !== input.preflight.rootIdentity) {
    await closeHandle(platform, sourceHandle);
    mismatch("The source root changed after preflight.");
  }

  const expected = expectedIdentityMap(input.preflight);
  let ownedBuilding = false;
  let ownedSandbox = false;
  try {
    await mkdir(dirname(buildingRoot), { recursive: true });
    try {
      await mkdir(buildingRoot, { recursive: false });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new SandboxSnapshotError(
          "SANDBOX_DESTINATION_EXISTS",
          "The sandbox destination already exists.",
        );
      }
      throw error;
    }
    ownedBuilding = true;
    const files: SandboxSnapshotFile[] = [];
    let totalBytes = 0;
    for (const entry of input.preflight.entries) {
      if (entry.kind === "directory") {
        const opened = await openVerifiedPath({
          expected,
          platform,
          relativePath: entry.path,
          rootFinalPath,
          rootHandle: sourceHandle,
        });
        await closePathHandles(platform, opened.handles);
        await mkdir(join(buildingRoot, nativeRelative(entry.path)), { recursive: false });
        continue;
      }
      const file = await writeVerifiedSource({
        destinationPath: join(buildingRoot, nativeRelative(entry.path)),
        entry,
        expected,
        hooks: input.hooks,
        platform,
        rootFinalPath,
        rootHandle: sourceHandle,
      });
      totalBytes += file.size;
      if (totalBytes > SANDBOX_MAX_BYTES) {
        throw new SandboxSnapshotError("SANDBOX_LIMIT_EXCEEDED", "Snapshot bytes exceed 2 GiB.");
      }
      files.push(file);
    }
    if (totalBytes !== input.preflight.totalBytes) {
      mismatch("Snapshot bytes do not match the preflight manifest.");
    }
    const sandboxFiles = await verifyBuildingManifest({
      expectedEntryCount: input.preflight.entries.length,
      expectedFiles: files,
      platform,
      rootPath: buildingRoot,
      totalBytes,
    });
    await rename(buildingRoot, sandboxRoot);
    ownedBuilding = false;
    ownedSandbox = true;
    await runHook(input.hooks, "sandbox-renamed");
    const manifestHash = createHash("sha256").update(JSON.stringify(
      files.map(({ identity: _identity, ...file }) => file),
    )).digest("hex");
    return {
      files,
      itemCount: input.preflight.itemCount,
      manifestHash,
      rootIdentity: input.preflight.rootIdentity,
      sandboxFiles,
      totalBytes,
    };
  } catch (error) {
    if (ownedBuilding) await rm(buildingRoot, { force: true, recursive: true }).catch(() => undefined);
    if (ownedSandbox) await rm(sandboxRoot, { force: true, recursive: true }).catch(() => undefined);
    if (error instanceof SandboxSnapshotError) throw error;
    throw new SandboxSnapshotError("SANDBOX_SOURCE_MISMATCH", "Sandbox snapshot verification failed.");
  } finally {
    await closeHandle(platform, sourceHandle);
  }
}

export async function cleanupOwnedSandbox(input: {
  expectedRootIdentity: string;
  platform?: SandboxSnapshotPlatformAdapter;
  sandboxRoot: string;
}): Promise<boolean> {
  const sandboxRoot = resolve(input.sandboxRoot);
  const platform = input.platform ?? await createDefaultSandboxFsAdapter();
  let rootHandle: unknown;
  try {
    rootHandle = await platform.openRootDirectory(sandboxRoot);
  } catch {
    return false;
  }
  try {
    if (identityKey(await platform.identity(rootHandle)) !== input.expectedRootIdentity) {
      return false;
    }
  } catch {
    return false;
  } finally {
    await closeHandle(platform, rootHandle).catch(() => undefined);
  }

  const quarantine = `${sandboxRoot}.cleanup-${randomUUID()}`;
  try {
    await rename(sandboxRoot, quarantine);
  } catch {
    return false;
  }
  let movedHandle: unknown;
  try {
    movedHandle = await platform.openRootDirectory(quarantine);
    if (identityKey(await platform.identity(movedHandle)) !== input.expectedRootIdentity) {
      await closeHandle(platform, movedHandle).catch(() => undefined);
      await rename(quarantine, sandboxRoot).catch(() => undefined);
      return false;
    }
    await closeHandle(platform, movedHandle);
    await rm(quarantine, { force: true, recursive: true });
    return true;
  } catch {
    await closeHandle(platform, movedHandle).catch(() => undefined);
    await rename(quarantine, sandboxRoot).catch(() => undefined);
    return false;
  }
}

export function sandboxDeadlineState(startedAtMs: number, nowMs: number): "expired" | "live" {
  return nowMs - startedAtMs >= 900_000 ? "expired" : "live";
}

export function sandboxLeaseExpiry(nowMs: number, overallDeadlineMs: number): number {
  return Math.min(nowMs + 120_000, overallDeadlineMs);
}
