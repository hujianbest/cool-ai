import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import AxeBuilder from "@axe-core/playwright";
import { chromium } from "playwright";

const host = "127.0.0.1";
const portSeed = randomBytes(4).readUInt32BE();
const appPort = 10_000 + (portSeed % 20_000);
const providerPort = appPort + 1;
const baseUrl = `http://${host}:${appPort}`;
const providerBaseUrl = `http://${host}:${providerPort}/v1`;
const temporaryDirectory = mkdtempSync(join(tmpdir(), "cool-ai-execution-smoke-"));
const workspaceDirectory = join(temporaryDirectory, "workspace");
const executionRoot = join(temporaryDirectory, "executions");
const databasePath = join(temporaryDirectory, "execution-smoke.sqlite");
mkdirSync(join(workspaceDirectory, "src"), { recursive: true });
mkdirSync(executionRoot, { recursive: true });
writeFileSync(join(workspaceDirectory, "src", "canonical.txt"), "canonical-before\n");
const canonicalWorkspace = realpathSync(workspaceDirectory);
const masterKey = randomBytes(32).toString("base64url");
const apiKey = `execution-key-${randomBytes(18).toString("base64url")}`;
const rawProviderMarker = `RAW_PROVIDER_${randomBytes(12).toString("hex")}`;
const chainOfThoughtMarker = `COT_${randomBytes(12).toString("hex")}`;
const environmentMarker = `ENV_${randomBytes(12).toString("hex")}`;
const evidenceDirectory = resolve("features", "005-safe-parallel-execution", "evidence");
const auditEvidenceDirectory = resolve("features", "028-audit-projection-mvp", "evidence");
const desktopScreenshot = join(evidenceDirectory, "demo-execution-desktop.png");
const narrowScreenshot = join(evidenceDirectory, "demo-execution-narrow.png");
const auditDesktopScreenshot = join(auditEvidenceDirectory, "demo-audit-desktop.png");
const auditNarrowScreenshot = join(auditEvidenceDirectory, "demo-audit-narrow.png");
const approvalCenterEvidenceDirectory = resolve("features", "029-unified-approval-center", "evidence");
const approvalCenterDesktopScreenshot = join(approvalCenterEvidenceDirectory, "approval-center-desktop-light.png");
const approvalCenterLapsedScreenshot = join(approvalCenterEvidenceDirectory, "approval-center-lapsed-desktop-light.png");
const approvalCenterLapsedDarkScreenshot = join(approvalCenterEvidenceDirectory, "approval-center-lapsed-desktop-dark.png");
const approvalCenterNarrowScreenshot = join(approvalCenterEvidenceDirectory, "approval-center-narrow-light.png");
const approvalCenterResultsPath = join(approvalCenterEvidenceDirectory, "approval-center-acceptance-results.json");
mkdirSync(evidenceDirectory, { recursive: true });
mkdirSync(auditEvidenceDirectory, { recursive: true });
mkdirSync(approvalCenterEvidenceDirectory, { recursive: true });

const browserExecutable = [
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
].find((candidate) => candidate && existsSync(candidate));

const providerCaptures = [];
const apiBodies = [];
const advanceRequests = [];
const modelSteps = new Map();
let alphaAgentId = "";
let betaAgentId = "";
let collaborationStep = 0;
let executionPhase = "isolated";
let approvalCenterProposalSeeded = false;
let providerAuthorizationCount = 0;
let maxConcurrentProviderCalls = 0;
let concurrentProviderCalls = 0;

function jsonResponse(response, value, status = 200) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

async function requestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function executionAction(taskTitle, step) {
  const alpha = taskTitle.includes("Alpha");
  if (executionPhase === "manual" && step < 10) {
    return {
      action: {
        content: `${`manual merge payload ${step}\n`.repeat(3_000)}`,
        expectedHash: null,
        path: `src/manual-${String(step).padStart(2, "0")}.txt`,
        type: "write",
      },
      summary: `Prepare manual recovery merge file ${step}.`,
    };
  }
  if (executionPhase === "manual" && step === 10) {
    return {
      action: {
        args: ["--version"],
        executable: process.execPath,
        expectedEffect: "Run the declared standing validation.",
        type: "command",
        workdir: ".",
      },
      summary: "Run standing validation before the fault-injected merge.",
    };
  }
  if (executionPhase === "manual") {
    return {
      action: { type: "staged" },
      summary: "Declare the multi-file manual recovery fixture ready.",
    };
  }
  if (step === 0) {
    // lapsed 造数必须写全新路径：沙盒快照会带上 canonical 里已合入的 beta.txt，
    // 既有文件 + expectedHash=null 在 verified 写语义下失败关闭（-conflict/unverifiable），
    // 与 restart 无关；各阶段 step 0 一贯只写新文件。
    const path = executionPhase === "conflict"
      ? "src/conflict.txt"
      : executionPhase === "lapsed"
        ? "src/lapsed.txt"
        : alpha ? "src/alpha.txt" : "src/beta.txt";
    const content = `${alpha ? "alpha" : "beta"} isolated edit\n`;
    return {
      action: {
        content,
        expectedHash: null,
        path,
        type: "write",
      },
      summary: `${alpha ? "Alpha" : "Beta"} writes only its declared file.`,
    };
  }
  if (step === 1) {
    return {
      action: {
        args: [alpha ? "--version" : "--help"],
        executable: process.execPath,
        expectedEffect: alpha
          ? "Run the declared standing validation."
          : "Exercise one exact one-shot approval.",
        type: "command",
        workdir: ".",
      },
      summary: alpha ? "Run standing validation." : "Request one-shot validation.",
    };
  }
  if (!alpha && step === 2) {
    return {
      action: {
        args: ["--version"],
        executable: process.execPath,
        expectedEffect: "Run the declared standing validation.",
        type: "command",
        workdir: ".",
      },
      summary: "Run standing validation after the one-shot command.",
    };
  }
  return {
    action: { type: "staged" },
    summary: "Declare the isolated edit ready for staged review.",
  };
}

function collaborationAction(step) {
  if (step === 0) {
    // 029 T-04：首个规划轮顺带 emit 一个待决 proposal 块（真实公共协作缝持久化），
    // 作为审批中心内联决策域的待决造数；后续规划轮不再重复 emit。
    const approvalCenterBlocks = approvalCenterProposalSeeded ? undefined : [{
      actions: ["accept", "reject"],
      blockRevision: 1,
      blockSchemaVersion: 1,
      blockType: "proposal",
      body: "Decide the unified approval center end to end.",
      logicalBlockId: "approval-center-proposal",
      title: "Approval Center Proposal",
    }];
    approvalCenterProposalSeeded = true;
    return {
      ...(approvalCenterBlocks ? { blocks: approvalCenterBlocks } : {}),
      claim: { clientKey: "alpha", source: "proposed" },
      disposition: {
        reason: "Beta owns the second independent execution task.",
        summary: "Alpha claimed its task and handed planning to Beta.",
        targetAgentId: betaAgentId,
        type: "handoff",
      },
      message: "Plan the two independent execution tasks.",
      tasks: [{
        clientKey: "alpha",
        dependsOnKeys: [],
        description: "Edit only src/alpha.txt.",
        title: "Implement Alpha file",
      }],
    };
  }
  return {
    claim: { clientKey: "beta", source: "proposed" },
    disposition: { type: "plan_ready" },
    message: "Both independent execution tasks are assigned and ready.",
    tasks: [{
      clientKey: "beta",
      dependsOnKeys: [],
      description: "Edit only src/beta.txt.",
      title: "Implement Beta file",
    }],
  };
}

const provider = createServer(async (request, response) => {
  const body = await requestBody(request);
  providerCaptures.push({
    authorization: String(request.headers.authorization ?? ""),
    body,
    method: request.method,
    url: request.url,
  });
  if (request.headers.authorization === `Bearer ${apiKey}`) {
    providerAuthorizationCount += 1;
  }
  if (request.method === "GET" && request.url === "/v1/models") {
    jsonResponse(response, { data: [{ id: "execution-model" }] });
    return;
  }
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    response.writeHead(404).end();
    return;
  }
  const parsed = JSON.parse(body);
  const prompt = parsed.messages.map(({ content }) => content).join("\n");
  if (prompt.includes("ProposedTask:")) {
    const action = collaborationAction(collaborationStep);
    collaborationStep += 1;
    jsonResponse(response, {
      choices: [{ message: { content: JSON.stringify(action) } }],
      usage: { completion_tokens: 7, prompt_tokens: 11, total_tokens: 18 },
    });
    return;
  }
  if (!prompt.includes("You are executing one frozen project task")) {
    jsonResponse(response, {
      choices: [{ message: { content: "ok" } }],
      usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 },
    });
    return;
  }
  concurrentProviderCalls += 1;
  maxConcurrentProviderCalls = Math.max(maxConcurrentProviderCalls, concurrentProviderCalls);
  try {
    const alphaTask = /"task":\{[^}]*"title":"Implement Alpha file"/u.test(prompt);
    const betaTask = /"task":\{[^}]*"title":"Implement Beta file"/u.test(prompt);
    const taskTitle = alphaTask && !betaTask
      ? "Implement Alpha file"
      : betaTask && !alphaTask
        ? "Implement Beta file"
        : undefined;
    assert.ok(
      taskTitle === "Implement Alpha file" || taskTitle === "Implement Beta file",
      `Unexpected execution task context: ${taskTitle}`,
    );
    const step = modelSteps.get(taskTitle) ?? 0;
    modelSteps.set(taskTitle, step + 1);
    await new Promise((done) => setTimeout(done, step === 0 ? 500 : 30));
    jsonResponse(response, {
      choices: [{ message: { content: JSON.stringify(executionAction(taskTitle, step)) } }],
      usage: { completion_tokens: 7, prompt_tokens: 11, total_tokens: 18 },
    });
  } finally {
    concurrentProviderCalls -= 1;
  }
});

function listen(server, port) {
  return new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, host, resolveListen);
  });
}

function close(server) {
  return new Promise((resolveClose) => server.close(resolveClose));
}

const nextCli = resolve("node_modules", "next", "dist", "bin", "next");
const serverCommand = {
  args: [
    nextCli,
    "start",
    "--hostname",
    host,
    "--port",
    String(appPort),
  ],
  command: process.execPath,
};

let appServer;
let serverOutput = "";

function startAppServer() {
  appServer = spawn(serverCommand.command, serverCommand.args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      COCKPIT_DB_PATH: databasePath,
      COCKPIT_EXECUTION_ROOT: executionRoot,
      COCKPIT_MASTER_KEY: masterKey,
      EXECUTION_SMOKE_ENV_MARKER: environmentMarker,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  appServer.stdout.on("data", (chunk) => { serverOutput += chunk.toString(); });
  appServer.stderr.on("data", (chunk) => { serverOutput += chunk.toString(); });
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
      throw new Error(`Execution app exited before readiness.\n${serverOutput}`);
    }
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
    } catch {
      // Next is still compiling.
    }
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error(`Execution app did not become ready.\n${serverOutput}`);
}

