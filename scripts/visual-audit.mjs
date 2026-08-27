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
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { chromium } from "playwright";

const host = "127.0.0.1";
const appPort = 5920;
const baseUrl = `http://${host}:${appPort}`;

const tempDir = mkdtempSync(join(tmpdir(), "cool-ai-visual-audit-"));
const workspaceDir = join(tempDir, "workspace");
mkdirSync(workspaceDir, { recursive: true });
const canonicalWorkspace = realpathSync(workspaceDir);
const dbPath = join(tempDir, "audit.sqlite");
const masterKey = randomBytes(32).toString("base64url");

const screenshotsDir = resolve("visual-audit-results");
mkdirSync(screenshotsDir, { recursive: true });

const browserExecutable = [
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
].find((c) => c && existsSync(c));

console.log("Using browser executable:", browserExecutable || "bundled playwright chromium");

// Write sample files in workspace
writeFileSync(
  join(workspaceDir, "auth.ts"),
  `export interface SessionUser {\n  id: string;\n  name: string;\n  role: 'owner' | 'guest';\n}\n\nexport function verifySession(token: string): SessionUser | null {\n  if (!token) return null;\n  return { id: 'usr_01', name: 'Alex', role: 'owner' };\n}\n`,
  "utf8"
);
writeFileSync(
  join(workspaceDir, "README.md"),
  `# Cool AI Project\n\nLocal-first multi-agent cockpit.\n`,
  "utf8"
);

// Server management
let serverProcess;
let serverLogs = "";

function startServer() {
  const nextBin = resolve("node_modules", "next", "dist", "bin", "next");
  const isDev = process.env.AUDIT_DEV === "1";
  const cmd = isDev ? "dev" : "start";
  
  console.log(`Starting Next.js with '${cmd}' on port ${appPort}...`);
  
  serverProcess = spawn(
    process.execPath,
    [nextBin, cmd, "--hostname", host, "--port", String(appPort)],
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
    } catch {
      // connecting
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`Server did not respond within 60s\n${serverLogs}`);
}

