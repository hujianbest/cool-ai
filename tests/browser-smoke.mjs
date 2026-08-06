import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";

import { chromium } from "playwright";

const host = "127.0.0.1";
const port = 4100 + (process.pid % 500);
const baseUrl = `http://${host}:${port}`;
const temporaryDirectory = mkdtempSync(join(tmpdir(), "cool-ai-smoke-"));
const databasePath = join(temporaryDirectory, "smoke.sqlite");
const evidenceDirectory = resolve("features", "001-walking-skeleton", "evidence");
const smokeScreenshot = join(evidenceDirectory, "smoke-desktop.png");
const narrowScreenshot = join(evidenceDirectory, "smoke-workbench-narrow.png");
const demoScreenshot = join(evidenceDirectory, "demo-cockpit.png");
const currentEvidenceDirectory = resolve("features", "008-ui-design-refresh", "evidence");
const currentDesktopScreenshot = join(
  currentEvidenceDirectory,
  "smoke-workbench-current-desktop.png",
);
const currentNarrowScreenshot = join(
  currentEvidenceDirectory,
  "smoke-workbench-current-narrow.png",
);
const currentDesktopDemoScreenshot = join(
  currentEvidenceDirectory,
  "demo-workbench-current-desktop.png",
);
const currentNarrowDemoScreenshot = join(
  currentEvidenceDirectory,
  "demo-workbench-current-narrow.png",
);
const browserExecutable = [
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
].find((candidate) => candidate && existsSync(candidate));

mkdirSync(evidenceDirectory, { recursive: true });
mkdirSync(currentEvidenceDirectory, { recursive: true });

const serverCommand =
  process.platform === "win32"
    ? {
        command: "cmd.exe",
        args: [
          "/d",
          "/s",
          "/c",
          `npm run dev -- --hostname ${host} --port ${port}`,
        ],
      }
    : {
        command: "npm",
        args: ["run", "dev", "--", "--hostname", host, "--port", String(port)],
      };

