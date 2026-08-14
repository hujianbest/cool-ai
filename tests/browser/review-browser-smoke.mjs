import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { chromium } from "playwright";

const host = "127.0.0.1";
const portSeed = randomBytes(4).readUInt32BE();
const appPort = 10_000 + (portSeed % 20_000);
const providerPort = appPort + 1;
const baseUrl = `http://${host}:${appPort}`;
const providerBaseUrl = `http://${host}:${providerPort}/v1`;
const root = mkdtempSync(join(tmpdir(), "cool-ai-review-smoke-"));
const workspaceDirectory = join(root, "workspace");
const executionRoot = join(root, "executions");
const databasePath = join(root, "review-smoke.sqlite");
const reviewBodyMarker = `review-smoke-body-${randomBytes(8).toString("hex")}`;
const memoryMarker = `review-smoke-memory-${randomBytes(8).toString("hex")}`;
const apiKey = `review-key-${randomBytes(18).toString("base64url")}`;
const masterKey = randomBytes(32).toString("base64url");
const evidenceDirectory = resolve("features", "006-peer-review-memory-delivery", "evidence");
const desktopScreenshot = join(evidenceDirectory, "smoke-review-desktop.png");
const narrowScreenshot = join(evidenceDirectory, "smoke-review-narrow.png");
mkdirSync(join(workspaceDirectory, "src"), { recursive: true });
mkdirSync(executionRoot, { recursive: true });
mkdirSync(evidenceDirectory, { recursive: true });
writeFileSync(join(workspaceDirectory, "src", "baseline.txt"), "review smoke baseline\n");

const browserExecutable = [
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
].find((candidate) => candidate && existsSync(candidate));

const reviewRoute = (workItemId) => `/api/work-items/${workItemId}/reviews`;
const escalationAnswerRoute = (escalationId) =>
  `/api/escalations/${escalationId}/answer`;

let executorAgentId = "";
let reviewerAgentId = "";
let collaborationStep = 0;
let executionStep = 0;
let providerCallCount = 0;
let reviewCallCount = 0;
let providerSawReviewBody = false;
let serverOutput = "";
let appServer;
let projectPath = "";

function jsonResponse(response, value, status = 200) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

async function requestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function collaborationTurn() {
  if (collaborationStep > 0) {
    collaborationStep += 1;
    return {
      claim: null,
      disposition: { type: "plan_ready" },
      message: "The executor and independent reviewer have completed planning.",
      tasks: [],
    };
  }
  collaborationStep += 1;
  return {
    claim: { clientKey: "review_task", source: "proposed" },
    disposition: {
      reason: "The non-executing reviewer must inspect the plan.",
      summary: "The executor claimed the single implementation task.",
      targetAgentId: reviewerAgentId,
      type: "handoff",
    },
    message: "The implementation task is assigned; hand off planning to its reviewer.",
    tasks: [{
      clientKey: "review_task",
      dependsOnKeys: [],
      description: "Create one public text change for independent review.",
      title: "Implement reviewed change",
    }],
  };
}

function executionTurn() {
  const executionNumber = Math.floor(executionStep / 2) + 1;
  if (executionStep % 2 === 0) {
    executionStep += 1;
    return {
      action: {
        content: `${reviewBodyMarker}-v${executionNumber}\n`,
        expectedHash: null,
        path: `src/reviewed-${executionNumber}.txt`,
        type: "write",
      },
      summary: "Create the public body that the independent reviewer must read.",
    };
  }
  executionStep += 1;
  return {
    action: { type: "staged" },
    summary: "Stage the reviewed text change.",
  };
}