async function warmAppRoutes() {
  const missingId = "00000000-0000-4000-8000-000000000000";
  const routes = [
    "/team",
    "/api/providers",
    "/api/providers/verify",
    "/api/skills",
    "/api/agents",
    "/api/agent-templates",
    "/api/projects",
    `/api/projects/${missingId}/workspace`,
    `/api/projects/${missingId}/members`,
    `/api/projects/${missingId}/mission`,
    `/api/projects/${missingId}/tasks`,
    `/api/projects/${missingId}/collaboration`,
    `/api/projects/${missingId}/executions`,
    `/api/projects/${missingId}/audit-events`,
    `/api/projects/${missingId}/validation-policy`,
    `/api/projects/${missingId}/validation-policy/revisions`,
    `/api/executions/${missingId}`,
    `/api/executions/${missingId}/advance`,
    `/api/executions/${missingId}/approvals`,
    `/api/executions/${missingId}/recovery/resolve`,
    `/api/executions/${missingId}/validations`,
  ];
  for (const path of routes) {
    const response = await fetch(`${baseUrl}${path}`).catch(() => null);
    if (response) await response.arrayBuffer();
  }
}

async function restartAppServer() {
  stopAppServer();
  await new Promise((done) => setTimeout(done, 1_000));
  startAppServer();
  await waitForApp();
}

function openDatabase() {
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA busy_timeout=15000");
  return database;
}

function scalar(database, sql, ...parameters) {
  return database.prepare(sql).get(...parameters).value;
}

async function createSkill(page, name, instructions) {
  await page.getByRole("tab", { name: "技能" }).click();
  await page.getByRole("button", { name: "创建新技能" }).click();
  await page.getByLabel("技能名称").fill(name);
  await page.getByLabel("技能说明").fill("Execution smoke private instructions");
  await page.getByLabel("指令正文").fill(instructions);
  await page.getByRole("button", { name: "保存技能" }).click();
  await page.getByRole("heading", { name }).waitFor();
}

async function createAgent(page, name, avatar, skill) {
  await page.getByRole("tab", { name: "Agent" }).click();
  await page.getByRole("button", { name: "创建 Agent" }).click();
  await page.getByLabel("创建方式").selectOption("builder");
  await page.getByLabel("Agent 名称").fill(name);
  await page
    .getByLabel("模型服务", { exact: true })
    .selectOption({ label: "Execution Local Provider" });
  await page.getByRole("checkbox", { name: skill }).check();
  await page.getByLabel("Token 预算").fill("24000");
  await page.getByLabel("接力轮次").fill("8");
  await page.getByLabel("头像文字").fill(avatar);
  await page.getByRole("button", { name: "保存 Agent" }).click();
  await page.getByRole("heading", { name }).waitFor();
}

async function createTeam(page) {
  await page.goto(`${baseUrl}/team`, { waitUntil: "networkidle" });
  const providerTab = page.getByRole("tab", { name: "模型服务" });
  await providerTab.waitFor({ timeout: 60_000 });
  await page.waitForTimeout(750);
  await providerTab.click();
  await page.getByRole("button", { name: "创建模型服务" }).click();
  await page.getByLabel("服务名称").fill("Execution Local Provider");
  await page.getByLabel("Base URL").fill(providerBaseUrl);
  await page.getByLabel("默认模型").fill("execution-model");
  await page.getByLabel("API key").fill(apiKey);
  await page.getByRole("checkbox", { name: /HTTP 会明文传输凭据/ }).check();
  await page.getByRole("button", { name: "验证连接" }).click();
  await page.getByText("已验证模型 execution-model", { exact: true }).waitFor();
  await page.getByRole("button", { name: "保存服务" }).click();
  await createSkill(page, "Alpha Execution Skill", "Alpha private execution instructions.");
  await createSkill(page, "Beta Execution Skill", "Beta private execution instructions.");
  await createAgent(page, "Execution Alpha", "甲", "Alpha Execution Skill");
  await createAgent(page, "Execution Beta", "乙", "Beta Execution Skill");
}

