import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

type RootKind = "journal" | "canonical";
type OwnedRef = {
  rootKind: RootKind;
  relativePath: string[];
  ownerId: string;
  parentIdentity: string;
  fileIdentity: string;
  finalPath: string;
  sha256: string;
  size: number;
};
type ExpectedFile = {
  rootKind: "canonical";
  relativePath: string[];
  exists: boolean;
  parentIdentity: string;
  fileIdentity: string | null;
  sha256: string | null;
  size: number | null;
};
type Result<T> =
  | { kind: "succeeded"; value: T }
  | { kind: "condition-mismatch"; observed: ExpectedFile }
  | { kind: "mutation-uncertain"; phase: string };
type NativeStep =
  | "open-root"
  | "open-parent"
  | "open-file"
  | "identity"
  | "final-path"
  | "read"
  | "create"
  | "write"
  | "flush-file"
  | "rename"
  | "delete"
  | "flush-directory"
  | "close";
type Adapter = {
  prepareOwnedFile(
    rootKind: RootKind,
    root: string,
    parentSegments: string[],
    name: string,
    ownerId: string,
    bytes: Uint8Array,
  ): Result<OwnedRef>;
  reopenOwnedFile(
    roots: { journal: string; canonical: string },
    ref: OwnedRef,
  ): Result<OwnedRef>;
  prepareCanonicalTempFromOwned(
    roots: { journal: string; canonical: string },
    sourceRef: OwnedRef,
    targetParentSegments: string[],
    tempName: string,
    ownerId: string,
  ): Result<OwnedRef>;
  conditionalReplacePrepared(
    roots: { journal: string; canonical: string },
    expectedTarget: ExpectedFile,
    preparedCanonicalTemp: OwnedRef,
  ): Result<ExpectedFile>;
  conditionalDelete(
    roots: { journal: string; canonical: string },
    expectedTarget: ExpectedFile,
  ): Result<{ deleted: true }>;
  conditionalCleanupOwned(
    roots: { journal: string; canonical: string },
    ref: OwnedRef,
  ): Result<{ deleted: true }>;
};
type NativeModule = {
  createWindowsNativeMergeLifecycleAdapter(options?: {
    hooks?: {
      beforeMutation?: (operation: "replace" | "delete" | "cleanup", name: string) => void;
      beforeNativeStep?: (step: NativeStep, name: string) => void;
      onClose?: (name: string, handle: unknown) => void;
      onWriteBytes?: (bytes: Uint8Array) => void;
    };
  }): Adapter;
};

let canonical: string;
let journal: string;
let native: NativeModule;

