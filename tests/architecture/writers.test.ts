import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readSource, ROOT, sourceFiles } from "./helpers";

/**
 * Writer-location guardrail (product/architecture.md section 10):
 * runtime writes to an owner's tables only from that owner's adapter dirs.
 * Blocking per owner once its migration wave lands (MIGRATED_OWNERS);
 * the frozen pre-migration writer count is ratcheted so it can only shrink.
 */

const MANIFEST = JSON.parse(
  readFileSync(resolve(ROOT, "tests/architecture/write-ownership.manifest.json"), "utf8"),
) as { owners: Record<string, string[]> };

/** Canonical bootstrap/validation lifecycle entry — DDL only, exempt from writer rules. */
const LIFECYCLE_FILES = new Set([
  "src/adapters/outbound/sqlite/current-schema.ts",
  "src/adapters/outbound/sqlite/bootstrap-current-schema.ts",
  "src/adapters/outbound/sqlite/validate-current-schema.ts",
  "src/adapters/outbound/sqlite/current-data-invariants.ts",
  "src/adapters/outbound/sqlite/schema-error.ts",
]);

/** Per-owner allowed production writer dirs (adapter layer of that owner). */
const OWNER_WRITER_DIRS: Record<string, RegExp[]> = {
  "identity-capability": [/^src\/adapters\/outbound\/sqlite\/identity-capability\//u],
  "project-workspace": [
    /^src\/adapters\/outbound\/sqlite\/project-workspace\//u,
    /^src\/adapters\/outbound\/workspace\//u,
  ],
  "mission-work": [/^src\/adapters\/outbound\/sqlite\/mission-work\//u],
  "public-collaboration": [/^src\/adapters\/outbound\/sqlite\/public-collaboration\//u],
  "safe-execution": [
    /^src\/adapters\/outbound\/sqlite\/safe-execution\//u,
    /^src\/adapters\/outbound\/workspace\//u,
  ],
  governance: [/^src\/adapters\/outbound\/sqlite\/governance\//u],
  "review-delivery": [/^src\/adapters\/outbound\/sqlite\/review-delivery\//u],
  "knowledge-provenance": [/^src\/adapters\/outbound\/sqlite\/knowledge-provenance\//u],
};

/** Owners whose migration wave has landed; writer rule blocks for these. */
const MIGRATED_OWNERS: string[] = [
  "identity-capability",
  "project-workspace",
  "mission-work",
  "knowledge-provenance",
  "governance",
  "safe-execution",
  "public-collaboration",
  "review-delivery",
];

/**
 * Known transitional non-owner writers, frozen 2026-08-09 (see the ratchet below).
 * This set may only shrink.
 * T-11: review-delivery no longer writes mission-work's work_items directly — the
 * completion/finalizer board projections were extracted verbatim into
 * src/adapters/outbound/sqlite/mission-work/work-item-status-effects.ts.
 * T-07: review-finalizer still persists review_memory_candidates inline inside the
 * finalization transaction; the candidate write path is formalized in T-13.
 * T-09: validation-policy-service persists its idempotent operation receipt in
 * safe-execution's execution_operations (the T-05 registered cross-domain seam);
 * the receipt write path is formalized in T-13/T-14.
 * T-11: merge-journal-service's merge rollback deletes review-delivery's
 * work_item_review_heads projections (frozen ratchet edge
 * "merge-journal-service->work_item_review_heads"); formalized in T-13.
 */
const TRANSITIONAL_NON_OWNER_WRITERS: Array<{ file: string; owner: string; table: string }> = [
  {
    file: "src/adapters/outbound/sqlite/review-delivery/review-finalizer.ts",
    owner: "knowledge-provenance",
    table: "review_memory_candidates",
  },
  {
    file: "src/adapters/outbound/sqlite/safe-execution/merge-journal-service.ts",
    owner: "review-delivery",
    table: "work_item_review_heads",
  },
  {
    file: "src/adapters/outbound/sqlite/project-workspace/validation-policy-service.ts",
    owner: "safe-execution",
    table: "execution_operations",
  },
];

const WRITE_RE =
  /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM|REPLACE\s+INTO)\s+([A-Za-z_]\w*)/giu;

function productionWritersByTable(): Map<string, string[]> {
  const tables = new Set(Object.values(MANIFEST.owners).flat());
  const byTable = new Map<string, string[]>();
  const productionFiles = [
    ...sourceFiles("src"),
    ...sourceFiles("app"),
  ].filter((file) => !LIFECYCLE_FILES.has(file) && !/^src\/adapters\/outbound\/sqlite\/(?:current-schema|lifecycle)/u.test(file));
  for (const file of productionFiles) {
    const text = readSource(file);
    const written = new Set<string>();
    for (const match of text.matchAll(WRITE_RE)) {
      if (tables.has(match[1])) written.add(match[1]);
    }
    for (const table of written) {
      const list = byTable.get(table) ?? [];
      list.push(file);
      byTable.set(table, list);
    }
  }
  return byTable;
}

describe("writer location by owner", () => {
  const byTable = productionWritersByTable();

  it("keeps every registered table with at least one production writer", () => {
    const missing = Object.values(MANIFEST.owners)
      .flat()
      .filter((table) => !(byTable.get(table)?.length));
    expect(missing, `tables without any production writer: ${missing.join(", ")}`).toEqual([]);
  });

  it("blocks non-owner writers for migrated owners", () => {
    const found: string[] = [];
    for (const owner of MIGRATED_OWNERS) {
      const allowed = OWNER_WRITER_DIRS[owner];
      for (const table of MANIFEST.owners[owner] ?? []) {
        for (const file of byTable.get(table) ?? []) {
          if (!allowed.some((pattern) => pattern.test(file))) {
            const exempt = TRANSITIONAL_NON_OWNER_WRITERS.some(
              (entry) =>
                entry.owner === owner && entry.table === table && entry.file === file,
            );
            if (!exempt) {
              found.push(`${table} (${owner}) written by ${file}`);
            }
          }
        }
      }
    }
    expect(found).toEqual([]);
  });

  it("ratchets cross-owner writer edges at the frozen count", () => {
    // Frozen 2026-08-09 (8 edges): mission-service->collaboration_operations;
    // merge-journal-service->work_item_review_heads; validation-policy-service->
    // project_validation_policy_* (x4); completion-gate/review-finalizer->work_items.
    // T-11: the review->work_items edges are gone (extracted into mission-work's
    // work-item-status-effects capability); src/server/review/ is deleted, so the
    // fileOwner map below no longer attributes review files — the migrated-owner
    // writer block above is now the guard for review-delivery's eleven tables.
    // Each migration wave resolves its edges; the count may only shrink.
    const ownerOf = new Map<string, string>();
    for (const [owner, tables] of Object.entries(MANIFEST.owners)) {
      for (const table of tables) ownerOf.set(table, owner);
    }
    const ROOT_FILE_OWNER: Record<string, string> = {
      "mission-service.ts": "mission-work",
      "tasks.ts": "mission-work",
      "task-api.ts": "mission-work",
      "mission-api.ts": "mission-work",
      "projects.ts": "project-workspace",
      "membership-service.ts": "project-workspace",
      "membership-api.ts": "project-workspace",
      "workspace-service.ts": "project-workspace",
      "context-api.ts": "project-workspace",
      "context-snapshot-service.ts": "project-workspace",
      "memory-service.ts": "knowledge-provenance",
      "memory-api.ts": "knowledge-provenance",
      "memory-source-resolver.ts": "knowledge-provenance",
      "agent-service.ts": "identity-capability",
      "agent-api.ts": "identity-capability",
      "skill-service.ts": "identity-capability",
      "skill-api.ts": "identity-capability",
      "provider-service.ts": "identity-capability",
      "provider-api.ts": "identity-capability",
      "credential-vault.ts": "identity-capability",
      "provider-verifier.ts": "runtime",
    };
    const fileOwner = (file: string): string | null => {
      const subdir = file.match(/^src\/server\/([^/]+)\//u)?.[1];
      if (subdir) {
        if (subdir === "collaboration" || subdir === "structured-messages") return "public-collaboration";
        if (subdir === "execution") return "safe-execution"; // governance extraction lands in T-08
        if (subdir === "review") return "review-delivery";
        if (subdir === "mission") return "mission-work";
        if (subdir === "storage" || subdir === "application" || subdir === "composition") return "__infra__";
        return null;
      }
      const base = file.match(/^src\/server\/([^/]+\.ts)$/u)?.[1];
      return (base && ROOT_FILE_OWNER[base]) ?? null;
    };
    let crossEdges = 0;
    const found: string[] = [];
    for (const [table, files] of byTable) {
      const tableOwner = ownerOf.get(table);
      for (const file of files) {
        const writerOwner = fileOwner(file);
        if (!writerOwner || writerOwner === "__infra__") continue;
        if (writerOwner !== tableOwner) {
          // memory facts are written by review/ until T-07/T-11
          const tolerated =
            tableOwner === "knowledge-provenance" && writerOwner === "review-delivery";
          if (!tolerated) {
            crossEdges += 1;
            found.push(`${table} (${tableOwner}) written by ${file} (${writerOwner})`);
          }
        }
      }
    }
    expect(
      crossEdges,
      `cross-owner writer edges grew to ${crossEdges} (frozen at 8): ${found.join("; ")}`,
    ).toBeLessThanOrEqual(8);
  });
});
