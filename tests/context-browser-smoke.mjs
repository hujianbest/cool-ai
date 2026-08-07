import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { chromium } from "playwright";

const host = "127.0.0.1";
const appPort = 5200 + (process.pid % 200);
const providerPort = 5400 + (process.pid % 200);
const baseUrl = `http://${host}:${appPort}`;
const providerBaseUrl = `http://${host}:${providerPort}/v1`;
const temporaryDirectory = mkdtempSync(
  join(tmpdir(), "cool-ai-context-smoke-"),
);
const workspaceDirectory = join(temporaryDirectory, "real-workspace");
mkdirSync(workspaceDirectory);
const canonicalWorkspace = realpathSync(workspaceDirectory);
let boundWorkspacePath = canonicalWorkspace;
const reboundWorkspaceDirectory = join(
  temporaryDirectory,
  "rebound-real-workspace",
);
mkdirSync(reboundWorkspaceDirectory);
let reboundWorkspacePath = realpathSync(reboundWorkspaceDirectory);
const databasePath = join(temporaryDirectory, "context-smoke.sqlite");
const auditPath = join(temporaryDirectory, "workspace-audit.jsonl");
const masterKey = randomBytes(32).toString("base64url");
const testApiKey = "context-provider-key-DO-NOT-LEAK-2026";
const evidenceDirectory = resolve(
  "features",
  "003-project-team-context",
  "evidence",
);
const desktopScreenshot = join(
  evidenceDirectory,
  "smoke-context-desktop.png",
);
const narrowScreenshot = join(
  evidenceDirectory,
  "smoke-context-narrow.png",
);
const demoScreenshot = join(evidenceDirectory, "demo-project-context.png");
const browserExecutable = [
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
].find((candidate) => candidate && existsSync(candidate));

mkdirSync(evidenceDirectory, { recursive: true });

let providerAuthorizationCount = 0;
const provider = createServer((request, response) => {
  if (request.url === "/v1/models") {
    if (request.headers.authorization === `Bearer ${testApiKey}`) {
      providerAuthorizationCount += 1;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "context-model" }] }));
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
      throw new Error(`Context app exited before readiness.\n${serverOutput}`);
    }
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
    } catch {
      // The isolated Next.js app is still starting.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  throw new Error(`Context app did not become ready.\n${serverOutput}`);
}

function countOccurrences(text, needle) {
  return needle ? text.split(needle).length - 1 : 0;
}

async function selectOptionContaining(select, text) {
  const value = await select
    .locator("option")
    .filter({ hasText: text })
    .getAttribute("value");
  assert.ok(value, `select option containing "${text}" must exist`);
  await select.selectOption(value);
}

async function createTeamPrerequisites(page) {
  await page.goto(`${baseUrl}/team`, { waitUntil: "networkidle" });
  await page.getByRole("tab", { name: "模型服务" }).click();
  await page.getByRole("button", { name: "创建模型服务" }).click();
  await page.getByLabel("服务名称").fill("Context Local Provider");
  await page.getByLabel("Base URL").fill(providerBaseUrl);
  await page.getByLabel("默认模型").fill("context-model");
  await page.getByLabel("API key").fill(testApiKey);
  await page
    .getByRole("checkbox", { name: /HTTP 会明文传输凭据/ })
    .check();
  await page.getByRole("button", { name: "验证连接" }).click();
  await page
    .getByText("已验证模型 context-model", { exact: true })
    .waitFor();
  await page.getByRole("button", { name: "保存服务" }).click();
  await page.getByText("模型服务已保存。", { exact: true }).waitFor();

  await page.getByRole("tab", { name: "技能" }).click();
  await page.getByRole("button", { name: "创建新技能" }).click();
  await page.getByLabel("技能名称").fill("Context Skill");
  await page.getByLabel("技能说明").fill("Context browser acceptance skill");
  await page
    .getByLabel("指令正文")
    .fill("Keep project context deterministic and sourced.");
  await page.getByRole("button", { name: "保存技能" }).click();
  await page.getByRole("heading", { name: "Context Skill" }).waitFor();

  await page.getByRole("tab", { name: "Agent" }).click();
  await page.getByRole("button", { name: "创建 Agent" }).click();
  await page.getByLabel("创建方式").selectOption("planner");
  await page.getByLabel("Agent 名称").fill("Context Planner");
  await page
    .getByLabel("模型服务")
    .selectOption({ label: "Context Local Provider" });
  await page.getByRole("checkbox", { name: "Context Skill" }).check();
  await page.getByRole("button", { name: "保存 Agent" }).click();
  await page.getByRole("heading", { name: "Context Planner" }).waitFor();

  await page.getByRole("button", { name: "创建 Agent" }).click();
  await page.getByLabel("创建方式").selectOption("builder");
  await page.getByLabel("Agent 名称").fill("Context Builder");
  await page
    .getByLabel("模型服务")
    .selectOption({ label: "Context Local Provider" });
  await page.getByRole("checkbox", { name: "Context Skill" }).check();
  await page.getByRole("checkbox", { name: "写入文件" }).check();
  await page.getByRole("checkbox", { name: "运行命令" }).check();
  await page.getByRole("button", { name: "保存 Agent" }).click();
  await page.getByRole("heading", { name: "Context Builder" }).waitFor();
}

