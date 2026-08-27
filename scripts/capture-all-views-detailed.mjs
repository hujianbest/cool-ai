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
import { chromium } from "playwright";

const host = "127.0.0.1";
const appPort = 5940;
const mockProviderPort = 5941;
const baseUrl = `http://${host}:${appPort}`;
const mockProviderUrl = `http://${host}:${mockProviderPort}/v1`;

const tempDir = mkdtempSync(join(tmpdir(), "cool-ai-audit-"));
const workspaceDir = join(tempDir, "workspace");
mkdirSync(workspaceDir, { recursive: true });
const canonicalWorkspace = realpathSync(workspaceDir);
const dbPath = join(tempDir, "detailed.sqlite");
const masterKey = randomBytes(32).toString("base64url");
const mockApiKey = `test-key-${randomBytes(12).toString("hex")}`;

const screenshotsDir = resolve("visual-audit-detailed");
mkdirSync(screenshotsDir, { recursive: true });

const browserExecutable = [
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
].find((c) => c && existsSync(c));

// Sample files in workspace
writeFileSync(
  join(workspaceDir, "auth.ts"),
  `export interface SessionUser {\n  id: string;\n  name: string;\n  role: 'owner' | 'guest';\n}\n\nexport function verifySession(token: string): SessionUser | null {\n  if (!token) return null;\n  return { id: 'usr_01', name: 'Alex', role: 'owner' };\n}\n`,
  "utf8"
);
writeFileSync(
  join(workspaceDir, "package.json"),
  JSON.stringify({ name: "cool-app", version: "1.0.0" }, null, 2),
  "utf8"
);

// Mock Provider HTTP Server
let turnCount = 0;
const mockProvider = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  res.writeHead(200, { "content-type": "application/json" });

  if (req.url === "/v1/models") {
    res.end(JSON.stringify({ data: [{ id: "gpt-5.3-codex" }, { id: "gpt-4o" }] }));
    return;
  }

  turnCount += 1;
  if (turnCount === 1) {
    // Planner proposal response
    res.end(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            kind: "proposal",
            title: "鉴权与会话体系升级方案",
            rationale: "基于当前轻量架构，引入 JWT 与 SQLite 双轨校验，确保离线与在线状态一致性。",
            options: [
              { id: "opt-1", label: "方案 A：无状态 JWT + 刷新令牌（推荐）" },
              { id: "opt-2", label: "方案 B：SQLite 持久会话 + 内存缓存" }
            ]
          })
        }
      }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }
    }));
  } else {
    // Implementer checklist response
    res.end(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            kind: "checklist",
            title: "鉴权模块实施清单",
            items: [
              { id: "c1", label: "编写 Token 签名与验签单元测试", checked: true },
              { id: "c2", label: "在 API 路由中注入 Session 中间件", checked: false },
              { id: "c3", label: "对接 SQLite Outbox 审计日志脱敏", checked: false }
            ]
          })
        }
      }],
      usage: { prompt_tokens: 12, completion_tokens: 24, total_tokens: 36 }
    }));
  }
});

mockProvider.listen(mockProviderPort, host);

// Next.js App Server
let serverProcess;
let serverLogs = "";

function startServer() {
  const nextBin = resolve("node_modules", "next", "dist", "bin", "next");
  serverProcess = spawn(
    process.execPath,
    [nextBin, "start", "--hostname", host, "--port", String(appPort)],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        COCKPIT_DB_PATH: dbPath,
        COCKPIT_MASTER_KEY: masterKey,
        COCKPIT_ALLOW_SCRIPTED_PICKER: "1",
        COCKPIT_SCRIPTED_DIRECTORY: workspaceDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }
  );

  serverProcess.stdout.on("data", (d) => { serverLogs += d.toString(); });
  serverProcess.stderr.on("data", (d) => { serverLogs += d.toString(); });
}

function stopServer() {
  try { mockProvider.close(); } catch {}
  if (!serverProcess?.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(serverProcess.pid), "/T", "/F"], { stdio: "ignore" });
    const listeners = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-Command", `(Get-NetTCPConnection -State Listen -LocalPort ${appPort} -ErrorAction SilentlyContinue).OwningProcess`],
      { encoding: "utf8", windowsHide: true }
    ).stdout;
    for (const pid of listeners.match(/\d+/g) ?? []) {
      spawnSync("taskkill", ["/pid", pid, "/T", "/F"], { stdio: "ignore" });
    }
  } else {
    serverProcess.kill("SIGTERM");
  }
}

async function waitForServer() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (serverProcess?.exitCode !== null) {
      throw new Error(`Server exited early with code ${serverProcess?.exitCode}\n${serverLogs}`);
    }
    try {
      const res = await fetch(baseUrl);
      if (res.ok || res.status === 200 || res.status === 304) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`Server did not respond within 60s\n${serverLogs}`);
}

