import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  createCipheriv,
  createHash,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";

const host = "127.0.0.1";
const port = 6100 + (process.pid % 300);
const baseUrl = `http://${host}:${port}`;
const temporaryDirectory = mkdtempSync(join(tmpdir(), "cool-ai-onboarding-"));
const databasePath = join(temporaryDirectory, "onboarding.sqlite");
const workspaceDirectory = join(temporaryDirectory, "workspace");
const reboundWorkspaceDirectory = join(temporaryDirectory, "workspace-rebound");
const secondWorkspaceDirectory = join(temporaryDirectory, "workspace-second");
const reconciledWorkspaceDirectory = join(
  temporaryDirectory,
  "workspace-reconciled",
);
mkdirSync(workspaceDirectory);
mkdirSync(reboundWorkspaceDirectory);
mkdirSync(secondWorkspaceDirectory);
mkdirSync(reconciledWorkspaceDirectory);
const workspacePath = realpathSync(workspaceDirectory);
const reboundWorkspacePath = realpathSync(reboundWorkspaceDirectory);
const projectId = "project-onboarding";
const providerId = "provider-onboarding";
const providerApiKey = "onboarding-browser-key";
const masterKeyBuffer = Buffer.alloc(32, 7);
const masterKey = masterKeyBuffer.toString("base64url");
const requestedApiPaths = [];
const requestedApiMethods = [];
const evidenceDirectory = join(
  process.cwd(),
  "features",
  "013-progressive-onboarding",
  "evidence",
);
const requiredScreenshots = [
  "onboarding-happy-desktop.png",
  "onboarding-existing-refresh-desktop.png",
  "onboarding-drift-repair-narrow-dark.png",
  "onboarding-error-focus-narrow.png",
];
const resultsPath = join(evidenceDirectory, "onboarding-results.json");
const executionDirectory = join(temporaryDirectory, "execution");
mkdirSync(executionDirectory);
mkdirSync(evidenceDirectory, { recursive: true });
let providerBaseUrl = "";
let providerAuthorizationCount = 0;
let providerRequestCount = 0;
const demoResults = {
  axe: [],
  controls: {},
  failureInjection: {},
  focus: [],
  getWriteCount: {},
  history: [],
  liveRegion: [],
  network: {},
  scenarios: [],
  themes: [],
  viewports: [],
};
const compatibleProvider = createServer((request, response) => {
  providerRequestCount += 1;
  if (request.headers.authorization) providerAuthorizationCount += 1;
  if (request.url === "/v1/models") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "test-model" }] }));
    return;
  }
  if (request.url === "/v1/chat/completions") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        choices: [{ finish_reason: "stop", index: 0, message: { content: "fixed", role: "assistant" } }],
        created: 1786118400,
        id: "chatcmpl-onboarding-fixed",
        model: "test-model",
        object: "chat.completion",
      }),
    );
    return;
  }
  response.writeHead(404).end();
});
const browserExecutable = [
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
].find((candidate) => candidate && existsSync(candidate));

const serverCommand =
  process.platform === "win32"
    ? {
        args: [
          "/d",
          "/s",
          "/c",
          `npx next start --hostname ${host} --port ${port}`,
        ],
        command: "cmd.exe",
      }
    : {
        args: ["next", "start", "--hostname", host, "--port", String(port)],
        command: "npx",
      };

let appServer;
let browser;
let context;
let serverOutput = "";

function listenRandom(server) {
  return new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, host, () => {
      const address = server.address();
      assert.equal(typeof address, "object");
      resolveListen(address.port);
    });
  });
}

function closeServer(server) {
  return new Promise((resolveClose) => server.close(() => resolveClose()));
}

function startServer() {
  appServer = spawn(serverCommand.command, serverCommand.args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      COCKPIT_DB_PATH: databasePath,
      COCKPIT_MASTER_KEY: masterKey,
      COCKPIT_EXECUTION_ROOT: executionDirectory,
      COCKPIT_WORKSPACE_ROOT: workspaceDirectory,
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

function stopServer() {
  if (!appServer?.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(appServer.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_500);
    spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*next*--port ${port}*' } | ForEach-Object { taskkill /pid $_.ProcessId /T /F | Out-Null }`,
      ],
      { stdio: "ignore", windowsHide: true },
    );
    const listeners = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue).OwningProcess`,
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
      throw new Error(`Onboarding app exited before readiness.\n${serverOutput}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/projects`);
      if (response.ok) return;
    } catch {
      // The isolated application is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Onboarding app did not become ready.\n${serverOutput}`);
}

async function setTheme(page, theme) {
  const currentTheme = await page.evaluate(
    () => document.documentElement.dataset.theme ?? "light",
  );
  if (currentTheme === theme) return;
  await page
    .getByRole("button", {
      name:
        theme === "dark"
          ? "当前为明色主题，切换到暗色主题"
          : "当前为暗色主题，切换到明色主题",
    })
    .evaluate((button) => button.click());
  assert.equal(
    await page.evaluate(() => document.documentElement.dataset.theme),
    theme,
  );
}

async function assertAccessibleSurface(page, label) {
  const scope = await page.evaluate(() => {
    const visible = (element) => {
      const style = window.getComputedStyle(element);
      const bounds = element.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        bounds.width > 0 &&
        bounds.height > 0
      );
    };
    return {
      elementCount: document.querySelectorAll("body *").length,
      kind: "document",
      openOverlays: Array.from(
        document.querySelectorAll('[role="dialog"], [aria-modal="true"]'),
      )
        .filter(visible)
        .map((element) => ({
          ariaLabel:
            element.getAttribute("aria-label") ??
            element.getAttribute("aria-labelledby") ??
            null,
          role: element.getAttribute("role"),
        })),
      path: `${window.location.pathname}${window.location.search}`,
      selector: "html",
      title: document.title,
    };
  });
  const results = await new AxeBuilder({ page }).analyze();
  const severity = {
    critical: 0,
    high: 0,
    minor: 0,
    moderate: 0,
    unknown: 0,
  };
  const nodesBySeverity = {
    critical: 0,
    high: 0,
    minor: 0,
    moderate: 0,
    unknown: 0,
  };
  for (const violation of results.violations) {
    const impact =
      violation.impact === "serious"
        ? "high"
        : violation.impact && violation.impact in severity
          ? violation.impact
          : "unknown";
    severity[impact] += 1;
    nodesBySeverity[impact] += violation.nodes.length;
  }
  const highImpact = results.violations.filter(
    (violation) =>
      violation.impact === "critical" || violation.impact === "serious",
  );
  assert.deepEqual(
    highImpact.map(({ id, impact, nodes }) => ({
      id,
      impact,
      targets: nodes.map((node) => node.target),
    })),
    [],
    `${label} axe critical/high violations`,
  );
  const undersized = await page
    .locator(
      ".onboarding-guide button:visible, .onboarding-guide-controls button:visible",
    )
    .evaluateAll((buttons) =>
      buttons
        .map((button) => {
          const rect = button.getBoundingClientRect();
          return {
            height: rect.height,
            label: button.getAttribute("aria-label") || button.textContent?.trim(),
            width: rect.width,
          };
        })
        .filter(({ height, width }) => height < 44 || width < 44),
    );
  assert.deepEqual(undersized, [], `${label} touch targets must be at least 44px`);
  demoResults.axe.push({
    label,
    nodesBySeverity,
    scope,
    severity,
    violations: results.violations.map(({ id, impact, nodes }) => ({
      id,
      impact: impact ?? "unknown",
      nodes: nodes.length,
    })),
  });
  return { criticalHigh: highImpact.length, undersized: undersized.length };
}