async function createMemory(rightPanel, {
  type,
  content,
  sourceType,
  sourceRef,
  supersedes,
}) {
  await rightPanel.getByRole("radio", { name: type }).check();
  await rightPanel.getByLabel("记忆正文").fill(content);
  await rightPanel.getByLabel("来源类型").selectOption(sourceType);
  await rightPanel.getByLabel("来源引用").fill(sourceRef);
  if (supersedes) {
    await rightPanel.getByLabel("取代旧记忆").selectOption({
      label: supersedes,
    });
  }
  await rightPanel.getByRole("button", { name: "保存记忆" }).click();
  await rightPanel.getByRole("heading", { name: content }).waitFor();
}

let browser;
let validationToken = "";
const projectResponseBodies = [];
const errorResponseBodies = [];
try {
  await listen(provider, providerPort);
  appServer = spawn(serverCommand.command, serverCommand.args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      COCKPIT_DB_PATH: databasePath,
      COCKPIT_MASTER_KEY: masterKey,
      COCKPIT_WORKSPACE_AUDIT_PATH: auditPath,
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
    viewport: { height: 1100, width: 1600 },
  });
  page.on("response", async (response) => {
    const url = response.url();
    if (
      url.endsWith("/api/providers/verify") &&
      response.status() === 200
    ) {
      validationToken = (await response.json()).validationToken;
      return;
    }
    if (url.includes("/api/projects/") || url.includes("/api/missions/")) {
      const body = await response.text().catch(() => "");
      projectResponseBodies.push(body);
      if (response.status() >= 400) errorResponseBodies.push(body);
    }
  });

  await createTeamPrerequisites(page);
  assert.equal(providerAuthorizationCount, 1);
  assert.ok(validationToken);

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.getByLabel("项目名称").fill("Context Smoke Project");
  await page
    .locator("form")
    .filter({ has: page.getByLabel("项目名称") })
    .getByRole("button", { name: "创建项目" })
    .click();
  await page.waitForURL(/\/projects\/[^/]+$/);
  await page
    .getByRole("heading", { name: "Context Smoke Project" })
    .waitFor();

  await page.getByLabel("本地工作区路径").fill(workspaceDirectory);
  await page.getByRole("button", { name: "绑定工作区" }).click();
  await page.getByText("工作区已保存。", { exact: true }).waitFor();
  boundWorkspacePath =
    (await page.getByLabel("工作区绑定状态").locator("code").textContent()) ??
    canonicalWorkspace;

  const membersFieldset = page.getByRole("group", {
    name: "平等项目成员",
  });
  await membersFieldset
    .getByRole("checkbox", { name: /Context Planner/ })
    .check();
  await membersFieldset
    .getByRole("checkbox", { name: /Context Builder/ })
    .check();
  await page.getByRole("button", { name: "保存成员" }).click();
  await page.getByText("项目成员已保存。", { exact: true }).waitFor();
  await page.reload({ waitUntil: "networkidle" });
  await page.getByText(boundWorkspacePath, { exact: true }).waitFor();
  await page
    .getByRole("checkbox", { name: /Context Planner/ })
    .waitFor();

  await page.getByLabel("使命标题").fill("Context Smoke Mission");
  await page
    .getByLabel("使命目标")
    .fill("Prove real deterministic project context");
  await page.getByRole("button", { name: "创建使命" }).click();
  await page
    .getByRole("heading", { name: "Context Smoke Mission" })
    .waitFor();

  await page.getByLabel("任务标题").fill("Plan task");
  await page.getByLabel("任务说明").fill("Prepare the implementation");
  await selectOptionContaining(page.getByLabel("负责人"), "Context Planner");
  await page.getByRole("button", { name: "创建任务" }).click();
  await page.getByRole("heading", { name: "Plan task" }).waitFor();

  await page.getByLabel("任务标题").fill("Build task");
  await page.getByLabel("任务说明").fill("Implement after planning");
  await selectOptionContaining(page.getByLabel("负责人"), "Context Builder");
  await page
    .getByRole("group", { name: "前置依赖" })
    .getByRole("checkbox", { name: "Plan task" })
    .check();
  await page.getByRole("button", { name: "创建任务" }).click();
  await page.getByRole("heading", { name: "Build task" }).waitFor();

  await page.getByRole("button", { name: "开始任务 Build task" }).click();
  await page
    .getByRole("alert")
    .getByText(/前置依赖尚未完成/)
    .waitFor();
  await page.getByRole("button", { name: "开始任务 Plan task" }).click();
  await page.getByRole("button", { name: "完成任务 Plan task" }).click();
  await page.getByRole("button", { name: "开始任务 Build task" }).click();
  await page.getByRole("button", { name: "完成任务 Build task" }).click();

  const missionState = await page.evaluate(async () => {
    const projects = await (await fetch("/api/projects")).json();
    const projectId = projects.projects[0].id;
    const state = await (
      await fetch(`/api/projects/${projectId}/mission`)
    ).json();
    return { projectId, state };
  });
  const planId = missionState.state.workItems.find(
    (item) => item.title === "Plan task",
  ).id;

  const rightPanel = page.locator(".cockpit-context");
  await createMemory(rightPanel, {
    type: "目标",
    content: "Initial context goal",
    sourceType: "owner_input",
    sourceRef: "Owner baseline",
  });
  await createMemory(rightPanel, {
    type: "目标",
    content: "Current context goal",
    sourceType: "owner_input",
    sourceRef: "Owner revision",
    supersedes: "Initial context goal",
  });
  await createMemory(rightPanel, {
    type: "决策",
    content: "Use deterministic transitions",
    sourceType: "owner_input",
    sourceRef: "Owner decision",
  });
  await createMemory(rightPanel, {
    type: "事实",
    content: "Plan task completed",
    sourceType: "work_item",
    sourceRef: planId,
  });
  await createMemory(rightPanel, {
    type: "产物",
    content: "Acceptance report",
    sourceType: "artifact_path",
    sourceRef: "docs/context-report.md",
  });
  await rightPanel.getByText("仅引用，尚未读取", { exact: true }).waitFor();

  await rightPanel.getByRole("tab", { name: "上下文预览" }).click();
  const memberSelect = rightPanel.getByLabel("预览成员");
  await selectOptionContaining(memberSelect, "Context Planner");
  const sharedRegion = rightPanel.getByRole("region", {
    name: "共享项目上下文",
  });
  await sharedRegion.waitFor();
  const plannerSharedText = await sharedRegion.textContent();
  await selectOptionContaining(memberSelect, "Context Builder");
  await rightPanel
    .getByRole("region", { name: "当前 Agent 私有配置" })
    .getByRole("heading", { name: "Context Builder" })
    .waitFor();
  const builderSharedText = await sharedRegion.textContent();
  assert.equal(builderSharedText, plannerSharedText);

  const snapshots = await page.evaluate(
    async ({ projectId }) => {
      const memberState = await (
        await fetch(`/api/projects/${projectId}/members`)
      ).json();
      return Promise.all(
        memberState.members.map(async (member) => ({
          agentId: member.agentId,
          snapshot: await (
            await fetch(
              `/api/projects/${projectId}/context?agentId=${member.agentId}`,
            )
          ).json(),
        })),
      );
    },
    { projectId: missionState.projectId },
  );
  assert.deepEqual(snapshots[0].snapshot.shared, snapshots[1].snapshot.shared);
  console.log("SHARED SNAPSHOT PASS: two member shared sections deeply equal");

  await page.evaluate(
    async ({ projectId, path }) => {
      await fetch(`/api/projects/${projectId}/workspace`, {
        body: `{"path":"${path}"`,
        headers: { "content-type": "application/json" },
        method: "PUT",
      });
    },
    { projectId: missionState.projectId, path: boundWorkspacePath },
  );

  await page.screenshot({ fullPage: true, path: desktopScreenshot });
  await page.screenshot({ fullPage: true, path: demoScreenshot });

  await page.reload({ waitUntil: "networkidle" });
  await page
    .getByRole("heading", { name: "Context Smoke Mission" })
    .waitFor();
  await page
    .getByTestId("editor-surface")
    .getByRole("heading", { exact: true, name: "Plan task" })
    .waitFor();
  await page
    .getByTestId("editor-surface")
    .getByRole("heading", { exact: true, name: "Build task" })
    .waitFor();
  await page
    .locator(".cockpit-context")
    .getByRole("heading", { name: "Current context goal" })
    .waitFor();
  console.log("PERSISTENCE PASS: project context survived refresh");

  await page.setViewportSize({ height: 844, width: 390 });
  await page.reload({ waitUntil: "networkidle" });
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  });
  await page.keyboard.press("Tab");
  const projectsOpener = page.getByRole("button", {
    name: "打开项目导航",
  });
  assert.equal(
    await projectsOpener.evaluate(
      (element) => document.activeElement === element,
    ),
    true,
  );
  await page.keyboard.press("Tab");
  const editorOpener = page.getByRole("button", { name: "打开编辑" });
  assert.equal(
    await editorOpener.evaluate(
      (element) => document.activeElement === element,
    ),
    true,
  );
  await page.keyboard.press("Tab");
  const contextOpener = page.getByRole("button", {
    name: "打开当前任务上下文",
  });
  assert.equal(
    await contextOpener.evaluate(
      (element) => document.activeElement === element,
    ),
    true,
  );

  await projectsOpener.click();
  const projectsDialog = page.getByRole("dialog", { name: "项目导航" });
  await projectsDialog.waitFor();
  assert.notEqual(
    await page.getByTestId("editor-surface").getAttribute("inert"),
    null,
  );
  const narrowWorkspaceInput = projectsDialog.getByLabel(
    "本地工作区路径",
  );
  await narrowWorkspaceInput.fill(reboundWorkspaceDirectory);
  const rebindOpener = projectsDialog.getByRole("button", {
    name: "保存工作区",
  });
  await rebindOpener.click();
  let rebindConfirmation = page.getByRole("dialog", {
    name: "确认改绑工作区",
  });
  await rebindConfirmation.waitFor();
  assert.equal(
    await page.locator('[aria-modal="true"]').count(),
    1,
  );
  assert.equal(
    await rebindConfirmation
      .getByRole("button", { name: "确认改绑" })
      .evaluate((element) => document.activeElement === element),
    true,
  );
  await rebindConfirmation.getByRole("button", { name: "取消" }).click();
  await rebindConfirmation.waitFor({ state: "detached" });
  assert.equal(await page.locator('[aria-modal="true"]').count(), 1);
  assert.equal(
    await rebindOpener.evaluate(
      (element) => document.activeElement === element,
    ),
    true,
  );

  await rebindOpener.click();
  rebindConfirmation = page.getByRole("dialog", {
    name: "确认改绑工作区",
  });
  await rebindConfirmation.getByRole("button", { name: "确认改绑" }).click();
  await rebindConfirmation.waitFor({ state: "detached" });
  reboundWorkspacePath =
    (await projectsDialog
      .getByLabel("工作区绑定状态")
      .locator("code")
      .textContent()) ?? reboundWorkspacePath;
  assert.equal(await page.locator('[aria-modal="true"]').count(), 1);
  await page.keyboard.press("Escape");
  await projectsDialog.waitFor({ state: "detached" });
  assert.equal(
    await projectsOpener.evaluate(
      (element) => document.activeElement === element,
    ),
    true,
  );

  await editorOpener.click();
  const editorDialog = page.getByRole("dialog", { name: "任务编辑" });
  await editorDialog
    .getByRole("heading", { name: "Context Smoke Mission" })
    .waitFor();
  assert.equal(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
    true,
  );
  await page.keyboard.press("Escape");
  await editorDialog.waitFor({ state: "detached" });

  await contextOpener.click();
  const contextDialog = page.getByRole("dialog", {
    name: "当前任务上下文",
  });
  await contextDialog.waitFor();
  const memoryTab = contextDialog.getByRole("tab", { name: "共享记忆" });
  await memoryTab.focus();
  await page.keyboard.press("End");
  assert.equal(
    await contextDialog
      .getByRole("tab", { name: "骨架运行" })
      .getAttribute("aria-selected"),
    "true",
  );
  await page.keyboard.press("Home");
  assert.equal(await memoryTab.getAttribute("aria-selected"), "true");
  await page.screenshot({ fullPage: true, path: narrowScreenshot });
  await page.keyboard.press("Escape");
  await contextDialog.waitFor({ state: "detached" });
  assert.equal(
    await contextOpener.evaluate(
      (element) => document.activeElement === element,
    ),
    true,
  );

  const auditOperations = readFileSync(auditPath, "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line).operation);
  assert.deepEqual(auditOperations, [
    "realpath",
    "stat",
    "access",
    "realpath",
    "stat",
    "access",
  ]);
  const operationAudit = {
    access: auditOperations.filter((operation) => operation === "access")
      .length,
    contentRead: 0,
    enumerate: 0,
    exec: 0,
    realpath: auditOperations.filter((operation) => operation === "realpath")
      .length,
    stat: auditOperations.filter((operation) => operation === "stat").length,
    write: 0,
  };
  assert.deepEqual(operationAudit, {
    access: 2,
    contentRead: 0,
    enumerate: 0,
    exec: 0,
    realpath: 2,
    stat: 2,
    write: 0,
  });
  console.log(
    `AUDIT PASS: ${JSON.stringify(operationAudit)}; content read/enumerate/write/exec=0`,
  );

  const serializedSnapshots = JSON.stringify(snapshots);
  const providerSecrets = [
    testApiKey,
    masterKey,
    validationToken,
    providerBaseUrl,
  ];
  for (const secret of providerSecrets) {
    assert.equal(countOccurrences(serializedSnapshots, secret), 0);
    assert.equal(countOccurrences(projectResponseBodies.join("\n"), secret), 0);
    assert.equal(countOccurrences(serverOutput, secret), 0);
  }
  for (const path of new Set([
    workspaceDirectory,
    boundWorkspacePath,
    reboundWorkspaceDirectory,
    reboundWorkspacePath,
  ])) {
    assert.equal(countOccurrences(serverOutput, path), 0);
    assert.equal(countOccurrences(errorResponseBodies.join("\n"), path), 0);
  }
  for (const entry of snapshots) {
    assert.equal(
      entry.snapshot.shared.project.workspacePath,
      boundWorkspacePath,
    );
  }
  console.log(
    "SECURITY PASS: provider secrets=0 across snapshots/project responses/logs; full path=0 in errors/logs and allowlisted in workspace snapshots",
  );

  const database = new DatabaseSync(databasePath, { readOnly: true });
  const counts = Object.fromEntries(
    [
      "providers",
      "agents",
      "projects",
      "project_memberships",
      "missions",
      "work_items",
      "memory_entries",
    ].map((table) => [
      table,
      database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count,
    ]),
  );
  database.close();
  assert.deepEqual(counts, {
    agents: 2,
    memory_entries: 5,
    missions: 1,
    project_memberships: 2,
    projects: 1,
    providers: 1,
    work_items: 2,
  });

  console.log("BROWSER PASS: full S-3 desktop and narrow acceptance completed");
  console.log(`SMOKE SCREENSHOT: ${desktopScreenshot}`);
  console.log(`NARROW SCREENSHOT: ${narrowScreenshot}`);
  console.log(`DEMO SCREENSHOT: ${demoScreenshot}`);
} finally {
  await browser?.close();
  stopAppServer();
  if (provider.listening) await close(provider);
  rmSync(temporaryDirectory, { force: true, recursive: true });
}
