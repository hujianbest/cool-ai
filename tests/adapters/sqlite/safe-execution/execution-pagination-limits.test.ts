import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  assertTextChunkInvariants,
  computeStagedSnapshot,
  createBoundedUtf8Text,
  type StagingEntry,
} from "@/src/adapters/outbound/sqlite/safe-execution/stage-service";

const HASH = "a".repeat(64);

function text(path: string, content = ""): StagingEntry {
  return {
    content,
    kind: "text",
    modeTag: "644",
    path,
    sha256: createHash("sha256").update(content).digest("hex"),
    size: Buffer.byteLength(content, "utf8"),
  };
}

async function* entries(values: Iterable<StagingEntry>): AsyncIterable<StagingEntry> {
  yield* values;
}

function stageInput(sandbox: AsyncIterable<StagingEntry>) {
  return {
    attemptId: "attempt",
    baseline: entries([]),
    baselineManifestHash: HASH,
    contextHash: "b".repeat(64),
    pendingApproval: false,
    policyHash: "c".repeat(64),
    policyRevisionId: "policy",
    requiredPolicyEntryIds: [],
    requiredValidations: [],
    sandbox,
    sandboxManifestHash: "d".repeat(64),
  };
}

describe("execution pagination and persisted limits", () => {
  it("preserves the worst legal UTF-8 body in seventeen scalar-safe chunks", () => {
    const value = "€".repeat(349_525);
    expect(Buffer.byteLength(value, "utf8")).toBe(1_048_575);
    const output = createBoundedUtf8Text(value);

    expect(output.bytes).toBe(1_048_575);
    expect(output.chunks).toHaveLength(17);
    expect(output.chunks.map((chunk) => chunk.byteOffset)).toEqual(
      output.chunks.map((_, index, chunks) =>
        chunks.slice(0, index).reduce((total, chunk) => total + chunk.byteLength, 0)),
    );
    expect(output.chunks.every((chunk) =>
      chunk.byteLength <= 65_536
      && Buffer.byteLength(chunk.text, "utf8") === chunk.byteLength
      && !chunk.text.includes("\uFFFD"))).toBe(true);
    expect(output.chunks.map((chunk) => chunk.text).join("")).toBe(value);
    expect(() => assertTextChunkInvariants(output, output.chunks)).not.toThrow();
  });

  it("retains the 101st observation but excludes the whole set from merge rows", async () => {
    const sandbox = Array.from({ length: 101 }, (_, index) =>
      text(`src/file-${String(index).padStart(3, "0")}.txt`, "x"));
    const staged = await computeStagedSnapshot(stageInput(entries(sandbox)));

    expect(staged.totals).toMatchObject({
      blockerCount: 1,
      mergeFileCount: 0,
      observedPathCount: 101,
    });
    expect(staged.observations.at(-1)).toMatchObject({
      path: "src/file-100.txt",
      position: 100,
    });
    expect(staged.blockers).toEqual([
      expect.objectContaining({ kind: "file_count_limit", position: 100 }),
    ]);
    expect(staged.classification).toBe("blocked");
  });

  it("streams exactly 100000 observations through the staging adapter boundary", async () => {
    async function* generated(): AsyncIterable<StagingEntry> {
      for (let index = 0; index < 100_000; index += 1) {
        yield text(`generated/${String(index).padStart(6, "0")}.txt`);
      }
    }
    const staged = await computeStagedSnapshot(stageInput(generated()));

    expect(staged.totals.observedPathCount).toBe(100_000);
    expect(staged.observations[0]).toMatchObject({
      path: "generated/000000.txt",
      position: 0,
    });
    expect(staged.observations.at(-1)).toMatchObject({
      path: "generated/099999.txt",
      position: 99_999,
    });
    expect(staged.totals.mergeFileCount).toBe(0);
    expect(staged.classification).toBe("blocked");
  }, 60_000);
});