function reviewOutput(material) {
  const source = material.sourceRefs.find(({ type }) => type === "result");
  assert.ok(source, "frozen review material must expose its result version");
  const frozenBody = JSON.stringify(material);
  assert.ok(
    frozenBody.includes(reviewBodyMarker),
    "the independent review Agent must receive the real public diff body",
  );
  providerSawReviewBody = true;
  if (reviewCallCount === 1) {
    return {
      decision: {
        choice: "reject",
        reworkRequirements: ["Add a second public result for independent review."],
      },
      evidenceRefs: [source],
      findings: [],
      limitations: [],
      memoryCandidates: [],
      publicSummary: "The first result needs a public rework result.",
    };
  }
  if (reviewCallCount === 2) {
    return {
      decision: {
        choice: "escalate",
        options: [
          "Continue review with the owner clarification.",
          "Return the revised result for another rework cycle.",
        ],
        question: "Should this revised public result proceed to final review?",
      },
      evidenceRefs: [source],
      findings: [],
      limitations: [],
      memoryCandidates: [],
      publicSummary: "The revised result needs one explicit owner clarification.",
    };
  }
  return {
    decision: { choice: "pass" },
    evidenceRefs: [source],
    findings: [],
    limitations: [],
    memoryCandidates: [{
      content: memoryMarker,
      source,
      supersedesMemoryId: null,
      type: "experience",
    }],
    publicSummary: "The public change body was read and is ready for delivery.",
  };
}

const provider = createServer(async (request, response) => {
  const body = await requestBody(request);
  if (request.method === "GET" && request.url === "/v1/models") {
    jsonResponse(response, { data: [{ id: "review-model" }] });
    return;
  }
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    response.writeHead(404).end();
    return;
  }
  assert.equal(request.headers.authorization, `Bearer ${apiKey}`);
  providerCallCount += 1;
  const parsed = JSON.parse(body);
  const prompt = parsed.messages.map(({ content }) => content).join("\n");
  let content;
  if (prompt.includes("You are executing one frozen project task")) {
    content = executionTurn();
  } else if (prompt.includes("independently selected review Agent")) {
    reviewCallCount += 1;
    content = reviewOutput(JSON.parse(parsed.messages[2].content));
  } else if (
    prompt.includes("auditable collaboration turn")
    || prompt.includes("ProposedTask:")
  ) {
    content = collaborationTurn();
  } else {
    jsonResponse(response, {
      choices: [{ message: { content: "ok" } }],
      usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 },
    });
    return;
  }
  jsonResponse(response, {
    choices: [{ message: { content: JSON.stringify(content) } }],
    usage: { completion_tokens: 11, prompt_tokens: 17, total_tokens: 28 },
  });
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

function startAppServer() {
  appServer = spawn(process.execPath, [
    nextCli,
    "start",
    "--hostname",
    host,
    "--port",
    String(appPort),
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      COCKPIT_DB_PATH: databasePath,
      COCKPIT_EXECUTION_ROOT: executionRoot,
      COCKPIT_MASTER_KEY: masterKey,
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
      throw new Error(`Review app exited before readiness.\n${serverOutput}`);
    }
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
    } catch {
      // The real Next process is still starting.
    }
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error(`Review app did not become ready.\n${serverOutput}`);
}

async function restartAppServer() {
  stopAppServer();
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      await fetch(baseUrl);
    } catch {
      break;
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  appServer = undefined;
  startAppServer();
  await waitForApp();
}

async function createSkill(page) {
  await page.getByRole("tab", { name: "技能" }).click();
  await page.getByRole("button", { name: "创建新技能" }).click();
  await page.getByLabel("技能名称").fill("Review Smoke Skill");
  await page.getByLabel("技能说明").fill("Public review smoke instructions");
  await page.getByLabel("指令正文").fill("Read the supplied public body before deciding.");
  await page.getByRole("button", { name: "保存技能" }).click();
  await page.getByRole("heading", { name: "Review Smoke Skill" }).waitFor();
}

