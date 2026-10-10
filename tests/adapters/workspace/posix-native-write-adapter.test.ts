import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  createPosixNativeWriteAdapter,
  createPosixNativeMergeLifecycleAdapter,
  type ExpectedCanonicalFile,
  type VerifiedOwnedFileRef,
} from "@/src/adapters/outbound/workspace/posix-native-write-adapter";
import { WindowsNativeWriteFailure } from "@/src/modules/safe-execution";
import { createHash } from "node:crypto";

const describePosix = process.platform === "darwin" ? describe : describe.skip;

function temporaryWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "cool-ai-posix-write-"));
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describePosix("posix native write adapter", () => {
  it("creates a verified file atomically when the target is absent", () => {
    const root = temporaryWorkspace();
    mkdirSync(join(root, "nested"));
    const adapter = createPosixNativeWriteAdapter();
    try {
      const bytes = new TextEncoder().encode("first content");
      const result = adapter.writeVerifiedFile(root, ["nested", "file.txt"], bytes, null);
      expect(result.hash).toBe(sha256(bytes));
      expect(result.identity.fileId).toMatch(/^[0-9a-f]{32}$/);
      expect(readFileSync(join(root, "nested", "file.txt"), "utf8")).toBe("first content");
      expect(adapter.writeVerifiedFile(root, ["nested", "file.txt"], bytes, result.hash).hash)
        .toBe(result.hash);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("replaces an existing file only when the expected hash matches", () => {
    const root = temporaryWorkspace();
    writeFileSync(join(root, "file.txt"), "original");
    const adapter = createPosixNativeWriteAdapter();
    try {
      const wrongHash = sha256("not-the-content");
      let outcome = "";
      try {
        adapter.writeVerifiedFile(
          root,
          ["file.txt"],
          new TextEncoder().encode("new"),
          wrongHash,
        );
      } catch (error) {
        outcome = (error as WindowsNativeWriteFailure).mutationState;
      }
      expect(outcome).toBe("cleanup-confirmed");
      expect(readFileSync(join(root, "file.txt"), "utf8")).toBe("original");

      const correctHash = sha256("original");
      const replaced = adapter.writeVerifiedFile(
        root,
        ["file.txt"],
        new TextEncoder().encode("replaced"),
        correctHash,
      );
      expect((replaced as { hash: string }).hash).toBe(sha256("replaced"));
      expect(readFileSync(join(root, "file.txt"), "utf8")).toBe("replaced");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("leaves no temp files behind and rejects invalid requests", () => {
    const root = temporaryWorkspace();
    const adapter = createPosixNativeWriteAdapter();
    try {
      const { readdirSync } = require("node:fs") as typeof import("node:fs");
      expect(() =>
        adapter.writeVerifiedFile(root, [], new TextEncoder().encode("x"), null))
        .toThrow();
      expect(() =>
        adapter.writeVerifiedFile(root, ["a/../b"], new TextEncoder().encode("x"), null))
        .toThrow();
      expect(readdirSync(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("classifies post-rename failures and confirmed cleanup under fault injection", () => {
    const root = temporaryWorkspace();
    writeFileSync(join(root, "file.txt"), "original");
    const beforeRename = vi.fn();
    const adapter = createPosixNativeWriteAdapter({
      hooks: {
        beforeNativeStep(step, name) {
          if (step === "rename" && name === "file.txt") {
            beforeRename();
            throw new Error("injected rename fault");
          }
        },
      },
    });
    try {
      let outcome = "not-thrown";
      try {
        adapter.writeVerifiedFile(
          root,
          ["file.txt"],
          new TextEncoder().encode("next"),
          sha256("original"),
        );
      } catch (error) {
        outcome = (error as WindowsNativeWriteFailure).mutationState;
      }
      expect(beforeRename).toHaveBeenCalled();
      expect(outcome).toBe("cleanup-confirmed");
      expect(readFileSync(join(root, "file.txt"), "utf8")).toBe("original");
      const { readdirSync } = require("node:fs") as typeof import("node:fs");
      expect(readdirSync(root)).toEqual(["file.txt"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("deletes a verified file only when the hash matches", () => {
    const root = temporaryWorkspace();
    writeFileSync(join(root, "file.txt"), "bye");
    const adapter = createPosixNativeWriteAdapter();
    try {
      expect(() => adapter.deleteVerifiedFile(root, ["file.txt"], sha256("wrong")))
        .toThrow();
      const { existsSync } = require("node:fs") as typeof import("node:fs");
      expect(existsSync(join(root, "file.txt"))).toBe(true);
      adapter.deleteVerifiedFile(root, ["file.txt"], sha256("bye"));
      expect(existsSync(join(root, "file.txt"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describePosix("posix native merge lifecycle", () => {
  it("prepares, reopens, replaces, and cleans up owned files conditionally", () => {
    const canonical = temporaryWorkspace();
    const journal = temporaryWorkspace();
    const lifecycle = createPosixNativeMergeLifecycleAdapter();
    try {
      const bytes = new TextEncoder().encode("owned payload");
      const prepared = lifecycle.prepareOwnedFile(
        "journal",
        journal,
        [],
        "merge-owner-1.part",
        "owner-1",
        bytes,
      );
      expect(prepared.kind).toBe("succeeded");
      const ref = (prepared as { value: VerifiedOwnedFileRef }).value;
      expect(ref.ownerId).toBe("owner-1");
      expect(ref.sha256).toBe(sha256(bytes));
      expect(ref.fileIdentity).toMatch(/^[0-9a-f]+:[0-9a-f]{32}$/);

      const reopened = lifecycle.reopenOwnedFile(
        { canonical, journal },
        ref,
      );
      expect(reopened.kind).toBe("succeeded");

      writeFileSync(join(canonical, "target.txt"), "current");
      // Observe the real canonical target through the public seam: a delete
      // with a wrong hash reports the observed state as condition-mismatch.
      const probe = lifecycle.conditionalDelete({ canonical, journal }, {
        exists: true,
        fileIdentity: null,
        parentIdentity: "",
        relativePath: ["target.txt"],
        rootKind: "canonical" as const,
        sha256: sha256("wrong"),
        size: 0,
      });
      expect(probe.kind).toBe("condition-mismatch");
      const observed = (probe as { observed: ExpectedCanonicalFile }).observed;
      expect(observed.exists).toBe(true);
      expect(observed.sha256).toBe(sha256("current"));

      const canonicalTemp = lifecycle.prepareCanonicalTempFromOwned(
        { canonical, journal },
        ref,
        [],
        "canonical-owner-1.tmp",
        "owner-1",
      );
      expect(canonicalTemp.kind).toBe("succeeded");

      const replaced = lifecycle.conditionalReplacePrepared(
        { canonical, journal },
        observed,
        (canonicalTemp as { value: VerifiedOwnedFileRef }).value,
      );
      expect(replaced.kind).toBe("succeeded");
      expect(readFileSync(join(canonical, "target.txt"), "utf8")).toBe("owned payload");

      const deleted = lifecycle.conditionalDelete({ canonical, journal }, {
        exists: true,
        fileIdentity: (canonicalTemp as { value: VerifiedOwnedFileRef }).value.fileIdentity,
        parentIdentity: observed.parentIdentity,
        relativePath: ["target.txt"],
        rootKind: "canonical" as const,
        sha256: sha256("owned payload"),
        size: bytes.byteLength,
      });
      expect(deleted.kind).toBe("succeeded");

      const cleaned = lifecycle.conditionalCleanupOwned({ canonical, journal }, ref);
      expect(cleaned.kind).toBe("succeeded");
    } finally {
      rmSync(canonical, { recursive: true, force: true });
      rmSync(journal, { recursive: true, force: true });
    }
  });

  it("reports mutation-uncertain when a native step fails", () => {
    const journal = temporaryWorkspace();
    const lifecycle = createPosixNativeMergeLifecycleAdapter({
      hooks: {
        beforeNativeStep(step, name) {
          if (step === "flush-file" && name.includes("owner")) {
            throw new Error("injected flush fault");
          }
        },
      },
    });
    try {
      const result = lifecycle.prepareOwnedFile(
        "journal",
        journal,
        [],
        "merge-owner-9.part",
        "owner",
        new TextEncoder().encode("x"),
      );
      expect(result.kind).toBe("mutation-uncertain");
    } finally {
      rmSync(journal, { recursive: true, force: true });
    }
  });
});
