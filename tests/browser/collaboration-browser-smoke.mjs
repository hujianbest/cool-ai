import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { chromium } from "playwright";

const host = "127.0.0.1";
const appPort = 5600 + (process.pid % 200);
const providerPort = 5800 + (process.pid % 200);
const baseUrl = `http://${host}:${appPort}`;
const providerBaseUrl = `http://${host}:${providerPort}/v1`;
const temporaryDirectory = mkdtempSync(
  join(tmpdir(), "cool-ai-collaboration-smoke-"),
);
const workspaceDirectory = join(temporaryDirectory, "workspace");
mkdirSync(workspaceDirectory);
const canonicalWorkspace = realpathSync(workspaceDirectory);
const databasePath = join(temporaryDirectory, "collaboration-smoke.sqlite");
const masterKey = randomBytes(32).toString("base64url");
const apiKey = `collaboration-key-${randomBytes(18).toString("base64url")}`;
const alphaPrivate = `ALPHA_PRIVATE_${randomBytes(12).toString("hex")}`;
const betaPrivate = `BETA_PRIVATE_${randomBytes(12).toString("hex")}`;
const rawProviderBodyMarker = `RAW_PROVIDER_BODY_${randomBytes(12).toString("hex")}`;
const chainOfThoughtMarker = `CHAIN_OF_THOUGHT_${randomBytes(12).toString("hex")}`;
const evidenceDirectory = resolve(
  "features",
  "004-collaboration-orchestration",
  "evidence",
);
const desktopScreenshot = join(
  evidenceDirectory,
  "demo-collaboration-desktop.png",
);
const narrowScreenshot = join(
  evidenceDirectory,
  "demo-collaboration-narrow.png",
);
const browserExecutable = [
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
].find((candidate) => candidate && existsSync(candidate));

mkdirSync(evidenceDirectory, { recursive: true });

let alphaAgentId = "";
let betaAgentId = "";
let validationToken = "";
let providerAuthorizationCount = 0;
let completionCount = 0;
const outboundRequests = [];
const productApiBodies = [];

function turn(content, promptTokens = 11, completionTokens = 7) {
  return {
    choices: [{ message: { content: JSON.stringify(content) } }],
    usage: {
      completion_tokens: completionTokens,
      prompt_tokens: promptTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

const provider = createServer(async (request, response) => {
  const rawBody = await readRequestBody(request);
  outboundRequests.push({
    authorization: request.headers.authorization ?? "",
    body: rawBody,
    method: request.method,
    url: request.url,
  });

  if (request.headers.authorization === `Bearer ${apiKey}`) {
    providerAuthorizationCount += 1;
  }

  if (request.method === "GET" && request.url === "/v1/models") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "collaboration-model" }] }));
    return;
  }

  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    response.writeHead(404).end();
    return;
  }

  completionCount += 1;
  response.writeHead(200, { "content-type": "application/json" });
  if (completionCount === 1) {
    response.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content:
                `not-json ${rawProviderBodyMarker} ${chainOfThoughtMarker}`,
            },
          },
        ],
        usage: {
          completion_tokens: 7,
          prompt_tokens: 11,
          total_tokens: 18,
        },
      }),
    );
    return;
  }
  if (completionCount === 2) {
    response.end(
      JSON.stringify(
        turn({
          claim: { clientKey: "implementation", source: "proposed" },
          disposition: {
            reason: "The implementation specialist should review the task.",
            summary: "A concrete task was proposed and claimed.",
            targetAgentId: betaAgentId,
            type: "handoff",
          },
          message: "I split the mission into one implementation task.",
          tasks: [
            {
              clientKey: "implementation",
              dependsOnKeys: [],
              description: "Implement and verify the collaboration smoke path.",
              title: "Implement collaboration path",
            },
          ],
        }),
      ),
    );
    return;
  }
  if (completionCount === 3) {
    response.end(
      JSON.stringify(
        turn({
          claim: null,
          disposition: {
            options: ["Proceed with the verified path", "Revise the task"],
            question: "Should the team proceed with the verified path?",
            type: "decision_request",
          },
          message: "The implementation path is ready for owner confirmation.",
          tasks: [],
        }),
      ),
    );
    return;
  }
  if (completionCount === 4) {
    response.end(
      JSON.stringify(
        turn({
          claim: null,
          disposition: { type: "plan_ready" },
          message: "Both agents contributed; the plan is ready.",
          tasks: [],
        }),
      ),
    );
    return;
  }

  response.writeHead(500, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: "unexpected completion" }));
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

