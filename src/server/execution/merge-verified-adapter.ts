import { createHash } from "node:crypto";
import { dirname } from "node:path";

import { ExecutionError } from "@/src/server/execution/execution-service";
import {
  createWindowsVerifiedExecutionAdapters,
  type WindowsVerifiedFileAdapter,
} from "@/src/server/execution/windows-verified-execution-adapter";
import {
  createWindowsNativeMergeLifecycleAdapter,
  type ExpectedCanonicalFile,
  type NativeMutationResult,
  type VerifiedOwnedFileRef,
} from "@/src/server/execution/windows-native-merge-lifecycle";

export type MergeVerifiedState = {
  bytes: Buffer | null;
  target: ExpectedCanonicalFile;
};

export type MergeRoots = {
  canonical: string;
  journal: string;
};

export type MergeVerifiedAdapter = {
  assertCapability(input: {
    journalBaseRoot: string;
    sandboxRoot: string;
    workspaceRoot: string;
  }): Promise<void>;
  conditionalCleanupOwned(
    roots: MergeRoots,
    ref: VerifiedOwnedFileRef,
  ): NativeMutationResult<{ deleted: true }>;
  conditionalDelete(
    roots: MergeRoots,
    expectedTarget: ExpectedCanonicalFile,
  ): NativeMutationResult<{ deleted: true }>;
  conditionalReplacePrepared(
    roots: MergeRoots,
    expectedTarget: ExpectedCanonicalFile,
    preparedCanonicalTemp: VerifiedOwnedFileRef,
  ): NativeMutationResult<ExpectedCanonicalFile>;
  prepareCanonicalTempFromOwned(
    roots: MergeRoots,
    sourceRef: VerifiedOwnedFileRef,
    targetParentSegments: string[],
    tempName: string,
    ownerId: string,
  ): NativeMutationResult<VerifiedOwnedFileRef>;
  prepareOwnedFile(
    rootKind: "journal" | "canonical",
    root: string,
    parentSegments: string[],
    name: string,
    ownerId: string,
    bytes: Uint8Array,
  ): NativeMutationResult<VerifiedOwnedFileRef>;
  readFile(input: {
    maximumBytes: number;
    pathSegments: string[];
    root: string;
  }): Promise<MergeVerifiedState>;
  reopenOwnedFile(
    roots: MergeRoots,
    ref: VerifiedOwnedFileRef,
  ): NativeMutationResult<VerifiedOwnedFileRef>;
};

function unavailable(message: string, cause?: unknown): never {
  throw new ExecutionError(
    "SANDBOX_UNVERIFIABLE",
    422,
    cause instanceof Error ? `${message}: ${cause.message}` : message,
  );
}

function validateSegments(pathSegments: string[]): void {
  if (
    pathSegments.length === 0
    || pathSegments.some((segment) =>
      !segment
      || segment === "."
      || segment === ".."
      || segment.includes("/")
      || segment.includes("\\")
      || segment.includes("\0")
      || segment.normalize("NFC") !== segment
    )
  ) {
    unavailable("A merge path is not a valid verified relative path.");
  }
}

async function closeAll(
  adapter: WindowsVerifiedFileAdapter,
  handles: unknown[],
  previous?: unknown,
): Promise<void> {
  let failure = previous;
  for (const handle of handles.reverse()) {
    try {
      await adapter.close(handle as never);
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure !== undefined) unavailable("A merge handle close was uncertain.", failure);
}

export function createWindowsVerifiedMergeAdapter(): MergeVerifiedAdapter {
  let adapter: WindowsVerifiedFileAdapter;
  let lifecycle: ReturnType<typeof createWindowsNativeMergeLifecycleAdapter>;
  try {
    adapter = createWindowsVerifiedExecutionAdapters().fileAdapter;
    lifecycle = createWindowsNativeMergeLifecycleAdapter();
  } catch (error) {
    return unavailable("The Windows verified merge lifecycle is unavailable.", error);
  }

  async function verifyRoot(root: string): Promise<void> {
    const handle = await adapter.openRootDirectory(root).catch((error) =>
      unavailable("A merge root could not be verified.", error));
    try {
      const identity = await adapter.identity(handle);
      if (identity.kind !== "directory") unavailable("A merge root is not an ordinary directory.");
    } finally {
      await closeAll(adapter, [handle]);
    }
  }

  return {
    async assertCapability(input) {
      await verifyRoot(input.workspaceRoot);
      await verifyRoot(input.sandboxRoot);
      await verifyRoot(dirname(input.journalBaseRoot));
    },
    conditionalCleanupOwned: lifecycle.conditionalCleanupOwned,
    conditionalDelete: lifecycle.conditionalDelete,
    conditionalReplacePrepared: lifecycle.conditionalReplacePrepared,
    prepareCanonicalTempFromOwned: lifecycle.prepareCanonicalTempFromOwned,
    prepareOwnedFile: lifecycle.prepareOwnedFile,
    async readFile(input) {
      validateSegments(input.pathSegments);
      const owned: unknown[] = [];
      try {
        let parent = await adapter.openRootDirectory(input.root);
        owned.push(parent);
        for (const segment of input.pathSegments.slice(0, -1)) {
          const listed = await adapter.list(parent);
          const expected = listed.find((entry) => entry.name === segment);
          if (!expected) unavailable("A merge parent path is unavailable.");
          const child = await adapter.openChildNoFollow(parent, segment);
          owned.push(child);
          const identity = await adapter.identity(child);
          if (identity.kind !== "directory" || identity.identity !== expected.identity) {
            unavailable("A merge parent changed during verified traversal.");
          }
          parent = child;
        }
        const parentIdentity = await adapter.currentIdentity(parent);
        if (parentIdentity.kind !== "directory") unavailable("A merge parent is not a directory.");
        const name = input.pathSegments.at(-1)!;
        const listed = await adapter.list(parent);
        const expected = listed.find((entry) => entry.name === name);
        if (!expected) {
          return {
            bytes: null,
            target: {
              rootKind: "canonical",
              relativePath: [...input.pathSegments],
              exists: false,
              parentIdentity: parentIdentity.identity,
              fileIdentity: null,
              sha256: null,
              size: null,
            },
          };
        }
        const file = await adapter.openChildNoFollow(parent, name);
        owned.push(file);
        const before = await adapter.identity(file);
        if (before.kind !== "file" || before.identity !== expected.identity) {
          unavailable("A merge file changed before verified reading.");
        }
        const bytes = Buffer.from(await adapter.readFromHandle(file, input.maximumBytes + 1));
        const after = await adapter.currentIdentity(file);
        if (
          bytes.byteLength > input.maximumBytes
          || bytes.byteLength !== before.size
          || after.identity !== before.identity
          || after.finalPath !== before.finalPath
          || after.size !== before.size
        ) {
          unavailable("A merge file changed during verified reading.");
        }
        return {
          bytes,
          target: {
            rootKind: "canonical",
            relativePath: [...input.pathSegments],
            exists: true,
            parentIdentity: parentIdentity.identity,
            fileIdentity: before.identity,
            sha256: createHash("sha256").update(bytes).digest("hex"),
            size: bytes.byteLength,
          },
        };
      } catch (error) {
        if (error instanceof ExecutionError) throw error;
        return unavailable("A verified merge read was uncertain.", error);
      } finally {
        await closeAll(adapter, owned);
      }
    },
    reopenOwnedFile: lifecycle.reopenOwnedFile,
  };
}
