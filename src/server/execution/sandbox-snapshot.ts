import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  mkdir,
  open,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

import {
  SANDBOX_MAX_BYTES,
  SANDBOX_MAX_ENTRIES,
  nodeSandboxIdentityAdapter,
  type SandboxEntryKind,
  type SandboxPreflightEntry,
  type SandboxPreflightResult,
  type SandboxProvenIdentity,
} from "@/src/server/execution/sandbox-preflight";

export type SandboxSnapshotHandle = FileHandle;

export type SandboxSnapshotPlatformAdapter = {
  inspectHandle(handle: SandboxSnapshotHandle): Promise<SandboxProvenIdentity>;
  inspectPath(path: string): Promise<SandboxProvenIdentity>;
  openNoFollow(path: string): Promise<SandboxSnapshotHandle>;
};

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
  hash: string;
  path: string;
  size: number;
};

export type SandboxSnapshotResult = {
  files: SandboxSnapshotFile[];
  itemCount: number;
  manifestHash: string;
  rootIdentity: string;
  totalBytes: number;
};

export class SandboxSnapshotError extends Error {
  constructor(
    public readonly code:
      | "SANDBOX_DESTINATION_EXISTS"
      | "SANDBOX_LIMIT_EXCEEDED"
      | "SANDBOX_SOURCE_MISMATCH",
    message: string,
  ) {
    super(message);
    this.name = "SandboxSnapshotError";
  }
}

function identityFromStats(stats: Awaited<ReturnType<FileHandle["stat"]>>): SandboxProvenIdentity {
  let kind: SandboxEntryKind;
  if (stats.isDirectory()) kind = "directory";
  else if (stats.isFile()) kind = "file";
  else if (stats.isSymbolicLink()) kind = "link";
  else kind = "special";
  const dev = typeof stats.dev === "bigint" ? stats.dev : BigInt(stats.dev);
  const ino = typeof stats.ino === "bigint" ? stats.ino : BigInt(stats.ino);
  return {
    finalPath: null,
    identity: ino === 0n ? null : `${dev}:${ino}`,
    kind,
    size: kind === "file" ? Number(stats.size) : 0,
  };
}

export const nodeSandboxSnapshotAdapter: SandboxSnapshotPlatformAdapter = {
  async inspectHandle(handle) {
    return identityFromStats(await handle.stat({ bigint: true }));
  },
  inspectPath(path) {
    return nodeSandboxIdentityAdapter.inspect(path);
  },
  async openNoFollow(path) {
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    return open(path, constants.O_RDONLY | noFollow);
  },
};

function mismatch(message: string): never {
  throw new SandboxSnapshotError("SANDBOX_SOURCE_MISMATCH", message);
}

function assertOrdinary(
  actual: SandboxProvenIdentity,
  expected: { identity: string; kind: "directory" | "file"; size: number },
  label: string,
): void {
  if (
    actual.kind !== expected.kind
    || actual.identity !== expected.identity
    || (expected.kind === "file" && actual.size !== expected.size)
  ) {
    mismatch(`${label} changed after preflight.`);
  }
}

function nativeRelative(relativePath: string): string {
  return relativePath.split("/").join(sep);
}

