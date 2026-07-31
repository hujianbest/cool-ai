import { lstat, opendir, realpath } from "node:fs/promises";
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
  kindHint?: SandboxEntryKind;
  name: string;
};

export type SandboxProvenIdentity = {
  finalPath: string | null;
  identity: string | null;
  kind: SandboxEntryKind;
  size: number;
};

export type SandboxPlatformIdentityAdapter = {
  inspect(path: string): Promise<SandboxProvenIdentity>;
};

export type SandboxPreflightOptions = {
  canonicalRoot: string;
  configuredExclusions?: string[];
  identityAdapter?: SandboxPlatformIdentityAdapter;
  iterateDirectory?: (path: string) => AsyncIterable<SandboxListedEntry>;
  managedSandboxRoot: string;
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

async function* nodeDirectoryIterator(path: string): AsyncIterable<SandboxListedEntry> {
  const directory = await opendir(path);
  for await (const entry of directory) {
    let kindHint: SandboxEntryKind = "special";
    if (entry.isDirectory()) kindHint = "directory";
    else if (entry.isFile()) kindHint = "file";
    else if (entry.isSymbolicLink()) kindHint = "link";
    yield { kindHint, name: entry.name };
  }
}

export const nodeSandboxIdentityAdapter: SandboxPlatformIdentityAdapter = {
  async inspect(path) {
    let stats;
    try {
      stats = await lstat(path, { bigint: true });
    } catch {
      return { finalPath: null, identity: null, kind: "special", size: 0 };
    }

    let kind: SandboxEntryKind;
    if (stats.isSymbolicLink()) kind = "link";
    else if (stats.isDirectory()) kind = "directory";
    else if (stats.isFile()) kind = "file";
    else kind = "special";

    if (kind === "link" || kind === "special") {
      return {
        finalPath: null,
        identity: `${stats.dev}:${stats.ino}`,
        kind,
        size: 0,
      };
    }

    let finalPath: string;
    try {
      finalPath = await realpath(path);
    } catch {
      return { finalPath: null, identity: null, kind, size: Number(stats.size) };
    }
    const identity = stats.ino === 0n ? null : `${stats.dev}:${stats.ino}`;
    return {
      finalPath,
      identity,
      kind,
      size: kind === "file" ? Number(stats.size) : 0,
    };
  },
};

async function proveRoot(path: string, adapter: SandboxPlatformIdentityAdapter) {
  const identity = await inspectWithAdapter(adapter, path);
  if (
    identity.kind !== "directory"
    || !identity.identity
    || !identity.finalPath
  ) {
    failUnverifiable("The canonical root cannot be proven as an ordinary directory.");
  }
  return identity;
}

async function inspectWithAdapter(
  adapter: SandboxPlatformIdentityAdapter,
  path: string,
): Promise<SandboxProvenIdentity> {
  try {
    return await adapter.inspect(path);
  } catch {
    return failUnverifiable("The platform identity adapter is unavailable.");
  }
}

async function realRoot(path: string, label: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return failUnverifiable(`${label} cannot be resolved.`);
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
  const canonicalRoot = await realRoot(walkRoot, "Canonical root");
  const managedSandboxRoot = await realRoot(
    options.managedSandboxRoot,
    "Managed sandbox root",
  );
  if (
    isSameOrDescendant(canonicalRoot, managedSandboxRoot)
    || isSameOrDescendant(managedSandboxRoot, canonicalRoot)
  ) {
    throw new SandboxPreflightError(
      "SANDBOX_ROOT_INTERSECTION",
      "Canonical and managed sandbox roots must not intersect.",
    );
  }

  const adapter = options.identityAdapter ?? nodeSandboxIdentityAdapter;
  const iterator = options.iterateDirectory ?? nodeDirectoryIterator;
  const provenRoot = await proveRoot(walkRoot, adapter);

  const configuredExclusions = configuredExclusionKeys(
    options.configuredExclusions ?? [],
  );
  const entries: SandboxPreflightEntry[] = [];
  const pathKeys = new Set<string>();
  let excludedCount = 0;
  let itemCount = 0;
  let totalBytes = 0;

  async function walk(directoryPath: string): Promise<void> {
    for await (const listed of iterator(directoryPath)) {
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

      if (
        listed.kindHint
        && isFixedExcluded(listed.kindHint, listed.name)
      ) {
        excludedCount += 1;
        continue;
      }

      const identity = await inspectWithAdapter(adapter, absolutePath);
      if (identity.kind !== "directory" && identity.kind !== "file") {
        throw new SandboxPreflightError(
          "SPECIAL_FILE_REJECTED",
          "Sandbox preflight accepts only ordinary files and directories.",
        );
      }
      if (
        !identity.identity
        || !identity.finalPath
        || !Number.isSafeInteger(identity.size)
        || identity.size < 0
      ) {
        failUnverifiable("The platform adapter could not prove an entry identity.");
      }
      if (!isWithinRoot(identity.finalPath, provenRoot.finalPath!)) {
        failUnverifiable("An entry final path escaped the canonical root.");
      }
      if (isFixedExcluded(identity.kind, listed.name)) {
        excludedCount += 1;
        continue;
      }

      const relativePath = relativePathFromRoot(walkRoot, absolutePath);
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
        identity: identity.identity,
        kind: identity.kind,
        path: relativePath,
        size: identity.kind === "file" ? identity.size : 0,
      });
      if (identity.kind === "directory") await walk(absolutePath);
    }
  }

  await walk(walkRoot);
  entries.sort((left, right) =>
    Buffer.from(left.path, "utf8").compare(Buffer.from(right.path, "utf8")));
  return {
    entries,
    excludedCount,
    itemCount,
    rootIdentity: provenRoot.identity!,
    totalBytes,
  };
}