const server = spawn(serverCommand.command, serverCommand.args, {
  cwd: process.cwd(),
  env: {
    ...process.env,
    COCKPIT_DB_PATH: databasePath,
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

let serverOutput = "";
server.stdout.on("data", (chunk) => {
  serverOutput += chunk.toString();
});
server.stderr.on("data", (chunk) => {
  serverOutput += chunk.toString();
});

function stopServer() {
  if (!server.pid) return;
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
    if (server.exitCode !== null) {
      throw new Error(`Development server exited early.\n${serverOutput}`);
    }
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
    } catch {
      // The server is still starting.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  throw new Error(`Development server did not become ready.\n${serverOutput}`);
}

let browser;
try {
  await waitForServer();
  browser = await chromium.launch({
    headless: true,
    ...(browserExecutable ? { executablePath: browserExecutable } : {}),
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  assert.equal(await page.locator("html").getAttribute("lang"), "zh-CN");
  await page.getByText("暂无项目。", { exact: true }).waitFor();

  await page.getByLabel("项目名称").fill("Smoke project");
  await page.getByRole("button", { name: "创建项目" }).click();
  await page.getByRole("button", { name: "Smoke project" }).waitFor();
  const currentProjectTitle = page.getByRole("heading", { level: 2, name: "Smoke project" });
  assert.equal(
    await currentProjectTitle.evaluate((element) => document.activeElement === element),
    true,
  );

  await page.getByLabel("任务目标").fill("Verify the walking skeleton");
  await page.getByRole("button", { name: "运行任务" }).click();
  await page.getByText("任务已完成。", { exact: true }).waitFor();

  for (const message of ["任务已排队。", "任务已开始。", "任务已完成。"]) {
    await page.getByText(message, { exact: true }).waitFor();
  }
  const statuses = await page.locator(".status-label").allTextContents();
  assert.deepEqual(statuses, ["排队中", "运行中", "已完成"]);
  const taskResult = page.getByText(/示例 Agent 已完成骨架任务/);

  await page.screenshot({ path: smokeScreenshot, fullPage: true });
  await page.screenshot({ path: currentDesktopScreenshot, fullPage: true });

  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Smoke project" }).waitFor();
  await page.getByText("任务已完成。", { exact: true }).waitFor();
  await page.getByRole("tab", { name: "骨架运行" }).click();
  await taskResult.scrollIntoViewIfNeeded();
  assert.deepEqual(await page.locator(".status-label").allTextContents(), [
    "排队中",
    "运行中",
    "已完成",
  ]);

  await page.screenshot({ path: demoScreenshot, fullPage: true });
  await page.screenshot({ path: currentDesktopDemoScreenshot, fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: "networkidle" });
  await page
    .getByText("任务已完成。", { exact: true })
    .waitFor({ state: "attached" });

  const overflow = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    offenders: [...document.querySelectorAll("body *")]
      .filter((element) => element.getBoundingClientRect().right > document.documentElement.clientWidth)
      .map((element) => ({
        className: element.className,
        right: element.getBoundingClientRect().right,
        tagName: element.tagName,
      }))
      .slice(0, 10),
  }));
  assert.equal(
    overflow.scrollWidth <= overflow.clientWidth,
    true,
    `narrow viewport must not overflow horizontally: ${JSON.stringify(overflow)}`,
  );
  await page.screenshot({ path: narrowScreenshot, fullPage: true });
  await page.getByRole("button", { name: "打开编辑" }).click();
  await page.getByRole("dialog", { name: "任务编辑" }).waitFor();
  await page.screenshot({ path: currentNarrowScreenshot, fullPage: true });
  await page.screenshot({ path: currentNarrowDemoScreenshot, fullPage: true });
  await page.getByRole("button", { name: "关闭任务编辑" }).click();
  await page.reload({ waitUntil: "networkidle" });
  await page
    .getByText("任务已完成。", { exact: true })
    .waitFor({ state: "attached" });

  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  const projectToggle = page.locator('[aria-controls="project-navigation-drawer"]');
  for (let index = 0; index < 10; index += 1) {
    if (await projectToggle.evaluate((element) => document.activeElement === element)) break;
    await page.keyboard.press("Tab");
  }
  assert.equal(await projectToggle.getAttribute("aria-label"), "打开项目导航");
  assert.equal(await projectToggle.evaluate((element) => document.activeElement === element), true);
  assert.notEqual(await projectToggle.evaluate((element) => getComputedStyle(element).boxShadow), "none");
  await page.keyboard.press("Tab");
  const editorToggle = page.getByRole("button", { name: "打开编辑" });
  assert.equal(await editorToggle.evaluate((element) => document.activeElement === element), true);
  await page.keyboard.press("Tab");
  const contextToggle = page.locator('[aria-controls="task-context-drawer"]');
  assert.equal(await contextToggle.getAttribute("aria-label"), "打开当前任务上下文");
  assert.equal(await contextToggle.evaluate((element) => document.activeElement === element), true);
  await page.keyboard.press("Tab");
  const nextFocus = await page.evaluate(() => ({
    ariaLabel: document.activeElement?.getAttribute("aria-label"),
    insideClosedSurface:
      document.activeElement?.closest(
        '.cockpit-sidebar[hidden], .cockpit-flow[hidden], .cockpit-context[hidden]',
      ) !== null,
    tagName: document.activeElement?.tagName,
    text: document.activeElement?.textContent?.trim().slice(0, 80),
  }));
  assert.equal(
    nextFocus.insideClosedSurface,
    false,
    `closed narrow surfaces must stay outside tab order: ${JSON.stringify(nextFocus)}`,
  );

  await projectToggle.click();
  assert.equal(await projectToggle.getAttribute("aria-expanded"), "true");
  const closeProjects = page.getByRole("button", { name: "关闭项目导航" });
  assert.equal(await closeProjects.evaluate((element) => document.activeElement === element), true);
  await closeProjects.click();
  assert.equal(await projectToggle.evaluate((element) => document.activeElement === element), true);

  await contextToggle.click();
  assert.equal(await contextToggle.getAttribute("aria-expanded"), "true");
  const closeContext = page.getByRole("button", { name: "关闭当前任务上下文" });
  assert.equal(await closeContext.evaluate((element) => document.activeElement === element), true);
  await closeContext.click();
  assert.equal(await contextToggle.evaluate((element) => document.activeElement === element), true);

  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
    true,
  );

  console.log(`SMOKE PASS: real project/task persistence verified at ${baseUrl}`);
  console.log(`SMOKE SCREENSHOT: ${smokeScreenshot}`);
  console.log(`NARROW SCREENSHOT: ${narrowScreenshot}`);
  console.log(`DEMO SCREENSHOT: ${demoScreenshot}`);
  console.log(`CURRENT DESKTOP SCREENSHOT: ${currentDesktopScreenshot}`);
  console.log(`CURRENT NARROW SCREENSHOT: ${currentNarrowScreenshot}`);
  console.log(`CURRENT DESKTOP DEMO: ${currentDesktopDemoScreenshot}`);
  console.log(`CURRENT NARROW DEMO: ${currentNarrowDemoScreenshot}`);
} finally {
  await browser?.close();
  stopServer();
  rmSync(temporaryDirectory, { force: true, recursive: true });
}