async function run() {
  try {
    startServer();
    await waitForServer();
    console.log("Servers ready!");

    const browser = await chromium.launch({
      executablePath: browserExecutable,
      headless: true,
    });

    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
    });

    const page = await context.newPage();

    // Helper for theme toggle
    async function toggleTheme(mode) {
      const isDark = await page.evaluate(() => document.documentElement.classList.contains("dark") || document.body.classList.contains("dark-theme"));
      if ((mode === "dark" && !isDark) || (mode === "light" && isDark)) {
        const themeBtn = page.locator(".activity-bar-theme-toggle, button[data-tooltip*='主题'], button[aria-label*='主题']").first();
        if (await themeBtn.isVisible()) {
          await themeBtn.click();
          await page.waitForTimeout(400);
        }
      }
    }

    // 01. Home / Direct Chat Empty State
    console.log("1. Capturing Home Empty State...");
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.waitForTimeout(800);
    await page.screenshot({ path: join(screenshotsDir, "01-home-empty-light.png"), fullPage: true });
    await toggleTheme("dark");
    await page.screenshot({ path: join(screenshotsDir, "01-home-empty-dark.png"), fullPage: true });
    await toggleTheme("light");

    // 02. Team & Settings Page (/team)
    console.log("2. Capturing Team & Settings Overview...");
    await page.goto(`${baseUrl}/team`, { waitUntil: "networkidle" });
    await page.waitForTimeout(800);
    await page.screenshot({ path: join(screenshotsDir, "02-team-overview-light.png"), fullPage: true });
    await toggleTheme("dark");
    await page.screenshot({ path: join(screenshotsDir, "02-team-overview-dark.png"), fullPage: true });
    await toggleTheme("light");

    // Setup Provider
    console.log("Setting up Provider on /team...");
    const providerTab = page.getByRole("tab", { name: /模型服务|Provider/i }).or(page.getByRole("link", { name: /模型服务|Provider/i }));
    if (await providerTab.isVisible()) {
      await providerTab.click();
      await page.waitForTimeout(400);
      const createProvBtn = page.getByRole("button", { name: /创建模型服务|添加服务/i });
      if (await createProvBtn.isVisible()) {
        await createProvBtn.click();
        await page.waitForTimeout(300);
        await page.getByLabel(/服务名称/i).fill("OpenAI Local Compatible");
        await page.getByLabel(/Base URL/i).fill(mockProviderUrl);
        await page.getByLabel(/默认模型/i).fill("gpt-5.3-codex");
        await page.getByLabel(/API key/i).fill(mockApiKey);
        const allowHttp = page.getByRole("checkbox", { name: /HTTP 会明文传输凭据/i });
        if (await allowHttp.isVisible()) await allowHttp.check();
        const verifyBtn = page.getByRole("button", { name: /验证连接/i });
        if (await verifyBtn.isVisible()) await verifyBtn.click();
        await page.waitForTimeout(500);
        const saveProvBtn = page.getByRole("button", { name: /保存服务/i });
        if (await saveProvBtn.isVisible()) await saveProvBtn.click();
        await page.waitForTimeout(500);
      }
      await page.screenshot({ path: join(screenshotsDir, "02-team-providers-light.png"), fullPage: true });
    }

    // Capture Skills tab
    const skillTab = page.getByRole("tab", { name: /技能库|Skills/i }).or(page.getByRole("link", { name: /技能库|Skills/i }));
    if (await skillTab.isVisible()) {
      await skillTab.click();
      await page.waitForTimeout(500);
      await page.screenshot({ path: join(screenshotsDir, "02-team-skills-light.png"), fullPage: true });
    }

    // 03. Open Project Folder & Thread Creation
    console.log("3. Opening workspace and creating active thread...");
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: /打开文件夹/i }).first().click();
    await page.waitForTimeout(2000);

    // New Thread Modal
    const newThreadBtn = page.getByRole("button", { name: /创建新对话|新对话/i }).first();
    if (await newThreadBtn.isVisible()) {
      await newThreadBtn.click();
      await page.waitForTimeout(500);
      
      const dialog = page.getByRole("dialog");
      if (await dialog.isVisible()) {
        await page.screenshot({ path: join(screenshotsDir, "03-new-thread-modal-light.png") });
        const titleInput = dialog.locator("input#thread-title-input, input[placeholder*='发布计划评审']").first();
        if (await titleInput.isVisible()) {
          await titleInput.fill("用户鉴权与会话治理重构");
        }
        const checkboxes = dialog.locator("input[type='checkbox']");
        const count = await checkboxes.count();
        for (let i = 0; i < Math.min(count, 3); i++) {
          await checkboxes.nth(i).check();
        }
        await dialog.getByRole("button", { name: "创建对话", exact: true }).click();
        await dialog.waitFor({ state: "detached" });
        await page.waitForTimeout(1000);
      }
    }

    // Send messages in Composer to trigger rich proposal card
    console.log("4. Sending message to trigger conversation cards...");
    const composerInput = page.locator("textarea, [contenteditable='true']").first();
    if (await composerInput.isVisible()) {
      await composerInput.fill("@规划 请分析当前鉴权模块并给出重构方案");
      await page.waitForTimeout(300);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(3000);
    }

    // Active Project Chat View
    await page.screenshot({ path: join(screenshotsDir, "04-project-chat-active-light.png"), fullPage: true });
    await toggleTheme("dark");
    await page.screenshot({ path: join(screenshotsDir, "04-project-chat-active-dark.png"), fullPage: true });
    await toggleTheme("light");

    // 05. Populate Governance Data (Tasks, Memories, Approvals, Audit)
    console.log("5. Populating Governance data...");
    await page.evaluate(async () => {
      const projectId = window.location.pathname.split("/")[2];
      if (!projectId) return;

      // Create Mission
      const mRes = await fetch(`/api/projects/${projectId}/mission`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "用户鉴权与会话治理重构",
          goal: "建立本地优先、不可变的身份验证体系与安全策略",
          expectedVersion: 0,
          operationId: crypto.randomUUID(),
        }),
      });
      const mData = await mRes.json();
      const missionId = mData?.mission?.id;

      if (missionId) {
        // Create Work Items (Tasks)
        await fetch(`/api/projects/${projectId}/tasks`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            title: "T-01 验证策略与 Token 签名算法对齐",
            description: "实现基于 Ed25519 的自校验会话令牌并集成 SQLite 审计",
            status: "in_progress",
            expectedVersion: 1,
            operationId: crypto.randomUUID(),
          }),
        });

        await fetch(`/api/projects/${projectId}/tasks`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            title: "T-02 统一受控工作区文件写入隔离",
            description: "通过 Koffi Windows Native API 限制越界写入并记录 Stage Diff",
            status: "todo",
            expectedVersion: 1,
            operationId: crypto.randomUUID(),
          }),
        });

        await fetch(`/api/projects/${projectId}/tasks`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            title: "T-03 独立代码复核与交付流水线",
            description: "由复核 Agent 进行独立安全与架构契约裁决",
            status: "done",
            expectedVersion: 1,
            operationId: crypto.randomUUID(),
          }),
        });
      }

      // Create Memories
      await fetch(`/api/projects/${projectId}/memories`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "架构决策：无状态会话与零凭据日志",
          content: "所有 Outbox 审计日志脱敏处理，凭据必须经由 Master Key AES-256-GCM 隔离存储。",
          category: "architecture",
          expectedVersion: 0,
          operationId: crypto.randomUUID(),
        }),
      });

      await fetch(`/api/projects/${projectId}/memories`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "规范：Phosphor 图标族与 WCAG AA 对比度",
          content: "所有控件高度 >=44px，正文文字与背景对比度 >=4.5:1，严禁用 Emoji 作为结构图标。",
          category: "design_system",
          expectedVersion: 0,
          operationId: crypto.randomUUID(),
        }),
      });
    });

    await page.waitForTimeout(1000);

    // 06. Tasks View
    console.log("6. Capturing Tasks Board...");
    await page.locator("button[data-tooltip*='任务'], button[aria-label*='任务']").first().click();
    await page.waitForTimeout(1000);
    await page.screenshot({ path: join(screenshotsDir, "05-tasks-board-light.png"), fullPage: true });
    await toggleTheme("dark");
    await page.screenshot({ path: join(screenshotsDir, "05-tasks-board-dark.png"), fullPage: true });
    await toggleTheme("light");

    // 07. Memories View
    console.log("7. Capturing Memories View...");
    await page.locator("button[data-tooltip*='记忆'], button[aria-label*='记忆']").first().click();
    await page.waitForTimeout(1000);
    await page.screenshot({ path: join(screenshotsDir, "06-memories-view-light.png"), fullPage: true });
    await toggleTheme("dark");
    await page.screenshot({ path: join(screenshotsDir, "06-memories-view-dark.png"), fullPage: true });
    await toggleTheme("light");

    // 08. Approvals View
    console.log("8. Capturing Approvals View...");
    await page.locator("button[data-tooltip*='审批'], button[aria-label*='审批']").first().click();
    await page.waitForTimeout(1000);
    await page.screenshot({ path: join(screenshotsDir, "07-approvals-view-light.png"), fullPage: true });
    await toggleTheme("dark");
    await page.screenshot({ path: join(screenshotsDir, "07-approvals-view-dark.png"), fullPage: true });
    await toggleTheme("light");

    // 09. Audit View
    console.log("9. Capturing Audit View...");
    await page.locator("button[data-tooltip*='审计'], button[aria-label*='审计']").first().click();
    await page.waitForTimeout(1000);
    await page.screenshot({ path: join(screenshotsDir, "08-audit-view-light.png"), fullPage: true });
    await toggleTheme("dark");
    await page.screenshot({ path: join(screenshotsDir, "08-audit-view-dark.png"), fullPage: true });
    await toggleTheme("light");

    // 10. Mobile Responsive View
    console.log("10. Capturing Mobile View...");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.waitForTimeout(800);
    await page.screenshot({ path: join(screenshotsDir, "09-mobile-home-light.png"), fullPage: true });
    await toggleTheme("dark");
    await page.screenshot({ path: join(screenshotsDir, "09-mobile-home-dark.png"), fullPage: true });

    await browser.close();
    console.log("All detailed views captured successfully in visual-audit-detailed!");
  } finally {
    stopServer();
  }
}

run().catch((err) => {
  console.error("Detailed visual audit failed:", err);
  stopServer();
  process.exit(1);
});