async function doesExist(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function syncDirectory(path: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    if (process.platform !== "win32") throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
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

function parentPaths(path: string): string[] {
  const parts = path.split("/");
  const parents = [""];
  for (let index = 1; index < parts.length; index += 1) {
    parents.push(parts.slice(0, index).join("/"));
  }
  return parents;
}

async function verifyParentChain(
  sourceRoot: string,
  relativePath: string,
  expected: Map<string, SandboxPreflightEntry>,
  platform: SandboxSnapshotPlatformAdapter,
): Promise<void> {
  for (const parent of parentPaths(relativePath)) {
    const identity = expected.get(parent);
    if (!identity || identity.kind !== "directory") {
      mismatch("The preflight manifest is missing a parent directory identity.");
    }
    const absolute = parent ? join(sourceRoot, nativeRelative(parent)) : sourceRoot;
    let actual: SandboxProvenIdentity;
    try {
      actual = await platform.inspectPath(absolute);
    } catch {
      return mismatch("A source parent could not be inspected.");
    }
    assertOrdinary(actual, identity, "A source parent");
  }
}

async function runHook(
  hooks: SandboxSnapshotHooks | undefined,
  phase: SandboxSnapshotPhase,
  path?: string,
): Promise<void> {
  await hooks?.onPhase?.(phase, path);
}

async function copyVerifiedFile(input: {
  buildingRoot: string;
  entry: SandboxPreflightEntry;
  expected: Map<string, SandboxPreflightEntry>;
  hooks?: SandboxSnapshotHooks;
  platform: SandboxSnapshotPlatformAdapter;
  sourceRoot: string;
}): Promise<SandboxSnapshotFile> {
  const { buildingRoot, entry, expected, hooks, platform, sourceRoot } = input;
  const sourcePath = join(sourceRoot, nativeRelative(entry.path));
  const destinationPath = join(buildingRoot, nativeRelative(entry.path));
  const temporaryPath = `${destinationPath}.tmp-${randomUUID()}`;

  await verifyParentChain(sourceRoot, entry.path, expected, platform);
  await runHook(hooks, "parents-verified", entry.path);
  const before = await platform.inspectPath(sourcePath).catch(() => null);
  if (!before) mismatch("A source file disappeared before open.");
  assertOrdinary(before, entry, "A source file");
  await runHook(hooks, "before-source-open", entry.path);

  let source: SandboxSnapshotHandle | undefined;
  let destination: FileHandle | undefined;
  try {
    source = await platform.openNoFollow(sourcePath).catch(() => undefined);
    if (!source) mismatch("A source file could not be opened without following links.");
    const opened = await platform.inspectHandle(source).catch(() => null);
    if (!opened) mismatch("An opened source handle could not be inspected.");
    assertOrdinary(opened, entry, "An opened source handle");
    await verifyParentChain(sourceRoot, entry.path, expected, platform);
    await runHook(hooks, "source-opened", entry.path);

    await mkdir(dirname(destinationPath), { recursive: true });
    destination = await open(temporaryPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let total = 0;
    while (true) {
      const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > entry.size || total > SANDBOX_MAX_BYTES) {
        mismatch("A source file exceeded its preflight size.");
      }
      const chunk = buffer.subarray(0, bytesRead);
      digest.update(chunk);
      await destination.write(chunk);
    }
    await runHook(hooks, "source-read", entry.path);
    if (total !== entry.size) mismatch("A source file size changed while reading.");

    const handleAfter = await platform.inspectHandle(source).catch(() => null);
    const pathAfter = await platform.inspectPath(sourcePath).catch(() => null);
    if (!handleAfter || !pathAfter) mismatch("A source identity became unverifiable after read.");
    assertOrdinary(handleAfter, entry, "The opened source handle");
    assertOrdinary(pathAfter, entry, "The source path");
    await verifyParentChain(sourceRoot, entry.path, expected, platform);
    await runHook(hooks, "source-reverified", entry.path);

    await destination.sync();
    await destination.close();
    destination = undefined;
    await rename(temporaryPath, destinationPath);
    await syncDirectory(dirname(destinationPath));
    await runHook(hooks, "destination-synced", entry.path);
    return { hash: digest.digest("hex"), path: entry.path, size: total };
  } finally {
    await source?.close().catch(() => undefined);
    await destination?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
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
  if (await doesExist(sandboxRoot) || await doesExist(buildingRoot)) {
    throw new SandboxSnapshotError("SANDBOX_DESTINATION_EXISTS", "The sandbox destination already exists.");
  }

  const expected = expectedIdentityMap(input.preflight);
  const platform = input.platform ?? nodeSandboxSnapshotAdapter;
  let ownedBuilding = false;
  let ownedSandbox = false;
  try {
    await mkdir(dirname(buildingRoot), { recursive: true });
    await mkdir(buildingRoot, { recursive: false });
    ownedBuilding = true;
    const files: SandboxSnapshotFile[] = [];
    let totalBytes = 0;
    for (const entry of input.preflight.entries) {
      if (entry.kind === "directory") {
        await verifyParentChain(sourceRoot, entry.path, expected, platform);
        const actual = await platform.inspectPath(join(sourceRoot, nativeRelative(entry.path)));
        assertOrdinary(actual, entry, "A source directory");
        await mkdir(join(buildingRoot, nativeRelative(entry.path)), { recursive: false });
        continue;
      }
      const file = await copyVerifiedFile({
        buildingRoot,
        entry,
        expected,
        hooks: input.hooks,
        platform,
        sourceRoot,
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
    await syncDirectory(buildingRoot);
    await mkdir(dirname(sandboxRoot), { recursive: true });
    await rename(buildingRoot, sandboxRoot);
    ownedBuilding = false;
    ownedSandbox = true;
    await syncDirectory(dirname(sandboxRoot));
    await runHook(input.hooks, "sandbox-renamed");
    const manifestHash = createHash("sha256")
      .update(JSON.stringify({ files, itemCount: input.preflight.itemCount, totalBytes }))
      .digest("hex");
    return {
      files,
      itemCount: input.preflight.itemCount,
      manifestHash,
      rootIdentity: input.preflight.rootIdentity,
      totalBytes,
    };
  } catch (error) {
    if (ownedBuilding) await rm(buildingRoot, { force: true, recursive: true }).catch(() => undefined);
    if (ownedSandbox) await rm(sandboxRoot, { force: true, recursive: true }).catch(() => undefined);
    if (error instanceof SandboxSnapshotError) throw error;
    throw new SandboxSnapshotError("SANDBOX_SOURCE_MISMATCH", "Sandbox snapshot verification failed.");
  }
}

export async function cleanupOwnedSandbox(input: {
  expectedRootIdentity: string;
  platform?: SandboxSnapshotPlatformAdapter;
  sandboxRoot: string;
}): Promise<boolean> {
  const sandboxRoot = resolve(input.sandboxRoot);
  const platform = input.platform ?? nodeSandboxSnapshotAdapter;
  if (!(await doesExist(sandboxRoot))) return true;
  const before = await platform.inspectPath(sandboxRoot).catch(() => null);
  if (
    !before
    || before.kind !== "directory"
    || before.identity !== input.expectedRootIdentity
  ) return false;

  const quarantine = `${sandboxRoot}.cleanup-${randomUUID()}`;
  try {
    await rename(sandboxRoot, quarantine);
  } catch {
    return false;
  }
  const moved = await platform.inspectPath(quarantine).catch(() => null);
  if (
    !moved
    || moved.kind !== "directory"
    || moved.identity !== input.expectedRootIdentity
  ) {
    if (!(await doesExist(sandboxRoot))) {
      await rename(quarantine, sandboxRoot).catch(() => undefined);
    }
    return false;
  }
  try {
    await rm(quarantine, { force: true, recursive: true });
    return true;
  } catch {
    return false;
  }
}

export function sandboxDeadlineState(startedAtMs: number, nowMs: number): "expired" | "live" {
  return nowMs - startedAtMs >= 900_000 ? "expired" : "live";
}

export function sandboxLeaseExpiry(nowMs: number, overallDeadlineMs: number): number {
  return Math.min(nowMs + 120_000, overallDeadlineMs);
}


