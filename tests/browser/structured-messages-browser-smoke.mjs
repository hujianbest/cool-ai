import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
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
const seed = randomBytes(4).readUInt32BE();
const appPort = 14_000 + (seed % 8_000);
const providerPort = 24_000 + (seed % 8_000);
const baseUrl = `http://${host}:${appPort}`;
const providerBaseUrl = `http://${host}:${providerPort}/v1`;
const temporaryDirectory = mkdtempSync(join(tmpdir(), "cool-ai-structured-smoke-"));
const databasePath = join(temporaryDirectory, "structured.sqlite");
const workspaceDirectory = join(temporaryDirectory, "workspace");
mkdirSync(workspaceDirectory);
const privateHostPath = join(temporaryDirectory, "PRIVATE_HOST_PATH_NEVER_PUBLIC.txt");
const masterKey = randomBytes(32).toString("base64url");
const apiKey = `structured-key-${randomBytes(18).toString("base64url")}`;
const rawProviderMarker = `RAW_PROVIDER_${randomBytes(12).toString("hex")}`;
const privatePromptMarker = `PRIVATE_PROMPT_${randomBytes(12).toString("hex")}`;
const evidenceDirectory = resolve(
  "features",
  "015-structured-messages-inline-decisions",
  "evidence",
);
const evidence = {
  desktop: join(evidenceDirectory, "structured-messages-desktop.png"),
  dark: join(evidenceDirectory, "structured-messages-dark.png"),
  narrow: join(evidenceDirectory, "structured-messages-narrow.png"),
  invalid: join(evidenceDirectory, "structured-messages-invalid.png"),
  reconciliation: join(evidenceDirectory, "structured-messages-reconciliation.png"),
  results: join(evidenceDirectory, "structured-messages-results.json"),
};
const stableConfig = ["next-env.d.ts", "tsconfig.json"]
  .map((path) => resolve(path))
  .filter(existsSync)
  .map((path) => ({ content: readFileSync(path, "utf8"), path }));
const browserExecutable = [
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
].find((candidate) => candidate && existsSync(candidate));

mkdirSync(evidenceDirectory, { recursive: true });
for (const path of Object.values(evidence)) rmSync(path, { force: true });

const results = {
  assertions: [],
  axe: [],
  evidence: Object.values(evidence).map((path) => path.replaceAll("\\", "/")),
  status: "running",
};
const productApiBodies = [];
let appServer;
let browser;
let serverOutput = "";
let providerCalls = 0;
let alphaAgentId = "";
let betaAgentId = "";

function pass(name, details = {}) {
  results.assertions.push({ name, status: "passed", ...details });
}

function turn(value) {
  return {
    choices: [{ message: { content: JSON.stringify(value) } }],
    usage: { completion_tokens: 7, prompt_tokens: 11, total_tokens: 18 },
    marker: rawProviderMarker,
  };
}

async function requestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