async function scanSurfaceMatrix(
  page,
  label,
  {
    closeNarrowSurface,
    openNarrowSurface,
  } = {},
) {
  const initialViewport = page.viewportSize();
  const initialTheme = await page.evaluate(
    () => document.documentElement.dataset.theme ?? "light",
  );
  const combinations = [
    { height: 1000, theme: "light", width: 1440 },
    { height: 1000, theme: "dark", width: 1440 },
    { height: 844, theme: "light", width: 390 },
    { height: 844, theme: "dark", width: 390 },
  ];
  for (const combination of combinations) {
    await page.setViewportSize({
      height: combination.height,
      width: combination.width,
    });
    await setTheme(page, combination.theme);
    if (combination.width === 390 && openNarrowSurface) {
      await openNarrowSurface();
    }
    await assertAccessibleSurface(
      page,
      `${label} ${combination.width}px ${combination.theme}`,
    );
    if (combination.width === 390 && closeNarrowSurface) {
      await closeNarrowSurface();
    }
  }
  if (initialViewport) await page.setViewportSize(initialViewport);
  await setTheme(page, initialTheme);
}

async function scanOpenOverlayMatrix(page, label, { close, open }) {
  const initialViewport = page.viewportSize();
  const initialTheme = await page.evaluate(
    () => document.documentElement.dataset.theme ?? "light",
  );
  const combinations = [
    { height: 1000, theme: "light", width: 1440 },
    { height: 1000, theme: "dark", width: 1440 },
    { height: 844, theme: "light", width: 390 },
    { height: 844, theme: "dark", width: 390 },
  ];
  for (const combination of combinations) {
    await page.setViewportSize({
      height: combination.height,
      width: combination.width,
    });
    await setTheme(page, combination.theme);
    await open();
    const visibleModalCount = await page
      .locator('[role="dialog"][aria-modal="true"]:visible')
      .count();
    assert.equal(
      visibleModalCount > 0,
      true,
      `${label} must expose an open modal surface before axe`,
    );
    await assertAccessibleSurface(
      page,
      `${label} open ${combination.width}px ${combination.theme}`,
    );
    await close();
  }
  if (initialViewport) await page.setViewportSize(initialViewport);
  await setTheme(page, initialTheme);
}

function seedReadyResources() {
  const database = new DatabaseSync(databasePath);
  const now = "2026-08-08T00:00:00.000Z";
  const encryptionKey = Buffer.from(
    hkdfSync(
      "sha256",
      masterKeyBuffer,
      Buffer.from("collaboration-cockpit:v1", "utf8"),
      Buffer.from("credential-encryption:v1", "utf8"),
      32,
    ),
  );
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
  cipher.setAAD(Buffer.from(`provider-api-key:v1\u0000${providerId}`, "utf8"));
  const encrypted = Buffer.concat([
    cipher.update(providerApiKey, "utf8"),
    cipher.final(),
  ]);
  const keyId = createHash("sha256")
    .update(masterKeyBuffer)
    .digest("base64url")
    .slice(0, 16);
  try {
    database
      .prepare(
        `INSERT INTO projects (
           id, name, created_at, workspace_path, workspace_key, version
         ) VALUES (?, 'Onboarding Project', ?, ?, ?, 1)`,
      )
      .run(projectId, now, workspacePath, workspacePath.toLowerCase());
    database
      .prepare(
        `INSERT INTO providers (
           id, name, base_url, default_model, api_key_cipher, api_key_iv,
           api_key_tag, credential_version, credential_generation, key_id,
           api_key_mask, verified_at, version, created_at, updated_at
         ) VALUES (
           ?, 'Verified Provider', ?,
           'test-model', ?, ?, ?, 1, 1, ?, '••••-key', ?,
           1, ?, ?
         )`,
      )
      .run(
        providerId,
        `${providerBaseUrl}/v1`,
        encrypted.toString("base64url"),
        iv.toString("base64url"),
        cipher.getAuthTag().toString("base64url"),
        keyId,
        now,
        now,
        now,
      );
    const insertAgent = database.prepare(
      `INSERT INTO agents (
         id, name, role, system_prompt, provider_id, model, avatar_text,
         accent_token, can_read, can_write, can_execute, review_capable,
         max_tokens, max_handoffs, version, created_at, updated_at
       ) VALUES (?, ?, ?, 'Follow the owner goal.', 'provider-onboarding',
         'test-model', ?, ?, 1, ?, ?, ?, 1000, 5, 1, ?, ?)`,
    );
    insertAgent.run(
      "agent-builder",
      "Builder",
      "builder",
      "B",
      "sage",
      1,
      1,
      0,
      now,
      now,
    );
    insertAgent.run(
      "agent-reviewer",
      "Reviewer",
      "reviewer",
      "R",
      "gold",
      0,
      0,
      1,
      now,
      now,
    );
    insertAgent.run(
      "agent-operator",
      "Operator",
      "operator",
      "O",
      "slate",
      1,
      1,
      0,
      now,
      now,
    );
    const insertMember = database.prepare(
      `INSERT INTO project_memberships (project_id, agent_id, joined_at)
       VALUES (?, ?, ?)`,
    );
    insertMember.run(projectId, "agent-builder", now);
    insertMember.run(projectId, "agent-reviewer", now);
  } finally {
    database.close();
  }
}

