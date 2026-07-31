import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const readIfPresent = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : "");

describe("one-command developer loop", () => {
  it("documents reproducible install, development, test, build, and smoke commands", () => {
    const readmePath = join(root, "README.md");
    expect(existsSync(readmePath)).toBe(true);
    const readme = readIfPresent(readmePath);

    for (const command of [
      "npm install",
      "npm run dev",
      "npm test",
      "npm run build",
      "npm run smoke",
    ]) {
      expect(readme).toContain(command);
    }
    expect(readme).toMatch(/Node\.js 24/i);
    expect(readme).toMatch(/COCKPIT_DB_PATH/);
    expect(readme).toMatch(/port|3000/i);
  });

  it("provides a real Playwright smoke command and harness", () => {
    const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const smokePath = join(root, "tests", "browser-smoke.mjs");

    expect(packageJson.scripts?.smoke).toBe("node tests/browser-smoke.mjs");
    expect(packageJson.devDependencies?.playwright).toEqual(expect.any(String));
    expect(existsSync(smokePath)).toBe(true);

    const smoke = readIfPresent(smokePath);
    for (const contract of [
      "chromium.launch",
      "COCKPIT_DB_PATH",
      "page.reload",
      "scrollWidth",
      "smoke-desktop.png",
      "demo-cockpit.png",
    ]) {
      expect(smoke).toContain(contract);
    }
  });
});
