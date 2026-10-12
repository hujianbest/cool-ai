// UI consistency audit capture runner: drives the real app through every
// functional screen and after-click state, screenshotting each one for
// comparison against product/ui/preview-ucd.html and product/ui/UI设计.md.
// Self-contained: own dev server, temp DB, temp workspace, scripted picker,
// mock OpenAI-compatible provider. Screenshots land in
// tests/browser/test-artifacts/ui-audit/ (gitignored).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { chromium } from "playwright";

import { stopServerTree } from "./runner-process.mjs";

const host = "127.0.0.1";
const port = 4600 + (process.pid % 300);
const baseUrl = `http://${host}:${port}`;
const mockProviderPort = 5200 + (process.pid % 300);
const mockProviderUrl = `http://127.0.0.1:${mockProviderPort}/v1`;
const temporaryDirectory = mkdtempSync(join(tmpdir(), "cool-ai-ui-audit-"));
const databasePath = join(temporaryDirectory, "audit.sqlite");
const workspaceDirectory = join(temporaryDirectory, "audit-workspace");
const artifactDirectory = resolve("tests", "browser", "test-artifacts", "ui-audit");
// 清掉上一轮失败截图，避免与本次证据并排误读。
try {
  for (const entry of readdirSync(artifactDirectory)) {
    if (entry.endsWith("-failure.png")) rmSync(join(artifactDirectory, entry), { force: true });
  }
} catch {
  // 目录首次创建时不存在。
}
// 纪律（执行策略 5）：测试期间绝不回滚 tsconfig.json / next-env.d.ts；
// 全部运行结束后由操作者统一 `git checkout -- tsconfig.json next-env.d.ts` 一次。
mkdirSync(artifactDirectory, { recursive: true });
mkdirSync(workspaceDirectory, { recursive: true });

const MOCK_TURN = {
  message:
    "已针对登录模块完成拆解：\n1. 接入层区分 Access Token（15 分钟）与 Refresh Token（7 天）；\n" +
    "2. 校验中间件在 401 时自动无感换票并重放请求；\n" +
    "3. 单元测试覆盖过期、并发刷新与撤销分支。\n请审阅此提案。",
  blocks: [
    {
      actions: ["accept", "reject"],
      blockRevision: 1,
      blockSchemaVersion: 1,
      blockType: "proposal",
      body: "将 src/adapters/auth.ts 的 HMAC 签名升级为 RS256，并补齐公钥配置与单元测试。",
      logicalBlockId: "proposal-login-refactor",
      title: "提案：JWT 登录模块改造为双 Token",
    },
  ],
  tasks: [],
  claim: null,
  disposition: {
    type: "decision_request",
    question: "是否按双 Token 方案继续实施？",
    options: ["按双 Token 方案继续", "先补充安全评审"],
  },
};

const mockProvider = createServer((request, response) => {
  if (request.url === "/v1/models") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "gpt-4o", object: "model" }] }));
    return;
  }
  if (request.url === "/v1/chat/completions" && request.method === "POST") {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      // 个人对话（1:1 直聊）的回合以 reply 收束；协作回合用 decision_request
      // （无参与者门槛，并可点亮 Needs Me）。平台提示词声明直聊范围。
      let turn = MOCK_TURN;
      try {
        const parsed = JSON.parse(body);
        const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
        const directChat = messages.some(
          (message) =>
            message?.role === "system"
            && typeof message?.content === "string"
            && message.content.includes("direct 1:1 conversation"),
        );
        if (directChat) {
          turn = {
            ...MOCK_TURN,
            disposition: { summary: "已完成拆解并给出直聊答复。", type: "reply" },
          };
        }
      } catch {
        // 非法请求体按协作回合处理。
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: "chatcmpl-ui-audit",
          object: "chat.completion",
          created: Date.now(),
          model: "gpt-4o",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: JSON.stringify(turn) },
              finish_reason: "stop",
            },
          ],
          usage: { completion_tokens: 128, prompt_tokens: 256, total_tokens: 384 },
        }),
      );
    });
    return;
  }
  response.writeHead(404).end();
});

