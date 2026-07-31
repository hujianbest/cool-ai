import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const packageJson = JSON.parse(
  readFileSync(join(root, "package.json"), "utf8"),
) as { scripts?: Record<string, string> };
const readme = readFileSync(join(root, "README.md"), "utf8");
const harnessPath = join(root, "tests", "context-browser-smoke.mjs");

describe("project-context developer loop contract", () => {
  it("documents and exposes the isolated context smoke command", () => {
    expect(packageJson.scripts?.["smoke:context"]).toBe(
      "node tests/context-browser-smoke.mjs",
    );
    expect(readme).toContain("npm run smoke:context");
    expect(readme).toContain("temporary workspace");
    expect(readme).toContain("content read/enumerate/write/exec = 0");
  });

  it("provides a compiling harness with required evidence and security contracts", () => {
    expect(existsSync(harnessPath)).toBe(true);
    if (!existsSync(harnessPath)) return;

    const source = readFileSync(harnessPath, "utf8");
    for (const contract of [
      "smoke-context-desktop.png",
      "smoke-context-narrow.png",
      "demo-project-context.png",
      "AUDIT PASS",
      "SECURITY PASS",
      "SHARED SNAPSHOT PASS",
      "PERSISTENCE PASS",
    ]) {
      expect(source).toContain(contract);
    }
    const syntax = spawnSync(process.execPath, ["--check", harnessPath], {
      encoding: "utf8",
    });
    expect(syntax.status, syntax.stderr).toBe(0);
  });
});
