import type { SandboxFileHandleAdapter } from "@/src/adapters/outbound/workspace/file-tools";
export type { SandboxFileHandleAdapter } from "@/src/adapters/outbound/workspace/file-tools";
import { validateSandboxRelativePath } from "@/src/adapters/outbound/workspace/path-guard";
import { WorkspaceError } from "@/src/modules/project-workspace";
import type {
  WorkspaceDirectoryEntry,
  WorkspaceDirectoryListing,
  WorkspaceFilePreview,
  WorkspaceImageContentType,
} from "@/src/modules/project-workspace";

export const WORKSPACE_PREVIEW_TEXT_BYTES = 512 * 1024;
export const WORKSPACE_PREVIEW_IMAGE_BYTES = 2 * 1024 * 1024;

const DIRECTORY_LIST_LIMIT = 1000;

// 敏感遮蔽词汇（027 T-01 冻结，集中于此一处）：命中任一片段即遮蔽，
// 不读取内容。大小写不敏感，方向宁可误遮蔽不可泄漏。
const SENSITIVE_PREFIXES = [".env", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"];
const SENSITIVE_EXTENSIONS = [".pem", ".key", ".p12", ".pfx"];
const SENSITIVE_SUBSTRINGS = ["credential", "secret"];

function isSensitiveWorkspaceName(name: string): boolean {
  const lower = name.normalize("NFC").toLowerCase();
  return (
    SENSITIVE_PREFIXES.some((prefix) => lower.startsWith(prefix))
    || SENSITIVE_EXTENSIONS.some((extension) => lower.endsWith(extension))
    || SENSITIVE_SUBSTRINGS.some((substring) => lower.includes(substring))
  );
}

function isSensitiveWorkspacePath(segments: string[]): boolean {
  return segments.some(isSensitiveWorkspaceName);
}

type HandleIdentity = {
  finalPath: string;
  identity: string;
  kind: string;
  size: number;
};

function sameIdentity(left: HandleIdentity, right: HandleIdentity): boolean {
  return (
    left.identity === right.identity
    && left.kind === right.kind
    && left.finalPath === right.finalPath
    && left.size === right.size
  );
}

function comparablePath(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/\/+$/u, "");
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

function isInsideRoot(path: string, root: string): boolean {
  const child = comparablePath(path);
  const parent = comparablePath(root);
  return child === parent || child.startsWith(`${parent}/`);
}

function invalidPath(): never {
  throw new WorkspaceError("INVALID_INPUT", "Workspace path is invalid.", [
    { field: "path", code: "invalid_format" },
  ]);
}

function entryNotFound(): never {
  throw new WorkspaceError("WORKSPACE_ENTRY_NOT_FOUND", "Workspace entry was not found.");
}

function pathRejected(): never {
  throw new WorkspaceError(
    "WORKSPACE_PATH_REJECTED",
    "Workspace path cannot be verified inside the binding root.",
  );
}

function browseUnavailable(): never {
  throw new WorkspaceError(
    "WORKSPACE_BROWSE_UNAVAILABLE",
    "Workspace browsing is unavailable.",
  );
}

function validateBrowsePath(relativePath: string): { path: string; segments: string[] } {
  if (relativePath === ".") return { path: ".", segments: [] };
  try {
    return validateSandboxRelativePath(relativePath);
  } catch {
    return invalidPath();
  }
}

export function workspaceEditPathSegments(relativePath: string): string[] {
  const segments = validateBrowsePath(relativePath).segments;
  if (segments.length === 0) {
    throw new WorkspaceError(
      "WORKSPACE_PATH_REJECTED",
      "Workspace path cannot be verified inside the binding root.",
    );
  }
  return segments;
}

async function openVerifiedRoot<Handle>(
  fs: SandboxFileHandleAdapter<Handle>,
  workspaceRoot: string,
): Promise<{ root: Handle; rootFinalPath: string }> {
  const root = await fs.openRootDirectory(workspaceRoot).catch(() => null);
  if (!root) return browseUnavailable();
  const identity = await fs.identity(root).catch(() => null);
  const current = await fs.currentIdentity(root).catch(() => null);
  if (
    !identity
    || !current
    || identity.kind !== "directory"
    || !identity.identity
    || !identity.finalPath
    || !sameIdentity(identity, current)
  ) {
    await fs.close(root).catch(() => undefined);
    return browseUnavailable();
  }
  return { root, rootFinalPath: identity.finalPath };
}

async function verifiedChild<Handle>(
  fs: SandboxFileHandleAdapter<Handle>,
  parent: Handle,
  name: string,
  listedIdentity: string,
  rootFinalPath: string,
): Promise<{ handle: Handle; identity: HandleIdentity }> {
  const child = await fs.openChildNoFollow(parent, name).catch(() => null);
  if (!child) return pathRejected();
  try {
    const identity = await fs.identity(child).catch(() => null);
    const current = await fs.currentIdentity(child).catch(() => null);
    if (
      !identity
      || !current
      || !sameIdentity(identity, current)
      || identity.identity !== listedIdentity
    ) {
      return browseUnavailable();
    }
    if (!identity.finalPath || !isInsideRoot(identity.finalPath, rootFinalPath)) {
      return pathRejected();
    }
    return { handle: child, identity };
  } catch (error) {
    await fs.close(child).catch(() => undefined);
    throw error;
  }
}

async function traverseToDirectory<Handle>(
  fs: SandboxFileHandleAdapter<Handle>,
  root: Handle,
  rootFinalPath: string,
  segments: string[],
  owned: Handle[],
): Promise<Handle> {
  let directory = root;
  for (const segment of segments) {
    const listed = await fs.list(directory).catch(() => null);
    if (!listed) return browseUnavailable();
    const entry = listed.find((candidate) => candidate.name === segment);
    if (!entry) return entryNotFound();
    const child = await verifiedChild(fs, directory, segment, entry.identity, rootFinalPath);
    if (child.identity.kind !== "directory") return pathRejected();
    owned.push(child.handle);
    directory = child.handle;
  }
  return directory;
}

async function closeAll<Handle>(
  fs: SandboxFileHandleAdapter<Handle>,
  handles: Handle[],
): Promise<void> {
  for (const handle of handles.reverse()) {
    await fs.close(handle).catch(() => undefined);
  }
}

function compareEntries(left: WorkspaceDirectoryEntry, right: WorkspaceDirectoryEntry): number {
  if (left.kind !== right.kind) return left.kind === "dir" ? -1 : 1;
  const lowerLeft = left.name.toLowerCase();
  const lowerRight = right.name.toLowerCase();
  if (lowerLeft !== lowerRight) return lowerLeft < lowerRight ? -1 : 1;
  if (left.name === right.name) return 0;
  return left.name < right.name ? -1 : 1;
}

export async function listWorkspaceEntries<Handle>(input: {
  fs: SandboxFileHandleAdapter<Handle>;
  relativePath: string;
  workspaceRoot: string;
}): Promise<WorkspaceDirectoryListing> {
  const validated = validateBrowsePath(input.relativePath);
  if (isSensitiveWorkspacePath(validated.segments)) return pathRejected();
  const { fs } = input;
  const owned: Handle[] = [];
  try {
    const { root, rootFinalPath } = await openVerifiedRoot(fs, input.workspaceRoot);
    owned.push(root);
    const directory = await traverseToDirectory(
      fs,
      root,
      rootFinalPath,
      validated.segments,
      owned,
    );
    const listed = await fs.list(directory).catch(() => null);
    if (!listed) return browseUnavailable();
    const entries: WorkspaceDirectoryEntry[] = [];
    const names = new Set<string>();
    for (const entry of listed) {
      if (
        !entry.identity
        || entry.name.length === 0
        || entry.name === "."
        || entry.name === ".."
        || entry.name.includes("/")
        || entry.name.includes("\\")
        || names.has(entry.name)
      ) {
        return browseUnavailable();
      }
      names.add(entry.name);
      const child = await verifiedChild(fs, directory, entry.name, entry.identity, rootFinalPath);
      try {
        if (child.identity.kind !== "directory" && child.identity.kind !== "file") {
          return pathRejected();
        }
        const name = entry.name.normalize("NFC");
        const sensitive = isSensitiveWorkspaceName(name);
        entries.push(
          child.identity.kind === "directory"
            ? { kind: "dir", name, sensitive }
            : { kind: "file", name, sensitive, sizeBytes: child.identity.size },
        );
      } finally {
        await fs.close(child.handle).catch(() => undefined);
      }
    }
    entries.sort(compareEntries);
    return { entries: entries.slice(0, DIRECTORY_LIST_LIMIT), path: validated.path };
  } finally {
    await closeAll(fs, owned);
  }
}

function detectImageContentType(bytes: Uint8Array): WorkspaceImageContentType | null {
  if (
    bytes.byteLength >= 8
    && bytes[0] === 0x89
    && bytes[1] === 0x50
    && bytes[2] === 0x4e
    && bytes[3] === 0x47
    && bytes[4] === 0x0d
    && bytes[5] === 0x0a
    && bytes[6] === 0x1a
    && bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.byteLength >= 6
    && bytes[0] === 0x47
    && bytes[1] === 0x49
    && bytes[2] === 0x46
    && bytes[3] === 0x38
    && (bytes[4] === 0x37 || bytes[4] === 0x39)
    && bytes[5] === 0x61
  ) {
    return "image/gif";
  }
  if (
    bytes.byteLength >= 12
    && bytes[0] === 0x52
    && bytes[1] === 0x49
    && bytes[2] === 0x46
    && bytes[3] === 0x46
    && bytes[8] === 0x57
    && bytes[9] === 0x45
    && bytes[10] === 0x42
    && bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

function decodeTextPrefix(bytes: Uint8Array, truncated: boolean): string | null {
  const attempts = truncated ? 4 : 1;
  for (let trim = 0; trim < attempts && trim <= bytes.byteLength; trim += 1) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(0, bytes.byteLength - trim),
      );
    } catch {
      // 截断点可能落在多字节字符内部，最多回退 3 字节。
    }
  }
  return null;
}

