import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Test partition guardrail (product/architecture.md section 7):
 * tests/ root holds only shared infrastructure; every test file lives in
 * modules/ workflows/ adapters/ browser/ architecture/ fixtures/ or shared/.
 */

const ALLOWED_ROOT_FILES = new Set([
  "setup.ts",
  "cockpit-test-fetch.ts",
]);

const ALLOWED_ROOT_DIRS = new Set([
  "modules",
  "workflows",
  "adapters",
  "browser",
  "architecture",
  "fixtures",
  "shared",
]);

describe("tests/ partition", () => {
  it("keeps no stray test files at the tests/ root", () => {
    const root = resolve(process.cwd(), "tests");
    const entries = readdirSync(root, { withFileTypes: true });
    const strayTests = entries
      .filter((entry) => entry.isFile() && /\.test\.(?:ts|tsx|mjs)$/u.test(entry.name))
      .map((entry) => entry.name);
    expect(strayTests, `stray root test files: ${strayTests.join(", ")}`).toEqual([]);
  });

  it("keeps only known infrastructure files and partition dirs at the tests/ root", () => {
    const root = resolve(process.cwd(), "tests");
    const entries = readdirSync(root, { withFileTypes: true });
    const unexpected = entries
      .filter((entry) =>
        entry.isFile()
          ? !ALLOWED_ROOT_FILES.has(entry.name)
          : !ALLOWED_ROOT_DIRS.has(entry.name),
      )
      .map((entry) => entry.name);
    expect(unexpected, `unexpected tests/ root entries: ${unexpected.join(", ")}`).toEqual([]);
  });
});
