import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const packageJson = JSON.parse(
  readFileSync(join(root, "package.json"), "utf8"),
) as { scripts?: Record<string, string> };
const readme = readFileSync(join(root, "README.md"), "utf8");
const smokePath = join(root, "tests", "browser", "team-browser-smoke.mjs");
const smoke = existsSync(smokePath) ? readFileSync(smokePath, "utf8") : "";

describe("Team browser developer loop and security contract", () => {
  it("exposes a separate documented smoke:team command", () => {
    expect(packageJson.scripts?.["smoke:team"]).toBe(
      "node tests/browser/team-browser-smoke.mjs",
    );
    expect(readme).toContain("npm run smoke:team");
    expect(readme).toContain("COCKPIT_MASTER_KEY");
    expect(readme).toContain('randomBytes(32).toString("base64url")');
    expect(readme).not.toMatch(
      /COCKPIT_MASTER_KEY\s*=\s*['"]?[A-Za-z0-9_-]{43}['"]?/,
    );
  });

  it("isolates the app, database, key and local compatible provider", () => {
    expect(smoke).toContain("mkdtempSync");
    expect(smoke).toContain("COCKPIT_DB_PATH");
    expect(smoke).toContain("COCKPIT_MASTER_KEY");
    expect(smoke).toContain("randomBytes(32).toString(\"base64url\")");
    expect(smoke).toContain("createServer");
    expect(smoke).toContain("/v1/models");
    expect(smoke).toContain("redirectAuthorizationCount");
    expect(smoke).toContain("rmSync(temporaryDirectory");
  });

  it("drives the complete persisted Team browser behavior", () => {
    for (const marker of [
      "创建模型服务",
      "验证连接",
      "创建新技能",
      "编辑 Smoke Skill",
      "planner",
      "builder",
      "page.reload",
      "getByRole(\"dialog\"",
      "Escape",
      "打开团队资源",
      "关闭模型服务编辑器",
      "关闭技能编辑器",
      "关闭 Agent 编辑器",
    ]) {
      expect(smoke, marker).toContain(marker);
    }
  });

  it("writes exact visual evidence and scans every secret surface", () => {
    for (const filename of [
      "smoke-team-desktop.png",
      "smoke-team-narrow.png",
      "demo-agent-team.png",
    ]) {
      expect(smoke).toContain(filename);
    }
    for (const surface of [
      "database",
      "apiBodies",
      "serverOutput",
      "fallbackErrors",
      "domText",
      "evidenceLogs",
    ]) {
      expect(smoke).toContain(surface);
    }
    expect(smoke).toContain("SECURITY SCAN PASS: secret occurrences=0");
    expect(smoke).toContain("REDIRECT CHECK PASS: authorization requests=0");
  });
});