async function createAgent(page, { avatar, name, template }) {
  await page.getByRole("tab", { name: "Agent" }).click();
  await page.getByRole("button", { name: "创建 Agent" }).click();
  await page.getByLabel("创建方式").selectOption(template);
  await page.getByLabel("Agent 名称").fill(name);
  await page
    .getByRole("combobox", { exact: true, name: "模型服务" })
    .selectOption({ label: "Review Local Provider" });
  await page.getByRole("checkbox", { name: "Review Smoke Skill" }).check();
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
  await providerTab.click();
  await page.getByRole("button", { name: "创建模型服务" }).click();
  await page.getByLabel("服务名称").fill("Review Local Provider");
  await page.getByLabel("Base URL").fill(providerBaseUrl);
  await page.getByLabel("默认模型").fill("review-model");
  await page.getByLabel("API key").fill(apiKey);
  await page.getByRole("checkbox", { name: /HTTP 会明文传输凭据/ }).check();
  await page.getByRole("button", { name: "验证连接" }).click();
  await page.getByText("已验证模型 review-model", { exact: true }).waitFor();
  await page.getByRole("button", { name: "保存服务" }).click();
  await createSkill(page);
  await createAgent(page, {
    avatar: "执",
    name: "Review Executor",
    template: "builder",
  });
  await createAgent(page, {
    avatar: "审",
    name: "Review Verifier",
    template: "reviewer",
  });
}