async function createProject(page) {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.getByLabel("项目名称").fill("Execution Smoke Project");
  await page
    .locator("form")
    .filter({ has: page.getByLabel("项目名称") })
    .getByRole("button", { name: "创建项目" })
    .click();
  await page.waitForURL(/\/projects\/[^/]+$/);
  await page.getByRole("heading", { name: "Execution Smoke Project" }).waitFor();
  await page.getByLabel("本地工作区路径").fill(workspaceDirectory);
  await page.getByRole("button", { name: "绑定工作区" }).click();
  await page.getByText("工作区已保存。", { exact: true }).waitFor();
  const members = page.getByRole("group", { name: "平等项目成员" });
  await members.getByRole("checkbox", { name: /Execution Alpha/ }).check();
  await members.getByRole("checkbox", { name: /Execution Beta/ }).check();
  await page.getByRole("button", { name: "保存成员" }).click();
  await page.getByText("项目成员已保存。", { exact: true }).waitFor();
  await page.getByLabel("使命标题").fill("Execution Smoke Mission");
  await page.getByLabel("使命目标").fill("Verify two safe isolated edits");
  await page.getByRole("button", { name: "创建使命" }).click();
  await page.getByRole("heading", { name: "Execution Smoke Mission" }).waitFor();
  return page.evaluate(async () => {
    const project = (await (await fetch("/api/projects")).json()).projects[0];
    const mission = (await (await fetch(`/api/projects/${project.id}/mission`)).json()).mission;
    const agents = (await (await fetch("/api/agents")).json()).agents;
    const threadResponse = await fetch(`/api/projects/${project.id}/threads`, {
      body: JSON.stringify({
        memberAgentIds: agents.map((agent) => agent.id),
        operationId: crypto.randomUUID(),
        title: "Execution smoke thread",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const thread = await threadResponse.json();
    return {
      agents,
      missionId: mission.id,
      projectId: project.id,
      threadId: thread.thread.id,
    };
  });
}

async function grantExecutionPermissions(page, agents) {
  const results = await page.evaluate(async (items) => Promise.all(items.map(async (agent) => {
    const agentId = agent.id;
    const response = await fetch(`/api/agents/${agentId}`, {
      body: JSON.stringify({
        accentToken: agent.accentToken,
        avatarText: agent.avatarText,
        expectedVersion: agent.version,
        maxHandoffs: agent.maxHandoffs,
        maxTokens: agent.maxTokens,
        model: agent.model,
        name: agent.name,
        permissions: { readFiles: true, runCommands: true, writeFiles: true },
        providerId: agent.providerId,
        role: agent.role,
        skillIds: agent.skillIds,
        systemPrompt: agent.systemPrompt,
      }),
      headers: { "content-type": "application/json" },
      method: "PATCH",
    });
    return { body: await response.json(), status: response.status };
  })), agents);
  assert.ok(results.every(({ status }) => status === 200), JSON.stringify(results));
}

async function planExecutableTasks(page, projectId, threadId, firstAgentId) {
  const started = await page.evaluate(async ({ agentId, id, selectedThreadId }) => {
    const response = await fetch(`/api/projects/${id}/threads/${selectedThreadId}/runs`, {
      body: JSON.stringify({
        mentionAgentId: agentId,
        message: "Plan and assign the two independent execution tasks.",
        operationId: crypto.randomUUID(),
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    return { body: await response.json(), status: response.status };
  }, { agentId: firstAgentId, id: projectId, selectedThreadId: threadId });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  const runId = started.body.run.id;
  await page.evaluate(({ id, selectedThreadId, selectedRunId }) => {
    window.history.pushState(
      window.history.state,
      "",
      `/projects/${encodeURIComponent(id)}?thread=${encodeURIComponent(
        selectedThreadId,
      )}&run=${encodeURIComponent(selectedRunId)}`,
    );
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, { id: projectId, selectedRunId: runId, selectedThreadId: threadId });
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const state = await page.evaluate(async ({ id, selectedRunId, selectedThreadId }) => (
      await (
        await fetch(
          `/api/projects/${id}/threads/${selectedThreadId}?run=${selectedRunId}`,
        )
      ).json()
    ), { id: projectId, selectedRunId: runId, selectedThreadId: threadId });
    if (state.selectedRun?.status === "planned") return runId;
    assert.equal(state.selectedRun?.status, "running", JSON.stringify(state));
    await page.evaluate(async ({ id, selectedRunId, selectedThreadId }) => {
      const response = await fetch(
        `/api/projects/${id}/threads/${selectedThreadId}/runs/${selectedRunId}/advance`,
        {
          body: JSON.stringify({ operationId: crypto.randomUUID() }),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      );
      if (!response.ok && response.status !== 409) {
        throw new Error(`Collaboration advance failed: ${await response.text()}`);
      }
    }, { id: projectId, selectedRunId: runId, selectedThreadId: threadId });
    await new Promise((done) => setTimeout(done, 200));
  }
  throw new Error("Public collaboration did not produce a planned execution run.");
}

async function startPlannedExecutions(page, source, workItemCount = 2) {
  return page.evaluate(async ({ count, sourceTuple }) => {
    const id = sourceTuple.projectId;
    const mission = await (await fetch(`/api/projects/${id}/mission`, {
      cache: "no-store",
    })).json();
    return Promise.all(mission.workItems.slice(-count).map(async (workItem) => {
      const response = await fetch(`/api/projects/${id}/executions`, {
        body: JSON.stringify({
          operationId: crypto.randomUUID(),
          source: sourceTuple,
          workItemId: workItem.id,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      return { body: await response.json(), status: response.status };
    }));
  }, { count: workItemCount, sourceTuple: source });
}

async function openRunTab(page) {
  const heading = page.getByRole("heading", { name: "选择并执行" });
  if (await heading.isVisible().catch(() => false)) return;
  const runTab = page.getByRole("tab", { name: "运行详情" });
  await runTab.waitFor();
  await runTab.focus();
  await page.keyboard.press("Enter");
  await heading.waitFor();
}

async function saveStandingPolicy(page) {
  await page.getByRole("button", { name: "管理验证政策" }).focus();
  await page.keyboard.press("Enter");
  await page.getByRole("heading", { name: "验证政策" }).waitFor();
  try {
    await page.getByRole("button", { name: "添加持续批准" }).click({ timeout: 10_000 });
  } catch (error) {
    throw new Error(`${error.message}\n${await page.getByRole("heading", { name: "验证政策" })
      .locator("xpath=..").locator("xpath=..").innerText()}`);
  }
  await page.getByRole("textbox", { name: "可执行文件" }).fill(process.execPath);
  await page.getByRole("textbox", { name: "参数（每行一项）" }).fill("--version");
  await page.getByRole("checkbox", { name: "必需验证" }).check();
  await page.getByRole("checkbox", { name: /hostile OS sandbox/ }).check();
  await page.getByRole("button", { name: "保存验证政策" }).focus();
  await page.keyboard.press("Enter");
  await page.getByText("验证政策已保存为修订 #2。").waitFor();
}

async function waitForDatabase(predicate, label, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const database = openDatabase();
    try {
      if (predicate(database)) return;
    } finally {
      database.close();
    }
    await new Promise((done) => setTimeout(done, 1));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function waitForStatus(page, projectId, status, count = 1) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const state = await page.evaluate(async (id) => {
      return (await (await fetch(`/api/projects/${id}/executions`)).json()).executions;
    }, projectId);
    if (state.filter((item) => item.status === status).length >= count) return state;
    await new Promise((done) => setTimeout(done, 200));
  }
  throw new Error(`Executions did not reach ${status}.`);
}

async function advanceUntilStatus(page, projectId, status, count = 1) {
  const deadline = Date.now() + 90_000;
  let lastState = [];
  while (Date.now() < deadline) {
    lastState = await page.evaluate(async (id) => (
      await (await fetch(`/api/projects/${id}/executions`, { cache: "no-store" })).json()
    ).executions, projectId);
    if (lastState.filter((item) => item.status === status).length >= count) return lastState;
    const approvalDecisions = await page.evaluate(async (executions) => Promise.all(executions
      .filter(({ status: current }) => current === "waiting_approval")
      .map(async (execution) => {
        const approvals = await (
          await fetch(`/api/executions/${execution.id}/approvals?limit=10`, { cache: "no-store" })
        ).json();
        const approval = approvals.items.find(({ kind, status: approvalStatus }) => (
          kind === "command" && approvalStatus === "pending"
        ));
        if (!approval) return { approvals: approvals.items, status: 204 };
        const response = await fetch(
          `/api/executions/${execution.id}/approvals/${approval.id}`,
          {
            body: JSON.stringify({
              action: "approve",
              expectedVersion: execution.version,
              operationId: crypto.randomUUID(),
            }),
            headers: { "content-type": "application/json" },
            method: "POST",
          },
        );
        return { body: await response.json(), status: response.status };
      })), lastState);
    assert.ok(
      approvalDecisions.every(({ status: decisionStatus }) => (
        decisionStatus === 200 || decisionStatus === 204
      )),
      `command approval failed: ${JSON.stringify(approvalDecisions)}`,
    );
    lastState = await page.evaluate(async (id) => (
      await (await fetch(`/api/projects/${id}/executions`, { cache: "no-store" })).json()
    ).executions, projectId);
    const advances = await page.evaluate(async (executions) => Promise.all(executions
      .filter(({ status: current }) => (
        current === "queued" || current === "running" || current === "waiting_approval"
      ))
      .map(async (execution) => {
        const detail = await (
          await fetch(`/api/executions/${execution.id}`, { cache: "no-store" })
        ).json();
        const approvals = detail.execution.status === "waiting_approval"
          ? await (
            await fetch(`/api/executions/${execution.id}/approvals?limit=10`, { cache: "no-store" })
          ).json()
          : null;
        const response = await fetch(`/api/executions/${execution.id}/advance`, {
          body: JSON.stringify({
            expectedVersion: detail.execution.version,
            operationId: crypto.randomUUID(),
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        });
        return {
          body: await response.json(),
          approvals: approvals?.items ?? [],
          priorStatus: detail.execution.status,
          priorVersion: detail.execution.version,
          status: response.status,
        };
      })), lastState);
    assert.ok(
      advances.every(({ priorStatus, status: advanceStatus }) => (
        (advanceStatus >= 200 && advanceStatus < 300)
        || (advanceStatus === 409 && priorStatus !== "waiting_approval")
      )),
      `execution advance failed: ${JSON.stringify(advances)}`,
    );
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`Executions did not reach ${status}: ${JSON.stringify(lastState)}`);
}

async function abandonManualRecovery(page, execution) {
  return page.evaluate(async (current) => {
    const response = await fetch(`/api/executions/${current.id}/recovery/resolve`, {
      body: JSON.stringify({
        action: "abandon",
        expectedVersion: current.version,
        observedManifestHash: current.recovery.observedManifestHash,
        operationId: crypto.randomUUID(),
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    return { body: await response.json(), status: response.status };
  }, execution);
}

function databaseText() {
  const database = openDatabase();
  try {
    const tables = database.prepare(`
      SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'
    `).all().map(({ name }) => name);
    const values = [];
    for (const table of tables) {
      const columns = database.prepare(`PRAGMA table_info("${table}")`).all()
        .filter(({ type }) => String(type).toUpperCase().includes("TEXT"))
        .map(({ name }) => name);
      if (!columns.length) continue;
      const rows = database.prepare(
        `SELECT ${columns.map((name) => `"${name}"`).join(",")} FROM "${table}"`,
      ).all();
      values.push(JSON.stringify(rows));
    }
    return values.join("\n");
  } finally {
    database.close();
  }
}

function counts() {
  const database = openDatabase();
  try {
    const tables = [
      "executions",
      "execution_attempts",
      "execution_actions",
      "execution_operations",
      "execution_model_calls",
      "execution_tool_calls",
      "execution_approvals",
      "execution_validation_results",
      "execution_staged_results",
      "execution_staged_files",
      "execution_events",
      "audit_event_outbox",
      "audit_event_projection",
      "audit_projection_checkpoints",
    ];
    return Object.fromEntries(tables.map((table) => [
      table,
      Number(database.prepare(`SELECT COUNT(*) AS value FROM ${table}`).get().value),
    ]));
  } finally {
    database.close();
  }
}

let browser;
let page;
let desktopFacingText = "";
let narrowFacingText = "";
let narrowAuditFacingText = "";
let approvalCenterFacingText = "";

async function axeScan(state) {
  const scan = await new AxeBuilder({ page }).analyze();
  const blocking = scan.violations
    .filter((violation) => violation.impact === "critical" || violation.impact === "serious")
    .map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      targets: violation.nodes.map((node) => node.target),
    }));
  const contrast = scan.violations
    .filter((violation) => violation.id === "color-contrast")
    .flatMap((violation) => violation.nodes.map((node) => node.target));
  console.log(
    `AXE ${state}: violations=${scan.violations.length} blocking=${blocking.length} [${
      scan.violations
        .map((violation) =>
          `${violation.id}:${violation.impact}@${
            violation.nodes.flatMap((node) => node.target).join("|")
          }`)
        .join(",")
    }]`,
  );
  assert.deepEqual(blocking, [], `${state}: axe critical/serious must be 0`);
  assert.deepEqual(contrast, [], `${state}: WCAG AA color contrast must pass`);
}

// ---- 029 T-04：统一审批中心验收计数与 axe 记录（结果落 evidence results.json） ----
const approvalCenterAcceptance = { assertions: 0, axe: [], matrix: [] };

function acOk(value, message) {
  approvalCenterAcceptance.assertions += 1;
  assert.ok(value, message);
}

function acEqual(actual, expected, message) {
  approvalCenterAcceptance.assertions += 1;
  assert.equal(actual, expected, message);
}

function acDeepEqual(actual, expected, message) {
  approvalCenterAcceptance.assertions += 1;
  assert.deepEqual(actual, expected, message);
}

async function axeApprovalCenter(state) {
  const scan = await new AxeBuilder({ page }).analyze();
  const blocking = scan.violations
    .filter((violation) => violation.impact === "critical" || violation.impact === "serious")
    .map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      targets: violation.nodes.map((node) => node.target),
    }));
  const contrast = scan.violations
    .filter((violation) => violation.id === "color-contrast")
    .flatMap((violation) => violation.nodes.map((node) => node.target));
  approvalCenterAcceptance.axe.push({
    blocking,
    contrast,
    state,
    violationCount: scan.violations.length,
    violations: scan.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact ?? "unknown",
      targets: violation.nodes.flatMap((node) => node.target),
    })),
  });
  assert.deepEqual(blocking, [], `${state}: axe critical/serious must be 0`);
  assert.deepEqual(contrast, [], `${state}: WCAG AA color contrast must pass`);
}

// Readable copy mirror of components/project-context/audit-panel.tsx; unknown
// types fall back to the raw contract value exactly like the panel does.
const AUDIT_EVENT_TYPE_COPY = {
  action_finished: "动作已完成",
  action_queued: "动作已排队",
  approval_decided: "审批已决定",
  approval_requested: "审批已请求",
  attempt_started: "尝试已开始",
  conflict_detected: "检测到冲突",
  control_applied: "控制操作已应用",
  execution_created: "执行已创建",
  merged: "执行已合入",
  stale_detected: "检测到上下文过期",
  status_changed: "状态已变更",
  tool_failed: "工具调用失败",
  tool_requested: "工具已请求",
  tool_succeeded: "工具调用成功",
  usage_recorded: "用量已记录",
};
try {
  await listen(provider, providerPort);
  assert.ok(
    existsSync(resolve(".next", "BUILD_ID")),
    "Run `npm run build` before the execution smoke.",
  );
  startAppServer();
  await waitForApp();
  await warmAppRoutes();
  browser = await chromium.launch({
    headless: true,
    ...(browserExecutable ? { executablePath: browserExecutable } : {}),
  });
  const browserContext = await browser.newContext({
    viewport: { height: 1100, width: 1600 },
  });
  page = await browserContext.newPage();
  page.setDefaultTimeout(60_000);
  page.on("response", async (response) => {
    if (response.url().startsWith(baseUrl) && response.url().includes("/api/")) {
      apiBodies.push(await response.text().catch(() => ""));
    }
  });
  page.on("request", (request) => {
    if (request.url().includes("/api/executions/") && request.url().endsWith("/advance")) {
      advanceRequests.push({ body: request.postData(), url: request.url() });
    }
  });

  await createTeam(page);
  const context = await createProject(page);
  const alpha = context.agents.find(({ name }) => name === "Execution Alpha");
  const beta = context.agents.find(({ name }) => name === "Execution Beta");
  assert.ok(alpha?.id && beta?.id && alpha.id !== beta.id);
  alphaAgentId = alpha.id;
  betaAgentId = beta.id;
  await grantExecutionPermissions(page, [alpha, beta]);
  await openRunTab(page);
  await saveStandingPolicy(page);
  const sourceRunId = await planExecutableTasks(
    page,
    context.projectId,
    context.threadId,
    alpha.id,
  );
  const source = {
    projectId: context.projectId,
    runId: sourceRunId,
    threadId: context.threadId,
  };
  await page.reload({ waitUntil: "networkidle" });
  await openRunTab(page);
  const startRequests = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST"
      && /\/api\/projects\/[^/]+\/executions$/u.test(new URL(request.url()).pathname)
    ) {
      startRequests.push({
        body: request.postData(),
        input: JSON.parse(request.postData()),
        url: request.url(),
      });
    }
  });

  const startStatuses = await page.evaluate(async ({ projectId, sourceTuple }) => {
    const mission = await (await fetch(`/api/projects/${projectId}/mission`)).json();
    return Promise.all(mission.workItems.map(async (workItem) => {
      const response = await fetch(`/api/projects/${projectId}/executions`, {
        body: JSON.stringify({
          operationId: crypto.randomUUID(),
          source: sourceTuple,
          workItemId: workItem.id,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      return response.status;
    }));
  }, { projectId: context.projectId, sourceTuple: source });
  assert.deepEqual(startStatuses, [201, 201]);
  try {
    await waitForDatabase(
      (database) => Number(scalar(database, "SELECT COUNT(*) AS value FROM executions")) === 2,
      "two start contracts",
      15_000,
    );
  } catch (error) {
    throw new Error(
      `${error.message}\nAPI: ${apiBodies.slice(-8).join("\n")}`
      + `\nSERVER: ${serverOutput}`,
    );
  }
  assert.equal(startRequests.length, 2, "the harness must issue two public start requests");
  const publicExecutions = await page.evaluate(async (projectId) => {
    return (await (await fetch(`/api/projects/${projectId}/executions`)).json()).executions;
  }, context.projectId);
  const starts = publicExecutions.map((execution) => {
    const request = startRequests.find(({ input }) => input.workItemId === execution.workItem.id);
    assert.ok(request, `missing public start request for ${execution.workItem.title}`);
    const database = openDatabase();
    try {
      const attempt = database.prepare(`
        SELECT sandbox_root AS sandboxRoot FROM execution_attempts
        WHERE execution_id=? AND attempt_no=?
      `).get(execution.id, execution.attemptNo);
      return {
        executionId: execution.id,
        operationId: request.input.operationId,
        requestBody: request.body,
        sandboxRoot: attempt.sandboxRoot,
        url: request.url,
        workItem: execution.workItem,
      };
    } finally {
      database.close();
    }
  });
  assert.equal(starts.length, 2, "two public start operations must create executions");
  assert.equal(readFileSync(join(workspaceDirectory, "src", "canonical.txt"), "utf8"), "canonical-before\n");
  assert.equal(existsSync(join(workspaceDirectory, "src", "alpha.txt")), false);
  assert.equal(existsSync(join(workspaceDirectory, "src", "beta.txt")), false);
  const queuedAdvances = await page.evaluate(async (projectId) => {
    const list = await (await fetch(`/api/projects/${projectId}/executions`)).json();
    return Promise.all(list.executions.filter(({ status }) => status === "queued").map(async (execution) => {
      const response = await fetch(`/api/executions/${execution.id}/advance`, {
        body: JSON.stringify({
          expectedVersion: execution.version,
          operationId: crypto.randomUUID(),
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      return response.status;
    }));
  }, context.projectId);
  assert.ok(queuedAdvances.every((status) => (status >= 200 && status < 300) || status === 409));

  try {
    await waitForDatabase(
      () => maxConcurrentProviderCalls === 2,
      "concurrent model calls",
    );
  } catch (error) {
    const diagnosticDatabase = openDatabase();
    try {
      throw new Error(`${error.message}; got ${maxConcurrentProviderCalls}. `
        + `Executions=${JSON.stringify(diagnosticDatabase.prepare(
          "SELECT id,status,reason_code AS reasonCode,version FROM executions",
        ).all())} Calls=${JSON.stringify(diagnosticDatabase.prepare(
          "SELECT status,error_category AS errorCategory FROM execution_model_calls",
        ).all())} Provider=${JSON.stringify(providerCaptures.map(({ method, url }) => ({ method, url })))} `
        + `Logs=${serverOutput}`);
    } finally {
      diagnosticDatabase.close();
    }
  }
  try {
    await waitForDatabase(
      (database) => Number(scalar(database, `
        SELECT COUNT(*) AS value FROM execution_model_calls WHERE status='succeeded'
      `)) >= 2,
      "completed first concurrent model calls",
    );
  } catch (error) {
    const diagnosticDatabase = openDatabase();
    try {
      throw new Error(`${error.message}. Calls=${JSON.stringify(diagnosticDatabase.prepare(
        "SELECT status,error_category AS errorCategory FROM execution_model_calls",
      ).all())} Executions=${JSON.stringify(diagnosticDatabase.prepare(
        "SELECT status,reason_code AS reasonCode,version FROM executions",
      ).all())} ProviderCaptures=${providerCaptures.length} ModelSteps=${JSON.stringify([...modelSteps])} Logs=${serverOutput}`);
    } finally {
      diagnosticDatabase.close();
    }
  }
  assert.equal(new Set(starts.map(({ sandboxRoot }) => realpathSync(sandboxRoot))).size, 2);

  const providerBeforeReplay = providerCaptures.length;
  const executionCountBeforeReplay = starts.length;
  const replay = await page.evaluate(async ({ body, url }) => {
    const response = await fetch(url, {
      body,
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    return { body: await response.json(), status: response.status };
  }, { body: starts[0].requestBody, url: starts[0].url });
  assert.equal(replay.status, 201, `start operation replay failed: ${JSON.stringify(replay.body)}`);
  assert.equal(starts.length, executionCountBeforeReplay);
  assert.equal(replay.body.execution.id, starts[0].executionId);
  assert.equal(providerCaptures.length, providerBeforeReplay);
  console.log("OPERATION REPLAY PASS: exact operation replay added no provider call or duplicate action");
  await page.reload({ waitUntil: "networkidle" });
  await openRunTab(page);

  const alphaExecution = starts.find(({ workItem }) => workItem.title.includes("Alpha"));
  const betaExecution = starts.find(({ workItem }) => workItem.title.includes("Beta"));
  assert.ok(alphaExecution && betaExecution);

  try {
    await waitForDatabase(
      (database) => Number(scalar(database, `
        SELECT COUNT(*) AS value FROM execution_approvals WHERE kind='command' AND status='pending'
      `)) === 1,
      "one-shot approval",
      30_000,
    );
  } catch (error) {
    const diagnosticDatabase = openDatabase();
    try {
      throw new Error(`${error.message} Executions=${JSON.stringify(diagnosticDatabase.prepare(
        "SELECT id,status,reason_code AS reasonCode,business_round_count AS rounds,tool_call_count AS tools FROM executions",
      ).all())} Actions=${JSON.stringify(diagnosticDatabase.prepare(
        "SELECT execution_id AS executionId,kind,status,error_code AS errorCode,result_json AS result FROM execution_actions",
      ).all())} ProviderCaptures=${providerCaptures.length} ModelSteps=${JSON.stringify([...modelSteps])}`);
    } finally {
      diagnosticDatabase.close();
    }
  }
  // ---- APPROVAL CENTER ACCEPTANCE (feature 029 T-04, desktop light key path) ----
  // 真实造数已就位：Beta 一次性命令审批待决（执行域）+ 首个规划轮 proposal 块待决
  // （内联决策域，由 provider 在 collaborationAction step 0 emit）。本段经真实浏览器
  // 在「审批」tab 完成呈现断言与批准/拒绝裁决，替代原裸 API 批准步骤（裁决仍落既
  // 有域路由——UI 分派零新写路径）。
  const acBaseline = await page.evaluate(async (projectId) => {
    const response = await fetch(`/api/projects/${projectId}/approvals/pending`, { cache: "no-store" });
    return { body: await response.json(), status: response.status };
  }, context.projectId);
  acEqual(acBaseline.status, 200, `center API must respond 200: ${JSON.stringify(acBaseline.body)}`);
  acEqual(acBaseline.body.approvals.length, 2, "center must list the execution approval and the proposal");
  const [acFirst, acSecond] = acBaseline.body.approvals;
  acEqual(acFirst.domain, "execution", "newest item must be the execution approval");
  acEqual(acFirst.kind, "command", "execution item must be the one-shot command approval");
  acEqual(acFirst.status, "pending", "execution approval must be pending");
  acEqual(acFirst.decisionHint, null, "a pending approval must stay decidable");
  acEqual(
    acFirst.sourceRef.executionId,
    betaExecution.executionId,
    "the approval must reference the Beta execution",
  );
  acOk(
    typeof acFirst.title === "string" && acFirst.title.endsWith("--help"),
    "command title must summarize executable and args",
  );
  acEqual(acSecond.domain, "inline_decision", "the second item must be the inline decision proposal");
  acEqual(acSecond.kind, "proposal", "the inline item must be a proposal");
  acEqual(acSecond.title, "Approval Center Proposal", "proposal title must come from the block payload");
  const acProposalRef = {
    blockId: acSecond.approvalId,
    messageId: acSecond.sourceRef.messageId,
    runId: acSecond.sourceRef.runId,
    threadId: acSecond.sourceRef.threadId,
  };
  const acExecutionApprovalId = acFirst.approvalId;
  const acCenterApiText = JSON.stringify(acBaseline.body);
  for (const value of [
    apiKey,
    masterKey,
    rawProviderMarker,
    chainOfThoughtMarker,
    environmentMarker,
    temporaryDirectory,
    "Authorization:",
  ]) {
    acOk(!acCenterApiText.includes(value), "center API payload must not leak forbidden markers");
  }

  const acPanel = page.locator(".cockpit-context");
  await axeApprovalCenter("desktop light memory tab baseline before approval center");
  const acMemoryTab = acPanel.getByRole("tab", { name: "共享记忆" });
  await acMemoryTab.focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  const acTab = acPanel.getByRole("tab", { name: "审批" });
  acEqual(await acTab.getAttribute("aria-selected"), "true", "ArrowRight x3 must select the approval tab");
  acOk(
    await acTab.evaluate((element) => document.activeElement === element),
    "tablist keyboard selection must focus the approval tab",
  );
  const acList = acPanel.getByRole("list", { name: "待裁决请求" });
  await acList.waitFor();
  const acItems = acList.locator("> li");
  acEqual(await acItems.count(), 2, "approval center must render both pending items");
  const acExecutionItem = acItems.nth(0);
  const acProposalItem = acItems.nth(1);
  acOk(
    ((await acExecutionItem.locator("h3").textContent()) ?? "").includes("--help"),
    "execution item title must render the command summary",
  );
  acEqual(
    await acExecutionItem.getByText("执行", { exact: true }).count(),
    1,
    "execution item must carry the execution domain badge",
  );
  acEqual(
    await acExecutionItem.getByText("待裁决", { exact: true }).count(),
    1,
    "execution item must carry the pending status badge",
  );
  acEqual(
    await acExecutionItem.getByText("命令", { exact: true }).count(),
    1,
    "execution item must carry the command kind copy",
  );
  acOk(
    ((await acExecutionItem.textContent()) ?? "").includes("Exercise one exact one-shot approval."),
    "execution item must render the public impact summary",
  );
  acEqual(
    await acProposalItem.locator("h3").textContent(),
    "Approval Center Proposal",
    "proposal item must render the block title",
  );
  acEqual(
    await acProposalItem.getByText("内联决策", { exact: true }).count(),
    1,
    "proposal item must carry the inline decision domain badge",
  );
  acOk(
    ((await acProposalItem.textContent()) ?? "").includes("Decide the unified approval center end to end."),
    "proposal item must render the block body summary",
  );
  const acProposalLink = acProposalItem.getByRole("link", { name: "查看来源消息" });
  const acProposalHref = (await acProposalLink.getAttribute("href")) ?? "";
  acOk(
    acProposalHref.includes(`thread=${acProposalRef.threadId}`)
      && acProposalHref.includes(`run=${acProposalRef.runId}`),
    "proposal source link must carry the canonical thread/run identity",
  );
  const acProposalLinkBox = await acProposalLink.boundingBox();
  acOk(
    acProposalLinkBox && acProposalLinkBox.height >= 44,
    "the source link must be at least 44px tall",
  );

  // 来源定位（鼠标路径）：焦点真实落到执行卡标题。先钉住执行卡渲染，
  // 消除 context 面板与运行详情列表的加载竞态。
  await page.getByRole("region", { name: "Implement Beta file" }).waitFor();
  await acExecutionItem.getByRole("button", { name: "定位来源执行" }).click();
  await acPanel.getByText("已定位到来源执行。", { exact: true }).waitFor();
  acEqual(
    await page.evaluate(() => document.activeElement?.id ?? ""),
    `execution-${betaExecution.executionId}-title`,
    "locate source must move focus to the rendered execution card title",
  );

  acDeepEqual(
    await acPanel.locator(".approval-center-panel").getByRole("button").evaluateAll((buttons) =>
      buttons
        .map((button) => {
          const rect = button.getBoundingClientRect();
          return {
            height: rect.height,
            label: button.getAttribute("aria-label") ?? button.textContent?.trim() ?? "",
            width: rect.width,
          };
        })
        .filter(({ height, width }) => height < 44 || width < 44),
    ),
    [],
    "approval center buttons must be at least 44x44px",
  );
  await axeApprovalCenter("desktop light approval center pending list");
  approvalCenterAcceptance.matrix.push("desktop-light");
  await page.screenshot({ fullPage: true, path: approvalCenterDesktopScreenshot });

  // 键盘裁决（批准）：tab → 刷新列表 → 批准 → Enter。
  await acTab.focus();
  await page.keyboard.press("Tab");
  const acRefresh = acPanel.getByRole("button", { name: "刷新列表" });
  acOk(
    await acRefresh.evaluate((element) => document.activeElement === element),
    "Tab from the approval tab must reach the refresh button",
  );
  await page.keyboard.press("Tab");
  const acApprove = acExecutionItem.getByRole("button", { name: /^批准 .+--help$/u });
  acOk(
    await acApprove.evaluate((element) => document.activeElement === element),
    "the second Tab must reach the execution approve button",
  );
  acOk(
    await acApprove.evaluate(
      (element) =>
        element.matches(":focus-visible")
        && getComputedStyle(element).boxShadow !== "none",
    ),
    "the keyboard-focused approve button must show a visible focus ring",
  );
  await page.keyboard.press("Enter");
  await acPanel.getByText("已批准，列表已刷新。", { exact: true }).waitFor();
  // 通知先于静默重取发出，钉住列表收缩后再断言，消除 notice/refresh 竞态。
  await page.waitForFunction(
    () => document.querySelectorAll(".approval-center-list > li").length === 1,
  );
  acEqual(await acItems.count(), 1, "the approved execution approval must leave the center list");
  acEqual(
    await acPanel.getByText(/--help/u).count(),
    0,
    "the approved item must not render anymore",
  );

  // 键盘裁决（拒绝）：刷新列表 → 批准 → 拒绝 → Enter。
  await acTab.focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  const acReject = acPanel.getByRole("button", { name: "拒绝 Approval Center Proposal" });
  acOk(
    await acReject.evaluate((element) => document.activeElement === element),
    "Tab x3 must reach the proposal reject button",
  );
  await page.keyboard.press("Enter");
  await acPanel.getByText("已拒绝，列表已刷新。", { exact: true }).waitFor();
  await acPanel.getByText("没有待裁决的请求。", { exact: true }).waitFor();
  acEqual(await acList.count(), 0, "a fully decided center must collapse to the empty state");

  const acDecisionTruth = await page.evaluate(
    async ({ approvalId, executionId, projectId, ref }) => {
      const center = await (
        await fetch(`/api/projects/${projectId}/approvals/pending`, { cache: "no-store" })
      ).json();
      const block = await (
        await fetch(
          `/api/projects/${projectId}/threads/${ref.threadId}/runs/${ref.runId}`
            + `/messages/${ref.messageId}/blocks/${ref.blockId}`,
          { cache: "no-store" },
        )
      ).json();
      const approvals = await (
        await fetch(`/api/executions/${executionId}/approvals?limit=10`, { cache: "no-store" })
      ).json();
      return {
        blockState: block.block.state,
        centerCount: center.approvals.length,
        executionApproval: approvals.items.find((item) => item.id === approvalId),
      };
    },
    {
      approvalId: acExecutionApprovalId,
      executionId: betaExecution.executionId,
      projectId: context.projectId,
      ref: acProposalRef,
    },
  );
  acEqual(acDecisionTruth.centerCount, 0, "center API must be empty after both decisions");
  acEqual(
    acDecisionTruth.executionApproval?.status,
    "approved",
    "the domain route must record the approval verdict",
  );
  acEqual(acDecisionTruth.blockState?.status, "rejected", "the proposal block must settle rejected");
  acEqual(acDecisionTruth.blockState?.stateVersion, 2, "the proposal block must advance one state version");
  console.log(
    "APPROVAL CENTER DECISION PASS: keyboard approve/reject dispatched to domain routes, both items delisted",
  );

  await page.reload({ waitUntil: "networkidle" });
  await openRunTab(page);

  await advanceUntilStatus(page, context.projectId, "staged", 2);
  // 029 T-04 续跑证据：中心批准的命令在 advance 中被消费，Beta 推进到 staged。
  const acContinuation = await page.evaluate(
    async ({ approvalId, executionId }) => {
      const detail = await (
        await fetch(`/api/executions/${executionId}`, { cache: "no-store" })
      ).json();
      const approvals = await (
        await fetch(`/api/executions/${executionId}/approvals?limit=10`, { cache: "no-store" })
      ).json();
      return {
        approvalStatus: approvals.items.find((item) => item.id === approvalId)?.status,
        executionStatus: detail.execution.status,
      };
    },
    { approvalId: acExecutionApprovalId, executionId: betaExecution.executionId },
  );
  acEqual(
    acContinuation.approvalStatus,
    "consumed",
    "the approved command must be consumed by the execution flow",
  );
  acEqual(
    acContinuation.executionStatus,
    "staged",
    "the Beta execution must advance to staged after the center decision",
  );
  assert.equal(existsSync(join(workspaceDirectory, "src", "alpha.txt")), false);
  assert.equal(existsSync(join(workspaceDirectory, "src", "beta.txt")), false);
  await page.reload({ waitUntil: "networkidle" });
  await openRunTab(page);
  // 029 T-04 运行详情证据：执行卡状态从「等待审批」推进为「变更待审阅」。
  await page
    .getByRole("region", { name: "Implement Beta file" })
    .getByText("变更待审阅", { exact: true })
    .waitFor();
  const mergeResult = await page.evaluate(async (executionId) => {
    const detail = await (
      await fetch(`/api/executions/${executionId}`, { cache: "no-store" })
    ).json();
    const response = await fetch(`/api/executions/${executionId}/merge`, {
      body: JSON.stringify({
        expectedVersion: detail.execution.version,
        operationId: crypto.randomUUID(),
        stagedHash: detail.staged.stagedHash,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    return { body: await response.json(), execution: detail.execution, status: response.status };
  }, betaExecution.executionId);
  assert.equal(mergeResult.status, 200, JSON.stringify(mergeResult));
  assert.equal(mergeResult.body.execution.status, "merged");
  await page.reload({ waitUntil: "networkidle" });
  await openRunTab(page);
  const betaCard = page.getByRole("region", { name: "Implement Beta file" });
  await betaCard.getByText("已合入").waitFor();
  assert.equal(existsSync(join(workspaceDirectory, "src", "alpha.txt")), false);
  assert.equal(readFileSync(join(workspaceDirectory, "src", "beta.txt"), "utf8"), "beta isolated edit\n");
  console.log("MERGE PASS: public merge changed only the selected nonoverlapping canonical path");

  const staleResult = await page.evaluate(async ({ executionId, missionId, projectId }) => {
    const missionState = await (await fetch(`/api/projects/${projectId}/mission`)).json();
    const mission = missionState.mission;
    const changed = await fetch(`/api/missions/${missionId}`, {
      body: JSON.stringify({
        expectedVersion: mission.version,
        goal: `${mission.goal} (changed after stage)`,
        title: mission.title,
      }),
      headers: { "content-type": "application/json" },
      method: "PATCH",
    });
    const detail = await (await fetch(`/api/executions/${executionId}`)).json();
    const response = await fetch(`/api/executions/${executionId}/merge`, {
      body: JSON.stringify({
        expectedVersion: detail.execution.version,
        operationId: crypto.randomUUID(),
        stagedHash: detail.staged.stagedHash,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const latest = await (await fetch(`/api/executions/${executionId}`, {
      cache: "no-store",
    })).json();
    return {
      body: await response.json(),
      changedStatus: changed.status,
      execution: latest.execution,
      status: response.status,
    };
  }, {
    executionId: alphaExecution.executionId,
    missionId: context.missionId,
    projectId: context.projectId,
  });
  assert.equal(staleResult.changedStatus, 200);
  assert.equal(staleResult.status, 409);
  assert.equal(staleResult.execution.status, "stale");
  console.log("STALE PASS: public mission mutation invalidated the remaining staged execution");

  collaborationStep = 0;
  executionPhase = "conflict";
  modelSteps.clear();
  const conflictRunId = await planExecutableTasks(
    page,
    context.projectId,
    context.threadId,
    alpha.id,
  );
  const conflictStarts = await startPlannedExecutions(page, {
    projectId: context.projectId,
    runId: conflictRunId,
    threadId: context.threadId,
  });
  assert.equal(conflictStarts.filter(({ status }) => status === 201).length, 2);
  await advanceUntilStatus(page, context.projectId, "conflicted", 2);
  const conflicted = await page.evaluate(async (projectId) => (
    await (await fetch(`/api/projects/${projectId}/executions`, { cache: "no-store" })).json()
  ).executions.filter(({ status }) => status === "conflicted"), context.projectId);
  assert.equal(conflicted.length, 2);
  assert.ok(conflicted.every(({ manualRecoveryRequired }) => !manualRecoveryRequired));
  console.log("CONFLICT PASS: two public executions staged the same path and both conflicted");

  collaborationStep = 0;
  executionPhase = "manual";
  modelSteps.clear();
  const manualRunId = await planExecutableTasks(
    page,
    context.projectId,
    context.threadId,
    alpha.id,
  );
  const manualStarts = await startPlannedExecutions(page, {
    projectId: context.projectId,
    runId: manualRunId,
    threadId: context.threadId,
  }, 1);
  assert.equal(manualStarts.length, 1);
  assert.equal(manualStarts[0].status, 201, JSON.stringify(manualStarts[0].body));
  const manualExecutionId = manualStarts[0].body.execution.id;
  await advanceUntilStatus(page, context.projectId, "staged", 1);
  const manualDetail = await page.evaluate(async (executionId) => (
    await (await fetch(`/api/executions/${executionId}`, { cache: "no-store" })).json()
  ), manualExecutionId);
  assert.equal(manualDetail.execution.status, "staged");
  const faultProcess = spawn(process.execPath, [
    "-e",
    `const fs=require("node:fs");
const [watchPath,targetPath]=process.argv.slice(1);
const deadline=Date.now()+30000;
while(Date.now()<deadline){
  if(fs.existsSync(watchPath)){
    fs.writeFileSync(targetPath,"external writer won\\n");
    process.exit(0);
  }
}
process.exit(2);`,
    join(workspaceDirectory, "src", "manual-00.txt"),
    join(workspaceDirectory, "src", "manual-09.txt"),
  ], { stdio: "ignore", windowsHide: true });
  const faultCompleted = new Promise((resolveFault, rejectFault) => {
    faultProcess.once("error", rejectFault);
    faultProcess.once("exit", (code) => (
      code === 0 ? resolveFault() : rejectFault(new Error(`Merge fault injector exited ${code}.`))
    ));
  });
  const manualMerge = page.evaluate(async ({ executionId, stagedHash, version }) => {
    const response = await fetch(`/api/executions/${executionId}/merge`, {
      body: JSON.stringify({
        expectedVersion: version,
        operationId: crypto.randomUUID(),
        stagedHash,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    return { body: await response.json(), status: response.status };
  }, {
    executionId: manualExecutionId,
    stagedHash: manualDetail.staged.stagedHash,
    version: manualDetail.execution.version,
  });
  await faultCompleted;
  const manualMergeResult = await manualMerge;
  assert.equal(manualMergeResult.status, 409, JSON.stringify(manualMergeResult.body));
  assert.equal(manualMergeResult.body.error.code, "MANUAL_RECOVERY_REQUIRED");
  const recoveryDetailResult = await page.evaluate(async (executionId) => {
    const response = await fetch(`/api/executions/${executionId}`, { cache: "no-store" });
    return { body: await response.json(), status: response.status };
  }, manualExecutionId);
  assert.equal(
    recoveryDetailResult.status,
    200,
    `manual recovery detail unavailable: ${JSON.stringify(recoveryDetailResult.body)}`,
  );
  const recoveryDetail = recoveryDetailResult.body;
  assert.equal(recoveryDetail.execution.manualRecoveryRequired, true);
  assert.equal(recoveryDetail.recovery.required, true);
  const recoveryFiles = await page.evaluate(async (executionId) => {
    const response = await fetch(
      `/api/executions/${executionId}/recovery/files?limit=20`,
      { cache: "no-store" },
    );
    return { body: await response.json(), status: response.status };
  }, manualExecutionId);
  assert.equal(
    recoveryFiles.status,
    200,
    `${JSON.stringify(recoveryFiles.body)} server=${serverOutput}`,
  );
  assert.equal(recoveryFiles.body.items.length, 10);
  assert.equal(recoveryFiles.body.nextCursor, null);
  assert.ok(recoveryFiles.body.items.some(({ status }) => status === "temp_ready"));
  console.log("RECOVERY FILE PASS: public pagination preserved the durable temp_ready state");
  await restartAppServer();
  await page.goto(`${baseUrl}/?manual-restart=${Date.now()}`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Execution Smoke Mission" }).waitFor();
  const persistedRecovery = await page.evaluate(async (executionId) => {
    const response = await fetch(`/api/executions/${executionId}`, { cache: "no-store" });
    return { body: await response.json(), status: response.status };
  }, manualExecutionId);
  assert.equal(persistedRecovery.status, 200, JSON.stringify(persistedRecovery.body));
  assert.equal(persistedRecovery.body.recovery.required, true);
  assert.equal(
    persistedRecovery.body.recovery.observedManifestHash,
    recoveryDetail.recovery.observedManifestHash,
  );
  console.log("RECOVERY PERSISTENCE PASS: detail tuple and paged files survived process restart");
  const resolution = await abandonManualRecovery(page, {
    ...persistedRecovery.body.execution,
    recovery: persistedRecovery.body.recovery,
  });
  assert.equal(resolution.status, 200, JSON.stringify(resolution.body));
  assert.equal(resolution.body.execution.status, "stopped");
  console.log("MANUAL RECOVERY PASS: external merge race entered the public barrier and abandon resolved it");

  await page.reload({ waitUntil: "networkidle" });
  await openRunTab(page);
  await page.getByText("已过期").waitFor();
  await restartAppServer();
  await page.goto(`${baseUrl}/?restart=${Date.now()}`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Execution Smoke Mission" }).waitFor();
  await openRunTab(page);
  await page.getByText("已过期").waitFor();

  // ---- APPROVAL CENTER ACCEPTANCE (feature 029 T-04, lapsed presentation) ----
  // 真实失效造数：新规划轮启动一个 Beta 执行至 waiting_approval（一次性命令审批
  // 待决），公开路由改使命目标使 frozen input 漂移，advance 触发域内失败关闭——
  // 执行 stale、开放审批 expired（与 stop/stale 路径共用的同一写缝），零手改 DB。
  collaborationStep = 0;
  executionPhase = "lapsed";
  modelSteps.clear();
  const lapsedRunId = await planExecutableTasks(
    page,
    context.projectId,
    context.threadId,
    alpha.id,
  );
  const lapsedStarts = await startPlannedExecutions(page, {
    projectId: context.projectId,
    runId: lapsedRunId,
    threadId: context.threadId,
  }, 1);
  assert.equal(lapsedStarts.length, 1);
  assert.equal(lapsedStarts[0].status, 201, JSON.stringify(lapsedStarts[0].body));
  const lapsedExecutionId = lapsedStarts[0].body.execution.id;
  const lapsedDeadline = Date.now() + 90_000;
  let lapsedDetail;
  while (Date.now() < lapsedDeadline) {
    lapsedDetail = await page.evaluate(async (executionId) => (
      await (await fetch(`/api/executions/${executionId}`, { cache: "no-store" })).json()
    ), lapsedExecutionId);
    if (lapsedDetail.execution.status === "waiting_approval") break;
    assert.ok(
      ["queued", "running"].includes(lapsedDetail.execution.status),
      `lapsed-fixture execution must stay advanceable: ${JSON.stringify(lapsedDetail.execution)}`,
    );
    const lapsedAdvance = await page.evaluate(
      async ({ executionId, version }) => {
        const response = await fetch(`/api/executions/${executionId}/advance`, {
          body: JSON.stringify({
            expectedVersion: version,
            operationId: crypto.randomUUID(),
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        });
        return { body: await response.json(), status: response.status };
      },
      { executionId: lapsedExecutionId, version: lapsedDetail.execution.version },
    );
    assert.ok(
      (lapsedAdvance.status >= 200 && lapsedAdvance.status < 300) || lapsedAdvance.status === 409,
      `lapsed-fixture advance failed: ${JSON.stringify(lapsedAdvance.body)}`,
    );
    await new Promise((done) => setTimeout(done, 200));
  }
  assert.equal(
    lapsedDetail?.execution.status,
    "waiting_approval",
    "lapsed fixture must reach waiting_approval",
  );

  const lapsedOutcome = await page.evaluate(
    async ({ executionId, projectId }) => {
      const missionState = await (
        await fetch(`/api/projects/${projectId}/mission`, { cache: "no-store" })
      ).json();
      const mission = missionState.mission;
      const changed = await fetch(`/api/missions/${mission.id}`, {
        body: JSON.stringify({
          expectedVersion: mission.version,
          goal: `${mission.goal} (approval expires)`,
          title: mission.title,
        }),
        headers: { "content-type": "application/json" },
        method: "PATCH",
      });
      const before = await (
        await fetch(`/api/executions/${executionId}`, { cache: "no-store" })
      ).json();
      const advance = await fetch(`/api/executions/${executionId}/advance`, {
        body: JSON.stringify({
          expectedVersion: before.execution.version,
          operationId: crypto.randomUUID(),
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const advanceBody = await advance.json();
      const after = await (
        await fetch(`/api/executions/${executionId}`, { cache: "no-store" })
      ).json();
      const approvals = await (
        await fetch(`/api/executions/${executionId}/approvals?limit=10`, { cache: "no-store" })
      ).json();
      return {
        advanceBody,
        advanceStatus: advance.status,
        approvalStatus: approvals.items.find((item) => item.kind === "command")?.status,
        changedStatus: changed.status,
        executionStatus: after.execution.status,
      };
    },
    { executionId: lapsedExecutionId, projectId: context.projectId },
  );
  acEqual(lapsedOutcome.changedStatus, 200, "the mission goal change must succeed");
  acEqual(lapsedOutcome.advanceStatus, 409, "advancing a stale execution must fail closed");
  acEqual(
    lapsedOutcome.advanceBody?.error?.code,
    "STALE_EXECUTION",
    "the stale advance must carry the sanitized code",
  );
  acEqual(lapsedOutcome.executionStatus, "stale", "the execution must settle stale");
  acEqual(
    lapsedOutcome.approvalStatus,
    "expired",
    "the open approval must expire with the stale transition",
  );

  const acLapsed = await page.evaluate(async (projectId) => {
    const response = await fetch(`/api/projects/${projectId}/approvals/pending`, { cache: "no-store" });
    return { body: await response.json(), status: response.status };
  }, context.projectId);
  acEqual(acLapsed.status, 200, `center API must respond 200: ${JSON.stringify(acLapsed.body)}`);
  acEqual(acLapsed.body.approvals.length, 1, "the center must list exactly the lapsed approval");
  acEqual(acLapsed.body.approvals[0].status, "expired", "the lapsed item must map the expired status");
  acEqual(
    acLapsed.body.approvals[0].decisionHint,
    "expired",
    "the lapsed item must carry the expired decision hint",
  );
  acEqual(
    acLapsed.body.approvals[0].sourceRef.executionId,
    lapsedExecutionId,
    "the lapsed item must reference the stale execution",
  );

  await page.reload({ waitUntil: "networkidle" });
  await openRunTab(page);
  const acLapsedPanel = page.locator(".cockpit-context");
  const acLapsedTab = acLapsedPanel.getByRole("tab", { name: "审批" });
  await acLapsedTab.click();
  const acLapsedList = acLapsedPanel.getByRole("list", { name: "待裁决请求" });
  await acLapsedList.waitFor();
  const acLapsedItem = acLapsedList.locator("> li").nth(0);
  acEqual(await acLapsedList.locator("> li").count(), 1, "the center must render exactly the lapsed item");
  acEqual(
    await acLapsedItem.getByText("已过期", { exact: true }).count(),
    1,
    "the lapsed status badge must render",
  );
  await acLapsedItem.getByText("无法裁决：请求已过期。", { exact: true }).waitFor();
  acEqual(
    await acLapsedItem.getByRole("button", { name: /^批准 /u }).count(),
    0,
    "the lapsed item must not render an approve button",
  );
  acEqual(
    await acLapsedItem.getByRole("button", { name: /^拒绝 /u }).count(),
    0,
    "the lapsed item must not render a reject button",
  );
  const acLapsedLocate = acLapsedItem.getByRole("button", { name: "定位来源执行" });
  const acLapsedLocateBox = await acLapsedLocate.boundingBox();
  acOk(
    acLapsedLocateBox && acLapsedLocateBox.height >= 44 && acLapsedLocateBox.width >= 44,
    "the lapsed locate button must be at least 44x44",
  );
  const acLapsedTabBox = await acLapsedTab.boundingBox();
  acOk(
    acLapsedTabBox && acLapsedTabBox.height >= 44 && acLapsedTabBox.width >= 44,
    "the approval tab must be at least 44x44",
  );
  await axeApprovalCenter("desktop light approval center lapsed item");
  await page.screenshot({ fullPage: true, path: approvalCenterLapsedScreenshot });
  approvalCenterFacingText = await page.locator("html").innerText();

  // 暗色桌面关键路径复核：失效呈现与 axe。
  await page.getByRole("button", { name: /切换到暗色主题/u }).click();
  await page.getByRole("button", { name: /切换到明色主题/u }).waitFor();
  await acLapsedItem.getByText("无法裁决：请求已过期。", { exact: true }).waitFor();
  acEqual(
    await acLapsedItem.getByText("已过期", { exact: true }).count(),
    1,
    "the dark theme must keep the lapsed presentation",
  );
  await axeApprovalCenter("desktop dark approval center lapsed item");
  approvalCenterAcceptance.matrix.push("desktop-dark");
  await page.screenshot({ fullPage: true, path: approvalCenterLapsedDarkScreenshot });
  await page.getByRole("button", { name: /切换到明色主题/u }).click();
  await page.getByRole("button", { name: /切换到暗色主题/u }).waitFor();
  console.log(
    "APPROVAL CENTER LAPSED PASS: stale transition expired the open approval, center renders it disabled with reason, decide routes fail closed, light/dark axe",
  );

  // ---- AUDIT PANEL ACCEPTANCE (feature 028 T-04, desktop light key path) ----
  const auditApi = await page.evaluate(async (projectId) => {
    const pages = [];
    let before = null;
    for (let depth = 0; depth < 12; depth += 1) {
      const response = await fetch(
        `/api/projects/${projectId}/audit-events${before === null ? "" : `?before=${before}`}`,
        { cache: "no-store" },
      );
      const body = await response.json();
      if (!response.ok) return { error: body, status: response.status };
      pages.push(body);
      if (body.nextBeforeSeq === null) break;
      before = body.nextBeforeSeq;
    }
    return { pages, status: 200 };
  }, context.projectId);
  assert.equal(auditApi.status, 200, JSON.stringify(auditApi.error));
  const auditEvents = auditApi.pages.flatMap(({ events }) => events);
  const firstAuditPage = auditApi.pages[0];
  assert.ok(auditEvents.length > 0, "real executions must produce audit events");
  assert.equal(
    firstAuditPage.freshness.status,
    "caught_up",
    JSON.stringify(firstAuditPage.freshness),
  );
  for (let index = 1; index < auditEvents.length; index += 1) {
    assert.ok(
      auditEvents[index - 1].outboxSeq > auditEvents[index].outboxSeq,
      "audit events must be globally descending by outbox_seq",
    );
  }
  if (firstAuditPage.nextBeforeSeq !== null) {
    const secondPage = auditApi.pages[1];
    assert.ok(secondPage.events.length > 0, "cursor page must return older events");
    assert.ok(
      Math.max(...secondPage.events.map(({ outboxSeq }) => outboxSeq))
        < firstAuditPage.nextBeforeSeq,
      "before cursor must be exclusive",
    );
  }
  const auditApiText = JSON.stringify(auditApi.pages);
  for (const value of [
    apiKey,
    masterKey,
    `Bearer ${apiKey}`,
    rawProviderMarker,
    chainOfThoughtMarker,
    environmentMarker,
    canonicalWorkspace,
    realpathSync(executionRoot),
    temporaryDirectory,
    "Authorization:",
  ]) {
    assert.ok(!auditApiText.includes(value), "audit API payload leaked a forbidden marker");
  }
  const auditDatabaseCounts = (() => {
    const database = openDatabase();
    try {
      return {
        checkpoint: Number(database.prepare(`
          SELECT last_outbox_seq AS value FROM audit_projection_checkpoints
          WHERE consumer_id='audit-event-projection'
        `).get().value),
        maxSeq: Number(scalar(database, "SELECT COALESCE(MAX(outbox_seq),0) AS value FROM audit_event_outbox")),
        outbox: Number(scalar(database, "SELECT COUNT(*) AS value FROM audit_event_outbox")),
        projection: Number(scalar(database, "SELECT COUNT(*) AS value FROM audit_event_projection")),
      };
    } finally {
      database.close();
    }
  })();
  assert.equal(auditDatabaseCounts.outbox, auditEvents.length, "API must expose every outbox event");
  assert.equal(auditDatabaseCounts.projection, auditDatabaseCounts.outbox, "read path must catch up the projection");
  assert.equal(auditDatabaseCounts.checkpoint, auditDatabaseCounts.maxSeq, "checkpoint must be caught up");
  console.log(`AUDIT API PASS: events=${auditEvents.length} freshness=caught_up pages=${auditApi.pages.length}`);

  const contextPanel = page.locator(".cockpit-context");
  const memoryTab = contextPanel.getByRole("tab", { name: "共享记忆" });
  await memoryTab.focus();
  // Same-page baseline with the audit panel still unmounted, so any axe
  // violation present here is pre-existing cockpit chrome, not the new panel.
  await axeScan("desktop light memory tab baseline");
  await page.keyboard.press("End");
  const auditTab = contextPanel.getByRole("tab", { name: "审计" });
  assert.equal(await auditTab.getAttribute("aria-selected"), "true");
  const auditList = contextPanel.getByRole("list", { name: "审计事件" });
  await auditList.waitFor();
  await contextPanel.getByText("已追平", { exact: true }).waitFor();
  const auditRows = auditList.getByRole("listitem");
  const firstPageRows = Math.min(auditEvents.length, 50);
  await page.waitForFunction(
    (expected) => document.querySelectorAll(".audit-event-list > li").length === expected,
    firstPageRows,
  );
  const expectedFirstCopy =
    AUDIT_EVENT_TYPE_COPY[auditEvents[0].eventType] ?? auditEvents[0].eventType;
  const expectedLastCopy = AUDIT_EVENT_TYPE_COPY[auditEvents[firstPageRows - 1].eventType]
    ?? auditEvents[firstPageRows - 1].eventType;
  const firstRowText = await auditRows.first().innerText();
  const lastRowText = await auditRows.nth(firstPageRows - 1).innerText();
  assert.ok(firstRowText.includes(expectedFirstCopy), `first audit row must show readable type copy: ${firstRowText}`);
  assert.ok(lastRowText.includes(expectedLastCopy), `last audit row must keep descending order: ${lastRowText}`);
  for (let click = 0; click < 12; click += 1) {
    const moreButton = contextPanel.getByRole("button", { name: "加载更多审计事件" });
    if (!(await moreButton.isVisible().catch(() => false))) break;
    const beforeCount = await auditRows.count();
    await moreButton.click();
    await page.waitForFunction(
      (expected) => document.querySelectorAll(".audit-event-list > li").length > expected,
      beforeCount,
    );
  }
  assert.equal(
    await auditRows.count(),
    auditEvents.length,
    "audit list must render every projected event after cursor paging",
  );
  const firstLocate = auditList.getByRole("button", { name: "定位来源执行" }).first();
  const locateBox = await firstLocate.boundingBox();
  assert.ok(locateBox && locateBox.height >= 44 && locateBox.width >= 44, "locate button must be at least 44x44");
  const auditTabBox = await auditTab.boundingBox();
  assert.ok(auditTabBox && auditTabBox.height >= 44 && auditTabBox.width >= 44, "audit tab must be at least 44x44");

  const renderedExecutionIds = await page.evaluate(async (projectId) => (
    await (await fetch(`/api/projects/${projectId}/executions`, { cache: "no-store" })).json()
  ).executions.slice(0, 2).map(({ id }) => id), context.projectId);
  const locateTarget = renderedExecutionIds
    .map((executionId) => ({
      executionId,
      index: auditEvents.findIndex((event) => event.executionId === executionId),
    }))
    .find(({ index }) => index >= 0);
  assert.ok(locateTarget, "a rendered execution card must have audit events");
  await auditRows.nth(locateTarget.index)
    .getByRole("button", { name: "定位来源执行" })
    .click();
  await page.waitForFunction(
    (expectedId) => document.activeElement?.id === expectedId,
    `execution-${locateTarget.executionId}-title`,
  );
  await contextPanel.getByText("已定位到来源执行。").waitFor();
  await axeScan("desktop light audit panel");
  await page.screenshot({ fullPage: true, path: auditDesktopScreenshot });
  await page.getByRole("button", { name: /切换到暗色主题/ }).click();
  await page.getByRole("button", { name: /切换到明色主题/ }).waitFor();
  await contextPanel.getByText("已追平", { exact: true }).waitFor();
  await axeScan("desktop dark audit panel");
  await page.getByRole("button", { name: /切换到明色主题/ }).click();
  await page.getByRole("button", { name: /切换到暗色主题/ }).waitFor();
  console.log("AUDIT DESKTOP PASS: list+freshness+paging+locate+keyboard+44px+light/dark axe");

  desktopFacingText = await page.locator("html").innerText();
  await page.screenshot({ fullPage: true, path: desktopScreenshot });

  await page.setViewportSize({ height: 844, width: 390 });
  await page.reload({ waitUntil: "networkidle" });
  const editorOpener = page.getByRole("button", { name: "打开编辑" });
  await editorOpener.focus();
  await page.keyboard.press("Enter");
  const editor = page.getByRole("dialog", { name: "任务编辑" });
  const runTab = editor.getByRole("tab", { name: "运行详情" });
  await runTab.focus();
  await page.keyboard.press("Enter");
  const switcher = editor.getByRole("list", { name: "执行摘要切换" });
  const firstSummary = switcher.getByRole("button").first();
  await firstSummary.focus();
  await page.keyboard.press("Enter");
  const detailDialog = page.getByRole("dialog", { name: /详情/ });
  await detailDialog.waitFor();
  const layout = await detailDialog.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return {
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
      width: bounds.width,
      left: bounds.left,
      right: bounds.right,
      controls: [...element.querySelectorAll("button")].map((button) => {
        const rect = button.getBoundingClientRect();
        return { height: rect.height, width: rect.width };
      }),
    };
  });
  assert.ok(layout.documentWidth <= layout.viewportWidth);
  assert.ok(layout.left >= 0 && layout.right <= layout.viewportWidth);
  assert.ok(layout.controls.every(({ height, width }) => height >= 44 && width >= 44));
  narrowFacingText = await page.locator("html").innerText();
  await page.screenshot({ fullPage: true, path: narrowScreenshot });
  await page.keyboard.press("Escape");
  await detailDialog.waitFor({ state: "detached" });
  assert.equal(await firstSummary.evaluate((element) => document.activeElement === element), true);

  // ---- AUDIT PANEL ACCEPTANCE (feature 028 T-04, narrow drawer key path) ----
  await page.keyboard.press("Escape");
  await editor.waitFor({ state: "detached" });
  const contextOpener = page.getByRole("button", { name: "打开当前任务上下文" });
  await contextOpener.focus();
  await page.keyboard.press("Enter");
  const contextDrawer = page.getByRole("dialog", { name: "当前任务上下文" });

  // ---- APPROVAL CENTER ACCEPTANCE (feature 029 T-04, narrow drawer key path) ----
  const narrowApprovalsTab = contextDrawer.getByRole("tab", { name: "审批" });
  await narrowApprovalsTab.focus();
  await page.keyboard.press("Enter");
  acEqual(
    await narrowApprovalsTab.getAttribute("aria-selected"),
    "true",
    "Enter must select the narrow approval tab",
  );
  const narrowApprovalList = contextDrawer.getByRole("list", { name: "待裁决请求" });
  await narrowApprovalList.waitFor();
  acEqual(
    await narrowApprovalList.locator("> li").count(),
    1,
    "the narrow drawer must render the lapsed item",
  );
  await contextDrawer.getByText("无法裁决：请求已过期。", { exact: true }).waitFor();
  acEqual(
    await contextDrawer.getByRole("button", { name: /^批准 /u }).count(),
    0,
    "the narrow lapsed item must not render an approve button",
  );
  acEqual(
    await contextDrawer.getByRole("button", { name: /^拒绝 /u }).count(),
    0,
    "the narrow lapsed item must not render a reject button",
  );
  const narrowApprovalLocate = contextDrawer.getByRole("button", { name: "定位来源执行" });
  const narrowApprovalLocateBox = await narrowApprovalLocate.boundingBox();
  acOk(
    narrowApprovalLocateBox
      && narrowApprovalLocateBox.height >= 44
      && narrowApprovalLocateBox.width >= 44,
    "the narrow lapsed locate button must be at least 44x44",
  );
  const narrowApprovalsTabBox = await narrowApprovalsTab.boundingBox();
  acOk(
    narrowApprovalsTabBox
      && narrowApprovalsTabBox.height >= 44
      && narrowApprovalsTabBox.width >= 44,
    "the narrow approval tab must be at least 44x44",
  );
  await axeApprovalCenter("narrow light approval center drawer");
  approvalCenterAcceptance.matrix.push("narrow-light");
  await page.screenshot({ fullPage: true, path: approvalCenterNarrowScreenshot });
  console.log("APPROVAL CENTER NARROW PASS: drawer renders the lapsed item disabled, 44px, axe");

  const narrowAuditTab = contextDrawer.getByRole("tab", { name: "审计" });
  await narrowAuditTab.focus();
  await page.keyboard.press("Enter");
  assert.equal(await narrowAuditTab.getAttribute("aria-selected"), "true");
  const narrowAuditList = contextDrawer.getByRole("list", { name: "审计事件" });
  await narrowAuditList.waitFor();
  await contextDrawer.getByText("已追平", { exact: true }).waitFor();
  const narrowLocate = narrowAuditList.getByRole("button", { name: "定位来源执行" }).first();
  await narrowLocate.focus();
  const narrowLocateBox = await narrowLocate.boundingBox();
  assert.ok(
    narrowLocateBox && narrowLocateBox.height >= 44 && narrowLocateBox.width >= 44,
    "narrow locate button must be at least 44x44",
  );
  const narrowTabBox = await narrowAuditTab.boundingBox();
  assert.ok(
    narrowTabBox && narrowTabBox.height >= 44 && narrowTabBox.width >= 44,
    "narrow audit tab must be at least 44x44",
  );
  await page.keyboard.press("Enter");
  // The execution cards live in the closed editor drawer in narrow mode, so the
  // locate seam must honestly report instead of faking a jump.
  await contextDrawer
    .getByText("该执行未显示在运行详情列表中（仅展示最近的执行）。")
    .waitFor();
  await axeScan("narrow audit drawer");
  await page.screenshot({ fullPage: true, path: auditNarrowScreenshot });
  narrowAuditFacingText = await page.locator("html").innerText();
  await page.keyboard.press("Escape");
  await contextDrawer.waitFor({ state: "detached" });
  assert.equal(await contextOpener.evaluate((element) => document.activeElement === element), true);
  console.log("AUDIT NARROW PASS: drawer list+freshness+keyboard+44px+honest locate+axe");

  const providerBodyText = providerCaptures.map(({ body }) => body).join("\n");
  assert.ok(providerCaptures.some(({ authorization }) => authorization === `Bearer ${apiKey}`));
  assert.ok(providerAuthorizationCount >= modelSteps.size + 1);
  const providerEnvelope = (() => {
    const database = openDatabase();
    try {
      return database.prepare(`
        SELECT api_key_cipher AS cipher,api_key_iv AS iv,api_key_tag AS tag FROM providers
      `).get();
    } finally {
      database.close();
    }
  })();
  const surfaces = {
    api: apiBodies.join("\n"),
    database: databaseText(),
    dom: `${desktopFacingText}\n${narrowFacingText}\n${narrowAuditFacingText}\n${approvalCenterFacingText}`,
    logs: serverOutput,
    providerBodies: providerBodyText,
    screenshotFacingText: `${desktopFacingText}\n${narrowFacingText}\n${narrowAuditFacingText}\n${
      approvalCenterFacingText
    }\n${readFileSync(desktopScreenshot).toString("latin1")
    }\n${readFileSync(narrowScreenshot).toString("latin1")
    }\n${readFileSync(auditDesktopScreenshot).toString("latin1")
    }\n${readFileSync(auditNarrowScreenshot).toString("latin1")
    }\n${readFileSync(approvalCenterDesktopScreenshot).toString("latin1")
    }\n${readFileSync(approvalCenterLapsedScreenshot).toString("latin1")
    }\n${readFileSync(approvalCenterLapsedDarkScreenshot).toString("latin1")
    }\n${readFileSync(approvalCenterNarrowScreenshot).toString("latin1")}`,
  };
  const forbidden = [
    apiKey,
    masterKey,
    `Bearer ${apiKey}`,
    providerEnvelope.cipher,
    providerEnvelope.iv,
    providerEnvelope.tag,
    rawProviderMarker,
    chainOfThoughtMarker,
    canonicalWorkspace,
    realpathSync(executionRoot),
    temporaryDirectory,
    environmentMarker,
    "Authorization:",
  ];
  const leaks = [];
  const storedCiphertext = new Set([
    providerEnvelope.cipher,
    providerEnvelope.iv,
    providerEnvelope.tag,
  ]);
  for (const [surface, text] of Object.entries(surfaces)) {
    for (const value of forbidden) {
      if (surface === "database" && storedCiphertext.has(value)) continue;
      if (value && text.includes(value)) leaks.push({ surface, value });
    }
  }
  assert.deepEqual(leaks, []);
  const finalCounts = counts();
  console.log(
    "SECURITY SCAN PASS: key/master/cipher/Authorization/raw host paths/env/CoT occurrences=0 "
    + "across provider bodies, DB, product API, DOM, logs, and screenshot-facing surfaces",
  );
  writeFileSync(
    approvalCenterResultsPath,
    `${JSON.stringify(approvalCenterAcceptance, null, 2)}\n`,
  );
  console.log(
    `APPROVAL CENTER ACCEPTANCE PASS: assertions=${approvalCenterAcceptance.assertions} `
    + `axeStates=${approvalCenterAcceptance.axe.length} matrix=${approvalCenterAcceptance.matrix.join("/")}`,
  );
  console.log(`APPROVAL CENTER RESULTS: ${approvalCenterResultsPath}`);
  console.log(
    `BROWSER PASS: providerCalls=${providerCaptures.length} maxConcurrentProviderCalls=${maxConcurrentProviderCalls} `
    + Object.entries(finalCounts).map(([name, value]) => `${name}=${value}`).join(" "),
  );
  console.log("PERSISTENCE PASS: refresh and process restart restored execution/manual recovery outcomes");
  console.log(`DESKTOP SCREENSHOT: ${desktopScreenshot}`);
  console.log(`NARROW SCREENSHOT: ${narrowScreenshot}`);
  console.log(`AUDIT DESKTOP SCREENSHOT: ${auditDesktopScreenshot}`);
  console.log(`AUDIT NARROW SCREENSHOT: ${auditNarrowScreenshot}`);
} finally {
  await page?.unrouteAll({ behavior: "ignoreErrors" }).catch(() => undefined);
  await browser?.close();
  stopAppServer();
  if (provider.listening) await close(provider);
  rmSync(temporaryDirectory, { force: true, recursive: true });
}
