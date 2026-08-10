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
import { dirname, join, resolve } from "node:path";
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
  attachmentsDesktop: join(
    resolve("features", "024-image-attachments", "evidence"),
    "attachments-desktop.png",
  ),
  attachmentsNarrow: join(
    resolve("features", "024-image-attachments", "evidence"),
    "attachments-narrow.png",
  ),
  desktop: join(evidenceDirectory, "persistent-threads-desktop.png"),
  narrow: join(evidenceDirectory, "persistent-threads-narrow.png"),
  policy: join(evidenceDirectory, "persistent-threads-policy-repair.png"),
  replyReference: join(
    evidenceDirectory,
    "persistent-threads-reply-reference.png",
  ),
  draftRestored: join(
    evidenceDirectory,
    "persistent-threads-draft-restored.png",
  ),
  inputHistory: join(
    evidenceDirectory,
    "persistent-threads-input-history.png",
  ),
  favoritesDesktop: join(
    resolve("features", "025-thread-favorites", "evidence"),
    "favorites-desktop.png",
  ),
  favoritesNarrow: join(
    resolve("features", "025-thread-favorites", "evidence"),
    "favorites-narrow.png",
  ),
  results: join(evidenceDirectory, "persistent-threads-results.json"),
};
const PNG_1X1 = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41,
  0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
  0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);
const GIF_1X1 = Buffer.from([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00,
  0x01, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00,
  0xff, 0xff, 0xff, 0x21, 0xf9, 0x04, 0x01, 0x00,
  0x00, 0x00, 0x00, 0x2c, 0x00, 0x00, 0x00, 0x00,
  0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02, 0x44,
  0x01, 0x00, 0x3b,
]);
const attachmentsRoot = join(temporaryDirectory, "attachments");
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

for (const path of Object.values(evidence)) {
  mkdirSync(dirname(path), { recursive: true });
  rmSync(path, { force: true });
}

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

const command = {
  command: process.execPath,
  args: [
    resolve("node_modules", "next", "dist", "bin", "next"),
    "dev",
    "--webpack",
    "--hostname",
    host,
    "--port",
    String(appPort),
  ],
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
    violations: scan.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
    })),
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

