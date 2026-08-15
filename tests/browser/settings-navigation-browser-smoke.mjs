import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import AxeBuilder from "@axe-core/playwright";
import { chromium } from "playwright";

const host = "127.0.0.1";
const portSeed = randomBytes(4).readUInt32BE();
const appPort = 10_000 + (portSeed % 20_000);
const baseUrl = `http://${host}:${appPort}`;
const temporaryDirectory = mkdtempSync(
  join(tmpdir(), "cool-ai-settings-smoke-"),
);
const databasePath = join(temporaryDirectory, "settings-smoke.sqlite");
const workspaceDirectory = join(temporaryDirectory, "project");
const smokeDistDirectory = `.next-settings-smoke-${process.pid}`;
const evidenceDirectory = resolve(
  "features",
  "011-settings-navigation",
  "evidence",
);
const desktopScreenshot = join(
  evidenceDirectory,
  "settings-navigation-desktop.png",
);
const narrowScreenshot = join(
  evidenceDirectory,
  "settings-navigation-narrow.png",
);
const resultsPath = join(
  evidenceDirectory,
  "settings-navigation-results.json",
);
const generatedConfigSnapshots = ["next-env.d.ts", "tsconfig.json"]
  .map((path) => resolve(path))
  .filter(existsSync)
  .map((path) => ({ content: readFileSync(path, "utf8"), path }));
const browserExecutable = [
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
].find((candidate) => candidate && existsSync(candidate));

mkdirSync(evidenceDirectory, { recursive: true });
mkdirSync(workspaceDirectory);
for (const stablePath of [desktopScreenshot, narrowScreenshot, resultsPath]) {
  rmSync(stablePath, { force: true });
}

const serverCommand = {
  command: process.execPath,
  args: [
    resolve("node_modules", "next", "dist", "bin", "next"),
    "start",
    "--hostname",
    host,
    "--port",
    String(appPort),
  ],
};

let appServer;
let browser;
let serverOutput = "";
const results = {
  axe: [],
  status: "running",
  steps: [],
};

function recordStep(name, details = {}) {
  results.steps.push({ name, status: "passed", ...details });
}

function startAppServer() {
  appServer = spawn(serverCommand.command, serverCommand.args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      COCKPIT_DB_PATH: databasePath,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  appServer.stdout.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });
  appServer.stderr.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });
}

