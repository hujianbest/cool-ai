import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

type EntryKind = "directory" | "file" | "link" | "reparse" | "special";

type ListedEntry = {
  kindHint?: EntryKind;
  name: string;
};

type ProvenIdentity = {
  finalPath: string | null;
  identity: string | null;
  kind: EntryKind;
  size: number;
};

type PreflightOptions = {
  canonicalRoot: string;
  configuredExclusions?: string[];
  identityAdapter?: {
    inspect(path: string): Promise<ProvenIdentity>;
  };
  iterateDirectory?: (path: string) => AsyncIterable<ListedEntry>;
  managedSandboxRoot: string;
  platform?: {
    attributes(handle: unknown): unknown;
    close(handle: unknown): unknown;
    finalPath(handle: unknown): unknown;
    identity(handle: unknown): unknown;
    list(handle: unknown): unknown;
    openChildDirectoryNoFollow(parent: unknown, name: string): unknown;
    openFileNoFollow(parent: unknown, name: string): unknown;
    openRootDirectory(path: string): unknown;
  };
  workspaceKind?: "git" | "nonGit";
};

type PreflightResult = {
  entries: Array<{
    identity: string;
    kind: "directory" | "file";
    path: string;
    size: number;
  }>;
  excludedCount: number;
  itemCount: number;
  rootIdentity: string;
  totalBytes: number;
};

type PreflightModule = {
  createDefaultSandboxFsAdapter(options?: {
    arch?: string;
    factory?: () => NonNullable<PreflightOptions["platform"]>;
    platform?: string;
  }): Promise<NonNullable<PreflightOptions["platform"]>>;
  preflightSandbox(options: PreflightOptions): Promise<PreflightResult>;
};

let directory: string;
let canonicalRoot: string;
let managedSandboxRoot: string;
let preflight: PreflightModule;

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "cool-ai-sandbox-preflight-"));
  canonicalRoot = join(directory, "workspace");
  managedSandboxRoot = join(directory, "managed-executions");
  mkdirSync(canonicalRoot);
  mkdirSync(managedSandboxRoot);

  const moduleId = "@/src/adapters/outbound/workspace/sandbox-preflight";
  try {
    preflight = await import(/* @vite-ignore */ moduleId) as PreflightModule;
  } catch {
    expect.fail("The sandbox preflight boundary is unavailable.");
  }
});

afterEach(() => {
  rmSync(directory, { force: true, recursive: true });
});

function write(relativePath: string, content = relativePath): string {
  const absolutePath = join(canonicalRoot, relativePath);
  mkdirSync(resolve(absolutePath, ".."), { recursive: true });
  writeFileSync(absolutePath, content);
  return absolutePath;
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
}

function syntheticOptions(
  entries: number,
  sizeAt: (index: number) => number,
): Pick<PreflightOptions, "platform"> {
  type Handle = { path: string };
  return {
    platform: {
      attributes(handle) {
        const path = (handle as Handle).path;
        const root = path === canonicalRoot || path === managedSandboxRoot;
        const index = Number(path.slice(path.lastIndexOf("entry-") + "entry-".length));
        return { directory: root, reparsePoint: false, size: root ? 0 : sizeAt(index) };
      },
      close() {},
      finalPath(handle) { return (handle as Handle).path; },
      identity(handle) {
        const path = (handle as Handle).path;
        if (path === canonicalRoot) return "root-identity";
        if (path === managedSandboxRoot) return "managed-root-identity";
        return `file-${Number(path.slice(path.lastIndexOf("entry-") + "entry-".length))}`;
      },
      list(handle) {
        if ((handle as Handle).path !== canonicalRoot) return [];
        return Array.from({ length: entries }, (_, index) => {
          const sourceIndex = entries - index - 1;
          return {
            attributes: { directory: false, reparsePoint: false },
            identity: `file-${sourceIndex}`,
            name: `entry-${sourceIndex}`,
            size: sizeAt(sourceIndex),
          };
        });
      },
      openChildDirectoryNoFollow() { throw new Error("no synthetic directories"); },
      openFileNoFollow(parent, name) {
        return { path: join((parent as Handle).path, name) };
      },
      openRootDirectory(path) { return { path }; },
    },
  };
}

