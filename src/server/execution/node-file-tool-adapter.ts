import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  open,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";

import type {
  SandboxHandleIdentity,
  SandboxWriteAdapter,
} from "@/src/server/execution/file-tools";

type NodeHandle = {
  file: FileHandle;
  opened: SandboxHandleIdentity;
  path: string;
};

type PreviousFile = {
  bytes: Uint8Array;
  mode: number;
};

function kindOf(stats: Awaited<ReturnType<FileHandle["stat"]>>): SandboxHandleIdentity["kind"] {
  if (stats.isDirectory()) return "directory";
  if (stats.isFile()) return "file";
  if (stats.isSymbolicLink()) return "link";
  return "special";
}

async function identity(handle: NodeHandle): Promise<SandboxHandleIdentity> {
  const stats = await handle.file.stat({ bigint: true });
  const kind = kindOf(stats);
  return {
    finalPath: (await realpath(handle.path)).replaceAll("\\", "/"),
    identity: `${stats.dev}:${stats.ino}`,
    kind,
    size: kind === "file" ? Number(stats.size) : 0,
  };
}

function sameIdentity(left: SandboxHandleIdentity, right: SandboxHandleIdentity): boolean {
  return left.identity === right.identity
    && left.finalPath === right.finalPath
    && left.kind === right.kind
    && left.size === right.size;
}

async function openNoFollow(path: string, flags = constants.O_RDONLY): Promise<NodeHandle> {
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const file = await open(path, flags | noFollow);
  const value = { file, path } as NodeHandle;
  value.opened = await identity(value);
  return value;
}

async function readWhole(handle: NodeHandle): Promise<Uint8Array> {
  const stats = await handle.file.stat();
  const bytes = Buffer.alloc(Number(stats.size));
  let offset = 0;
  while (offset < bytes.length) {
    const read = await handle.file.read(bytes, offset, bytes.length - offset, offset);
    if (read.bytesRead === 0) break;
    offset += read.bytesRead;
  }
  if (offset !== bytes.length) throw new Error("Short file read.");
  return bytes;
}

export const nodeFileToolAdapter: SandboxWriteAdapter<NodeHandle, PreviousFile> = {
  async close(handle) {
    await handle.file.close();
  },
  currentIdentity: identity,
  async identity(handle) {
    return { ...handle.opened };
  },
  async list(handle) {
    const entries = await readdir(handle.path);
    const output = [];
    for (const name of entries) {
      const child = await openNoFollow(join(handle.path, name));
      try {
        output.push({ identity: child.opened.identity, name });
      } finally {
        await child.file.close();
      }
    }
    return output;
  },
  openChildNoFollow(parent, name) {
    return openNoFollow(join(parent.path, name));
  },
  openRootDirectory(root) {
    return openNoFollow(root);
  },
  async readFromHandle(handle, maximumBytes) {
    const stats = await handle.file.stat();
    const length = Math.min(Number(stats.size), maximumBytes);
    const bytes = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const read = await handle.file.read(bytes, offset, length - offset, offset);
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    return bytes.subarray(0, offset);
  },
  async createOwnedTemp(parent, ownerId) {
    const name = `.cool-ai-${ownerId}-${randomUUID()}.tmp`;
    return {
      handle: await openNoFollow(
        join(parent.path, name),
        constants.O_CREAT | constants.O_EXCL | constants.O_RDWR,
      ),
      name,
    };
  },
  async writeAll(handle, bytes) {
    await handle.file.truncate(0);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const written = await handle.file.write(bytes, offset, bytes.byteLength - offset, offset);
      if (written.bytesWritten === 0) throw new Error("Short file write.");
      offset += written.bytesWritten;
    }
  },
  async fsyncFile(handle) {
    await handle.file.sync();
    return true;
  },
  async fsyncDirectory(handle) {
    try {
      await handle.file.sync();
      return true;
    } catch {
      return process.platform === "win32";
    }
  },
  async conditionalAtomicReplace(input) {
    const targetPath = join(input.parent.path, input.name);
    let target: NodeHandle | null = null;
    let previous: PreviousFile | null = null;
    try {
      target = await openNoFollow(targetPath);
      if (!input.expectedTarget || !sameIdentity(target.opened, input.expectedTarget)) return null;
      previous = {
        bytes: await readWhole(target),
        mode: Number((await target.file.stat()).mode),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || input.expectedTarget) throw error;
    } finally {
      await target?.file.close().catch(() => undefined);
    }
    await rename(join(input.parent.path, input.tempName), targetPath);
    const replacement = await openNoFollow(targetPath);
    return {
      previous,
      target: replacement,
      targetIdentity: replacement.opened,
    };
  },
  async conditionalRemoveOwnedTemp(input) {
    const path = join(input.parent.path, input.name);
    let handle: NodeHandle | null = null;
    try {
      handle = await openNoFollow(path);
      if (!sameIdentity(handle.opened, input.expected)) return false;
      await handle.file.close();
      handle = null;
      await rm(path);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT";
    } finally {
      await handle?.file.close().catch(() => undefined);
    }
  },
  async conditionalRollback(input) {
    const path = join(input.parent.path, input.name);
    const current = await openNoFollow(path).catch(() => null);
    if (!current || !sameIdentity(current.opened, input.expectedCurrent)) {
      await current?.file.close().catch(() => undefined);
      return false;
    }
    await current.file.close();
    if (!input.previous) {
      await rm(path);
      return true;
    }
    const temporaryPath = join(input.parent.path, `.cool-ai-rollback-${randomUUID()}.tmp`);
    const temporary = await open(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR,
      input.previous.mode,
    );
    try {
      await temporary.writeFile(input.previous.bytes);
      await temporary.sync();
    } finally {
      await temporary.close();
    }
    await rename(temporaryPath, path);
    return true;
  },
};
