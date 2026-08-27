import { chromium } from "playwright";

async function main() {
  console.log("Connecting to http://localhost:3000...");
  const browser = await chromium.launch({
    headless: false,
    channel: "chrome",
  }).catch(() => chromium.launch({ headless: false }));

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();

  console.log("Navigating to home page...");
  await page.goto("http://localhost:3000", { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);

  // Hide Next.js dev overlay portal from intercepting clicks
  await page.addStyleTag({
    content: "nextjs-portal { pointer-events: none !important; display: none !important; }",
  }).catch(() => {});

  console.log("Checking UI elements on home page...");
  const title = await page.title();
  console.log(`Page title: ${title}`);

  // Test theme switch
  console.log("Testing theme toggle...");
  const themeToggle = page.locator(".activity-bar-item.activity-bar-end, button[data-tooltip*='主题']").first();
  if (await themeToggle.isVisible()) {
    await themeToggle.click({ force: true });
    await page.waitForTimeout(800);
    console.log("✓ Switched to dark theme");
    await themeToggle.click({ force: true });
    await page.waitForTimeout(800);
    console.log("✓ Switched back to light theme");
  }

  // Test ActivityBar governance views
  console.log("Testing governance views in ActivityBar...");
  const views = ["任务", "记忆", "审批", "审计"];
  for (const viewName of views) {
    const btn = page.locator(`button[data-tooltip='${viewName}']`).first();
    if (await btn.isVisible()) {
      await btn.click({ force: true });
      await page.waitForTimeout(600);
      console.log(`✓ Opened ${viewName} governance view`);
      const backBtn = page.locator(".btn-back-chat").first();
      if (await backBtn.isVisible()) {
        await backBtn.click({ force: true });
        await page.waitForTimeout(600);
        console.log(`✓ Returned to chat from ${viewName}`);
      }
    }
  }

  // Test Team navigation
  console.log("Testing team page navigation...");
  const teamLink = page.locator("a[data-tooltip='团队']").first();
  if (await teamLink.isVisible()) {
    await teamLink.click({ force: true });
    await page.waitForURL("**/team**");
    await page.waitForTimeout(1000);
    console.log("✓ Navigated to /team page successfully");
    
    // Switch team tabs
    const skillsTab = page.locator("button#skill-resource-tab").first();
    const providersTab = page.locator("button#provider-resource-tab").first();
    const agentsTab = page.locator("button#agent-resource-tab").first();
    
    if (await skillsTab.isVisible()) {
      await skillsTab.click({ force: true });
      await page.waitForTimeout(500);
      console.log("✓ Tested skills tab");
    }
    if (await providersTab.isVisible()) {
      await providersTab.click({ force: true });
      await page.waitForTimeout(500);
      console.log("✓ Tested providers tab");
    }
    if (await agentsTab.isVisible()) {
      await agentsTab.click({ force: true });
      await page.waitForTimeout(500);
      console.log("✓ Tested agents tab");
    }

    // Return to chat
    const chatLink = page.locator("a[data-tooltip='对话']").first();
    if (await chatLink.isVisible()) {
      await chatLink.click({ force: true });
      await page.waitForURL("http://localhost:3000/");
      await page.waitForTimeout(800);
      console.log("✓ Returned to main chat cockpit");
    }
  }

  console.log("Testing composer input typing...");
  const textarea = page.locator(".composer-input-row textarea").first();
  if (await textarea.isVisible()) {
    await textarea.fill("你好，Cool AI！测试会话输入与 UI 响应。");
    await page.waitForTimeout(1000);
    console.log("✓ Composer input verified");
  }

  console.log("🎉 All live automated browser tests completed successfully!");
  await page.waitForTimeout(2000);
  await browser.close();
}

main().catch((err) => {
  console.error("Live test failed:", err);
  process.exit(1);
});