async function run() {
  try {
    startServer();
    await waitForServer();
    console.log("Server is ready at", baseUrl);

    const browser = await chromium.launch({
      executablePath: browserExecutable,
      headless: true,
    });

    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2, // Retina 2x crisp screenshots
    });

    const page = await context.newPage();

    // 1. Visit Home page
    console.log("1. Visiting Home page...");
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.waitForTimeout(1000);

    // Capture 01: Home Empty Light
    await page.screenshot({ path: join(screenshotsDir, "01-home-empty-light.png"), fullPage: true });

    // Switch to Dark mode
    const themeBtn = page.getByRole("button", { name: /切换至(暗色|深色)主题|主题/i });
    if (await themeBtn.isVisible()) {
      await themeBtn.click();
      await page.waitForTimeout(500);
      await page.screenshot({ path: join(screenshotsDir, "01-home-empty-dark.png"), fullPage: true });
      // Switch back to light
      await page.getByRole("button", { name: /切换至(亮色|浅色)主题|主题/i }).click();
      await page.waitForTimeout(500);
    }

    // 2. Click "打开文件夹" to initialize project with built-in agents
    console.log("2. Initializing project with workspace picker...");
    const openFolderBtn = page.getByRole("button", { name: /打开文件夹/i }).first();
    if (await openFolderBtn.isVisible()) {
      await openFolderBtn.click();
      await page.waitForTimeout(2000);
    }

    // Capture 02: Project Ready / Empty Chat Light & Dark
    await page.screenshot({ path: join(screenshotsDir, "02-project-ready-light.png"), fullPage: true });
    
    // Toggle theme to dark
    const darkBtn = page.getByRole("button", { name: /切换至(暗色|深色)主题|主题/i });
    if (await darkBtn.isVisible()) {
      await darkBtn.click();
      await page.waitForTimeout(500);
      await page.screenshot({ path: join(screenshotsDir, "02-project-ready-dark.png"), fullPage: true });
      await page.getByRole("button", { name: /切换至(亮色|浅色)主题|主题/i }).click();
      await page.waitForTimeout(500);
    }

    // 3. Send a message in Composer
    console.log("3. Sending message in Composer...");
    const composerInput = page.locator("textarea, [contenteditable='true']").first();
    if (await composerInput.isVisible()) {
      await composerInput.fill("@规划 请分析当前鉴权模块并给出重构方案");
      await page.waitForTimeout(300);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(2500);
    }

    await page.screenshot({ path: join(screenshotsDir, "03-project-chat-light.png"), fullPage: true });

    // 4. Test Cmd+K Search modal
    console.log("4. Testing Search Modal...");
    await page.keyboard.press("Control+k");
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(screenshotsDir, "04-search-modal-light.png"), fullPage: true });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    // 5. Check Governance Views: Tasks (任务看板)
    console.log("5. Testing Tasks View...");
    const tasksRailBtn = page.locator("button[data-tooltip*='任务'], button[aria-label*='任务']").first();
    if (await tasksRailBtn.isVisible()) {
      await tasksRailBtn.click();
      await page.waitForTimeout(1000);
      await page.screenshot({ path: join(screenshotsDir, "05-tasks-view-light.png"), fullPage: true });
      
      // dark
      await page.getByRole("button", { name: /切换至(暗色|深色)主题|主题/i }).click();
      await page.waitForTimeout(500);
      await page.screenshot({ path: join(screenshotsDir, "05-tasks-view-dark.png"), fullPage: true });
      await page.getByRole("button", { name: /切换至(亮色|浅色)主题|主题/i }).click();
      await page.waitForTimeout(500);
    }

    // 6. Check Memories (共享记忆)
    console.log("6. Testing Memories View...");
    const memRailBtn = page.locator("button[data-tooltip*='记忆'], button[aria-label*='记忆']").first();
    if (await memRailBtn.isVisible()) {
      await memRailBtn.click();
      await page.waitForTimeout(1000);
      await page.screenshot({ path: join(screenshotsDir, "06-memories-view-light.png"), fullPage: true });

      // dark
      await page.getByRole("button", { name: /切换至(暗色|深色)主题|主题/i }).click();
      await page.waitForTimeout(500);
      await page.screenshot({ path: join(screenshotsDir, "06-memories-view-dark.png"), fullPage: true });
      await page.getByRole("button", { name: /切换至(亮色|浅色)主题|主题/i }).click();
      await page.waitForTimeout(500);
    }

    // 7. Check Approvals (统一审批中心)
    console.log("7. Testing Approvals View...");
    const appRailBtn = page.locator("button[data-tooltip*='审批'], button[aria-label*='审批']").first();
    if (await appRailBtn.isVisible()) {
      await appRailBtn.click();
      await page.waitForTimeout(1000);
      await page.screenshot({ path: join(screenshotsDir, "07-approvals-view-light.png"), fullPage: true });

      // dark
      await page.getByRole("button", { name: /切换至(暗色|深色)主题|主题/i }).click();
      await page.waitForTimeout(500);
      await page.screenshot({ path: join(screenshotsDir, "07-approvals-view-dark.png"), fullPage: true });
      await page.getByRole("button", { name: /切换至(亮色|浅色)主题|主题/i }).click();
      await page.waitForTimeout(500);
    }

    // 8. Check Audit (统一审计中心)
    console.log("8. Testing Audit View...");
    const audRailBtn = page.locator("button[data-tooltip*='审计'], button[aria-label*='审计']").first();
    if (await audRailBtn.isVisible()) {
      await audRailBtn.click();
      await page.waitForTimeout(1000);
      await page.screenshot({ path: join(screenshotsDir, "08-audit-view-light.png"), fullPage: true });

      // dark
      await page.getByRole("button", { name: /切换至(暗色|深色)主题|主题/i }).click();
      await page.waitForTimeout(500);
      await page.screenshot({ path: join(screenshotsDir, "08-audit-view-dark.png"), fullPage: true });
      await page.getByRole("button", { name: /切换至(亮色|浅色)主题|主题/i }).click();
      await page.waitForTimeout(500);
    }

    // 9. Check Team Page (/team)
    console.log("9. Testing Team & Settings Page...");
    await page.goto(`${baseUrl}/team`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1000);
    await page.screenshot({ path: join(screenshotsDir, "09-team-overview-light.png"), fullPage: true });

    // dark
    await page.getByRole("button", { name: /切换至(暗色|深色)主题|主题/i }).click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(screenshotsDir, "09-team-overview-dark.png"), fullPage: true });
    await page.getByRole("button", { name: /切换至(亮色|浅色)主题|主题/i }).click();
    await page.waitForTimeout(500);

    // Check Providers section on /team
    const providerNav = page.getByRole("link", { name: /Provider|模型供应/i }).or(page.getByRole("button", { name: /Provider|模型供应/i })).first();
    if (await providerNav.isVisible()) {
      await providerNav.click();
      await page.waitForTimeout(800);
      await page.screenshot({ path: join(screenshotsDir, "10-team-providers-light.png"), fullPage: true });
    }

    // Check Preferences section on /team
    const prefNav = page.getByRole("link", { name: /偏好|设置|系统/i }).or(page.getByRole("button", { name: /偏好|设置|系统/i })).first();
    if (await prefNav.isVisible()) {
      await prefNav.click();
      await page.waitForTimeout(800);
      await page.screenshot({ path: join(screenshotsDir, "11-team-preferences-light.png"), fullPage: true });
    }

    // 10. Mobile Narrow View (390x844)
    console.log("10. Testing Mobile Narrow View...");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.waitForTimeout(1000);
    await page.screenshot({ path: join(screenshotsDir, "12-mobile-home-light.png"), fullPage: true });

    await browser.close();
    console.log("Visual audit screenshots captured successfully in:", screenshotsDir);
  } finally {
    stopServer();
  }
}

run().catch((err) => {
  console.error("Visual audit failed:", err);
  stopServer();
  process.exit(1);
});
