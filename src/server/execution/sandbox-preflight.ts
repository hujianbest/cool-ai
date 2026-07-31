import { isAbsolute, relative, resolve, sep } from "node:path";

export const SANDBOX_MAX_ENTRIES = 100_000;
export const SANDBOX_MAX_BYTES = 2_147_483_648;

export type SandboxEntryKind =
  | "directory"
  | "file"
  | "link"
  | "reparse"
  | "special";

export type SandboxListedEntry = {
  attributes: {
    directory: boolean;
    reparsePoint: boolean;
  };
  identity: unknown;
  name: string;
  size: number;
};

export type SandboxProvenIdentity = {
  finalPath: string | null;
  identity: string | null;
  kind: SandboxEntryKind;
  size: number;
};

type Awaitable<T> = T | Promise<T>;

export type SandboxFsAdapter = {
  attributes(handle: unknown): Awaitable<{
    directory: boolean;
    reparsePoint: boolean;
    size: number;
  }>;
  close(handle: unknown): Awaitable<void>;
  finalPath(handle: unknown): Awaitable<string>;
  identity(handle: unknown): Awaitable<unknown>;
  list(handle: unknown): Awaitable<SandboxListedEntry[]>;
  openChildDirectoryNoFollow(parent: unknown, name: string): Awaitable<unknown>;
  openFileNoFollow(parent: unknown, name: string): Awaitable<unknown>;
  openRootDirectory(path: string): Awaitable<unknown>;
  readFromHandle?(handle: unknown, maximumBytes: number): Awaitable<Uint8Array>;
};

export type SandboxPreflightOptions = {
  canonicalRoot: string;
  configuredExclusions?: string[];
  managedSandboxRoot: string;
  platform?: SandboxFsAdapter;
  workspaceKind?: "git" | "nonGit";
};

export type SandboxPreflightEntry = {
  identity: string;
  kind: "directory" | "file";
  path: string;
  size: number;
};

export type SandboxPreflightResult = {
  entries: SandboxPreflightEntry[];
  excludedCount: number;
  itemCount: number;
  rootIdentity: string;
  totalBytes: number;
};

export class SandboxPreflightError extends Error {
  constructor(
    public readonly code:
      | "SANDBOX_LIMIT_EXCEEDED"
      | "SANDBOX_ROOT_INTERSECTION"
      | "SANDBOX_UNVERIFIABLE"
      | "SPECIAL_FILE_REJECTED",
    message: string,
  ) {
    super(message);
    this.name = "SandboxPreflightError";
  }
}

const EXCLUDED_DIRECTORY_NAMES = new Set([
  ".data",
  ".git",
  ".hg",
  ".next",
  ".svn",
  "build",
  "coverage",
  "dist",
  "node_modules",
]);

const EXCLUDED_SECRET_BASENAMES = new Set(["id_ed25519", "id_rsa"]);
const EXCLUDED_SECRET_SUFFIXES = [".key", ".p12", ".pem", ".pfx"];

function failUnverifiable(message: string): never {
  throw new SandboxPreflightError("SANDBOX_UNVERIFIABLE", message);
}

function comparablePath(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

function isSameOrDescendant(path: string, possibleAncestor: string): boolean {
  const child = comparablePath(path);
  const ancestor = comparablePath(possibleAncestor);
  return child === ancestor || child.startsWith(`${ancestor}${sep}`);
}

function isWithinRoot(path: string, root: string): boolean {
  const child = comparablePath(path);
  const ancestor = comparablePath(root);
  return child === ancestor || child.startsWith(`${ancestor}${sep}`);
}

function validEntryName(name: string): boolean {
  return name.length > 0
    && name !== "."
    && name !== ".."
    && !name.includes("/")
    && !name.includes("\\")
    && !name.includes("\0");
}

function isFixedExcluded(kind: SandboxEntryKind, name: string): boolean {
  if (kind === "directory") return EXCLUDED_DIRECTORY_NAMES.has(name);
  if (kind !== "file") return false;
  if (name === ".env.example") return false;
  if (name === ".env" || name.startsWith(".env.")) return true;
  if (EXCLUDED_SECRET_BASENAMES.has(name)) return true;
  return EXCLUDED_SECRET_SUFFIXES.some((suffix) => name.endsWith(suffix));
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
    if (value.fileId.length > 0 && value.volumeSerialNumber.length > 0) {
      return `${value.volumeSerialNumber}:${value.fileId}`;
    }
  }
  return failUnverifiable("The platform adapter returned an invalid identity.");
}