function countLines(content: string): number {
  if (content.length === 0) return 0;
  const breaks = content.match(/\n/gu)?.length ?? 0;
  return content.endsWith("\n") ? breaks : breaks + 1;
}

function classifyPreview(bytes: Uint8Array, size: number): WorkspaceFilePreview {
  const contentType = detectImageContentType(bytes);
  if (contentType) {
    if (size > WORKSPACE_PREVIEW_IMAGE_BYTES) {
      throw new WorkspaceError(
        "WORKSPACE_FILE_TOO_LARGE",
        "Image exceeds the inline preview limit.",
      );
    }
    return {
      contentType,
      dataUrl: `data:${contentType};base64,${Buffer.from(bytes).toString("base64")}`,
      kind: "image",
      sizeBytes: size,
    };
  }
  const truncated = size > WORKSPACE_PREVIEW_TEXT_BYTES;
  const textBytes = bytes.subarray(0, Math.min(bytes.byteLength, WORKSPACE_PREVIEW_TEXT_BYTES));
  const content = decodeTextPrefix(textBytes, truncated);
  if (content === null || content.includes("\0")) return { kind: "binary-unsupported" };
  return { content, kind: "text", lineCount: countLines(content), sizeBytes: size, truncated };
}

export async function readWorkspacePreview<Handle>(input: {
  fs: SandboxFileHandleAdapter<Handle>;
  relativePath: string;
  workspaceRoot: string;
}): Promise<WorkspaceFilePreview> {
  const validated = validateBrowsePath(input.relativePath);
  if (validated.segments.length === 0) {
    throw new WorkspaceError("WORKSPACE_NOT_PREVIEWABLE", "Directories cannot be previewed.");
  }
  // 命中敏感词汇即遮蔽：不做任何文件系统访问，存在性也不探测。
  if (isSensitiveWorkspacePath(validated.segments)) return { kind: "sensitive-masked" };
  const { fs } = input;
  const owned: Handle[] = [];
  try {
    const { root, rootFinalPath } = await openVerifiedRoot(fs, input.workspaceRoot);
    owned.push(root);
    const parent = await traverseToDirectory(
      fs,
      root,
      rootFinalPath,
      validated.segments.slice(0, -1),
      owned,
    );
    const name = validated.segments.at(-1)!;
    const listed = await fs.list(parent).catch(() => null);
    if (!listed) return browseUnavailable();
    const entry = listed.find((candidate) => candidate.name === name);
    if (!entry) return entryNotFound();
    const file = await verifiedChild(fs, parent, name, entry.identity, rootFinalPath);
    owned.push(file.handle);
    if (file.identity.kind === "directory") {
      throw new WorkspaceError("WORKSPACE_NOT_PREVIEWABLE", "Directories cannot be previewed.");
    }
    if (file.identity.kind !== "file") return pathRejected();
    if (!Number.isSafeInteger(file.identity.size) || file.identity.size < 0) {
      return browseUnavailable();
    }
    const size = file.identity.size;
    const bytes = await fs
      .readFromHandle(file.handle, WORKSPACE_PREVIEW_IMAGE_BYTES)
      .catch(() => null);
    if (!bytes) return browseUnavailable();
    const after = await fs.currentIdentity(file.handle).catch(() => null);
    if (
      !after
      || !sameIdentity(file.identity, after)
      || bytes.byteLength !== Math.min(size, WORKSPACE_PREVIEW_IMAGE_BYTES)
    ) {
      return browseUnavailable();
    }
    return classifyPreview(bytes, size);
  } finally {
    await closeAll(fs, owned);
  }
}

