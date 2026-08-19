import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

type NativeFailure = Error & { code?: string };
type NativeStep =
  | "create-temp"
  | "write"
  | "flush-file"
  | "pre-target-open"
  | "pre-parent-check"
  | "rename"
  | "post-target-open"
  | "post-parent-check"
  | "flush-directory"
  | "delete";
type AdapterOptions = {
  hooks?: {
    afterReplace?: (name: string) => void;
    beforeNativeStep?: (step: NativeStep, name: string) => void;
    beforeReplace?: (name: string) => void;
    maximumWriteChunk?: number;
    onWriteBytes?: (bytes: Uint8Array) => void;
  };
};
type MutationResult = {
  hash: string;
  identity: { fileId: string; volumeSerialNumber: string };
};
type WriteAdapter = {
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
  ): MutationResult;
};
type NativeModule = {
  createWindowsNativeWriteAdapter(options?: AdapterOptions): WriteAdapter;
};

let directory: string;
let native: NativeModule;

function hash(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function expectUnverifiable(run: () => unknown): void {
  try {
    run();
    expect.fail("Expected the native write adapter to fail closed.");
  } catch (error) {
    expect((error as NativeFailure).code).toBe("SANDBOX_UNVERIFIABLE");
  }
}

function tempNames(path: string): string[] {
  return readdirSync(path).filter((name) => name.startsWith(".cool-ai-"));
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "cool-ai-native-write-"));
  const moduleId = "@/src/adapters/outbound/workspace/windows-native-write-adapter";
  try {
    native = await import(/* @vite-ignore */ moduleId) as NativeModule;
  } catch {
    expect.fail("The Windows handle-relative write adapter is unavailable.");
  }
});

afterEach(() => {
  rmSync(directory, { force: true, recursive: true });
});

