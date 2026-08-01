import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("review browser smoke harness contract", () => {
  it("exposes the reviewed public routes through a real browser harness", () => {
    const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };

    expect(
      packageJson.scripts?.["smoke:review"],
      "package.json must expose the T-29 review smoke command",
    ).toBe("node tests/review-browser-smoke.mjs");

    const harnessPath = resolve("tests/review-browser-smoke.mjs");
    expect(
      existsSync(harnessPath),
      "the T-29 real provider/browser harness must exist",
    ).toBe(true);

    const harness = readFileSync(harnessPath, "utf8");
    expect(harness).toContain("createServer");
    expect(harness).toContain("COCKPIT_DB_PATH");
    expect(harness).toContain("chromium");
    expect(harness).toContain("/api/work-items/${workItemId}/reviews");
    expect(harness).toContain("/api/escalations/${escalationId}/answer");
    expect(harness).not.toContain("page.route(");
    expect(harness).not.toContain("route.fulfill(");
    expect(harness).not.toContain("DatabaseSync");
    expect(harness).not.toContain("/api/projects/${projectId}/reviews");
    expect(harness).not.toContain("/api/reviews/${attemptId}/escalations");
  });
});