// 生产模式 next start（需要先有 .next 构建；smoke-suite.mjs 或 npm run build 先行），
// 与全部冒烟脚本一致；不再走 next dev 按需编译。
const server = spawn(process.execPath, [
  join("node_modules", "next", "dist", "bin", "next"),
  "start",
  "--hostname",
  host,
  "--port",
  String(port),
], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    COCKPIT_ALLOW_SCRIPTED_PICKER: "1",
    COCKPIT_DB_PATH: databasePath,
    COCKPIT_MASTER_KEY: "MTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTI",
    COCKPIT_SCRIPTED_DIRECTORY: workspaceDirectory,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverOutput = "";
server.stdout.on("data", (chunk) => (serverOutput += chunk.toString()));
server.stderr.on("data", (chunk) => (serverOutput += chunk.toString()));

function stopServer() {
  // posix 下 SIGTERM 父进程后按端口反查兜底，避免孤儿 next 进程占端口。
  stopServerTree(server, { label: "audit-dev-server", port });
}

async function waitForServer() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
    } catch {}
    await new Promise((done) => setTimeout(done, 1000));
  }
  throw new Error(`server did not start: ${serverOutput.slice(-2000)}`);
}

const steps = [];
const pageDiagnostics = [];
let activePage;
let page;

async function shot(name) {
  await page.screenshot({ path: join(artifactDirectory, `${name}.png`), fullPage: true });
  console.log(`SHOT ${name}`);
}

// 对话框截图前把弹层滚到顶部：抽屉/模态内部滚动位置会让头部与首批字段被裁切，
// 截到「滚动中段」状态会产生假缺陷读数。
async function scrollDialogToTop() {
  await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"], .modal-surface, .action-dialog');
    if (!dialog) return;
    dialog.scrollTop = 0;
    for (const node of dialog.querySelectorAll("*")) {
      if (node.scrollHeight > node.clientHeight) node.scrollTop = 0;
    }
  });
  await page.waitForTimeout(250);
}

// 聊天截图前把时间线滚到底：浮起 Composer 遮挡末端内容是截图中段状态，
// 滚到末端（含 scroll-padding 让位）后再截图才反映用户看到的稳定形态。
async function scrollChatToBottom() {
  await page.evaluate(() => {
    const log = document.querySelector('[aria-label="协作时间线"]');
    if (log) log.scrollTop = log.scrollHeight;
  });
  await page.waitForTimeout(400);
}

async function step(id, title, fn) {
  pageDiagnostics.length = 0;
  const startedAt = Date.now();
  const elapsed = () => `${Math.round((Date.now() - startedAt) / 1000)}s`;
  try {
    await fn();
    steps.push({ id, title, status: "PASS", seconds: Math.round((Date.now() - startedAt) / 1000) });
    console.log(`[PASS] ${id} ${title} (${elapsed()})`);
  } catch (error) {
    let failureShot = null;
    try {
      failureShot = `${id}-failure`;
      await shot(failureShot);
    } catch {
      failureShot = null;
    }
    let url = null;
    try {
      url = activePage?.url() ?? null;
    } catch {
      url = null;
    }
    steps.push({
      id,
      title,
      status: "FAIL",
      error: String(error?.message ?? error).slice(0, 300),
      failureShot,
      url,
      diagnostics: [...pageDiagnostics].slice(-8),
    });
    console.log(`[FAIL] ${id} ${title} (${elapsed()}): ${String(error?.message ?? error).slice(0, 200)}`);
    for (const line of pageDiagnostics.slice(-5)) console.log(`  diag ${line}`);
  }
}

