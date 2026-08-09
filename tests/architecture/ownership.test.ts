import { describe, expect, it } from "vitest";

import { readSource, ROOT } from "./helpers";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const MANIFEST = JSON.parse(
  readFileSync(resolve(ROOT, "tests/architecture/write-ownership.manifest.json"), "utf8"),
) as { owners: Record<string, string[]> };

/** The canonical schema DDL source of truth (sqlite adapter, since T-03). */
const CANONICAL_SCHEMA_SOURCE = "src/adapters/outbound/sqlite/current-schema.ts";

const CREATE_TABLE_RE = /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_]\w*)/giu;

describe("write-ownership manifest", () => {
  it("registers every canonical-schema table under exactly one owner", () => {
    const schemaText = readSource(CANONICAL_SCHEMA_SOURCE);
    const schemaTables = new Set(
      [...schemaText.matchAll(CREATE_TABLE_RE)].map((match) => match[1]),
    );
    expect(schemaTables.size).toBeGreaterThan(50);

    const registration = new Map<string, string>();
    for (const [owner, tables] of Object.entries(MANIFEST.owners)) {
      for (const table of tables) {
        expect(
          registration.has(table),
          `table ${table} registered under both ${registration.get(table)} and ${owner}`,
        ).toBe(false);
        registration.set(table, owner);
      }
    }

    const unregistered = [...schemaTables].filter((table) => !registration.has(table));
    const phantom = [...registration.keys()].filter((table) => !schemaTables.has(table));
    expect(unregistered, `unregistered tables: ${unregistered.join(", ")}`).toEqual([]);
    expect(phantom, `phantom tables not in schema: ${phantom.join(", ")}`).toEqual([]);
  });

  it("keeps the manifest owner vocabulary aligned with the target module set", () => {
    const knownOwners = new Set([
      "identity-capability",
      "project-workspace",
      "mission-work",
      "public-collaboration",
      "safe-execution",
      "governance",
      "review-delivery",
      "knowledge-provenance",
      "runtime",
      "operations-projection",
    ]);
    for (const owner of Object.keys(MANIFEST.owners)) {
      expect(knownOwners.has(owner), `unknown owner ${owner}`).toBe(true);
    }
  });
});
