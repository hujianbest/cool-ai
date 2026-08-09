import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const evidenceDirectory = resolve(
  "features",
  "006-peer-review-memory-delivery",
  "evidence",
);
const desktopScreenshot = resolve(
  evidenceDirectory,
  "smoke-review-desktop.png",
);
const narrowScreenshot = resolve(
  evidenceDirectory,
  "smoke-review-narrow.png",
);

type ProcessResult = {
  exitCode: number | null;
  output: string;
};

function runFullChain(): Promise<ProcessResult> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn("npm run smoke:review -- --full", {
      cwd: process.cwd(),
      env: process.env,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";

    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.once("error", rejectRun);
    child.once("close", (exitCode) => resolveRun({ exitCode, output }));
  });
}

describe("review browser full-chain smoke", () => {
  it("completes the real full chain and writes both viewport screenshots", async () => {
    rmSync(desktopScreenshot, { force: true });
    rmSync(narrowScreenshot, { force: true });

    const result = await runFullChain();
    const sentinels = result.output
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("REVIEW FULL CHAIN PASS"));

    expect(result.exitCode, result.output).toBe(0);
    expect.soft(
      sentinels,
      `expected one REVIEW FULL CHAIN PASS sentinel\n${result.output}`,
    ).toHaveLength(1);
    expect.soft(
      existsSync(desktopScreenshot),
      `desktop screenshot was not written\n${result.output}`,
    ).toBe(true);
    expect.soft(
      existsSync(narrowScreenshot),
      `narrow screenshot was not written\n${result.output}`,
    ).toBe(true);
  }, 300_000);
});