const provider = createServer(async (request, response) => {
  const raw = await requestBody(request);
  assert.equal(request.headers.authorization, `Bearer ${apiKey}`);
  assert.equal(raw.includes(apiKey), false);
  response.writeHead(200, { "content-type": "application/json" });
  if (request.method === "GET" && request.url === "/v1/models") {
    response.end(JSON.stringify({ data: [{ id: "structured-model" }] }));
    return;
  }
  assert.equal(request.method, "POST");
  assert.equal(request.url, "/v1/chat/completions");
  providerCalls += 1;
  if (providerCalls === 2) {
    response.end(JSON.stringify(turn({
      blocks: [],
      claim: null,
      disposition: { type: "plan_ready" },
      message: "Structured smoke plan is complete.",
      tasks: [],
    })));
    return;
  }
  response.end(JSON.stringify(turn({
    blocks: [
      {
        actions: ["accept", "reject"],
        blockRevision: 1,
        blockSchemaVersion: 1,
        blockType: "proposal",
        body: "Accept this immutable proposal.",
        logicalBlockId: "smoke-proposal-accept",
        title: "Accept Proposal",
      },
      {
        actions: ["accept", "reject"],
        blockRevision: 1,
        blockSchemaVersion: 1,
        blockType: "proposal",
        body: "Reject this immutable proposal.",
        logicalBlockId: "smoke-proposal-reject",
        title: "Reject Proposal",
      },
      {
        actions: ["check_item", "uncheck_item"],
        blockRevision: 1,
        blockSchemaVersion: 1,
        blockType: "checklist",
        items: [
          { id: "verify-source", text: "Verify frozen source" },
          { id: "verify-navigation", text: "Verify safe navigation" },
        ],
        logicalBlockId: "smoke-checklist",
        title: "Verification Checklist",
      },
    ],
    claim: { clientKey: "structured-work", source: "proposed" },
    disposition: {
      reason: "A second agent verifies the immutable result.",
      summary: "Hand off the structured smoke verification.",
      targetAgentId: betaAgentId,
      type: "handoff",
    },
    message: "Agent published immutable structured decisions.",
    tasks: [{
      clientKey: "structured-work",
      dependsOnKeys: [],
      description: "Verify structured decisions and safe projections.",
      title: "Verify structured messages",
    }],
  })));
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

function startApp() {
  serverOutput = "";
  appServer = spawn(
    process.execPath,
    [
      resolve("node_modules", "next", "dist", "bin", "next"),
      "dev",
      "--webpack",
      "--hostname",
      host,
      "--port",
      String(appPort),
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        COCKPIT_DB_PATH: databasePath,
        COCKPIT_MASTER_KEY: masterKey,
        NEXT_DIST_DIR: `.next-structured-smoke-${process.pid}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  appServer.stdout.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });
  appServer.stderr.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });
}

function stopApp() {
  if (!appServer?.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(appServer.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
  } else {
    appServer.kill("SIGTERM");
  }
  appServer = undefined;
}

async function waitForApp() {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (appServer.exitCode !== null) {
      throw new Error(`Structured app exited before readiness.\n${serverOutput}`);
    }
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
    } catch {
      // Isolated product process is still starting.
    }
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error(`Structured app did not become ready.\n${serverOutput}`);
}

async function restartApp() {
  stopApp();
  await new Promise((done) => setTimeout(done, 800));
  startApp();
  await waitForApp();
}

async function api(page, path, init) {
  return page.evaluate(async ({ init, path }) => {
    const response = await fetch(path, init);
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { body, status: response.status };
  }, { init, path });
}

async function axe(page, state) {
  const scan = await new AxeBuilder({ page }).analyze();
  const blocking = scan.violations
    .filter(({ impact }) => impact === "critical" || impact === "serious")
    .map(({ id, impact, nodes }) => ({
      id,
      impact,
      targets: nodes.map((node) => node.target),
    }));
  const contrast = scan.violations
    .filter(({ id }) => id === "color-contrast")
    .flatMap(({ nodes }) => nodes.map((node) => node.target));
  results.axe.push({
    blocking,
    contrast,
    state,
    violationCount: scan.violations.length,
  });
  assert.deepEqual(blocking, [], `${state}: axe critical/serious must be 0`);
  assert.deepEqual(contrast, [], `${state}: contrast must be 0`);
}

async function createAgent(page, name, template, avatar, accent) {
  await page.getByRole("tab", { name: "Agent" }).click();
  await page.getByRole("button", { name: "创建 Agent" }).click();
  await page.getByLabel("创建方式").selectOption(template);
  await page.getByLabel("Agent 名称").fill(name);
  await page.getByLabel("模型服务", { exact: true }).selectOption({
    label: "Structured Local Provider",
  });
  await page.getByLabel("头像文字").fill(avatar);
  await page.getByLabel("强调色").selectOption(accent);
  await page.getByRole("button", { name: "保存 Agent" }).click();
  await page.getByRole("heading", { name }).waitFor();
}

async function provision(page) {
  await page.goto(`${baseUrl}/team`, { waitUntil: "networkidle" });
  await page.getByRole("tab", { name: "模型服务" }).click();
  await page.getByRole("button", { name: "创建模型服务" }).click();
  await page.getByLabel("服务名称").fill("Structured Local Provider");
  await page.getByLabel("Base URL").fill(providerBaseUrl);
  await page.getByLabel("默认模型").fill("structured-model");
  await page.getByLabel("API key").fill(apiKey);
  await page.getByRole("checkbox", { name: /HTTP 会明文传输凭据/ }).check();
  await page.getByRole("button", { name: "验证连接" }).click();
  await page.getByText("已验证模型 structured-model", { exact: true }).waitFor();
  await page.getByRole("button", { name: "保存服务" }).click();
  await page.getByText("模型服务已保存。", { exact: true }).waitFor();
  await createAgent(page, "Structured Alpha", "planner", "SA", "rose");
  await createAgent(page, "Structured Beta", "builder", "SB", "gold");
  const agents = await api(page, "/api/agents");
  alphaAgentId = agents.body.agents.find(({ name }) => name === "Structured Alpha").id;
  betaAgentId = agents.body.agents.find(({ name }) => name === "Structured Beta").id;
  assert.ok(alphaAgentId && betaAgentId);
}

async function createProject(page) {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "打开文件夹" }).first().click();
  await page.getByLabel("文件夹路径").fill(workspaceDirectory);
  await page.locator("form")
    .filter({ has: page.getByLabel("文件夹路径") })
    .getByRole("button", { name: "打开文件夹" })
    .click();
  await page.waitForURL(/\/projects\/[^/]+$/);
  await page.getByRole("heading", { name: "workspace" }).waitFor();
  const projectId = new URL(page.url()).pathname.split("/").at(-1);
  const members = page.getByRole("group", { name: "平等项目成员" });
  await members.getByRole("checkbox", { name: /Structured Alpha/ }).check();
  await members.getByRole("checkbox", { name: /Structured Beta/ }).check();
  await page.getByRole("button", { name: "保存成员" }).click();
  await page.getByText("项目成员已保存。", { exact: true }).waitFor();
  await page.getByRole("button", { name: "创建使命" }).click();
  await page.getByLabel("使命标题").fill("Structured Browser Mission");
  await page.getByLabel("使命目标").fill("Verify immutable structured messages");
  await page.getByRole("button", { name: "创建使命" }).click();
  await page.getByRole("heading", { name: "Structured Browser Mission" }).waitFor();
  return projectId;
}

async function createThread(page) {
  await page.getByRole("button", { name: "创建线程" }).first().click();
  const dialog = page.getByRole("dialog", { name: "创建线程" });
  await dialog.getByLabel("线程标题").fill("Structured smoke thread");
  await dialog.getByLabel("Structured Alpha").check();
  await dialog.getByLabel("Structured Beta").check();
  await dialog.getByRole("button", { name: "创建线程", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  await page.waitForURL((url) => Boolean(url.searchParams.get("thread")));
  return new URL(page.url()).searchParams.get("thread");
}

async function waitForRun(page, projectId, threadId, status) {
  const deadline = Date.now() + 60_000;
  let last = null;
  while (Date.now() < deadline) {
    const response = await api(page, `/api/projects/${projectId}/threads/${threadId}`);
    last = response.body;
    const run = last.runs?.find((candidate) => candidate.status === status);
    if (run) return run;
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error(`Run did not reach ${status}: ${JSON.stringify(last)}`);
}

async function allFacts(page, projectId, threadId) {
  const items = [];
  let after = 0;
  do {
    const response = await api(
      page,
      `/api/projects/${projectId}/threads/${threadId}/facts?after=${after}&limit=100`,
    );
    assert.equal(response.status, 200);
    items.push(...response.body.items);
    after = response.body.nextAfter ?? 0;
  } while (after > 0);
  return items;
}

function blockByLogicalId(facts, id) {
  return facts.flatMap((fact) => fact.message?.blocks ?? [])
    .find((block) => block.logicalBlockId === id);
}

function inspectDatabase() {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const counts = Object.fromEntries([
      "business_action_receipts",
      "collaboration_operations",
      "collaboration_thread_facts",
      "execution_approvals",
      "inline_decisions",
      "structured_message_blocks",
    ].map((table) => [
      table,
      database.prepare(`SELECT count(*) AS count FROM ${table}`).get().count,
    ]));
    const facts = database.prepare(`
      SELECT id,sequence,type,message_id AS messageId,inline_decision_id AS decisionId
      FROM collaboration_thread_facts ORDER BY sequence,id
    `).all();
    const blocks = database.prepare(`
      SELECT id,logical_block_id AS logicalId,block_schema_version AS schemaVersion,
             source_kind AS sourceKind,source_id AS sourceId,
             source_entity_version AS sourceVersion
      FROM structured_message_blocks ORDER BY message_id,position
    `).all();
    const states = database.prepare(`
      SELECT block_id AS blockId,current_state_version AS version
      FROM structured_message_state_heads ORDER BY block_id
    `).all();
    return { blocks, counts, facts, states };
  } finally {
    database.close();
  }
}

function runFixture(mode, tuple = {}) {
  const child = spawnSync(
    process.platform === "win32" ? "cmd.exe" : "npx",
    process.platform === "win32"
      ? [
          "/d",
          "/s",
          "/c",
          "npx vite-node --config vitest.config.ts tests/fixtures/structured-messages/browser.ts",
        ]
      : [
          "vite-node",
          "--config",
          "vitest.config.ts",
          "tests/fixtures/structured-messages/browser.ts",
        ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        COCKPIT_MASTER_KEY: masterKey,
        STRUCTURED_SMOKE_AGENT_ID: tuple.agentId ?? "",
        STRUCTURED_SMOKE_DB_PATH: databasePath,
        STRUCTURED_SMOKE_FIXTURE_MODE: mode,
        STRUCTURED_SMOKE_PRIVATE_PATH: privateHostPath,
        STRUCTURED_SMOKE_PROJECT_ID: tuple.projectId ?? "",
        STRUCTURED_SMOKE_RUN_ID: tuple.runId ?? "",
        STRUCTURED_SMOKE_THREAD_ID: tuple.threadId ?? "",
      },
      windowsHide: true,
    },
  );
  assert.equal(
    child.status,
    0,
    `Structured fixture ${mode} failed\n${child.stdout}\n${child.stderr}`,
  );
  return child.stdout.trim();
}

try {
  await listen(provider, providerPort);
  startApp();
  await waitForApp();
  browser = await chromium.launch({
    headless: true,
    ...(browserExecutable ? { executablePath: browserExecutable } : {}),
  });
  const context = await browser.newContext({ viewport: { height: 1050, width: 1500 } });
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  page.on("response", async (response) => {
    if (response.url().startsWith(baseUrl) && response.url().includes("/api/")) {
      productApiBodies.push(await response.text().catch(() => ""));
    }
  });

  await provision(page);
  const projectId = await createProject(page);
  const threadId = await createThread(page);
  await page.goto(
    `${baseUrl}/projects/${projectId}?thread=${encodeURIComponent(threadId)}`,
    { waitUntil: "networkidle" },
  );
  const emptyThread = await api(page, `/api/projects/${projectId}/threads/${threadId}`);
  assert.deepEqual(emptyThread.body.runs, []);
  pass("empty-state");
  const composer = page.getByLabel("发送给项目群聊");
  try {
    await composer.waitFor({ timeout: 10_000 });
  } catch (error) {
    for (const name of ["重试加载运行", "重试加载群聊"]) {
      const retry = page.getByRole("button", { name });
      if (await retry.count() > 0 && await retry.first().isVisible()) {
        await retry.first().click();
      }
    }
    try {
      await composer.waitFor({ timeout: 20_000 });
      pass("load-error-retry-recovered");
    } catch (retryError) {
      throw new Error(
        `Composer unavailable at ${page.url()}\n${serverOutput}\n${(await page.locator("body").innerText()).slice(0, 8_000)}`,
        { cause: retryError ?? error },
      );
    }
  }
  await composer.fill("Legacy plain text starts the structured run.");
  await page.getByRole("button", { name: "发送并开始首次运行" }).click();
  const run = await waitForRun(page, projectId, threadId, "planned");
  assert.equal(providerCalls, 2);
  await page.getByRole("heading", { name: "Accept Proposal" }).waitFor();
  await page.getByRole("heading", { name: "Verification Checklist" }).waitFor();
  await page.getByText("Legacy plain text starts the structured run.", { exact: true }).waitFor();
  pass("provider-published-proposal-checklist-legacy-text", { runId: run.id });

  const initialFacts = await allFacts(page, projectId, threadId);
  const acceptBlock = blockByLogicalId(initialFacts, "smoke-proposal-accept");
  const rejectBlock = blockByLogicalId(initialFacts, "smoke-proposal-reject");
  const checklistBlock = blockByLogicalId(initialFacts, "smoke-checklist");
  assert.ok(acceptBlock && rejectBlock && checklistBlock);

  const stalePage = await context.newPage();
  stalePage.setDefaultTimeout(60_000);
  const frozenFactsBody = JSON.stringify({ items: initialFacts, nextAfter: null });
  await stalePage.route(
    `**/api/projects/${projectId}/threads/${threadId}/facts**`,
    (route) => route.fulfill({
      body: frozenFactsBody,
      contentType: "application/json",
      status: 200,
    }),
  );
  await stalePage.goto(page.url(), { waitUntil: "networkidle" });
  await stalePage.getByRole("heading", { name: "Reject Proposal" }).waitFor();

  const acceptEndpoint = `/api/projects/${projectId}/threads/${threadId}/runs/${run.id}`
    + `/messages/${acceptBlock.source.messageId}/blocks/${acceptBlock.id}/decision`;
  let unknownWriteBody = "";
  await page.route(`**${acceptEndpoint}`, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    unknownWriteBody = route.request().postData() ?? "";
    const committed = await page.request.fetch(route.request().url(), {
      data: unknownWriteBody,
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    assert.equal(committed.status(), 200);
    await route.abort("failed");
  }, { times: 1 });
  await page.getByRole("button", { name: "接受 Proposal" }).first().click();
  await page.getByLabel("Proposal 决定结果").waitFor();
  assert.ok(unknownWriteBody);
  pass("unknown-write-get-only-reconciliation");

  const replay = await api(page, acceptEndpoint, {
    body: unknownWriteBody,
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(replay.status, 200);
  const afterReplay = inspectDatabase();
  assert.equal(afterReplay.counts.inline_decisions, 1);
  assert.equal(afterReplay.counts.business_action_receipts, 1);
  pass("same-operation-replay-no-duplicate");

  await page.getByRole("button", { name: "拒绝 Proposal" }).last().click();
  await page.getByLabel("Proposal 决定结果").last().waitFor();

  const checklist = page.getByRole("button", { name: "勾选 Verify frozen source" });
  await checklist.focus();
  await page.keyboard.press("Enter");
  await page.getByLabel("Checklist 决定结果").waitFor();

  const staleRequests = [];
  stalePage.on("request", (request) => {
    if (request.url().includes("/api/")) {
      staleRequests.push({
        method: request.method(),
        postData: request.postData(),
        url: request.url(),
      });
    }
  });
  let releaseHead;
  const headGate = new Promise((done) => {
    releaseHead = done;
  });
  await stalePage.route(
    `**/api/projects/${projectId}/threads/${threadId}/runs/${run.id}`
      + `/messages/${checklistBlock.source.messageId}/blocks/${checklistBlock.id}`,
    async (route) => {
      await headGate;
      await route.continue();
    },
    { times: 1 },
  );
  const beforeStale = inspectDatabase();
  await stalePage.getByRole("button", { name: "勾选 Verify safe navigation" }).click();
  const staleCard = stalePage.getByRole("region", {
    exact: true,
    name: "Checklist：Verification Checklist",
  });
  const staleAlert = staleCard.getByRole("alert");
  await staleAlert.waitFor();
  assert.match(await staleAlert.innerText(), /正在读取最新状态/);
  assert.equal(
    await staleAlert.evaluate((node) => document.activeElement === node),
    true,
  );
  assert.equal(
    await staleCard.getByRole("button", { name: "勾选 Verify safe navigation" }).isDisabled(),
    true,
  );
  assert.equal(
    await staleCard.getByRole("button", { name: "勾选 Verify frozen source" }).isDisabled(),
    true,
  );
  assert.equal(staleRequests.filter(({ method }) => method === "POST").length, 1);
  releaseHead();
  await staleCard.getByText(/state 2/).waitFor();
  assert.match(await staleAlert.innerText(), /最新完整 Checklist/);
  assert.match(await staleAlert.innerText(), /状态版本 2/);
  assert.equal(
    await staleAlert.evaluate((node) => document.activeElement === node),
    true,
  );
  await staleCard.getByRole("button", { name: "取消勾选 Verify frozen source" }).waitFor();
  const retryAction = staleCard.getByRole("button", { name: "勾选 Verify safe navigation" });
  assert.equal(await retryAction.isDisabled(), false);
  assert.equal(staleRequests.filter(({ method }) => method === "POST").length, 1);
  await axe(stalePage, "desktop light stale reconciliation latest-ready");
  await stalePage.screenshot({ fullPage: true, path: evidence.reconciliation });
  pass("two-page-conflict-latest-ready-zero-auto-post-focus");

  await retryAction.click();
  await stalePage.getByLabel("Checklist 决定结果").waitFor();
  assert.match(
    await stalePage.getByLabel("Checklist 决定结果").innerText(),
    /2 → 3/,
  );
  assert.equal(await retryAction.isDisabled(), true);
  const stalePosts = staleRequests.filter(({ method }) => method === "POST");
  assert.equal(stalePosts.length, 2);
  const [conflictPost, retryPost] = stalePosts.map(({ postData }) => JSON.parse(postData));
  assert.equal(conflictPost.expectedStateVersion, 1);
  assert.equal(retryPost.expectedStateVersion, 2);
  assert.equal(retryPost.action, "check_item");
  assert.equal(retryPost.itemId, "verify-navigation");
  assert.notEqual(retryPost.operationId, conflictPost.operationId);
  assert.equal(
    staleRequests.filter(({ method, url }) =>
      method === "GET" && url.endsWith(`/blocks/${checklistBlock.id}`)
    ).length,
    1,
  );
  const afterStale = inspectDatabase();
  assert.equal(
    afterStale.counts.inline_decisions,
    beforeStale.counts.inline_decisions + 1,
  );
  assert.equal(
    afterStale.counts.business_action_receipts,
    beforeStale.counts.business_action_receipts + 1,
  );
  pass("explicit-retry-single-new-operation-latest-version");
  await stalePage.close();
  await page.reload({ waitUntil: "networkidle" });
  const decidedProposals = page.getByText(/Proposal 已决定为/);
  await decidedProposals.first().waitFor();
  const proposalActions = page.getByRole("button", { name: /^(接受|拒绝) Proposal$/ });
  assert.equal(await proposalActions.count(), 4);
  for (const action of await proposalActions.all()) assert.equal(await action.isDisabled(), true);
  const uncheck = page.getByRole("button", { name: "取消勾选 Verify frozen source" });
  await uncheck.focus();
  await page.keyboard.press("Enter");
  await page.getByLabel("Checklist 决定结果").waitFor();
  pass("checklist-keyboard-check-uncheck-success-focus");

  const beforeSources = inspectDatabase();
  runFixture("sources", {
    agentId: alphaAgentId,
    projectId,
    runId: run.id,
    threadId,
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForURL((url) => url.searchParams.get("run") === run.id);
  await page.getByRole("heading", { name: "Frozen Diff Preview" }).waitFor();
  await page.getByRole("heading", { name: "Frozen File Reference" }).waitFor();
  await page.getByRole("heading", { name: "Frozen Handoff Card" }).waitFor();
  await page.getByText("不支持的结构化消息", { exact: true }).waitFor();
  assert.equal(await page.getByText("此版本不可执行；其他协作事实仍可继续阅读。").count(), 1);
  const fileCard = page.locator('section[aria-label="File Reference：Frozen File Reference"]');
  await fileCard.getByText("safe-report.txt", { exact: true }).waitFor();
  pass("file-reference-card-shows-frozen-name-before-source-fetch");

  for (const name of [
    "Proposal：Accept Proposal",
    "Proposal：Reject Proposal",
    "Checklist：Verification Checklist",
    "Diff Preview：Frozen Diff Preview",
    "File Reference：Frozen File Reference",
    "Handoff Card：Frozen Handoff Card",
  ]) {
    await page.getByRole("region", { exact: true, name }).waitFor();
  }
  pass("five-formal-type-region-names");

  let releaseSource;
  const sourceGate = new Promise((done) => {
    releaseSource = done;
  });
  await page.route(
    `**/api/projects/${projectId}/threads/${threadId}/runs/${run.id}/messages/*/blocks/*/source`,
    async (route) => {
      await sourceGate;
      await route.continue();
    },
    { times: 1 },
  );
  const diffRegion = page.getByRole("region", {
    exact: true,
    name: "Diff Preview：Frozen Diff Preview",
  });
  await page.getByRole("button", { name: "加载 Diff Preview 安全来源" }).click();
  await page.getByText("正在核对来源，请稍候…", { exact: true }).waitFor();
  assert.equal(await diffRegion.getAttribute("aria-busy"), "true");
  releaseSource();
  await page.getByLabel("脱敏 Diff Preview").waitFor();
  assert.equal(await diffRegion.getAttribute("aria-busy"), "false");
  await page.getByText("来源已核对，以下显示安全投影。", { exact: true }).waitFor();
  pass("source-pending-busy-live-status-cleared-on-success");
  await page.getByRole("button", { name: "打开 File Reference 安全来源" }).click();
  await page.getByText("safe-report.txt", { exact: true }).waitFor();
  await page.getByRole("button", { name: "加载 Handoff Card 安全来源" }).click();
  const handoffCard = page.locator('section[aria-label="Handoff Card：Frozen Handoff Card"]');
  await handoffCard.getByText(/Hand off the structured smoke verification/).waitFor();
  const approvalLink = page.getByRole("link", { name: "前往正式 Approval surface" }).first();
  assert.match(await approvalLink.getAttribute("href"), /#execution-structured-smoke-execution-title$/);
  const handoffLink = page.getByRole("link", { name: "查看既有 handoff 运行" });
  assert.equal(
    await handoffLink.getAttribute("href"),
    `/projects/${projectId}?thread=${threadId}&run=${run.id}`,
  );
  const fileLink = page.getByRole("link", { name: /在 execution 中查看 safe-report.txt/ });
  assert.match(await fileLink.getAttribute("href"), /execution-structured-smoke-execution-title$/);
  assert.equal((await page.locator("body").innerText()).includes(privateHostPath), false);
  const readonlyCards = page.locator(
    'section[aria-label="Diff Preview：Frozen Diff Preview"],'
      + 'section[aria-label="File Reference：Frozen File Reference"],'
      + 'section[aria-label="Handoff Card：Frozen Handoff Card"]',
  );
  assert.equal(
    await readonlyCards.getByRole("button", { name: /编辑|merge|approve/i }).count(),
    0,
  );
  await approvalLink.click();
  await page.waitForURL(/#execution-structured-smoke-execution-title$/);
  assert.equal(
    inspectDatabase().counts.execution_approvals,
    beforeSources.counts.execution_approvals,
  );
  pass("readonly-frozen-sources-safe-navigation-no-approval");

  runFixture("rename-source");
  await page.reload({ waitUntil: "networkidle" });
  await fileCard.getByText("safe-report.txt", { exact: true }).waitFor();
  await fileCard.getByRole("button", { name: "打开 File Reference 安全来源" }).click();
  await fileCard.getByText(/source version/).waitFor();
  assert.equal(await page.getByText("renamed-later.txt").count(), 0);
  assert.equal((await page.locator("body").innerText()).includes(privateHostPath), false);
  pass("file-reference-frozen-name-survives-rename-reopen");

  await axe(page, "desktop light structured transcript");
  await page.screenshot({ fullPage: true, path: evidence.desktop });
  const themeButton = page.getByRole("button", { name: /切换到暗色主题/ });
  await themeButton.click();
  await page.getByRole("button", { name: /切换到明色主题/ }).waitFor();
  await page.getByText("safe-report.txt", { exact: true }).first().waitFor();
  await axe(page, "desktop dark structured transcript");
  await page.screenshot({ fullPage: true, path: evidence.dark });
  pass("light-dark-axe");

  const beforeRestart = inspectDatabase();
  const restartHref = `${new URL(page.url()).pathname}${new URL(page.url()).search}`;
  await restartApp();
  await page.goto(`${baseUrl}${restartHref}`, { waitUntil: "networkidle" });
  const recoveredDiff = page.getByRole("heading", { name: "Frozen Diff Preview" });
  try {
    await recoveredDiff.waitFor({ timeout: 10_000 });
  } catch {
    for (const name of ["重试加载运行", "重试加载群聊"]) {
      const retry = page.getByRole("button", { name });
      if (await retry.count() > 0 && await retry.first().isVisible()) {
        await retry.first().click();
      }
    }
    await recoveredDiff.waitFor();
  }
  await page.getByText("safe-report.txt", { exact: true }).first().waitFor();
  assert.equal(await page.getByText("renamed-later.txt").count(), 0);
  assert.deepEqual(inspectDatabase(), beforeRestart);
  const recoveredFacts = await allFacts(page, projectId, threadId);
  assert.deepEqual(
    recoveredFacts.map(({ id, sequence, type }) => ({ id, sequence, type })),
    initialFacts.concat(recoveredFacts.slice(initialFacts.length))
      .map(({ id, sequence, type }) => ({ id, sequence, type })),
  );
  pass("refresh-process-reopen-preserves-block-state-receipt-fact-order");

  await page.setViewportSize({ height: 844, width: 390 });
  await page.reload({ waitUntil: "networkidle" });
  const editorOpener = page.getByRole("button", { name: "打开编辑" });
  await editorOpener.focus();
  await page.keyboard.press("Enter");
  const editor = page.getByRole("dialog", { name: "任务编辑" });
  await editor.getByRole("tab", { name: "群聊" }).focus();
  await page.keyboard.press("Enter");
  await editor.getByRole("heading", { name: "Frozen Diff Preview" }).waitFor();
  await editor.getByText("safe-report.txt", { exact: true }).first().waitFor();
  const layout = await editor.evaluate((surface) => ({
    controls: [...surface.querySelectorAll("button,a")].filter((element) => {
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0;
    }).map((element) => {
      const box = element.getBoundingClientRect();
      return {
        height: box.height,
        outlineStyle: getComputedStyle(element).outlineStyle,
        width: box.width,
      };
    }),
    documentWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  assert.ok(layout.scrollWidth <= layout.documentWidth);
  for (const control of layout.controls) {
    assert.ok(control.height >= 44 && control.width >= 44);
  }
  await axe(page, "narrow dark structured drawer");
  await page.screenshot({ fullPage: true, path: evidence.narrow });
  await page.keyboard.press("Escape");
  await editor.waitFor({ state: "detached" });
  assert.equal(await editorOpener.evaluate((node) => document.activeElement === node), true);
  pass("narrow-keyboard-escape-focus-44px");

  let focusRing = null;
  for (let attempt = 0; attempt < 8 && !focusRing; attempt += 1) {
    await page.keyboard.press("Tab");
    focusRing = await page.evaluate(() => {
      const element = document.activeElement;
      if (!element || element === document.body || element === document.documentElement) {
        return null;
      }
      return getComputedStyle(element).boxShadow !== "none"
        ? { tag: element.tagName }
        : null;
    });
  }
  assert.ok(focusRing, "narrow: keyboard focus must show a visible focus ring");
  pass("narrow-focus-visible-ring");

  stopApp();
  await new Promise((done) => setTimeout(done, 800));
  runFixture("invalid");
  startApp();
  await waitForApp();
  await page.goto(
    `${baseUrl}/projects/${projectId}?thread=${threadId}&run=${run.id}`,
    { waitUntil: "domcontentloaded" },
  );
  const invalidApi = await api(
    page,
    `/api/projects/${projectId}/threads/${threadId}/facts?after=0&limit=100`,
  );
  assert.equal(invalidApi.status, 503);
  assert.deepEqual(invalidApi.body, {
    error: {
      code: "SCHEMA_DATA_INVALID",
      message: "Database data is invalid.",
    },
  });
  assert.equal(JSON.stringify(invalidApi.body).includes(privateHostPath), false);
  assert.equal(JSON.stringify(invalidApi.body).includes("payload_json"), false);
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.screenshot({ fullPage: true, path: evidence.invalid });
  pass("invalid-persisted-content-route-fails-safe");

  const evidenceText = readdirSync(evidenceDirectory)
    .filter((name) => name.endsWith(".json") || name.endsWith(".log"))
    .map((name) => readFileSync(join(evidenceDirectory, name), "utf8"))
    .join("\n");
  const surfaces = [
    await page.locator("html").innerHTML(),
    productApiBodies.join("\n"),
    serverOutput,
    evidenceText,
    JSON.stringify(results),
  ];
  for (const forbidden of [
    apiKey,
    masterKey,
    privateHostPath,
    privatePromptMarker,
    rawProviderMarker,
    "renamed-later.txt",
    `Bearer ${apiKey}`,
  ]) {
    for (const surface of surfaces) {
      assert.equal(surface.includes(forbidden), false, `forbidden value leaked: ${forbidden}`);
    }
  }
  pass("api-dom-evidence-security-scan");

  results.status = "passed";
  results.summary = {
    assertions: results.assertions.length,
    axeStates: results.axe.length,
    providerCalls,
  };
  writeFileSync(evidence.results, `${JSON.stringify(results, null, 2)}\n`, "utf8");
  console.log(
    `STRUCTURED SMOKE PASS: assertions=${results.assertions.length} axeStates=${results.axe.length} providerCalls=${providerCalls}`,
  );
  for (const path of Object.values(evidence)) console.log(`EVIDENCE: ${path}`);
} finally {
  await browser?.close();
  stopApp();
  if (provider.listening) await close(provider);
  rmSync(`.next-structured-smoke-${process.pid}`, { force: true, recursive: true });
  rmSync(temporaryDirectory, { force: true, recursive: true });
  for (const snapshot of stableConfig) {
    writeFileSync(snapshot.path, snapshot.content, "utf8");
  }
}