const serverCommand = {
  args: [
    resolve("node_modules", "next", "dist", "bin", "next"),
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
      COCKPIT_MASTER_KEY: masterKey,
      COCKPIT_ALLOW_SCRIPTED_PICKER: "1",
      COCKPIT_SCRIPTED_DIRECTORY: workspaceDirectory,
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
      throw new Error(`Collaboration app exited before readiness.\n${serverOutput}`);
    }
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
    } catch {
      // The isolated Next.js app is still starting.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  throw new Error(`Collaboration app did not become ready.\n${serverOutput}`);
}

async function restartAppServer() {
  stopAppServer();
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
  startAppServer();
  await waitForApp();
}

async function navigateAfterRestart(page, href) {
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await page.goto(`${baseUrl}${href}`, {
        waitUntil: "domcontentloaded",
      });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
    }
  }
  throw lastError;
}

async function createSkill(page, name, description, instructions) {
  await page.getByRole("tab", { name: "技能" }).click();
  await page.getByRole("button", { name: "创建新技能" }).click();
  await page.getByLabel("技能名称").fill(name);
  await page.getByLabel("技能说明").fill(description);
  await page.getByLabel("指令正文").fill(instructions);
  await page.getByRole("button", { name: "创建技能" }).click();
  await page.getByRole("heading", { name }).waitFor();
}

async function createAgent(page, {
  accent,
  avatar,
  name,
  skill,
  template,
}) {
  await page.getByRole("tab", { name: "Agent" }).click();
  await page.getByRole("button", { name: "创建 Agent" }).click();
  await page.getByLabel("创建方式").selectOption(template);
  await page.getByLabel("Agent 名称").fill(name);
  await page
    .getByLabel("模型服务", { exact: true })
    .selectOption({ label: "Collaboration Local Provider" });
  await page.getByRole("checkbox", { name: skill }).check();
  await page.getByLabel("Token 预算").fill("24000");
  await page.getByLabel("接力轮次").fill("8");
  await page.getByLabel("头像文字").fill(avatar);
  await page.getByLabel("强调色").selectOption(accent);
  await page.getByRole("button", { name: "保存 Agent" }).click();
  await page.getByRole("heading", { name }).waitFor();
}

async function createTeam(page) {
  await page.goto(`${baseUrl}/team`, { waitUntil: "networkidle" });
  await page.getByRole("tab", { name: "模型服务" }).click();
  await page.getByRole("button", { name: "创建模型服务" }).click();
  await page.getByLabel("服务名称").fill("Collaboration Local Provider");
  await page.getByLabel("Base URL").fill(providerBaseUrl);
  await page.getByLabel("默认模型").fill("collaboration-model");
  await page.getByLabel("API key").fill(apiKey);
  await page
    .getByRole("checkbox", { name: /HTTP 会明文传输凭据/ })
    .check();
  await page.getByRole("button", { name: "验证连接" }).click();
  await page
    .getByText("已验证模型 collaboration-model", { exact: true })
    .waitFor();
  await page.getByRole("button", { name: "保存服务" }).click();
  await page.getByText("模型服务已保存。", { exact: true }).waitFor();

  await createSkill(
    page,
    "Alpha Collaboration Skill",
    "Private planning instructions",
    `Plan the mission using ${alphaPrivate}.`,
  );
  await createSkill(
    page,
    "Beta Collaboration Skill",
    "Private implementation instructions",
    `Review the implementation using ${betaPrivate}.`,
  );
  await createAgent(page, {
    accent: "rose",
    avatar: "甲",
    name: "Collaboration Alpha",
    skill: "Alpha Collaboration Skill",
    template: "planner",
  });
  await createAgent(page, {
    accent: "gold",
    avatar: "乙",
    name: "Collaboration Beta",
    skill: "Beta Collaboration Skill",
    template: "builder",
  });

  const agents = await page.evaluate(async () => {
    return (await (await fetch("/api/agents")).json()).agents;
  });
  alphaAgentId = agents.find((agent) => agent.name === "Collaboration Alpha").id;
  betaAgentId = agents.find((agent) => agent.name === "Collaboration Beta").id;
  assert.ok(alphaAgentId);
  assert.ok(betaAgentId);
  assert.notEqual(alphaAgentId, betaAgentId);
}

