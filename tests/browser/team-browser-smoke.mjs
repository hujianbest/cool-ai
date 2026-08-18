import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { chromium } from "playwright";

const host = "127.0.0.1";
const appPort = 4600 + (process.pid % 200);
const providerPort = 4800 + (process.pid % 200);
const redirectPort = 5000 + (process.pid % 200);
const baseUrl = `http://${host}:${appPort}`;
const providerBaseUrl = `http://${host}:${providerPort}`;
const redirectTargetUrl = `http://${host}:${redirectPort}/must-not-receive`;
const temporaryDirectory = mkdtempSync(join(tmpdir(), "cool-ai-team-smoke-"));
const databasePath = join(temporaryDirectory, "team-smoke.sqlite");
const masterKey = randomBytes(32).toString("base64url");
const testApiKey = "smoke-team-api-key-DO-NOT-LEAK-2026";
const evidenceDirectory = resolve(
  "features",
  "002-agent-team-configuration",
  "evidence",
);
const desktopScreenshot = join(evidenceDirectory, "smoke-team-desktop.png");
const narrowScreenshot = join(evidenceDirectory, "smoke-team-narrow.png");
const demoScreenshot = join(evidenceDirectory, "demo-agent-team.png");
const currentEvidenceDirectory = resolve(
  "features",
  "008-ui-design-refresh",
  "evidence",
);
const currentDesktopScreenshot = join(
  currentEvidenceDirectory,
  "smoke-team-current-desktop.png",
);
const currentNarrowScreenshot = join(
  currentEvidenceDirectory,
  "smoke-team-current-narrow.png",
);
const currentDesktopDemoScreenshot = join(
  currentEvidenceDirectory,
  "demo-team-current-desktop.png",
);
const currentNarrowDemoScreenshot = join(
  currentEvidenceDirectory,
  "demo-team-current-narrow.png",
);
const browserExecutable = [
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
].find((candidate) => candidate && existsSync(candidate));

mkdirSync(evidenceDirectory, { recursive: true });
mkdirSync(currentEvidenceDirectory, { recursive: true });

let providerAuthorizationCount = 0;
let redirectAuthorizationCount = 0;
let redirectRequestCount = 0;

const redirectTarget = createServer((request, response) => {
  redirectRequestCount += 1;
  if (request.headers.authorization) redirectAuthorizationCount += 1;
  response.writeHead(204).end();
});

const compatibleProvider = createServer((request, response) => {
  if (request.url === "/redirect/v1/models") {
    response.writeHead(302, { location: redirectTargetUrl }).end();
    return;
  }
  if (request.url === "/v1/models") {
    if (request.headers.authorization === `Bearer ${testApiKey}`) {
      providerAuthorizationCount += 1;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "smoke-model" }] }));
    return;
  }
  response.writeHead(404).end();
});

function listen(server, port) {
  return new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, host, resolveListen);
  });
}

function close(server) {
  return new Promise((resolveClose) => server.close(() => resolveClose()));
}

const serverCommand =
  process.platform === "win32"
    ? {
        command: "cmd.exe",
        args: [
          "/d",
          "/s",
          "/c",
          `npm run dev -- --hostname ${host} --port ${appPort}`,
        ],
      }
    : {
        command: "npm",
        args: [
          "run",
          "dev",
          "--",
          "--hostname",
          host,
          "--port",
          String(appPort),
        ],
      };