export async function createDefaultSandboxFsAdapter(): Promise<SandboxFsAdapter> {
  try {
    const native = await import("@/src/server/execution/windows-native-read-adapter");
    return native.createWindowsNativeReadAdapter();
  } catch {
    return failUnverifiable("The Windows verified-handle adapter is unavailable.");
  }
}

async function closeVerified(adapter: SandboxFsAdapter, handle: unknown): Promise<void> {
  try {
    await adapter.close(handle);
  } catch {
    failUnverifiable("A verified handle could not be closed.");
  }
}

async function proveHandle(
  adapter: SandboxFsAdapter,
  handle: unknown,
  expectedKind: "directory" | "file",
): Promise<SandboxProvenIdentity & { kind: "directory" | "file" }> {
  try {
    const attributes = await adapter.attributes(handle);
    const finalPath = await adapter.finalPath(handle);
    const identity = identityKey(await adapter.identity(handle));
    if (
      attributes.reparsePoint
      || attributes.directory !== (expectedKind === "directory")
      || !Number.isSafeInteger(attributes.size)
      || attributes.size < 0
      || !isAbsolute(finalPath)
    ) {
      failUnverifiable("The verified handle is not an ordinary object.");
    }
    return {
      finalPath,
      identity,
      kind: expectedKind,
      size: expectedKind === "file" ? attributes.size : 0,
    };
  } catch (error) {
    if (error instanceof SandboxPreflightError) throw error;
    return failUnverifiable("The verified handle identity is unavailable.");
  }
}

function configuredExclusionKeys(paths: string[]): string[] {
  return paths.map((path) => comparablePath(path));
}

function isConfiguredExcluded(path: string, exclusions: string[]): boolean {
  const candidate = comparablePath(path);
  return exclusions.some((excluded) =>
    candidate === excluded || candidate.startsWith(`${excluded}${sep}`));
}

function relativePathFromRoot(root: string, path: string): string {
  return relative(root, path).split(sep).join("/").normalize("NFC");
}