export const WORKSPACE_EDIT_TEXT_BYTES = WORKSPACE_PREVIEW_TEXT_BYTES;

export type VerifiedWorkspaceTextFile = {
  bytes: Uint8Array;
  path: string;
  sizeBytes: number;
};

export async function readVerifiedWorkspaceTextFile<Handle>(input: {
  fs: SandboxFileHandleAdapter<Handle>;
  relativePath: string;
  workspaceRoot: string;
}): Promise<VerifiedWorkspaceTextFile> {
  const validated = validateBrowsePath(input.relativePath);
  if (validated.segments.length === 0) {
    throw new WorkspaceError("WORKSPACE_NOT_EDITABLE", "Directories cannot be edited.");
  }
  if (isSensitiveWorkspacePath(validated.segments)) {
    return pathRejected();
  }
  const { fs } = input;
  const owned: Handle[] = [];
  try {
    const { root, rootFinalPath } = await openVerifiedRoot(fs, input.workspaceRoot);
    owned.push(root);
    const parent = await traverseToDirectory(
      fs,
      root,
      rootFinalPath,
      validated.segments.slice(0, -1),
      owned,
    );
    const name = validated.segments.at(-1)!;
    const listed = await fs.list(parent).catch(() => null);
    if (!listed) return browseUnavailable();
    const entry = listed.find((candidate) => candidate.name === name);
    if (!entry) return entryNotFound();
    const file = await verifiedChild(fs, parent, name, entry.identity, rootFinalPath);
    owned.push(file.handle);
    if (file.identity.kind === "directory") {
      throw new WorkspaceError("WORKSPACE_NOT_EDITABLE", "Directories cannot be edited.");
    }
    if (file.identity.kind !== "file") return pathRejected();
    if (!Number.isSafeInteger(file.identity.size) || file.identity.size < 0) {
      return browseUnavailable();
    }
    const size = file.identity.size;
    if (size > WORKSPACE_EDIT_TEXT_BYTES) {
      throw new WorkspaceError(
        "WORKSPACE_FILE_TOO_LARGE",
        "File exceeds the workspace edit limit.",
      );
    }
    const bytes = await fs.readFromHandle(file.handle, WORKSPACE_EDIT_TEXT_BYTES + 1).catch(() => null);
    if (!bytes) return browseUnavailable();
    const after = await fs.currentIdentity(file.handle).catch(() => null);
    if (
      !after
      || !sameIdentity(file.identity, after)
      || bytes.byteLength !== size
    ) {
      return browseUnavailable();
    }
    if (detectImageContentType(bytes)) {
      throw new WorkspaceError("WORKSPACE_NOT_EDITABLE", "Only text files can be edited.");
    }
    const content = decodeTextPrefix(bytes, false);
    if (content === null || content.includes("\0")) {
      throw new WorkspaceError("WORKSPACE_NOT_EDITABLE", "Only text files can be edited.");
    }
    return { bytes, path: validated.path, sizeBytes: size };
  } finally {
    await closeAll(fs, owned);
  }
}
