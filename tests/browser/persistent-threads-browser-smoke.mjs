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
  auditDesktop: join(
    resolve("features", "030-collaboration-audit-events", "evidence"),
    "collaboration-audit-desktop.png",
  ),
  auditDark: join(
    resolve("features", "030-collaboration-audit-events", "evidence"),
    "collaboration-audit-dark.png",
  ),
  auditNarrow: join(
    resolve("features", "030-collaboration-audit-events", "evidence"),
    "collaboration-audit-narrow.png",
  ),
  searchDark: join(
    resolve("features", "031-thread-search", "evidence"),
    "thread-search-dark.png",
  ),
  searchDesktop: join(
    resolve("features", "031-thread-search", "evidence"),
    "thread-search-desktop.png",
  ),
  searchNarrow: join(
    resolve("features", "031-thread-search", "evidence"),
    "thread-search-narrow.png",
  ),
  tagsDark: join(
    resolve("features", "032-thread-tags-bulk-organize", "evidence"),
    "thread-tags-dark.png",
  ),
  tagsDesktop: join(
    resolve("features", "032-thread-tags-bulk-organize", "evidence"),
    "thread-tags-desktop.png",
  ),
  tagsNarrow: join(
    resolve("features", "032-thread-tags-bulk-organize", "evidence"),
    "thread-tags-narrow.png",
  ),
  tagsNarrowDark: join(
    resolve("features", "032-thread-tags-bulk-organize", "evidence"),
    "thread-tags-narrow-dark.png",
  ),
  recycleDesktop: join(
    resolve("features", "033-thread-recycle-bin", "evidence"),
    "thread-recycle-bin-desktop.png",
  ),
  recycleDark: join(
    resolve("features", "033-thread-recycle-bin", "evidence"),
    "thread-recycle-bin-dark.png",
  ),
  recycleNarrow: join(
    resolve("features", "033-thread-recycle-bin", "evidence"),
    "thread-recycle-bin-narrow.png",
  ),
  recycleNarrowDark: join(
    resolve("features", "033-thread-recycle-bin", "evidence"),
    "thread-recycle-bin-narrow-dark.png",
  ),
  queueDesktop: join(
    resolve("features", "034-thread-message-queue-steer", "evidence"),
    "thread-queue-desktop.png",
  ),
  queueDark: join(
    resolve("features", "034-thread-message-queue-steer", "evidence"),
    "thread-queue-dark.png",
  ),
  queueNarrow: join(
    resolve("features", "034-thread-message-queue-steer", "evidence"),
    "thread-queue-narrow.png",
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
let auditFacingText = "";
let narrowAuditFacingText = "";
let searchFacingText = "";
let tagFacingText = "";
let narrowTagFacingText = "";
let recycleFacingText = "";
let narrowRecycleFacingText = "";
let queueFacingText = "";
let narrowQueueFacingText = "";

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
  const targetUrl = currentUrl === "about:blank" ? baseUrl : currentUrl;
  await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForURL(targetUrl, { timeout: 60_000 }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
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
  await page.getByRole("button", { name: "创建 Agent" }).click({ noWaitAfter: true });
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
  const openers = page.getByRole("button", { exact: true, name: "创建线程" });
  await openers.first().click();
  const dialog = page.getByRole("dialog", { name: "创建线程" });
  await dialog.waitFor();
  await dialog.getByRole("textbox", { name: "线程标题" }).fill(title);
  for (const name of memberNames) {
    let checked = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await dialog.getByRole("checkbox", { exact: true, name }).check();
        checked = true;
        break;
      } catch (error) {
        if (attempt === 2) throw error;
        await page.waitForLoadState("networkidle");
        await dialog.waitFor();
      }
    }
    assert.equal(checked, true);
  }
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
  const expectedStatuses = status === "waiting_owner"
    ? new Set(["waiting_owner", "running"])
    : new Set([status]);
  const deadline = Date.now() + 45_000;
  let lastDetail = null;
  while (Date.now() < deadline) {
    const detail = await readThread(page, projectId, threadId);
    lastDetail = detail;
    const run = detail.runs.find((candidate) => expectedStatuses.has(candidate.status));
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
  await page.getByRole("button", { name: "绑定工作区" }).click();
  await page.getByLabel("本地工作区路径").fill(workspaceDirectory);
  await page.getByRole("button", { name: "绑定工作区" }).click();
  await page.getByText("工作区已保存。", { exact: true }).waitFor();
  await page.getByRole("button", { name: "创建使命" }).click();
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
  // A-237 same-wave pin: current canonical schema identity is userVersion 25.
  assert.equal(inspectDatabase().version, 25);
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
  await page.goto(`${baseUrl}${firstHref}`, { waitUntil: "networkidle" });
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
    // This route stays registered for the rest of the run, so every later
    // facts poll passes through here; a poll aborted by a navigation makes
    // fulfill() throw, and a second fulfill attempt crashes the runner with
    // "Route is already handled". Parse and fulfill must therefore live in
    // separate try blocks, and an aborted route is simply dropped.
    try {
      const response = await route.fetch();
      const text = await response.text();
      let body = null;
      try {
        const parsed = JSON.parse(text);
        if (parsed && Array.isArray(parsed.items)) body = parsed;
      } catch {
        // Non-JSON or unexpected payload: fulfill the original response below.
      }
      if (body) {
        body.items = body.items.filter((fact) => fact.message?.id !== cutTargetId);
        await route.fulfill({ response, json: body });
        return;
      }
      await route.fulfill({ response, body: text });
    } catch {
      // The request was aborted mid-handling; the page no longer awaits it.
    }
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
  await page.keyboard.press("Tab");
  await page.waitForFunction(() =>
    !document.activeElement?.classList?.contains("reply-target-highlight")
  );

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
  try {
    await historyRegion.getByText("没有匹配的输入历史。", { exact: true }).waitFor({
      timeout: 15000,
    });
  } catch {
    // Retry once when the first submit races with region refresh.
    await searchInput.press("Enter");
    await historyRegion.getByText("没有匹配的输入历史。", { exact: true }).waitFor();
  }
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
  const favoritesViewTab = viewTabs.getByRole("tab", { name: "收藏" });
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
        .map(
          (node) =>
            node.querySelector(".thread-list-entry-title")?.textContent?.trim()
            ?? node.textContent?.trim()
            ?? "",
        )
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
  let favoriteFocused = false;
  for (let attempt = 0; attempt < 3 && !favoriteFocused; attempt += 1) {
    await page.keyboard.press("Tab");
    favoriteFocused = await thirdStar.evaluate((node) => document.activeElement === node);
  }
  assert.equal(
    favoriteFocused,
    true,
    "favorite star must remain keyboard reachable from its thread entry",
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
  await favoritesNavDialog.getByRole("tab", { name: "收藏" }).click();
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
  let narrowFavoriteFocused = false;
  for (let attempt = 0; attempt < 3 && !narrowFavoriteFocused; attempt += 1) {
    await page.keyboard.press("Tab");
    narrowFavoriteFocused = await narrowStar.evaluate(
      (node) => document.activeElement === node,
    );
  }
  assert.equal(
    narrowFavoriteFocused,
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

  // ---- COLLABORATION AUDIT ACCEPTANCE (feature 030 T-03) ----
  // Landing spot: smoke:threads already produces the richest real
  // collaboration data (owner/agent messages, run lifecycle, decisions), so
  // the collaboration audit section lives here; smoke:execution keeps the
  // execution-domain audit section (028). Readable copy mirror of
  // components/project-context/audit-panel.tsx; unknown types fall back to
  // the raw contract value exactly like the panel does.
  const COLLABORATION_AUDIT_EVENT_TYPE_COPY = {
    action_rejected: "动作已被拒绝",
    agent_message: "Agent 消息",
    boundary_paused: "运行已在边界暂停",
    context_changed: "上下文已变更",
    decision_answered: "决策已答复",
    decision_requested: "决策已请求",
    handoff: "已交棒",
    owner_message: "Owner 消息",
    run_paused: "运行已暂停",
    run_planned: "运行已规划",
    run_resumed: "运行已恢复",
    run_retried: "运行已重试",
    run_started: "运行已开始",
    run_stopped: "运行已停止",
    thread_deleted: "线程已移入回收站",
    thread_purged: "线程已永久删除",
    thread_restored: "线程已恢复",
    task_claimed: "任务已认领",
    tasks_created: "任务已创建",
  };
  const PROJECT_WORKSPACE_AUDIT_EVENT_TYPE_COPY = {
    member_joined: "成员已加入",
    member_removed: "成员已移除",
    project_created: "项目已创建",
    validation_policy_changed: "验证政策已变更",
    workspace_bound: "工作区已绑定",
    workspace_rebound: "工作区已改绑",
  };
  const MISSION_WORK_AUDIT_EVENT_TYPE_COPY = {
    mission_created: "使命已创建",
    task_completed: "任务已完成",
    task_created: "任务已创建",
    task_failed: "任务已失败",
    task_started: "任务已开始",
    work_item_created: "看板任务已创建",
    work_item_status_changed: "看板任务状态已变更",
  };
  const AUDIT_EVENT_TYPE_COPY = {
    ...COLLABORATION_AUDIT_EVENT_TYPE_COPY,
    ...PROJECT_WORKSPACE_AUDIT_EVENT_TYPE_COPY,
    ...MISSION_WORK_AUDIT_EVENT_TYPE_COPY,
  };
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
  }, "legacy-project");
  assert.equal(auditApi.status, 200, JSON.stringify(auditApi.error));
  const auditEvents = auditApi.pages.flatMap(({ events }) => events);
  assert.ok(auditEvents.length > 0, "real collaboration must produce audit events");
  assert.equal(
    auditApi.pages[0].freshness.status,
    "caught_up",
    JSON.stringify(auditApi.pages[0].freshness),
  );
  for (let index = 1; index < auditEvents.length; index += 1) {
    assert.ok(
      auditEvents[index - 1].outboxSeq > auditEvents[index].outboxSeq,
      "audit events must be globally descending by outbox_seq",
    );
  }
  // After 036/035 source-owner outbox, this smoke also projects project and
  // mission events (member_removed, mission_created, …). Collaboration
  // thread-identity assertions apply only to collaboration-typed rows.
  const collaborationEvents = auditEvents.filter((event) =>
    Object.hasOwn(COLLABORATION_AUDIT_EVENT_TYPE_COPY, event.eventType),
  );
  assert.ok(collaborationEvents.length > 0, "collaboration events must be present");
  for (const event of auditEvents) {
    if (Object.hasOwn(COLLABORATION_AUDIT_EVENT_TYPE_COPY, event.eventType)) {
      assert.equal(event.executionId, null);
      assert.equal(typeof event.payload.threadId, "string");
    }
  }
  const auditEventTypes = new Set(auditEvents.map((event) => event.eventType));
  for (const required of [
    "agent_message",
    "decision_requested",
    "owner_message",
    "run_started",
    "run_stopped",
  ]) {
    assert.ok(auditEventTypes.has(required), `audit trail must include ${required}`);
  }
  const attachOwnerMessage = auditEvents.find((event) =>
    event.eventType === "owner_message"
    && event.payload.messageExcerpt === "Owner message with image attachments."
  );
  assert.ok(attachOwnerMessage, "owner message excerpt must reach the audit trail");
  assert.equal(attachOwnerMessage.payload.threadId, firstThread);
  assert.equal(attachOwnerMessage.payload.runId, null);
  const secondThreadNote = auditEvents.find((event) =>
    event.eventType === "owner_message"
    && event.payload.messageExcerpt === "Second-thread owner note."
  );
  assert.ok(secondThreadNote, "second-thread owner note must reach the audit trail");
  assert.equal(secondThreadNote.payload.threadId, secondThread);
  assert.equal(secondThreadNote.payload.runId, null);
  const stoppedEvent = auditEvents.find((event) =>
    event.eventType === "run_stopped" && event.payload.runId === activeRun.id
  );
  assert.ok(stoppedEvent, "run_stopped must carry the stopped run identity");
  assert.equal(stoppedEvent.payload.threadId, firstThread);
  const auditApiText = JSON.stringify(auditApi.pages);
  for (const value of [
    apiKey,
    masterKey,
    `Bearer ${apiKey}`,
    temporaryDirectory,
    workspaceDirectory,
    attachmentsRoot,
    "Authorization:",
  ]) {
    assert.ok(!auditApiText.includes(value), "audit API payload leaked a forbidden marker");
  }
  const foreignAudit = await api(page, "/api/projects/foreign-project/audit-events");
  assert.equal(foreignAudit.status, 404);
  assert.equal(
    JSON.stringify(foreignAudit.body).includes(temporaryDirectory),
    false,
    "404 envelope must not echo host paths",
  );
  const auditDatabaseCounts = (() => {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const scalar = (sql) => Number(database.prepare(sql).get().value);
      return {
        checkpoint: Number(database.prepare(`
          SELECT last_outbox_seq AS value FROM audit_projection_checkpoints
          WHERE consumer_id='audit-event-projection'
        `).get().value),
        collaboration: scalar(
          "SELECT COUNT(*) AS value FROM audit_event_outbox WHERE source='public_collaboration'",
        ),
        maxSeq: scalar("SELECT COALESCE(MAX(outbox_seq),0) AS value FROM audit_event_outbox"),
        noise: scalar(
          "SELECT COUNT(*) AS value FROM audit_event_outbox"
          + " WHERE event_type IN ('model_call_started','model_call_succeeded','model_call_failed','usage_recorded','attempt_interrupted')",
        ),
        outbox: scalar("SELECT COUNT(*) AS value FROM audit_event_outbox"),
        projection: scalar("SELECT COUNT(*) AS value FROM audit_event_projection"),
      };
    } finally {
      database.close();
    }
  })();
  assert.equal(auditDatabaseCounts.outbox, auditEvents.length, "API must expose every outbox event");
  assert.equal(
    auditDatabaseCounts.collaboration,
    collaborationEvents.length,
    "collaboration outbox rows must match collaboration-typed API events",
  );
  assert.equal(auditDatabaseCounts.projection, auditDatabaseCounts.outbox, "read path must catch up the projection");
  assert.equal(auditDatabaseCounts.checkpoint, auditDatabaseCounts.maxSeq, "checkpoint must be caught up");
  assert.equal(auditDatabaseCounts.noise, 0, "noise event types must never enter the audit trail");
  pass("collaboration-audit-api-projection-consistency", {
    events: auditEvents.length,
    pages: auditApi.pages.length,
  });

  await page.goto(`${baseUrl}${firstHref}`, { waitUntil: "networkidle" });
  const auditContextPanel = page.locator(".cockpit-context");
  await auditContextPanel.getByRole("tab", { name: "共享记忆" }).focus();
  // Same-page baseline with the audit panel still unmounted, so any axe
  // violation present here is pre-existing cockpit chrome, not the panel.
  await axe(page, "desktop light memory tab audit baseline");
  await page.keyboard.press("End");
  const auditTab = auditContextPanel.getByRole("tab", { name: "审计" });
  assert.equal(await auditTab.getAttribute("aria-selected"), "true");
  assert.equal(
    await auditTab.evaluate((node) => document.activeElement === node),
    true,
    "End key must move focus to the audit tab",
  );
  const auditList = auditContextPanel.getByRole("list", { name: "审计事件" });
  await auditList.waitFor();
  await auditContextPanel.getByText("已追平", { exact: true }).waitFor();
  const auditRows = auditList.getByRole("listitem");
  const firstPageRows = Math.min(auditEvents.length, 50);
  await page.waitForFunction(
    (expected) => document.querySelectorAll(".audit-event-list > li").length === expected,
    firstPageRows,
  );
  const firstRowText = await auditRows.first().innerText();
  assert.ok(
    firstRowText.includes(
      AUDIT_EVENT_TYPE_COPY[auditEvents[0].eventType] ?? auditEvents[0].eventType,
    ),
    `first audit row must show readable type copy: ${firstRowText}`,
  );
  const lastFirstPageRowText = await auditRows.nth(firstPageRows - 1).innerText();
  assert.ok(
    lastFirstPageRowText.includes(
      AUDIT_EVENT_TYPE_COPY[auditEvents[firstPageRows - 1].eventType]
        ?? auditEvents[firstPageRows - 1].eventType,
    ),
    `last first-page audit row must keep descending order: ${lastFirstPageRowText}`,
  );
  for (let click = 0; click < 12; click += 1) {
    const moreButton = auditContextPanel.getByRole("button", { name: "加载更多审计事件" });
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
    "audit list must render every projected event",
  );
  assert.equal(
    await auditList.locator(".status-label.status-queued").count(),
    collaborationEvents.length,
    "collaboration rows must carry the collaboration domain badge",
  );
  const excerptRow = auditRows.nth(auditEvents.indexOf(attachOwnerMessage));
  assert.equal(
    await excerptRow.locator(".audit-event-excerpt").innerText(),
    "Owner message with image attachments.",
    "message events must render the truncated public excerpt",
  );
  const stoppedLink = auditRows.nth(auditEvents.indexOf(stoppedEvent))
    .getByRole("link", { name: "定位来源线程" });
  assert.equal(
    await stoppedLink.getAttribute("href"),
    `/projects/legacy-project?thread=${firstThread}&run=${activeRun.id}`,
  );
  const noteLink = auditRows.nth(auditEvents.indexOf(secondThreadNote))
    .getByRole("link", { name: "定位来源线程" });
  assert.equal(
    await noteLink.getAttribute("href"),
    `/projects/legacy-project?thread=${secondThread}`,
    "run-less owner message must link to the thread without a run param",
  );
  const auditTabBox = await auditTab.boundingBox();
  assert.ok(auditTabBox && auditTabBox.height >= 44 && auditTabBox.width >= 44, "audit tab must be at least 44x44");
  const stoppedLinkBox = await stoppedLink.boundingBox();
  assert.ok(stoppedLinkBox && stoppedLinkBox.height >= 44 && stoppedLinkBox.width >= 44, "locate link must be at least 44x44");
  await stoppedLink.focus();
  assert.notEqual(
    await stoppedLink.evaluate((node) => getComputedStyle(node).boxShadow),
    "none",
    "focused locate link must show a visible focus ring",
  );
  await page.keyboard.press("Enter");
  try {
    await page.waitForURL(
      (url) => url.searchParams.get("thread") === firstThread
        && url.searchParams.get("run") === activeRun.id,
      { timeout: 10_000 },
    );
  } catch {
    await stoppedLink.focus();
    await page.keyboard.press("Enter");
    await page.waitForURL((url) =>
      url.searchParams.get("thread") === firstThread
      && url.searchParams.get("run") === activeRun.id
    );
  }
  const landedRunSelector = page.getByRole("combobox", { name: "选择线程运行" });
  await landedRunSelector.waitFor();
  assert.equal(
    await landedRunSelector.inputValue(),
    activeRun.id,
    "locate link must land on the canonical thread+run identity",
  );
  pass("collaboration-audit-desktop-list-badge-excerpt-locate", {
    events: auditEvents.length,
  });

  await auditContextPanel.getByRole("tab", { name: "审计" }).click();
  await auditList.waitFor();
  await auditContextPanel.getByText("已追平", { exact: true }).waitFor();
  await page.waitForFunction(
    (expected) => document.querySelectorAll(".audit-event-list > li").length === expected,
    firstPageRows,
  );
  await axe(page, "desktop light collaboration audit panel");
  await page.screenshot({ fullPage: true, path: evidence.auditDesktop });
  auditFacingText = await page.locator("html").innerText();
  await page.getByRole("button", { name: /切换到暗色主题/ }).click();
  await page.getByRole("button", { name: /切换到明色主题/ }).waitFor();
  await auditContextPanel.getByText("已追平", { exact: true }).waitFor();
  const darkFirstRowText = await auditRows.first().innerText();
  assert.ok(
    darkFirstRowText.includes(
      AUDIT_EVENT_TYPE_COPY[auditEvents[0].eventType] ?? auditEvents[0].eventType,
    ),
    "dark theme must keep the audit presentation",
  );
  await axe(page, "desktop dark collaboration audit panel");
  await page.screenshot({ fullPage: true, path: evidence.auditDark });
  await page.getByRole("button", { name: /切换到明色主题/ }).click();
  await page.getByRole("button", { name: /切换到暗色主题/ }).waitFor();
  pass("collaboration-audit-desktop-light-dark-axe");

  await page.setViewportSize({ height: 844, width: 390 });
  await page.reload({ waitUntil: "networkidle" });
  const auditContextOpener = page.getByRole("button", { name: "打开当前任务上下文" });
  await auditContextOpener.focus();
  await page.keyboard.press("Enter");
  const auditContextDrawer = page.getByRole("dialog", { name: "当前任务上下文" });
  const narrowAuditTab = auditContextDrawer.getByRole("tab", { name: "审计" });
  await narrowAuditTab.focus();
  await page.keyboard.press("Enter");
  assert.equal(await narrowAuditTab.getAttribute("aria-selected"), "true");
  const narrowAuditList = auditContextDrawer.getByRole("list", { name: "审计事件" });
  await narrowAuditList.waitFor();
  await auditContextDrawer.getByText("已追平", { exact: true }).waitFor();
  await page.waitForFunction(
    (expected) => document.querySelectorAll(".audit-event-list > li").length === expected,
    firstPageRows,
  );
  const narrowRows = narrowAuditList.getByRole("listitem");
  const narrowFirstRowText = await narrowRows.first().innerText();
  assert.ok(
    narrowFirstRowText.includes(
      AUDIT_EVENT_TYPE_COPY[auditEvents[0].eventType] ?? auditEvents[0].eventType,
    ),
    "narrow drawer must keep the audit presentation",
  );
  assert.equal(
    await narrowRows.nth(auditEvents.indexOf(attachOwnerMessage))
      .locator(".audit-event-excerpt").innerText(),
    "Owner message with image attachments.",
  );
  const narrowLocateLink = narrowRows.nth(auditEvents.indexOf(stoppedEvent))
    .getByRole("link", { name: "定位来源线程" });
  assert.equal(
    await narrowLocateLink.getAttribute("href"),
    `/projects/legacy-project?thread=${firstThread}&run=${activeRun.id}`,
  );
  const narrowLocateBox = await narrowLocateLink.boundingBox();
  assert.ok(narrowLocateBox && narrowLocateBox.height >= 44 && narrowLocateBox.width >= 44, "narrow locate link must be at least 44x44");
  const narrowAuditTabBox = await narrowAuditTab.boundingBox();
  assert.ok(narrowAuditTabBox && narrowAuditTabBox.height >= 44 && narrowAuditTabBox.width >= 44, "narrow audit tab must be at least 44x44");
  await axe(page, "narrow collaboration audit drawer");
  await page.screenshot({ fullPage: true, path: evidence.auditNarrow });
  narrowAuditFacingText = await page.locator("html").innerText();
  await page.keyboard.press("Escape");
  await auditContextDrawer.waitFor({ state: "detached" });
  assert.equal(
    await auditContextOpener.evaluate((node) => document.activeElement === node),
    true,
    "Escape must return focus to the context drawer opener",
  );
  pass("collaboration-audit-narrow-drawer-44px-axe");

  // ---- feature 031 T-04: thread search real-browser acceptance ----
  // Seeded after the audit section so the new outbox rows cannot shift the
  // earlier exact audit assertions. Keywords are unique across the fixture:
  // "quokka" lives in a legacy-project message (content hit), "云雀" in a
  // legacy-project thread title (title hit), "walrus" only in a foreign
  // project (cross-project isolation + empty state).
  await page.setViewportSize({ height: 1050, width: 1500 });

  const foreignProject = await api(page, "/api/projects", {
    body: JSON.stringify({ name: "外部检索隔离项目" }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(
    foreignProject.status,
    201,
    `foreign project create failed: ${JSON.stringify(foreignProject.body)}`,
  );
  const foreignProjectId = foreignProject.body.project.id;
  assert.ok(foreignProjectId);
  const foreignMembers = await api(
    page,
    `/api/projects/${foreignProjectId}/members`,
  );
  assert.equal(foreignMembers.status, 200);
  const foreignMembersUpdate = await api(
    page,
    `/api/projects/${foreignProjectId}/members`,
    {
      body: JSON.stringify({
        agentIds: [alpha.id, beta.id],
        expectedProjectVersion: foreignMembers.body.projectVersion,
      }),
      headers: { "content-type": "application/json" },
      method: "PUT",
    },
  );
  assert.equal(
    foreignMembersUpdate.status,
    200,
    `foreign members update failed: ${JSON.stringify(foreignMembersUpdate.body)}`,
  );
  const foreignThreadPost = await api(
    page,
    `/api/projects/${foreignProjectId}/threads`,
    {
      body: JSON.stringify({
        memberAgentIds: [alpha.id, beta.id],
        operationId: randomUUID(),
        title: "外部隔离线程",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
  );
  assert.equal(
    foreignThreadPost.status,
    201,
    `foreign thread create failed: ${JSON.stringify(foreignThreadPost.body)}`,
  );
  const foreignThreadId = foreignThreadPost.body.thread.id;
  const foreignMessagePost = await api(
    page,
    `/api/projects/${foreignProjectId}/threads/${foreignThreadId}/messages`,
    {
      body: JSON.stringify({
        content: "walrus 独有用词仅属外部项目。",
        operationId: randomUUID(),
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
  );
  assert.equal(
    foreignMessagePost.status,
    201,
    `foreign message post failed: ${JSON.stringify(foreignMessagePost.body)}`,
  );

  const larkThreadPost = await api(page, "/api/projects/legacy-project/threads", {
    body: JSON.stringify({
      memberAgentIds: ["legacy-agent-a", "legacy-agent-b"],
      operationId: randomUUID(),
      title: "云雀发布计划",
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(
    larkThreadPost.status,
    201,
    `title-hit thread create failed: ${JSON.stringify(larkThreadPost.body)}`,
  );
  const larkThreadId = larkThreadPost.body.thread.id;
  const larkMessagePost = await api(
    page,
    `/api/projects/legacy-project/threads/${larkThreadId}/messages`,
    {
      body: JSON.stringify({
        content: "排期已与成员确认。",
        operationId: randomUUID(),
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
  );
  assert.equal(larkMessagePost.status, 201);
  const quokkaPost = await api(
    page,
    `/api/projects/legacy-project/threads/${firstThread}/messages`,
    {
      body: JSON.stringify({
        content: "上线前再核对 quokka 检查单。",
        operationId: randomUUID(),
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
  );
  assert.equal(
    quokkaPost.status,
    201,
    `quokka message post failed: ${JSON.stringify(quokkaPost.body)}`,
  );
  const quokkaMessageId = quokkaPost.body.message.id;
  assert.ok(quokkaMessageId);

  const searchApi = (projectId, query) =>
    api(
      page,
      `/api/projects/${projectId}/thread-search?q=${encodeURIComponent(query)}`,
    );
  const quokkaSearch = await searchApi("legacy-project", "quokka");
  assert.equal(quokkaSearch.status, 200);
  assert.equal(quokkaSearch.body.nextCursor, null);
  assert.equal(quokkaSearch.body.results.length, 1);
  assert.equal(quokkaSearch.body.results[0].kind, "message");
  assert.equal(quokkaSearch.body.results[0].messageId, quokkaMessageId);
  assert.equal(quokkaSearch.body.results[0].threadId, firstThread);
  assert.ok(quokkaSearch.body.results[0].snippet.includes("quokka"));
  const larkSearch = await searchApi("legacy-project", "云雀");
  assert.equal(larkSearch.status, 200);
  assert.equal(larkSearch.body.results.length, 1);
  assert.equal(larkSearch.body.results[0].kind, "thread_title");
  assert.equal(larkSearch.body.results[0].messageId, null);
  assert.equal(larkSearch.body.results[0].threadId, larkThreadId);
  assert.ok(larkSearch.body.results[0].snippet.includes("云雀发布计划"));
  const foreignWalrus = await searchApi(foreignProjectId, "walrus");
  assert.equal(foreignWalrus.status, 200);
  assert.equal(foreignWalrus.body.results.length, 1);
  assert.equal(foreignWalrus.body.results[0].kind, "message");
  const legacyWalrus = await searchApi("legacy-project", "walrus");
  assert.equal(legacyWalrus.status, 200);
  assert.deepEqual(legacyWalrus.body.results, []);
  const foreignLark = await searchApi(foreignProjectId, "云雀");
  assert.equal(foreignLark.status, 200);
  assert.deepEqual(foreignLark.body.results, []);
  const unknownProjectSearch = await searchApi("foreign-project", "walrus");
  assert.equal(unknownProjectSearch.status, 404);
  assert.equal(unknownProjectSearch.body?.error?.code, "PROJECT_NOT_FOUND");
  for (const body of [
    quokkaSearch.body,
    larkSearch.body,
    foreignWalrus.body,
    legacyWalrus.body,
  ]) {
    const text = JSON.stringify(body);
    assert.equal(text.includes(apiKey), false, "search response leaks apiKey");
    assert.equal(
      text.includes(masterKey),
      false,
      "search response leaks masterKey",
    );
  }
  pass("thread-search-api-kinds-snippet-cross-project-isolation");

  await page.goto(`${baseUrl}${firstHref}`, { waitUntil: "networkidle" });
  const threadSearchInput = page.getByLabel("搜索线程");
  await threadSearchInput.waitFor();
  await threadSearchInput.click();
  await threadSearchInput.pressSequentially("quokka");
  const searchRegion = page.getByRole("region", { name: "线程搜索结果" });
  await searchRegion.waitFor();
  const quokkaResult = searchRegion.locator(".thread-search-result", {
    hasText: "quokka",
  });
  await quokkaResult.waitFor();
  assert.equal(await searchRegion.locator(".thread-search-result").count(), 1);
  const quokkaResultText = await quokkaResult.innerText();
  assert.ok(quokkaResultText.includes("内容"), "message hit must show 内容 badge");
  assert.ok(quokkaResultText.includes("quokka"), "snippet must carry the keyword");
  const threadSearchInputBox = await threadSearchInput.boundingBox();
  assert.ok(
    threadSearchInputBox
    && threadSearchInputBox.height >= 44
    && threadSearchInputBox.width >= 44,
    "search input must be at least 44x44",
  );
  const quokkaResultBox = await quokkaResult.boundingBox();
  assert.ok(
    quokkaResultBox && quokkaResultBox.height >= 44 && quokkaResultBox.width >= 44,
    "search result must be at least 44x44",
  );
  searchFacingText = await page.locator("html").innerText();
  await axe(page, "desktop light thread search results");
  await page.screenshot({ fullPage: true, path: evidence.searchDesktop });
  await threadSearchInput.focus();
  await page.keyboard.press("ArrowDown");
  assert.equal(
    await quokkaResult.evaluate((node) => document.activeElement === node),
    true,
    "ArrowDown must move focus into the result list",
  );
  const resultFocusShadow = await quokkaResult.evaluate(
    (node) => getComputedStyle(node).boxShadow,
  );
  assert.notEqual(
    resultFocusShadow,
    "none",
    "keyboard-focused search result must show a visible focus ring",
  );
  await page.keyboard.press("Enter");
  await page.waitForURL((url) =>
    url.searchParams.get("thread") === firstThread
    && url.searchParams.get("message") === quokkaMessageId
  );
  const locatedMessage = page.locator("li.reply-target-highlight", {
    hasText: "quokka",
  });
  await locatedMessage.waitFor();
  assert.equal(
    await locatedMessage.evaluate((node) => document.activeElement === node),
    true,
    "located message must receive real focus",
  );
  const locatedBox = await locatedMessage.boundingBox();
  assert.ok(
    locatedBox && locatedBox.y >= 0 && locatedBox.y < 1050,
    "located message must be scrolled into the viewport",
  );
  await axe(page, "desktop light located search message");
  pass("thread-search-desktop-light-keyboard-locate-44px-axe");

  await threadSearchInput.click();
  await page.keyboard.press("Escape");
  assert.equal(await threadSearchInput.inputValue(), "");
  await searchRegion.waitFor({ state: "detached" });
  await threadSearchInput.pressSequentially("云雀");
  await searchRegion.waitFor();
  const larkResult = searchRegion.locator(".thread-search-result", {
    hasText: "云雀发布计划",
  });
  await larkResult.waitFor();
  assert.equal(await searchRegion.locator(".thread-search-result").count(), 1);
  assert.ok(
    (await larkResult.innerText()).includes("标题"),
    "title hit must show 标题 badge",
  );
  await larkResult.click();
  await page.waitForURL((url) =>
    url.searchParams.get("thread") === larkThreadId
    && url.searchParams.get("message") === null
  );
  pass("thread-search-title-hit-navigation");

  await threadSearchInput.click();
  await threadSearchInput.fill("");
  await threadSearchInput.pressSequentially("walrus");
  await searchRegion.waitFor();
  await searchRegion.getByText("无匹配结果。", { exact: true }).waitFor();
  assert.equal(await searchRegion.locator(".thread-search-result").count(), 0);
  pass("thread-search-empty-state-foreign-keyword");

  const searchRoutePredicate = (url) =>
    url.pathname === "/api/projects/legacy-project/thread-search";
  await page.route(searchRoutePredicate, async (route) => {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_200));
    await route.continue();
  });
  try {
    await threadSearchInput.fill("");
    await threadSearchInput.pressSequentially("quokka");
    const loadingStatus = page
      .getByRole("status")
      .filter({ hasText: "正在搜索…" });
    await loadingStatus.waitFor();
    await searchRegion
      .locator(".thread-search-result", { hasText: "quokka" })
      .waitFor();
    await loadingStatus.waitFor({ state: "detached" });
  } finally {
    await page.unroute(searchRoutePredicate);
  }
  pass("thread-search-loading-state");

  await page.getByRole("button", { name: /切换到暗色主题/ }).click();
  await page.getByRole("button", { name: /切换到明色主题/ }).waitFor();
  await searchRegion
    .locator(".thread-search-result", { hasText: "quokka" })
    .waitFor();
  await axe(page, "desktop dark thread search results");
  await page.screenshot({ fullPage: true, path: evidence.searchDark });
  await page.getByRole("button", { name: /切换到明色主题/ }).click();
  await page.getByRole("button", { name: /切换到暗色主题/ }).waitFor();
  pass("thread-search-desktop-dark-light-axe");

  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto(`${baseUrl}${firstHref}`, { waitUntil: "networkidle" });
  const searchNavOpener = page.getByRole("button", { name: "打开项目导航" });
  await searchNavOpener.click();
  const searchDrawer = page.getByRole("dialog", { name: "项目导航" });
  await searchDrawer.waitFor();
  const narrowSearchInput = searchDrawer.getByLabel("搜索线程");
  await narrowSearchInput.click();
  await narrowSearchInput.pressSequentially("quokka");
  const narrowSearchRegion = searchDrawer.getByRole("region", {
    name: "线程搜索结果",
  });
  await narrowSearchRegion.waitFor();
  const narrowResult = narrowSearchRegion.locator(".thread-search-result", {
    hasText: "quokka",
  });
  await narrowResult.waitFor();
  const narrowInputBox = await narrowSearchInput.boundingBox();
  assert.ok(
    narrowInputBox && narrowInputBox.height >= 44 && narrowInputBox.width >= 44,
    "narrow search input must be at least 44x44",
  );
  const narrowResultBox = await narrowResult.boundingBox();
  assert.ok(
    narrowResultBox && narrowResultBox.height >= 44 && narrowResultBox.width >= 44,
    "narrow search result must be at least 44x44",
  );
  await narrowSearchInput.focus();
  await page.keyboard.press("ArrowDown");
  assert.equal(
    await narrowResult.evaluate((node) => document.activeElement === node),
    true,
    "narrow ArrowDown must move focus into the result list",
  );
  const narrowFocusShadow = await narrowResult.evaluate(
    (node) => getComputedStyle(node).boxShadow,
  );
  assert.notEqual(
    narrowFocusShadow,
    "none",
    "narrow keyboard-focused search result must show a visible focus ring",
  );
  await axe(page, "narrow thread search drawer");
  await page.screenshot({ fullPage: true, path: evidence.searchNarrow });
  await page.keyboard.press("Escape");
  assert.equal(await narrowSearchInput.inputValue(), "");
  await narrowSearchRegion.waitFor({ state: "detached" });
  assert.equal(
    await searchDrawer.isVisible(),
    true,
    "Escape with an active query must clear the search, not close the drawer",
  );
  assert.equal(
    await narrowSearchInput.evaluate((node) => document.activeElement === node),
    true,
    "Escape must return focus to the search input",
  );
  await page.keyboard.press("Escape");
  await searchDrawer.waitFor({ state: "detached" });
  assert.equal(
    await searchNavOpener.evaluate((node) => document.activeElement === node),
    true,
    "a second Escape must close the drawer and return focus to its opener",
  );
  pass("thread-search-narrow-44px-focus-layered-escape-axe");

  await searchNavOpener.click();
  await searchDrawer.waitFor();
  await narrowSearchInput.click();
  await narrowSearchInput.pressSequentially("quokka");
  await narrowResult.waitFor();
  await narrowResult.click();
  await page.waitForURL((url) =>
    url.searchParams.get("thread") === firstThread
    && url.searchParams.get("message") === quokkaMessageId
  );
  await searchDrawer.getByRole("button", { name: "关闭项目导航" }).click();
  await searchDrawer.waitFor({ state: "detached" });
  await page.getByRole("button", { name: "打开编辑" }).click();
  const searchEditorDrawer = page.getByRole("dialog", { name: "任务编辑" });
  await searchEditorDrawer.waitFor();
  await searchEditorDrawer.getByRole("tab", { name: "群聊" }).click();
  await searchEditorDrawer
    .getByText("上线前再核对 quokka 检查单。", { exact: true })
    .waitFor();
  await page.keyboard.press("Escape");
  await searchEditorDrawer.waitFor({ state: "detached" });
  pass("thread-search-narrow-result-navigation-locate");

  // ---- feature 032 T-05: thread tags & bulk organize real-browser acceptance ----
  // Cohesive single block after the 031 search section and before the terminal
  // scans (031 A-179 zero-displacement precedent). Tag names are unique across
  // the fixture: 发布阻塞/缺陷跟踪/文档待办 live in legacy-project, 外部标签 in
  // the foreign project created by the search section (isolation probes).
  await page.setViewportSize({ height: 1050, width: 1500 });
  await page.goto(`${baseUrl}${firstHref}`, { waitUntil: "networkidle" });

  const waitForActiveElement = (selector) =>
    page.waitForFunction(
      (expected) => document.activeElement?.matches(expected) ?? false,
      selector,
    );
  const waitForActiveText = (text) =>
    page.waitForFunction(
      (expected) => document.activeElement?.textContent === expected,
      text,
    );

  const manageTagsOpener = page.getByRole("button", { name: "管理标签" });
  await manageTagsOpener.waitFor();
  await manageTagsOpener.click();
  const manageDialog = page.getByRole("dialog", { name: "管理标签" });
  await manageDialog.waitFor();
  const newTagInput = manageDialog.getByLabel("新标签名称");
  await manageDialog
    .getByText("暂无标签。创建标签后开始整理线程。", { exact: true })
    .waitFor();
  await waitForActiveElement(".manage-tags-dialog #new-thread-tag-name");
  assert.equal(
    await newTagInput.evaluate((node) => document.activeElement === node),
    true,
    "manage dialog must move focus to the new tag input",
  );
  await newTagInput.fill("   ");
  await manageDialog.getByRole("button", { name: "创建标签" }).click();
  await manageDialog.getByText("请输入标签名称。", { exact: true }).waitFor();
  const createTagSubmit = manageDialog.getByRole("button", { name: "创建标签" });
  const createTagSubmitBox = await createTagSubmit.boundingBox();
  assert.ok(
    createTagSubmitBox
    && createTagSubmitBox.height >= 44
    && createTagSubmitBox.width >= 44,
    "create tag submit must stay >= 44px",
  );
  await newTagInput.fill("发布阻塞");
  await createTagSubmit.click();
  await manageDialog
    .getByText("已创建标签“发布阻塞”。", { exact: true })
    .waitFor();
  await newTagInput.fill("  发布阻塞  ");
  await createTagSubmit.click();
  await manageDialog
    .getByText("标签“发布阻塞”已存在。", { exact: true })
    .waitFor();
  assert.equal(
    await manageDialog.locator(".thread-tag-manage-item").count(),
    1,
    "folded duplicate create must not add a second row",
  );
  await newTagInput.fill("缺陷跟踪");
  await createTagSubmit.click();
  await manageDialog
    .getByText("已创建标签“缺陷跟踪”。", { exact: true })
    .waitFor();
  await newTagInput.fill("文档待办");
  await createTagSubmit.click();
  await manageDialog
    .getByText("已创建标签“文档待办”。", { exact: true })
    .waitFor();
  await page.waitForFunction(() =>
    document.querySelectorAll(".thread-tag-manage-item").length === 3
  );
  assert.equal(
    await manageDialog.getByText("已分配 0 条线程", { exact: true }).count(),
    3,
    "fresh tags must report zero assignments",
  );
  const manageTagSearch = manageDialog.getByLabel("搜索标签");
  await manageTagSearch.fill("缺陷");
  await page.waitForFunction(() =>
    document.querySelectorAll(".thread-tag-manage-item").length === 1
  );
  await manageDialog.getByText("缺陷跟踪", { exact: true }).waitFor();
  await manageTagSearch.fill("不存在的标签");
  await manageDialog.getByText("无匹配标签。", { exact: true }).waitFor();
  assert.equal(
    await manageDialog.locator(".thread-tag-manage-item").count(),
    0,
    "manage search empty state must list no items",
  );
  await manageTagSearch.fill("");
  await page.waitForFunction(() =>
    document.querySelectorAll(".thread-tag-manage-item").length === 3
  );
  const manageDeleteBox = await manageDialog
    .getByRole("button", { name: "删除标签 缺陷跟踪" })
    .boundingBox();
  assert.ok(
    manageDeleteBox && manageDeleteBox.height >= 44 && manageDeleteBox.width >= 44,
    "manage dialog delete button must stay >= 44px",
  );
  const manageCloseBox = await manageDialog
    .getByRole("button", { name: "关闭管理标签" })
    .boundingBox();
  assert.ok(
    manageCloseBox && manageCloseBox.height >= 44 && manageCloseBox.width >= 44,
    "manage dialog close button must stay >= 44px",
  );
  await axe(page, "desktop light manage tags dialog");
  await page.keyboard.press("Escape");
  await manageDialog.waitFor({ state: "detached" });
  await waitForActiveText("管理标签");
  assert.equal(
    await manageTagsOpener.evaluate((node) => document.activeElement === node),
    true,
    "Escape must close the manage dialog and return focus to its opener",
  );
  pass("thread-tags-manage-create-search-validation-focus-44px-axe");

  const tagList = await api(
    page,
    "/api/projects/legacy-project/thread-tags?limit=100",
  );
  assert.equal(tagList.status, 200);
  assert.equal(tagList.body.tags.length, 3);
  const tagByName = new Map(tagList.body.tags.map((tag) => [tag.name, tag]));
  const releaseTag = tagByName.get("发布阻塞");
  const defectTag = tagByName.get("缺陷跟踪");
  const docsTag = tagByName.get("文档待办");
  assert.ok(releaseTag && defectTag && docsTag);
  for (const tag of [releaseTag, defectTag, docsTag]) {
    assert.equal(tag.projectId, "legacy-project");
    assert.equal(tag.threadCount, 0);
  }
  const tagQueryApi = await api(
    page,
    `/api/projects/legacy-project/thread-tags?q=${encodeURIComponent("缺陷")}`,
  );
  assert.equal(tagQueryApi.status, 200);
  assert.deepEqual(
    tagQueryApi.body.tags.map((tag) => tag.name),
    ["缺陷跟踪"],
    "tag query must be a literal contains match",
  );

  const assignTag = (threadId, tagId, assigned) =>
    api(page, `/api/projects/legacy-project/threads/${threadId}/tags`, {
      body: JSON.stringify({ assigned, tagId }),
      headers: { "content-type": "application/json" },
      method: "PUT",
    });
  const assignFirst = await assignTag(firstThread, releaseTag.id, true);
  assert.equal(assignFirst.status, 200);
  assert.deepEqual(assignFirst.body, {
    assigned: true,
    projectId: "legacy-project",
    tagId: releaseTag.id,
    threadId: firstThread,
  });
  const assignThirdRelease = await assignTag(thirdThread, releaseTag.id, true);
  assert.equal(assignThirdRelease.status, 200);
  assert.equal(assignThirdRelease.body.assigned, true);
  const assignThirdDefect = await assignTag(thirdThread, defectTag.id, true);
  assert.equal(assignThirdDefect.status, 200);
  const assignRepeat = await assignTag(firstThread, releaseTag.id, true);
  assert.equal(assignRepeat.status, 200);
  assert.equal(assignRepeat.body.assigned, true);
  const assignNoop = await assignTag(secondThread, releaseTag.id, false);
  assert.equal(assignNoop.status, 200);
  assert.equal(assignNoop.body.assigned, false);

  await page.reload({ waitUntil: "networkidle" });
  const threadItem = (threadId) =>
    page.locator("#project-threads-list li", {
      has: page.locator(`[data-thread-id="${threadId}"]`),
    });
  const itemChipTexts = (threadId) =>
    threadItem(threadId).locator(".thread-tag-chip").allInnerTexts();
  await page.waitForFunction(() =>
    document.querySelectorAll("#project-threads-list .thread-tag-chip").length
    === 3
  );
  assert.deepEqual(await itemChipTexts(firstThread), ["发布阻塞"]);
  assert.deepEqual(await itemChipTexts(secondThread), []);
  assert.deepEqual(await itemChipTexts(thirdThread), ["发布阻塞", "缺陷跟踪"]);

  const tagFilterGroup = page.getByRole("group", { name: "按标签筛选线程" });
  await tagFilterGroup.waitFor();
  const allTagChip = tagFilterGroup.getByRole("button", {
    exact: true,
    name: "全部",
  });
  const releaseChip = tagFilterGroup.getByRole("button", { name: "发布阻塞" });
  const defectChip = tagFilterGroup.getByRole("button", { name: "缺陷跟踪" });
  const docsChip = tagFilterGroup.getByRole("button", { name: "文档待办" });
  assert.equal(await allTagChip.getAttribute("aria-pressed"), "true");
  const releaseChipBox = await releaseChip.boundingBox();
  assert.ok(
    releaseChipBox && releaseChipBox.height >= 44 && releaseChipBox.width >= 44,
    "filter chip must stay >= 44px",
  );
  const listedThreadIds = () =>
    page.evaluate(() =>
      [...document.querySelectorAll("#project-threads-list .thread-list-entry")]
        .map((node) => node.getAttribute("data-thread-id"))
    );
  const allThreadCount = (
    await api(page, "/api/projects/legacy-project/threads?limit=100")
  ).body.threads.length;
  assert.equal((await listedThreadIds()).length, allThreadCount);
  const tagFilterLoad = (tagId) =>
    page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === "GET"
        && url.pathname === "/api/projects/legacy-project/threads"
        && url.searchParams.get("tagId") === tagId;
    });

  const releaseFilterLoad = tagFilterLoad(releaseTag.id);
  await releaseChip.click();
  assert.equal((await releaseFilterLoad).status(), 200);
  const releaseFiltered = await api(
    page,
    `/api/projects/legacy-project/threads?tagId=${releaseTag.id}`,
  );
  assert.equal(releaseFiltered.status, 200);
  assert.deepEqual(
    releaseFiltered.body.threads.map((thread) => thread.id).sort(),
    [firstThread, thirdThread].sort(),
  );
  const thirdProjection = releaseFiltered.body.threads.find(
    (thread) => thread.id === thirdThread,
  );
  assert.deepEqual(
    thirdProjection.tags.map((tag) => tag.name),
    ["发布阻塞", "缺陷跟踪"],
    "list projection must carry the thread tags in name order",
  );
  await page.waitForFunction(() =>
    document.querySelectorAll("#project-threads-list .thread-list-entry")
      .length === 2
  );
  assert.deepEqual(
    await listedThreadIds(),
    releaseFiltered.body.threads.map((thread) => thread.id),
    "filtered UI order must match the server page exactly",
  );
  assert.equal(await releaseChip.getAttribute("aria-pressed"), "true");
  assert.equal(await allTagChip.getAttribute("aria-pressed"), "false");

  const docsFilterLoad = tagFilterLoad(docsTag.id);
  await docsChip.click();
  assert.equal((await docsFilterLoad).status(), 200);
  await page
    .getByText("标签“文档待办”下暂无线程。", { exact: true })
    .waitFor();
  await page.getByRole("button", { name: "清除筛选" }).click();
  await page.waitForFunction(
    (count) =>
      document.querySelectorAll("#project-threads-list .thread-list-entry")
        .length === count,
    allThreadCount,
  );

  const mutexFilter = await api(
    page,
    `/api/projects/legacy-project/threads?favorites=true&tagId=${defectTag.id}`,
  );
  assert.equal(mutexFilter.status, 400);
  assert.equal(mutexFilter.body?.error?.code, "INVALID_INPUT");
  assert.equal(mutexFilter.body?.error?.fields?.tagId, "not_combinable");
  await favoritesViewTab.click();
  await page.waitForFunction(() =>
    document.querySelectorAll("#project-threads-list .thread-list-entry")
      .length === 1
  );
  assert.equal(await favoritesViewTab.getAttribute("aria-selected"), "true");
  const defectFilterLoad = tagFilterLoad(defectTag.id);
  await defectChip.click();
  assert.equal((await defectFilterLoad).status(), 200);
  await page.waitForFunction(
    (expected) => {
      const entries = [
        ...document.querySelectorAll("#project-threads-list .thread-list-entry"),
      ];
      return entries.length === 1
        && entries[0].getAttribute("data-thread-id") === expected;
    },
    thirdThread,
  );
  assert.equal(
    await allViewTab.getAttribute("aria-selected"),
    "true",
    "selecting a tag chip in favorites view must fall back to 全部",
  );
  assert.equal(await favoritesViewTab.getAttribute("aria-selected"), "false");
  assert.equal(await defectChip.getAttribute("aria-pressed"), "true");
  await allTagChip.click();
  await page.waitForFunction(
    (count) =>
      document.querySelectorAll("#project-threads-list .thread-list-entry")
        .length === count,
    allThreadCount,
  );
  assert.equal(await allTagChip.getAttribute("aria-pressed"), "true");

  tagFacingText = await page.locator("html").innerText();
  await axe(page, "desktop light thread tag chips and filter");
  await page.screenshot({ fullPage: true, path: evidence.tagsDesktop });

  await page.getByRole("button", { name: /切换到暗色主题/ }).click();
  await page.getByRole("button", { name: /切换到明色主题/ }).waitFor();
  const darkDefectLoad = tagFilterLoad(defectTag.id);
  await defectChip.click();
  assert.equal((await darkDefectLoad).status(), 200);
  await page.waitForFunction(
    (expected) => {
      const entries = [
        ...document.querySelectorAll("#project-threads-list .thread-list-entry"),
      ];
      return entries.length === 1
        && entries[0].getAttribute("data-thread-id") === expected;
    },
    thirdThread,
  );
  assert.deepEqual(await itemChipTexts(thirdThread), ["发布阻塞", "缺陷跟踪"]);
  await axe(page, "desktop dark thread tag filter");
  await page.screenshot({ fullPage: true, path: evidence.tagsDark });
  await allTagChip.click();
  await page.waitForFunction(
    (count) =>
      document.querySelectorAll("#project-threads-list .thread-list-entry")
        .length === count,
    allThreadCount,
  );
  await page.getByRole("button", { name: /切换到明色主题/ }).click();
  await page.getByRole("button", { name: /切换到暗色主题/ }).waitFor();
  pass("thread-tags-assign-chips-filter-mutex-dark-light-axe");

  const organizeButton = page.getByRole("button", { name: "整理线程" });
  await organizeButton.click();
  assert.equal(await organizeButton.getAttribute("aria-pressed"), "true");
  const batchBar = page.getByRole("region", { name: "批量整理线程" });
  await batchBar.waitFor();
  await batchBar.getByText("已选 0 条线程", { exact: true }).waitFor();
  assert.equal(
    await tagFilterGroup.count(),
    0,
    "filter chips must hide while organize mode is active",
  );
  const threadCheckbox = (threadId) => threadItem(threadId).getByRole("checkbox");
  await threadCheckbox(firstThread).waitFor();
  const selectLabelBox = await threadItem(firstThread)
    .locator(".thread-list-select")
    .boundingBox();
  assert.ok(
    selectLabelBox && selectLabelBox.height >= 44 && selectLabelBox.width >= 44,
    "organize select control must stay >= 44px",
  );
  await threadCheckbox(firstThread).click();
  await batchBar.getByText("已选 1 条线程", { exact: true }).waitFor();
  await threadItem(secondThread).locator(".thread-list-entry").focus();
  await page.keyboard.press("Shift+Tab");
  assert.equal(
    await threadCheckbox(secondThread).evaluate(
      (node) => document.activeElement === node,
    ),
    true,
    "Shift+Tab from a thread entry must reach its organize checkbox",
  );
  assert.notEqual(
    await threadCheckbox(secondThread).evaluate(
      (node) => getComputedStyle(node).boxShadow,
    ),
    "none",
    "keyboard-focused organize checkbox must show a visible focus ring",
  );
  await page.keyboard.press("Space");
  await batchBar.getByText("已选 2 条线程", { exact: true }).waitFor();
  assert.equal(await threadCheckbox(secondThread).isChecked(), true);
  const addGroup = batchBar.getByRole("group", { name: "添加标签" });
  const removeGroup = batchBar.getByRole("group", { name: "移除标签" });
  const addDefectChip = addGroup.getByRole("button", { name: "缺陷跟踪" });
  await addDefectChip.click();
  assert.equal(await addDefectChip.getAttribute("aria-pressed"), "true");
  const removeReleaseChip = removeGroup.getByRole("button", { name: "发布阻塞" });
  await removeReleaseChip.click();
  assert.equal(await removeReleaseChip.getAttribute("aria-pressed"), "true");
  const applyButton = batchBar.getByRole("button", { name: "应用更改" });
  assert.equal(await applyButton.isDisabled(), false);
  const batchPost = page.waitForResponse((response) =>
    response.request().method() === "POST"
    && response.url().endsWith("/api/projects/legacy-project/thread-tag-batch")
  );
  await applyButton.click();
  const batchConfirmDialog = page.getByRole("dialog", { name: "确认批量整理" });
  await batchConfirmDialog.waitFor();
  await batchConfirmDialog
    .getByText("将为 2 条线程添加 1 个标签、移除 1 个标签。", { exact: true })
    .waitFor();
  await batchConfirmDialog
    .getByText("移除会立即解除这些线程上的标签分配。", { exact: true })
    .waitFor();
  const confirmApplyButton = batchConfirmDialog.getByRole("button", {
    name: "确认应用",
  });
  await waitForActiveElement(".batch-apply-confirm button.button-primary");
  assert.equal(
    await confirmApplyButton.evaluate((node) => document.activeElement === node),
    true,
    "batch confirm must move focus to 确认应用",
  );
  await page.keyboard.press("Enter");
  const batchResponse = await batchPost;
  assert.equal(batchResponse.status(), 200);
  const batchBody = await batchResponse.json();
  assert.equal(batchBody.replayed, false);
  assert.equal(batchBody.applied.length, 2);
  const batchRequestBody = batchResponse.request().postDataJSON();
  assert.ok(batchRequestBody.operationId);
  assert.deepEqual(
    batchRequestBody.threadIds.sort(),
    [firstThread, secondThread].sort(),
  );
  assert.deepEqual(batchRequestBody.addTagIds, [defectTag.id]);
  assert.deepEqual(batchRequestBody.removeTagIds, [releaseTag.id]);
  const appliedFirst = batchBody.applied.find(
    (item) => item.threadId === firstThread,
  );
  const appliedSecond = batchBody.applied.find(
    (item) => item.threadId === secondThread,
  );
  assert.deepEqual(appliedFirst.addedTagIds, [defectTag.id]);
  assert.deepEqual(appliedFirst.removedTagIds, [releaseTag.id]);
  assert.deepEqual(appliedSecond.addedTagIds, [defectTag.id]);
  assert.deepEqual(appliedSecond.removedTagIds, []);
  await page.getByText("已为 2 条线程更新标签。", { exact: true }).waitFor();
  await batchBar.waitFor({ state: "detached" });
  assert.equal(await organizeButton.getAttribute("aria-pressed"), "false");
  await page.waitForFunction(() => {
    const chips = [
      ...document.querySelectorAll("#project-threads-list .thread-tag-chip"),
    ].map((node) => node.textContent);
    return chips.length === 4
      && chips.filter((name) => name === "缺陷跟踪").length === 3
      && chips.filter((name) => name === "发布阻塞").length === 1;
  });
  assert.deepEqual(await itemChipTexts(firstThread), ["缺陷跟踪"]);
  assert.deepEqual(await itemChipTexts(secondThread), ["缺陷跟踪"]);
  assert.deepEqual(await itemChipTexts(thirdThread), ["发布阻塞", "缺陷跟踪"]);

  const batchReplay = await api(
    page,
    "/api/projects/legacy-project/thread-tag-batch",
    {
      body: JSON.stringify({
        addTagIds: batchRequestBody.addTagIds,
        operationId: batchRequestBody.operationId,
        removeTagIds: batchRequestBody.removeTagIds,
        threadIds: batchRequestBody.threadIds,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
  );
  if (batchReplay.status === 200) {
    assert.equal(batchReplay.body.replayed, true);
    assert.equal(batchReplay.body.operationId, batchBody.operationId);
    assert.deepEqual(batchReplay.body.applied, batchBody.applied);
  } else {
    assert.equal(batchReplay.status, 409);
    assert.equal(batchReplay.body?.error?.code, "OPERATION_CONFLICT");
  }
  const defectEdgesAfterReplay = await api(
    page,
    `/api/projects/legacy-project/threads?tagId=${defectTag.id}`,
  );
  assert.equal(
    defectEdgesAfterReplay.body.threads.length,
    3,
    "replayed batch must not duplicate edges",
  );
  const batchConflict = await api(
    page,
    "/api/projects/legacy-project/thread-tag-batch",
    {
      body: JSON.stringify({
        addTagIds: [],
        operationId: batchRequestBody.operationId,
        removeTagIds: [releaseTag.id],
        threadIds: [thirdThread],
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
  );
  assert.equal(batchConflict.status, 409);
  assert.equal(batchConflict.body?.error?.code, "OPERATION_CONFLICT");
  pass("thread-tags-batch-organize-confirm-notice-replay-conflict");

  await manageTagsOpener.click();
  await manageDialog.waitFor();
  await page.waitForFunction(() => {
    const items = [
      ...document.querySelectorAll(".thread-tag-manage-item"),
    ].map((node) => node.textContent ?? "");
    return items.some((text) =>
      text.includes("发布阻塞") && text.includes("已分配 1 条线程")
    )
      && items.some((text) =>
        text.includes("缺陷跟踪") && text.includes("已分配 3 条线程")
      )
      && items.some((text) =>
        text.includes("文档待办") && text.includes("已分配 0 条线程")
      );
  });
  await manageDialog.getByRole("button", { name: "删除标签 文档待办" }).click();
  const deleteConfirm = page.getByRole("dialog", { name: "删除标签" });
  await deleteConfirm.waitFor();
  await deleteConfirm
    .getByText("删除标签“文档待办”将解除 0 条分配。此操作不可撤销。", {
      exact: true,
    })
    .waitFor();
  const deleteCancelButton = deleteConfirm.getByRole("button", { name: "取消" });
  await waitForActiveElement(".delete-tag-confirm button.button-secondary");
  assert.equal(
    await deleteCancelButton.evaluate((node) => document.activeElement === node),
    true,
    "delete confirm must move focus to 取消",
  );
  await page.keyboard.press("Escape");
  await deleteConfirm.waitFor({ state: "detached" });
  assert.equal(
    await manageDialog.isVisible(),
    true,
    "Escape must dismiss only the delete confirm layer",
  );
  await waitForActiveElement(".manage-tags-dialog #manage-tag-search");
  assert.equal(
    await manageTagSearch.evaluate((node) => document.activeElement === node),
    true,
    "confirm Escape must return focus to the tag search input",
  );
  await manageDialog.getByRole("button", { name: "删除标签 文档待办" }).click();
  await deleteConfirm.waitFor();
  const docsDeleteResponse = page.waitForResponse((response) =>
    response.request().method() === "DELETE"
    && response.url().includes(
      `/api/projects/legacy-project/thread-tags/${docsTag.id}`,
    )
  );
  await deleteConfirm.getByRole("button", { name: "确认删除" }).click();
  assert.equal((await docsDeleteResponse).status(), 200);
  await manageDialog
    .getByText("已删除标签“文档待办”，解除 0 条分配。", { exact: true })
    .waitFor();
  await page.waitForFunction(() =>
    document.querySelectorAll(".thread-tag-manage-item").length === 2
  );

  await manageDialog.getByRole("button", { name: "删除标签 发布阻塞" }).click();
  await deleteConfirm.waitFor();
  await deleteConfirm
    .getByText("删除标签“发布阻塞”将解除 1 条分配。此操作不可撤销。", {
      exact: true,
    })
    .waitFor();
  const releaseDeleteResponse = page.waitForResponse((response) =>
    response.request().method() === "DELETE"
    && response.url().includes(
      `/api/projects/legacy-project/thread-tags/${releaseTag.id}`,
    )
  );
  await deleteConfirm.getByRole("button", { name: "确认删除" }).click();
  const releaseDelete = await releaseDeleteResponse;
  assert.equal(releaseDelete.status(), 200);
  const releaseDeleteBody = await releaseDelete.json();
  assert.equal(releaseDeleteBody.tagId, releaseTag.id);
  assert.equal(releaseDeleteBody.removedEdgeCount, 1);
  await manageDialog
    .getByText("已删除标签“发布阻塞”，解除 1 条分配。", { exact: true })
    .waitFor();
  await page.waitForFunction(() =>
    document.querySelectorAll(".thread-tag-manage-item").length === 1
  );
  await page.keyboard.press("Escape");
  await manageDialog.waitFor({ state: "detached" });
  await waitForActiveText("管理标签");
  assert.equal(
    await manageTagsOpener.evaluate((node) => document.activeElement === node),
    true,
    "manage dialog Escape must return focus to its opener",
  );
  await tagFilterGroup.waitFor();
  assert.deepEqual(
    await tagFilterGroup.getByRole("button").allInnerTexts(),
    ["全部", "缺陷跟踪"],
    "deleted tags must leave the filter bar immediately",
  );
  await page.waitForFunction(() => {
    const chips = [
      ...document.querySelectorAll("#project-threads-list .thread-tag-chip"),
    ].map((node) => node.textContent);
    return chips.length === 3 && chips.every((name) => name === "缺陷跟踪");
  });

  await page.reload({ waitUntil: "networkidle" });
  await tagFilterGroup.waitFor();
  assert.deepEqual(
    await tagFilterGroup.getByRole("button").allInnerTexts(),
    ["全部", "缺陷跟踪"],
    "deleted tags must stay out of the filter bar after reload",
  );
  await page.waitForFunction(() => {
    const chips = [
      ...document.querySelectorAll("#project-threads-list .thread-tag-chip"),
    ].map((node) => node.textContent);
    return chips.length === 3 && chips.every((name) => name === "缺陷跟踪");
  });
  const tagsAfterDelete = await api(
    page,
    "/api/projects/legacy-project/thread-tags?limit=100",
  );
  assert.deepEqual(
    tagsAfterDelete.body.tags.map((tag) => [tag.name, tag.threadCount]),
    [["缺陷跟踪", 3]],
  );
  const deletedTagFilter = await api(
    page,
    `/api/projects/legacy-project/threads?tagId=${releaseTag.id}`,
  );
  assert.equal(deletedTagFilter.status, 200);
  assert.deepEqual(
    deletedTagFilter.body.threads,
    [],
    "deleted tag filter must be an empty page",
  );
  pass("thread-tags-delete-confirm-count-views-consistent-reload");

  await restartApp(page);
  await tagFilterGroup.waitFor();
  const tagsAfterRestart = await api(
    page,
    "/api/projects/legacy-project/thread-tags?limit=100",
  );
  assert.deepEqual(
    tagsAfterRestart.body.tags.map((tag) => [tag.name, tag.threadCount]),
    [["缺陷跟踪", 3]],
    "tags and usage counts must survive an app restart",
  );
  const defectAfterRestart = await api(
    page,
    `/api/projects/legacy-project/threads?tagId=${defectTag.id}`,
  );
  assert.equal(defectAfterRestart.status, 200);
  assert.deepEqual(
    defectAfterRestart.body.threads.map((thread) => thread.id).sort(),
    [firstThread, secondThread, thirdThread].sort(),
  );
  await page.waitForFunction(() => {
    const chips = [
      ...document.querySelectorAll("#project-threads-list .thread-tag-chip"),
    ].map((node) => node.textContent);
    return chips.length === 3 && chips.every((name) => name === "缺陷跟踪");
  });
  assert.deepEqual(
    await tagFilterGroup.getByRole("button").allInnerTexts(),
    ["全部", "缺陷跟踪"],
  );
  pass("thread-tags-restart-persistence-api-view");

  const foreignTagCreate = await api(
    page,
    `/api/projects/${foreignProjectId}/thread-tags`,
    {
      body: JSON.stringify({ name: "外部标签" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
  );
  assert.equal(foreignTagCreate.status, 200);
  assert.equal(foreignTagCreate.body.created, true);
  const foreignTag = foreignTagCreate.body.tag;
  assert.equal(foreignTag.projectId, foreignProjectId);
  const legacyTagsAfterForeign = await api(
    page,
    "/api/projects/legacy-project/thread-tags?limit=100",
  );
  assert.equal(
    legacyTagsAfterForeign.body.tags.some(
      (tag) => tag.id === foreignTag.id || tag.name === "外部标签",
    ),
    false,
    "foreign tag must not appear in the legacy project",
  );
  const foreignTagList = await api(
    page,
    `/api/projects/${foreignProjectId}/thread-tags?limit=100`,
  );
  assert.equal(foreignTagList.status, 200);
  assert.deepEqual(
    foreignTagList.body.tags.map((tag) => tag.name),
    ["外部标签"],
  );
  const foreignTagSearch = await api(
    page,
    `/api/projects/${foreignProjectId}/thread-tags?q=${encodeURIComponent("缺陷")}`,
  );
  assert.equal(foreignTagSearch.status, 200);
  assert.deepEqual(
    foreignTagSearch.body.tags,
    [],
    "foreign project must not search-hit legacy tags",
  );
  assert.equal(
    await tagFilterGroup.getByRole("button", { name: "外部标签" }).count(),
    0,
    "foreign tag must never reach the filter bar",
  );
  const crossAssignments = [
    [
      `/api/projects/legacy-project/threads/${firstThread}/tags`,
      { assigned: true, tagId: foreignTag.id },
    ],
    [
      `/api/projects/${foreignProjectId}/threads/${firstThread}/tags`,
      { assigned: true, tagId: foreignTag.id },
    ],
    [
      `/api/projects/legacy-project/threads/${foreignThreadId}/tags`,
      { assigned: true, tagId: defectTag.id },
    ],
  ];
  for (const [path, payload] of crossAssignments) {
    const denied = await api(page, path, {
      body: JSON.stringify(payload),
      headers: { "content-type": "application/json" },
      method: "PUT",
    });
    assert.equal(denied.status, 404, `cross-tuple assignment must 404: ${path}`);
    assert.equal(denied.body?.error?.code, "RESOURCE_NOT_FOUND");
    assert.equal(
      JSON.stringify(denied.body).includes(foreignProjectId),
      false,
      "404 envelope must not echo the foreign project id",
    );
  }
  const foreignTagDelete = await api(
    page,
    `/api/projects/legacy-project/thread-tags/${foreignTag.id}`,
    { method: "DELETE" },
  );
  assert.equal(foreignTagDelete.status, 404);
  assert.equal(foreignTagDelete.body?.error?.code, "RESOURCE_NOT_FOUND");
  const foreignBatch = await api(
    page,
    "/api/projects/legacy-project/thread-tag-batch",
    {
      body: JSON.stringify({
        addTagIds: [foreignTag.id],
        operationId: randomUUID(),
        removeTagIds: [],
        threadIds: [firstThread],
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
  );
  assert.equal(foreignBatch.status, 404);
  assert.equal(foreignBatch.body?.error?.code, "RESOURCE_NOT_FOUND");
  const foreignTagFilter = await api(
    page,
    `/api/projects/legacy-project/threads?tagId=${foreignTag.id}`,
  );
  assert.equal(foreignTagFilter.status, 200);
  assert.deepEqual(
    foreignTagFilter.body.threads,
    [],
    "foreign tagId filter must stay an empty page",
  );
  const defectEdgesAfterCross = await api(
    page,
    `/api/projects/legacy-project/threads?tagId=${defectTag.id}`,
  );
  assert.equal(
    defectEdgesAfterCross.body.threads.length,
    3,
    "rejected cross-tuple writes must not change edges",
  );
  for (const body of [
    tagList.body,
    tagQueryApi.body,
    assignFirst.body,
    batchBody,
    batchReplay.body,
    releaseDeleteBody,
    foreignTagCreate.body,
    foreignTagList.body,
  ]) {
    const text = JSON.stringify(body);
    assert.equal(text.includes(apiKey), false, "tag API response leaks apiKey");
    assert.equal(
      text.includes(masterKey),
      false,
      "tag API response leaks masterKey",
    );
  }
  pass("thread-tags-cross-project-isolation-tuple-404-secret-scan");

  await page.setViewportSize({ height: 844, width: 390 });
  await page.reload({ waitUntil: "networkidle" });
  const tagNavOpener = page.getByRole("button", { name: "打开项目导航" });
  await tagNavOpener.click();
  const tagNavDrawer = page.getByRole("dialog", { name: "项目导航" });
  await tagNavDrawer.waitFor();
  const narrowManageOpener = tagNavDrawer.getByRole("button", { name: "管理标签" });
  await narrowManageOpener.click();
  const narrowManageDialog = page.getByRole("dialog", { name: "管理标签" });
  await narrowManageDialog.waitFor();
  await waitForActiveElement(".manage-tags-dialog #new-thread-tag-name");
  assert.equal(
    await narrowManageDialog
      .getByLabel("新标签名称")
      .evaluate((node) => document.activeElement === node),
    true,
    "narrow manage dialog must move focus to the new tag input",
  );
  const narrowTagSearch = narrowManageDialog.getByLabel("搜索标签");
  await narrowTagSearch.fill("缺陷");
  await page.waitForFunction(() =>
    document.querySelectorAll(".thread-tag-manage-item").length === 1
  );
  await narrowManageDialog
    .getByText("已分配 3 条线程", { exact: true })
    .waitFor();
  const narrowDeleteBox = await narrowManageDialog
    .getByRole("button", { name: "删除标签 缺陷跟踪" })
    .boundingBox();
  assert.ok(
    narrowDeleteBox && narrowDeleteBox.height >= 44 && narrowDeleteBox.width >= 44,
    "narrow delete tag button must stay >= 44px",
  );
  const narrowManageCloseBox = await narrowManageDialog
    .getByRole("button", { name: "关闭管理标签" })
    .boundingBox();
  assert.ok(
    narrowManageCloseBox
    && narrowManageCloseBox.height >= 44
    && narrowManageCloseBox.width >= 44,
    "narrow manage close button must stay >= 44px",
  );
  narrowTagFacingText = await page.locator("html").innerText();
  await axe(page, "narrow light manage tags dialog");
  await page.keyboard.press("Escape");
  await narrowManageDialog.waitFor({ state: "detached" });
  await waitForActiveText("管理标签");
  assert.equal(
    await narrowManageOpener.evaluate((node) => document.activeElement === node),
    true,
    "narrow manage Escape must return focus to its opener",
  );
  const narrowFilterGroup = tagNavDrawer.getByRole("group", {
    name: "按标签筛选线程",
  });
  const narrowAllChip = narrowFilterGroup.getByRole("button", {
    exact: true,
    name: "全部",
  });
  const narrowDefectChip = narrowFilterGroup.getByRole("button", {
    name: "缺陷跟踪",
  });
  await narrowDefectChip.waitFor();
  const narrowChipBox = await narrowDefectChip.boundingBox();
  assert.ok(
    narrowChipBox && narrowChipBox.height >= 44 && narrowChipBox.width >= 44,
    "narrow filter chip must stay >= 44px",
  );
  await narrowAllChip.focus();
  await page.keyboard.press("Tab");
  assert.equal(
    await narrowDefectChip.evaluate((node) => document.activeElement === node),
    true,
    "Tab must move focus from 全部 to the tag filter chip",
  );
  assert.notEqual(
    await narrowDefectChip.evaluate((node) => getComputedStyle(node).boxShadow),
    "none",
    "keyboard-focused filter chip must show a visible focus ring",
  );
  await page.keyboard.press("Enter");
  await page.waitForFunction(() =>
    document.querySelectorAll("#project-threads-list .thread-list-entry")
      .length === 3
  );
  assert.equal(await narrowDefectChip.getAttribute("aria-pressed"), "true");
  await axe(page, "narrow light tag filter drawer");
  await page.screenshot({ fullPage: true, path: evidence.tagsNarrow });
  await narrowAllChip.click();
  await page.waitForFunction(
    (count) =>
      document.querySelectorAll("#project-threads-list .thread-list-entry")
        .length === count,
    allThreadCount,
  );
  await page.keyboard.press("Escape");
  await tagNavDrawer.waitFor({ state: "detached" });
  await waitForActiveText("项目");
  assert.equal(
    await tagNavOpener.evaluate((node) => document.activeElement === node),
    true,
    "Escape must close the drawer and return focus to its opener",
  );
  pass("thread-tags-narrow-light-manage-filter-44px-keyboard-focus-axe");

  await page.getByRole("button", { name: /切换到暗色主题/ }).click();
  await page.getByRole("button", { name: /切换到明色主题/ }).waitFor();
  await tagNavOpener.click();
  await tagNavDrawer.waitFor();
  const narrowDarkChip = tagNavDrawer
    .getByRole("group", { name: "按标签筛选线程" })
    .getByRole("button", { name: "缺陷跟踪" });
  await narrowDarkChip.waitFor();
  await narrowDarkChip.click();
  await page.waitForFunction(() =>
    document.querySelectorAll("#project-threads-list .thread-list-entry")
      .length === 3
  );
  assert.equal(await narrowDarkChip.getAttribute("aria-pressed"), "true");
  await axe(page, "narrow dark tag filter drawer");
  await page.screenshot({ fullPage: true, path: evidence.tagsNarrowDark });
  await page.keyboard.press("Escape");
  await tagNavDrawer.waitFor({ state: "detached" });
  await page.getByRole("button", { name: /切换到明色主题/ }).click();
  await page.getByRole("button", { name: /切换到暗色主题/ }).waitFor();
  pass("thread-tags-narrow-dark-filter-axe");

  // ---- feature 033 T-06: thread recycle-bin lifecycle real-browser acceptance ----
  // Cohesive single block after 032 and before terminal scans. It validates the
  // full lifecycle: soft delete, recycle-bin visibility, restore, purge,
  // execution provenance guard, restart invariants, cross-project isolation,
  // matrix coverage, and secret scanning surfaces.
  await page.setViewportSize({ height: 1050, width: 1500 });
  await page.goto(`${baseUrl}${firstHref}`, { waitUntil: "networkidle" });

  const recycleKeyword = `recycle-keyword-${seed}`;
  const recycleHistoryKeyword = `recycle-history-${seed}`;
  let beforeRecycleOrder = [];
  const favoriteSecond = await api(
    page,
    `/api/projects/legacy-project/threads/${secondThread}/favorite`,
    {
      body: JSON.stringify({ favorite: true }),
      headers: { "content-type": "application/json" },
      method: "PUT",
    },
  );
  assert.equal(favoriteSecond.status, 200);
  assert.equal(favoriteSecond.body.isFavorite, true);
  const tagSecond = await api(
    page,
    `/api/projects/legacy-project/threads/${secondThread}/tags`,
    {
      body: JSON.stringify({ assigned: true, tagId: defectTag.id }),
      headers: { "content-type": "application/json" },
      method: "PUT",
    },
  );
  assert.equal(tagSecond.status, 200);
  assert.equal(tagSecond.body.assigned, true);
  // Use a unique payload per run so purge byte-removal assertions are not
  // confounded by hash-deduplicated attachments shared with earlier fixtures.
  const recycleAttachmentBytes = [...PNG_1X1, seed % 251];
  const recycleAttachmentUpload = await page.evaluate(
    async ({ bytes, threadId }) => {
      const response = await fetch(
        `/api/projects/legacy-project/threads/${threadId}/attachments?name=recycle-proof.png`,
        {
          body: new Uint8Array(bytes),
          headers: { "content-type": "image/png" },
          method: "POST",
        },
      );
      return {
        body: await response.json().catch(() => null),
        status: response.status,
      };
    },
    { bytes: recycleAttachmentBytes, threadId: secondThread },
  );
  assert.equal(recycleAttachmentUpload.status, 201);
  const recycleAttachmentId = recycleAttachmentUpload.body?.attachment?.id;
  assert.equal(typeof recycleAttachmentId, "string");
  const recycleMessage = await api(
    page,
    `/api/projects/legacy-project/threads/${secondThread}/messages`,
    {
      body: JSON.stringify({
        attachmentIds: [recycleAttachmentId],
        content: recycleKeyword,
        operationId: randomUUID(),
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
  );
  assert.equal(recycleMessage.status, 201);
  const recycleHistoryMessage = await api(
    page,
    `/api/projects/legacy-project/threads/${secondThread}/messages`,
    {
      body: JSON.stringify({
        content: recycleHistoryKeyword,
        operationId: randomUUID(),
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
  );
  assert.equal(recycleHistoryMessage.status, 201);
  const recycleSearchBefore = await api(
    page,
    `/api/projects/legacy-project/thread-search?q=${encodeURIComponent(recycleKeyword)}`,
  );
  assert.equal(recycleSearchBefore.status, 200);
  assert.equal(
    recycleSearchBefore.body.results.some((result) => result.threadId === secondThread),
    true,
  );
  const recycleHistoryBefore = await api(
    page,
    `/api/projects/legacy-project/input-history?query=${encodeURIComponent(recycleHistoryKeyword)}`,
  );
  assert.equal(recycleHistoryBefore.status, 200);
  assert.equal(
    recycleHistoryBefore.body.entries.some((entry) => entry.threadId === secondThread),
    true,
  );
  beforeRecycleOrder = (
    await api(page, "/api/projects/legacy-project/threads?limit=100")
  ).body.threads.map((thread) => thread.id);

  await page.goto(
    `${baseUrl}/projects/legacy-project?thread=${secondThread}`,
    { waitUntil: "networkidle" },
  );
  const secondListItem = page.locator("#project-threads-list li", {
    has: page.locator(`[data-thread-id="${secondThread}"]`),
  });
  await secondListItem.waitFor();
  const moreButton = secondListItem.getByRole("button", { name: /更多/ });
  await moreButton.waitFor();
  const moreBox = await moreButton.boundingBox();
  assert.ok(
    moreBox && moreBox.height >= 44 && moreBox.width >= 44,
    "more button must stay >= 44px",
  );
  await moreButton.click();
  const softDeleteButton = secondListItem.getByRole("button", { name: /移入回收站/ });
  await softDeleteButton.waitFor();
  const softDeleteBox = await softDeleteButton.boundingBox();
  assert.ok(
    softDeleteBox && softDeleteBox.height >= 44 && softDeleteBox.width >= 44,
    "soft delete menu item must stay >= 44px",
  );
  await softDeleteButton.click();
  const softDeleteDialog = page.getByRole("dialog", { name: "移入回收站" });
  await softDeleteDialog.waitFor();
  const softDeleteCancel = softDeleteDialog.getByRole("button", { name: "取消" });
  assert.equal(
    await softDeleteCancel.evaluate((node) => document.activeElement === node),
    true,
    "soft delete confirm must move focus to 取消",
  );
  await page.keyboard.press("Escape");
  await softDeleteDialog.waitFor({ state: "detached" });
  await moreButton.focus();
  assert.equal(
    await moreButton.evaluate((node) => document.activeElement === node),
    true,
    "more opener must remain keyboard focusable after Escape",
  );
  const softDeleteResponse = page.waitForResponse((response) =>
    response.request().method() === "DELETE"
    && response.url().endsWith(`/api/projects/legacy-project/threads/${secondThread}`)
  );
  await moreButton.click();
  await secondListItem.getByRole("button", { name: /移入回收站/ }).click();
  await softDeleteDialog.waitFor();
  await softDeleteDialog.getByRole("button", { name: "确认移入" }).click();
  assert.equal((await softDeleteResponse).status(), 200);
  await page.waitForURL((url) => url.searchParams.get("thread") !== secondThread);
  assert.equal(
    new URL(page.url()).searchParams.get("thread") !== secondThread,
    true,
    "deleting the current thread must not keep the deleted selection",
  );
  const deleteLark = await api(
    page,
    `/api/projects/legacy-project/threads/${larkThreadId}`,
    { method: "DELETE" },
  );
  assert.equal(deleteLark.status, 200);
  const listedAfterDelete = await api(
    page,
    "/api/projects/legacy-project/threads?limit=100",
  );
  assert.equal(
    listedAfterDelete.body.threads.some((thread) => thread.id === secondThread),
    false,
  );
  const favoritesAfterDelete = await api(
    page,
    "/api/projects/legacy-project/threads?favorites=true",
  );
  assert.equal(
    favoritesAfterDelete.body.threads.some((thread) => thread.id === secondThread),
    false,
  );
  const taggedAfterDelete = await api(
    page,
    `/api/projects/legacy-project/threads?tagId=${defectTag.id}`,
  );
  assert.equal(
    taggedAfterDelete.body.threads.some((thread) => thread.id === secondThread),
    false,
  );
  const searchAfterDelete = await api(
    page,
    `/api/projects/legacy-project/thread-search?q=${encodeURIComponent(recycleKeyword)}`,
  );
  assert.equal(searchAfterDelete.status, 200);
  assert.deepEqual(searchAfterDelete.body.results, []);
  const historyAfterDelete = await api(
    page,
    `/api/projects/legacy-project/input-history?query=${encodeURIComponent(recycleHistoryKeyword)}`,
  );
  assert.equal(historyAfterDelete.status, 200);
  assert.equal(
    historyAfterDelete.body.entries.some((entry) => entry.threadId === secondThread),
    false,
  );
  pass("thread-recycle-soft-delete-excludes-list-search-favorites-tags-history-selection");

  const recycleList = await api(
    page,
    "/api/projects/legacy-project/thread-recycle-bin?limit=100",
  );
  assert.equal(recycleList.status, 200);
  assert.deepEqual(
    recycleList.body.threads.slice(0, 2).map((item) => item.id),
    [larkThreadId, secondThread],
    "recycle bin must be ordered by deleted_at DESC with id tie-break",
  );
  const secondRecycleItem = recycleList.body.threads.find((item) => item.id === secondThread);
  assert.ok(secondRecycleItem);
  assert.ok(secondRecycleItem.messageCount >= 2);
  assert.ok(secondRecycleItem.attachmentCount >= 1);

  const recycleViewTab = page.getByRole("button", { name: "回收站" });
  await recycleViewTab.waitFor();
  const recycleViewTabBox = await recycleViewTab.boundingBox();
  assert.ok(
    recycleViewTabBox
    && recycleViewTabBox.height >= 44
    && recycleViewTabBox.width >= 44,
    "recycle view tab must stay >= 44px",
  );
  await recycleViewTab.click();
  assert.equal(await recycleViewTab.getAttribute("aria-selected"), "true");
  await page
    .getByText(
      `消息 ${secondRecycleItem.messageCount} · 附件 ${secondRecycleItem.attachmentCount}`,
      { exact: true },
    )
    .waitFor();
  const restoreSecondButton = page.getByRole("button", {
    name: "恢复 Duplicate title",
  });
  await restoreSecondButton.waitFor();
  const restoreSecondBox = await restoreSecondButton.boundingBox();
  assert.ok(
    restoreSecondBox
    && restoreSecondBox.height >= 44
    && restoreSecondBox.width >= 44,
    "recycle restore button must stay >= 44px",
  );
  await restoreSecondButton.focus();
  assert.equal(
    await restoreSecondButton.evaluate((node) => document.activeElement === node),
    true,
    "recycle restore action must be keyboard focusable",
  );
  recycleFacingText = await page.locator("html").innerText();
  await axe(page, "desktop light thread recycle bin");
  await page.screenshot({ fullPage: true, path: evidence.recycleDesktop });
  await page.getByRole("button", { name: /切换到暗色主题/ }).click();
  await page.getByRole("button", { name: /切换到明色主题/ }).waitFor();
  await recycleViewTab.waitFor();
  await axe(page, "desktop dark thread recycle bin");
  await page.screenshot({ fullPage: true, path: evidence.recycleDark });
  await page.getByRole("button", { name: /切换到明色主题/ }).click();
  await page.getByRole("button", { name: /切换到暗色主题/ }).waitFor();

  const restoreSecondResponse = page.waitForResponse((response) =>
    response.request().method() === "POST"
    && response.url().endsWith(`/api/projects/legacy-project/threads/${secondThread}/restore`)
  );
  await restoreSecondButton.click();
  assert.equal((await restoreSecondResponse).status(), 200);
  const restoreLark = await api(
    page,
    `/api/projects/legacy-project/threads/${larkThreadId}/restore`,
    {
      body: "{}",
      headers: { "content-type": "application/json" },
      method: "POST",
    },
  );
  assert.equal(restoreLark.status, 200);
  const orderAfterRestore = (
    await api(page, "/api/projects/legacy-project/threads?limit=100")
  ).body.threads.map((thread) => thread.id);
  assert.deepEqual(
    orderAfterRestore,
    beforeRecycleOrder,
    "restore must recover the original thread ordering",
  );
  const searchAfterRestore = await api(
    page,
    `/api/projects/legacy-project/thread-search?q=${encodeURIComponent(recycleKeyword)}`,
  );
  assert.equal(
    searchAfterRestore.body.results.some((result) => result.threadId === secondThread),
    true,
  );
  const favoritesAfterRestore = await api(
    page,
    "/api/projects/legacy-project/threads?favorites=true",
  );
  assert.equal(
    favoritesAfterRestore.body.threads.some((thread) => thread.id === secondThread),
    true,
  );
  const taggedAfterRestore = await api(
    page,
    `/api/projects/legacy-project/threads?tagId=${defectTag.id}`,
  );
  assert.equal(
    taggedAfterRestore.body.threads.some((thread) => thread.id === secondThread),
    true,
  );
  const historyAfterRestore = await api(
    page,
    `/api/projects/legacy-project/input-history?query=${encodeURIComponent(recycleHistoryKeyword)}`,
  );
  assert.equal(
    historyAfterRestore.body.entries.some((entry) => entry.threadId === secondThread),
    true,
  );

  const deleteSecondAgain = await api(
    page,
    `/api/projects/legacy-project/threads/${secondThread}`,
    { method: "DELETE" },
  );
  assert.equal(deleteSecondAgain.status, 200);
  await page.goto(
    `${baseUrl}/projects/legacy-project?thread=${secondThread}`,
    { waitUntil: "networkidle" },
  );
  const deletedPlaceholder = page.locator(".thread-deleted-placeholder");
  await deletedPlaceholder.getByText("该线程已移入回收站。", { exact: true }).waitFor();
  await deletedPlaceholder.getByRole("button", { name: "返回线程列表" }).click();
  await recycleViewTab.waitFor();

  await recycleViewTab.click();
  const openPurgeDialog = page.getByRole("button", {
    name: "永久删除 Duplicate title",
  });
  await openPurgeDialog.click();
  const purgeDialog = page.getByRole("dialog", { name: "永久删除线程" });
  await purgeDialog.waitFor();
  const purgeWarning = await purgeDialog.locator("p").first().innerText();
  assert.equal(
    purgeWarning.includes(
      `将永久删除 ${secondRecycleItem.messageCount} 条消息、${secondRecycleItem.attachmentCount} 个附件。此操作不可恢复；删除操作会记录在审计日志中。`,
    ),
    true,
  );
  const purgeCancel = purgeDialog.getByRole("button", { name: "取消" });
  assert.equal(
    await purgeCancel.evaluate((node) => document.activeElement === node),
    true,
    "purge confirm must move focus to 取消",
  );
  const purgeResponse = page.waitForResponse((response) =>
    response.request().method() === "POST"
    && response.url().endsWith(`/api/projects/legacy-project/threads/${secondThread}/purge`)
  );
  await purgeDialog.getByRole("button", { name: "永久删除" }).click();
  let purgeStatus = (await purgeResponse).status();
  if (purgeStatus === 503) {
    await purgeDialog.getByText("服务暂时不可用，请稍后重试。", { exact: true }).waitFor();
    const retryResponse = page.waitForResponse((response) =>
      response.request().method() === "POST"
      && response.url().endsWith(`/api/projects/legacy-project/threads/${secondThread}/purge`)
    );
    await purgeDialog.getByRole("button", { name: "永久删除" }).click();
    purgeStatus = (await retryResponse).status();
  }
  assert.equal(purgeStatus, 200);
  const recycleAfterPurge = await api(
    page,
    "/api/projects/legacy-project/thread-recycle-bin?limit=100",
  );
  assert.equal(
    recycleAfterPurge.body.threads.some((item) => item.id === secondThread),
    false,
  );
  const searchAfterPurge = await api(
    page,
    `/api/projects/legacy-project/thread-search?q=${encodeURIComponent(recycleKeyword)}`,
  );
  assert.equal(searchAfterPurge.status, 200);
  assert.deepEqual(searchAfterPurge.body.results, []);
  const attachmentAfterPurge = await api(
    page,
    `/api/projects/legacy-project/threads/${secondThread}/attachments/${recycleAttachmentId}/content`,
  );
  assert.equal(attachmentAfterPurge.status, 404);

  let deleteFirstForExecutionGuard = await api(
    page,
    `/api/projects/legacy-project/threads/${firstThread}`,
    { method: "DELETE" },
  );
  if (
    deleteFirstForExecutionGuard.status === 409
    && deleteFirstForExecutionGuard.body?.error?.fields?.threadId === "has_active_run"
  ) {
    const latestFirstThread = await readThread(page, "legacy-project", firstThread);
    const waitingRun = latestFirstThread.runs.find((run) => run.status === "waiting_owner")
      ?? latestFirstThread.runs.find((run) => run.status === "running");
    assert.ok(waitingRun, "active run guard requires an active run to stop");
    const stopResponse = await api(
      page,
      `/api/projects/legacy-project/threads/${firstThread}/runs/${waitingRun.id}/control`,
      {
        body: JSON.stringify({
          action: "stop",
          expectedVersion: waitingRun.version,
          operationId: randomUUID(),
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    );
    assert.equal(stopResponse.status, 200);
    deleteFirstForExecutionGuard = await api(
      page,
      `/api/projects/legacy-project/threads/${firstThread}`,
      { method: "DELETE" },
    );
  }
  assert.equal(deleteFirstForExecutionGuard.status, 200);
  const purgeFirstAttempt = await api(
    page,
    `/api/projects/legacy-project/threads/${firstThread}/purge`,
    {
      body: "{}",
      headers: { "content-type": "application/json" },
      method: "POST",
    },
  );
  let restartTargetHref = firstHref;
  if (purgeFirstAttempt.status === 409) {
    assert.equal(purgeFirstAttempt.body?.error?.code, "OPERATION_CONFLICT");
    assert.equal(purgeFirstAttempt.body?.error?.fields?.threadId, "has_executions");
    await page.goto(`${baseUrl}${firstHref}`, { waitUntil: "networkidle" });
    await page.getByText("该线程已移入回收站。", { exact: true }).waitFor();
    await page.getByRole("button", { name: "恢复线程" }).click();
    await page.getByText("Owner message with image attachments.", { exact: true }).waitFor();
  } else {
    assert.equal(purgeFirstAttempt.status, 200);
    restartTargetHref = `/projects/legacy-project?thread=${legacyThreadId}`;
  }

  await restartApp(page);
  await page.goto(`${baseUrl}${restartTargetHref}`, { waitUntil: "networkidle" });
  const restartThreadId = new URL(`${baseUrl}${restartTargetHref}`).searchParams.get("thread");
  assert.ok(restartThreadId);
  await readThread(page, "legacy-project", restartThreadId);
  const reopenedState = inspectDatabase();
  assert.equal(
    reopenedState.threads.some((thread) => thread.id === secondThread),
    false,
    "purged thread must stay absent after restart reopen",
  );
  assert.equal(
    reopenedState.attachments.some((attachment) => attachment.id === recycleAttachmentId),
    false,
    "purged attachment row must stay absent after restart reopen",
  );
  const attachmentAfterRestart = await api(
    page,
    `/api/projects/legacy-project/threads/${secondThread}/attachments/${recycleAttachmentId}/content`,
  );
  assert.equal(attachmentAfterRestart.status, 404);

  const listPendingAuditTypes = async () => {
    let before = null;
    const events = [];
    while (true) {
      const path = before === null
        ? "/api/projects/legacy-project/audit-events"
        : `/api/projects/legacy-project/audit-events?before=${before}`;
      const pageResult = await api(page, path);
      assert.equal(pageResult.status, 200);
      events.push(...pageResult.body.events);
      before = pageResult.body.nextBeforeSeq;
      if (before === null) return events.map((event) => event.eventType);
    }
  };
  const lifecycleAuditTypes = new Set(await listPendingAuditTypes());
  for (const expected of ["thread_deleted", "thread_restored", "thread_purged"]) {
    assert.equal(
      lifecycleAuditTypes.has(expected),
      true,
      `audit trail must include ${expected}`,
    );
  }
  pass("thread-recycle-restore-purge-audit-search-attachment-restart");

  const foreignRecycle = await api(
    page,
    `/api/projects/${foreignProjectId}/thread-recycle-bin?limit=100`,
  );
  assert.equal(foreignRecycle.status, 200);
  assert.deepEqual(foreignRecycle.body.threads, []);
  for (const [method, path, payload] of [
    ["DELETE", `/api/projects/legacy-project/threads/${foreignThreadId}`, null],
    ["POST", `/api/projects/legacy-project/threads/${foreignThreadId}/restore`, {}],
    ["POST", `/api/projects/legacy-project/threads/${foreignThreadId}/purge`, {}],
    ["DELETE", `/api/projects/${foreignProjectId}/threads/${firstThread}`, null],
    ["POST", `/api/projects/${foreignProjectId}/threads/${firstThread}/restore`, {}],
    ["POST", `/api/projects/${foreignProjectId}/threads/${firstThread}/purge`, {}],
  ]) {
    const denied = await api(page, path, payload === null
      ? { method }
      : {
          body: JSON.stringify(payload),
          headers: { "content-type": "application/json" },
          method,
        });
    assert.equal(denied.status, 404, `cross-tuple lifecycle route must 404: ${path}`);
    assert.equal(denied.body?.error?.code, "RESOURCE_NOT_FOUND");
  }
  pass("thread-recycle-cross-project-isolation-and-tuple-404");

  await page.setViewportSize({ height: 844, width: 390 });
  await page.reload({ waitUntil: "networkidle" });
  const recycleNavOpener = page.getByRole("button", { name: "打开项目导航" });
  await recycleNavOpener.click();
  const recycleDrawer = page.getByRole("dialog", { name: "项目导航" });
  await recycleDrawer.waitFor();
  const narrowRecycleTab = recycleDrawer.getByRole("button", { name: "回收站" });
  await narrowRecycleTab.waitFor();
  const narrowRecycleTabBox = await narrowRecycleTab.boundingBox();
  assert.ok(
    narrowRecycleTabBox
    && narrowRecycleTabBox.height >= 44
    && narrowRecycleTabBox.width >= 44,
    "narrow recycle tab must stay >= 44px",
  );
  await narrowRecycleTab.click();
  await recycleDrawer.getByText("回收站为空。", { exact: true }).waitFor();
  narrowRecycleFacingText = await page.locator("html").innerText();
  await axe(page, "narrow light thread recycle bin drawer");
  await page.screenshot({ fullPage: true, path: evidence.recycleNarrow });
  await page.keyboard.press("Escape");
  await recycleDrawer.waitFor({ state: "detached" });
  assert.equal(
    await recycleNavOpener.evaluate((node) => document.activeElement === node),
    true,
    "narrow Escape must return focus to recycle drawer opener",
  );
  await page.getByRole("button", { name: /切换到暗色主题/ }).click();
  await page.getByRole("button", { name: /切换到明色主题/ }).waitFor();
  await recycleNavOpener.click();
  await recycleDrawer.waitFor();
  await recycleDrawer.getByRole("button", { name: "回收站" }).click();
  await recycleDrawer.getByText("回收站为空。", { exact: true }).waitFor();
  await axe(page, "narrow dark thread recycle bin drawer");
  await page.screenshot({ fullPage: true, path: evidence.recycleNarrowDark });
  await page.keyboard.press("Escape");
  await recycleDrawer.waitFor({ state: "detached" });
  await page.getByRole("button", { name: /切换到明色主题/ }).click();
  await page.getByRole("button", { name: /切换到暗色主题/ }).waitFor();
  pass("thread-recycle-desktop-narrow-light-dark-keyboard-focus-44px-axe");

  // ---- feature 034 T-05: thread queue steer real-browser acceptance ----
  // Covers enqueue/cancel/reorder/steer plus run-start consumption observable
  // results in one cohesive affected-threads smoke segment.
  await page.setViewportSize({ height: 1050, width: 1500 });
  const queueProjectId = "legacy-project";
  const queueMembers = await api(page, `/api/projects/${queueProjectId}/members`);
  assert.equal(queueMembers.status, 200);
  const queueMemberAgentIds = queueMembers.body.members
    .map((member) => member.agentId)
    .slice(0, 2);
  assert.ok(queueMemberAgentIds.length > 0, "queue thread requires at least one project member");
  const queueThreadCreate = await api(page, `/api/projects/${queueProjectId}/threads`, {
    body: JSON.stringify({
      memberAgentIds: queueMemberAgentIds,
      operationId: randomUUID(),
      title: "队列验收线程",
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(
    queueThreadCreate.status,
    201,
    `queue thread create failed: ${JSON.stringify(queueThreadCreate.body)}`,
  );
  const queueThreadId = queueThreadCreate.body.thread.id;
  await page.goto(
    `${baseUrl}/projects/${queueProjectId}?thread=${queueThreadId}`,
    { waitUntil: "networkidle" },
  );

  const queueFirstContent = `queue-first-${seed}`;
  const queueSecondContent = `queue-second-${seed}`;
  const queueThirdContent = `queue-third-${seed}`;
  const enqueueRoute = `/api/projects/${queueProjectId}/threads/${queueThreadId}/queue`;
  const enqueueFirst = await api(page, enqueueRoute, {
    body: JSON.stringify({
      content: queueFirstContent,
      expectedVersion: 1,
      operationId: randomUUID(),
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(enqueueFirst.status, 201);
  const enqueueSecond = await api(page, enqueueRoute, {
    body: JSON.stringify({
      content: queueSecondContent,
      expectedVersion: enqueueFirst.body.threadVersion,
      operationId: randomUUID(),
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(enqueueSecond.status, 201);
  const enqueueThird = await api(page, enqueueRoute, {
    body: JSON.stringify({
      content: queueThirdContent,
      expectedVersion: enqueueSecond.body.threadVersion,
      operationId: randomUUID(),
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(enqueueThird.status, 201);
  const firstQueueSnapshot = await api(page, enqueueRoute);
  assert.equal(firstQueueSnapshot.status, 200);
  assert.deepEqual(
    firstQueueSnapshot.body.items.map((item) => item.content),
    [queueFirstContent, queueSecondContent, queueThirdContent],
  );
  assert.deepEqual(
    firstQueueSnapshot.body.items.map((item) => item.status),
    ["pending", "pending", "pending"],
  );
  pass("thread-queue-enqueue-api-order");
  await page.reload({ waitUntil: "networkidle" });

  const queueExpandButton = page.getByRole("button", { name: "展开待处理消息队列" });
  await queueExpandButton.click();
  const queueRegion = page.getByRole("region", { name: "待处理消息队列" });
  await queueRegion.waitFor();
  await queueRegion.getByText(queueFirstContent, { exact: true }).waitFor();
  await queueRegion.getByText(queueSecondContent, { exact: true }).waitFor();
  await queueRegion.getByText(queueThirdContent, { exact: true }).waitFor();
  const queueSteerButton = queueRegion.getByRole("button", {
    name: `Steer ${queueThirdContent}`,
  });
  const queueSteerBox = await queueSteerButton.boundingBox();
  assert.ok(
    queueSteerBox && queueSteerBox.height >= 44 && queueSteerBox.width >= 44,
    "queue steer button must stay >= 44px",
  );
  const steerResponse = page.waitForResponse((response) =>
    response.request().method() === "POST"
    && response.url().endsWith(
      `/api/projects/${queueProjectId}/threads/${queueThreadId}/queue/${enqueueThird.body.item.id}/steer`,
    )
  );
  await queueSteerButton.click();
  assert.equal((await steerResponse).status(), 200);
  await page.waitForFunction(
    (expected) =>
      document.querySelector(".timeline-event h4")?.textContent === expected,
    queueThirdContent,
  );
  const reorderResponse = page.waitForResponse((response) =>
    response.request().method() === "POST"
    && response.url().endsWith(
      `/api/projects/${queueProjectId}/threads/${queueThreadId}/queue/${enqueueThird.body.item.id}/reorder`,
    )
  );
  await queueRegion
    .getByRole("button", { name: `下移 ${queueThirdContent}` })
    .click();
  assert.equal((await reorderResponse).status(), 200);
  const cancelResponse = page.waitForResponse((response) =>
    response.request().method() === "POST"
    && response.url().endsWith(
      `/api/projects/${queueProjectId}/threads/${queueThreadId}/queue/${enqueueFirst.body.item.id}/cancel`,
    )
  );
  await queueRegion
    .getByRole("button", { name: `撤回 ${queueFirstContent}` })
    .click();
  assert.equal((await cancelResponse).status(), 200);
  const queueListAfterOps = await api(page, enqueueRoute);
  assert.equal(queueListAfterOps.status, 200);
  assert.deepEqual(
    queueListAfterOps.body.items.map((item) => [item.content, item.status, item.position]),
    [
      [queueFirstContent, "cancelled", 1],
      [queueThirdContent, "pending", 2],
      [queueSecondContent, "pending", 3],
    ],
  );
  await queueRegion.getByText("队列位置 #2", { exact: true }).waitFor();
  pass("thread-queue-steer-reorder-cancel-ui");

  const queueStartRun = await api(
    page,
    `/api/projects/${queueProjectId}/threads/${queueThreadId}/runs`,
    {
      body: JSON.stringify({
        message: `trigger-queue-consume-${seed}`,
        operationId: randomUUID(),
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
  );
  assert.equal(queueStartRun.status, 201, JSON.stringify(queueStartRun.body));
  assert.equal(queueStartRun.body.message.content, queueThirdContent);
  const queueActiveRun = await waitForRun(
    page,
    queueProjectId,
    queueThreadId,
    "running",
  );
  assert.ok(queueActiveRun.id);
  const queueAfterConsume = await api(page, enqueueRoute);
  assert.equal(queueAfterConsume.status, 200);
  const consumedQueueItem = queueAfterConsume.body.items.find((item) => item.content === queueThirdContent);
  assert.ok(consumedQueueItem);
  assert.equal(consumedQueueItem.status, "consumed");
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("button", { name: "展开待处理消息队列" }).click();
  await queueRegion.getByText("consumed", { exact: true }).waitFor();
  queueFacingText = await page.locator("html").innerText();
  await axe(page, "desktop light thread queue panel");
  await page.screenshot({ fullPage: true, path: evidence.queueDesktop });
  await page.getByRole("button", { name: /切换到暗色主题/ }).click();
  await page.getByRole("button", { name: /切换到明色主题/ }).waitFor();
  await axe(page, "desktop dark thread queue panel");
  await page.screenshot({ fullPage: true, path: evidence.queueDark });
  await page.getByRole("button", { name: /切换到明色主题/ }).click();
  await page.getByRole("button", { name: /切换到暗色主题/ }).waitFor();

  await page.setViewportSize({ height: 844, width: 390 });
  await page.reload({ waitUntil: "networkidle" });
  const queueEditorOpener = page.getByRole("button", { name: "打开编辑" });
  await queueEditorOpener.focus();
  await page.keyboard.press("Enter");
  const queueEditorDrawer = page.getByRole("dialog", { name: "任务编辑" });
  await queueEditorDrawer.waitFor();
  await queueEditorDrawer.getByRole("tab", { name: "群聊" }).click();
  await queueEditorDrawer
    .getByRole("button", { name: "展开待处理消息队列" })
    .click();
  const narrowQueueRegion = queueEditorDrawer.getByRole("region", {
    name: "待处理消息队列",
  });
  await narrowQueueRegion.getByText(queueThirdContent, { exact: true }).waitFor();
  await narrowQueueRegion.getByText("consumed", { exact: true }).waitFor();
  narrowQueueFacingText = await page.locator("html").innerText();
  await axe(page, "narrow thread queue drawer");
  await page.screenshot({ fullPage: true, path: evidence.queueNarrow });
  await page.keyboard.press("Escape");
  await queueEditorDrawer.waitFor({ state: "detached" });
  assert.equal(
    await queueEditorOpener.evaluate((node) => document.activeElement === node),
    true,
    "queue drawer Escape must return focus to opener",
  );
  pass("thread-queue-consume-desktop-narrow-light-dark-axe");

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
  const auditScreenshotBytes = [
    evidence.auditDark,
    evidence.auditDesktop,
    evidence.auditNarrow,
  ]
    .map((path) => readFileSync(path).toString("latin1"))
    .join("\n");
  const searchScreenshotBytes = [
    evidence.searchDark,
    evidence.searchDesktop,
    evidence.searchNarrow,
  ]
    .map((path) => readFileSync(path).toString("latin1"))
    .join("\n");
  const tagScreenshotBytes = [
    evidence.tagsDark,
    evidence.tagsDesktop,
    evidence.tagsNarrow,
    evidence.tagsNarrowDark,
  ]
    .map((path) => readFileSync(path).toString("latin1"))
    .join("\n");
  const recycleScreenshotBytes = [
    evidence.recycleDark,
    evidence.recycleDesktop,
    evidence.recycleNarrow,
    evidence.recycleNarrowDark,
  ]
    .map((path) => readFileSync(path).toString("latin1"))
    .join("\n");
  const queueScreenshotBytes = [
    evidence.queueDark,
    evidence.queueDesktop,
    evidence.queueNarrow,
  ]
    .map((path) => readFileSync(path).toString("latin1"))
    .join("\n");
  const publicSurfaces = [
    dom,
    databaseText,
    productApiBodies.join("\n"),
    serverOutput,
    existingEvidence,
    auditFacingText,
    narrowAuditFacingText,
    searchFacingText,
    tagFacingText,
    narrowTagFacingText,
    recycleFacingText,
    narrowRecycleFacingText,
    queueFacingText,
    narrowQueueFacingText,
    auditScreenshotBytes,
    searchScreenshotBytes,
    tagScreenshotBytes,
    recycleScreenshotBytes,
    queueScreenshotBytes,
    JSON.stringify(results),
  ];
  for (const secret of [apiKey, masterKey, `Bearer ${apiKey}`]) {
    for (const surface of publicSurfaces) {
      assert.equal(surface.includes(secret), false, "fixture secret leaked");
    }
  }
  for (const surface of [
    dom,
    databaseText,
    productApiBodies.join("\n"),
    serverOutput,
    auditFacingText,
    narrowAuditFacingText,
    searchFacingText,
    tagFacingText,
    narrowTagFacingText,
    recycleFacingText,
    narrowRecycleFacingText,
    queueFacingText,
    narrowQueueFacingText,
  ]) {
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
  for (const cleanupPath of [`.next-thread-smoke-${process.pid}`, temporaryDirectory]) {
    let removed = false;
    for (let attempt = 0; attempt < 5 && !removed; attempt += 1) {
      try {
        rmSync(cleanupPath, { force: true, recursive: true });
        removed = true;
      } catch (error) {
        const busy =
          error
          && typeof error === "object"
          && "code" in error
          && (error.code === "EPERM" || error.code === "EACCES" || error.code === "EBUSY");
        if (!busy || attempt === 4) throw error;
        await new Promise((done) => setTimeout(done, 350));
      }
    }
  }
  for (const snapshot of stableConfig) {
    writeFileSync(snapshot.path, snapshot.content, "utf8");
  }
}
