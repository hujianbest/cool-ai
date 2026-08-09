// @vitest-environment jsdom
import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { chromium, type Browser } from "playwright";
import { afterEach, describe, expect, it } from "vitest";

const host = "127.0.0.1";
const port = 4600 + (process.pid % 300);
const baseUrl = `http://${host}:${port}`;
const temporaryDirectory = mkdtempSync(join(tmpdir(), "cool-ai-theme-hydration-"));
const databasePath = join(temporaryDirectory, "theme.sqlite");
const distDirectory = `.next-theme-hydration-${process.pid}`;
const generatedConfigSnapshots = ["next-env.d.ts", "tsconfig.json"].map((path) => ({
  content: readFileSync(path, "utf8"),
  path,
}));
const browserExecutable = [
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
].find((candidate) => candidate && existsSync(candidate));

let server: ChildProcessByStdio<null, Readable, Readable> | undefined;
let browser: Browser | undefined;
let serverOutput = "";
let releaseClientChunks: (() => void) | undefined;

function stopServer() {
  if (!server?.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(server.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
  } else {
    server.kill("SIGTERM");
  }
}

async function waitForServer() {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (server?.exitCode !== null) {
      throw new Error(`Development server exited early.\n${serverOutput}`);
    }
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Development server did not become ready.\n${serverOutput}`);
}

afterEach(async () => {
  releaseClientChunks?.();
  releaseClientChunks = undefined;
  await browser?.close();
  stopServer();
  rmSync(join(process.cwd(), distDirectory), { force: true, recursive: true });
  rmSync(temporaryDirectory, { force: true, recursive: true });
  for (const snapshot of generatedConfigSnapshots) {
    writeFileSync(snapshot.path, snapshot.content, "utf8");
  }
});

describe("real browser theme hydration", () => {
  it("prepaints dark before FCP while all Next client chunks are delayed", async () => {
    const command = process.platform === "win32"
      ? {
          executable: "cmd.exe",
          args: [
            "/d",
            "/s",
            "/c",
            `npm run dev -- --hostname ${host} --port ${port}`,
          ],
        }
      : {
          executable: "npm",
          args: ["run", "dev", "--", "--hostname", host, "--port", String(port)],
        };
    const startedServer = spawn(command.executable, command.args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        COCKPIT_DB_PATH: databasePath,
        NEXT_DIST_DIR: distDirectory,
        NODE_ENV: "development",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    server = startedServer;
    startedServer.stdout.on("data", (chunk) => {
      serverOutput += chunk.toString();
    });
    startedServer.stderr.on("data", (chunk) => {
      serverOutput += chunk.toString();
    });
    await waitForServer();

    browser = await chromium.launch({
      headless: true,
      ...(browserExecutable ? { executablePath: browserExecutable } : {}),
    });
    const context = await browser.newContext();
    let delayedClientChunkCount = 0;
    const clientChunksReleased = new Promise<void>((resolve) => {
      releaseClientChunks = resolve;
    });
    await context.route("**/_next/static/chunks/**", async (route) => {
      if (route.request().resourceType() === "script") {
        delayedClientChunkCount += 1;
        await clientChunksReleased;
      }
      await route.continue();
    });
    await context.addInitScript(() => {
      const key = "cool-ai:theme:v1";
      const preference = JSON.stringify({
        version: 1,
        theme: "dark",
        revision: 3,
        updatedAt: "2026-08-08T00:00:00.000Z",
      });
      localStorage.setItem(key, preference);
      const originalSetItem = Storage.prototype.setItem;
      Object.defineProperty(window, "__themeWrites", {
        configurable: true,
        value: [] as Array<[string, string]>,
      });
      Storage.prototype.setItem = function (storageKey, value) {
        (window as unknown as { __themeWrites: Array<[string, string]> })
          .__themeWrites.push([storageKey, value]);
        return originalSetItem.call(this, storageKey, value);
      };

      const observer = new PerformanceObserver((list) => {
        const firstContentfulPaint = list
          .getEntries()
          .find((entry) => entry.name === "first-contentful-paint");
        if (!firstContentfulPaint) return;

        const root = document.documentElement;
        Object.defineProperty(window, "__themeAtFirstContentfulPaint", {
          configurable: true,
          value: {
            bootstrapTimestamp: (
              window as unknown as {
                __COOL_THEME_BOOTSTRAP__?: { timestamp: number };
              }
            ).__COOL_THEME_BOOTSTRAP__?.timestamp,
            fcpTimestamp: firstContentfulPaint.startTime,
            surfaceMain: getComputedStyle(root)
              .getPropertyValue("--surface-main")
              .trim(),
            theme: root.dataset.theme,
          },
        });
        observer.disconnect();
      });
      observer.observe({ type: "paint", buffered: true });
    });
    const page = await context.newPage();
    const hydrationErrors: string[] = [];
    page.on("console", (message) => {
      if (
        message.type() === "error" &&
        /hydration|did not match|didn't match|server rendered html/i.test(
          message.text(),
        )
      ) {
        hydrationErrors.push(message.text());
      }
    });
    page.on("pageerror", (error) => {
      if (/hydration/i.test(error.message)) hydrationErrors.push(error.message);
    });

    await page.goto(baseUrl, { waitUntil: "commit" });
    await expect.poll(() => delayedClientChunkCount).toBeGreaterThan(0);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              window as unknown as {
                __themeAtFirstContentfulPaint?: {
                  bootstrapTimestamp?: number;
                  fcpTimestamp: number;
                  surfaceMain: string;
                  theme?: string;
                };
              }
            ).__themeAtFirstContentfulPaint,
        ),
      )
      .toMatchObject({
        surfaceMain: "#202724",
        theme: "dark",
      });
    const themeAtFirstContentfulPaint = await page.evaluate(
      () =>
        (
          window as unknown as {
            __themeAtFirstContentfulPaint: {
              bootstrapTimestamp?: number;
              fcpTimestamp: number;
            };
          }
        ).__themeAtFirstContentfulPaint,
    );
    expect(themeAtFirstContentfulPaint.bootstrapTimestamp).toBeLessThanOrEqual(
      themeAtFirstContentfulPaint.fcpTimestamp,
    );

    releaseClientChunks?.();
    releaseClientChunks = undefined;
    await page.waitForLoadState("domcontentloaded");
    await expect
      .poll(() => page.locator("html").getAttribute("data-theme"))
      .toBe("dark");
    const toggle = page.getByRole("button", {
      name: "当前为暗色主题，切换到明色主题",
    });
    await toggle.waitFor();
    await expect.poll(() => toggle.isEnabled()).toBe(true);

    expect(hydrationErrors).toEqual([]);
    const writes = await page.evaluate(
      () =>
        (window as unknown as { __themeWrites: Array<[string, string]> })
          .__themeWrites,
    );
    expect(
      writes.filter(
        ([key, value]) =>
          key === "cool-ai:theme:v1" &&
          (JSON.parse(value) as { theme?: string }).theme === "light",
      ),
    ).toEqual([]);
  }, 120_000);
});
