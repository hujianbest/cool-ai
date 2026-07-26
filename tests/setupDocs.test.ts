import { readFileSync, existsSync } from "node:fs";
import { describe, it, expect } from "vitest";

describe("one-command setup", () => {
  it("README documents dev and test commands", () => {
    const readme = readFileSync("README.md", "utf8");
    expect(readme).toContain("npm run dev");
    expect(readme).toContain("npm test");
  });

  it(".gitignore excludes deps, build output and local db files", () => {
    expect(existsSync(".gitignore")).toBe(true);
    const gi = readFileSync(".gitignore", "utf8");
    expect(gi).toContain("node_modules");
    expect(gi).toContain(".next");
    expect(gi).toMatch(/prisma\/\*\.db/);
    expect(gi).toContain(".env");
  });
});