let browser;
try {
  await new Promise((done) => mockProvider.listen(mockProviderPort, host, done));
  await waitForServer();
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: "light" });
  await context.addInitScript(() => {
    const inject = () => {
      const style = document.createElement("style");
      style.textContent =
        "nextjs-portal, [data-nextjs-dev-overlay] { display: none !important; pointer-events: none !important; }";
      document.documentElement.appendChild(style);
    };
    if (document.documentElement) inject();
    else document.addEventListener("DOMContentLoaded", inject, { once: true });
  });
  page = await context.newPage();
  activePage = page;
  page.on("console", (message) => {
    if (message.type() === "error") pageDiagnostics.push(`console: ${message.text().slice(0, 200)}`);
  });
  page.on("pageerror", (error) => pageDiagnostics.push(`pageerror: ${String(error).slice(0, 200)}`));
  // dev 模式首屏编译可达数十秒：放宽默认等待，不把加载态误判为缺陷。
  page.setDefaultTimeout(45_000);
  page.setDefaultNavigationTimeout(90_000);
  page.on("response", async (response) => {
    if (response.status() >= 400) {
      const body = await response.text().catch(() => "");
      console.log(`API ERROR ${response.status()} ${response.url()} :: ${body.slice(0, 300)}`);
    }
  });

  // ---------- S01-S02: first open without provider ----------
  await step("S01", "首页无 Provider 引导态", async () => {
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.getByText("配置模型 Provider 后即可开始。", { exact: true }).waitFor();
    await shot("01-home-no-provider");
  });

  await step("S02", "/team 空态（模型服务/Agent/技能）", async () => {
    await page.goto(`${baseUrl}/team`, { waitUntil: "networkidle" });
    await page.getByRole("tablist", { name: "团队资源" }).waitFor();
    await shot("02-team-empty");
  });

  // ---------- S03-S07: configure provider / skill / agent via UI ----------
  await step("S03", "模型服务创建对话框", async () => {
    const tab = page.locator('#provider-resource-tab, button:has-text("模型服务")').first();
    await tab.click();
    await page.locator("#provider-resource-panel button.button-primary").first().click();
    await page.fill("#provider-name", "本机审计网关");
    await page.fill("#provider-base-url", mockProviderUrl);
    await page.fill("#provider-model", "gpt-4o");
    await page.fill("#provider-api-key", "sk-mock-audit-key");
    const insecure = page.locator('input[type="checkbox"]').first();
    if (await insecure.isVisible().catch(() => false)) await insecure.check();
    await scrollDialogToTop();
    await shot("03-provider-dialog");
  });

  await step("S04", "验证连接与保存后的模型服务列表", async () => {
    await page.locator('button:has-text("验证连接")').click();
    await page.getByText(/验证成功|连接成功|已通过/).waitFor({ timeout: 20_000 }).catch(() => {});
    await shot("04-provider-verified");
    await page.locator('button:has-text("保存服务")').click();
    await page.waitForTimeout(1200);
    await shot("04b-provider-saved");
  });

  await step("S05", "技能包对话框与保存", async () => {
    const tab = page.locator('#skill-resource-tab, button:has-text("技能")').first();
    await tab.click();
    await page.waitForTimeout(400);
    await page.locator("#skill-resource-panel button.button-primary").first().click();
    await page.fill("#skill-name", "TDD 开发规范");
    await page.fill("#skill-description", "遵循红绿重构循环进行高质量交付");
    await page.fill("#skill-instructions", "编写功能前先编写失败测试，逐步实现并重构。");
    await scrollDialogToTop();
    await shot("05-skill-dialog");
    await page.locator('#skill-resource-panel button[type="submit"], button:has-text("创建技能"), button:has-text("保存技能")').first().click();
    await page.waitForTimeout(1000);
    await shot("05b-skill-saved");
  });

  await step("S06", "Agent 创建对话框与保存", async () => {
    const tab = page.locator('#agent-resource-tab, button:has-text("Agent")').first();
    await tab.click();
    await page.waitForTimeout(400);
    await page.locator("#agent-resource-panel button.button-primary").first().click();
    await page.fill("#agent-name", "规划搭档");
    await page.fill("#agent-role", "负责系统设计与任务拆解");
    await page.fill("#agent-system-prompt", "你是一名资深的系统架构师与规划搭档。");
    await page.locator("#agent-provider").selectOption({ index: 1 });
    await page.fill("#agent-avatar", "规");
    await scrollDialogToTop();
    await shot("06-agent-dialog");
    await page.locator('#agent-resource-panel button[type="submit"], button:has-text("保存 Agent")').first().click();
    await page.waitForTimeout(1200);
    await shot("06b-agent-created");
  });

  await step("S07", "/team 纵深分区滚动截图（健康/用量/贡献/规则）", async () => {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 3));
    await page.waitForTimeout(400);
    await shot("07-team-scroll-1");
    await page.evaluate(() => window.scrollTo(0, (document.body.scrollHeight * 2) / 3));
    await page.waitForTimeout(400);
    await shot("07-team-scroll-2");
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(400);
    await shot("07-team-scroll-3");
  });

  // ---------- S08: settings view via rail ----------
  await step("S08", "设置视图（图标轨）", async () => {
    await page.getByRole("button", { name: "设置" }).first().click();
    await page.waitForTimeout(800);
    await shot("08-settings");
  });

  // ---------- S09-S14: home direct chat, thread create, composer, search ----------
  await step("S09", "首页 1:1 直聊态", async () => {
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.waitForTimeout(800);
    await shot("09-home-direct-chat");
  });

  await step("S10", "新对话对话框与创建", async () => {
    await page.getByRole("button", { name: "新对话" }).first().click();
    await page.waitForTimeout(500);
    await shot("10-thread-dialog");
    await page.fill("#thread-title", "JWT 登录模块重构与双 Token 方案");
    await page.locator('.thread-create-form button[type="submit"]').click();
    await page.waitForTimeout(1200);
    await shot("10b-thread-created");
  });

  await step("S11", "Composer @提及建议、提及发送失败态与纯文本发送回执", async () => {
    const composer = page.locator("textarea").first();
    await composer.click();
    await composer.fill("@规");
    await page.waitForTimeout(600);
    await shot("11-mention-suggest");
    await composer.fill("@规划搭档 请拆解登录模块的改造方案。");
    const send = page.locator('button.composer-send, button[aria-label*="发送"]').first();
    await send.click();
    await page.waitForTimeout(2500);
    await scrollChatToBottom();
    await shot("11c-mention-send-result");
    await composer.fill("请拆解登录模块的改造方案。");
    await send.click();
    await page.getByText("完成拆解", { exact: false }).first().waitFor({ timeout: 60_000 });
    await page.waitForTimeout(800);
    await page.evaluate(() => {
      const body = document.querySelector(".chat-body");
      if (body) body.scrollTop = body.scrollHeight;
    });
    await page.waitForTimeout(400);
    await scrollChatToBottom();
    await shot("11b-chat-reply");
  });

  await step("S11b", "历史运行结束后直接发送开始新一轮（U-10）", async () => {
    // 结束当前运行（waiting_owner → stopped），再直接发送。
    const threadId = new URL(page.url()).searchParams.get("thread");
    if (!threadId) throw new Error("对话未选中");
    // 首页直聊的项目 id 不在路径里：从 home 读接口取当前项目。
    const projectId = await page.evaluate(async () => {
      const home = await (await fetch("/api/home")).json();
      return home?.project?.id ?? null;
    });
    if (!projectId) throw new Error("未找到当前个人对话项目");
    const stopped = await page.evaluate(async ({ pid, tid }) => {
      // 运行版本可能因推进变化：读到的 currentVersion 用于重试。
      let expectedVersion = null;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const detail = await (await fetch(`/api/projects/${pid}/threads/${tid}`)).json();
        const run = (detail.runs ?? []).at(-1);
        if (!run) return { ok: false, reason: "no run" };
        expectedVersion =
          expectedVersion ?? run.version;
        const response = await fetch(
          `/api/projects/${pid}/threads/${tid}/runs/${run.id}/control`,
          {
            body: JSON.stringify({
              action: "stop",
              expectedVersion,
              operationId: crypto.randomUUID(),
            }),
            headers: { "content-type": "application/json" },
            method: "POST",
          },
        );
        if (response.ok) return { ok: true, status: response.status };
        const body = await response.json().catch(() => null);
        if (body?.error?.currentVersion === undefined) {
          return { ok: false, status: response.status, body: JSON.stringify(body) };
        }
        expectedVersion = body.error.currentVersion;
      }
      return { ok: false, reason: "stop retries exhausted" };
    }, { pid: projectId, tid: threadId });
    if (!stopped.ok) throw new Error(`停止运行失败: ${JSON.stringify(stopped)}`);
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(1200);
    await shot("11d-after-stop");

    // 不再要求先选择历史运行：发送即可开始新一轮，且不出现内部术语提示。
    const composer = page.locator("textarea").first();
    await composer.click();
    await composer.fill("停止后直接开始新一轮。");
    const send = page.locator('button.composer-send, button[aria-label*="发送"]').first();
    await send.click();
    await page.waitForTimeout(2500);
    const termHintCount = await page.getByText("请先选择历史运行", { exact: false }).count();
    if (termHintCount !== 0) throw new Error("Composer 仍出现历史运行内部术语提示");
    await page.evaluate(() => {
      const body = document.querySelector(".chat-body");
      if (body) body.scrollTop = body.scrollHeight;
    });
    await page.waitForTimeout(400);
    await scrollChatToBottom();
    await shot("11e-new-round-direct-send");
  });

  await step("S12", "Cmd+K 搜索浮层与结果", async () => {
    await page.keyboard.press("Meta+k");
    await page.waitForTimeout(300);
    const overlayVisible = await page.locator('[role="dialog"], .search-overlay, [class*="search"]').first().isVisible().catch(() => false);
    if (!overlayVisible) await page.keyboard.press("Control+k");
    await page.waitForTimeout(500);
    await shot("12-search-overlay");
    await page.keyboard.type("登录");
    await page.waitForTimeout(800);
    await shot("12b-search-results");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  });

  await step("S13", "输入历史（空 Composer ↑）", async () => {
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.waitForTimeout(800);
    const composer = page.locator("textarea").first();
    await composer.click();
    await composer.fill("");
    await page.keyboard.press("ArrowUp");
    await page.waitForTimeout(600);
    await shot("13-input-history");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  });

  await step("S14", "附件入口弹出", async () => {
    const attach = page.locator('button[aria-label*="附件"], button[aria-label*="添加"]').first();
    if (await attach.isVisible().catch(() => false)) {
      await attach.click();
      await page.waitForTimeout(500);
      await shot("14-attach-menu");
      await page.keyboard.press("Escape");
    } else {
      throw new Error("附件按钮不可见");
    }
  });

  // ---------- S15-S16: open folder, project conversation ----------
  let projectUrl;
  await step("S15", "打开文件夹进入项目（空态）", async () => {
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "打开文件夹" }).first().click();
    const rawPicker = page.waitForResponse((response) => response.url().includes("/api/directory-picker"), { timeout: 15_000 }).catch(() => null);
    await rawPicker;
    await page.waitForURL(/\/projects\/[^/]+$/, { timeout: 30_000 });
    projectUrl = page.url();
    await page.waitForTimeout(1500);
    await shot("15-project-empty");
  });

  await step("S16", "项目内新对话、无使命首发送引导与群聊发送", async () => {
    if (!projectUrl) throw new Error("项目未打开");
    await page.getByRole("button", { name: "新对话" }).first().click();
    await page.waitForTimeout(500);
    await page.fill("#thread-title", "登录模块改造协作");
    const memberChecks = page.locator(".agent-select-input");
    await memberChecks.nth(0).check();
    await memberChecks.nth(1).check();
    await page.waitForTimeout(300);
    await page.locator('.thread-create-form button[type="submit"]').click();
    await page.locator(".thread-create-form").waitFor({ state: "detached", timeout: 20_000 }).catch(() => {});
    await page.waitForTimeout(1200);
    await shot("16-project-conversation");

    // U-02：项目尚无使命时的首条发送必须给出可操作的「创建使命」入口（真实浏览器）。
    const needsMissionComposer = page.locator("textarea").first();
    await needsMissionComposer.click();
    await needsMissionComposer.fill("@规划搭档 请给出登录模块改造的第一步。");
    await page.locator('button.composer-send, button[aria-label*="发送"]').first().click();
    await page
      .getByText("当前对话还没有使命。先创建使命，再在对话中发起协作。", { exact: true })
      .waitFor({ timeout: 20_000 });
    await shot("16a-project-chat-needs-mission");

    // 入口按钮把用户带到使命创建表单；创建后回到对话再发送。
    await page.getByRole("button", { name: "创建使命" }).first().click();
    const projectId = new URL(projectUrl).pathname.split("/").at(-1);
    const missionTitle = page.locator(`#mission-title-${projectId}`);
    await missionTitle.waitFor({ timeout: 20_000 });
    await missionTitle.fill("登录模块改造");
    await page.locator(`#mission-goal-${projectId}`).fill("完成 JWT 登录模块的改造与验证。");
    await page.getByRole("button", { name: "创建使命", exact: true }).first().click();
    await page.getByText("使命已创建。", { exact: false }).first().waitFor({ timeout: 30_000 });
    await shot("16b-mission-created-from-chat");
    await page.keyboard.press("Meta+1");
    await page.waitForTimeout(1200);

    const composer = page.locator("textarea").first();
    await composer.click();
    await composer.fill("@规划搭档 请给出登录模块改造的第一步。");
    await page.locator('button.composer-send, button[aria-label*="发送"]').first().click();
    await page.getByText("完成拆解", { exact: false }).first().waitFor({ timeout: 60_000 });
    await page.waitForTimeout(1200);
    await page.evaluate(() => {
      const body = document.querySelector(".chat-body");
      if (body) body.scrollTop = body.scrollHeight;
    });
    await page.waitForTimeout(400);
    await scrollChatToBottom();
    await shot("16c-project-chat-reply");
  });

  // ---------- S17-S21: governance views ----------
  await step("S17", "任务视图（空态/看板）", async () => {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    const cancel = page.locator('button:has-text("取消")').last();
    if (await cancel.isVisible().catch(() => false)) {
      await cancel.click();
      await page.waitForTimeout(400);
    }
    await page.locator(".activity-bar").getByRole("button", { name: "任务" }).first().click();
    await page.waitForTimeout(3000);
    await shot("17-tasks-view");
  });

  await step("S18", "任务看板：使命表单与新建任务", async () => {
    const titleInput = page.locator('input[id^="mission-title"]').first();
    if (!(await titleInput.isVisible().catch(() => false))) {
      const createBtn = page.getByRole("button", { name: /创建使命/ }).first();
      const editBtn = page.getByRole("button", { name: /编辑使命/ }).first();
      if (await createBtn.isVisible().catch(() => false)) {
        await createBtn.click();
      } else if (await editBtn.isVisible().catch(() => false)) {
        await editBtn.click();
      }
      await page.waitForTimeout(700);
    }
    await shot("18-mission-dialog");
    if (await titleInput.isVisible().catch(() => false)) {
      await titleInput.fill("登录模块改造（已更新目标）");
      const goalInput = page.locator('input[id^="mission-goal"], textarea[id^="mission-goal"]').first();
      if (await goalInput.isVisible().catch(() => false)) {
        await goalInput.fill("完成 JWT 登录模块的改造与验证。");
      }
      await page.locator('button:has-text("保存使命"), button:has-text("创建使命")').last().click();
      await page.waitForTimeout(1800);
    }
    await shot("18b-mission-created");
    const addItem = page.getByRole("button", { name: /新建任务/ }).first();
    if (await addItem.isVisible().catch(() => false)) {
      await addItem.click();
      await page.waitForTimeout(600);
      await shot("18c-workitem-dialog");
      const itemTitle = page.locator('input[id^="work-item-title"]').first();
      if (await itemTitle.isVisible().catch(() => false)) {
        await itemTitle.fill("补齐双 Token 刷新与并发测试");
        const submit = page.locator('button:has-text("创建任务"), button:has-text("保存任务")').last();
        if (await submit.isEnabled().catch(() => false)) {
          await submit.click();
          await page.waitForTimeout(1200);
        }
      }
      await shot("18d-board-with-card");
    }
  });

  await step("S19", "记忆视图（空态与有数据）", async () => {
    await page.locator(".activity-bar").getByRole("button", { name: "记忆" }).first().click();
    await page.waitForTimeout(1000);
    await shot("19-memory-view");
    await page.evaluate(async () => {
      const projectId = new URL(window.location.href).pathname.split("/").at(-1);
      const entries = [
        { content: "登录模块采用双 Token：Access 15 分钟 + Refresh 7 天。", type: "decision", sourceType: "owner_input", sourceRef: "Owner decision" },
        { content: "鉴权中间件需支持并发刷新去重，避免雪崩。", type: "fact", sourceType: "owner_input", sourceRef: "Owner note" },
      ];
      for (const entry of entries) {
        const response = await fetch(`/api/projects/${projectId}/memories`, {
          body: JSON.stringify(entry),
          headers: { "content-type": "application/json" },
          method: "POST",
        });
        if (!response.ok) console.log(`memory create failed: ${response.status} ${await response.text()}`);
      }
    });
    await page.reload({ waitUntil: "networkidle" });
    await page.locator(".activity-bar").getByRole("button", { name: "记忆" }).first().click();
    await page.waitForTimeout(1200);
    await shot("19b-memory-with-entries");
  });

  await step("S20", "审批中心视图", async () => {
    await page.locator(".activity-bar").getByRole("button", { name: "审批" }).first().click();
    await page.waitForTimeout(1000);
    await shot("20-approval-view");
  });

  await step("S21", "审计视图与时间轴", async () => {
    await page.locator(".activity-bar").getByRole("button", { name: "审计" }).first().click();
    await page.waitForTimeout(1200);
    await shot("21-audit-view");
    const timelineToggle = page.getByRole("button", { name: /时间轴/ }).first();
    if (await timelineToggle.isVisible().catch(() => false)) {
      await timelineToggle.click();
      await page.waitForTimeout(800);
      await shot("21b-audit-timeline");
    }
  });

  await step("S22", "返回对话（Cmd+1）与回收站", async () => {
    await page.keyboard.press("Meta+1");
    await page.waitForTimeout(300);
    if (!/\/projects\//.test(page.url())) await page.keyboard.press("Control+1");
    await page.waitForTimeout(800);
    await scrollChatToBottom();
    await shot("22-back-to-chat");
    const recycle = page.locator('button:has-text("回收站"), .thread-recycle-entry').first();
    if (await recycle.isVisible().catch(() => false)) {
      await recycle.click();
      await page.waitForTimeout(2000);
      await shot("22b-recycle-bin");
      await page.keyboard.press("Escape");
    }
  });

  await step("S23", "会话项更多菜单与批量整理", async () => {
    await page.goto(projectUrl, { waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    const item = page.locator(".thread-list-item").first();
    await item.waitFor({ timeout: 10_000 });
    await item.hover();
    await page.waitForTimeout(400);
    const more = item.locator('.thread-item-more button, button[aria-label*="更多"]').first();
    await more.click();
    await page.waitForTimeout(500);
    await shot("23-more-menu");
    const batch = page.locator('button:has-text("打标进批量整理"), .thread-item-menu button:has-text("打标")').first();
    if (await batch.isVisible().catch(() => false)) {
      await batch.click();
      await page.waitForTimeout(800);
      await shot("23b-batch-bar");
    }
  });

  await step("S24", "暗色主题切换", async () => {
    await page.locator("button.activity-bar-end").first().click();
    await page.waitForTimeout(900);
    await shot("24-dark-chat");
    await page.locator("button.activity-bar-end").first().click();
    await page.waitForTimeout(600);
  });

  await step("S25", "窄屏 390x844（主路径与抽屉）", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(1000);
    await shot("25-narrow-main");
    const drawer = page.locator('button[aria-label*="项目导航"], button[aria-label*="打开侧栏"], button[aria-label*="打开对话"]').first();
    if (await drawer.isVisible().catch(() => false)) {
      await drawer.click();
      await page.waitForTimeout(700);
      await shot("25b-narrow-drawer");
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.waitForTimeout(600);
  });

  await step("S26", "团队页资源分区（Provider/Agent/技能全览）", async () => {
    await page.goto(`${baseUrl}/team`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1200);
    await shot("26-team-overview");
  });

  await step("S27", "项目页 Header 语境与打开文件夹入口", async () => {
    if (projectUrl) {
      await page.goto(projectUrl, { waitUntil: "networkidle" });
      await page.waitForTimeout(1200);
      await shot("27-project-header");
    } else {
      throw new Error("项目未打开");
    }
  });

  // ---------- S28-S33：逐按钮点击后的页面补齐（任务编辑/记忆弹层/筛选态/团队编辑/会话筛选） ----------
  await step("S28", "任务编辑对话框（打开编辑 → 对话表面 → 关闭钮）", async () => {
    if (!projectUrl) throw new Error("项目未打开");
    // 「打开编辑」是窄屏移动工具栏的铅笔按钮（UCD §7 移动工具栏）；桌面三区无此控件。
    await page.goto(projectUrl, { waitUntil: "networkidle" });
    await page.waitForTimeout(1200);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(600);
    await page.getByRole("button", { name: "打开编辑" }).first().click();
    const editor = page.getByRole("dialog", { name: "任务编辑" });
    await editor.waitFor({ timeout: 20_000 });
    await page.waitForTimeout(800);
    await scrollDialogToTop();
    await shot("28-narrow-task-editor-dialog");
    await editor.getByRole("button", { name: "关闭任务编辑" }).first().click();
    await editor.waitFor({ state: "detached", timeout: 10_000 }).catch(() => {});
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.waitForTimeout(600);
  });

  await step("S29", "记忆沉淀/检索对话框与类型胶囊", async () => {
    await page.locator(".activity-bar").getByRole("button", { name: "记忆" }).first().click();
    await page.waitForTimeout(1200);
    await page.getByRole("button", { name: "沉淀新记忆" }).first().click();
    const createDialog = page.getByRole("dialog").first();
    await createDialog.waitFor({ timeout: 10_000 });
    await page.waitForTimeout(700);
    await scrollDialogToTop();
    await shot("29-memory-create-dialog");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);
    await page.getByRole("button", { name: "打开记忆检索" }).first().click();
    const searchDialog = page.getByRole("dialog").first();
    await searchDialog.waitFor({ timeout: 10_000 });
    await page.waitForTimeout(700);
    await scrollDialogToTop();
    await shot("29b-memory-search-dialog");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);
    const chip = page.locator(".memory-type-chips button").filter({ hasText: "决策" }).first();
    if (await chip.isVisible().catch(() => false)) {
      await chip.click();
      await page.waitForTimeout(800);
      await shot("29c-memory-type-filter");
      await chip.click().catch(() => {});
      await page.waitForTimeout(300);
    }
  });

  await step("S30", "审批中心状态筛选（下拉切换与回位）", async () => {
    await page.locator(".activity-bar").getByRole("button", { name: "审批" }).first().click();
    await page.waitForTimeout(1200);
    const select = page.locator(".approval-status-filter select").first();
    await select.waitFor({ timeout: 10_000 });
    const optionCount = await select.locator("option").count();
    await select.selectOption({ index: Math.min(1, optionCount - 1) });
    await page.waitForTimeout(800);
    await shot("30-approval-status-filter");
    await select.selectOption({ index: 0 });
    await page.waitForTimeout(400);
  });

  await step("S31", "审计中心域筛选（切换与回位）", async () => {
    await page.locator(".activity-bar").getByRole("button", { name: "审计" }).first().click();
    await page.waitForTimeout(1200);
    const chips = page.locator(".audit-domain-filters button");
    await chips.first().waitFor({ timeout: 10_000 });
    if ((await chips.count()) > 1) {
      await chips.nth(1).click();
      await page.waitForTimeout(800);
      await shot("31-audit-domain-filter");
      await chips.nth(0).click();
      await page.waitForTimeout(400);
    } else {
      throw new Error("审计域筛选按钮不足（期望 ≥2）");
    }
  });

  await step("S32", "团队页编辑对话框（模型服务与 Agent）", async () => {
    await page.goto(`${baseUrl}/team`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    // 编辑钮的 accessible name 为「编辑 <名称>」（aria-label 覆盖内部文本）。
    const editButtons = page.locator('button[aria-label^="编辑 "]');
    const count = await editButtons.count();
    if (count === 0) throw new Error("团队页无任何编辑按钮（aria-label^=编辑）");
    await editButtons.nth(0).click();
    const dialog = page.getByRole("dialog").first();
    await dialog.waitFor({ timeout: 10_000 });
    await page.waitForTimeout(700);
    await scrollDialogToTop();
    await shot("32-team-edit-dialog-1");
    await page.getByRole("button", { name: /^关闭.*编辑器$/ }).first().click();
    await dialog.waitFor({ state: "detached", timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(500);
    if (count > 1) {
      await editButtons.nth(1).click();
      const dialog2 = page.getByRole("dialog").first();
      await dialog2.waitFor({ timeout: 10_000 });
      await page.waitForTimeout(700);
      await scrollDialogToTop();
    await shot("32b-team-edit-dialog-2");
      await page.getByRole("button", { name: /^关闭.*编辑器$/ }).first().click();
      await dialog2.waitFor({ state: "detached", timeout: 10_000 }).catch(() => {});
      await page.waitForTimeout(500);
    }
  });

  await step("S33", "会话筛选 Tab（收藏与标签视图）", async () => {
    if (!projectUrl) throw new Error("项目未打开");
    await page.goto(projectUrl, { waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    const tablist = page.getByRole("tablist", { name: "对话视图" });
    await tablist.getByRole("tab", { name: "收藏" }).click();
    await page.waitForTimeout(1000);
    await shot("33-thread-favorites-view");
    await tablist.getByRole("tab", { name: "标签" }).click();
    await page.waitForTimeout(1000);
    await shot("33b-thread-tags-view");
    await tablist.getByRole("tab", { name: "全部" }).click();
    await page.waitForTimeout(500);
  });

  writeFileSync(
    join(artifactDirectory, "steps.json"),
    `${JSON.stringify({ generatedAt: new Date().toISOString(), steps }, null, 2)}\n`,
  );
  const failed = steps.filter((entry) => entry.status === "FAIL");
  console.log(`\nAUDIT CAPTURE DONE: ${steps.length - failed.length}/${steps.length} steps, screenshots in ${artifactDirectory}`);
  for (const entry of failed) console.log(`  FAIL ${entry.id}: ${entry.error}`);
} finally {
  await browser?.close();
  stopServer();
  mockProvider.close();
  rmSync(temporaryDirectory, { force: true, recursive: true });
}
