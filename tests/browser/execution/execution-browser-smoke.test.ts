import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const harness = readFileSync(resolve("tests", "browser", "execution-browser-smoke.mjs"), "utf8");

describe("execution browser smoke harness contract", () => {
  it("uses product execution routes without intercepting their responses", () => {
    expect(harness).not.toMatch(
      /page\.route\(\s*["'`][^"'`]*(?:\/executions|executions\/)[^"'`]*/,
    );
    expect(harness).toContain("/api/projects/${projectId}/executions");
    expect(harness).toContain("/api/executions/${execution.id}/advance");
    expect(harness).toContain("/recovery/resolve");
  });

  it("does not synthesize product state with SQLite writes or file copies", () => {
    expect(harness).not.toMatch(
      /\b(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|UPDATE|DELETE\s+FROM)\s+[a-z_]+/i,
    );
    expect(harness).not.toContain("cpSync(");
    expect(harness).not.toContain("seedPlannedTasks");
    expect(harness).not.toContain("wireStartContract");
    expect(harness).not.toContain("wireStagedContract");
    expect(harness).not.toContain("wireMergeContract");
  });

  it("creates permissions and executable work through public product routes", () => {
    expect(harness).toContain("/api/agents/${agentId}");
    expect(harness).toContain(
      "/api/projects/${id}/threads/${selectedThreadId}/runs",
    );
    expect(harness).not.toContain("UPDATE agents SET");
    expect(harness).not.toContain("INSERT INTO collaboration_");
  });

  it("measures execution provider concurrency without a synthetic provider probe", () => {
    expect(harness).not.toContain("CONCURRENCY_PROBE");
    expect(harness).toContain("maxConcurrentProviderCalls");
    expect(harness).toMatch(/request\.method\s*===\s*["']GET["'][\s\S]*\/v1\/models/);
  });

  it("proves conflict and manual recovery through observable public outcomes", () => {
    expect(harness).toContain('console.log("CONFLICT PASS:');
    expect(harness).toContain('console.log("MANUAL RECOVERY PASS:');
    expect(harness).toContain("/recovery/files");
    expect(harness).toContain('console.log("RECOVERY FILE PASS:');
    expect(harness).toContain('console.log("RECOVERY PERSISTENCE PASS:');
    expect(harness).toMatch(/await\s+abandonManualRecovery\(/);
  });
});