describe("sandbox preflight", () => {
  it("constructs the statically wired default factory exactly once on supported Windows x64", async () => {
    const adapter = syntheticOptions(0, () => 0).platform!;
    const factory = vi.fn(() => adapter);

    await expect(preflight.createDefaultSandboxFsAdapter({
      arch: "x64",
      factory,
      platform: "win32",
    })).resolves.toBe(adapter);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["linux", "x64"],
    ["win32", "arm64"],
  ])("rejects unsupported runtime %s/%s before calling the native factory", async (platform, arch) => {
    const factory = vi.fn(() => syntheticOptions(0, () => 0).platform!);

    await expect(preflight.createDefaultSandboxFsAdapter({
      arch,
      factory,
      platform,
    })).rejects.toMatchObject({ code: "SANDBOX_UNVERIFIABLE" });
    expect(factory).not.toHaveBeenCalled();
  });

  it("preserves typed native failures and wraps only unknown construction failures with cause", async () => {
    const nativeCause = new Error("missing fixed symbol");
    const typed = Object.assign(new Error("native ABI mismatch", { cause: nativeCause }), {
      code: "SANDBOX_UNVERIFIABLE" as const,
    });
    await expect(preflight.createDefaultSandboxFsAdapter({
      arch: "x64",
      factory: () => { throw typed; },
      platform: "win32",
    })).rejects.toBe(typed);

    const unknown = new Error("unexpected constructor failure");
    await expect(preflight.createDefaultSandboxFsAdapter({
      arch: "x64",
      factory: () => { throw unknown; },
      platform: "win32",
    })).rejects.toMatchObject({
      cause: unknown,
      code: "SANDBOX_UNVERIFIABLE",
      message: "The Windows verified-handle adapter construction failed.",
    });
  });

  it("fails closed through the verified-handle adapter instead of using a path fallback", async () => {
    write("ordinary.txt", "ordinary");
    let rootOpenCount = 0;

    await expectCode(preflight.preflightSandbox({
      canonicalRoot,
      managedSandboxRoot,
      platform: {
        openRootDirectory() {
          rootOpenCount += 1;
          throw new Error("native adapter unavailable");
        },
      } as never,
    }), "SANDBOX_UNVERIFIABLE");

    expect(rootOpenCount).toBe(1);
  });

  it.each(["git", "nonGit"] as const)(
    "uses the same ordinary snapshot rules for %s workspaces without Git metadata",
    async (workspaceKind) => {
      write("src/index.ts", "export const value = 1;");
      write("README.md", "read me");
      write(".git/config", "[core]");

      const result = await preflight.preflightSandbox({
        canonicalRoot,
        managedSandboxRoot,
        workspaceKind,
      });

      expect(result.entries.map((entry) => entry.path)).toEqual([
        "README.md",
        "src",
        "src/index.ts",
      ]);
      expect(result.entries.every((entry) => entry.identity.length > 0)).toBe(true);
      expect(result.excludedCount).toBe(1);
      expect(result.itemCount).toBe(4);
    },
  );

  it("rejects either direction of canonical and managed-root intersection", async () => {
    const managedInsideCanonical = join(canonicalRoot, "managed");
    mkdirSync(managedInsideCanonical);
    await expectCode(preflight.preflightSandbox({
      canonicalRoot,
      managedSandboxRoot: managedInsideCanonical,
    }), "SANDBOX_ROOT_INTERSECTION");

    const outerManaged = join(directory, "outer-managed");
    const canonicalInsideManaged = join(outerManaged, "workspace");
    mkdirSync(canonicalInsideManaged, { recursive: true });
    await expectCode(preflight.preflightSandbox({
      canonicalRoot: canonicalInsideManaged,
      managedSandboxRoot: outerManaged,
    }), "SANDBOX_ROOT_INTERSECTION");
  });

  it("excludes exact configured sensitive paths while retaining normal source names", async () => {
    const database = write(".app/cockpit.sqlite", "database-secret");
    const masterKey = write(".keys/master.key", "master-secret");
    const appSandbox = join(canonicalRoot, ".app/executions");
    const appTemp = join(canonicalRoot, ".app/temp");
    const secretPath = join(canonicalRoot, "private/credentials");
    mkdirSync(appSandbox, { recursive: true });
    mkdirSync(appTemp, { recursive: true });
    mkdirSync(secretPath, { recursive: true });
    write(".app/executions/attempt.bin", "sandbox-secret");
    write(".app/temp/process.tmp", "temp-secret");
    write("private/credentials/token.txt", "token-secret");
    write("src/database.ts");
    write("src/master-key-help.ts");
    write("src/temp.ts");
    write("src/secret-notes.ts");
    write("src/sandbox.ts");

    const result = await preflight.preflightSandbox({
      canonicalRoot,
      configuredExclusions: [database, masterKey, appSandbox, appTemp, secretPath],
      managedSandboxRoot,
    });
    const paths = result.entries.map((entry) => entry.path);

    expect(paths).toEqual(expect.arrayContaining([
      "src/database.ts",
      "src/master-key-help.ts",
      "src/sandbox.ts",
      "src/secret-notes.ts",
      "src/temp.ts",
    ]));
    expect(paths).not.toEqual(expect.arrayContaining([
      ".app/cockpit.sqlite",
      ".app/executions",
      ".app/executions/attempt.bin",
      ".app/temp",
      ".app/temp/process.tmp",
      ".keys/master.key",
      "private/credentials",
      "private/credentials/token.txt",
    ]));
    expect(result.excludedCount).toBe(5);
  });

  it("applies fixed managed and credential rules without excluding .env.example", async () => {
    write("packages/pkg/node_modules/secret.txt", "excluded");
    write("packages/pkg/dist/output.js", "excluded");
    write(".env", "TOKEN=secret");
    write(".env.local", "TOKEN=secret");
    write(".env.example", "TOKEN=example");
    write("cert.pem", "secret");
    write("src/build-helper.ts", "normal");

    const result = await preflight.preflightSandbox({
      canonicalRoot,
      managedSandboxRoot,
    });
    const paths = result.entries.map((entry) => entry.path);

    expect(paths).toContain(".env.example");
    expect(paths).toContain("src/build-helper.ts");
    expect(paths).not.toContain(".env");
    expect(paths).not.toContain(".env.local");
    expect(paths).not.toContain("cert.pem");
    expect(paths).not.toContain("packages/pkg/node_modules");
    expect(paths).not.toContain("packages/pkg/dist");
  });

  it("enumerates only ordinary files and directories in deterministic UTF-8 relative order", async () => {
    write("z-last.txt");
    write("a-dir/b.txt");
    write("é.txt");
    write("middle.txt");

    const first = await preflight.preflightSandbox({ canonicalRoot, managedSandboxRoot });
    const second = await preflight.preflightSandbox({ canonicalRoot, managedSandboxRoot });
    const expected = [...first.entries].sort((left, right) =>
      Buffer.from(left.path, "utf8").compare(Buffer.from(right.path, "utf8")));

    expect(first.entries).toEqual(expected);
    expect(second.entries).toEqual(first.entries);
    expect(second.rootIdentity).toBe(first.rootIdentity);
    expect(first.entries.every((entry) =>
      entry.kind === "file" || entry.kind === "directory")).toBe(true);
  });

  it("rejects a real symbolic link before traversing or reading its target", async () => {
    const target = write("ordinary.txt", "ordinary");
    const link = join(canonicalRoot, "linked.txt");
    try {
      symlinkSync(target, link, "file");
    } catch {
      return;
    }

    await expectCode(
      preflight.preflightSandbox({ canonicalRoot, managedSandboxRoot }),
      "SPECIAL_FILE_REJECTED",
    );
  });

  it("rejects a real directory junction or directory symlink without traversal", async () => {
    const target = join(directory, "outside-target");
    mkdirSync(target);
    writeFileSync(join(target, "secret.txt"), "outside-secret");
    const link = join(canonicalRoot, "linked-directory");
    try {
      symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
    } catch {
      return;
    }

    await expectCode(
      preflight.preflightSandbox({ canonicalRoot, managedSandboxRoot }),
      "SPECIAL_FILE_REJECTED",
    );
  });

  it("rejects an adapter-listed reparse entry before relative open", async () => {
    const synthetic = syntheticOptions(1, () => 0);
    const platform = synthetic.platform!;
    const originalList = platform.list;
    platform.list = (handle) => {
      const entries = originalList(handle) as Array<{
        attributes: { directory: boolean; reparsePoint: boolean };
      }>;
      return entries.map((entry) => ({
        ...entry,
        attributes: { ...entry.attributes, reparsePoint: true },
      }));
    };
    await expectCode(preflight.preflightSandbox({
      canonicalRoot,
      managedSandboxRoot,
      platform,
    }), "SPECIAL_FILE_REJECTED");
  });

  it.each([
    ["limit-1", 99_999, true],
    ["limit", 100_000, true],
    ["limit+1", 100_001, false],
  ] as const)("enforces the 100000 entry boundary at %s", async (_label, count, succeeds) => {
    const promise = preflight.preflightSandbox({
      canonicalRoot,
      managedSandboxRoot,
      ...syntheticOptions(count, () => 0),
    });
    if (succeeds) {
      await expect(promise).resolves.toMatchObject({ itemCount: count });
    } else {
      await expectCode(promise, "SANDBOX_LIMIT_EXCEEDED");
    }
  }, 30_000);

  it.each([
    ["limit-1", 2_147_483_647, true],
    ["limit", 2_147_483_648, true],
    ["limit+1", 2_147_483_649, false],
  ] as const)("enforces the 2 GiB byte boundary at %s", async (_label, bytes, succeeds) => {
    const promise = preflight.preflightSandbox({
      canonicalRoot,
      managedSandboxRoot,
      ...syntheticOptions(2, (index) => index === 0 ? bytes : 0),
    });
    if (succeeds) {
      await expect(promise).resolves.toMatchObject({ itemCount: 2, totalBytes: bytes });
    } else {
      await expectCode(promise, "SANDBOX_LIMIT_EXCEEDED");
    }
  });
});