function hash(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function success<T>(result: Result<T>): T {
  expect(result.kind).toBe("succeeded");
  return (result as { kind: "succeeded"; value: T }).value;
}

function expected(ref: OwnedRef): ExpectedFile {
  return {
    rootKind: "canonical",
    relativePath: ref.relativePath,
    exists: true,
    parentIdentity: ref.parentIdentity,
    fileIdentity: ref.fileIdentity,
    sha256: ref.sha256,
    size: ref.size,
  };
}

beforeEach(async () => {
  const root = mkdtempSync(join(tmpdir(), "cool-ai-native-merge-"));
  canonical = join(root, "canonical");
  journal = join(root, "journal");
  mkdirSync(join(canonical, "parent"), { recursive: true });
  mkdirSync(join(journal, "owned"), { recursive: true });
  const moduleId = "@/src/adapters/outbound/workspace/windows-native-merge-lifecycle";
  native = await import(/* @vite-ignore */ moduleId) as NativeModule;
});

afterEach(() => {
  rmSync(join(canonical, ".."), { force: true, recursive: true });
});

describe("Windows merge-owned lifecycle", () => {
  it("closes prepared handles and lets a new adapter reopen the complete descriptor", () => {
    const closes = new Map<unknown, number>();
    const adapter = native.createWindowsNativeMergeLifecycleAdapter({
      hooks: {
        onClose(_name, handle) {
          closes.set(handle, (closes.get(handle) ?? 0) + 1);
        },
      },
    });
    const ref = success(adapter.prepareOwnedFile(
      "journal",
      journal,
      ["owned"],
      "action-1-new.bin",
      "action-1",
      Buffer.from("post"),
    ));
    const closesAfterPrepare = closes.size;
    const reopened = success(
      native.createWindowsNativeMergeLifecycleAdapter().reopenOwnedFile(
        { canonical, journal },
        ref,
      ),
    );

    expect(closesAfterPrepare).toBe(3);
    for (const count of closes.values()) expect(count).toBe(1);
    expect(reopened).toEqual(ref);
    expect(ref).toEqual(expect.objectContaining({
      rootKind: "journal",
      relativePath: ["owned", "action-1-new.bin"],
      ownerId: "action-1",
      parentIdentity: expect.stringMatching(/^[0-9a-f]+:[0-9a-f]{32}$/),
      fileIdentity: expect.stringMatching(/^[0-9a-f]+:[0-9a-f]{32}$/),
      finalPath: expect.stringContaining("action-1-new.bin"),
      sha256: hash("post"),
      size: 4,
    }));
    expect(native.createWindowsNativeMergeLifecycleAdapter().reopenOwnedFile(
      { canonical, journal },
      { ...ref, ownerId: "different-owner" },
    ).kind).not.toBe("succeeded");
  });

  it("supports old-to-post, post-to-old, added rollback, and owned cleanup", () => {
    const adapter = native.createWindowsNativeMergeLifecycleAdapter();
    const roots = { canonical, journal };
    const oldTarget = success(adapter.prepareOwnedFile(
      "canonical", canonical, ["parent"], "action-2-file.txt", "action-2", Buffer.from("old"),
    ));
    const backup = success(adapter.prepareOwnedFile(
      "journal", journal, ["owned"], "action-2-backup.bin", "action-2", Buffer.from("old"),
    ));
    const durableNew = success(adapter.prepareOwnedFile(
      "journal", journal, ["owned"], "action-2-new.bin", "action-2", Buffer.from("post"),
    ));
    const applyTemp = success(adapter.prepareCanonicalTempFromOwned(
      roots, durableNew, ["parent"], "action-2-apply.tmp", "action-2",
    ));
    const postTarget = success(adapter.conditionalReplacePrepared(
      roots, expected(oldTarget), applyTemp,
    ));
    expect(postTarget.fileIdentity).toBe(applyTemp.fileIdentity);
    expect(readFileSync(join(canonical, "parent", "action-2-file.txt"), "utf8")).toBe("post");

    const rollbackTemp = success(adapter.prepareCanonicalTempFromOwned(
      roots, backup, ["parent"], "action-2-rollback.tmp", "action-2",
    ));
    success(adapter.conditionalReplacePrepared(roots, postTarget, rollbackTemp));
    expect(readFileSync(join(canonical, "parent", "action-2-file.txt"), "utf8")).toBe("old");

    const addedSource = success(adapter.prepareOwnedFile(
      "journal", journal, ["owned"], "action-2-added.bin", "action-2", Buffer.from("added"),
    ));
    const addedTemp = success(adapter.prepareCanonicalTempFromOwned(
      roots, addedSource, ["parent"], "action-2-added.tmp", "action-2",
    ));
    const absent: ExpectedFile = {
      rootKind: "canonical",
      relativePath: ["parent", "added.txt"],
      exists: false,
      parentIdentity: addedTemp.parentIdentity,
      fileIdentity: null,
      sha256: null,
      size: null,
    };
    const addedPost = success(adapter.conditionalReplacePrepared(roots, absent, {
      ...addedTemp,
      relativePath: ["parent", "action-2-added.tmp"],
    }));
    // The prepared name is renamed to the expected target's final name.
    expect(readFileSync(join(canonical, "parent", "added.txt"), "utf8")).toBe("added");
    success(adapter.conditionalDelete(roots, addedPost));
    expect(existsSync(join(canonical, "parent", "added.txt"))).toBe(false);

    success(adapter.conditionalCleanupOwned(roots, backup));
    success(adapter.conditionalCleanupOwned(roots, durableNew));
    success(adapter.conditionalCleanupOwned(roots, addedSource));
  });

  it("preserves same-byte new identities and raced external bytes", () => {
    const base = native.createWindowsNativeMergeLifecycleAdapter();
    const roots = { canonical, journal };
    const target = success(base.prepareOwnedFile(
      "canonical", canonical, ["parent"], "action-3-race.txt", "action-3", Buffer.from("same"),
    ));
    const source = success(base.prepareOwnedFile(
      "journal", journal, ["owned"], "action-3-new.bin", "action-3", Buffer.from("new"),
    ));
    const temp = success(base.prepareCanonicalTempFromOwned(
      roots, source, ["parent"], "action-3.tmp", "action-3",
    ));
    const racing = native.createWindowsNativeMergeLifecycleAdapter({
      hooks: {
        beforeMutation(operation) {
          if (operation !== "replace") return;
          renameSync(
            join(canonical, "parent", "action-3-race.txt"),
            join(canonical, "parent", "moved.txt"),
          );
          writeFileSync(join(canonical, "parent", "action-3-race.txt"), "same");
        },
      },
    });

    expect(racing.conditionalReplacePrepared(roots, expected(target), temp).kind)
      .toBe("condition-mismatch");
    expect(readFileSync(join(canonical, "parent", "action-3-race.txt"), "utf8")).toBe("same");
    expect(readFileSync(join(canonical, "parent", "moved.txt"), "utf8")).toBe("same");
  });

  it("rejects a reparse parent race without touching the external target", () => {
    const adapter = native.createWindowsNativeMergeLifecycleAdapter();
    const roots = { canonical, journal };
    const target = success(adapter.prepareOwnedFile(
      "canonical", canonical, ["parent"], "action-4-safe.txt", "action-4", Buffer.from("old"),
    ));
    const source = success(adapter.prepareOwnedFile(
      "journal", journal, ["owned"], "action-4-new.bin", "action-4", Buffer.from("new"),
    ));
    const temp = success(adapter.prepareCanonicalTempFromOwned(
      roots, source, ["parent"], "action-4.tmp", "action-4",
    ));
    mkdirSync(join(canonical, "external"));
    writeFileSync(join(canonical, "external", "action-4-safe.txt"), "EXTERNAL-SECRET");
    renameSync(join(canonical, "parent"), join(canonical, "real-parent"));
    symlinkSync(join(canonical, "external"), join(canonical, "parent"), "junction");

    expect(adapter.conditionalReplacePrepared(roots, expected(target), temp).kind)
      .not.toBe("succeeded");
    expect(readFileSync(join(canonical, "external", "action-4-safe.txt"), "utf8"))
      .toBe("EXTERNAL-SECRET");
  });

  it.each<NativeStep>([
    "open-root", "open-parent", "open-file", "identity", "final-path", "read",
    "create", "write", "flush-file", "rename", "flush-directory", "close",
  ])("fails closed at native %s with zero external-byte overwrite and closes once", (fault) => {
    writeFileSync(join(canonical, "external.txt"), "EXTERNAL-SECRET");
    const closes = new Map<unknown, number>();
    let armed = false;
    let fired = false;
    const base = native.createWindowsNativeMergeLifecycleAdapter();
    const roots = { canonical, journal };
    let reopenRef: OwnedRef | undefined;
    let replaceInput: { expected: ExpectedFile; temp: OwnedRef } | undefined;
    if (fault === "open-file" || fault === "read") {
      reopenRef = success(base.prepareOwnedFile(
        "journal", journal, ["owned"], `fault-${fault}.bin`, "fault", Buffer.from("owned"),
      ));
    } else if (fault === "rename") {
      const target = success(base.prepareOwnedFile(
        "canonical", canonical, ["parent"], "fault-rename.txt", "fault", Buffer.from("old"),
      ));
      const source = success(base.prepareOwnedFile(
        "journal", journal, ["owned"], "fault-rename.bin", "fault", Buffer.from("new"),
      ));
      const temp = success(base.prepareCanonicalTempFromOwned(
        roots, source, ["parent"], "fault-rename.tmp", "fault",
      ));
      replaceInput = { expected: expected(target), temp };
    }
    const adapter = native.createWindowsNativeMergeLifecycleAdapter({
      hooks: {
        beforeNativeStep(step) {
          if (armed && !fired && step === fault) {
            fired = true;
            throw new Error(`fault:${fault}`);
          }
        },
        onClose(_name, handle) {
          closes.set(handle, (closes.get(handle) ?? 0) + 1);
        },
        onWriteBytes(bytes) {
          expect(Buffer.from(bytes).includes(Buffer.from("EXTERNAL-SECRET"))).toBe(false);
        },
      },
    });
    armed = true;
    const result = reopenRef
      ? adapter.reopenOwnedFile(roots, reopenRef)
      : replaceInput
        ? adapter.conditionalReplacePrepared(roots, replaceInput.expected, replaceInput.temp)
        : adapter.prepareOwnedFile(
            "journal",
            journal,
            ["owned"],
            `fault-${fault}.bin`,
            "fault",
            Buffer.from("owned"),
          );

    expect(result.kind).toBe("mutation-uncertain");
    expect(fired).toBe(true);
    expect(readFileSync(join(canonical, "external.txt"), "utf8")).toBe("EXTERNAL-SECRET");
    for (const count of closes.values()) expect(count).toBe(1);
  });

  it.each(["delete", "flush-directory", "close"] as const)(
    "fails closed at cleanup native %s without overwriting external bytes",
    (fault) => {
      const base = native.createWindowsNativeMergeLifecycleAdapter();
      const roots = { canonical, journal };
      const ref = success(base.prepareOwnedFile(
        "journal", journal, ["owned"], `cleanup-${fault}.bin`, "cleanup", Buffer.from("owned"),
      ));
      writeFileSync(join(canonical, "external.txt"), "EXTERNAL-SECRET");
      let fired = false;
      const adapter = native.createWindowsNativeMergeLifecycleAdapter({
        hooks: {
          beforeNativeStep(step) {
            if (!fired && step === fault) {
              fired = true;
              throw new Error(`fault:${fault}`);
            }
          },
        },
      });
      const result = adapter.conditionalCleanupOwned(roots, ref);

      expect(result.kind).toBe("mutation-uncertain");
      expect(fired).toBe(true);
      expect(readFileSync(join(canonical, "external.txt"), "utf8")).toBe("EXTERNAL-SECRET");
    },
  );

  it("keeps same-byte new identities during conditional delete and owned cleanup races", () => {
    const base = native.createWindowsNativeMergeLifecycleAdapter();
    const roots = { canonical, journal };
    const target = success(base.prepareOwnedFile(
      "canonical", canonical, ["parent"], "delete-race.txt", "delete-race", Buffer.from("same"),
    ));
    const owned = success(base.prepareOwnedFile(
      "journal", journal, ["owned"], "cleanup-race.bin", "cleanup-race", Buffer.from("same"),
    ));
    let deleteRaced = false;
    const deleteAdapter = native.createWindowsNativeMergeLifecycleAdapter({
      hooks: {
        beforeMutation(operation) {
          if (operation !== "delete" || deleteRaced) return;
          deleteRaced = true;
          renameSync(
            join(canonical, ...target.relativePath),
            join(canonical, "parent", "delete-platform.bin"),
          );
          writeFileSync(join(canonical, ...target.relativePath), "same");
        },
      },
    });
    expect(deleteAdapter.conditionalDelete(roots, expected(target)).kind)
      .toBe("condition-mismatch");
    expect(readFileSync(join(canonical, ...target.relativePath), "utf8")).toBe("same");

    let cleanupRaced = false;
    const cleanupAdapter = native.createWindowsNativeMergeLifecycleAdapter({
      hooks: {
        beforeMutation(operation) {
          if (operation !== "cleanup" || cleanupRaced) return;
          cleanupRaced = true;
          renameSync(
            join(journal, ...owned.relativePath),
            join(journal, "owned", "cleanup-platform.bin"),
          );
          writeFileSync(join(journal, ...owned.relativePath), "same");
        },
      },
    });
    expect(cleanupAdapter.conditionalCleanupOwned(roots, owned).kind)
      .toBe("condition-mismatch");
    expect(readFileSync(join(journal, ...owned.relativePath), "utf8")).toBe("same");
  });
});
