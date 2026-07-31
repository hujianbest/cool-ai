import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const packageJson = JSON.parse(
  readFileSync(join(root, "package.json"), "utf8"),
) as { scripts?: Record<string, string> };
const readme = readFileSync(join(root, "README.md"), "utf8");
const harnessPath = join(root, "tests", "collaboration-browser-smoke.mjs");

describe("collaboration browser verification contract", () => {
  it("documents and exposes the isolated collaboration smoke command", () => {
    expect(packageJson.scripts?.["smoke:collaboration"]).toBe(
      "node tests/collaboration-browser-smoke.mjs",
    );
    expect(readme).toContain("npm run smoke:collaboration");
    expect(readme).toContain("two distinct Agents");
    expect(readme).toContain("local OpenAI-compatible provider");
  });

  it("provides a compiling harness with behavioral, recovery, and evidence contracts", () => {
    expect(existsSync(harnessPath)).toBe(true);
    if (!existsSync(harnessPath)) return;

    const source = readFileSync(harnessPath, "utf8");
    for (const contract of [
      "demo-collaboration-desktop.png",
      "demo-collaboration-narrow.png",
      "/chat/completions",
      "primary",
      "repair",
      "handoff",
      "decision_request",
      "plan_ready",
      "page.reload",
      "restartAppServer",
      "OUTBOUND ALLOWLIST PASS",
      "PRIVATE SEPARATION PASS",
      "SECURITY SCAN PASS",
      "RECOVERY PASS",
      "BROWSER PASS",
    ]) {
      expect(source, contract).toContain(contract);
    }

    for (const securitySurface of [
      "productApiBodies",
      "domText",
      "serverOutput",
      "evidenceFacingData",
    ]) {
      expect(source).toContain(securitySurface);
    }

    const syntax = spawnSync(process.execPath, ["--check", harnessPath], {
      encoding: "utf8",
    });
    expect(syntax.status, syntax.stderr).toBe(0);
  });
});
