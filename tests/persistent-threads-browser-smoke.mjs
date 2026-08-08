import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
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
const appPort = 12_000 + (seed % 10_000);
const providerPort = 22_000 + (seed % 10_000);
const baseUrl = `http://${host}:${appPort}`;
const providerBaseUrl = `http://${host}:${providerPort}/v1`;
const temporaryDirectory = mkdtempSync(join(tmpdir(), "cool-ai-thread-smoke-"));
const databasePath = join(temporaryDirectory, "threads-v6.sqlite");
const workspaceDirectory = join(temporaryDirectory, "workspace");
mkdirSync(workspaceDirectory);
const masterKey = randomBytes(32).toString("base64url");
const apiKey = `thread-smoke-${randomBytes(18).toString("base64url")}`;
const evidenceDirectory = resolve(
  "features",
  "014-persistent-project-threads",
  "evidence",
);
const evidence = {
  desktop: join(evidenceDirectory, "persistent-threads-desktop.png"),
  narrow: join(evidenceDirectory, "persistent-threads-narrow.png"),
  policy: join(evidenceDirectory, "persistent-threads-policy-repair.png"),
  results: join(evidenceDirectory, "persistent-threads-results.json"),
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
const results = {
  axe: [],
  assertions: [],
  evidence: Object.values(evidence).map((path) => path.replaceAll("\\", "/")),
  status: "running",
};
const productApiBodies = [];
let appServer;
let browser;
let serverOutput = "";
let providerCalls = 0;

mkdirSync(evidenceDirectory, { recursive: true });
for (const path of Object.values(evidence)) rmSync(path, { force: true });

function pass(name, details = {}) {
  results.assertions.push({ name, status: "passed", ...details });
}

function turn(content) {
  return {
    choices: [{ message: { content: JSON.stringify(content) } }],
    usage: {
      completion_tokens: 5,
      prompt_tokens: 7,
      total_tokens: 12,
    },
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
  providerCalls += 1;
  response.writeHead(200, { "content-type": "application/json" });
  if (request.method === "GET" && request.url === "/v1/models") {
    response.end(JSON.stringify({ data: [{ id: "thread-model" }] }));
    return;
  }
  assert.equal(request.method, "POST");
  assert.equal(request.url, "/v1/chat/completions");
  response.end(JSON.stringify(turn({
    claim: null,
    disposition: {
      options: ["Keep active", "Stop"],
      question: "Keep this thread active?",
      type: "decision_request",
    },
    message: "Thread-scoped agent response.",
    tasks: [],
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

const command = process.platform === "win32"
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
      args: ["run", "dev", "--", "--hostname", host, "--port", String(appPort)],
    };

function startApp() {
  appServer = spawn(command.command, command.args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      COCKPIT_DB_PATH: databasePath,
      COCKPIT_MASTER_KEY: masterKey,
      NEXT_DIST_DIR: `.next-thread-smoke-${process.pid}`,
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
}

async function waitForApp() {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (appServer.exitCode !== null) {
      throw new Error(`Thread app exited before readiness.\n${serverOutput}`);
    }
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
    } catch {
      // The isolated product process is still starting.
    }
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error(`Thread app did not become ready.\n${serverOutput}`);
}

async function restartApp(page) {
  const currentUrl = page.url();
  stopApp();
  await new Promise((done) => setTimeout(done, 700));
  serverOutput = "";
  startApp();
  await waitForApp();
  await page.goto(currentUrl, { waitUntil: "networkidle" });
}

async function axe(page, state) {
  const scan = await new AxeBuilder({ page }).analyze();
  const blocking = scan.violations
    .filter((violation) =>
      violation.impact === "critical" || violation.impact === "serious"
    )
    .map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      targets: violation.nodes.map((node) => node.target),
    }));
  const contrast = scan.violations
    .filter((violation) => violation.id === "color-contrast")
    .flatMap((violation) => violation.nodes.map((node) => node.target));
  results.axe.push({
    blocking,
    contrast,
    state,
    violationCount: scan.violations.length,
  });
  assert.deepEqual(blocking, [], `${state}: axe critical/serious must be 0`);
  assert.deepEqual(contrast, [], `${state}: WCAG AA color contrast must pass`);
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

async function createAgent(page, name, template, avatar, accent) {
  await page.getByRole("tab", { name: "Agent" }).click();
  await page.getByRole("button", { name: "创建 Agent" }).click();
  await page.getByLabel("创建方式").selectOption(template);
  await page.getByLabel("Agent 名称").fill(name);
  await page.getByLabel("模型服务", { exact: true }).selectOption({
    label: "Persistent Threads Local Provider",
  });
  await page.getByLabel("头像文字").fill(avatar);
  await page.getByLabel("强调色").selectOption(accent);
  await page.getByRole("button", { name: "保存 Agent" }).click();
  await page.getByRole("heading", { name }).waitFor();
}

async function provisionProviderAndAgents(page) {
  await page.goto(`${baseUrl}/team`, { waitUntil: "networkidle" });
  await page.getByRole("tab", { name: "模型服务" }).click();
  await page.getByRole("button", { name: "创建模型服务" }).click();
  await page.getByLabel("服务名称").fill("Persistent Threads Local Provider");
  await page.getByLabel("Base URL").fill(providerBaseUrl);
  await page.getByLabel("默认模型").fill("thread-model");
  await page.getByLabel("API key").fill(apiKey);
  await page
    .getByRole("checkbox", { name: /HTTP 会明文传输凭据/ })
    .check();
  await page.getByRole("button", { name: "验证连接" }).click();
  await page.getByText("已验证模型 thread-model", { exact: true }).waitFor();
  await page.getByRole("button", { name: "保存服务" }).click();
  await page.getByText("模型服务已保存。", { exact: true }).waitFor();
  await createAgent(page, "Thread Alpha", "planner", "TA", "rose");
  await createAgent(page, "Thread Beta", "builder", "TB", "gold");
  const agents = await api(page, "/api/agents");
  const alpha = agents.body.agents.find((agent) => agent.name === "Thread Alpha");
  const beta = agents.body.agents.find((agent) => agent.name === "Thread Beta");
  assert.ok(alpha?.id && beta?.id);
  return { alpha, beta };
}

async function createThread(page, title, memberNames) {
  const previousThreadId = new URL(page.url()).searchParams.get("thread");
  const openers = page.getByRole("button", { name: "创建线程" });
  await openers.first().click();
  const dialog = page.getByRole("dialog", { name: "创建线程" });
  await dialog.getByLabel("线程标题").fill(title);
  for (const name of memberNames) await dialog.getByLabel(name).check();
  await dialog.getByRole("button", { name: "创建线程", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  await page.waitForURL((url) => {
    const selected = url.searchParams.get("thread");
    return Boolean(selected && selected !== previousThreadId);
  });
  const id = new URL(page.url()).searchParams.get("thread");
  assert.ok(id);
  return id;
}

async function readThread(page, projectId, threadId, runId = null) {
  const suffix = runId ? `?run=${encodeURIComponent(runId)}` : "";
  const response = await api(
    page,
    `/api/projects/${projectId}/threads/${threadId}${suffix}`,
  );
  assert.equal(response.status, 200);
  return response.body;
}

async function waitForRun(page, projectId, threadId, status) {
  const deadline = Date.now() + 45_000;
  let lastDetail = null;
  while (Date.now() < deadline) {
    const detail = await readThread(page, projectId, threadId);
    lastDetail = detail;
    const run = detail.runs.find((candidate) => candidate.status === status);
    if (run) return run;
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error(
    `Run did not reach ${status}: ${JSON.stringify(lastDetail?.runs ?? null)}`,
  );
}

function inspectDatabase() {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const version = database.prepare("PRAGMA user_version").get().user_version;
    const threads = database.prepare(`
      SELECT id,title,project_id AS projectId,last_activity_sequence AS activity
      FROM collaboration_threads ORDER BY activity DESC,id
    `).all();
    const ownership = database.prepare(`
      SELECT m.id,m.project_id AS projectId,m.thread_id AS threadId,m.run_id AS runId,
             m.content,f.type
      FROM collaboration_messages m
      JOIN collaboration_thread_facts f
        ON f.project_id=m.project_id AND f.thread_id=m.thread_id AND f.message_id=m.id
      ORDER BY m.thread_id,m.sequence
    `).all();
    const policies = database.prepare(`
      SELECT t.id,t.active_policy_revision_id AS revisionId,
             r.version,group_concat(pm.agent_id,'|') AS members
      FROM collaboration_threads t
      JOIN collaboration_thread_policy_revisions r
        ON r.project_id=t.project_id AND r.thread_id=t.id
       AND r.id=t.active_policy_revision_id
      LEFT JOIN collaboration_thread_policy_members pm
        ON pm.project_id=r.project_id AND pm.thread_id=r.thread_id
       AND pm.revision_id=r.id
      GROUP BY t.id,t.active_policy_revision_id,r.version ORDER BY t.id
    `).all();
    const activeRuns = database.prepare(`
      SELECT count(*) AS count FROM collaboration_runs
      WHERE project_id='legacy-project'
        AND status IN ('running','waiting_owner','paused','failed')
    `).get().count;
    return { activeRuns, ownership, policies, threads, version };
  } finally {
    database.close();
  }
}

const fixture = spawnSync(
  process.platform === "win32" ? "cmd.exe" : "npx",
  process.platform === "win32"
    ? [
        "/d",
        "/s",
        "/c",
        "npx vite-node --config vitest.config.ts tests/persistent-threads-v6-fixture.ts",
      ]
    : [
        "vite-node",
        "--config",
        "vitest.config.ts",
        "tests/persistent-threads-v6-fixture.ts",
      ],
  {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      COCKPIT_MASTER_KEY: masterKey,
      THREAD_SMOKE_DB_PATH: databasePath,
    },
    windowsHide: true,
  },
);
assert.equal(
  fixture.status,
  0,
  `v6 fixture failed\n${fixture.error ?? ""}\n${fixture.stdout}\n${fixture.stderr}`,
);

try {
  await listen(provider, providerPort);
  startApp();
  await waitForApp();
  browser = await chromium.launch({
    headless: true,
    ...(browserExecutable ? { executablePath: browserExecutable } : {}),
  });
  const context = await browser.newContext({
    viewport: { height: 1050, width: 1500 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  page.on("response", async (response) => {
    if (response.url().startsWith(baseUrl) && response.url().includes("/api/")) {
      productApiBodies.push(await response.text().catch(() => ""));
    }
  });

  const { alpha, beta } = await provisionProviderAndAgents(page);
  assert.equal(providerCalls, 1);
  await page.goto(`${baseUrl}/projects/legacy-project`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Persistent Threads Legacy" }).waitFor();
  await page.getByLabel("本地工作区路径").fill(workspaceDirectory);
  await page.getByRole("button", { name: "绑定工作区" }).click();
  await page.getByText("工作区已保存。", { exact: true }).waitFor();
  await page.getByLabel("使命标题").fill("Persistent Threads Mission");
  await page
    .getByLabel("使命目标")
    .fill("Verify persistent project threads end to end");
  await page.getByRole("button", { name: "创建使命" }).click();
  await page
    .getByRole("heading", { name: "Persistent Threads Mission" })
    .waitFor();
  const migrated = await api(page, "/api/projects/legacy-project/threads?limit=100");
  assert.equal(migrated.status, 200);
  assert.equal(migrated.body.threads.length, 1);
  assert.equal(migrated.body.threads[0].title, "历史协作");
  const legacyThreadId = migrated.body.threads[0].id;
  assert.equal(inspectDatabase().version, 7);
  pass("migrated-legacy-default-thread", { legacyThreadId });
  await axe(page, "migrated legacy project");

  const membership = await api(page, "/api/projects/legacy-project/members");
  const allMemberIds = [
    ...membership.body.members.map((member) => member.agentId),
    alpha.id,
    beta.id,
  ];
  const membershipUpdate = await api(
    page,
    "/api/projects/legacy-project/members",
    {
      body: JSON.stringify({
        agentIds: allMemberIds,
        expectedProjectVersion: membership.body.projectVersion,
      }),
      headers: { "content-type": "application/json" },
      method: "PUT",
    },
  );
  assert.equal(membershipUpdate.status, 200);
  await page.reload({ waitUntil: "networkidle" });

  const firstThread = await createThread(
    page,
    "Duplicate title",
    ["Thread Alpha", "Thread Beta"],
  );
  const secondThread = await createThread(
    page,
    "Duplicate title",
    ["Legacy Alpha", "Thread Beta"],
  );
  const thirdThread = await createThread(
    page,
    "Distinct title",
    ["Legacy Beta", "Thread Alpha"],
  );
  assert.equal(new Set([firstThread, secondThread, thirdThread]).size, 3);
  const listed = await api(page, "/api/projects/legacy-project/threads?limit=100");
  assert.equal(
    listed.body.threads.filter((thread) => thread.title === "Duplicate title").length,
    2,
  );
  pass("same-and-distinct-title-explicit-policies");

  await page.getByRole("button", { name: "Duplicate title" }).last().click();
  await page.waitForURL((url) => url.searchParams.get("thread") === firstThread);
  const firstHref = `/projects/legacy-project?thread=${firstThread}`;
  const thirdHref = `/projects/legacy-project?thread=${thirdThread}`;
  await page.evaluate((href) => {
    window.history.pushState(null, "", href);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, thirdHref);
  await page.waitForURL((url) => url.searchParams.get("thread") === thirdThread);
  await page.evaluate(() => window.history.back());
  await page.waitForURL((url) => url.searchParams.get("thread") === firstThread);
  await page.evaluate(() => window.history.forward());
  await page.waitForURL((url) => url.searchParams.get("thread") === thirdThread);
  await page.goto(`${baseUrl}${firstHref}`, { waitUntil: "networkidle" });
  const teamLink = page.getByRole("link", { name: "团队" });
  assert.equal(
    await teamLink.getAttribute("href"),
    `/team?section=skills&returnTo=${encodeURIComponent(firstHref)}`,
  );
  await teamLink.click();
  await page.getByRole("link", { name: "返回原位置" }).click();
  await page.waitForURL((url) => url.pathname + url.search === firstHref);
  pass("url-settings-history-navigation");

  await page.goto(`${baseUrl}${firstHref}`, { waitUntil: "networkidle" });
  const composer = page.getByLabel("发送给项目群聊");
  await composer.fill("Owner message isolated in first thread.");
  const startButton = page.getByRole("button", { name: "发送并开始首次运行" });
  assert.equal(await startButton.isEnabled(), true);
  const startResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST"
    && response.url().endsWith(`/threads/${firstThread}/runs`)
  );
  await startButton.click();
  const startResponse = await startResponsePromise;
  assert.equal(
    startResponse.status(),
    201,
    `run start failed: ${await startResponse.text()}`,
  );
  const activeRun = await waitForRun(
    page,
    "legacy-project",
    firstThread,
    "waiting_owner",
  );
  await page.getByText("Thread-scoped agent response.", { exact: true }).waitFor();
  const secondFacts = await api(
    page,
    `/api/projects/legacy-project/threads/${secondThread}/facts`,
  );
  assert.equal(
    secondFacts.body.items.some((fact) =>
      fact.message?.content?.includes("isolated in first thread")
    ),
    false,
  );
  assert.equal(inspectDatabase().activeRuns, 1);
  await page.goto(
    `${baseUrl}/projects/legacy-project?thread=${secondThread}`,
    { waitUntil: "networkidle" },
  );
  const returnLink = await page.getByRole("link", {
    name: `返回活动线程 ${activeRun.id}`,
  });
  assert.equal(
    await returnLink.getAttribute("href"),
    `/projects/legacy-project?thread=${firstThread}&run=${activeRun.id}`,
  );
  assert.equal(
    await page.getByRole("button", { name: "发送并开始首次运行" }).isDisabled(),
    true,
  );
  await returnLink.focus();
  await page.keyboard.press("Enter");
  await page.waitForURL((url) => url.searchParams.get("run") === activeRun.id);
  pass("thread-isolation-single-active-safe-return", { activeRunId: activeRun.id });
  await axe(page, "active thread selected run");
  await page.screenshot({ fullPage: true, path: evidence.desktop });
  const currentActive = await readThread(
    page,
    "legacy-project",
    firstThread,
    activeRun.id,
  );
  const stopped = await api(
    page,
    `/api/projects/legacy-project/threads/${firstThread}/runs/${activeRun.id}/control`,
    {
      body: JSON.stringify({
        action: "stop",
        expectedVersion: currentActive.selectedRun.version,
        operationId: randomUUID(),
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
  );
  assert.equal(stopped.status, 200);

  await page.goto(
    `${baseUrl}/projects/legacy-project?thread=${legacyThreadId}`,
    { waitUntil: "networkidle" },
  );
  const runSelector = page.getByRole("combobox", { name: "选择线程运行" });
  await runSelector.selectOption("legacy-run-stopped");
  await page.waitForURL((url) =>
    url.searchParams.get("run") === "legacy-run-stopped"
  );
  await page.getByRole("heading", { name: "运行 legacy-run-stopped" }).waitFor();
  const legacyDetail = await readThread(
    page,
    "legacy-project",
    legacyThreadId,
    "legacy-run-stopped",
  );
  assert.equal(legacyDetail.selectedRun.id, "legacy-run-stopped");
  assert.notEqual(legacyDetail.selectedRun.id, activeRun.id);
  pass("explicit-historical-run-no-latest-substitution");

  const membersBeforeRemoval = await api(page, "/api/projects/legacy-project/members");
  const withoutBeta = membersBeforeRemoval.body.members
    .filter((member) => member.agentId !== beta.id)
    .map((member) => member.agentId);
  const removal = await api(page, "/api/projects/legacy-project/members", {
    body: JSON.stringify({
      agentIds: withoutBeta,
      expectedProjectVersion: membersBeforeRemoval.body.projectVersion,
    }),
    headers: { "content-type": "application/json" },
    method: "PUT",
  });
  assert.equal(removal.status, 200);
  await page.goto(`${baseUrl}${firstHref}`, { waitUntil: "networkidle" });
  await page.getByText(/需要修复/).first().waitFor();
  await page.getByRole("button", { name: "修复线程成员策略" }).click();
  const repairDialog = page.getByRole("dialog", { name: "编辑线程成员策略" });
  await repairDialog.getByLabel("Legacy Alpha").check();
  await repairDialog.getByRole("button", { name: "保存成员策略" }).click();
  await page.getByRole("status").filter({ hasText: /策略版本/ }).waitFor();
  await axe(page, "repaired policy success");
  await page.screenshot({ fullPage: true, path: evidence.policy });

  const editPolicy = page.getByRole("button", { name: "编辑线程成员策略" });
  await editPolicy.click();
  const staleDialog = page.getByRole("dialog", { name: "编辑线程成员策略" });
  const staleDetail = await readThread(page, "legacy-project", firstThread);
  const externalPolicy = await api(
    page,
    `/api/projects/legacy-project/threads/${firstThread}/policy`,
    {
      body: JSON.stringify({
        expectedVersion: staleDetail.thread.version,
        memberAgentIds: [alpha.id, "legacy-agent-a"],
        operationId: randomUUID(),
      }),
      headers: { "content-type": "application/json" },
      method: "PATCH",
    },
  );
  assert.equal(
    externalPolicy.status,
    200,
    `external policy update failed: ${JSON.stringify(externalPolicy.body)}`,
  );
  await staleDialog.getByLabel("Legacy Beta").check();
  await staleDialog.getByRole("button", { name: "保存成员策略" }).click();
  await staleDialog.getByRole("alert").filter({
    hasText: /重新加载最新版本和事实/,
  }).waitFor();
  assert.equal(await staleDialog.getByLabel("Legacy Beta").isChecked(), true);
  await staleDialog.getByRole("button", { name: "保存成员策略" }).click();
  await staleDialog.waitFor({ state: "detached" });
  pass("policy-removal-repair-stale-conflict");

  const beforeCredential = inspectDatabase();
  const credentialAttempt = await api(
    page,
    `/api/projects/legacy-project/threads/${firstThread}/messages`,
    {
      body: JSON.stringify({
        message: `Do not persist ${apiKey}`,
        operationId: randomUUID(),
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
  );
  assert.equal(credentialAttempt.status, 400);
  assert.equal(JSON.stringify(credentialAttempt.body).includes(apiKey), false);
  const afterCredential = inspectDatabase();
  assert.deepEqual(afterCredential.ownership, beforeCredential.ownership);
  pass("configured-credential-rejected-atomically");

  const crossProject = await api(
    page,
    `/api/projects/foreign-project/threads/${firstThread}`,
  );
  const crossThreadRun = await api(
    page,
    `/api/projects/legacy-project/threads/${secondThread}?run=${activeRun.id}`,
  );
  assert.equal(crossProject.status, 404);
  assert.equal(crossThreadRun.status, 404);
  pass("cross-project-thread-run-tuples-fail-safe");

  const beforeRestart = inspectDatabase();
  await restartApp(page);
  await page.getByText("Owner message isolated in first thread.", {
    exact: true,
  }).waitFor();
  const afterRestart = inspectDatabase();
  assert.deepEqual(afterRestart, beforeRestart);
  assert.equal(
    afterRestart.ownership.some((row) =>
      row.threadId === firstThread
      && row.runId === activeRun.id
      && row.type === "owner_message"
    ),
    true,
  );
  assert.deepEqual(
    afterRestart.threads.map((thread) => thread.id),
    beforeRestart.threads.map((thread) => thread.id),
  );
  pass("restart-preserves-ownership-facts-policy-order-source-tuple");

  await page.setViewportSize({ height: 844, width: 390 });
  await page.reload({ waitUntil: "networkidle" });
  const navigationOpener = page.getByRole("button", { name: "打开项目导航" });
  await navigationOpener.focus();
  await page.keyboard.press("Enter");
  const navigationDialog = page.getByRole("dialog", { name: "项目导航" });
  await navigationDialog.getByRole("button", { name: "Distinct title" }).focus();
  await page.keyboard.press("Enter");
  await page.waitForURL((url) => url.searchParams.get("thread") === thirdThread);
  await page.keyboard.press("Escape");
  await navigationDialog.waitFor({ state: "detached" });
  const editorOpener = page.getByRole("button", { name: "打开编辑" });
  await editorOpener.focus();
  await page.keyboard.press("Enter");
  const editor = page.getByRole("dialog", { name: "任务编辑" });
  await editor.getByRole("tab", { name: "运行详情" }).focus();
  await page.keyboard.press("Enter");
  const narrowLayout = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    controls: [...document.querySelectorAll("button,select")].map((element) => {
      const box = element.getBoundingClientRect();
      return {
        height: box.height,
        left: box.left,
        right: box.right,
        visible: box.width > 0 && box.height > 0,
        width: box.width,
      };
    }).filter((item) => item.visible),
    scrollWidth: document.documentElement.scrollWidth,
  }));
  assert.ok(narrowLayout.scrollWidth <= narrowLayout.clientWidth);
  for (const control of narrowLayout.controls) {
    assert.ok(control.left >= 0 && control.right <= narrowLayout.clientWidth + 1);
    assert.ok(control.height >= 44 && control.width >= 44);
  }
  await axe(page, "narrow keyboard dialogs and run state");
  await page.screenshot({ fullPage: true, path: evidence.narrow });
  await page.keyboard.press("Escape");
  await editor.waitFor({ state: "detached" });
  assert.equal(await editorOpener.evaluate((node) => document.activeElement === node), true);
  pass("desktop-narrow-keyboard-dialog-focus-live-states");

  const dom = await page.evaluate(() => document.documentElement.outerHTML);
  const databaseText = JSON.stringify(inspectDatabase());
  const existingEvidence = readdirSync(evidenceDirectory)
    .filter((name) => name.endsWith(".json") || name.endsWith(".log"))
    .map((name) => readFileSync(join(evidenceDirectory, name), "utf8"))
    .join("\n");
  const publicSurfaces = [
    dom,
    databaseText,
    productApiBodies.join("\n"),
    serverOutput,
    existingEvidence,
    JSON.stringify(results),
  ];
  for (const secret of [apiKey, masterKey, `Bearer ${apiKey}`]) {
    for (const surface of publicSurfaces) {
      assert.equal(surface.includes(secret), false, "fixture secret leaked");
    }
  }
  pass("no-secret-db-api-dom-evidence");
  results.status = "passed";
  results.summary = {
    activeRuns: afterRestart.activeRuns,
    axeStates: results.axe.length,
    projectId: "legacy-project",
    providerCalls,
    threadCount: afterRestart.threads.length,
  };
  writeFileSync(evidence.results, `${JSON.stringify(results, null, 2)}\n`, "utf8");
  console.log(
    `THREAD SMOKE PASS: assertions=${results.assertions.length} axeStates=${results.axe.length} threads=${afterRestart.threads.length}`,
  );
  for (const path of Object.values(evidence)) console.log(`EVIDENCE: ${path}`);
} finally {
  await browser?.close();
  stopApp();
  await close(provider);
  rmSync(`.next-thread-smoke-${process.pid}`, { force: true, recursive: true });
  rmSync(temporaryDirectory, { force: true, recursive: true });
  for (const snapshot of stableConfig) {
    writeFileSync(snapshot.path, snapshot.content, "utf8");
  }
}
