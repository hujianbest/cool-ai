// 步骤控制（tests/browser/smoke-steps.mjs）：--from-step=<id> / --only-step=<id> / --list-steps。
// 不带参默认全量跑；最终 DoD 验证必须不带参全量跑（脚本内这条约束同样适用于所有冒烟脚本）。
// 步骤（按序）：home-empty → project-shell → desktop-baseline → reload-demo-baseline →
//   narrow-baseline → narrow-task-editor → narrow-keyboard → team-page。
// 自足性：home-empty 自足；project-shell 自足（重新绑定 heading）；desktop-baseline 依赖 project-shell；
//   reload-demo-baseline 起依赖 project-shell 的页面；narrow-* 依赖前置段已进入窄屏视口；team-page 自足导航。
// 纪律：测试期间绝不回滚 tsconfig.json / next-env.d.ts；全部运行结束后统一 git checkout 一次。
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";

import AxeBuilder from "@axe-core/playwright";
import { chromium } from "playwright";

import { assertMatchesVisualBaseline } from "./visual-baseline.mjs";
import { createStepGate } from "./smoke-steps.mjs";
import { stopServerTree } from "./runner-process.mjs";

const host = "127.0.0.1";
const port = 4100 + (process.pid % 500);
const baseUrl = `http://${host}:${port}`;
const temporaryDirectory = mkdtempSync(join(tmpdir(), "cool-ai-smoke-"));
const databasePath = join(temporaryDirectory, "smoke.sqlite");
const workspaceDirectory = join(temporaryDirectory, "real-workspace");
const smokeDistDirectory = `.next-smoke-${process.pid}`;
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

const gate = createStepGate("browser-smoke", [
  "home-empty",
  "project-shell",
  "desktop-baseline",
  "reload-demo-baseline",
  "narrow-baseline",
  "narrow-task-editor",
  "narrow-keyboard",
  "team-page",
]);
// --list-steps：只打印步骤表并退出，不启动任何服务。
if (gate.listOnly) process.exit(0);
const browserExecutable = [
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
].find((candidate) => candidate && existsSync(candidate));

mkdirSync(evidenceDirectory, { recursive: true });
mkdirSync(currentEvidenceDirectory, { recursive: true });
mkdirSync(workspaceDirectory);

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
    COCKPIT_ALLOW_SCRIPTED_PICKER: "1",
    COCKPIT_SCRIPTED_DIRECTORY: workspaceDirectory,
    NEXT_DIST_DIR: smokeDistDirectory,
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
  // posix 下 SIGTERM 父进程后按端口反查兜底，避免孤儿 next 进程占端口。
  stopServerTree(server, { label: "smoke-dev-server", port });
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

async function assertAxeCriticalFree(page, routeLabel) {
  const result = await new AxeBuilder({ page }).analyze();
  const critical = result.violations.filter((violation) => violation.impact === "critical");
  assert.deepEqual(
    critical.map((violation) => ({
      id: violation.id,
      nodes: violation.nodes.map((node) => node.target),
    })),
    [],
    `${routeLabel} must have no critical axe violations`,
  );
}

