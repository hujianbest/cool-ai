import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const harnessPath = resolve("tests/browser/settings-navigation-browser-smoke.mjs");

describe("settings navigation browser smoke contract", () => {
  it("exposes an isolated S-9 browser command", () => {
    const packageJson = JSON.parse(
      readFileSync(resolve("package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };

    expect(packageJson.scripts?.["smoke:settings"]).toBe(
      "node tests/browser/settings-navigation-browser-smoke.mjs",
    );
    expect(existsSync(harnessPath)).toBe(true);
  });

  it("covers the required settings demo and stable evidence", () => {
    if (!existsSync(harnessPath)) return;

    const source = readFileSync(harnessPath, "utf8");
    for (const contract of [
      "COCKPIT_DB_PATH",
      "cool-ai-settings-smoke-",
      "settings-navigation-desktop.png",
      "settings-navigation-narrow.png",
      "settings-navigation-results.json",
      "AxeBuilder",
      "critical",
      "创建项目",
      "搜索设置分区",
      "打开固定设置：Agent",
      "固定历史",
      "localStorage",
      "返回原位置",
      "https://evil.example",
      "//evil.example",
      "%2F",
      "%5C",
      "%2e%2e",
    ]) {
      expect(source).toContain(contract);
    }
    expect(source).not.toContain("page.route(");
    expect(source).not.toContain("route.fulfill(");

    const syntax = spawnSync(process.execPath, ["--check", harnessPath], {
      encoding: "utf8",
    });
    expect(syntax.status, syntax.stderr).toBe(0);
  });
});