async function openFolderProject(page, headingName) {
  await page.getByRole("button", { name: "打开文件夹" }).first().click();
  await page.waitForURL(/\/projects\/[^/]+$/);
  await page.getByRole("heading", { name: headingName }).waitFor();
}

async function createMissionViaApi(page, title, goal) {
  const payload = await page.evaluate(async ({ goalText, titleText }) => {
    const projectId = new URL(window.location.href).pathname.split("/").at(-1);
    const members = await (await fetch(`/api/projects/${projectId}/members`)).json();
    const response = await fetch(`/api/projects/${projectId}/mission`, {
      body: JSON.stringify({
        expectedVersion: 0,
        goal: goalText,
        operationId: crypto.randomUUID(),
        title: titleText,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const body = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(body));
    return body;
  }, { goalText: goal, titleText: title });
  assert.equal(payload.mission.title, title);
}

async function createProjectContext(page) {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await openFolderProject(page, "workspace");

  const members = page.getByRole("group", { name: "平等项目成员" });
  await members
    .getByRole("checkbox", { name: /Collaboration Alpha/ })
    .check();
  await members
    .getByRole("checkbox", { name: /Collaboration Beta/ })
    .check();
  await page.getByRole("button", { name: "保存成员" }).click();
  await page.getByText("项目成员已保存。", { exact: true }).waitFor();

  await createMissionViaApi(
    page,
    "Collaboration Smoke Mission",
    "Produce a verified two-agent implementation plan",
  );

  return page.evaluate(() =>
    new URL(window.location.href).pathname.split("/").at(-1));
}

async function createThread(page, title, memberNames) {
  await page.getByRole("button", { name: "创建对话" }).first().click();
  const dialog = page.getByRole("dialog", { name: "创建对话" });
  await dialog.getByRole("textbox", { name: "对话标题" }).fill(title);
  for (const memberName of memberNames) {
    await dialog.getByLabel(memberName).check();
  }
  await dialog.getByRole("button", { name: "创建对话", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  await page.waitForURL((url) => Boolean(url.searchParams.get("thread")));
  return new URL(page.url()).searchParams.get("thread");
}

async function readCollaboration(page, projectId, threadId) {
  return page.evaluate(async ({ id, selectedThreadId }) => {
    const base = `/api/projects/${id}/threads/${selectedThreadId}`;
    const initial = await (await fetch(base)).json();
    const selectedRunId =
      new URL(window.location.href).searchParams.get("run") ??
      initial.runs?.[0]?.id ??
      null;
    if (!selectedRunId) {
      return { pendingDecision: null, run: null, usage: null };
    }
    const detail = await (
      await fetch(`${base}?run=${encodeURIComponent(selectedRunId)}`)
    ).json();
    const timeline = [];
    let after = 0;
    while (true) {
      const suffix = after > 0 ? `?after=${after}` : "";
      const page = await (
        await fetch(
          `${base}/runs/${encodeURIComponent(selectedRunId)}/timeline${suffix}`,
        )
      ).json();
      timeline.push(...page.items);
      if (page.nextAfter === null) break;
      after = page.nextAfter;
    }
    const answeredDecisionIds = new Set(
      timeline
        .filter((event) => event.type === "decision_answered")
        .map((event) => event.payload.decisionId),
    );
    const pendingDecisionEvent = timeline.findLast(
      (event) =>
        event.type === "decision_requested" &&
        !answeredDecisionIds.has(event.payload.decisionId),
    );
    const usageByAgent = new Map();
    let completionTokens = 0;
    let promptTokens = 0;
    let repairCalls = 0;
    let totalTokens = 0;
    let unreportedCalls = 0;
    for (const event of timeline) {
      if (event.type !== "usage_recorded") continue;
      if (event.payload.kind === "repair") repairCalls += 1;
      if (!event.payload.reported) {
        unreportedCalls += 1;
        continue;
      }
      completionTokens += event.payload.completionTokens;
      promptTokens += event.payload.promptTokens;
      totalTokens += event.payload.totalTokens;
      if (event.actorId) usageByAgent.set(event.actorId, true);
    }
    return {
      pendingDecision: pendingDecisionEvent
        ? { id: pendingDecisionEvent.payload.decisionId, status: "open" }
        : null,
      run: detail.selectedRun,
      usage: {
        byAgent: [...usageByAgent.keys()],
        completionTokens,
        promptTokens,
        repairCalls,
        totalTokens,
        unreportedCalls,
      },
    };
  }, { id: projectId, selectedThreadId: threadId });
}

async function waitForStatus(page, projectId, threadId, status) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const state = await readCollaboration(page, projectId, threadId);
    if (state.run?.status === status) return state;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(`Collaboration did not reach ${status}.`);
}

async function selectMentionByKeyboard(page, memberName) {
  const mention = page.getByRole("combobox", { name: "@成员" });
  await mention.focus();
  await page.keyboard.press("Enter");
  const listbox = page.getByRole("listbox", { name: "项目成员" });
  await listbox.waitFor();
  const optionTexts = await listbox.getByRole("option").allTextContents();
  const memberIndex = optionTexts.findIndex((text) => text.includes(memberName));
  assert.notEqual(memberIndex, -1, `${memberName} must be available to mention`);
  for (let index = 0; index < memberIndex; index += 1) {
    await page.keyboard.press("ArrowDown");
  }
  await page.keyboard.press("Enter");
  await page
    .getByRole("button", { name: `移除 @${memberName}` })
    .waitFor();
}

function countOccurrences(text, needle) {
  return needle ? text.split(needle).length - 1 : 0;
}

let browser;
let evidenceFacingData = "";
try {
  await listen(provider, providerPort);
  startAppServer();
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
    if (url.startsWith(baseUrl) && url.includes("/api/")) {
      productApiBodies.push(await response.text().catch(() => ""));
    }
  });

  await createTeam(page);
  assert.ok(validationToken);
  assert.equal(providerAuthorizationCount, 1);
  const projectId = await createProjectContext(page);
  const threadId = await createThread(
    page,
    "Collaboration smoke thread",
    ["Collaboration Alpha", "Collaboration Beta"],
  );
  assert.ok(threadId);
  await page.reload({ waitUntil: "networkidle" });

  await selectMentionByKeyboard(page, "Collaboration Alpha");
  const composer = page.getByLabel("发送给项目对话");
  await composer.fill("Start the two-agent collaboration plan.");
  await page
    .getByRole("button", { name: "发送并开始首次运行" })
    .focus();
  await page.keyboard.press("Enter");

  const waiting = await waitForStatus(page, projectId, threadId, "waiting_owner");
  assert.equal(waiting.pendingDecision?.status, "open");
  assert.equal(waiting.run.currentAgentId, betaAgentId);
  assert.equal(waiting.usage.repairCalls, 1);
  assert.equal(waiting.usage.totalTokens, 54);

  await selectMentionByKeyboard(page, "Collaboration Alpha");
  await composer.fill("Owner asks Alpha to close the verified plan.");
  await page.getByRole("button", { name: "发送消息" }).focus();
  await page.keyboard.press("Enter");
  await page
    .getByText("Owner asks Alpha to close the verified plan.", { exact: true })
    .waitFor();

  const decisionOption = page.getByRole("radio", {
    name: "Proceed with the verified path",
  });
  await decisionOption.focus();
  await page.keyboard.press("Space");
  await page
    .getByRole("combobox", { name: "回答后交给成员" })
    .selectOption(alphaAgentId);
  await page.getByRole("button", { name: "提交回答" }).focus();
  await page.keyboard.press("Enter");

  const planned = await waitForStatus(page, projectId, threadId, "planned");
  assert.equal(planned.run.currentAgentId, alphaAgentId);
  assert.equal(planned.run.roundCount, 3);
  assert.equal(planned.usage.promptTokens, 44);
  assert.equal(planned.usage.completionTokens, 28);
  assert.equal(planned.usage.totalTokens, 72);
  assert.equal(planned.usage.repairCalls, 1);
  assert.equal(planned.usage.byAgent.length, 2);
  assert.equal(completionCount, 4);

  await page.reload({ waitUntil: "networkidle" });
  await page.getByText("运行状态：planned", { exact: true }).waitFor();
  assert.equal(
    (await readCollaboration(page, projectId, threadId)).run.status,
    "planned",
  );

  const restartHref = `${new URL(page.url()).pathname}${new URL(page.url()).search}`;
  await restartAppServer();
  await navigateAfterRestart(page, restartHref);
  await page
    .getByRole("heading", { name: "Collaboration Smoke Mission" })
    .waitFor();
  await page.getByText("运行状态：planned", { exact: true }).waitFor();
  const recovered = await readCollaboration(page, projectId, threadId);
  assert.equal(recovered.run.status, "planned");
  assert.equal(recovered.run.roundCount, 3);
  assert.equal(recovered.pendingDecision, null);
  assert.equal(recovered.usage.totalTokens, 72);
  console.log("RECOVERY PASS: refresh and process restart restored planned run");

  await page.screenshot({ fullPage: true, path: desktopScreenshot });

  await page.setViewportSize({ height: 844, width: 390 });
  await page.reload({ waitUntil: "networkidle" });
  const editorOpener = page.getByRole("button", { name: "打开编辑" });
  await editorOpener.focus();
  await page.keyboard.press("Enter");
  const editor = page.getByRole("dialog", { name: "任务编辑" });
  await editor.waitFor();
  const chatTab = editor.getByRole("tab", { name: "对话" });
  await chatTab.focus();
  await page.keyboard.press("End");
  const runTab = editor.getByRole("tab", { name: "运行详情" });
  assert.equal(await runTab.getAttribute("aria-selected"), "true");
  const runSurface = editor.getByRole("tabpanel", { name: "运行详情" });
  const narrowLayout = await runSurface.evaluate((surface) => {
    const viewportWidth = document.documentElement.clientWidth;
    const inspect = (element) => {
      const bounds = element.getBoundingClientRect();
      return {
        clientWidth: element.clientWidth,
        height: bounds.height,
        left: bounds.left,
        right: bounds.right,
        scrollWidth: element.scrollWidth,
        width: bounds.width,
      };
    };
    const controls = surface.querySelector('[aria-label="运行控制"]');
    const usage = surface.querySelector('[aria-label="运行用量"]');
    const buttons = controls ? [...controls.querySelectorAll("button")] : [];
    const usageCards = usage
      ? [...usage.querySelectorAll(".metric-grid > div, .usage-agents > li")]
      : [];
    return {
      buttons: buttons.map((button) => ({
        ...inspect(button),
        disabled: button.disabled,
        tabIndex: button.tabIndex,
      })),
      document: {
        clientWidth: viewportWidth,
        scrollWidth: document.documentElement.scrollWidth,
      },
      regions: [surface, controls, usage].filter(Boolean).map(inspect),
      usageCards: usageCards.map(inspect),
      viewportWidth,
    };
  });
  assert.equal(
    narrowLayout.document.scrollWidth <= narrowLayout.document.clientWidth,
    true,
    `narrow document must not overflow: ${JSON.stringify(narrowLayout)}`,
  );
  for (const region of narrowLayout.regions) {
    assert.ok(
      region.scrollWidth <= region.clientWidth
        && region.left >= 0
        && region.right <= narrowLayout.viewportWidth,
      `selected run-detail surface must fit without horizontal overflow: ${JSON.stringify(narrowLayout)}`,
    );
  }
  assert.equal(narrowLayout.buttons.length, 4);
  for (const button of narrowLayout.buttons) {
    assert.ok(
      button.height >= 44
        && button.width >= 44
        && button.left >= 0
        && button.right <= narrowLayout.viewportWidth
        && (button.disabled || button.tabIndex >= 0),
      `run controls must fit, stay >=44px, and remain keyboard reachable when enabled: ${JSON.stringify(narrowLayout)}`,
    );
  }
  assert.ok(narrowLayout.usageCards.length >= 6);
  for (const card of narrowLayout.usageCards) {
    assert.ok(
      card.scrollWidth <= card.clientWidth
        && card.left >= 0
        && card.right <= narrowLayout.viewportWidth,
      `usage cards must fit or wrap in the narrow viewport: ${JSON.stringify(narrowLayout)}`,
    );
  }
  assert.equal(
    await runTab.evaluate((element) => document.activeElement === element),
    true,
    "the keyboard-selected run-detail tab must retain focus",
  );
  await editor.getByText("运行状态：planned", { exact: true }).waitFor();
  await page.screenshot({ fullPage: true, path: narrowScreenshot });
  await page.keyboard.press("Escape");
  await editor.waitFor({ state: "detached" });
  assert.equal(
    await editorOpener.evaluate(
      (element) => document.activeElement === element,
    ),
    true,
  );

  assert.equal(outboundRequests.length, 5);
  assert.equal(providerAuthorizationCount, 5);
  for (const outbound of outboundRequests) {
    assert.equal(outbound.authorization, `Bearer ${apiKey}`);
    assert.ok(
      outbound.url === "/v1/models" ||
        outbound.url === "/v1/chat/completions",
    );
    assert.ok(outbound.method === "GET" || outbound.method === "POST");
  }
  const completionRequests = outboundRequests.filter(
    (request) => request.url === "/v1/chat/completions",
  );
  for (const request of completionRequests) {
    const parsed = JSON.parse(request.body);
    assert.deepEqual(Object.keys(parsed).sort(), [
      "messages",
      "model",
      "response_format",
    ]);
    assert.equal(request.body.includes(apiKey), false);
    assert.equal(request.body.includes(masterKey), false);
    assert.equal(request.body.includes(canonicalWorkspace), false);
  }
  assert.equal(completionRequests[0].body.includes(alphaPrivate), true);
  assert.equal(completionRequests[0].body.includes(betaPrivate), false);
  assert.equal(completionRequests[1].body.includes(alphaPrivate), false);
  assert.equal(completionRequests[1].body.includes(betaPrivate), false);
  assert.equal(completionRequests[2].body.includes(alphaPrivate), false);
  assert.equal(completionRequests[2].body.includes(betaPrivate), true);
  assert.equal(completionRequests[3].body.includes(alphaPrivate), true);
  assert.equal(completionRequests[3].body.includes(betaPrivate), false);
  console.log(
    "OUTBOUND ALLOWLIST PASS: 1 models + 4 chat requests used only expected routes and fields",
  );
  console.log(
    "PRIVATE SEPARATION PASS: primary requests contained current private instructions only; repair contained neither",
  );

  const database = new DatabaseSync(databasePath, { readOnly: true });
  const providerEnvelope = database
    .prepare(
      `SELECT api_key_cipher AS cipher, api_key_iv AS iv, api_key_tag AS tag
       FROM providers`,
    )
    .get();
  const counts = Object.fromEntries(
    [
      "providers",
      "skills",
      "agents",
      "projects",
      "project_memberships",
      "missions",
      "work_items",
      "collaboration_runs",
      "collaboration_attempts",
      "collaboration_model_calls",
      "collaboration_turns",
      "decision_requests",
      "collaboration_messages",
      "collaboration_events",
    ].map((table) => [
      table,
      database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count,
    ]),
  );
  const workItem = database
    .prepare(
      `SELECT status, assignee_agent_id AS assigneeAgentId
       FROM work_items`,
    )
    .get();
  const actionEvents = database
    .prepare(
      `SELECT
         SUM(CASE WHEN type = 'tasks_created' THEN 1 ELSE 0 END) AS tasksCreated,
         SUM(CASE WHEN type = 'task_claimed' THEN 1 ELSE 0 END) AS tasksClaimed,
         SUM(CASE WHEN type = 'handoff' THEN 1 ELSE 0 END) AS handoffs,
         SUM(CASE WHEN type = 'decision_requested' THEN 1 ELSE 0 END) AS decisionsRequested,
         SUM(CASE WHEN type = 'decision_answered' THEN 1 ELSE 0 END) AS decisionsAnswered,
         SUM(CASE WHEN type = 'run_planned' THEN 1 ELSE 0 END) AS runsPlanned
       FROM collaboration_events`,
    )
    .get();
  database.close();

  assert.deepEqual(
    {
      agents: counts.agents,
      attempts: counts.collaboration_attempts,
      decisions: counts.decision_requests,
      memberships: counts.project_memberships,
      missions: counts.missions,
      modelCalls: counts.collaboration_model_calls,
      projects: counts.projects,
      providers: counts.providers,
      runs: counts.collaboration_runs,
      skills: counts.skills,
      turns: counts.collaboration_turns,
      workItems: counts.work_items,
    },
    {
      agents: 2,
      attempts: 3,
      decisions: 1,
      memberships: 2,
      missions: 1,
      modelCalls: 4,
      projects: 1,
      providers: 1,
      runs: 1,
      skills: 2,
      turns: 3,
      workItems: 1,
    },
  );
  assert.equal(workItem.status, "in_progress");
  assert.equal(workItem.assigneeAgentId, alphaAgentId);
  assert.deepEqual({ ...actionEvents }, {
    decisionsAnswered: 1,
    decisionsRequested: 1,
    handoffs: 1,
    runsPlanned: 1,
    tasksClaimed: 1,
    tasksCreated: 1,
  });

  const domText = await page.evaluate(
    () =>
      `${document.documentElement.innerHTML}\n${[
        ...document.querySelectorAll("input,textarea"),
      ]
        .map((input) => input.value)
        .join("\n")}`,
  );
  const evidenceLogs = readdirSync(evidenceDirectory)
    .filter((name) => name.endsWith(".log"))
    .map((name) => readFileSync(join(evidenceDirectory, name), "utf8"))
    .join("\n");
  evidenceFacingData = [
    "OUTBOUND ALLOWLIST PASS",
    "PRIVATE SEPARATION PASS",
    "SECURITY SCAN PASS",
    "RECOVERY PASS",
    "BROWSER PASS",
    JSON.stringify(counts),
  ].join("\n");
  const securitySurfaces = {
    domText,
    evidenceFacingData: `${evidenceFacingData}\n${evidenceLogs}`,
    productApiBodies: productApiBodies.join("\n"),
    serverOutput,
  };
  const forbiddenValues = [
    apiKey,
    masterKey,
    validationToken,
    `Bearer ${apiKey}`,
    providerEnvelope.cipher,
    providerEnvelope.iv,
    providerEnvelope.tag,
    rawProviderBodyMarker,
    chainOfThoughtMarker,
  ];
  let forbiddenOccurrences = 0;
  for (const surface of Object.values(securitySurfaces)) {
    for (const forbidden of forbiddenValues) {
      forbiddenOccurrences += countOccurrences(surface, forbidden);
    }
  }
  assert.equal(forbiddenOccurrences, 0);
  console.log(
    "SECURITY SCAN PASS: key/Authorization/master/cipher/token/raw body/CoT occurrences=0 across product API, DOM, logs, and evidence-facing data",
  );
  console.log(
    `BROWSER PASS: providers=${counts.providers} agents=${counts.agents} projects=${counts.projects} memberships=${counts.project_memberships} missions=${counts.missions} workItems=${counts.work_items} attempts=${counts.collaboration_attempts} modelCalls=${counts.collaboration_model_calls} turns=${counts.collaboration_turns} decisions=${counts.decision_requests} messages=${counts.collaboration_messages} events=${counts.collaboration_events}`,
  );
  console.log(`DESKTOP SCREENSHOT: ${desktopScreenshot}`);
  console.log(`NARROW SCREENSHOT: ${narrowScreenshot}`);
} finally {
  await browser?.close();
  stopAppServer();
  if (provider.listening) await close(provider);
  rmSync(temporaryDirectory, { force: true, recursive: true });
}