function stopAppServer() {
  if (!appServer?.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(appServer.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    const listeners = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `Start-Sleep -Milliseconds 1000; (Get-NetTCPConnection -State Listen -LocalPort ${appPort} -ErrorAction SilentlyContinue).OwningProcess`,
      ],
      { encoding: "utf8", windowsHide: true },
    ).stdout;
    for (const pid of listeners.match(/\d+/g) ?? []) {
      spawnSync("taskkill", ["/pid", pid, "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    }
  } else {
    appServer.kill("SIGTERM");
  }
  appServer = undefined;
}

async function waitForApp() {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (appServer.exitCode !== null) {
      throw new Error(`Settings app exited before readiness.\n${serverOutput}`);
    }
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
    } catch {
      // The isolated Next.js process is still starting.
    }
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error(`Settings app did not become ready.\n${serverOutput}`);
}

async function assertAxeCriticalFree(page, state) {
  const scan = await new AxeBuilder({ page }).analyze();
  const critical = scan.violations
    .filter((violation) => violation.impact === "critical")
    .map((violation) => ({
      id: violation.id,
      nodes: violation.nodes.map((node) => node.target),
    }));
  results.axe.push({
    critical,
    state,
    violationCount: scan.violations.length,
  });
  assert.deepEqual(critical, [], `${state} must have axe critical 0`);
}

async function assertSearchOpens(page, query, buttonName, section) {
  const search = page.getByRole("search");
  await search.getByLabel("搜索设置分区").fill(query);
  const result = search.getByRole("button", { name: buttonName });
  await result.waitFor();
  assert.equal(await search.getByRole("button").count(), 1);
  await result.click();
  await page.waitForURL((url) => url.searchParams.get("section") === section);
}

try {
  startAppServer();
  await waitForApp();
  browser = await chromium.launch({
    headless: true,
    ...(browserExecutable ? { executablePath: browserExecutable } : {}),
  });
  const context = await browser.newContext({
    viewport: { height: 1000, width: 1440 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "打开文件夹" }).first().click();
  await page.getByLabel("文件夹路径").fill(workspaceDirectory);
  await page
    .locator("form")
    .filter({ has: page.getByLabel("文件夹路径") })
    .getByRole("button", { name: "打开文件夹" })
    .click();
  await page.waitForURL(/\/projects\/[A-Za-z0-9_-]+$/u);
  const projectPath = new URL(page.url()).pathname;
  const projectId = projectPath.split("/").at(-1);
  assert.ok(projectId);
  await page
    .getByRole("heading", { name: "project" })
    .waitFor();
  await assertAxeCriticalFree(page, "desktop project");
  recordStep("created-real-project", { projectPath });

  await page.getByTitle("团队").click();
  await page.waitForURL((url) =>
    url.pathname === "/team"
    && url.searchParams.get("section") === "skills"
    && url.searchParams.get("returnTo") === projectPath);
  await page.getByRole("search").waitFor();
  const notificationRegion = page.getByRole("region", { name: "通知" });
  await notificationRegion.waitFor();
  const approvalSwitch = notificationRegion.getByRole("switch", {
    name: "审批通知",
  });
  const missionSwitch = notificationRegion.getByRole("switch", {
    name: "任务通知",
  });
  assert.equal(await approvalSwitch.getAttribute("aria-checked"), "false");
  assert.equal(await missionSwitch.getAttribute("aria-checked"), "false");
  await approvalSwitch.click();
  assert.equal(await approvalSwitch.getAttribute("aria-checked"), "true");
  await notificationRegion
    .getByText("浏览器未授权系统通知，驾驶舱不会弹出提醒。")
    .waitFor();
  assert.equal(
    await page.locator('link[rel="manifest"]').getAttribute("href"),
    "/manifest.webmanifest",
  );
  await assertAxeCriticalFree(page, "desktop settings default");
  recordStep("entered-settings-from-project-activity-bar");
  recordStep("notification-region-toggle-and-manifest");

  await assertSearchOpens(page, "  模型  ", "打开模型服务设置", "providers");
  await page.getByRole("heading", { exact: true, name: "模型服务" }).waitFor();
  recordStep("searched-and-opened-chinese-section");

  await assertSearchOpens(page, "  AGENT  ", "打开 Agent 设置", "agents");
  await page.getByRole("heading", { exact: true, name: "Agent" }).waitFor();
  recordStep("searched-and-opened-english-section");

  const pinAgent = page.getByRole("button", { name: "固定Agent" });
  await pinAgent.click();
  await page.getByRole("link", { name: "打开固定设置：Agent" }).waitFor();
  assert.equal(await pinAgent.getAttribute("aria-pressed"), "true");
  const storedAfterPin = await page.evaluate(() =>
    localStorage.getItem("cool-ai:pinned-settings:v1"));
  assert.ok(storedAfterPin);
  const preferenceAfterPin = JSON.parse(storedAfterPin);
  assert.deepEqual(preferenceAfterPin.pinned, ["agents"]);
  assert.equal(preferenceAfterPin.events.length, 1);
  assert.deepEqual(
    Object.keys(preferenceAfterPin.events[0]).sort(),
    ["action", "changedAt", "clock", "eventId", "section", "writerId"].sort(),
  );
  await assertAxeCriticalFree(page, "desktop settings pinned");
  await page.screenshot({ fullPage: true, path: desktopScreenshot });
  recordStep("pinned-current-activity-bar-immediately");

  await page.getByRole("link", { name: "返回原位置" }).click();
  await page.waitForURL(`${baseUrl}${projectPath}`);
  await page
    .getByRole("heading", { name: "project" })
    .waitFor();
  recordStep("returned-to-same-project");

  const pinnedProjectEntry = page.getByRole("link", {
    name: "打开固定设置：Agent",
  });
  await pinnedProjectEntry.waitFor();
  await pinnedProjectEntry.click();
  await page.waitForURL((url) =>
    url.pathname === "/team"
    && url.searchParams.get("section") === "agents"
    && url.searchParams.get("returnTo") === projectPath);
  recordStep("reentered-pinned-deep-link");

  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("link", { name: "打开固定设置：Agent" }).waitFor();
  const history = page.locator(
    "section[aria-labelledby='settings-preference-history-heading']",
  );
  await history.getByRole("heading", { name: "固定历史" }).waitFor();
  await history.getByText(/Clock 1 固定 Agent/u).waitFor();
  assert.equal(await history.locator("button, input, textarea, select").count(), 0);
  const storedAfterRefresh = await page.evaluate(() =>
    localStorage.getItem("cool-ai:pinned-settings:v1"));
  assert.equal(storedAfterRefresh, storedAfterPin);
  assert.equal(storedAfterRefresh.includes("AGENT"), false);
  recordStep("refreshed-persistence-and-read-only-audit-history");

  await page.setViewportSize({ height: 844, width: 390 });
  await page.reload({ waitUntil: "networkidle" });
  const narrowOpener = page.getByRole("button", { name: "打开团队资源" });
  await narrowOpener.click();
  const dialog = page.getByRole("dialog", { name: "团队导航" });
  await dialog.waitFor();
  const narrowSearch = dialog.getByRole("search");
  await narrowSearch.getByLabel("搜索设置分区").fill("不存在");
  await dialog.getByText("没有匹配的设置分区。", { exact: true }).waitFor();
  await assertAxeCriticalFree(page, "narrow settings empty search dialog");
  await dialog.getByRole("button", { name: "清除检索" }).click();
  assert.equal(
    await narrowSearch
      .getByLabel("搜索设置分区")
      .evaluate((element) => document.activeElement === element),
    true,
  );
  await dialog.getByRole("button", { name: "固定技能" }).click();
  await page.locator('[aria-label="打开固定设置：技能"]').waitFor({
    state: "attached",
  });
  await assertAxeCriticalFree(page, "narrow settings pinned dialog");
  await page.screenshot({ fullPage: true, path: narrowScreenshot });
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  assert.equal(
    await narrowOpener.evaluate((element) => document.activeElement === element),
    true,
  );
  recordStep("narrow-dialog-clear-pin-and-return-focus");

  await narrowOpener.click();
  const reopenedDialog = page.getByRole("dialog", { name: "团队导航" });
  await reopenedDialog.getByRole("link", { name: "返回原位置" }).click();
  await page.waitForURL(`${baseUrl}${projectPath}`);
  recordStep("narrow-returned-to-same-project");

  await page.setViewportSize({ height: 1000, width: 1440 });
  const maliciousCases = [
    {
      label: "duplicate",
      query: `section=agents&returnTo=${encodeURIComponent(projectPath)}&returnTo=%2Fprojects%2Fother`,
    },
    {
      label: "external",
      query: `section=agents&returnTo=${encodeURIComponent("https://evil.example/projects/p")}`,
    },
    {
      label: "protocol-relative",
      query: `section=agents&returnTo=${encodeURIComponent("//evil.example/projects/p")}`,
    },
    {
      label: "encoded-slash-%2F",
      query: "section=agents&returnTo=%2Fprojects%252Fmalice",
    },
    {
      label: "encoded-backslash-%5C",
      query: "section=agents&returnTo=%2Fprojects%255Cmalice",
    },
    {
      label: "encoded-dot-segment-%2e%2e",
      query: "section=agents&returnTo=%2Fprojects%2F%252e%252e",
    },
    {
      label: "decoded-dot-segment",
      query: "section=agents&returnTo=%2Fprojects%2F..",
    },
  ];
  for (const malicious of maliciousCases) {
    await page.goto(`${baseUrl}/team?${malicious.query}`, {
      waitUntil: "networkidle",
    });
    assert.equal(
      await page.getByRole("link", { name: "返回原位置" }).getAttribute("href"),
      "/",
      `${malicious.label} returnTo must fall back to /`,
    );
    recordStep("rejected-malicious-returnTo", { case: malicious.label });
  }
  await assertAxeCriticalFree(page, "malicious returnTo fallback");

  assert.equal(results.axe.every(({ critical }) => critical.length === 0), true);
  assert.ok(existsSync(desktopScreenshot));
  assert.ok(existsSync(narrowScreenshot));
  results.status = "passed";
  console.log(
    `SETTINGS BROWSER PASS: ${results.steps.length} steps; `
      + `${results.axe.length} axe states critical 0`,
  );
  console.log(`DESKTOP PNG: ${desktopScreenshot}`);
  console.log(`NARROW PNG: ${narrowScreenshot}`);
  console.log(`STRUCTURED RESULTS: ${resultsPath}`);
} catch (error) {
  results.status = "failed";
  results.error = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(error);
  console.error(serverOutput);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  stopAppServer();
  for (const snapshot of generatedConfigSnapshots) {
    writeFileSync(snapshot.path, snapshot.content);
  }
  rmSync(resolve(smokeDistDirectory), { force: true, recursive: true });
  rmSync(temporaryDirectory, { force: true, recursive: true });
  writeFileSync(resultsPath, `${JSON.stringify(results, null, 2)}\n`);
}