let browser;
try {
  await waitForServer();
  browser = await chromium.launch({
    headless: true,
    ...(browserExecutable ? { executablePath: browserExecutable } : {}),
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  // Smoke screenshots feed committed pixel baselines and the vision review;
  // the Next.js dev-server indicator (nextjs-portal) must not appear in them.
  await context.addInitScript(() => {
    const inject = () => {
      const style = document.createElement("style");
      style.textContent = "nextjs-portal { display: none !important; }";
      document.documentElement.appendChild(style);
    };
    if (document.documentElement) inject();
    else document.addEventListener("DOMContentLoaded", inject, { once: true });
  });
  const page = await context.newPage();
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  let workbenchHeading;

  if (gate.run("home-empty")) {
    assert.equal(await page.locator("html").getAttribute("lang"), "zh-CN");
    await page
      .getByText("配置模型 Provider 后即可开始。", { exact: true })
      .waitFor();
    assert.equal(
      await page
        .getByRole("link", { name: "配置 Provider" })
        .getAttribute("href"),
      "/team?section=providers&returnTo=/",
    );
    workbenchHeading = page.getByRole("heading", { level: 1, name: "协作工作台" });
    assert.equal(await workbenchHeading.count(), 1);
    assert.equal(await workbenchHeading.isVisible(), true);
    await assertAxeCriticalFree(page, "/");
  }

  if (gate.run("project-shell")) {
    await page.getByRole("button", { name: "打开文件夹" }).click();
    await page.waitForURL(/\/projects\/[^/]+$/);
    await page
      .locator(".cockpit-header-context")
      .filter({ hasText: "real-workspace" })
      .waitFor();
    workbenchHeading = page.getByRole("heading", { level: 1, name: "协作工作台" });
    assert.equal(await workbenchHeading.count(), 1);
    assert.equal(await workbenchHeading.isVisible(), true);
    await assertAxeCriticalFree(page, "/projects/<id>");

    await page.getByRole("button", { exact: true, name: "新对话" }).waitFor();
    await page.getByText("暂无对话。创建对话后开始协作。").waitFor();
  }

  if (gate.run("desktop-baseline")) {
    await page.screenshot({ path: smokeScreenshot, fullPage: true });
    await page.screenshot({ path: currentDesktopScreenshot, fullPage: true });
    assertMatchesVisualBaseline({
      runner: "browser-smoke",
      name: "cockpit-desktop-empty",
      screenshotPath: smokeScreenshot,
    });
  }

  if (gate.run("reload-demo-baseline")) {
    await page.reload({ waitUntil: "networkidle" });
    await page
      .locator(".cockpit-header-context")
      .filter({ hasText: "real-workspace" })
      .waitFor();
    await page.getByRole("button", { exact: true, name: "新对话" }).waitFor();

    await page.screenshot({ path: demoScreenshot, fullPage: true });
    await page.screenshot({ path: currentDesktopDemoScreenshot, fullPage: true });
    assertMatchesVisualBaseline({
      runner: "browser-smoke",
      name: "cockpit-desktop-reloaded",
      screenshotPath: demoScreenshot,
    });
  }

  if (gate.run("narrow-baseline")) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload({ waitUntil: "networkidle" });
    await page.getByRole("button", { name: "打开编辑" }).waitFor({ state: "attached" });

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
    assertMatchesVisualBaseline({
      runner: "browser-smoke",
      name: "cockpit-narrow",
      screenshotPath: narrowScreenshot,
    });
  }

  if (gate.run("narrow-task-editor")) {
    await page.getByRole("button", { name: "打开编辑" }).click();
    await page.getByRole("dialog", { name: "任务编辑" }).waitFor();
    await page.screenshot({ path: currentNarrowScreenshot, fullPage: true });
    await page.screenshot({ path: currentNarrowDemoScreenshot, fullPage: true });
    await page.getByRole("button", { name: "关闭任务编辑" }).click();
    await page.reload({ waitUntil: "networkidle" });
    await page.getByRole("button", { name: "打开编辑" }).waitFor({ state: "attached" });
  }

  if (gate.run("narrow-keyboard")) {
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
    assert.equal(await page.getByRole("button", { name: "打开当前任务上下文" }).count(), 0);
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

    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
      true,
    );
  }

  if (gate.run("team-page")) {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${baseUrl}/team`, { waitUntil: "networkidle" });
    await page.getByRole("tablist", { name: "团队资源" }).waitFor();
    const teamHeading = page.getByRole("heading", { level: 1, name: "团队管理" });
    assert.equal(await teamHeading.count(), 1);
    assert.equal(await teamHeading.isVisible(), true);
    await assertAxeCriticalFree(page, "/team");
  }

  gate.assertResolved();

  // 切片运行时只汇报实际跑过的步骤；全量运行时输出与引入步骤控制前保持一致。
  if (gate.slicing) {
    console.log(
      `SMOKE SLICE PASS: ${gate.summary().ran.join(", ")} (skipped: ${gate.summary().skipped.join(", ") || "none"})`,
    );
  } else {
    console.log(`SMOKE PASS: folder project and UCD shell verified at ${baseUrl}`);
    console.log("AXE PASS: /, /projects/<id>, and /team have no critical violations");
    console.log(`SMOKE SCREENSHOT: ${smokeScreenshot}`);
    console.log(`NARROW SCREENSHOT: ${narrowScreenshot}`);
    console.log(`DEMO SCREENSHOT: ${demoScreenshot}`);
    console.log(`CURRENT DESKTOP SCREENSHOT: ${currentDesktopScreenshot}`);
    console.log(`CURRENT NARROW SCREENSHOT: ${currentNarrowScreenshot}`);
    console.log(`CURRENT DESKTOP DEMO: ${currentDesktopDemoScreenshot}`);
    console.log(`CURRENT NARROW DEMO: ${currentNarrowDemoScreenshot}`);
  }
} finally {
  await browser?.close();
  stopServer();
  rmSync(resolve(smokeDistDirectory), { force: true, recursive: true });
  rmSync(temporaryDirectory, { force: true, recursive: true });
}