async function evaluateWithNavigationRetry(page, fn, arg) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await page.evaluate(fn, arg);
    } catch (error) {
      const navigation = String(error).includes("Execution context was destroyed");
      if (!navigation || attempt === 2) throw error;
      await page.waitForLoadState("networkidle");
    }
  }
  throw new Error("unreachable");
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
             m.content,m.reply_to_message_id AS replyToMessageId,
             m.reply_to_sequence AS replyToSequence,f.type
      FROM collaboration_messages m
      JOIN collaboration_thread_facts f
        ON f.project_id=m.project_id AND f.thread_id=m.thread_id AND f.message_id=m.id
      ORDER BY m.thread_id,m.sequence
    `).all();
    const facts = database.prepare(`
      SELECT id,project_id AS projectId,thread_id AS threadId,sequence,type
      FROM collaboration_thread_facts
      ORDER BY project_id,thread_id,sequence,id
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
    const attachments = database.prepare(`
      SELECT id,project_id AS projectId,thread_id AS threadId,
             message_id AS messageId,file_name AS fileName,size,
             mime_type AS mimeType,storage_relpath AS storageRelpath,status
      FROM message_attachments ORDER BY created_at,id
    `).all();
    const attachmentEvents = database.prepare(`
      SELECT attachment_id AS attachmentId,type
      FROM attachment_events ORDER BY created_at,id
    `).all();
    const favorites = database.prepare(`
      SELECT project_id AS projectId,thread_id AS threadId,created_at AS favoritedAt
      FROM thread_favorites ORDER BY project_id,thread_id
    `).all();
    return {
      activeRuns,
      attachmentEvents,
      attachments,
      factCount: facts.length,
      factIds: facts.map((fact) => fact.id),
      facts,
      favorites,
      ownership,
      policies,
      threads,
      version,
    };
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
        "npx vite-node --config vitest.config.ts tests/fixtures/collaboration/persistent-threads-browser.ts",
      ]
    : [
        "vite-node",
        "--config",
        "vitest.config.ts",
        "tests/fixtures/collaboration/persistent-threads-browser.ts",
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
  globalThis.__threadSmokePage = page;
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
  const persisted = await api(page, "/api/projects/legacy-project/threads?limit=100");
  assert.equal(persisted.status, 200);
  assert.equal(persisted.body.threads.length, 1);
  assert.equal(persisted.body.threads[0].title, "历史协作");
  const legacyThreadId = persisted.body.threads[0].id;
  assert.equal(inspectDatabase().version, 14);
  pass("current-persistent-default-thread", { legacyThreadId });
  await axe(page, "current persistent project");

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

  await page.getByRole("button", { exact: true, name: "Duplicate title" }).last().click();
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
  const secondThreadComposer = page.getByLabel("发送给项目群聊");
  await secondThreadComposer.fill("Second-thread owner note.");
  await page.waitForFunction(() =>
    [...document.querySelectorAll("button")].some(
      (button) => button.textContent?.trim() === "发送消息" && !button.disabled,
    )
  );
  assert.equal(
    await page.getByRole("button", { name: "发送消息" }).isEnabled(),
    true,
  );
  await page.getByText(
    "另一线程有活动运行；可发送线程消息，但不能在此启动新一轮。",
    { exact: true },
  ).waitFor();
  const secondThreadMessageResponse = page.waitForResponse((response) =>
    response.request().method() === "POST"
    && response.url().endsWith(`/threads/${secondThread}/messages`)
  );
  await page.getByRole("button", { name: "发送消息" }).click();
  assert.equal((await secondThreadMessageResponse).status(), 201);
  await page.getByText("Second-thread owner note.", { exact: true }).waitFor();
  assert.equal(inspectDatabase().activeRuns, 1);
  await returnLink.focus();
  await page.keyboard.press("Enter");
  try {
    await page.waitForURL(
      (url) => url.searchParams.get("run") === activeRun.id,
      { timeout: 10_000 },
    );
  } catch {
    await returnLink.focus();
    await page.keyboard.press("Enter");
    await page.waitForURL((url) => url.searchParams.get("run") === activeRun.id);
  }
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
        content: `Do not persist ${apiKey}`,
        operationId: randomUUID(),
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
  );
  assert.equal(credentialAttempt.status, 422);
  assert.equal(credentialAttempt.body?.error?.code, "CREDENTIAL_CONTENT_REJECTED");
  assert.equal(JSON.stringify(credentialAttempt.body).includes(apiKey), false);
  const afterCredential = inspectDatabase();
  assert.deepEqual(afterCredential.ownership, beforeCredential.ownership);
  assert.equal(afterCredential.factCount, beforeCredential.factCount);
  assert.deepEqual(afterCredential.factIds, beforeCredential.factIds);
  assert.deepEqual(afterCredential.facts, beforeCredential.facts);
  const credentialFacts = await api(
    page,
    `/api/projects/legacy-project/threads/${firstThread}/facts?after=0&limit=200`,
  );
  assert.equal(credentialFacts.status, 200);
  assert.equal(JSON.stringify(credentialFacts.body).includes(apiKey), false);
  assert.equal((await page.locator("body").innerText()).includes(apiKey), false);
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

  const threadMessages = await api(
    page,
    `/api/projects/legacy-project/threads/${firstThread}/messages?limit=100`,
  );
  assert.equal(threadMessages.status, 200);
  const sourceMessage = threadMessages.body.items.find((item) =>
    item.content === "Thread-scoped agent response."
  );
  assert.ok(sourceMessage);
  const replyPost = await api(
    page,
    `/api/projects/legacy-project/threads/${firstThread}/messages`,
    {
      body: JSON.stringify({
        content: "Reply carrying a frozen source reference.",
        operationId: randomUUID(),
        replyToMessageId: sourceMessage.id,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
  );
  assert.equal(
    replyPost.status,
    201,
    `reply post failed: ${JSON.stringify(replyPost.body)}`,
  );
  assert.deepEqual(replyPost.body.message.replyTo, {
    authorDisplayName: sourceMessage.authorDisplayName,
    excerpt: sourceMessage.content,
    messageId: sourceMessage.id,
    sequence: sourceMessage.sequence,
  });
  const replyEdgeRows = inspectDatabase().ownership.filter((row) =>
    row.replyToMessageId === sourceMessage.id
  );
  assert.equal(replyEdgeRows.length, 1);
  assert.equal(replyEdgeRows[0].replyToSequence, sourceMessage.sequence);
  const cutTargetPost = await api(
    page,
    `/api/projects/legacy-project/threads/${firstThread}/messages`,
    {
      body: JSON.stringify({
        content: "Source message later cut from the transcript.",
        operationId: randomUUID(),
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
  );
  assert.equal(cutTargetPost.status, 201);
  const cutReplyPost = await api(
    page,
    `/api/projects/legacy-project/threads/${firstThread}/messages`,
    {
      body: JSON.stringify({
        content: "Reply whose source becomes unavailable.",
        operationId: randomUUID(),
        replyToMessageId: cutTargetPost.body.message.id,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
  );
  assert.equal(cutReplyPost.status, 201);
  const cutTargetId = cutTargetPost.body.message.id;
  const cutFactsRoute = (url) =>
    url.pathname === `/api/projects/legacy-project/threads/${firstThread}/facts`;
  const cutFactsHandler = async (route) => {
    const response = await route.fetch();
    const text = await response.text();
    try {
      const body = JSON.parse(text);
      if (body && Array.isArray(body.items)) {
        body.items = body.items.filter((fact) => fact.message?.id !== cutTargetId);
        await route.fulfill({ response, json: body });
        return;
      }
    } catch {
      // Non-JSON or unexpected payload: fulfill the original response below.
    }
    await route.fulfill({ response, body: text });
  };
  await page.route(cutFactsRoute, cutFactsHandler);

  await page.goto(`${baseUrl}${firstHref}`, { waitUntil: "networkidle" });
  const replyChipName = `跳转到来源消息：#${sourceMessage.sequence} · ${sourceMessage.authorDisplayName} · ${sourceMessage.content}`;
  const replyChip = page.getByRole("button", { name: replyChipName });
  await replyChip.waitFor();
  const chipBox = await replyChip.boundingBox();
  assert.ok(chipBox && chipBox.height >= 44 && chipBox.width >= 44);
  const timelineLog = page.getByRole("log", { name: "协作时间线" });
  await timelineLog.focus();
  let chipFocusedByKeyboard = false;
  for (let attempt = 0; attempt < 15 && !chipFocusedByKeyboard; attempt += 1) {
    await page.keyboard.press("Tab");
    chipFocusedByKeyboard = await replyChip.evaluate(
      (node) => document.activeElement === node,
    );
  }
  assert.ok(chipFocusedByKeyboard, "reply chip must be keyboard reachable");
  assert.notEqual(
    await replyChip.evaluate((node) => getComputedStyle(node).boxShadow),
    "none",
  );
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => {
    const active = document.activeElement;
    return active?.tagName === "LI"
      && active.classList.contains("reply-target-highlight");
  });
  const locatedText = await page.evaluate(
    () => document.activeElement?.textContent ?? "",
  );
  assert.ok(locatedText.includes("Thread-scoped agent response."));
  await page.screenshot({ fullPage: true, path: evidence.replyReference });
  await axe(page, "desktop light reply reference jump highlight");
  await page.waitForFunction(() => {
    const active = document.activeElement;
    return active?.tagName === "LI"
      && !active.classList.contains("reply-target-highlight");
  });

  const unavailableName =
    "来源消息不可用，无法跳转：目标消息不在当前可读取的协作历史中。";
  const unavailableChip = page.getByRole("button", { name: unavailableName });
  await unavailableChip.waitFor();
  const unavailableBox = await unavailableChip.boundingBox();
  assert.ok(
    unavailableBox && unavailableBox.height >= 44 && unavailableBox.width >= 44,
  );
  assert.equal(await unavailableChip.getAttribute("aria-disabled"), "true");
  const unavailableText = await unavailableChip.textContent();
  assert.ok(unavailableText?.includes("来源消息不可用"));
  assert.equal(unavailableText?.includes("Source message later cut"), false);
  assert.equal(
    await page
      .getByText("Source message later cut from the transcript.", { exact: true })
      .count(),
    0,
  );
  await unavailableChip.focus();
  await page.keyboard.press("Enter");
  assert.equal(
    await unavailableChip.evaluate((node) => document.activeElement === node),
    true,
  );
  assert.equal(await page.locator(".reply-target-highlight").count(), 0);
  pass("reply-reference-chip-keyboard-jump-highlight-placeholder");

  const themeToggle = page.getByRole("button", { name: /切换到暗色主题/ });
  await themeToggle.click();
  await page.getByRole("button", { name: /切换到明色主题/ }).waitFor();
  await replyChip.waitFor();
  await axe(page, "desktop dark reply reference transcript");
  await page.getByRole("button", { name: /切换到明色主题/ }).click();
  await page.getByRole("button", { name: /切换到暗色主题/ }).waitFor();
  pass("reply-reference-light-dark-axe");

  await page.setViewportSize({ height: 844, width: 390 });
  await page.reload({ waitUntil: "networkidle" });
  const navigationOpener = page.getByRole("button", { name: "打开项目导航" });
  await navigationOpener.focus();
  await page.keyboard.press("Enter");
  const navigationDialog = page.getByRole("dialog", { name: "项目导航" });
  await navigationDialog.getByRole("button", { exact: true, name: "Distinct title" }).focus();
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

  await page.goto(`${baseUrl}${firstHref}`, { waitUntil: "networkidle" });
  const narrowEditorOpener = page.getByRole("button", { name: "打开编辑" });
  await narrowEditorOpener.focus();
  await page.keyboard.press("Enter");
  const narrowEditor = page.getByRole("dialog", { name: "任务编辑" });
  await narrowEditor.waitFor();
  await narrowEditor.getByRole("tab", { name: "群聊" }).click();
  const narrowReplyChip = narrowEditor.getByRole("button", { name: replyChipName });
  await narrowReplyChip.waitFor();
  const narrowUnavailable = narrowEditor.getByRole("button", { name: unavailableName });
  await narrowUnavailable.waitFor();
  for (const chip of [narrowReplyChip, narrowUnavailable]) {
    const box = await chip.boundingBox();
    assert.ok(box && box.height >= 44 && box.width >= 44);
  }
  await axe(page, "narrow reply reference transcript");
  await page.unroute(cutFactsRoute, cutFactsHandler);
  pass("reply-reference-narrow-44px-axe");

  await page.keyboard.press("Escape");
  await narrowEditor.waitFor({ state: "detached" });
  await page.setViewportSize({ height: 1050, width: 1500 });
  await page.goto(`${baseUrl}${firstHref}`, { waitUntil: "networkidle" });
  const draftComposer = page.getByLabel("发送给项目群聊");
  await draftComposer.waitFor();
  const draftText = "Draft continuity smoke note.";
  const attachmentName = "smoke-notes.png";
  const attachmentSize = PNG_1X1.length;
  const draftPut = (match) => page.waitForResponse((response) => {
    const request = response.request();
    if (request.method() !== "PUT" || !request.url().endsWith(`/threads/${firstThread}/draft`)) {
      return false;
    }
    try {
      return match(JSON.parse(request.postData() ?? "null"));
    } catch {
      return false;
    }
  });

  const sensitiveSample = "token=sk-smoke-sensitive-sample";
  const sensitiveSave = draftPut((body) => body?.content === sensitiveSample);
  await draftComposer.fill(sensitiveSample);
  const sensitiveResponse = await sensitiveSave;
  const sensitiveBody = await sensitiveResponse.json();
  assert.equal(sensitiveBody.contentSaved, false);
  await page.getByText(/检测到疑似敏感内容，草稿正文未保存/).waitFor();
  const sensitiveDraft = await api(
    page,
    `/api/projects/legacy-project/threads/${firstThread}/draft`,
  );
  assert.equal(sensitiveDraft.body.draft?.content, "");
  assert.equal(
    JSON.stringify(sensitiveDraft.body).includes(sensitiveSample),
    false,
  );
  const sensitiveClear = page.waitForResponse((response) =>
    response.request().method() === "DELETE"
    && response.url().endsWith(`/threads/${firstThread}/draft`)
  );
  await draftComposer.fill("");
  assert.equal((await sensitiveClear).status(), 200);
  const clearedSensitiveDraft = await api(
    page,
    `/api/projects/legacy-project/threads/${firstThread}/draft`,
  );
  assert.equal(clearedSensitiveDraft.body.draft, null);
  pass("draft-sensitive-content-skipped-server-evidence");

  const fullDraftSave = draftPut((body) =>
    body?.content === draftText
    && Array.isArray(body?.attachments)
    && body.attachments.length === 1
    && typeof body.attachments[0]?.attachmentId === "string"
    && typeof body?.replyToMessageId === "string"
  );
  await draftComposer.fill(draftText);
  const draftUpload = page.waitForResponse((response) =>
    response.request().method() === "POST"
    && response.url().includes(`/threads/${firstThread}/attachments?name=`)
  );
  await page.getByLabel("选择附件文件").setInputFiles({
    buffer: PNG_1X1,
    mimeType: "image/png",
    name: attachmentName,
  });
  assert.equal((await draftUpload).status(), 201);
  await page
    .locator("form.composer .mention-chip", { hasText: "已上传" })
    .waitFor();
  await page.getByRole("button", { name: /^回复 .+ 的消息/ }).first().click();
  const fullDraftResponse = await fullDraftSave;
  assert.equal((await fullDraftResponse.json()).contentSaved, true);
  const savedDraftBody = JSON.parse(fullDraftResponse.request().postData());
  const draftAttachmentId = savedDraftBody.attachments[0].attachmentId;
  assert.ok(draftAttachmentId.length > 0);
  assert.deepEqual(savedDraftBody.attachments, [
    { attachmentId: draftAttachmentId, name: attachmentName, size: attachmentSize },
  ]);

  await page.reload({ waitUntil: "networkidle" });
  await page.waitForFunction((expected) => {
    const composer = document.querySelector("form.composer textarea");
    return composer && composer.value === expected;
  }, draftText);
  const restoredChip = page.locator("form.composer .mention-chip", {
    hasText: `${attachmentName} · ${attachmentSize} B`,
  });
  await restoredChip.waitFor();
  assert.ok((await restoredChip.textContent())?.includes("已上传"));
  await page
    .locator("form.composer .mention-chip", { hasText: /^回复 / })
    .waitFor();
  await axe(page, "desktop light draft restored");
  await page.screenshot({ fullPage: true, path: evidence.draftRestored });
  pass("draft-restore-text-attachment-reply-after-reload");

  const orphanRemoval = page.waitForResponse((response) =>
    response.request().method() === "DELETE"
    && response.url().includes(`/threads/${firstThread}/attachments/`)
  );
  const orphanDraftSave = draftPut((body) =>
    body?.content === draftText
    && Array.isArray(body?.attachments)
    && body.attachments.length === 0
  );
  await page.getByRole("button", { name: `移除附件 ${attachmentName}` }).click();
  const orphanRemovalResponse = await orphanRemoval;
  assert.ok(
    orphanRemovalResponse.status() < 300,
    `orphan removal failed: ${orphanRemovalResponse.status()}`,
  );
  await orphanDraftSave;
  assert.equal(
    await page.locator("form.composer .mention-chip", { hasText: attachmentName }).count(),
    0,
  );

  const draftRunSelector = page.getByRole("combobox", { name: "选择线程运行" });
  await draftRunSelector.selectOption(activeRun.id);
  await page.waitForURL((url) => url.searchParams.get("run") === activeRun.id);
  await page.waitForFunction((expected) => {
    const composer = document.querySelector("form.composer textarea");
    return composer && composer.value === expected;
  }, draftText);
  await page
    .locator("form.composer .mention-chip", { hasText: /^回复 / })
    .waitFor();

  const replyRemovalSave = draftPut((body) =>
    body?.content === draftText && body?.replyToMessageId === null
  );
  await page.getByRole("button", { name: "移除回复链接" }).focus();
  await page.keyboard.press("Enter");
  await replyRemovalSave;
  const restartRun = page.waitForResponse((response) =>
    response.request().method() === "POST"
    && response.url().endsWith(`/threads/${firstThread}/runs`)
  );
  await page.getByRole("button", { name: "发送并开始新一轮" }).click();
  assert.equal((await restartRun).status(), 201);
  await page.waitForFunction(() => {
    const composer = document.querySelector("form.composer textarea");
    return composer && composer.value === "";
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForFunction(() => {
    const composer = document.querySelector("form.composer textarea");
    return composer && composer.value === "";
  });
  assert.equal(await page.locator("form.composer .mention-chip").count(), 0);
  const draftAfterSend = await api(
    page,
    `/api/projects/legacy-project/threads/${firstThread}/draft`,
  );
  assert.equal(draftAfterSend.body.draft, null);
  pass("draft-survives-run-selection-clears-after-send-reload");

  const historyEntry = page.getByRole("button", { name: "输入历史" });
  await historyEntry.focus();
  await page.keyboard.press("Enter");
  const historyRegion = page.getByRole("region", { name: "输入历史" });
  await historyRegion.waitFor();
  const historyItem = historyRegion.getByRole("button", {
    name: new RegExp(draftText.replaceAll(".", "\\.")),
  });
  await historyItem.waitFor();
  const searchInput = historyRegion.getByLabel("搜索输入历史");
  assert.equal(
    await searchInput.evaluate((node) => document.activeElement === node),
    true,
  );
  await searchInput.fill("continuity");
  await searchInput.press("Enter");
  await historyItem.waitFor();
  await searchInput.fill("没有命中");
  await searchInput.press("Enter");
  await historyRegion.getByText("没有匹配的输入历史。", { exact: true }).waitFor();
  assert.equal(await historyItem.count(), 0);
  await searchInput.fill("");
  await searchInput.press("Enter");
  await historyItem.waitFor();
  await historyItem.focus();
  await page.keyboard.press("Enter");
  await historyRegion.waitFor({ state: "detached" });
  await page.waitForFunction((expected) => {
    const composer = document.querySelector("form.composer textarea");
    return composer && composer.value === expected;
  }, draftText);
  assert.equal(
    await draftComposer.evaluate((node) => document.activeElement === node),
    true,
  );
  await historyEntry.focus();
  await page.keyboard.press("Enter");
  await historyRegion.waitFor();
  await page.keyboard.press("Escape");
  await historyRegion.waitFor({ state: "detached" });
  assert.equal(
    await historyEntry.evaluate((node) => document.activeElement === node),
    true,
  );
  await historyEntry.click();
  await historyRegion.waitFor();
  await historyItem.waitFor();
  await axe(page, "desktop light input history");
  await page.screenshot({ fullPage: true, path: evidence.inputHistory });
  await page.getByRole("button", { name: /切换到暗色主题/ }).click();
  await page.getByRole("button", { name: /切换到明色主题/ }).waitFor();
  await historyItem.waitFor();
  await axe(page, "desktop dark input history");
  await page.getByRole("button", { name: /切换到明色主题/ }).click();
  await page.getByRole("button", { name: /切换到暗色主题/ }).waitFor();
  pass("input-history-search-keyboard-fill-escape-light-dark-axe");

  await page.setViewportSize({ height: 844, width: 390 });
  await page.reload({ waitUntil: "networkidle" });
  const draftEditorOpener = page.getByRole("button", { name: "打开编辑" });
  await draftEditorOpener.focus();
  await page.keyboard.press("Enter");
  const draftEditor = page.getByRole("dialog", { name: "任务编辑" });
  await draftEditor.getByRole("tab", { name: "群聊" }).click();
  const narrowHistoryEntry = draftEditor.getByRole("button", { name: "输入历史" });
  await narrowHistoryEntry.click();
  const narrowHistoryRegion = draftEditor.getByRole("region", { name: "输入历史" });
  const narrowHistoryItem = narrowHistoryRegion.getByRole("button", {
    name: /Draft continuity smoke note\./,
  });
  await narrowHistoryItem.waitFor();
  const narrowControls = [
    ["entry", narrowHistoryEntry],
    ["search-input", narrowHistoryRegion.getByLabel("搜索输入历史")],
    ["search-submit", narrowHistoryRegion.getByRole("button", { name: "搜索" })],
    ["recording-toggle", narrowHistoryRegion.getByRole("checkbox", { name: "记录新输入历史" })],
    ["history-item", narrowHistoryItem],
    ["clear-all", narrowHistoryRegion.getByRole("button", { name: "清除全部" })],
  ];
  for (const [label, locator] of narrowControls) {
    await locator.scrollIntoViewIfNeeded();
    const box = await locator.boundingBox();
    assert.ok(
      box && box.height >= 44 && box.width >= 44,
      `narrow history control ${label} must stay >= 44px`,
    );
  }
  await axe(page, "narrow input history panel");
  await narrowHistoryRegion.getByLabel("搜索输入历史").focus();
  await page.keyboard.press("Escape");
  await narrowHistoryRegion.waitFor({ state: "detached" });
  assert.equal(
    await draftEditor.evaluate((node) => node.isConnected),
    true,
    "Escape inside the history region must not close the enclosing dialog",
  );
  assert.equal(
    await narrowHistoryEntry.evaluate((node) => document.activeElement === node),
    true,
  );
  await page.keyboard.press("Escape");
  await draftEditor.waitFor({ state: "detached" });
  pass("input-history-narrow-44px-axe-layered-escape");

  await page.setViewportSize({ height: 1050, width: 1500 });
  await page.goto(`${baseUrl}${firstHref}`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "输入历史" }).click();
  const clearRegion = page.getByRole("region", { name: "输入历史" });
  await clearRegion.getByRole("button", { name: /Draft continuity smoke note\./ })
    .waitFor();
  await clearRegion.getByRole("button", { name: "清除全部" }).click();
  await clearRegion.getByText(/确认清除全部输入历史/).waitFor();
  await clearRegion.getByRole("button", { name: "取消" }).click();
  await clearRegion.getByRole("button", { name: /Draft continuity smoke note\./ })
    .waitFor();
  await clearRegion.getByRole("button", { name: "清除全部" }).click();
  const clearResponse = page.waitForResponse((response) =>
    response.request().method() === "DELETE"
    && response.url().includes("/input-history")
  );
  await clearRegion.getByRole("button", { name: "确认清除" }).click();
  assert.equal((await clearResponse).status(), 200);
  await clearRegion.getByText("没有匹配的输入历史。", { exact: true }).waitFor();
  const clearedHistory = await api(
    page,
    "/api/projects/legacy-project/input-history",
  );
  assert.deepEqual(clearedHistory.body.entries, []);
  assert.equal(typeof clearedHistory.body.lastClearedAt, "string");
  await page.keyboard.press("Escape");
  await clearRegion.waitFor({ state: "detached" });
  pass("input-history-clear-two-step-confirm-api-empty");

  const threadState = await readThread(page, "legacy-project", firstThread);
  const liveRunId = threadState.activeRun?.runId;
  assert.ok(liveRunId, "first thread must have an active run for attachment send");
  await page.addInitScript(() => {
    window.__attachmentUploadProgress = [];
    class ObservedXHR extends window.XMLHttpRequest {
      constructor() {
        super();
        this.upload.addEventListener("progress", (event) => {
          window.__attachmentUploadProgress.push({
            lengthComputable: event.lengthComputable,
            loaded: event.loaded,
            total: event.total,
          });
        });
      }
    }
    window.XMLHttpRequest = ObservedXHR;
  });
  await page.goto(`${baseUrl}${firstHref}&run=${liveRunId}`, {
    waitUntil: "networkidle",
  });
  const attachComposer = page.getByLabel("发送给项目群聊");
  await attachComposer.waitFor();

  const attachmentPosts = [];
  const attachmentPostTracker = (request) => {
    if (
      request.method() === "POST"
      && new URL(request.url()).pathname
        === `/api/projects/legacy-project/threads/${firstThread}/attachments`
    ) {
      attachmentPosts.push(request.url());
    }
  };
  page.on("request", attachmentPostTracker);
  await page.getByLabel("选择附件文件").setInputFiles({
    buffer: Buffer.from("thread smoke attachment"),
    mimeType: "text/plain",
    name: "reject-me.txt",
  });
  await page
    .getByText("仅支持 PNG/JPEG/GIF/WebP 图片附件。", { exact: true })
    .waitFor();
  await page.getByLabel("选择附件文件").setInputFiles({
    buffer: Buffer.concat([PNG_1X1, Buffer.alloc(5 * 1024 * 1024)]),
    mimeType: "image/png",
    name: "too-big.png",
  });
  await page
    .getByText("单个附件不能超过 5 MiB。", { exact: true })
    .waitFor();
  assert.deepEqual(
    attachmentPosts,
    [],
    "client-rejected files must never reach the upload route",
  );
  page.off("request", attachmentPostTracker);
  const bogusUpload = await page.evaluate(async (url) => {
    const response = await fetch(url, {
      body: new TextEncoder().encode("declared png but wrong magic"),
      headers: { "content-type": "image/png" },
      method: "POST",
    });
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { body, status: response.status };
  }, `/api/projects/legacy-project/threads/${firstThread}/attachments?name=bogus.png`);
  assert.equal(bogusUpload.status, 400);
  assert.equal(bogusUpload.body?.error?.code, "INVALID_INPUT");
  assert.equal(JSON.stringify(bogusUpload.body).includes(temporaryDirectory), false);
  const oversizedUpload = await page.evaluate(async (url) => {
    const bytes = new Uint8Array(5 * 1024 * 1024 + 1);
    bytes.set([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    ]);
    const response = await fetch(url, {
      body: bytes,
      headers: { "content-type": "image/png" },
      method: "POST",
    });
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { body, status: response.status };
  }, `/api/projects/legacy-project/threads/${firstThread}/attachments?name=too-big-server.png`);
  assert.equal(oversizedUpload.status, 413);
  assert.equal(
    JSON.stringify(oversizedUpload.body).includes(temporaryDirectory),
    false,
  );
  pass("attachment-client-server-rejection-evidence");

  const acceptName = "smoke-attach.png";
  await page.getByLabel("选择附件文件").setInputFiles({
    buffer: PNG_1X1,
    mimeType: "image/png",
    name: acceptName,
  });
  const acceptChip = page.locator("form.composer .mention-chip", {
    hasText: `${acceptName} · ${PNG_1X1.length} B`,
  });
  await acceptChip.waitFor();
  await page.waitForFunction((expected) => {
    const chip = [...document.querySelectorAll("form.composer .mention-chip")]
      .find((candidate) => candidate.textContent?.includes(expected));
    return chip?.textContent?.includes("已上传") ?? false;
  }, acceptName);
  const progressEvents = await page.evaluate(
    () => window.__attachmentUploadProgress ?? [],
  );
  assert.ok(
    progressEvents.some((event) => event.loaded > 0),
    "browser must fire real XHR upload progress events",
  );

  const pasteName = "smoke-pasted.gif";
  const pasteOutcome = await page.evaluate(({ bytes, name }) => {
    const composer = document.querySelector("form.composer textarea");
    if (!composer) return "no-composer";
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array(bytes)], name, { type: "image/gif" }));
    const event = new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: data,
    });
    composer.dispatchEvent(event);
    return "dispatched";
  }, { bytes: Array.from(GIF_1X1), name: pasteName });
  assert.equal(pasteOutcome, "dispatched");
  const pasteChip = page.locator("form.composer .mention-chip", {
    hasText: `${pasteName} · ${GIF_1X1.length} B`,
  });
  await pasteChip.waitFor();
  await page.waitForFunction((expected) => {
    const chip = [...document.querySelectorAll("form.composer .mention-chip")]
      .find((candidate) => candidate.textContent?.includes(expected));
    return chip?.textContent?.includes("已上传") ?? false;
  }, pasteName);
  pass("attachment-select-progress-paste-upload-success");

  const attachMessageText = "Owner message with image attachments.";
  const attachmentSend = page.waitForResponse((response) =>
    response.request().method() === "POST"
    && response.url().endsWith(`/threads/${firstThread}/messages`)
  );
  const contentLoads = [];
  const contentTracker = (response) => {
    const url = new URL(response.url());
    if (
      url.pathname.includes("/attachments/")
      && url.pathname.endsWith("/content")
    ) {
      contentLoads.push({
        cacheControl: response.headers()["cache-control"] ?? "",
        contentType: response.headers()["content-type"] ?? "",
        nosniff: response.headers()["x-content-type-options"] ?? "",
        status: response.status(),
      });
    }
  };
  page.on("response", contentTracker);
  await attachComposer.fill(attachMessageText);
  await page.getByRole("button", { name: "发送消息" }).click();
  const attachmentSendResponse = await attachmentSend;
  assert.equal(
    attachmentSendResponse.status(),
    201,
    `attachment message failed: ${await attachmentSendResponse.text()}`,
  );
  const sentMessage = await attachmentSendResponse.json();
  assert.equal(sentMessage.message.attachments.length, 2);
  assert.deepEqual(
    sentMessage.message.attachments.map((item) => item.fileName).sort(),
    [acceptName, pasteName].sort(),
  );
  const sentRequestBody = JSON.parse(attachmentSendResponse.request().postData());
  assert.equal(sentRequestBody.attachmentIds.length, 2);
  const sentMessageId = sentMessage.message.id;
  for (const name of [acceptName, pasteName]) {
    const image = page.getByRole("img", { exact: true, name });
    await image.waitFor();
    assert.ok(
      (await image.getAttribute("src"))
        ?.startsWith(`/api/projects/legacy-project/threads/${firstThread}/attachments/`),
    );
    await page.waitForFunction((expected) => {
      const node = [...document.querySelectorAll("img")]
        .find((candidate) => candidate.alt === expected);
      return node && node.complete && node.naturalWidth > 0;
    }, name);
  }
  await page
    .getByText(`image/png · ${PNG_1X1.length} B`, { exact: true })
    .waitFor();
  await page
    .getByText(`image/gif · ${GIF_1X1.length} B`, { exact: true })
    .waitFor();
  assert.equal(await page.locator("form.composer .mention-chip").count(), 0);
  assert.ok(
    contentLoads.length >= 2,
    "both attachment images must load through the delivery route",
  );
  for (const load of contentLoads) {
    assert.equal(load.status, 200);
    assert.ok(["image/gif", "image/png"].includes(load.contentType));
    assert.equal(load.nosniff, "nosniff");
    assert.ok(load.cacheControl.includes("private"));
    assert.ok(load.cacheControl.includes("immutable"));
  }
  page.off("response", contentTracker);
  await axe(page, "desktop light attachments transcript");
  await page.screenshot({ fullPage: true, path: evidence.attachmentsDesktop });
  pass("attachment-send-render-alt-metadata-delivery-headers");

  const themeSwitcher = page.getByRole("button", { name: /切换到暗色主题/ });
  await themeSwitcher.click();
  await page.getByRole("button", { name: /切换到明色主题/ }).waitFor();
  await page.getByRole("img", { exact: true, name: acceptName }).waitFor();
  await axe(page, "desktop dark attachments transcript");
  await page.getByRole("button", { name: /切换到明色主题/ }).click();
  await page.getByRole("button", { name: /切换到暗色主题/ }).waitFor();

  const beforeAttachmentRestart = inspectDatabase();
  await restartApp(page);
  // A fresh browser context proves cold-cache persistence: no shared
  // connection pool or HTTP cache with the pre-restart page, so the bytes
  // can only come from the restarted process reading them back from disk.
  const verifyContext = await browser.newContext({
    viewport: { height: 1050, width: 1500 },
  });
  const verifyPage = await verifyContext.newPage();
  verifyPage.setDefaultTimeout(60_000);
  await verifyPage.goto(`${baseUrl}${firstHref}&run=${liveRunId}`, {
    waitUntil: "networkidle",
  });
  await verifyPage.getByText(attachMessageText, { exact: true }).waitFor();
  for (const name of [acceptName, pasteName]) {
    await verifyPage.getByRole("img", { exact: true, name }).waitFor();
  }
  const afterAttachmentRestart = inspectDatabase();
  assert.deepEqual(
    afterAttachmentRestart.attachments,
    beforeAttachmentRestart.attachments,
  );
  assert.deepEqual(
    afterAttachmentRestart.attachmentEvents,
    beforeAttachmentRestart.attachmentEvents,
  );
  const linkedRows = afterAttachmentRestart.attachments;
  assert.equal(linkedRows.length, 2);
  for (const row of linkedRows) {
    assert.equal(row.projectId, "legacy-project");
    assert.equal(row.threadId, firstThread);
    assert.equal(row.status, "linked");
    assert.equal(row.messageId, sentMessageId);
    assert.equal(row.storageRelpath, `legacy-project/${row.id}`);
    const expectedBytes = row.fileName === acceptName ? PNG_1X1 : GIF_1X1;
    const delivery = await evaluateWithNavigationRetry(
      verifyPage,
      async (path) => {
        const response = await fetch(path);
        const bytes = new Uint8Array(await response.arrayBuffer());
        const bitmap = await createImageBitmap(new Blob([bytes]));
        const decoded = { height: bitmap.height, width: bitmap.width };
        bitmap.close();
        return {
          bytes: Array.from(bytes),
          cacheControl: response.headers.get("cache-control") ?? "",
          contentType: response.headers.get("content-type") ?? "",
          decoded,
          nosniff: response.headers.get("x-content-type-options") ?? "",
          status: response.status,
        };
      },
      `/api/projects/legacy-project/threads/${firstThread}/attachments/${row.id}/content`,
    );
    assert.equal(delivery.status, 200);
    assert.equal(delivery.contentType, row.mimeType);
    assert.equal(delivery.nosniff, "nosniff");
    assert.ok(delivery.cacheControl.includes("private"));
    assert.ok(delivery.cacheControl.includes("immutable"));
    assert.deepEqual(
      delivery.bytes,
      Array.from(expectedBytes),
      "restarted process must serve the exact stored bytes",
    );
    assert.deepEqual(
      delivery.decoded,
      { height: 1, width: 1 },
      "delivered bytes must stay decodable images after restart",
    );
  }
  assert.deepEqual(
    afterAttachmentRestart.attachmentEvents.map((event) => event.type).sort(),
    ["linked", "linked", "removed", "uploaded", "uploaded", "uploaded"],
  );
  const attachmentsDisk = join(attachmentsRoot, "legacy-project");
  assert.ok(existsSync(attachmentsDisk));
  assert.deepEqual(
    readdirSync(attachmentsDisk).sort(),
    linkedRows.map((row) => row.id).sort(),
  );
  const pngRow = linkedRows.find((row) => row.fileName === acceptName);
  assert.equal(readFileSync(join(attachmentsDisk, pngRow.id)).equals(PNG_1X1), true);
  const gifRow = linkedRows.find((row) => row.fileName === pasteName);
  assert.equal(readFileSync(join(attachmentsDisk, gifRow.id)).equals(GIF_1X1), true);
  assert.equal(
    existsSync(join(attachmentsDisk, draftAttachmentId)),
    false,
    "removed orphan attachment bytes must be deleted",
  );
  for (const denied of [
    `/api/projects/legacy-project/threads/${secondThread}/attachments/${linkedRows[0].id}/content`,
    `/api/projects/foreign-project/threads/${firstThread}/attachments/${linkedRows[0].id}/content`,
    `/api/projects/legacy-project/threads/${firstThread}/attachments/${randomUUID()}/content`,
  ]) {
    const deniedResponse = await api(verifyPage, denied);
    assert.equal(deniedResponse.status, 404, `expected neutral 404 for ${denied}`);
    assert.equal(
      JSON.stringify(deniedResponse.body).includes(temporaryDirectory),
      false,
      "404 envelope must not echo host paths",
    );
  }
  await verifyContext.close();
  pass("attachment-restart-persistence-delivery-404-disk-evidence");

  await page.setViewportSize({ height: 844, width: 390 });
  await page.reload({ waitUntil: "networkidle" });
  const attachmentEditorOpener = page.getByRole("button", { name: "打开编辑" });
  await attachmentEditorOpener.click();
  const attachmentEditor = page.getByRole("dialog", { name: "任务编辑" });
  await attachmentEditor.getByRole("tab", { name: "群聊" }).click();
  const narrowImage = attachmentEditor.getByRole("img", {
    exact: true,
    name: acceptName,
  });
  await narrowImage.waitFor();
  await attachmentEditor
    .getByText(`image/png · ${PNG_1X1.length} B`, { exact: true })
    .waitFor();
  const narrowList = attachmentEditor.locator(".message-attachments").first();
  await narrowList.scrollIntoViewIfNeeded();
  const narrowListBox = await narrowList.boundingBox();
  assert.ok(narrowListBox && narrowListBox.width > 0);
  assert.ok(narrowListBox.width <= 390);
  const narrowAddButton = attachmentEditor.getByRole("button", { name: "添加附件" });
  await narrowAddButton.scrollIntoViewIfNeeded();
  const narrowAddBox = await narrowAddButton.boundingBox();
  assert.ok(narrowAddBox && narrowAddBox.height >= 44 && narrowAddBox.width >= 44);
  await attachmentEditor.getByLabel("发送给项目群聊").focus();
  let addButtonFocused = false;
  for (let attempt = 0; attempt < 15 && !addButtonFocused; attempt += 1) {
    await page.keyboard.press("Tab");
    addButtonFocused = await narrowAddButton.evaluate(
      (node) => document.activeElement === node,
    );
  }
  assert.ok(addButtonFocused, "添加附件 must be keyboard reachable");
  await axe(page, "narrow attachments transcript");
  await page.screenshot({ fullPage: true, path: evidence.attachmentsNarrow });
  await page.keyboard.press("Escape");
  await attachmentEditor.waitFor({ state: "detached" });
  pass("attachment-narrow-dark-light-44px-keyboard-axe");

  await page.setViewportSize({ height: 1050, width: 1500 });
  await page.goto(`${baseUrl}${firstHref}`, { waitUntil: "networkidle" });
  const threadsList = page.getByRole("navigation", {
    exact: true,
    name: "项目线程",
  });
  const viewTabs = page.getByRole("tablist", { name: "线程视图" });
  const allViewTab = viewTabs.getByRole("tab", { name: "全部" });
  const favoritesViewTab = viewTabs.getByRole("tab", { name: "已收藏" });
  await allViewTab.waitFor();
  assert.equal(await allViewTab.getAttribute("aria-selected"), "true");
  assert.equal(await favoritesViewTab.getAttribute("aria-selected"), "false");
  const favoritesQuery = () =>
    page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === "GET"
        && url.pathname === "/api/projects/legacy-project/threads"
        && url.searchParams.get("favorites") === "true";
    });
  const favoritePut = (threadId) =>
    page.waitForResponse((response) =>
      response.request().method() === "PUT"
      && response.url().endsWith(`/threads/${threadId}/favorite`)
    );
  const favoritesEntryTexts = () =>
    page.evaluate(() =>
      [...document.querySelectorAll("#project-threads-list .thread-list-entry")]
        .map((node) => node.textContent?.trim() ?? "")
    );

  const thirdEntry = threadsList.getByRole("button", {
    exact: true,
    name: "Distinct title",
  });
  const thirdStar = threadsList.getByRole("button", {
    name: "收藏线程 Distinct title",
  });
  await thirdStar.waitFor();
  assert.equal(await thirdStar.getAttribute("aria-pressed"), "false");
  const thirdStarBox = await thirdStar.boundingBox();
  assert.ok(
    thirdStarBox && thirdStarBox.height >= 44 && thirdStarBox.width >= 44,
    "desktop favorite star must stay >= 44px",
  );
  await thirdEntry.focus();
  await page.keyboard.press("Tab");
  assert.equal(
    await thirdStar.evaluate((node) => document.activeElement === node),
    true,
    "favorite star must be one Tab away from its thread entry",
  );
  assert.notEqual(
    await thirdStar.evaluate((node) => getComputedStyle(node).boxShadow),
    "none",
    "focused favorite star must show a visible focus ring",
  );
  const favoriteThird = favoritePut(thirdThread);
  await page.keyboard.press("Space");
  const favoriteThirdResponse = await favoriteThird;
  assert.equal(favoriteThirdResponse.status(), 200);
  const favoriteThirdBody = await favoriteThirdResponse.json();
  assert.deepEqual(
    Object.keys(favoriteThirdBody).sort(),
    ["favoritedAt", "isFavorite", "projectId", "threadId"],
  );
  assert.equal(favoriteThirdBody.isFavorite, true);
  assert.equal(typeof favoriteThirdBody.favoritedAt, "string");
  assert.equal(favoriteThirdBody.projectId, "legacy-project");
  assert.equal(favoriteThirdBody.threadId, thirdThread);
  const thirdUnstar = threadsList.getByRole("button", {
    name: "取消收藏 Distinct title",
  });
  await thirdUnstar.waitFor();
  assert.equal(await thirdUnstar.getAttribute("aria-pressed"), "true");

  const legacyStar = threadsList.getByRole("button", {
    name: "收藏线程 历史协作",
  });
  await legacyStar.waitFor();
  await legacyStar.focus();
  const favoriteLegacy = favoritePut(legacyThreadId);
  await page.keyboard.press("Enter");
  const favoriteLegacyResponse = await favoriteLegacy;
  assert.equal(favoriteLegacyResponse.status(), 200);
  assert.equal((await favoriteLegacyResponse.json()).isFavorite, true);
  const legacyUnstar = threadsList.getByRole("button", {
    name: "取消收藏 历史协作",
  });
  await legacyUnstar.waitFor();
  assert.equal(await legacyUnstar.getAttribute("aria-pressed"), "true");

  const favoritesList = await api(
    page,
    "/api/projects/legacy-project/threads?favorites=true",
  );
  assert.equal(favoritesList.status, 200);
  assert.equal(favoritesList.body.nextCursor, null);
  assert.deepEqual(
    favoritesList.body.threads.map((thread) => thread.id),
    [legacyThreadId, thirdThread],
    "favorites must order by favorited_at DESC",
  );
  for (const item of favoritesList.body.threads) {
    assert.equal(item.isFavorite, true);
    assert.equal(typeof item.favoritedAt, "string");
  }
  const legacyFavoritedAt = favoritesList.body.threads[0].favoritedAt;
  const fullList = await api(
    page,
    "/api/projects/legacy-project/threads?limit=100",
  );
  const favoriteFlags = new Map(
    fullList.body.threads.map((thread) => [thread.id, thread.isFavorite]),
  );
  assert.equal(favoriteFlags.get(legacyThreadId), true);
  assert.equal(favoriteFlags.get(thirdThread), true);
  assert.equal(favoriteFlags.get(firstThread), false);
  assert.equal(favoriteFlags.get(secondThread), false);

  const firstFavoritesLoad = favoritesQuery();
  await favoritesViewTab.click();
  assert.equal((await firstFavoritesLoad).status(), 200);
  await page.waitForFunction(() =>
    document.querySelectorAll("#project-threads-list .thread-list-entry")
      .length === 2
  );
  assert.equal(await favoritesViewTab.getAttribute("aria-selected"), "true");
  assert.equal(await allViewTab.getAttribute("aria-selected"), "false");
  assert.deepEqual(
    await favoritesEntryTexts(),
    ["历史协作", "Distinct title"],
    "favorites view must render favorited_at DESC order",
  );
  assert.equal(new URL(page.url()).searchParams.get("thread"), firstThread);
  assert.equal(
    await page.getByText(/所选线程无效/).count(),
    0,
    "favorites view must keep the current thread context without selection errors",
  );
  await axe(page, "desktop light favorites view");
  await page.screenshot({ fullPage: true, path: evidence.favoritesDesktop });

  const unfavoriteThird = favoritePut(thirdThread);
  await thirdUnstar.click();
  const unfavoriteThirdResponse = await unfavoriteThird;
  assert.equal(unfavoriteThirdResponse.status(), 200);
  assert.equal((await unfavoriteThirdResponse.json()).isFavorite, false);
  await page.waitForFunction(() => {
    const entries = [
      ...document.querySelectorAll("#project-threads-list .thread-list-entry"),
    ];
    return entries.length === 1
      && entries[0].textContent?.trim() === "历史协作";
  });
  pass("favorites-keyboard-toggle-view-order-unfavorite-desktop");

  await page.getByRole("button", { name: /切换到暗色主题/ }).click();
  await page.getByRole("button", { name: /切换到明色主题/ }).waitFor();
  await legacyUnstar.waitFor();
  assert.equal(await legacyUnstar.getAttribute("aria-pressed"), "true");
  await axe(page, "desktop dark favorites view");
  await page.getByRole("button", { name: /切换到明色主题/ }).click();
  await page.getByRole("button", { name: /切换到暗色主题/ }).waitFor();
  pass("favorites-view-dark-light-axe");

  await page.setViewportSize({ height: 844, width: 390 });
  await page.reload({ waitUntil: "networkidle" });
  const favoritesNavOpener = page.getByRole("button", { name: "打开项目导航" });
  await favoritesNavOpener.focus();
  await page.keyboard.press("Enter");
  const favoritesNavDialog = page.getByRole("dialog", { name: "项目导航" });
  await favoritesNavDialog.getByRole("tab", { name: "已收藏" }).click();
  const narrowFavoriteEntry = favoritesNavDialog.getByRole("button", {
    exact: true,
    name: "历史协作",
  });
  await narrowFavoriteEntry.waitFor();
  const narrowStar = favoritesNavDialog.getByRole("button", {
    name: "取消收藏 历史协作",
  });
  assert.equal(await narrowStar.getAttribute("aria-pressed"), "true");
  await narrowStar.scrollIntoViewIfNeeded();
  const narrowStarBox = await narrowStar.boundingBox();
  assert.ok(
    narrowStarBox && narrowStarBox.height >= 44 && narrowStarBox.width >= 44,
    "narrow favorite star must stay >= 44px",
  );
  await narrowFavoriteEntry.focus();
  await page.keyboard.press("Tab");
  assert.equal(
    await narrowStar.evaluate((node) => document.activeElement === node),
    true,
    "narrow favorite star must stay keyboard reachable",
  );
  assert.notEqual(
    await narrowStar.evaluate((node) => getComputedStyle(node).boxShadow),
    "none",
  );
  await axe(page, "narrow favorites view");
  await page.screenshot({ fullPage: true, path: evidence.favoritesNarrow });
  await page.keyboard.press("Escape");
  await favoritesNavDialog.waitFor({ state: "detached" });
  pass("favorites-narrow-drawer-44px-keyboard-focus-axe");

  await page.setViewportSize({ height: 1050, width: 1500 });
  await page.goto(`${baseUrl}${firstHref}`, { waitUntil: "networkidle" });
  const beforeFavoriteRestart = inspectDatabase();
  assert.equal(beforeFavoriteRestart.favorites.length, 1);
  assert.equal(
    beforeFavoriteRestart.favorites[0].projectId,
    "legacy-project",
  );
  assert.equal(beforeFavoriteRestart.favorites[0].threadId, legacyThreadId);
  assert.equal(
    beforeFavoriteRestart.favorites[0].favoritedAt,
    legacyFavoritedAt,
  );
  await restartApp(page);
  await legacyUnstar.waitFor();
  assert.equal(await legacyUnstar.getAttribute("aria-pressed"), "true");
  const afterFavoriteRestart = inspectDatabase();
  assert.deepEqual(
    afterFavoriteRestart.favorites,
    beforeFavoriteRestart.favorites,
  );
  const restartedFavorites = await api(
    page,
    "/api/projects/legacy-project/threads?favorites=true",
  );
  assert.deepEqual(
    restartedFavorites.body.threads.map((thread) => thread.id),
    [legacyThreadId],
  );
  assert.equal(restartedFavorites.body.threads[0].isFavorite, true);
  assert.equal(
    restartedFavorites.body.threads[0].favoritedAt,
    legacyFavoritedAt,
  );
  const restartedFavoritesLoad = favoritesQuery();
  await favoritesViewTab.click();
  assert.equal((await restartedFavoritesLoad).status(), 200);
  await page.waitForFunction(() => {
    const entries = [
      ...document.querySelectorAll("#project-threads-list .thread-list-entry"),
    ];
    return entries.length === 1
      && entries[0].textContent?.trim() === "历史协作";
  });
  await axe(page, "desktop light favorites view after restart");
  pass("favorites-restart-persistence-db-api-view");

  const gitCheckIgnore = spawnSync(
    "git",
    ["check-ignore", ".data/attachments/placeholder"],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  assert.equal(
    gitCheckIgnore.status,
    0,
    `.data/attachments must be git-ignored: ${gitCheckIgnore.stderr}`,
  );
  const gitStatusData = spawnSync(
    "git",
    ["status", "--porcelain", "--", ".data/"],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  assert.equal(gitStatusData.status, 0);
  assert.equal(
    gitStatusData.stdout.trim(),
    "",
    ".data/ must stay out of git status",
  );
  assert.equal(
    existsSync(resolve(".data", "attachments")),
    false,
    "attachment bytes must live beside the isolated smoke database, not the repo",
  );
  pass("attachment-artifacts-git-ignored-isolated-root");

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
  for (const surface of [dom, databaseText, productApiBodies.join("\n"), serverOutput]) {
    assert.equal(
      surface.includes(attachmentsRoot),
      false,
      "host attachment root path leaked",
    );
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
} catch (error) {
  try {
    const failurePath = join(evidenceDirectory, "persistent-threads-failure.txt");
    const page = globalThis.__threadSmokePage;
    const bodyText = page
      ? await page.locator("body").innerText().catch(() => "<unavailable>")
      : "<no page>";
    const pageUrl = page ? page.url() : "<no page>";
    if (page) {
      await page
        .screenshot({
          fullPage: true,
          path: join(evidenceDirectory, "persistent-threads-failure.png"),
        })
        .catch(() => {});
    }
    writeFileSync(
      failurePath,
      [
        `url: ${pageUrl}`,
        `error: ${error?.stack ?? error}`,
        "--- body text (first 4000 chars) ---",
        bodyText.slice(0, 4000),
        "--- server output (last 4000 chars) ---",
        serverOutput.slice(-4000),
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      join(evidenceDirectory, "persistent-threads-failure-server.log"),
      serverOutput,
      "utf8",
    );
    console.log(`FAILURE EVIDENCE: ${failurePath}`);
  } catch {
    // Diagnostics must never mask the original failure.
  }
  throw error;
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