async function createProject(page) {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.getByLabel("文件夹路径").fill(workspaceDirectory);
  await page
    .locator("form")
    .filter({ has: page.getByLabel("文件夹路径") })
    .getByRole("button", { name: "打开文件夹" })
    .click();
  await page.waitForURL(/\/projects\/[^/]+$/);
  projectPath = new URL(page.url()).pathname;
  await page.getByRole("heading", { name: "workspace" }).waitFor();
  const members = page.getByRole("group", { name: "平等项目成员" });
  await members.getByRole("checkbox", { name: /Review Executor/ }).check();
  await members.getByRole("checkbox", { name: /Review Verifier/ }).check();
  await page.getByRole("button", { name: "保存成员" }).click();
  await page.getByText("项目成员已保存。", { exact: true }).waitFor();
  await page.getByLabel("使命标题").fill("Review Smoke Mission");
  await page.getByLabel("使命目标").fill("Deliver one independently reviewed public change");
  await page.getByRole("button", { name: "创建使命" }).click();
  await page.getByRole("heading", { name: "Review Smoke Mission" }).waitFor();
  return page.evaluate(async () => {
    const projectId = new URL(window.location.href).pathname.split("/").at(-1);
    const projects = (await (await fetch("/api/projects")).json()).projects;
    const project = projects.find(({ id }) => id === projectId);
    if (!project) throw new Error(`Opened project ${projectId} was not listed.`);
    const missionState = await (await fetch(`/api/projects/${project.id}/mission`)).json();
    const agents = (await (await fetch("/api/agents")).json()).agents;
    const memberAgentIds = agents
      .filter(({ name }) => ["Review Executor", "Review Verifier"].includes(name))
      .map(({ id }) => id);
    const response = await fetch(`/api/projects/${project.id}/threads`, {
      body: JSON.stringify({
        memberAgentIds,
        operationId: crypto.randomUUID(),
        title: "Review smoke",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const created = await response.json();
    if (response.status !== 201) throw new Error(JSON.stringify(created));
    return { agents, mission: missionState.mission, project, thread: created.thread };
  });
}

async function enableExecutor(page, agent) {
  const result = await page.evaluate(async (current) => {
    const response = await fetch(`/api/agents/${current.id}`, {
      body: JSON.stringify({
        accentToken: current.accentToken,
        avatarText: current.avatarText,
        expectedVersion: current.version,
        maxHandoffs: current.maxHandoffs,
        maxTokens: current.maxTokens,
        model: current.model,
        name: current.name,
        permissions: { readFiles: true, runCommands: false, writeFiles: true },
        providerId: current.providerId,
        reviewCapable: false,
        role: current.role,
        skillIds: current.skillIds,
        systemPrompt: current.systemPrompt,
      }),
      headers: { "content-type": "application/json" },
      method: "PATCH",
    });
    return { body: await response.json(), status: response.status };
  }, agent);
  assert.equal(result.status, 200, JSON.stringify(result.body));
}

async function planTask(page, projectId, threadId) {
  const started = await page.evaluate(async ({ agentId, id, thread }) => {
    const response = await fetch(`/api/projects/${id}/threads/${thread}/runs`, {
      body: JSON.stringify({
        mentionAgentId: agentId,
        message: "Plan the single independently reviewed implementation task.",
        operationId: crypto.randomUUID(),
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    return { body: await response.json(), status: response.status };
  }, { agentId: executorAgentId, id: projectId, thread: threadId });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const state = await page.evaluate(async ({ id, runId, thread }) =>
      (await (await fetch(
        `/api/projects/${id}/threads/${thread}?run=${encodeURIComponent(runId)}`,
      )).json()), { id: projectId, runId: started.body.run.id, thread: threadId });
    if (state.selectedRun?.status === "planned") return state.selectedRun.id;
    assert.equal(state.selectedRun?.status, "running", JSON.stringify(state));
    const advanced = await page.evaluate(async ({ id, runId, thread }) => {
      const response = await fetch(
        `/api/projects/${id}/threads/${thread}/runs/${runId}/advance`,
        {
          body: JSON.stringify({ operationId: crypto.randomUUID() }),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      );
      return { body: await response.json(), status: response.status };
    }, { id: projectId, runId: started.body.run.id, thread: threadId });
    assert.ok(
      advanced.status >= 200 && advanced.status < 300,
      JSON.stringify(advanced.body),
    );
    await new Promise((done) => setTimeout(done, 200));
  }
  throw new Error("Public collaboration did not produce the planned task.");
}

async function startExecution(page, projectId, threadId, runId) {
  const result = await page.evaluate(async ({ id, sourceRunId, sourceThreadId }) => {
    const mission = await (await fetch(`/api/projects/${id}/mission`)).json();
    const workItem = mission.workItems.at(-1);
    const response = await fetch(`/api/projects/${id}/executions`, {
      body: JSON.stringify({
        operationId: crypto.randomUUID(),
        source: {
          projectId: id,
          runId: sourceRunId,
          threadId: sourceThreadId,
        },
        workItemId: workItem.id,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    return {
      body: await response.json(),
      status: response.status,
      workItem,
    };
  }, { id: projectId, sourceRunId: runId, sourceThreadId: threadId });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return { executionId: result.body.execution.id, workItem: result.workItem };
}

async function advanceToStaged(page, executionId) {
  const deadline = Date.now() + 120_000;
  let last;
  while (Date.now() < deadline) {
    last = await page.evaluate(async (id) =>
      (await (await fetch(`/api/executions/${id}`, { cache: "no-store" })).json()),
    executionId);
    if (last.execution.status === "staged") return last;
    assert.ok(
      ["queued", "running"].includes(last.execution.status),
      JSON.stringify(last),
    );
    const advanced = await page.evaluate(async ({ id, version }) => {
      const response = await fetch(`/api/executions/${id}/advance`, {
        body: JSON.stringify({
          expectedVersion: version,
          operationId: crypto.randomUUID(),
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      return { body: await response.json(), status: response.status };
    }, { id: executionId, version: last.execution.version });
    assert.ok(
      (advanced.status >= 200 && advanced.status < 300) || advanced.status === 409,
      JSON.stringify(advanced),
    );
  }
  throw new Error(`Execution did not stage.\n${JSON.stringify(last)}\n${serverOutput}`);
}

async function approveAndMerge(page, executionId, staged) {
  const approvals = await page.evaluate(async (id) =>
    (await (await fetch(`/api/executions/${id}/approvals?limit=10`)).json()),
  executionId);
  const pending = approvals.items.find(({ kind, status }) =>
    kind === "staged_merge" && status === "pending");
  if (pending) {
    const approved = await page.evaluate(async ({ approvalId, id, version }) => {
      const response = await fetch(`/api/executions/${id}/approvals/${approvalId}`, {
        body: JSON.stringify({
          action: "approve",
          expectedVersion: version,
          operationId: crypto.randomUUID(),
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      return { body: await response.json(), status: response.status };
    }, {
      approvalId: pending.id,
      id: executionId,
      version: staged.execution.version,
    });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
  }
  const current = await page.evaluate(async (id) =>
    (await (await fetch(`/api/executions/${id}`, { cache: "no-store" })).json()),
  executionId);
  const merged = await page.evaluate(async ({ id, stagedHash, version }) => {
    const response = await fetch(`/api/executions/${id}/merge`, {
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
    id: executionId,
    stagedHash: current.staged.stagedHash,
    version: current.execution.version,
  });
  assert.equal(merged.status, 200, JSON.stringify(merged.body));
  assert.equal(merged.body.execution.status, "merged");
  return merged.body.result;
}

async function openRunTab(page) {
  const openEditor = page.getByRole("button", {
    exact: true,
    name: "打开编辑",
  });
  if (await openEditor.isVisible().catch(() => false)) {
    await openEditor.focus();
    await page.keyboard.press("Enter");
    await page.getByRole("dialog", { name: "任务编辑" }).waitFor();
  }
  const heading = page.getByRole("heading", { exact: true, name: "运行详情" }).first();
  if (await heading.isVisible().catch(() => false)) return;
  const tab = page.getByRole("tab", { exact: true, name: "运行详情" }).first();
  try {
    await tab.focus();
    await page.keyboard.press("Enter");
    await heading.waitFor();
  } catch (error) {
    throw new Error(
      `${error.message}\nURL=${page.url()}`
      + `\nPage=${(await page.locator("body").innerText()).slice(-8_000)}`,
    );
  }
}

async function openReviewThroughKeyboard(page) {
  await page.goto(`${baseUrl}${projectPath}`, { waitUntil: "networkidle" });
  await openRunTab(page);
  const openReview = page.getByRole("button", { name: "打开复核闭环" }).last();
  await openReview.focus();
  await page.keyboard.press("Enter");
}

async function startReviewThroughKeyboard(page, workItemId, expectedChoice) {
  await openReviewThroughKeyboard(page);
  const reviewerChoice = page.getByRole("radio", { name: /Review Verifier/ });
  await reviewerChoice.focus();
  await page.keyboard.press("Space");
  const startReview = page.getByRole("button", { name: "确认并发起真实复核" });
  await startReview.focus();
  await page.keyboard.press("Enter");
  const expectedStatus = {
    escalate: "waiting_owner",
    pass: "passed",
    reject: "rework",
  }[expectedChoice];
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const workspace = await readWorkspace(page, workItemId);
    if (workspace.effectiveStatus === expectedStatus) break;
    await new Promise((done) => setTimeout(done, 200));
  }
  await openReviewThroughKeyboard(page);
  const answerTab = page.getByRole("tab", { exact: true, name: "回答" });
  await answerTab.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("listitem")
    .filter({ hasText: `唯一裁决：${expectedChoice}` })
    .last()
    .waitFor();
}

async function readWorkspace(page, workItemId) {
  return page.evaluate(async (id) =>
    (await (await fetch(`/api/work-items/${id}/review`)).json()), workItemId);
}

let browser;
try {
  assert.match(reviewRoute("work"), /^\/api\/work-items\/work\/reviews$/u);
  assert.match(
    escalationAnswerRoute("issue"),
    /^\/api\/escalations\/issue\/answer$/u,
  );
  await listen(provider, providerPort);
  startAppServer();
  await waitForApp();
  browser = await chromium.launch({
    headless: true,
    ...(browserExecutable ? { executablePath: browserExecutable } : {}),
  });
  const page = await browser.newPage({ viewport: { height: 1100, width: 1600 } });
  page.setDefaultTimeout(60_000);
  const browserErrors = [];
  page.on("pageerror", (error) => browserErrors.push(error.stack ?? error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });

  await createTeam(page);
  const context = await createProject(page);
  const executor = context.agents.find(({ name }) => name === "Review Executor");
  const reviewer = context.agents.find(({ name }) => name === "Review Verifier");
  assert.ok(executor && reviewer);
  assert.equal(executor.reviewCapable, false);
  assert.equal(reviewer.reviewCapable, true);
  assert.notEqual(executor.id, reviewer.id);
  executorAgentId = executor.id;
  reviewerAgentId = reviewer.id;
  await enableExecutor(page, executor);

  const runId = await planTask(page, context.project.id, context.thread.id);
  const started = await startExecution(
    page,
    context.project.id,
    context.thread.id,
    runId,
  );
  const staged = await advanceToStaged(page, started.executionId);
  const result = await approveAndMerge(page, started.executionId, staged);
  assert.equal(
    result.status,
    "awaiting_review",
    "the public first merge must enter independent review",
  );
  const firstWorkspace = await page.evaluate(async (workItemId) =>
    (await (await fetch(`/api/work-items/${workItemId}/review`)).json()),
  started.workItem.id);
  assert.ok(firstWorkspace.result, JSON.stringify(firstWorkspace));
  assert.equal(
    firstWorkspace.result.version,
    1,
    "the public merge must create the first result version",
  );

  try {
    await startReviewThroughKeyboard(page, started.workItem.id, "reject");
  } catch (error) {
    const workspace = await readWorkspace(page, started.workItem.id);
    throw new Error(
      `${error.message}\nReview calls=${reviewCallCount}; bodySeen=${providerSawReviewBody}`
      + `\nWorkspace=${JSON.stringify(workspace)}`
      + `\nBrowserErrors=${browserErrors.join("\n")}`
      + `\nPage=${(await page.locator("body").innerText()).slice(-8_000)}`,
    );
  }
  assert.equal(reviewCallCount, 1);
  assert.equal(providerSawReviewBody, true);
  assert.equal((await readWorkspace(page, started.workItem.id)).effectiveStatus, "rework");

  const reworkExecution = await startExecution(
    page,
    context.project.id,
    context.thread.id,
    runId,
  );
  assert.equal(reworkExecution.workItem.id, started.workItem.id);
  const reworkStaged = await advanceToStaged(page, reworkExecution.executionId);
  const revisedResult = await approveAndMerge(
    page,
    reworkExecution.executionId,
    reworkStaged,
  );
  assert.notEqual(revisedResult.id, result.id);
  assert.equal((await readWorkspace(page, started.workItem.id)).result.version, 2);

  await startReviewThroughKeyboard(page, started.workItem.id, "escalate");
  assert.equal(reviewCallCount, 2);
  const escalated = await readWorkspace(page, started.workItem.id);
  assert.equal(escalated.effectiveStatus, "waiting_owner");
  assert.ok(escalated.currentEscalation?.escalationId);

  await openReviewThroughKeyboard(page);
  const answerTab = page.getByRole("tab", { exact: true, name: "回答" });
  await answerTab.focus();
  await page.keyboard.press("Enter");
  const ownerAnswer = page.getByRole("textbox", { name: "Owner 回答" });
  await ownerAnswer.focus();
  await page.keyboard.type("Proceed with the revised public result.");
  const continueReview = page.getByRole("radio", { name: "继续复核" });
  await continueReview.focus();
  await page.keyboard.press("Space");
  const submitAnswer = page.getByRole("button", { name: "提交 Owner 回答" });
  await submitAnswer.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("heading", { name: "Owner 动作已保存" }).waitFor();
  const answered = await readWorkspace(page, started.workItem.id);
  assert.equal(answered.effectiveStatus, "pending_review");
  assert.equal(answered.answeredEscalations.length, 1);

  await startReviewThroughKeyboard(page, started.workItem.id, "pass");
  assert.equal(reviewCallCount, 3);
  const passed = await readWorkspace(page, started.workItem.id);
  assert.equal(passed.effectiveStatus, "passed");

  await openReviewThroughKeyboard(page);
  const memoryTab = page.getByRole("tab", { exact: true, name: "记忆" });
  await memoryTab.focus();
  await page.keyboard.press("Enter");
  try {
    await page
      .getByTestId("review-access-background")
      .getByText(memoryMarker, { exact: true })
      .waitFor();
  } catch (error) {
    const memories = await page.evaluate(async (projectId) => {
      const response = await fetch(
        `/api/projects/${projectId}/memories?includeInactive=0`,
      );
      return { body: await response.text(), status: response.status };
    }, context.project.id);
    throw new Error(
      `${error.message}\nMemories=${JSON.stringify(memories)}`
      + `\nPage=${(await page.locator("body").innerText()).slice(-8_000)}`,
    );
  }

  const generateDelivery = page.getByRole("button", { name: "生成最终交付" });
  await generateDelivery.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("heading", { name: "最终交付 v1" }).waitFor();

  const delivery = await page.evaluate(async (missionId) =>
    (await (await fetch(`/api/missions/${missionId}/delivery`)).json()),
  context.mission.id);
  assert.equal(delivery.state, "completed");
  assert.ok(delivery.currentDeliveryId);
  await page.screenshot({ fullPage: true, path: desktopScreenshot });

  await restartAppServer();
  await page.reload({ waitUntil: "networkidle" });
  const recovered = await readWorkspace(page, started.workItem.id);
  assert.equal(recovered.effectiveStatus, "passed");
  assert.equal(recovered.result.version, 2);
  assert.equal(recovered.answeredEscalations.length, 1);
  const recoveredHistory = await page.evaluate(async (workItemId) =>
    (await (await fetch(`/api/work-items/${workItemId}/reviews?limit=20`)).json()),
  started.workItem.id);
  assert.deepEqual(
    recoveredHistory.items.map((attempt) => attempt.decision?.choice),
    ["reject", "escalate", "pass"],
  );
  const recoveredDelivery = await page.evaluate(async (missionId) =>
    (await (await fetch(`/api/missions/${missionId}/delivery`)).json()),
  context.mission.id);
  assert.equal(recoveredDelivery.currentDeliveryId, delivery.currentDeliveryId);

  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto(`${baseUrl}${projectPath}`, { waitUntil: "networkidle" });
  await openRunTab(page);
  const executionSwitcher = page.getByRole("list", { name: "执行摘要切换" });
  const openExecution = executionSwitcher
    .getByRole("button", { name: /Implement reviewed change/ })
    .last();
  await openExecution.focus();
  await page.keyboard.press("Enter");
  const executionDialog = page.getByRole("dialog", {
    name: "Implement reviewed change 详情",
  });
  await executionDialog.waitFor();
  const openReviewClosure = executionDialog.getByRole("button", {
    name: "打开复核闭环",
  });
  await openReviewClosure.focus();
  await page.keyboard.press("Enter");
  const openNarrowReview = page.getByRole("button", {
    exact: true,
    name: "打开复核",
  });
  await openNarrowReview.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("dialog", {
    name: /Implement reviewed change 复核闭环/,
  }).waitFor();
  await page.screenshot({ fullPage: true, path: narrowScreenshot });
  await page.keyboard.press("Escape");

  assert.ok(providerCallCount >= 9);
  console.log(
    `REVIEW FULL CHAIN PASS: result ${result.id} rejected, result `
    + `${revisedResult.id} escalated then passed after owner answer, persisted `
    + `memory, restarted, and recovered delivery ${delivery.currentDeliveryId}`,
  );
  console.log(`SCREENSHOTS: ${desktopScreenshot}; ${narrowScreenshot}`);
} catch (error) {
  console.error(error);
  console.error(serverOutput);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  stopAppServer();
  await close(provider).catch(() => {});
  rmSync(root, { force: true, recursive: true });
}