describe("Windows handle-relative write adapter", () => {
  it("creates an exclusive owned temp and loops short WriteFile transfers before atomic replace", () => {
    mkdirSync(join(directory, "parent"));
    writeFileSync(join(directory, "parent", "safe.txt"), "old");
    const chunks: number[] = [];
    const adapter = native.createWindowsNativeWriteAdapter({
      hooks: {
        maximumWriteChunk: 3,
        onWriteBytes: (bytes) => chunks.push(bytes.byteLength),
      },
    });

    const result = adapter.writeVerifiedFile(
      directory,
      ["parent", "safe.txt"],
      Buffer.from("abcdefghij"),
      hash("old"),
    );

    expect(readFileSync(join(directory, "parent", "safe.txt"), "utf8")).toBe("abcdefghij");
    expect(chunks).toEqual([3, 3, 3, 1]);
    expect(result.hash).toBe(hash("abcdefghij"));
    expect(result.identity.fileId).toMatch(/^[0-9a-f]{32}$/);
    expect(tempNames(join(directory, "parent"))).toEqual([]);
  });

  it("flushes file and verified directory for create, replace, and relative delete", () => {
    mkdirSync(join(directory, "parent"));
    writeFileSync(join(directory, "parent", "remove.txt"), "remove-me");
    const steps: NativeStep[] = [];
    const adapter = native.createWindowsNativeWriteAdapter({
      hooks: {
        beforeNativeStep(step) {
          steps.push(step);
        },
      },
    });

    adapter.writeVerifiedFile(directory, ["parent", "new.txt"], Buffer.from("new"), null);
    adapter.deleteVerifiedFile(directory, ["parent", "remove.txt"], hash("remove-me"));

    expect(readFileSync(join(directory, "parent", "new.txt"), "utf8")).toBe("new");
    expect(existsSync(join(directory, "parent", "remove.txt"))).toBe(false);
    expect(steps).toEqual(expect.arrayContaining([
      "create-temp",
      "write",
      "flush-file",
      "rename",
      "delete",
      "flush-directory",
    ]));
    expect(steps.filter((step) => step === "flush-directory")).toHaveLength(2);
  });

  it.each<NativeStep>([
    "create-temp",
    "write",
    "flush-file",
    "pre-target-open",
    "pre-parent-check",
    "rename",
    "post-target-open",
    "post-parent-check",
    "flush-directory",
  ])("fails closed at native %s without changing external or secret bytes", (fault) => {
    mkdirSync(join(directory, "parent"));
    writeFileSync(join(directory, "parent", "safe.txt"), "old");
    writeFileSync(join(directory, "external.txt"), "EXTERNAL-SECRET");
    let secretBytesObserved = 0;
    const adapter = native.createWindowsNativeWriteAdapter({
      hooks: {
        beforeNativeStep(step) {
          if (step === fault) throw new Error(`fault:${fault}`);
        },
        onWriteBytes(bytes) {
          if (Buffer.from(bytes).includes(Buffer.from("EXTERNAL-SECRET"))) {
            secretBytesObserved += bytes.byteLength;
          }
        },
      },
    });

    expectUnverifiable(() => adapter.writeVerifiedFile(
      directory,
      ["parent", "safe.txt"],
      Buffer.from("new"),
      hash("old"),
    ));
    expect(readFileSync(join(directory, "external.txt"), "utf8")).toBe("EXTERNAL-SECRET");
    expect(secretBytesObserved).toBe(0);
    expect(tempNames(join(directory, "parent"))).toEqual([]);
    expect(["old", "new"]).toContain(readFileSync(join(directory, "parent", "safe.txt"), "utf8"));
  });

  it("detects target and parent races before replace and conditionally cleans only its owned temp", () => {
    mkdirSync(join(directory, "parent"));
    writeFileSync(join(directory, "parent", "safe.txt"), "old");
    writeFileSync(join(directory, "external.txt"), "EXTERNAL-SECRET");
    let raced = false;
    const adapter = native.createWindowsNativeWriteAdapter({
      hooks: {
        beforeReplace() {
          if (raced) return;
          raced = true;
          renameSync(join(directory, "parent", "safe.txt"), join(directory, "parent", "moved.txt"));
          writeFileSync(join(directory, "parent", "safe.txt"), "EXTERNAL-SECRET");
        },
      },
    });

    expectUnverifiable(() => adapter.writeVerifiedFile(
      directory,
      ["parent", "safe.txt"],
      Buffer.from("new"),
      hash("old"),
    ));
    expect(readFileSync(join(directory, "parent", "safe.txt"), "utf8")).toBe("EXTERNAL-SECRET");
    expect(readFileSync(join(directory, "parent", "moved.txt"), "utf8")).toBe("old");
    expect(readFileSync(join(directory, "external.txt"), "utf8")).toBe("EXTERNAL-SECRET");
    expect(tempNames(join(directory, "parent"))).toEqual([]);
  });

  it("reports uncertain post-replace races and never deletes an externally replaced temp", () => {
    mkdirSync(join(directory, "parent"));
    writeFileSync(join(directory, "parent", "safe.txt"), "old");
    let replaced = false;
    const adapter = native.createWindowsNativeWriteAdapter({
      hooks: {
        afterReplace(name) {
          if (replaced) return;
          replaced = true;
          renameSync(join(directory, "parent", name), join(directory, "parent", "platform-result.txt"));
          writeFileSync(join(directory, "parent", name), "EXTERNAL-SECRET");
        },
      },
    });

    expectUnverifiable(() => adapter.writeVerifiedFile(
      directory,
      ["parent", "safe.txt"],
      Buffer.from("new"),
      hash("old"),
    ));
    expect(readFileSync(join(directory, "parent", "safe.txt"), "utf8")).toBe("EXTERNAL-SECRET");
    expect(readFileSync(join(directory, "parent", "platform-result.txt"), "utf8")).toBe("new");
  });

  it("checks identity and hash before relative delete and preserves raced external content", () => {
    mkdirSync(join(directory, "parent"));
    writeFileSync(join(directory, "parent", "safe.txt"), "old");
    const adapter = native.createWindowsNativeWriteAdapter({
      hooks: {
        beforeNativeStep(step) {
          if (step === "delete") {
            renameSync(join(directory, "parent", "safe.txt"), join(directory, "parent", "moved.txt"));
            writeFileSync(join(directory, "parent", "safe.txt"), "EXTERNAL-SECRET");
          }
        },
      },
    });

    expectUnverifiable(() =>
      adapter.deleteVerifiedFile(directory, ["parent", "safe.txt"], hash("old")));
    expect(readFileSync(join(directory, "parent", "safe.txt"), "utf8")).toBe("EXTERNAL-SECRET");
    expect(readFileSync(join(directory, "parent", "moved.txt"), "utf8")).toBe("old");
  });

  it.each<NativeStep>([
    "pre-target-open",
    "pre-parent-check",
    "delete",
    "flush-directory",
  ])("fails closed at delete native %s without deleting external bytes", (fault) => {
    mkdirSync(join(directory, "parent"));
    writeFileSync(join(directory, "parent", "safe.txt"), "old");
    writeFileSync(join(directory, "external.txt"), "EXTERNAL-SECRET");
    const adapter = native.createWindowsNativeWriteAdapter({
      hooks: {
        beforeNativeStep(step) {
          if (step === fault) throw new Error(`fault:${fault}`);
        },
      },
    });

    expectUnverifiable(() =>
      adapter.deleteVerifiedFile(directory, ["parent", "safe.txt"], hash("old")));
    expect(readFileSync(join(directory, "external.txt"), "utf8")).toBe("EXTERNAL-SECRET");
    if (fault === "flush-directory") {
      expect(existsSync(join(directory, "parent", "safe.txt"))).toBe(false);
    } else {
      expect(readFileSync(join(directory, "parent", "safe.txt"), "utf8")).toBe("old");
    }
  });

  it("replaces after the native read adapter is also constructed", async () => {
    mkdirSync(join(directory, "parent"));
    writeFileSync(join(directory, "parent", "safe.txt"), "old");
    const readModuleId = "@/src/adapters/outbound/workspace/windows-native-read-adapter";
    const read = await import(/* @vite-ignore */ readModuleId) as {
      createWindowsNativeReadAdapter(): unknown;
    };
    read.createWindowsNativeReadAdapter();
    const adapter = native.createWindowsNativeWriteAdapter();
    adapter.writeVerifiedFile(directory, ["parent", "safe.txt"], Buffer.from("new"), hash("old"));
    expect(readFileSync(join(directory, "parent", "safe.txt"), "utf8")).toBe("new");
  });

  it("replaces after a native read of the same file", async () => {
    mkdirSync(join(directory, "parent"));
    writeFileSync(join(directory, "parent", "safe.txt"), "old");
    const readModuleId = "@/src/adapters/outbound/workspace/windows-native-read-adapter";
    const read = await import(/* @vite-ignore */ readModuleId) as {
      createWindowsNativeReadAdapter(): {
        readVerifiedFile(rootPath: string, segments: string[], maximumBytes: number): Uint8Array;
      };
    };
    read.createWindowsNativeReadAdapter().readVerifiedFile(
      directory,
      ["parent", "safe.txt"],
      1024,
    );
    native.createWindowsNativeWriteAdapter().writeVerifiedFile(
      directory,
      ["parent", "safe.txt"],
      Buffer.from("new"),
      hash("old"),
    );
    expect(readFileSync(join(directory, "parent", "safe.txt"), "utf8")).toBe("new");
  });

  it("replaces a file in the verified root directory", () => {
    writeFileSync(join(directory, "root.txt"), "old");
    native.createWindowsNativeWriteAdapter().writeVerifiedFile(
      directory,
      ["root.txt"],
      Buffer.from("new"),
      hash("old"),
    );
    expect(readFileSync(join(directory, "root.txt"), "utf8")).toBe("new");
  });
});