try {
  const providerPort = await listenRandom(compatibleProvider);
  providerBaseUrl = `http://${host}:${providerPort}`;
  startServer();
  await waitForApp();

  browser = await chromium.launch({
    headless: true,
    ...(browserExecutable ? { executablePath: browserExecutable } : {}),
  });
  context = await browser.newContext({
    viewport: { height: 1000, width: 1440 },
  });
  const page = await context.newPage();
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin === baseUrl && url.pathname.startsWith("/api/")) {
      requestedApiPaths.push(url.pathname);
      requestedApiMethods.push(request.method());
    }
  });

  let providerGetFailures = 0;
  await page.route("**/api/providers", async (route) => {
    if (route.request().method() === "GET" && providerGetFailures === 0) {
      providerGetFailures += 1;
      await route.abort("failed");
      return;
    }
    await route.continue();
  });
  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto(
    `${baseUrl}/team?section=providers&guide=provider&returnTo=/`,
    { waitUntil: "networkidle" },
  );
  const providerErrorGuide = page.getByRole("region", {
    name: "Provider 首次使用引导",
  });
  await providerErrorGuide
    .getByRole("alert")
    .filter({ hasText: "无法核对模型服务" })
    .waitFor();
  await page
    .getByRole("button", { name: "当前为明色主题，切换到暗色主题" })
    .click();
  const providerRetryButton = providerErrorGuide.getByRole("button", {
    name: "重新检测",
  });
  await providerRetryButton.focus();
  assert.equal(
    await providerRetryButton.evaluate((node) => document.activeElement === node),
    true,
  );
  await assertAccessibleSurface(page, "provider error narrow dark");
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: join(evidenceDirectory, "onboarding-error-focus-narrow.png"),
  });
  await providerRetryButton.click();
  await providerErrorGuide
    .getByText("尚无模型服务。请使用现有表面创建并验证连接。", {
      exact: true,
    })
    .waitFor();
  await page.unroute("**/api/providers");
  demoResults.failureInjection.providerGetRetry = {
    failedGets: providerGetFailures,
    recovered: true,
  };

  const preferenceControls = page.getByRole("group", { name: "引导控制" });
  await preferenceControls.getByRole("button", { name: "暂时关闭引导" }).click();
  assert.equal(await providerErrorGuide.count(), 0);
  assert.equal(
    await preferenceControls.getByRole("button", { name: "跳过此步骤" }).count(),
    0,
  );
  await page.reload({ waitUntil: "networkidle" });
  assert.equal(await providerErrorGuide.count(), 0);
  const resumePage = await context.newPage();
  await resumePage.goto(
    `${baseUrl}/team?section=providers&guide=provider&returnTo=/`,
    { waitUntil: "networkidle" },
  );
  assert.equal(
    await resumePage.getByRole("region", {
      name: "Provider 首次使用引导",
    }).count(),
    0,
  );
  const resumeButton = resumePage.getByRole("button", { name: "恢复引导" });
  await resumeButton.waitFor();
  assert.equal(
    await resumeButton.evaluate((node) => document.activeElement === node),
    true,
  );
  await resumeButton.click();
  await resumePage.getByRole("region", {
    name: "Provider 首次使用引导",
  }).waitFor();
  await providerErrorGuide.waitFor();
  await resumePage.close();
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Object.defineProperty(window, "__restoreOnboardingStorage", {
      configurable: true,
      value: () => {
        Storage.prototype.setItem = original;
      },
    });
    Storage.prototype.setItem = () => {
      throw new DOMException("Injected storage failure", "QuotaExceededError");
    };
  });
  await preferenceControls.getByRole("button", { name: "暂时关闭引导" }).click();
  await preferenceControls
    .getByRole("alert")
    .filter({ hasText: "引导偏好未能安全保存" })
    .waitFor();
  await page.evaluate(() => window.__restoreOnboardingStorage());
  demoResults.controls = {
    dismissResume: true,
    storageFailureRollback: true,
  };
  await page
    .getByRole("button", { name: "当前为暗色主题，切换到明色主题" })
    .click();
  await page.setViewportSize({ height: 1000, width: 1440 });

  await page.goto(`${baseUrl}/?guide=project-select`, {
    waitUntil: "networkidle",
  });
  const emptyProjectGuide = page.getByRole("region", {
    name: "首次使用引导",
  });
  await emptyProjectGuide
    .getByText(
      "尚无可选文件夹项目。请先打开本地文件夹，或直接在中间开始个人对话。",
      { exact: true },
    )
    .waitFor();
  await emptyProjectGuide
    .getByRole("button", { name: "使用现有表面打开文件夹" })
    .click();
  const folderPathInput = page.getByLabel("文件夹路径");
  assert.equal(
    await folderPathInput.evaluate((node) => document.activeElement === node),
    true,
  );

  await page.setViewportSize({ height: 844, width: 390 });
  await page.reload({ waitUntil: "networkidle" });
  await emptyProjectGuide
    .getByRole("button", { name: "使用现有表面打开文件夹" })
    .click();
  assert.equal(
    await folderPathInput.evaluate((node) => document.activeElement === node),
    true,
  );

  seedReadyResources();
  await page.setViewportSize({ height: 1000, width: 1440 });
  await page.goto(
    `${baseUrl}/team?section=providers&guide=provider&returnTo=/`,
    { waitUntil: "networkidle" },
  );
  const providerGuide = page.getByRole("region", {
    name: "Provider 首次使用引导",
  });
  await providerGuide
    .getByText("已检测到 verified 模型服务，可以继续。", { exact: true })
    .waitFor();
  assert.equal(
    await page.title(),
    "连接模型服务 · Cool AI 协作驾驶舱",
  );
  assert.equal(
    await page.getByRole("status").filter({
      hasText: "已进入 Provider 引导：连接模型服务",
    }).count(),
    1,
  );
  await scanSurfaceMatrix(page, "provider complete page", {
    closeNarrowSurface: async () => {
      await page
        .getByRole("button", { name: "关闭模型服务编辑器" })
        .click();
    },
    openNarrowSurface: async () => {
      await page.getByRole("button", { name: "编辑 Verified Provider" }).click();
      await page
        .getByRole("dialog", { name: "编辑模型服务" })
        .waitFor();
    },
  });
  await providerGuide
    .getByRole("button", { name: "聚焦已验证模型服务" })
    .click();
  const providerHeading = page.getByRole("heading", {
    name: "Verified Provider",
  });
  assert.equal(
    await providerHeading.evaluate((node) => document.activeElement === node),
    true,
  );
  assert.equal((await page.locator("body").innerText()).includes(providerApiKey), false);

  const preferenceBeforeProviderContinue = JSON.parse(
    await page.evaluate(() =>
      window.localStorage.getItem("cool-ai:onboarding-preference:v1"),
    ),
  );
  assert.equal(preferenceBeforeProviderContinue.skips.provider.value, false);
  await providerGuide.getByRole("button", { name: "继续" }).click();
  await page.waitForURL(
    `${baseUrl}/team?section=agents&guide=agent&returnTo=/`,
  );
  await page.goBack({ waitUntil: "networkidle" });
  await page.waitForURL(
    `${baseUrl}/team?section=providers&guide=provider&returnTo=/`,
  );
  await page.goForward({ waitUntil: "networkidle" });
  await page.waitForURL(
    `${baseUrl}/team?section=agents&guide=agent&returnTo=/`,
  );
  const preferenceAfterProviderContinue = JSON.parse(
    await page.evaluate(() =>
      window.localStorage.getItem("cool-ai:onboarding-preference:v1"),
    ),
  );
  assert.equal(preferenceAfterProviderContinue.skips.provider.value, false);
  assert.equal(
    preferenceAfterProviderContinue.events.some(
      (event) => event.action === "skip" && event.step === "provider",
    ),
    false,
  );
  demoResults.controls.continueWithoutSkip = true;
  const agentGuide = page.getByRole("region", {
    name: "Agent 首次使用引导",
  });
  await agentGuide
    .getByText("已检测到引用 verified Provider 的 Agent。", {
      exact: true,
    })
    .waitFor();
  assert.equal(await page.title(), "连接 Agent · Cool AI 协作驾驶舱");
  assert.equal(
    await page.getByRole("status").filter({
      hasText: "已进入 Agent 引导：连接 Agent 与未来复核资格",
    }).count(),
    1,
  );
  assert.equal(
    await page
      .getByRole("heading", { name: "连接 Agent 与未来复核资格" })
      .evaluate((node) => document.activeElement === node),
    true,
  );
  assert.equal(
    (await agentGuide.innerText()).includes(
      "选择项目后才会核对两名成员与未来复核候选；不会提前宣称独立复核。",
    ),
    true,
  );
  await agentGuide
    .getByRole("button", { name: "聚焦合格 Agent" })
    .click();
  const reviewerHeading = page.getByRole("heading", { name: "Builder" });
  assert.equal(
    await reviewerHeading.evaluate((node) => document.activeElement === node),
    true,
  );
  assert.equal((await page.locator("body").innerText()).includes("Follow the owner goal."), false);

  await page.setViewportSize({ height: 844, width: 390 });
  await page
    .getByRole("button", { name: "当前为明色主题，切换到暗色主题" })
    .evaluate((button) => button.click());
  assert.equal(
    await page.evaluate(() => document.documentElement.dataset.theme),
    "dark",
  );
  const providerGuideFit = await agentGuide.evaluate((node) => ({
    documentClientWidth: document.documentElement.clientWidth,
    documentScrollWidth: document.documentElement.scrollWidth,
    guideLeft: node.getBoundingClientRect().left,
    guideRight: node.getBoundingClientRect().right,
  }));
  assert.equal(
    providerGuideFit.documentScrollWidth <= providerGuideFit.documentClientWidth &&
      providerGuideFit.guideLeft >= 0 &&
      providerGuideFit.guideRight <= providerGuideFit.documentClientWidth,
    true,
  );
  await scanSurfaceMatrix(page, "agent complete page", {
    closeNarrowSurface: async () => {
      await page.getByRole("button", { name: "关闭 Agent 编辑器" }).click();
    },
    openNarrowSurface: async () => {
      await page.getByRole("button", { name: "编辑 Builder" }).click();
      await page.getByRole("dialog", { name: "编辑 Agent" }).waitFor();
    },
  });

  await page.setViewportSize({ height: 1000, width: 1440 });
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  const entry = page.getByRole("link", { name: "首次使用引导" });
  await entry.focus();
  assert.equal(await entry.evaluate((node) => document.activeElement === node), true);
  await page.keyboard.press("Enter");
  await page.waitForURL(
    `${baseUrl}/team?section=providers&guide=provider&returnTo=/`,
  );
  await page
    .getByRole("region", { name: "Provider 首次使用引导" })
    .getByRole("button", { name: "继续" })
    .click();
  await page.waitForURL(
    `${baseUrl}/team?section=agents&guide=agent&returnTo=/`,
  );
  await page
    .getByRole("region", { name: "Agent 首次使用引导" })
    .getByRole("button", { name: "继续" })
    .click();
  await page.waitForURL(`${baseUrl}/?guide=project-select`);

  const guide = page.getByRole("region", { name: "首次使用引导" });
  const oneProjectChoices = guide.getByRole("list", { name: "可访问项目" });
  await oneProjectChoices
    .getByRole("button", { name: "Onboarding Project" })
    .waitFor();
  assert.equal(await oneProjectChoices.getByRole("button").count(), 1);
  assert.equal(page.url(), `${baseUrl}/?guide=project-select`);

  const secondProjectResponse = await page.request.post(`${baseUrl}/api/projects`, {
    data: { path: secondWorkspaceDirectory },
  });
  assert.equal(secondProjectResponse.ok(), true);
  await page.reload({ waitUntil: "networkidle" });
  const multipleProjectChoices = guide.getByRole("list", {
    name: "可访问项目",
  });
  await multipleProjectChoices
    .getByRole("button", { name: "workspace-second" })
    .waitFor();
  assert.equal(await multipleProjectChoices.getByRole("button").count(), 2);
  assert.equal(page.url(), `${baseUrl}/?guide=project-select`);
  await guide.getByRole("button", { name: "Onboarding Project" }).click();
  await page.waitForURL(`${baseUrl}/projects/${projectId}?guide=workspace`);
  await page.goBack({ waitUntil: "networkidle" });
  await page.waitForURL(`${baseUrl}/?guide=project-select`);
  await guide.getByRole("button", { name: "Onboarding Project" }).waitFor();
  await scanSurfaceMatrix(page, "project selection complete page", {
    closeNarrowSurface: async () => {
      await page.getByRole("button", { name: "关闭项目导航" }).click();
    },
    openNarrowSurface: async () => {
      await page
        .getByRole("button", { name: "打开项目导航" })
        .evaluate((button) => button.click());
      await page.getByRole("dialog", { name: "项目导航" }).waitFor();
    },
  });
  await page.goForward({ waitUntil: "networkidle" });
  await page.waitForURL(`${baseUrl}/projects/${projectId}?guide=workspace`);
  await page.reload({ waitUntil: "networkidle" });
  assert.equal(page.url(), `${baseUrl}/projects/${projectId}?guide=workspace`);
  const workspaceGuide = page.getByRole("region", {
    name: "Workspace 首次使用引导",
  });
  await workspaceGuide
    .getByText("工作区已 bind ready：目录已规范化且当前可读。", {
      exact: true,
    })
    .waitFor();
  assert.equal((await workspaceGuide.innerText()).includes(workspacePath), false);
  await workspaceGuide.getByRole("button", { name: "聚焦工作区绑定" }).click();
  const workspaceSummary = page.getByRole("status", {
    name: "工作区绑定状态",
  });
  assert.equal(
    await workspaceSummary.evaluate((node) => document.activeElement === node),
    true,
  );
  await scanSurfaceMatrix(page, "workspace complete page");
  assert.equal(
    (await workspaceGuide.innerText()).includes(
      "真实执行仍会重新取得 verified handle、进入 sandbox，并遵守审批与审计。",
    ),
    true,
  );
  await page.getByRole("button", { name: "保存工作区" }).click();
  const workspaceInput = page.getByLabel("本地工作区路径");
  await workspaceInput.fill(reboundWorkspacePath);
  await page.getByRole("button", { name: "保存工作区" }).click();
  const rebindDialog = page.getByRole("dialog", { name: "确认改绑工作区" });
  await rebindDialog.waitFor();
  assert.equal(
    await rebindDialog
      .getByRole("button", { name: "确认改绑" })
      .evaluate((node) => document.activeElement === node),
    true,
  );
  await page.keyboard.press("Tab");
  assert.equal(
    await rebindDialog
      .getByRole("button", { name: "取消" })
      .evaluate((node) => document.activeElement === node),
    true,
  );
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Escape");
  assert.equal(await rebindDialog.count(), 0);
  assert.equal(
    await page
      .getByRole("button", { name: "保存工作区" })
      .evaluate((node) => document.activeElement === node),
    true,
  );
  await scanOpenOverlayMatrix(page, "workspace rebind dialog", {
    close: async () => {
      await page.keyboard.press("Escape");
      await rebindDialog.waitFor({ state: "detached" });
    },
    open: async () => {
      await page.getByRole("button", { name: "保存工作区" }).click();
      await rebindDialog.waitFor();
    },
  });
  await page.getByRole("button", { name: "保存工作区" }).click();
  await rebindDialog.getByRole("button", { name: "确认改绑" }).click();
  await page.getByText("工作区已保存。", { exact: true }).waitFor();
  const canonicalReboundWorkspacePath = await workspaceInput.inputValue();
  assert.equal((await workspaceGuide.innerText()).includes(reboundWorkspacePath), false);

  let conflictPuts = 0;
  await page.route(`**/api/projects/${projectId}/workspace`, async (route) => {
    if (route.request().method() === "PUT") {
      conflictPuts += 1;
      await route.fulfill({
        contentType: "application/json",
        status: 409,
        body: JSON.stringify({
          error: {
            code: "RESOURCE_CONFLICT",
            currentVersion: 3,
            message: "Project version is stale.",
          },
        }),
      });
      return;
    }
    await route.continue();
  });
  await workspaceInput.fill(workspacePath);
  await page.getByRole("button", { name: "保存工作区" }).click();
  await rebindDialog.getByRole("button", { name: "确认改绑" }).click();
  await page.getByRole("alert").filter({ hasText: "项目已更新" }).waitFor();
  await page.getByRole("button", { name: "重新加载工作区" }).click();
  await page.waitForFunction(
    (expected) =>
      document.querySelector("[name=workspacePath]")?.value === expected,
    canonicalReboundWorkspacePath,
  );
  assert.equal(conflictPuts, 1);
  await page.unroute(`**/api/projects/${projectId}/workspace`);

  let uncertainWorkspacePuts = 0;
  let reconciliationWorkspaceGets = 0;
  await page.route(`**/api/projects/${projectId}/workspace`, async (route) => {
    if (route.request().method() === "PUT") {
      uncertainWorkspacePuts += 1;
      await route.fetch();
      await route.abort("failed");
      return;
    }
    if (uncertainWorkspacePuts > 0) reconciliationWorkspaceGets += 1;
    await route.continue();
  });
  await page.getByRole("button", { name: "保存工作区" }).click();
  await page
    .getByText("已通过事实核对确认工作区已保存。", { exact: true })
    .waitFor();
  assert.equal(uncertainWorkspacePuts, 1);
  assert.equal(reconciliationWorkspaceGets, 1);
  await page.unroute(`**/api/projects/${projectId}/workspace`);

  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "dark");
  await page
    .getByRole("button", { name: "当前为暗色主题，切换到明色主题" })
    .click();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "light");
  await page.setViewportSize({ height: 844, width: 390 });
  await page.reload({ waitUntil: "networkidle" });
  await workspaceGuide.waitFor();
  const narrowWorkspaceFit = await workspaceGuide.evaluate((node) => ({
    documentClientWidth: document.documentElement.clientWidth,
    documentScrollWidth: document.documentElement.scrollWidth,
    guideLeft: node.getBoundingClientRect().left,
    guideRight: node.getBoundingClientRect().right,
  }));
  assert.equal(
    narrowWorkspaceFit.documentScrollWidth <=
      narrowWorkspaceFit.documentClientWidth &&
      narrowWorkspaceFit.guideLeft >= 0 &&
      narrowWorkspaceFit.guideRight <= narrowWorkspaceFit.documentClientWidth,
    true,
  );
  await page.getByRole("button", { name: "关闭项目导航" }).click();
  await page
    .getByRole("button", { name: "当前为明色主题，切换到暗色主题" })
    .click();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "dark");
  await page.getByRole("button", { name: "打开项目导航" }).click();
  await workspaceGuide.waitFor();
  assert.equal(
    (await page.evaluate(() =>
      window.localStorage.getItem("cool-ai:onboarding-preference:v1") ?? ""
    )).includes(canonicalReboundWorkspacePath),
    false,
  );
  await page.setViewportSize({ height: 1000, width: 1440 });
  await page.reload({ waitUntil: "networkidle" });
  await workspaceGuide.waitFor();

  await workspaceGuide.getByRole("button", { name: "继续" }).click();
  await page.waitForURL(`${baseUrl}/projects/${projectId}?guide=members`);
  const membersGuide = page.getByRole("region", {
    name: "Members 首次使用引导",
  });
  await membersGuide
    .getByText("两名合格成员与未来复核候选已就绪，无需重新保存。", {
      exact: true,
    })
    .waitFor();
  await membersGuide
    .getByRole("button", { name: "聚焦合格成员名册" })
    .click();
  assert.equal(
    await page
      .getByRole("heading", { name: "成员名册" })
      .evaluate((node) => document.activeElement === node),
    true,
  );
  await scanSurfaceMatrix(page, "members complete page");
  const memberGroup = page.getByRole("group", { name: "平等项目成员" });
  await memberGroup.getByRole("checkbox", { name: /Operator/ }).check();
  await memberGroup.getByRole("checkbox", { name: /Builder/ }).uncheck();
  await page.getByRole("button", { name: "保存成员" }).click();
  await page.getByText("项目成员已保存。", { exact: true }).waitFor();
  const memberStateAfterReplace = await page.evaluate(async (id) => {
    const response = await fetch(`/api/projects/${id}/members`);
    return response.json();
  }, projectId);
  assert.deepEqual(
    memberStateAfterReplace.members.map((member) => member.agentId),
    ["agent-reviewer", "agent-operator"],
  );
  assert.equal(
    (await membersGuide.innerText()).includes("正式复核仍会动态排除 executor"),
    true,
  );
  assert.equal(
    (await membersGuide.innerText()).includes("Follow the owner goal."),
    false,
  );
  await page.setViewportSize({ height: 844, width: 390 });
  await page.reload({ waitUntil: "networkidle" });
  await membersGuide.waitFor();
  const narrowMembersFit = await membersGuide.evaluate((node) => ({
    documentClientWidth: document.documentElement.clientWidth,
    documentScrollWidth: document.documentElement.scrollWidth,
    guideLeft: node.getBoundingClientRect().left,
    guideRight: node.getBoundingClientRect().right,
  }));
  assert.equal(
    narrowMembersFit.documentScrollWidth <=
      narrowMembersFit.documentClientWidth &&
      narrowMembersFit.guideLeft >= 0 &&
      narrowMembersFit.guideRight <= narrowMembersFit.documentClientWidth,
    true,
  );
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "dark");
  await page.setViewportSize({ height: 1000, width: 1440 });

  await membersGuide.getByRole("button", { name: "继续" }).click();
  await page.waitForURL(`${baseUrl}/projects/${projectId}?guide=goal`);
  await guide
    .getByText("资源已就绪，可以创建使命并启动协作。", { exact: true })
    .waitFor();

  let malformedMissionGets = 0;
  await page.route(`**/api/projects/${projectId}/mission`, async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    malformedMissionGets += 1;
    const response = await route.fetch();
    const payload = await response.json();
    await route.fulfill({
      body: JSON.stringify({ ...payload, extra: "fail-closed" }),
      headers: { ...response.headers(), "content-type": "application/json" },
      status: response.status(),
    });
  });
  await page.reload({ waitUntil: "networkidle" });
  await guide
    .getByText("无法核对资源，已停止引导写操作。", { exact: true })
    .waitFor();
  assert.equal(
    await guide.getByRole("button", { name: "创建使命目标" }).isDisabled(),
    true,
  );
  await page.unroute(`**/api/projects/${projectId}/mission`);
  await guide.getByRole("button", { name: "仅重新核对目标事实" }).click();
  await guide
    .getByText("资源已就绪，可以创建使命并启动协作。", { exact: true })
    .waitFor();
  demoResults.failureInjection.malformedMissionEnvelope = {
    failedClosed: true,
    malformedGets: malformedMissionGets,
    recoveredByGet: true,
  };
  await scanSurfaceMatrix(page, "mission and collaboration empty page");
  await guide
    .getByText(
      "后续正式执行仍会取得 verified handle、进入 sandbox 并遵守审批；独立复核必须由非 executor 的合格成员完成。",
      { exact: true },
    )
    .waitFor();

  let uncertainMissionPosts = 0;
  let missionReconciliationGets = 0;
  await page.route(`**/api/projects/${projectId}/mission`, async (route) => {
    if (route.request().method() === "POST") {
      uncertainMissionPosts += 1;
      await route.fetch();
      await route.abort("failed");
      return;
    }
    if (uncertainMissionPosts > 0) missionReconciliationGets += 1;
    await route.continue();
  });
  await guide.getByRole("button", { name: "创建使命目标" }).click();
  const missionTitle = page.getByLabel("使命标题");
  await page.waitForFunction(
    () => document.activeElement?.getAttribute("aria-label") === null &&
      document.activeElement?.id.startsWith("mission-title-"),
  );
  assert.equal(
    await missionTitle.evaluate((node) => document.activeElement === node),
    true,
  );
  await missionTitle.fill("Onboarding Mission");
  await page.getByLabel("使命目标").fill("Prepare a verified release plan");
  await page.getByRole("button", { name: "创建使命", exact: true }).click();
  await page.getByRole("heading", { name: "Onboarding Mission" }).waitFor();
  await page
    .getByText(
      "已通过事实核对确认目标已受理；尚未执行、复核或交付。",
      { exact: true },
    )
    .waitFor();
  await scanSurfaceMatrix(page, "mission populated complete page");
  assert.equal(uncertainMissionPosts, 1);
  assert.equal(missionReconciliationGets >= 1, true);
  await page.unroute(`**/api/projects/${projectId}/mission`);

  let uncertainMissionPatches = 0;
  let missionPatchReconciliationGets = 0;
  await page.route(`**/api/missions/**`, async (route) => {
    if (route.request().method() === "PATCH") {
      uncertainMissionPatches += 1;
      await route.fetch();
      await route.abort("failed");
      return;
    }
    await route.continue();
  });
  await page.route(`**/api/projects/${projectId}/mission`, async (route) => {
    if (uncertainMissionPatches > 0) missionPatchReconciliationGets += 1;
    await route.continue();
  });
  await page.getByRole("button", { name: "编辑使命" }).click();
  await missionTitle.fill("Updated Onboarding Mission");
  await page.getByLabel("使命目标").fill("Prepare a verified release plan safely");
  await page.getByRole("button", { name: "保存使命" }).click();
  await page
    .getByText("已通过事实核对确认使命已保存。", { exact: true })
    .waitFor();
  assert.equal(uncertainMissionPatches, 1);
  assert.equal(missionPatchReconciliationGets >= 1, true);
  await page.unroute(`**/api/missions/**`);
  await page.unroute(`**/api/projects/${projectId}/mission`);

  const threadId = await page.evaluate(async (id) => {
    const members = await (await fetch(`/api/projects/${id}/members`)).json();
    const response = await fetch(`/api/projects/${id}/threads`, {
      body: JSON.stringify({
        memberAgentIds: members.members.map((member) => member.agentId),
        operationId: crypto.randomUUID(),
        title: "Onboarding collaboration",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(payload));
    return payload.thread.id;
  }, projectId);
  await page.goto(
    `${baseUrl}/projects/${projectId}?thread=${encodeURIComponent(threadId)}&guide=goal`,
    { waitUntil: "networkidle" },
  );
  let uncertainRunPosts = 0;
  let runReconciliationGets = 0;
  await page.route(
    `**/api/projects/${projectId}/threads/${threadId}/runs`,
    async (route) => {
    uncertainRunPosts += 1;
    await route.fetch();
    await route.abort("failed");
    },
  );
  await page.route(`**/api/projects/${projectId}/threads/${threadId}**`, async (route) => {
    if (uncertainRunPosts > 0 && route.request().method() === "GET") {
      runReconciliationGets += 1;
    }
    await route.fallback();
  });
  await guide.getByRole("button", { name: "在项目群聊启动协作" }).click();
  const composer = page.getByLabel("发送给项目群聊");
  await page.waitForFunction(
    () => document.activeElement?.id.startsWith("collaboration-message-"),
  );
  assert.equal(await composer.evaluate((node) => document.activeElement === node), true);
  await composer.fill("Start the verified onboarding collaboration.");
  await page.getByRole("button", { name: "发送并开始首次运行" }).click();
  await page.getByText("协作已启动", { exact: true }).waitFor();
  await page.getByText("所有者发来消息", { exact: true }).waitFor();
  await page
    .getByText("协作已启动；目标已受理，但尚未执行、复核或交付。", {
      exact: true,
    })
    .waitFor();
  await page
    .getByText("Start the verified onboarding collaboration.", { exact: true })
    .waitFor();
  await scanSurfaceMatrix(page, "collaboration active complete page");
  assert.equal(uncertainRunPosts, 1);
  assert.equal(runReconciliationGets >= 1, true);
  await page.unroute(`**/api/projects/${projectId}/threads/${threadId}/runs`);
  await page.unroute(`**/api/projects/${projectId}/threads/${threadId}**`);

  let uncertainMessagePosts = 0;
  let messageReconciliationGets = 0;
  await page.route(
    `**/api/projects/${projectId}/threads/${threadId}/messages`,
    async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    uncertainMessagePosts += 1;
    await route.fetch();
    await route.abort("failed");
    },
  );
  await page.route(`**/api/projects/${projectId}/threads/${threadId}**`, async (route) => {
    if (uncertainMessagePosts > 0 && route.request().method() === "GET") {
      messageReconciliationGets += 1;
    }
    await route.fallback();
  });
  await composer.fill("Follow-up after the active run started.");
  await page.getByRole("button", { name: "发送消息" }).click();
  await page
    .getByText("已通过事实核对确认消息已发送。", { exact: true })
    .waitFor();
  await page
    .getByText("Follow-up after the active run started.", { exact: true })
    .waitFor();
  assert.equal(uncertainMessagePosts, 1);
  assert.equal(messageReconciliationGets >= 1, true);
  await page.unroute(`**/api/projects/${projectId}/threads/${threadId}/messages`);
  await page.unroute(`**/api/projects/${projectId}/threads/${threadId}**`);

  const facts = await page.evaluate(async ({ id, selectedThreadId }) => {
    const [mission, messages, threadFacts] = await Promise.all([
      fetch(`/api/projects/${id}/mission`).then((response) => response.json()),
      fetch(`/api/projects/${id}/threads/${selectedThreadId}/messages`)
        .then((response) => response.json()),
      fetch(`/api/projects/${id}/threads/${selectedThreadId}/facts`)
        .then((response) => response.json()),
    ]);
    return { mission, messages, threadFacts };
  }, { id: projectId, selectedThreadId: threadId });
  assert.equal(facts.mission.mission.title, "Updated Onboarding Mission");
  assert.equal(facts.messages.items[0].authorType, "owner");
  assert.equal(
    facts.threadFacts.items.some(
      (fact) =>
        fact.type === "run_event" && fact.payload.eventType === "run_started",
    ),
    true,
  );
  demoResults.failureInjection.unknownJourneyWrites = {
    activeMessagePosts: uncertainMessagePosts,
    activeMessageReconciliationGets: messageReconciliationGets,
    missionPatches: uncertainMissionPatches,
    missionPatchReconciliationGets,
    missionPosts: uncertainMissionPosts,
    missionReconciliationGets,
    runPosts: uncertainRunPosts,
    runReconciliationGets,
  };
  assert.equal(
    facts.threadFacts.items.some(
      (fact) => fact.type === "owner_message",
    ),
    true,
  );
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForFunction(() => {
    const raw = window.localStorage.getItem("cool-ai:onboarding-preference:v1");
    if (!raw) return false;
    try {
      return JSON.parse(raw).status?.value === "completed";
    } catch {
      return false;
    }
  });
  const completedPreference = JSON.parse(
    await page.evaluate(() =>
      window.localStorage.getItem("cool-ai:onboarding-preference:v1"),
    ),
  );
  assert.equal(
    completedPreference.status.value,
    "completed",
    "formal Mission and CollaborationRun acceptance must complete onboarding",
  );
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(completedPreference.skips).map(([step, register]) => [
        step,
        register.value,
      ]),
    ),
    {
      agent: false,
      goal: false,
      members: false,
      "project-select": false,
      provider: false,
      workspace: false,
    },
    "satisfied steps must continue without writing skip registers",
  );
  assert.equal(
    completedPreference.events.some((event) => event.action === "skip"),
    false,
    "only an explicit skip action may write a skip event",
  );
  assert.equal(
    requestedApiPaths.some((path) => /\/api\/runs\/[^/]+\/advance$/.test(path)),
    false,
    "goal intake must not advance execution automatically",
  );
  if (
    (await page.evaluate(() => document.documentElement.dataset.theme)) ===
    "dark"
  ) {
    await page
      .getByRole("button", { name: "当前为暗色主题，切换到明色主题" })
      .click();
  }
  await guide.screenshot({
    animations: "disabled",
    path: join(evidenceDirectory, "onboarding-happy-desktop.png"),
  });
  await page.reload({ waitUntil: "networkidle" });
  await guide
    .getByText(
      "协作已启动且 owner message 与 run_started 已对账；尚未执行、复核或交付。",
      { exact: true },
    )
    .waitFor();
  await guide.screenshot({
    animations: "disabled",
    path: join(evidenceDirectory, "onboarding-existing-refresh-desktop.png"),
  });
  assert.equal(
    (await guide.innerText()).includes("Prepare a verified release plan"),
    false,
  );
  const guidePreference = await page.evaluate(() =>
    window.localStorage.getItem("cool-ai:onboarding-preference:v1") ?? ""
  );
  for (const sensitiveValue of [
    providerApiKey,
    workspacePath,
    reboundWorkspacePath,
    "Prepare a verified release plan",
    "Start the verified onboarding collaboration.",
    "Follow the owner goal.",
  ]) {
    assert.equal(
      guidePreference.includes(sensitiveValue),
      false,
      "guide preference/events must not contain sensitive business values",
    );
  }
  assert.equal(
    (await guide.innerText()).includes(
      "Start the verified onboarding collaboration.",
    ),
    false,
  );
  await page.goBack({ waitUntil: "networkidle" });
  await page.goForward({ waitUntil: "networkidle" });
  await guide
    .getByText(
      "协作已启动且 owner message 与 run_started 已对账；尚未执行、复核或交付。",
      { exact: true },
    )
    .waitFor();
  const database = new DatabaseSync(databasePath);
  const originalCipher = database
    .prepare("SELECT api_key_cipher FROM providers WHERE id = ?")
    .get(providerId).api_key_cipher;
  database
    .prepare("UPDATE providers SET api_key_cipher = 'invalid' WHERE id = ?")
    .run(providerId);
  database.close();
  await page.setViewportSize({ height: 844, width: 390 });
  await page
    .getByRole("button", { name: "当前为明色主题，切换到暗色主题" })
    .evaluate((button) => button.click());
  await page.reload({ waitUntil: "networkidle" });
  await page
    .getByRole("group", { name: "引导控制" })
    .getByRole("alert")
    .filter({ hasText: "已完成记录仍保留，但当前事实已漂移" })
    .waitFor();
  const driftPreference = JSON.parse(
    await page.evaluate(() =>
      window.localStorage.getItem("cool-ai:onboarding-preference:v1"),
    ),
  );
  assert.equal(driftPreference.status.value, "completed");
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: join(
      evidenceDirectory,
      "onboarding-drift-repair-narrow-dark.png",
    ),
  });
  const repairDatabase = new DatabaseSync(databasePath);
  repairDatabase
    .prepare("UPDATE providers SET api_key_cipher = ? WHERE id = ?")
    .run(originalCipher, providerId);
  repairDatabase.close();
  await page.reload({ waitUntil: "networkidle" });
  await guide
    .getByText(
      "协作已启动且 owner message 与 run_started 已对账；尚未执行、复核或交付。",
      { exact: true },
    )
    .waitFor();
  assert.equal(
    await page
      .getByRole("group", { name: "引导控制" })
      .getByRole("alert")
      .filter({ hasText: "已完成记录仍保留" })
      .count(),
    0,
  );
  demoResults.controls.completedDriftRepair = true;
  const narrowGoalFit = await guide.evaluate((node) => ({
    documentClientWidth: document.documentElement.clientWidth,
    documentScrollWidth: document.documentElement.scrollWidth,
    guideLeft: node.getBoundingClientRect().left,
    guideRight: node.getBoundingClientRect().right,
  }));
  assert.equal(
    narrowGoalFit.documentScrollWidth <= narrowGoalFit.documentClientWidth &&
      narrowGoalFit.guideLeft >= 0 &&
      narrowGoalFit.guideRight <= narrowGoalFit.documentClientWidth,
    true,
  );
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "dark");
  await page.setViewportSize({ height: 1000, width: 1440 });

  let uncertainProjectPosts = 0;
  let reconciliationGets = 0;
  await page.route("**/api/projects", async (route) => {
    if (route.request().method() !== "POST") {
      if (uncertainProjectPosts > 0) reconciliationGets += 1;
      await route.continue();
      return;
    }
    uncertainProjectPosts += 1;
    await route.fetch();
    await route.abort("failed");
  });
  await page.goto(`${baseUrl}/?guide=project-select`, {
    waitUntil: "networkidle",
  });
  await page.getByRole("button", { name: "打开文件夹" }).first().click();
  await page.getByLabel("文件夹路径").fill(reconciledWorkspaceDirectory);
  await page.getByRole("button", { name: "打开文件夹", exact: true }).click();
  await page.waitForURL(/\/projects\/[^/]+/);
  await page.getByRole("heading", { name: "workspace-reconciled" }).waitFor();
  assert.equal(uncertainProjectPosts, 1);
  assert.equal(reconciliationGets >= 1, true);
  await page.unroute("**/api/projects");

  await page.goto(`${baseUrl}/projects/deleted-project?guide=workspace`, {
    waitUntil: "networkidle",
  });
  await page.getByRole("alert").filter({ hasText: "未找到该项目" }).first().waitFor();
  await page.getByRole("button", { name: "返回项目选择" }).click();
  await page.waitForURL(`${baseUrl}/?guide=project-select`);

  await page.setViewportSize({ height: 844, width: 390 });
  await page.reload({ waitUntil: "networkidle" });
  const narrowProjectSurface = page.getByTestId("collaboration-cockpit");
  await narrowProjectSurface.waitFor();
  const narrowFit = await narrowProjectSurface.evaluate((node) => ({
    documentClientWidth: document.documentElement.clientWidth,
    documentScrollWidth: document.documentElement.scrollWidth,
    guideLeft: node.getBoundingClientRect().left,
    guideRight: node.getBoundingClientRect().right,
  }));
  assert.equal(
    narrowFit.documentScrollWidth <= narrowFit.documentClientWidth &&
      narrowFit.guideLeft >= 0 &&
      narrowFit.guideRight <= narrowFit.documentClientWidth,
    true,
  );

  assert.equal(
    requestedApiPaths.some((path) => /^\/api\/tasks(?:\/|$)/.test(path)),
    false,
    `onboarding must not request the legacy root task API: ${requestedApiPaths.join(", ")}`,
  );
  assert.equal(serverOutput.includes(providerApiKey), false);
  assert.equal(serverOutput.includes("Authorization"), false);
  demoResults.scenarios = [
    "empty-database-entry-and-retry",
    "preseeded-resource-continue",
    "formal-mission-collaboration-accepted",
    "completed-drift-repair",
  ];
  demoResults.history = [
    "provider",
    "agent",
    "project-select",
    "workspace",
    "members",
    "goal",
    "back",
    "forward",
    "refresh",
  ];
  demoResults.focus = [
    "route-heading",
    "provider-target",
    "agent-target",
    "workspace-summary",
    "mission-title",
    "collaboration-composer",
    "dialog-trap-escape-restore",
  ];
  demoResults.liveRegion = [
    "polite-route-once",
    "assertive-error",
    "preference-result-once",
  ];
  demoResults.themes = ["light", "dark"];
  demoResults.viewports = [
    { height: 1000, width: 1440 },
    { height: 844, width: 390 },
  ];
  demoResults.network = {
    authorizationHeaderObserved: providerAuthorizationCount > 0,
    providerRequests: providerRequestCount,
    secretsLogged: false,
  };
  demoResults.getWriteCount = {
    apiGets: requestedApiMethods.filter((method) => method === "GET").length,
    apiWrites: requestedApiMethods.filter((method) => method !== "GET").length,
    legacyTasks: requestedApiPaths.filter((path) =>
      /^\/api\/tasks(?:\/|$)/.test(path),
    ).length,
  };
  const jsonPayload = JSON.stringify(
    {
      contractVersion: 1,
      generatedAt: "2026-08-08T00:00:00.000Z",
      result: "passed",
      ...demoResults,
    },
    null,
    2,
  );
  for (const sensitiveValue of [
    providerApiKey,
    workspacePath,
    reboundWorkspacePath,
    "Prepare a verified release plan",
    "Start the verified onboarding collaboration.",
  ]) {
    assert.equal(
      jsonPayload.includes(sensitiveValue),
      false,
      "demo result must not record secrets, filesystem paths, or goal bodies",
    );
  }
  writeFileSync(resultsPath, `${jsonPayload}\n`, "utf8");
  assert.deepEqual(
    requiredScreenshots.filter(
      (fileName) => !existsSync(join(evidenceDirectory, fileName)),
    ),
    [],
    "real browser demo must generate all four stable PNG evidence files",
  );
  assert.equal(existsSync(resultsPath), true);
  console.log(
    "ONBOARDING BROWSER PASS: verified Provider and Agent-member joins, future reviewer candidate only, light+dark, desktop+narrow, explicit project, Mission, CollaborationRun, owner message, run_started, no secrets, no /tasks",
  );
} finally {
  await browser?.close();
  stopServer();
  if (compatibleProvider.listening) await closeServer(compatibleProvider);
  rmSync(temporaryDirectory, {
    force: true,
    maxRetries: 10,
    recursive: true,
    retryDelay: 200,
  });
}
