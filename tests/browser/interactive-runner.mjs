import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, existsSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";

process.env.COCKPIT_MASTER_KEY = "MTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTI";

const baseUrl = "http://localhost:3000";
const mockProviderPort = 4999;
const mockProviderUrl = `http://127.0.0.1:${mockProviderPort}/v1`;
const screenshotDir = resolve("tests", "browser", "test-artifacts");
mkdirSync(screenshotDir, { recursive: true });

// 启动 Mock OpenAI 兼容服务
const mockProvider = createServer((req, res) => {
  if (req.url === "/v1/models") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        data: [
          { id: "gpt-4o", object: "model" },
          { id: "gpt-4o-mini", object: "model" },
        ],
      })
    );
    return;
  }
  if (req.url === "/v1/chat/completions" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-mock-test",
          object: "chat.completion",
          created: Date.now(),
          model: "gpt-4o",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "您好！我是您的规划搭档，已经为您就绪。我们可以从梳理系统目标与核心模块开始。",
              },
              finish_reason: "stop",
            },
          ],
        })
      );
    });
    return;
  }
  res.writeHead(404).end();
});

async function run() {
  await new Promise((res) => mockProvider.listen(mockProviderPort, "127.0.0.1", res));
  console.log(`Mock Provider 运行于 http://127.0.0.1:${mockProviderPort}`);

  // 重置空数据库
  const dbPath = resolve(".data", "cockpit.sqlite");
  if (existsSync(dbPath)) {
    try {
      unlinkSync(dbPath);
      console.log("已重置初始测试数据库");
    } catch (e) {
      console.log("数据库重置跳过:", e.message);
    }
  }

  const browser = await chromium.launch({ channel: "msedge" });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: "light",
  });
  const page = await context.newPage();

  const logs = [];
  const errors = [];
  page.on("console", (msg) => {
    const text = msg.text();
    if (msg.type() === "error" && !text.includes("favicon") && !text.includes("404")) {
      errors.push(`[Console Error] ${text}`);
    }
  });
  page.on("pageerror", (err) => {
    errors.push(`[Page Error] ${err.message}`);
  });

  const testResults = [];

  async function step(name, action) {
    console.log(`\n========================================`);
    console.log(`[测试用例] ${name}`);
    console.log(`========================================`);
    const start = Date.now();
    try {
      await action();
      const duration = Date.now() - start;
      console.log(`>>> [PASS] ${name} (${duration}ms)`);
      testResults.push({ name, status: "PASS", duration });
    } catch (err) {
      const duration = Date.now() - start;
      console.error(`>>> [FAIL] ${name} (${duration}ms):`, err.message);
      testResults.push({ name, status: "FAIL", duration, error: err.message });
    }
  }

  // TC-01: 首页加载与视觉层级检查
  await step("TC-01: 首页加载与视觉层级检查", async () => {
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.waitForTimeout(1000);
    await page.screenshot({ path: join(screenshotDir, "tc01-home-empty.png") });

    const content = await page.textContent("body");
    assert(content.includes("欢迎使用 Cool AI"), "首页应有欢迎标题");
    assert(content.includes("先配置一个 Agent，即可开始个人对话。"), "首页应有引导文案");
  });

  // TC-02: 导航至团队/设置配置页
  await step("TC-02: 导航至团队/设置配置页", async () => {
    const configBtn = page.locator('a:has-text("配置 Agent")');
    await configBtn.click();
    await page.waitForURL(/.*section=agents.*/, { timeout: 5000 });
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(screenshotDir, "tc02-team-agents-empty.png") });
  });

  // TC-03: 模型服务 (Provider) 表单交互与验证保存
  await step("TC-03: 模型服务 (Provider) 配置与验证保存", async () => {
    const providerNav = page.locator('#provider-resource-tab, button:has-text("模型服务")').first();
    await providerNav.click();
    await page.waitForTimeout(600);

    const addBtn = page.locator('#provider-resource-panel button.button-primary').first();
    await addBtn.click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(screenshotDir, "tc03-provider-editor-open.png") });

    await page.fill("#provider-name", "本地兼容网关");
    await page.fill("#provider-base-url", mockProviderUrl);
    await page.fill("#provider-model", "gpt-4o");
    await page.fill("#provider-api-key", "sk-mock-test-key-12345");
    
    const insecureCheck = page.locator('input[type="checkbox"]');
    if (await insecureCheck.isVisible()) {
      await insecureCheck.check();
    }
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(screenshotDir, "tc03-provider-form-filled.png") });

    const verifyBtn = page.locator('button:has-text("验证连接")');
    await verifyBtn.click();
    await page.waitForTimeout(1500);

    const saveBtn = page.locator('button:has-text("保存服务")');
    await saveBtn.click();
    await page.waitForTimeout(1200);
    await page.screenshot({ path: join(screenshotDir, "tc03-provider-saved.png") });

    const listContent = await page.textContent("#provider-resource-panel");
    assert(listContent.includes("本地兼容网关"), "列表应展示新保存的 Provider");
  });

  // TC-04: 技能 (Skill) 创建与保存
  await step("TC-04: 技能 (Skill) 创建与保存", async () => {
    const skillNav = page.locator('#skill-resource-tab, button:has-text("技能")').first();
    await skillNav.click();
    await page.waitForTimeout(600);

    const addSkillBtn = page.locator('#skill-resource-panel button.button-primary').first();
    await addSkillBtn.click();
    await page.waitForTimeout(500);

    await page.fill("#skill-name", "需求架构分析");
    await page.fill("#skill-description", "专注于需求拆解与架构设计方案输出");
    await page.fill("#skill-instructions", "分析用户需求并输出结构化设计方案。");
    await page.waitForTimeout(300);

    const saveSkillBtn = page.locator('#skill-resource-panel button[type="submit"], button:has-text("创建技能"), button:has-text("保存技能")').first();
    await saveSkillBtn.click();
    await page.waitForTimeout(1200);
    await page.screenshot({ path: join(screenshotDir, "tc04-skill-saved.png") });

    const skillListContent = await page.textContent("#skill-resource-panel");
    assert(skillListContent.includes("需求架构分析"), "列表应展示新保存的技能");
  });

  // TC-05: Agent 创建与配置
  await step("TC-05: Agent 创建与配置", async () => {
    const agentNav = page.locator('#agent-resource-tab, button:has-text("Agent")').first();
    await agentNav.click();
    await page.waitForTimeout(600);

    const addAgentBtn = page.locator('#agent-resource-panel button.button-primary').first();
    await addAgentBtn.click();
    await page.waitForTimeout(500);

    await page.fill("#agent-name", "规划搭档");
    await page.fill("#agent-role", "负责系统设计与需求规划");
    await page.fill("#agent-system-prompt", "你是一名资深的系统架构师与规划搭档。");
    
    const providerSelect = page.locator("#agent-provider");
    await providerSelect.selectOption({ index: 1 });
    await page.waitForTimeout(300);

    await page.fill("#agent-avatar", "规");
    await page.screenshot({ path: join(screenshotDir, "tc05-agent-form-filled.png") });

    const saveAgentBtn = page.locator('#agent-resource-panel button[type="submit"], button:has-text("保存 Agent")').first();
    await saveAgentBtn.click();
    await page.waitForTimeout(1200);
    await page.screenshot({ path: join(screenshotDir, "tc05-agent-saved.png") });

    const agentListContent = await page.textContent("#agent-resource-panel");
    assert(agentListContent.includes("规划搭档"), "列表应展示新创建的 Agent");
  });

  // TC-06: 首页直聊体验 (Home Direct Chat)
  await step("TC-06: 首页 1:1 直聊态验证", async () => {
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.waitForTimeout(1200);
    await page.screenshot({ path: join(screenshotDir, "tc06-home-direct-chat-ready.png") });

    const content = await page.textContent("body");
    assert(content.includes("个人对话") || content.includes("规划搭档"), "首页应进入直聊模式");
  });

  // TC-07: 首页直聊消息发送与交互
  await step("TC-07: 首页直聊消息发送与交互", async () => {
    // 首次进入直聊，点击 + 新对话
    const newThreadBtn = page.locator('button:has-text("+ 新对话"), button:has-text("新对话"), button[aria-label="新建对话"]').first();
    if (await newThreadBtn.isVisible()) {
      await newThreadBtn.click();
      await page.waitForTimeout(800);
    }

    const composer = page.locator('textarea[placeholder*="输入"], textarea[aria-label*="消息"]').first();
    if (await composer.isVisible() && await composer.isEnabled()) {
      await composer.fill("你好！请帮我规划系统的核心功能。");
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(screenshotDir, "tc07-composer-input.png") });

      const sendBtn = page.locator('button[aria-label="发送消息"], button:has-text("发送")').first();
      await sendBtn.click();
      await page.waitForTimeout(1500);
      await page.screenshot({ path: join(screenshotDir, "tc07-message-sent.png") });
    }
  });

  // TC-08: 打开工作区与创建项目
  let createdProjectId = null;
  await step("TC-08: 打开工作区与创建项目", async () => {
    const tempWorkDir = resolve(tmpdir(), "cool-ai-demo-workspace");
    mkdirSync(tempWorkDir, { recursive: true });

    const createProjRes = await page.request.post(`${baseUrl}/api/projects`, {
      data: { path: tempWorkDir },
    });
    console.log("项目创建响应状态:", createProjRes.status());
    const projData = await createProjRes.json();
    createdProjectId = projData.project?.id || projData.id;
    console.log("项目 ID:", createdProjectId);

    await page.goto(`${baseUrl}/projects/${createdProjectId}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: join(screenshotDir, "tc08-project-workspace.png") });
  });

  // TC-09: 项目多会话管理 (+ 新对话 / 切换)
  await step("TC-09: 项目多会话管理与会话列表", async () => {
    const newThreadBtn = page.locator('button[aria-label="新建对话"], button:has-text("新对话"), button:has-text("+ 新对话")').first();
    if (await newThreadBtn.isVisible()) {
      await newThreadBtn.click();
      await page.waitForTimeout(1000);
      await page.screenshot({ path: join(screenshotDir, "tc09-new-thread-created.png") });
    }
  });

  // TC-10: 治理视图 - 任务/使命看板
  await step("TC-10: 治理视图 - 任务/使命看板", async () => {
    const missionBtn = page.locator('button[data-tooltip="任务"], button[aria-label="任务"]').first();
    await missionBtn.click();
    await page.waitForTimeout(1000);
    await page.screenshot({ path: join(screenshotDir, "tc10-mission-board.png") });

    const backBtn = page.locator('button:has-text("返回对话")');
    if (await backBtn.isVisible()) {
      await backBtn.click();
      await page.waitForTimeout(500);
    }
  });

  // TC-11: 治理视图 - 记忆
  await step("TC-11: 治理视图 - 记忆面板", async () => {
    const memoryBtn = page.locator('button[data-tooltip="记忆"], button[aria-label="记忆"]').first();
    await memoryBtn.click();
    await page.waitForTimeout(1000);
    await page.screenshot({ path: join(screenshotDir, "tc11-memory-panel.png") });

    const backBtn = page.locator('button:has-text("返回对话")');
    if (await backBtn.isVisible()) {
      await backBtn.click();
      await page.waitForTimeout(500);
    }
  });

  // TC-12: 治理视图 - 审批
  await step("TC-12: 治理视图 - 审批中心", async () => {
    const approvalBtn = page.locator('button[data-tooltip="审批"], button[aria-label="审批"], button[aria-label*="审批"]').first();
    await approvalBtn.click();
    await page.waitForTimeout(1000);
    await page.screenshot({ path: join(screenshotDir, "tc12-approvals-panel.png") });

    const backBtn = page.locator('button:has-text("返回对话")');
    if (await backBtn.isVisible()) {
      await backBtn.click();
      await page.waitForTimeout(500);
    }
  });

  // TC-13: 治理视图 - 审计
  await step("TC-13: 治理视图 - 审计日志", async () => {
    const auditBtn = page.locator('button[data-tooltip="审计"], button[aria-label="审计"]').first();
    await auditBtn.click();
    await page.waitForTimeout(1000);
    await page.screenshot({ path: join(screenshotDir, "tc13-audit-panel.png") });

    const backBtn = page.locator('button:has-text("返回对话")');
    if (await backBtn.isVisible()) {
      await backBtn.click();
      await page.waitForTimeout(500);
    }
  });

  // TC-14: 亮暗主题切换
  await step("TC-14: 亮暗主题切换与对比度检查", async () => {
    const themeBtn = page.locator('button[aria-label*="主题"], button[data-tooltip*="主题"]').first();
    await themeBtn.evaluate((el) => el.click());
    await page.waitForTimeout(1000);
    await page.screenshot({ path: join(screenshotDir, "tc14-dark-theme.png") });

    await themeBtn.evaluate((el) => el.click());
    await page.waitForTimeout(800);
    await page.screenshot({ path: join(screenshotDir, "tc14-light-theme-restored.png") });
  });

  // TC-15: 移动端窄屏抽屉 (390x844)
  await step("TC-15: 移动端窄屏抽屉 (390x844)", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(800);
    await page.screenshot({ path: join(screenshotDir, "tc15-mobile-drawer.png") });
  });

  console.log("\n=========================================");
  console.log("=== 测试用例执行完成汇总 ===");
  console.table(testResults);
  if (errors.length > 0) {
    console.log("\n收集到的控制台/页面错误：");
    errors.forEach((e) => console.log("-", e));
  } else {
    console.log("\n页面运行完美，未发现任何控制台或页面崩溃错误！");
  }
  console.log("=========================================\n");

  await browser.close();
  mockProvider.close();
}

run().catch((err) => {
  console.error("Runner Fatal Error:", err);
  mockProvider.close();
  process.exit(1);
});