let appServer;
let serverOutput = "";
function stopAppServer() {
  if (!appServer?.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(appServer.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
  } else {
    appServer.kill("SIGTERM");
  }
}

async function waitForApp() {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (appServer.exitCode !== null) {
      throw new Error(`Team app exited before readiness.\n${serverOutput}`);
    }
    try {
      const response = await fetch(`${baseUrl}/team`);
      if (response.ok) return;
    } catch {
      // The isolated app is still starting.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  throw new Error(`Team app did not become ready.\n${serverOutput}`);
}

function countOccurrences(text, needle) {
  if (!needle) return 0;
  return text.split(needle).length - 1;
}

let browser;
try {
  await Promise.all([
    listen(compatibleProvider, providerPort),
    listen(redirectTarget, redirectPort),
  ]);
  appServer = spawn(serverCommand.command, serverCommand.args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      COCKPIT_DB_PATH: databasePath,
      COCKPIT_MASTER_KEY: masterKey,
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
  await waitForApp();

  browser = await chromium.launch({
    headless: true,
    ...(browserExecutable ? { executablePath: browserExecutable } : {}),
  });
  const page = await browser.newPage({
    viewport: { height: 1000, width: 1440 },
  });
  let validationToken = "";
  page.on("response", async (response) => {
    if (
      response.url().endsWith("/api/providers/verify") &&
      response.status() === 200
    ) {
      const payload = await response.json();
      validationToken = payload.validationToken;
    }
  });

  await page.goto(`${baseUrl}/team`, { waitUntil: "networkidle" });
  assert.equal(await page.locator("html").getAttribute("lang"), "zh-CN");

  const notificationRegion = page.getByRole("region", { name: "通知" });
  await notificationRegion.waitFor();
  const approvalSwitch = notificationRegion.getByRole("switch", { name: "审批通知" });
  const missionSwitch = notificationRegion.getByRole("switch", { name: "任务通知" });
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

  await page.getByRole("tab", { name: "模型服务" }).click();
  await page.getByText("暂无模型服务。", { exact: true }).waitFor();

  // Redirect verification proves that credentials are never forwarded.
  await page.getByRole("button", { name: "创建模型服务" }).click();
  await page.getByLabel("服务名称").fill("Redirect Probe");
  await page
    .getByLabel("Base URL")
    .fill(`${providerBaseUrl}/redirect/v1`);
  await page.getByLabel("默认模型").fill("smoke-model");
  await page.getByLabel("API key").fill(testApiKey);
  await page
    .getByRole("checkbox", { name: /HTTP 会明文传输凭据/ })
    .check();
  await page.getByRole("button", { name: "验证连接" }).click();
  await page.getByRole("alert").getByText(/重定向/).waitFor();
  assert.equal(redirectRequestCount, 0);
  assert.equal(redirectAuthorizationCount, 0);

  await page.getByLabel("服务名称").fill("Smoke Provider");
  await page.getByLabel("Base URL").fill(`${providerBaseUrl}/v1`);
  await page.getByLabel("默认模型").fill("smoke-model");
  await page.getByLabel("API key").fill(testApiKey);
  await page
    .getByRole("checkbox", { name: /HTTP 会明文传输凭据/ })
    .check();
  await page.getByRole("button", { name: "验证连接" }).click();
  await page.getByText("已验证模型 smoke-model", { exact: true }).waitFor();
  await page.getByRole("button", { name: "保存服务" }).click();
  await page.getByText("模型服务已保存。", { exact: true }).waitFor();
  assert.equal(providerAuthorizationCount, 1);
  assert.equal(await page.getByLabel("API key").count(), 0);

  await page.getByRole("tab", { name: "技能" }).click();
  await page.waitForURL((url) => url.searchParams.get("section") === "skills");
  await page.getByText("暂无技能。", { exact: true }).waitFor();
  await page.getByRole("button", { name: "创建新技能" }).click();
  const editor = page.getByRole("dialog", { name: "创建技能" });
  await editor.waitFor();
  await editor.getByLabel("技能名称").fill("Smoke Skill");
  await editor.getByLabel("技能说明").fill("Initial browser skill");
  await editor.getByLabel("指令正文").fill("Plan and verify each browser step.");
  await editor.getByRole("button", { name: "创建技能", exact: true }).click();
  await page.getByRole("heading", { name: "Smoke Skill" }).waitFor();
  await page.getByRole("button", { name: "编辑 Smoke Skill" }).click();
  await page.getByLabel("技能说明").fill("Edited browser skill");
  await page
    .getByLabel("指令正文")
    .fill("Plan, implement, and verify each browser step.");
  await page.getByRole("button", { name: "保存技能" }).click();
  await page.getByText("Edited browser skill", { exact: true }).waitFor();

  await page.getByRole("tab", { name: "Agent" }).click();
  await page.getByText("暂无 Agent。", { exact: true }).waitFor();

  await page.getByRole("button", { name: "创建 Agent" }).click();
  await page.getByLabel("创建方式").selectOption("planner");
  await page.getByLabel("Agent 名称").fill("Smoke Planner");
  await page
    .getByRole("combobox", { name: "模型服务", exact: true })
    .selectOption({ label: "Smoke Provider" });
  await page.getByRole("checkbox", { name: "Smoke Skill" }).check();
  await page.getByLabel("Token 预算").fill("24000");
  await page.getByLabel("接力轮次").fill("7");
  await page.getByLabel("头像文字").fill("规");
  await page.getByLabel("强调色").selectOption("rose");
  await page.getByRole("button", { name: "保存 Agent" }).click();
  await page.getByRole("heading", { name: "Smoke Planner" }).waitFor();

  await page.getByRole("button", { name: "创建 Agent" }).click();
  await page.getByLabel("创建方式").selectOption("builder");
  await page.getByLabel("Agent 名称").fill("Smoke Builder");
  await page
    .getByRole("combobox", { name: "模型服务", exact: true })
    .selectOption({ label: "Smoke Provider" });
  await page.getByRole("checkbox", { name: "Smoke Skill" }).check();
  await page.getByRole("checkbox", { name: "写入文件" }).check();
  await page.getByRole("checkbox", { name: "运行命令" }).check();
  await page.getByLabel("Token 预算").fill("48000");
  await page.getByLabel("接力轮次").fill("12");
  await page.getByLabel("头像文字").fill("实");
  await page.getByLabel("强调色").selectOption("gold");
  await page.getByRole("button", { name: "保存 Agent" }).click();
  await page.getByRole("heading", { name: "Smoke Builder" }).waitFor();

  const plannerCard = page
    .locator("article")
    .filter({ has: page.getByRole("heading", { name: "Smoke Planner" }) });
  const builderCard = page
    .locator("article")
    .filter({ has: page.getByRole("heading", { name: "Smoke Builder" }) });
  assert.equal(await plannerCard.getAttribute("data-accent"), "rose");
  assert.equal(await builderCard.getAttribute("data-accent"), "gold");
  await plannerCard.getByText("Smoke Skill", { exact: true }).waitFor();
  await builderCard.getByText("写入 · 命令").waitFor();

  const agentTab = page.getByRole("tab", { name: "Agent" });
  await agentTab.focus();
  await page.keyboard.press("ArrowLeft");
  await page.getByRole("tab", { name: "模型服务", selected: true }).waitFor();
  assert.equal(
    await page.getByRole("tab", { name: "模型服务" }).getAttribute("aria-selected"),
    "true",
  );
  await page.keyboard.press("ArrowRight");
  await page.getByRole("tab", { name: "Agent", selected: true }).waitFor();
  assert.equal(await agentTab.getAttribute("aria-selected"), "true");
  await page.getByRole("heading", { name: "Smoke Planner" }).waitFor();
  await page.getByRole("heading", { name: "Smoke Builder" }).waitFor();

  await page.screenshot({ fullPage: true, path: desktopScreenshot });
  await page.screenshot({ fullPage: true, path: demoScreenshot });
  await page.screenshot({ fullPage: true, path: currentDesktopScreenshot });
  await page.screenshot({ fullPage: true, path: currentDesktopDemoScreenshot });

  await page.setViewportSize({ height: 844, width: 390 });
  await page.reload({ waitUntil: "networkidle" });

  async function selectNarrowResource(name) {
    const opener = page.getByRole("button", { name: "打开团队资源" });
    await opener.click();
    const navigation = page.getByRole("dialog", { name: "团队导航" });
    await navigation.waitFor();
    assert.equal(await navigation.getAttribute("aria-modal"), "true");
    assert.equal(
      await navigation
        .getByRole("button", { name: "关闭团队资源" })
        .evaluate((element) => document.activeElement === element),
      true,
    );
    await page.getByRole("tab", { name }).click();
    await navigation.waitFor({ state: "detached" });
    assert.equal(
      await opener.evaluate((element) => document.activeElement === element),
      true,
    );
  }

  async function exerciseNarrowEditor(resource, editName, closeName, panelId) {
    await selectNarrowResource(resource);
    const opener = page.getByRole("button", { name: editName });
    await opener.click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    assert.equal(await dialog.getAttribute("aria-modal"), "true");
    assert.notEqual(await page.locator(panelId).getAttribute("inert"), null);
    assert.equal(
      await page
        .getByRole("button", { name: closeName })
        .evaluate((element) => document.activeElement === element),
      true,
    );
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    assert.equal(
      await opener.evaluate((element) => document.activeElement === element),
      true,
    );
  }

  await exerciseNarrowEditor(
    "模型服务",
    "编辑 Smoke Provider",
    "关闭模型服务编辑器",
    "#provider-resource-panel",
  );
  await exerciseNarrowEditor(
    "技能",
    "编辑 Smoke Skill",
    "关闭技能编辑器",
    "#skill-resource-panel",
  );
  await selectNarrowResource("Agent");
  await page.getByRole("heading", { name: "Smoke Planner" }).waitFor();
  await page.getByRole("heading", { name: "Smoke Builder" }).waitFor();
  assert.equal(
    await plannerCard.getByText("Smoke Skill", { exact: true }).textContent(),
    "Smoke Skill",
  );
  const agentEditOpener = page.getByRole("button", { name: "编辑 Smoke Planner" });
  await agentEditOpener.click();
  const mobileDialog = page.getByRole("dialog");
  await mobileDialog.waitFor();
  assert.equal(await mobileDialog.getAttribute("aria-modal"), "true");
  assert.notEqual(await page.locator("#agent-resource-panel").getAttribute("inert"), null);
  assert.equal(
    await page
      .getByRole("button", { name: "关闭 Agent 编辑器" })
      .evaluate((element) => document.activeElement === element),
    true,
  );
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
    true,
  );
  await page.screenshot({ fullPage: true, path: narrowScreenshot });
  await page.screenshot({ fullPage: true, path: currentNarrowScreenshot });
  await page.screenshot({ fullPage: true, path: currentNarrowDemoScreenshot });
  await page.keyboard.press("Escape");
  await mobileDialog.waitFor({ state: "detached" });
  assert.equal(
    await agentEditOpener.evaluate((element) => document.activeElement === element),
    true,
  );

  const apiBodies = await page.evaluate(async () => {
    const urls = [
      "/api/providers",
      "/api/skills",
      "/api/agents",
      "/api/agent-templates",
    ];
    return Promise.all(
      urls.map(async (url) => `${url}\n${await (await fetch(url)).text()}`),
    );
  });
  const fallbackErrors = await page.evaluate(
    async ({ secret, token }) =>
      (
        await fetch("/api/agents", {
          body: `{"broken":"${secret}-${token}"`,
          headers: { "content-type": "application/json" },
          method: "POST",
        })
      ).text(),
    { secret: testApiKey, token: validationToken },
  );
  const domText = await page.evaluate(
    () =>
      `${document.documentElement.innerHTML}\n${[...document.querySelectorAll("input")]
        .map((input) => input.value)
        .join("\n")}`,
  );
  const database = readFileSync(databasePath).toString("utf8");
  const evidenceLogs = readdirSync(evidenceDirectory)
    .filter((name) => name.endsWith(".log"))
    .map((name) => readFileSync(join(evidenceDirectory, name), "utf8"))
    .join("\n");

  assert.ok(validationToken, "provider validation token must be observed");
  const securitySurfaces = {
    apiBodies: apiBodies.join("\n"),
    database,
    domText,
    evidenceLogs,
    fallbackErrors,
    serverOutput,
  };
  let secretOccurrences = 0;
  for (const value of Object.values(securitySurfaces)) {
    secretOccurrences += countOccurrences(value, testApiKey);
    secretOccurrences += countOccurrences(value, validationToken);
  }
  assert.equal(secretOccurrences, 0);

  const databaseHandle = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(
    databaseHandle.prepare("SELECT COUNT(*) AS count FROM providers").get().count,
    1,
  );
  assert.equal(
    databaseHandle.prepare("SELECT COUNT(*) AS count FROM skills").get().count,
    1,
  );
  assert.equal(
    databaseHandle.prepare("SELECT COUNT(*) AS count FROM agents").get().count,
    2,
  );
  databaseHandle.close();

  console.log("SECURITY SCAN PASS: secret occurrences=0");
  console.log("REDIRECT CHECK PASS: authorization requests=0");
  console.log("BROWSER PASS: provider, edited skill, and two Agents persisted");
  console.log(`SMOKE SCREENSHOT: ${desktopScreenshot}`);
  console.log(`NARROW SCREENSHOT: ${narrowScreenshot}`);
  console.log(`DEMO SCREENSHOT: ${demoScreenshot}`);
  console.log(`CURRENT DESKTOP SCREENSHOT: ${currentDesktopScreenshot}`);
  console.log(`CURRENT NARROW SCREENSHOT: ${currentNarrowScreenshot}`);
  console.log(`CURRENT DESKTOP DEMO: ${currentDesktopDemoScreenshot}`);
  console.log(`CURRENT NARROW DEMO: ${currentNarrowDemoScreenshot}`);
} finally {
  await browser?.close();
  stopAppServer();
  if (compatibleProvider.listening) await close(compatibleProvider);
  if (redirectTarget.listening) await close(redirectTarget);
  rmSync(temporaryDirectory, { force: true, recursive: true });
}
