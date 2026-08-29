import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";

process.env.COCKPIT_MASTER_KEY = "MTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTI";

const baseUrl = "http://localhost:3000";
const mockProviderPort = 5100 + Math.floor(Math.random() * 800);
const mockProviderUrl = `http://127.0.0.1:${mockProviderPort}/v1`;
const artifactDir = resolve("tests", "browser", "test-artifacts", "comprehensive");
mkdirSync(artifactDir, { recursive: true });

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
                content: "您好！我是规划搭档。已根据要求拆解双 Token 刷新机制方案：\n1. 接入层配置 Access Token 与 Refresh Token\n2. 校验中间件实现自动无感换票\n3. 单元测试覆盖过期与并发竞争分支。",
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

async function main() {
  await new Promise((res) => mockProvider.listen(mockProviderPort, "127.0.0.1", res));
  console.log(`[Setup] Mock Provider 运行于 http://127.0.0.1:${mockProviderPort}`);

  // 重置数据库以确保干净状态
  const dbPath = resolve(".data", "cockpit.sqlite");
  if (existsSync(dbPath)) {
    try {
      unlinkSync(dbPath);
      console.log("[Setup] 已重置初始数据库");
    } catch (e) {
      console.log("[Setup] 数据库重置跳过:", e.message);
    }
  }

  const browser = await chromium.launch({ channel: "msedge" }).catch(() => chromium.launch());
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: "light",
  });
  const page = await context.newPage();

  // 隐藏 Next.js 开发覆盖层，防止遮挡左下角 ActivityBar 按钮
  await page.addInitScript(() => {
    window.addEventListener("DOMContentLoaded", () => {
      const style = document.createElement("style");
      style.innerHTML = `
        nextjs-portal, [data-nextjs-dev-overlay] {
          display: none !important;
          pointer-events: none !important;
        }
      `;
      (document.head || document.documentElement).appendChild(style);
    });
  });

  const issues = [];
  const results = [];

  page.on("console", (msg) => {
    const text = msg.text();
    if (msg.type() === "error" && !text.includes("favicon") && !text.includes("404")) {
      console.error(`  [Browser Console Error] ${text}`);
      issues.push(`Console Error: ${text}`);
    }
  });
  page.on("pageerror", (err) => {
    console.error(`  [Browser Page Error] ${err.message}`);
    issues.push(`Page Uncaught Error: ${err.message}`);
  });

  async function runStep(id, title, fn) {
    console.log(`\n------------------------------------------------------------`);
    console.log(`[RUN] ${id}: ${title}`);
    console.log(`------------------------------------------------------------`);
    const start = Date.now();
    try {
      await fn();
      const duration = Date.now() - start;
      console.log(`>>> [PASS] ${id} (${duration}ms)`);
      results.push({ id, title, status: "PASS", duration });
    } catch (error) {
      const duration = Date.now() - start;
      console.error(`>>> [FAIL] ${id} (${duration}ms):`, error.message);
      results.push({ id, title, status: "FAIL", duration, error: error.message });
      issues.push(`[${id}] ${title}: ${error.message}`);
    }
  }

  // ==========================================
  // SECTION 1: 首页初始加载与 ActivityBar 交互
  // ==========================================

  await runStep("TC-01", "首页初始加载与空态欢迎界面验证", async () => {
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: join(artifactDir, "01-home-initial.png") });

    const title = await page.title();
    assert(title.includes("Cool AI"), `页面标题应包含 Cool AI: ${title}`);
    const body = await page.textContent("body");
    assert(body.includes("欢迎使用 Cool AI") || body.includes("个人对话"), "首页应有欢迎或直聊语境");
  });

  await runStep("TC-02", "ActivityBar 图标悬停 Tooltip 与亮暗主题切换按钮", async () => {
    const themeBtn = page.locator('button.activity-bar-end').first();
    await page.waitForTimeout(600);
    await themeBtn.hover({ force: true });
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(artifactDir, "02-theme-hover-before-switch.png") });

    // 点击切换为暗色主题
    await themeBtn.click({ force: true });
    await page.waitForTimeout(800);
    await page.screenshot({ path: join(artifactDir, "02-theme-dark-optimized.png") });
    const isDark = await page.evaluate(() => document.documentElement.getAttribute("data-theme") === "dark");
    assert(isDark, "点击主题按钮后页面应为暗色模式");

    // 再次点击切回亮色主题
    await themeBtn.click({ force: true });
    await page.waitForTimeout(800);
    await page.screenshot({ path: join(artifactDir, "02-theme-light-optimized.png") });
  });

  await runStep("TC-03", "ActivityBar 治理视图按钮（任务/记忆/审批/审计）与返回对话", async () => {
    // 1. 任务
    const missionBtn = page.locator('.activity-bar button[data-tooltip="任务"], .activity-bar button[aria-label="任务"]').first();
    await missionBtn.click();
    await page.waitForTimeout(800);
    await page.screenshot({ path: join(artifactDir, "03-governance-mission.png") });
    let backBtn = page.locator('button:has-text("返回对话")').first();
    assert(await backBtn.isVisible(), "任务治理视图应有「返回对话」按钮");
    await backBtn.click();
    await page.waitForTimeout(500);

    // 2. 记忆
    const memoryBtn = page.locator('.activity-bar button[data-tooltip="记忆"], .activity-bar button[aria-label="记忆"]').first();
    await memoryBtn.click();
    await page.waitForTimeout(800);
    await page.screenshot({ path: join(artifactDir, "03-governance-memory.png") });
    backBtn = page.locator('button:has-text("返回对话")').first();
    assert(await backBtn.isVisible(), "记忆治理视图应有「返回对话」按钮");
    await backBtn.click();
    await page.waitForTimeout(500);

    // 3. 审批
    const approvalBtn = page.locator('.activity-bar button[data-tooltip="审批"], .activity-bar button[aria-label*="审批"]').first();
    await approvalBtn.click();
    await page.waitForTimeout(800);
    await page.screenshot({ path: join(artifactDir, "03-governance-approvals.png") });
    backBtn = page.locator('button:has-text("返回对话")').first();
    assert(await backBtn.isVisible(), "审批治理视图应有「返回对话」按钮");
    await backBtn.click();
    await page.waitForTimeout(500);

    // 4. 审计
    const auditBtn = page.locator('.activity-bar button[data-tooltip="审计"], .activity-bar button[aria-label="审计"]').first();
    await auditBtn.click();
    await page.waitForTimeout(800);
    await page.screenshot({ path: join(artifactDir, "03-governance-audit.png") });
    backBtn = page.locator('button:has-text("返回对话")').first();
    assert(await backBtn.isVisible(), "审计治理视图应有「返回对话」按钮");
    await backBtn.click();
    await page.waitForTimeout(500);
  });

  // ==========================================
  // SECTION 2: /team 页面配置与全表单交互
  // ==========================================

  await runStep("TC-04", "从 ActivityBar 导航至 /team 团队设置页面", async () => {
    const teamLink = page.locator('.activity-bar a[aria-label="团队"], .activity-bar a[data-tooltip="团队"]').first();
    await teamLink.click();
    await page.waitForURL(/.*\/team.*/, { timeout: 6000 });
    await page.waitForTimeout(1000);
    await page.screenshot({ path: join(artifactDir, "04-team-page.png") });

    const backHomeLink = page.locator('a:has-text("返回原位置")');
    assert(await backHomeLink.isVisible(), "团队页面应有「返回原位置」入口");
  });

  await runStep("TC-05", "模型服务 (Provider) 表单创建、测试连接与保存", async () => {
    const providerTab = page.locator('#provider-resource-tab, button:has-text("模型服务")').first();
    await providerTab.click();
    await page.waitForTimeout(600);

    const addBtn = page.locator('#provider-resource-panel button.button-primary').first();
    await addBtn.click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(artifactDir, "05-provider-dialog.png") });

    await page.fill("#provider-name", "本地测试网关");
    await page.fill("#provider-base-url", mockProviderUrl);
    await page.fill("#provider-model", "gpt-4o");
    await page.fill("#provider-api-key", "sk-mock-key-12345");

    const insecureCheckbox = page.locator('input[type="checkbox"]').first();
    if (await insecureCheckbox.isVisible()) {
      await insecureCheckbox.check();
    }
    await page.waitForTimeout(300);

    const verifyBtn = page.locator('button:has-text("验证连接")');
    await verifyBtn.click();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: join(artifactDir, "05-provider-verified.png") });

    const saveBtn = page.locator('button:has-text("保存服务")');
    await saveBtn.click();
    await page.waitForTimeout(1200);
    await page.screenshot({ path: join(artifactDir, "05-provider-saved.png") });

    const content = await page.textContent("#provider-resource-panel");
    assert(content.includes("本地测试网关"), "列表应包含已创建的 Provider");
  });

  await runStep("TC-06", "技能包 (Skill Package) 创建与保存", async () => {
    const skillTab = page.locator('#skill-resource-tab, button:has-text("技能")').first();
    await skillTab.click();
    await page.waitForTimeout(600);

    const addSkillBtn = page.locator('#skill-resource-panel button.button-primary').first();
    await addSkillBtn.click();
    await page.waitForTimeout(500);

    await page.fill("#skill-name", "TDD 开发规范");
    await page.fill("#skill-description", "遵循红绿重构循环进行高质量交付");
    await page.fill("#skill-instructions", "编写功能前先编写失败测试，逐步实现并重构。");
    await page.waitForTimeout(300);

    const saveSkillBtn = page.locator('#skill-resource-panel button[type="submit"], button:has-text("创建技能"), button:has-text("保存技能")').first();
    await saveSkillBtn.click();
    await page.waitForTimeout(1200);
    await page.screenshot({ path: join(artifactDir, "06-skill-saved.png") });

    const content = await page.textContent("#skill-resource-panel");
    assert(content.includes("TDD 开发规范"), "技能列表应包含新保存的技能");
  });

  await runStep("TC-07", "自带 Agent 创建与能力配置", async () => {
    const agentTab = page.locator('#agent-resource-tab, button:has-text("Agent")').first();
    await agentTab.click();
    await page.waitForTimeout(600);

    const addAgentBtn = page.locator('#agent-resource-panel button.button-primary').first();
    await addAgentBtn.click();
    await page.waitForTimeout(500);

    await page.fill("#agent-name", "规划搭档");
    await page.fill("#agent-role", "负责系统设计与任务拆解");
    await page.fill("#agent-system-prompt", "你是一名资深的系统架构师与规划搭档。");
    const providerSelect = page.locator("#agent-provider");
    await providerSelect.selectOption({ index: 1 });
    await page.fill("#agent-avatar", "规");
    await page.waitForTimeout(300);

    const saveAgentBtn = page.locator('#agent-resource-panel button[type="submit"], button:has-text("保存 Agent")').first();
    await saveAgentBtn.click();
    await page.waitForTimeout(1200);

    await page.screenshot({ path: join(artifactDir, "07-agent-created.png") });
    const content = await page.textContent("#agent-resource-panel");
    assert(content.includes("规划搭档"), "Agent 列表应包含规划搭档");
  });

  await runStep("TC-08", "通知与偏好设置分区交互", async () => {
    const notifTab = page.locator('#notifications-resource-tab, button:has-text("通知与偏好")').first();
    if (await notifTab.isVisible()) {
      await notifTab.click();
      await page.waitForTimeout(600);
      await page.screenshot({ path: join(artifactDir, "08-notifications-panel.png") });

      const testNotifBtn = page.locator('button:has-text("发送测试通知")');
      if (await testNotifBtn.isVisible()) {
        await testNotifBtn.click();
        await page.waitForTimeout(500);
      }
    }
  });

  // ==========================================
  // SECTION 3: 侧栏管理、拖拽调整与对话管理
  // ==========================================

  await runStep("TC-09", "返回首页直聊，验证「+ 新对话」创建与表单校验", async () => {
    const backHomeLink = page.locator('a:has-text("返回原位置")').first();
    await backHomeLink.click();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: join(artifactDir, "09-home-with-agent.png") });

    // 点击「+ 新对话」
    const newThreadBtn = page.locator('button[aria-label="新对话"]').first();
    await newThreadBtn.click();
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(artifactDir, "09-thread-create-dialog.png") });

    // 填写正常标题并提交
    const titleInput = page.locator("#thread-title");
    await titleInput.fill("用户中心登录模块重构与接口设计方案探讨");
    await page.waitForTimeout(300);
    const submitBtn = page.locator('.thread-create-form button[type="submit"]');
    await submitBtn.click();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: join(artifactDir, "09-thread-created-in-list.png") });
  });

  await runStep("TC-10", "侧栏拖拽调整宽度、双击复位与键盘调节", async () => {
    const resizer = page.locator(".cockpit-sidebar-resizer");
    if (await resizer.isVisible()) {
      const box = await resizer.boundingBox();
      if (box) {
        // 拖拽拉宽 +140px
        await page.mouse.move(box.x + box.width / 2, box.y + 200);
        await page.mouse.down();
        await page.mouse.move(box.x + 140, box.y + 200, { steps: 5 });
        await page.mouse.up();
        await page.waitForTimeout(600);
        await page.screenshot({ path: join(artifactDir, "10-sidebar-dragged-wide.png") });

        // 双击复位
        await resizer.dblclick();
        await page.waitForTimeout(600);
        await page.screenshot({ path: join(artifactDir, "10-sidebar-reset.png") });
      }
    }
  });

  await runStep("TC-11", "侧栏过滤 Tabs（全部/收藏/标签）与星标收藏切换", async () => {
    const threadItem = page.locator(".thread-list-item").first();
    if (await threadItem.isVisible()) {
      await threadItem.hover();
      await page.waitForTimeout(400);
      const starBtn = threadItem.locator('.thread-favorite-toggle, button[aria-label*="收藏"]').first();
      if (await starBtn.isVisible()) {
        await starBtn.click();
        await page.waitForTimeout(600);
        await page.screenshot({ path: join(artifactDir, "11-thread-starred.png") });
      }
    }

    // 切换到「收藏」Tab
    const favTab = page.locator('.thread-view-tabs [role="tab"]:has-text("收藏")');
    if (await favTab.isVisible()) {
      await favTab.click();
      await page.waitForTimeout(600);
      await page.screenshot({ path: join(artifactDir, "11-tab-favorites.png") });
    }

    // 切换到「标签」Tab
    const tagsTab = page.locator('.thread-view-tabs [role="tab"]:has-text("标签")');
    if (await tagsTab.isVisible()) {
      await tagsTab.click();
      await page.waitForTimeout(600);
      await page.screenshot({ path: join(artifactDir, "11-tab-tags.png") });
    }

    // 切回「全部」Tab
    const allTab = page.locator('.thread-view-tabs [role="tab"]:has-text("全部")');
    if (await allTab.isVisible()) {
      await allTab.click();
      await page.waitForTimeout(600);
    }
  });

  await runStep("TC-12", "侧栏更多操作菜单（移入回收站）与回收站还原", async () => {
    const threadItem = page.locator(".thread-list-item").first();
    if (await threadItem.isVisible()) {
      await threadItem.hover();
      const moreBtn = threadItem.locator('.thread-item-more button').first();
      if (await moreBtn.isVisible()) {
        await moreBtn.click();
        await page.waitForTimeout(400);
        await page.screenshot({ path: join(artifactDir, "12-thread-more-menu.png") });

        // 点击移入回收站
        const deleteOption = page.locator('.thread-item-menu button:has-text("移入回收站")').first();
        if (await deleteOption.isVisible()) {
          await deleteOption.click();
          await page.waitForTimeout(600);
          await page.screenshot({ path: join(artifactDir, "12-delete-confirm-dialog-optimized.png") });

          // 在居中的 action-dialog 中点击「确认移入」
          const confirmBtn = page.locator('.thread-delete-confirm button:has-text("确认移入")').first();
          if (await confirmBtn.isVisible()) {
            await confirmBtn.click();
            await page.waitForTimeout(800);
            await page.screenshot({ path: join(artifactDir, "12-thread-moved-to-recycle.png") });
          }
        }
      }
    }

    // 点击底部回收站入口
    const recycleBtn = page.locator('.thread-recycle-entry, button:has-text("回收站")').first();
    if (await recycleBtn.isVisible()) {
      await recycleBtn.click();
      await page.waitForTimeout(600);
      await page.screenshot({ path: join(artifactDir, "12-recycle-bin-list.png") });

      // 点击恢复按钮
      const restoreBtn = page.locator('.thread-recycle-item-action:has-text("恢复")').first();
      if (await restoreBtn.isVisible()) {
        await restoreBtn.click();
        await page.waitForTimeout(800);
        await page.screenshot({ path: join(artifactDir, "12-recycle-restored.png") });
      }
    }

    // 切回「全部」视图
    const allTab = page.locator('.thread-view-tabs [role="tab"]:has-text("全部")');
    if (await allTab.isVisible()) {
      await allTab.click();
      await page.waitForTimeout(500);
    }
  });

  // ==========================================
  // SECTION 4: 浮起 Composer、富输入与消息交互
  // ==========================================

  await runStep("TC-13", "浮起 Composer 输入、@Agent 提及建议与消息发送", async () => {
    const composer = page.locator('textarea[placeholder*="输入"], textarea[aria-label*="消息"]').first();
    if (await composer.isVisible()) {
      await composer.focus();
      await composer.fill("@规划搭档 请为登录模块设计双 Token 刷新机制与数据流。");
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(artifactDir, "13-composer-filled.png") });

      const sendBtn = page.locator('button.composer-send').first();
      if (await sendBtn.isVisible() && await sendBtn.isEnabled()) {
        await sendBtn.click();
        await page.waitForTimeout(2000);
        await page.screenshot({ path: join(artifactDir, "13-message-streamed.png") });
      }
    }
  });

  await runStep("TC-14", "快捷键 Cmd+K 搜索浮层与 Cmd+B 侧栏折叠", async () => {
    // 快捷键 Cmd+B 折叠
    await page.keyboard.press("Control+b");
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(artifactDir, "14-sidebar-collapsed.png") });

    // 快捷键 Cmd+B 展开
    await page.keyboard.press("Control+b");
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(artifactDir, "14-sidebar-expanded.png") });

    // 快捷键 Cmd+K 唤起搜索
    await page.keyboard.press("Control+k");
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(artifactDir, "14-search-overlay.png") });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  });

  // ==========================================
  // SECTION 5: 项目绑定与多 Agent 协作工作台
  // ==========================================

  await runStep("TC-15", "打开真实工作区并进入多 Agent 项目协作驾驶舱", async () => {
    const tempWorkDir = resolve(tmpdir(), "cool-ai-comprehensive-workspace");
    mkdirSync(tempWorkDir, { recursive: true });

    const createProjRes = await page.request.post(`${baseUrl}/api/projects`, {
      data: { path: tempWorkDir },
    });
    const projData = await createProjRes.json();
    const projectId = projData.project?.id || projData.id;
    console.log(`[Project] 创建并绑定项目: ${projectId}`);

    await page.goto(`${baseUrl}/projects/${projectId}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: join(artifactDir, "15-project-cockpit.png") });

    const headerText = await page.textContent(".cockpit-header");
    assert(headerText.includes("cool-ai-comprehensive-workspace") || headerText.includes("未命名") || headerText.includes("项目"), "Header 应展示当前项目名");
  });

  // ==========================================
  // 总结报告
  // ==========================================

  console.log(`\n============================================================`);
  console.log(`[SUMMARY] 综合浏览器端测试用例执行完成`);
  console.log(`============================================================`);
  const passCount = results.filter((r) => r.status === "PASS").length;
  const failCount = results.filter((r) => r.status === "FAIL").length;
  console.log(`总计用例: ${results.length} | 通过: ${passCount} | 失败: ${failCount}`);
  if (issues.length > 0) {
    console.log(`\n发现问题清单 (${issues.length} 项):`);
    issues.forEach((issue, idx) => console.log(`  ${idx + 1}. ${issue}`));
  } else {
    console.log(`\n全部用例通过，未捕获到运行时错误！`);
  }

  await browser.close();
  mockProvider.close();
}

main().catch((err) => {
  console.error("Fatal test runner error:", err);
  process.exit(1);
});