export async function preflightSandbox(
  options: SandboxPreflightOptions,
): Promise<SandboxPreflightResult> {
  if (!isAbsolute(options.canonicalRoot) || !isAbsolute(options.managedSandboxRoot)) {
    failUnverifiable("Sandbox roots must be absolute.");
  }

  const walkRoot = resolve(options.canonicalRoot);
  const adapter = options.platform ?? await createDefaultSandboxFsAdapter();
  let rootHandle: unknown;
  let managedHandle: unknown;
  try {
    rootHandle = await adapter.openRootDirectory(walkRoot);
    managedHandle = await adapter.openRootDirectory(resolve(options.managedSandboxRoot));
  } catch {
    return failUnverifiable("A sandbox root could not be opened through verified handles.");
  }
  let provenRoot: SandboxProvenIdentity;
  try {
    provenRoot = await proveHandle(adapter, rootHandle, "directory");
    const provenManagedRoot = await proveHandle(adapter, managedHandle, "directory");
    if (
      isSameOrDescendant(provenRoot.finalPath!, provenManagedRoot.finalPath!)
      || isSameOrDescendant(provenManagedRoot.finalPath!, provenRoot.finalPath!)
    ) {
      throw new SandboxPreflightError(
        "SANDBOX_ROOT_INTERSECTION",
        "Canonical and managed sandbox roots must not intersect.",
      );
    }
  } catch (error) {
    await closeVerified(adapter, managedHandle).catch(() => undefined);
    await closeVerified(adapter, rootHandle).catch(() => undefined);
    throw error;
  }
  await closeVerified(adapter, managedHandle);

  const configuredExclusions = configuredExclusionKeys(
    options.configuredExclusions ?? [],
  );
  const entries: SandboxPreflightEntry[] = [];
  const pathKeys = new Set<string>();
  let excludedCount = 0;
  let itemCount = 0;
  let totalBytes = 0;

  async function walk(
    directoryHandle: unknown,
    directoryPath: string,
    relativeDirectory: string,
  ): Promise<void> {
    let listedEntries: SandboxListedEntry[];
    try {
      listedEntries = await adapter.list(directoryHandle);
    } catch {
      return failUnverifiable("A directory could not be listed through its verified handle.");
    }
    for (const listed of listedEntries) {
      itemCount += 1;
      if (itemCount > SANDBOX_MAX_ENTRIES) {
        throw new SandboxPreflightError(
          "SANDBOX_LIMIT_EXCEEDED",
          "Sandbox entry count exceeds 100000.",
        );
      }
      if (!validEntryName(listed.name)) {
        failUnverifiable("Directory enumeration returned an invalid entry name.");
      }

      const absolutePath = resolve(directoryPath, listed.name);
      if (!isWithinRoot(absolutePath, walkRoot)) {
        failUnverifiable("Directory enumeration escaped the canonical root.");
      }
      if (isConfiguredExcluded(absolutePath, configuredExclusions)) {
        excludedCount += 1;
        continue;
      }

      const listedKind: SandboxEntryKind = listed.attributes.reparsePoint
        ? "reparse"
        : listed.attributes.directory
          ? "directory"
          : "file";
      if (isFixedExcluded(listedKind, listed.name)) {
        excludedCount += 1;
        continue;
      }
      if (listed.attributes.reparsePoint) {
        throw new SandboxPreflightError(
          "SPECIAL_FILE_REJECTED",
          "Sandbox preflight accepts only ordinary files and directories.",
        );
      }

      let entryHandle: unknown;
      try {
        entryHandle = listed.attributes.directory
          ? await adapter.openChildDirectoryNoFollow(directoryHandle, listed.name)
          : await adapter.openFileNoFollow(directoryHandle, listed.name);
      } catch {
        return failUnverifiable("An entry could not be opened relative to its verified parent.");
      }
      let identity: SandboxProvenIdentity & { kind: "directory" | "file" };
      try {
        identity = await proveHandle(
          adapter,
          entryHandle,
          listed.attributes.directory ? "directory" : "file",
        );
        if (
          identity.identity !== identityKey(listed.identity)
          || (identity.kind === "file" && identity.size !== listed.size)
          || !isWithinRoot(identity.finalPath!, provenRoot.finalPath!)
        ) {
          failUnverifiable("An entry changed between verified list and relative open.");
        }
      } catch (error) {
        await closeVerified(adapter, entryHandle).catch(() => undefined);
        throw error;
      }

      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${listed.name.normalize("NFC")}`
        : listed.name.normalize("NFC");
      const pathKey = process.platform === "win32"
        ? relativePath.toLocaleLowerCase("en-US")
        : relativePath;
      if (pathKeys.has(pathKey)) {
        failUnverifiable("Two entries collide after path normalization.");
      }
      pathKeys.add(pathKey);

      if (identity.kind === "file") {
        totalBytes += identity.size;
        if (totalBytes > SANDBOX_MAX_BYTES) {
          throw new SandboxPreflightError(
            "SANDBOX_LIMIT_EXCEEDED",
            "Sandbox file bytes exceed 2 GiB.",
          );
        }
      }
      entries.push({
        identity: identity.identity!,
        kind: identity.kind,
        path: relativePath,
        size: identity.kind === "file" ? identity.size : 0,
      });
      if (identity.kind === "directory") {
        await walk(entryHandle, absolutePath, relativePath);
      }
      const after = await proveHandle(adapter, entryHandle, identity.kind);
      if (
        after.identity !== identity.identity
        || after.finalPath!.toLocaleLowerCase("en-US")
          !== identity.finalPath!.toLocaleLowerCase("en-US")
      ) {
        await closeVerified(adapter, entryHandle).catch(() => undefined);
        failUnverifiable("A retained verified entry changed during preflight.");
      }
      await closeVerified(adapter, entryHandle);
    }
    const retained = await proveHandle(adapter, directoryHandle, "directory");
    if (!isWithinRoot(retained.finalPath!, provenRoot.finalPath!)) {
      failUnverifiable("A retained directory escaped the canonical root.");
    }
  }

  try {
    await walk(rootHandle, walkRoot, "");
    entries.sort((left, right) =>
      Buffer.from(left.path, "utf8").compare(Buffer.from(right.path, "utf8")));
    return {
      entries,
      excludedCount,
      itemCount,
      rootIdentity: provenRoot.identity!,
      totalBytes,
    };
  } finally {
    await closeVerified(adapter, rootHandle);
  }
}
