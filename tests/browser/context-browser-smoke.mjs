import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
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
const appPort = 5200 + (process.pid % 200);
const providerPort = 5400 + (process.pid % 200);
const baseUrl = `http://${host}:${appPort}`;
const providerBaseUrl = `http://${host}:${providerPort}/v1`;
const temporaryDirectory = mkdtempSync(
  join(tmpdir(), "cool-ai-context-smoke-"),
);
const workspaceDirectory = join(temporaryDirectory, "real-workspace");
mkdirSync(workspaceDirectory);
const canonicalWorkspace = realpathSync(workspaceDirectory);
let boundWorkspacePath = canonicalWorkspace;
const reboundWorkspaceDirectory = join(
  temporaryDirectory,
  "rebound-real-workspace",
);
mkdirSync(reboundWorkspaceDirectory);
let reboundWorkspacePath = realpathSync(reboundWorkspaceDirectory);

// --- 027 T-04：工作区只读浏览验收造数（真实临时工作区，smoke 结束随临时目录清理） ---
const browseCanary = "WORKSPACE_ENV_CANARY_DO_NOT_LEAK_2026";
const browseTextContent = [
  "# 工作区指南",
  "",
  "这是用于浏览器验收的文本文件。",
  "第二行内容。",
  "",
].join("\n");
const browseTextBytes = Buffer.byteLength(browseTextContent, "utf8");
const browseTextLines = (browseTextContent.match(/\n/g) ?? []).length;
const browseLargeStart = "LARGE-FILE-START-MARKER";
const browseLargeTail = "LARGE-FILE-TAIL-MARKER-PAST-512KIB";
const browseLargeContent = (() => {
  const filler = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789ab\n";
  const target = 540 * 1024;
  let content = `${browseLargeStart}\n`;
  while (content.length < target - browseLargeTail.length - filler.length) {
    content += filler;
  }
  return `${content}${browseLargeTail}\n`;
})();
const browseLargeBytes = Buffer.byteLength(browseLargeContent, "utf8");
const browsePngBytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
mkdirSync(join(workspaceDirectory, "docs", "inner"), { recursive: true });
mkdirSync(join(workspaceDirectory, "assets"));
writeFileSync(join(workspaceDirectory, "docs", "guide.md"), browseTextContent, "utf8");
writeFileSync(join(workspaceDirectory, "docs", "inner", "deep.txt"), "深层嵌套文件。\n", "utf8");
writeFileSync(join(workspaceDirectory, "assets", "logo.png"), browsePngBytes);
writeFileSync(join(workspaceDirectory, "notes.txt"), "根目录笔记。\n", "utf8");
writeFileSync(
  join(workspaceDirectory, "app.bin"),
  Buffer.from([0x00, 0xff, 0xfe, 0x01, 0x02, 0x03, 0x00, 0x10]),
);
writeFileSync(join(workspaceDirectory, ".env"), `SECRET_TOKEN=${browseCanary}\n`, "utf8");
writeFileSync(join(workspaceDirectory, "large.txt"), browseLargeContent, "utf8");
writeFileSync(join(reboundWorkspaceDirectory, "rebound-notes.txt"), "改绑后的工作区笔记。\n", "utf8");

const databasePath = join(temporaryDirectory, "context-smoke.sqlite");
const auditPath = join(temporaryDirectory, "workspace-audit.jsonl");
const masterKey = randomBytes(32).toString("base64url");
const testApiKey = "context-provider-key-DO-NOT-LEAK-2026";
const evidenceDirectory = resolve(
  "features",
  "003-project-team-context",
  "evidence",
);
const desktopScreenshot = join(
  evidenceDirectory,
  "smoke-context-desktop.png",
);
const narrowScreenshot = join(
  evidenceDirectory,
  "smoke-context-narrow.png",
);
const demoScreenshot = join(evidenceDirectory, "demo-project-context.png");
const dependencyEvidenceDirectory = resolve(
  "features",
  "026-mission-dependency-insight",
  "evidence",
);
const dependencyDesktopLightScreenshot = join(
  dependencyEvidenceDirectory,
  "dependencies-desktop-light.png",
);
const dependencyDesktopDarkScreenshot = join(
  dependencyEvidenceDirectory,
  "dependencies-desktop-dark.png",
);
const dependencyNarrowLightScreenshot = join(
  dependencyEvidenceDirectory,
  "dependencies-narrow-light.png",
);
const dependencyNarrowDarkScreenshot = join(
  dependencyEvidenceDirectory,
  "dependencies-narrow-dark.png",
);
const dependencyResultsPath = join(
  dependencyEvidenceDirectory,
  "dependencies-acceptance-results.json",
);
const browseEvidenceDirectory = resolve(
  "features",
  "027-workspace-readonly-browser",
  "evidence",
);
const browseDesktopLightScreenshot = join(
  browseEvidenceDirectory,
  "workspace-browse-desktop-light.png",
);
const browseDesktopDarkScreenshot = join(
  browseEvidenceDirectory,
  "workspace-browse-desktop-dark.png",
);
const browseNarrowLightScreenshot = join(
  browseEvidenceDirectory,
  "workspace-browse-narrow-light.png",
);
const browseNarrowDarkScreenshot = join(
  browseEvidenceDirectory,
  "workspace-browse-narrow-dark.png",
);
const browseResultsPath = join(
  browseEvidenceDirectory,
  "workspace-browse-acceptance-results.json",
);
const browserExecutable = [
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
].find((candidate) => candidate && existsSync(candidate));

mkdirSync(evidenceDirectory, { recursive: true });
mkdirSync(dependencyEvidenceDirectory, { recursive: true });
mkdirSync(browseEvidenceDirectory, { recursive: true });

let providerAuthorizationCount = 0;
const provider = createServer((request, response) => {
  if (request.url === "/v1/models") {
    if (request.headers.authorization === `Bearer ${testApiKey}`) {
      providerAuthorizationCount += 1;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "context-model" }] }));
    return;
  }
  response.writeHead(404).end();
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

const serverCommand =
  process.platform === "win32"
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
        args: [
          "run",
          "dev",
          "--",
          "--hostname",
          host,
          "--port",
          String(appPort),
        ],
      };

let appServer;
let serverOutput = "";
function stopAppServer() {
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
      throw new Error(`Context app exited before readiness.\n${serverOutput}`);
    }
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
    } catch {
      // The isolated Next.js app is still starting.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  throw new Error(`Context app did not become ready.\n${serverOutput}`);
}

function countOccurrences(text, needle) {
  return needle ? text.split(needle).length - 1 : 0;
}

async function selectOptionContaining(select, text) {
  const value = await select
    .locator("option")
    .filter({ hasText: text })
    .getAttribute("value");
  assert.ok(value, `select option containing "${text}" must exist`);
  await select.selectOption(value);
}

// --- 026 T-03：Mission 依赖全景验收助手 ---
const dependencyAcceptance = { assertions: 0, axe: [], matrix: [] };

function depOk(value, message) {
  dependencyAcceptance.assertions += 1;
  assert.ok(value, message);
}

function depEqual(actual, expected, message) {
  dependencyAcceptance.assertions += 1;
  assert.equal(actual, expected, message);
}

function depDeepEqual(actual, expected, message) {
  dependencyAcceptance.assertions += 1;
  assert.deepEqual(actual, expected, message);
}

async function axeDependencies(page, state) {
  const scan = await new AxeBuilder({ page }).analyze();
  const blocking = scan.violations
    .filter(
      (violation) =>
        violation.impact === "critical" || violation.impact === "serious",
    )
    .map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      targets: violation.nodes.map((node) => node.target),
    }));
  dependencyAcceptance.axe.push({
    blocking,
    state,
    violationCount: scan.violations.length,
    violations: scan.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact ?? "unknown",
    })),
  });
  assert.deepEqual(blocking, [], `${state}: axe critical/serious must be 0`);
}

// --- 027 T-04：工作区只读浏览验收助手 ---
const browseAcceptance = { assertions: 0, axe: [], matrix: [] };

function browseOk(value, message) {
  browseAcceptance.assertions += 1;
  assert.ok(value, message);
}

function browseEqual(actual, expected, message) {
  browseAcceptance.assertions += 1;
  assert.equal(actual, expected, message);
}

function browseDeepEqual(actual, expected, message) {
  browseAcceptance.assertions += 1;
  assert.deepEqual(actual, expected, message);
}

async function axeWorkspaceBrowse(page, state) {
  const scan = await new AxeBuilder({ page }).analyze();
  const blocking = scan.violations
    .filter(
      (violation) =>
        violation.impact === "critical" || violation.impact === "serious",
    )
    .map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      targets: violation.nodes.map((node) => node.target),
    }));
  browseAcceptance.axe.push({
    blocking,
    state,
    violationCount: scan.violations.length,
    violations: scan.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact ?? "unknown",
    })),
  });
  assert.deepEqual(blocking, [], `${state}: axe critical/serious must be 0`);
}

async function setCockpitTheme(page, theme) {
  const currentTheme = await page.evaluate(
    () => document.documentElement.dataset.theme ?? "light",
  );
  if (currentTheme === theme) return;
  await page
    .getByRole("button", {
      name:
        theme === "dark"
          ? "当前为明色主题，切换到暗色主题"
          : "当前为暗色主题，切换到明色主题",
    })
    .evaluate((button) => button.click());
  assert.equal(
    await page.evaluate(() => document.documentElement.dataset.theme),
    theme,
  );
}

function undersizedButtons(scope) {
  return scope.getByRole("button").evaluateAll((buttons) =>
    buttons
      .map((button) => {
        const rect = button.getBoundingClientRect();
        return {
          height: rect.height,
          label: button.textContent?.trim() ?? "",
          width: rect.width,
        };
      })
      .filter(({ height, width }) => height < 44 || width < 44),
  );
}

async function createTeamPrerequisites(page) {
  await page.goto(`${baseUrl}/team`, { waitUntil: "networkidle" });
  await page.getByRole("tab", { name: "模型服务" }).click();
  await page.getByRole("button", { name: "创建模型服务" }).click();
  await page.getByLabel("服务名称").fill("Context Local Provider");
  await page.getByLabel("Base URL").fill(providerBaseUrl);
  await page.getByLabel("默认模型").fill("context-model");
  await page.getByLabel("API key").fill(testApiKey);
  await page
    .getByRole("checkbox", { name: /HTTP 会明文传输凭据/ })
    .check();
  await page.getByRole("button", { name: "验证连接" }).click();
  await page
    .getByText("已验证模型 context-model", { exact: true })
    .waitFor();
  await page.getByRole("button", { name: "保存服务" }).click();
  await page.getByText("模型服务已保存。", { exact: true }).waitFor();

  await page.getByRole("tab", { name: "技能" }).click();
  await page.getByRole("button", { name: "创建新技能" }).click();
  await page.getByLabel("技能名称").fill("Context Skill");
  await page.getByLabel("技能说明").fill("Context browser acceptance skill");
  await page
    .getByLabel("指令正文")
    .fill("Keep project context deterministic and sourced.");
  await page.getByRole("button", { name: "保存技能" }).click();
  await page.getByRole("heading", { name: "Context Skill" }).waitFor();

  await page.getByRole("tab", { name: "Agent" }).click();
  await page.getByRole("button", { name: "创建 Agent" }).click();
  await page.getByLabel("创建方式").selectOption("planner");
  await page.getByLabel("Agent 名称").fill("Context Planner");
  await page
    .getByLabel("模型服务", { exact: true })
    .selectOption({ label: "Context Local Provider" });
  await page.getByRole("checkbox", { name: "Context Skill" }).check();
  await page.getByRole("button", { name: "保存 Agent" }).click();
  await page.getByRole("heading", { name: "Context Planner" }).waitFor();

  await page.getByRole("button", { name: "创建 Agent" }).click();
  await page.getByLabel("创建方式").selectOption("builder");
  await page.getByLabel("Agent 名称").fill("Context Builder");
  await page
    .getByLabel("模型服务", { exact: true })
    .selectOption({ label: "Context Local Provider" });
  await page.getByRole("checkbox", { name: "Context Skill" }).check();
  await page.getByRole("checkbox", { name: "写入文件" }).check();
  await page.getByRole("checkbox", { name: "运行命令" }).check();
  await page.getByRole("button", { name: "保存 Agent" }).click();
  await page.getByRole("heading", { name: "Context Builder" }).waitFor();
}

async function createMemory(rightPanel, {
  type,
  content,
  sourceType,
  sourceRef,
  supersedes,
}) {
  await rightPanel.getByRole("radio", { name: type }).check();
  await rightPanel.getByLabel("记忆正文").fill(content);
  await rightPanel.getByLabel("来源类型").selectOption(sourceType);
  await rightPanel.getByLabel("来源引用").fill(sourceRef);
  if (supersedes) {
    await rightPanel.getByLabel("取代旧记忆").selectOption({
      label: supersedes,
    });
  }
  await rightPanel.getByRole("button", { name: "保存记忆" }).click();
  await rightPanel.getByRole("heading", { name: content }).waitFor();
}

let browser;
let validationToken = "";
const projectResponseBodies = [];
const errorResponseBodies = [];
try {
  await listen(provider, providerPort);
  appServer = spawn(serverCommand.command, serverCommand.args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      COCKPIT_DB_PATH: databasePath,
      COCKPIT_MASTER_KEY: masterKey,
      COCKPIT_WORKSPACE_AUDIT_PATH: auditPath,
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
  await waitForApp();

  browser = await chromium.launch({
    headless: true,
    ...(browserExecutable ? { executablePath: browserExecutable } : {}),
  });
  const browserContext = await browser.newContext({
    viewport: { height: 1100, width: 1600 },
  });
  const page = await browserContext.newPage();
  page.on("response", async (response) => {
    const url = response.url();
    if (
      url.endsWith("/api/providers/verify") &&
      response.status() === 200
    ) {
      validationToken = (await response.json()).validationToken;
      return;
    }
    if (url.includes("/api/projects/") || url.includes("/api/missions/")) {
      const body = await response.text().catch(() => "");
      projectResponseBodies.push(body);
      if (response.status() >= 400) errorResponseBodies.push(body);
    }
  });

  await createTeamPrerequisites(page);
  assert.equal(providerAuthorizationCount, 1);
  assert.ok(validationToken);

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.getByLabel("项目名称").fill("Context Smoke Project");
  await page
    .locator("form")
    .filter({ has: page.getByLabel("项目名称") })
    .getByRole("button", { name: "创建项目" })
    .click();
  await page.waitForURL(/\/projects\/[^/]+$/);
  await page
    .getByRole("heading", { name: "Context Smoke Project" })
    .waitFor();

  await page.getByLabel("本地工作区路径").fill(workspaceDirectory);
  await page.getByRole("button", { name: "绑定工作区" }).click();
  await page.getByText("工作区已保存。", { exact: true }).waitFor();
  boundWorkspacePath =
    (await page.getByLabel("工作区绑定状态").locator("code").textContent()) ??
    canonicalWorkspace;

  // --- 027 T-04：工作区只读浏览真实浏览器验收（desktop light 全分支） ---
  function browseSizeLabel(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    const kib = bytes / 1024;
    if (kib < 1024) {
      return `${Number.isInteger(kib) ? kib : kib.toFixed(1)} KiB`;
    }
    const mib = kib / 1024;
    return `${Number.isInteger(mib) ? mib : mib.toFixed(1)} MiB`;
  }

  const workspaceTree = page.getByRole("tree", { name: "工作区文件" });
  await workspaceTree.waitFor();
  browseDeepEqual(
    await workspaceTree.locator(".workspace-tree-name").allTextContents(),
    ["assets", "docs", ".env", "app.bin", "large.txt", "notes.txt"],
    "root listing must sort directories first, then files by case-insensitive name",
  );
  browseEqual(
    await workspaceTree
      .getByRole("treeitem", { name: /\.env/ })
      .getByText("已遮蔽", { exact: true })
      .count(),
    1,
    ".env must carry the masked badge in the tree",
  );

  // 懒加载展开：docs → inner/guide.md（目录优先）
  await workspaceTree
    .getByRole("treeitem", { exact: true, name: "docs" })
    .click();
  const docsItem = workspaceTree.getByRole("treeitem", {
    exact: true,
    name: "docs",
  });
  browseEqual(
    await docsItem.getAttribute("aria-expanded"),
    "true",
    "clicking a directory must expand it",
  );
  const guideItem = workspaceTree.getByRole("treeitem", {
    exact: true,
    name: "guide.md",
  });
  await guideItem.waitFor();
  browseDeepEqual(
    await workspaceTree.locator(".workspace-tree-name").allTextContents(),
    ["assets", "docs", "inner", "guide.md", ".env", "app.bin", "large.txt", "notes.txt"],
    "expanded docs must list the nested directory before files",
  );

  // 键盘导航：ArrowDown → inner，Enter 展开，ArrowLeft 收起，ArrowDown → guide.md
  await page.keyboard.press("ArrowDown");
  const innerItem = workspaceTree.getByRole("treeitem", {
    exact: true,
    name: "inner",
  });
  browseOk(
    await innerItem.evaluate((element) => document.activeElement === element),
    "ArrowDown must move focus to the next tree item",
  );
  await page.keyboard.press("Enter");
  await workspaceTree
    .getByRole("treeitem", { exact: true, name: "deep.txt" })
    .waitFor();
  browseEqual(
    await innerItem.getAttribute("aria-expanded"),
    "true",
    "Enter on a collapsed directory must expand it",
  );
  await page.keyboard.press("ArrowLeft");
  browseEqual(
    await workspaceTree
      .getByRole("treeitem", { exact: true, name: "deep.txt" })
      .count(),
    0,
    "ArrowLeft on an expanded directory must collapse it",
  );
  await page.keyboard.press("ArrowDown");
  browseOk(
    await guideItem.evaluate(
      (element) =>
        document.activeElement === element
        && element.matches(":focus-visible")
        && getComputedStyle(element).boxShadow !== "none",
    ),
    "keyboard-focused tree item must show a visible focus ring",
  );

  // 文本预览分支：内容 + 路径头 + 行数/大小元信息
  await page.keyboard.press("Enter");
  const preview = page.getByRole("region", { name: "文件预览" });
  const previewContent = preview.locator(".workspace-preview-content");
  await previewContent.waitFor();
  browseEqual(
    await preview.locator(".workspace-preview-path code").textContent(),
    "docs/guide.md",
    "preview must show the workspace-relative path header",
  );
  browseEqual(
    await preview.locator(".workspace-preview-meta").textContent(),
    `${browseTextLines} 行 · ${browseSizeLabel(browseTextBytes)}`,
    "text preview must show line count and full file size",
  );
  browseEqual(
    await previewContent.textContent(),
    browseTextContent,
    "text preview must render the exact file content",
  );
  browseEqual(
    await docsItem.getAttribute("aria-selected"),
    "false",
    "directories must not become selected when a file is picked",
  );
  browseEqual(
    await guideItem.getAttribute("aria-selected"),
    "true",
    "the picked file must become the selected tree item",
  );

  // 大文件截断分支：>512KiB 文本截断并明示
  await workspaceTree
    .getByRole("treeitem", { exact: true, name: "large.txt" })
    .click();
  await preview
    .getByText("已截断（仅显示前 512KiB）", { exact: true })
    .waitFor();
  const largeMeta = await preview
    .locator(".workspace-preview-meta")
    .textContent();
  browseOk(
    new RegExp(`^\\d+ 行 · ${browseSizeLabel(browseLargeBytes)}$`).test(
      largeMeta ?? "",
    ),
    "truncated preview must keep showing the full file size",
  );
  const truncatedContent = (await previewContent.textContent()) ?? "";
  browseOk(
    truncatedContent.includes(browseLargeStart),
    "truncated preview must include the start of the file",
  );
  browseOk(
    !truncatedContent.includes(browseLargeTail),
    "truncated preview must not include content past 512KiB",
  );
  browseOk(
    truncatedContent.length <= 512 * 1024,
    "truncated preview must not exceed the 512KiB text budget",
  );

  // 图片分支：png magic bytes 内联渲染
  await workspaceTree
    .getByRole("treeitem", { exact: true, name: "assets" })
    .click();
  const pngItem = workspaceTree.getByRole("treeitem", {
    exact: true,
    name: "logo.png",
  });
  await pngItem.waitFor();
  await pngItem.click();
  const previewImage = preview.getByRole("img", { name: "logo.png" });
  await previewImage.waitFor();
  browseOk(
    ((await previewImage.getAttribute("src")) ?? "").startsWith(
      "data:image/png;base64,",
    ),
    "image preview must inline a png data URL",
  );
  browseEqual(
    await preview.locator(".workspace-preview-meta").textContent(),
    `image/png · ${browseSizeLabel(browsePngBytes.length)}`,
    "image preview must show the content type and size",
  );

  // 二进制降级分支
  await workspaceTree
    .getByRole("treeitem", { exact: true, name: "app.bin" })
    .click();
  await preview
    .getByText("该文件类型不支持预览。", { exact: true })
    .waitFor();
  browseEqual(
    await preview.locator(".workspace-preview-content").count(),
    0,
    "binary fallback must not render file content",
  );

  // 敏感遮蔽分支：占位 + DOM 零内容泄漏
  await workspaceTree.getByRole("treeitem", { name: /\.env/ }).click();
  await preview
    .getByText("敏感文件已遮蔽，内容不回显。", { exact: true })
    .waitFor();
  browseEqual(
    await preview.locator(".workspace-preview-content").count(),
    0,
    "masked preview must not render file content",
  );
  browseOk(
    !(await page.content()).includes(browseCanary),
    "the page DOM must never contain the .env canary",
  );

  // 只读断言：树与预览区无任何写/删/改入口
  browseEqual(
    await preview.getByRole("button").count(),
    0,
    "ready preview must render no buttons",
  );
  browseEqual(
    await preview.getByRole("textbox").count(),
    0,
    "preview must render no text inputs",
  );
  browseEqual(
    await preview.getByRole("link").count(),
    0,
    "preview must render no links",
  );
  browseEqual(
    await preview.locator("[contenteditable]").count(),
    0,
    "preview must render no contenteditable surface",
  );
  browseEqual(
    await workspaceTree.getByRole("button").count(),
    0,
    "ready tree must render no buttons",
  );
  browseEqual(
    await workspaceTree.locator("input, textarea, select").count(),
    0,
    "tree must render no form controls",
  );

  // 44px 触控目标
  browseDeepEqual(
    await workspaceTree.getByRole("treeitem").evaluateAll((items) =>
      items
        .map((item) => item.getBoundingClientRect())
        .filter((rect) => rect.height < 44),
    ),
    [],
    "tree items must be at least 44px tall",
  );

  // 越界/逃逸路径直调 API：稳定脱敏拒绝，零宿主路径与零 canary 泄漏
  const escapeProbes = await page.evaluate(async () => {
    const projects = await (await fetch("/api/projects")).json();
    const projectId = projects.projects[0].id;
    const probes = [
      ["files?path=..%2F", 400, "INVALID_INPUT"],
      ["files?path=..%2F..%2F", 400, "INVALID_INPUT"],
      ["files?path=%2Fetc%2Fpasswd", 400, "INVALID_INPUT"],
      ["files?path=docs%2F..%2F..%2F", 400, "INVALID_INPUT"],
      ["files?path=..%5C", 400, "INVALID_INPUT"],
      ["files?path=a%00b", 400, "INVALID_INPUT"],
      ["files?path=.env", 422, "WORKSPACE_PATH_REJECTED"],
      ["file?path=..%2F.env", 400, "INVALID_INPUT"],
      ["file?path=.env", 200, "sensitive-masked"],
    ];
    const results = [];
    for (const [query, expectedStatus, expectedCode] of probes) {
      const response = await fetch(
        `/api/projects/${projectId}/workspace/${query}`,
      );
      results.push({
        body: await response.text(),
        expectedCode,
        expectedStatus,
        query,
        status: response.status,
      });
    }
    return results;
  });
  for (const probe of escapeProbes) {
    browseEqual(
      probe.status,
      probe.expectedStatus,
      `probe ${probe.query} must return ${probe.expectedStatus}`,
    );
    browseOk(
      probe.body.includes(probe.expectedCode),
      `probe ${probe.query} must carry the sanitized code ${probe.expectedCode}`,
    );
    browseOk(
      !probe.body.includes(browseCanary),
      `probe ${probe.query} must not leak the .env canary`,
    );
    browseOk(
      !probe.body.includes(workspaceDirectory)
        && !probe.body.includes(boundWorkspacePath),
      `probe ${probe.query} must not leak host paths`,
    );
  }
  browseEqual(
    escapeProbes.find((probe) => probe.query === "file?path=.env")?.body,
    '{"kind":"sensitive-masked"}',
    "masked preview API must return the minimal mask payload",
  );

  await axeWorkspaceBrowse(page, "desktop light workspace browse");
  browseAcceptance.matrix.push("desktop-light");
  await page.screenshot({ fullPage: true, path: browseDesktopLightScreenshot });

  // 暗色桌面关键路径复核
  await setCockpitTheme(page, "dark");
  await workspaceTree
    .getByRole("treeitem", { exact: true, name: "notes.txt" })
    .click();
  await previewContent.waitFor();
  browseOk(
    ((await previewContent.textContent()) ?? "").includes("根目录笔记。"),
    "dark theme must keep the text preview path working",
  );
  await axeWorkspaceBrowse(page, "desktop dark workspace browse");
  browseAcceptance.matrix.push("desktop-dark");
  await page.screenshot({ fullPage: true, path: browseDesktopDarkScreenshot });
  await setCockpitTheme(page, "light");
  console.log(
    "WORKSPACE BROWSE DESKTOP PASS: tree ordering, keyboard, text/truncated/image/binary/masked branches, escape rejection, read-only, 44px, axe",
  );

  const membersFieldset = page.getByRole("group", {
    name: "平等项目成员",
  });
  await membersFieldset
    .getByRole("checkbox", { name: /Context Planner/ })
    .check();
  await membersFieldset
    .getByRole("checkbox", { name: /Context Builder/ })
    .check();
  await page.getByRole("button", { name: "保存成员" }).click();
  await page.getByText("项目成员已保存。", { exact: true }).waitFor();
  await page.reload({ waitUntil: "networkidle" });
  await page.getByText(boundWorkspacePath, { exact: true }).waitFor();
  await page
    .getByRole("checkbox", { name: /Context Planner/ })
    .waitFor();

  await page.getByLabel("使命标题").fill("Context Smoke Mission");
  await page
    .getByLabel("使命目标")
    .fill("Prove real deterministic project context");
  await page.getByRole("button", { name: "创建使命" }).click();
  await page
    .getByRole("heading", { name: "Context Smoke Mission" })
    .waitFor();

  await page.getByLabel("任务标题").fill("Plan task");
  await page.getByLabel("任务说明").fill("Prepare the implementation");
  await selectOptionContaining(page.getByLabel("负责人"), "Context Planner");
  await page.getByRole("button", { exact: true, name: "创建任务" }).click();
  await page.getByRole("heading", { name: "Plan task" }).waitFor();

  await page.getByLabel("任务标题").fill("Build task");
  await page.getByLabel("任务说明").fill("Implement after planning");
  await selectOptionContaining(page.getByLabel("负责人"), "Context Builder");
  await page
    .getByRole("group", { name: "前置依赖" })
    .getByRole("checkbox", { name: "Plan task" })
    .check();
  await page.getByRole("button", { exact: true, name: "创建任务" }).click();
  await page
    .getByRole("region", { name: "使命任务看板" })
    .getByRole("heading", { exact: true, name: "Build task" })
    .waitFor();

  await page.getByRole("button", { name: "开始任务 Build task" }).click();
  await page
    .getByRole("alert")
    .getByText(/前置依赖尚未完成/)
    .waitFor();
  // 统一完成门槛（特性 006）：看板"完成任务"要求先通过独立评审，评审路径由
  // review smoke 覆盖；此处保留依赖守卫拦截与无依赖任务可启动的正向控制。
  await page.getByRole("button", { name: "开始任务 Plan task" }).click();
  await page
    .getByRole("button", { name: "完成任务 Plan task" })
    .waitFor();

  const missionState = await page.evaluate(async () => {
    const projects = await (await fetch("/api/projects")).json();
    const projectId = projects.projects[0].id;
    const state = await (
      await fetch(`/api/projects/${projectId}/mission`)
    ).json();
    return { projectId, state };
  });
  const planId = missionState.state.workItems.find(
    (item) => item.title === "Plan task",
  ).id;

  // --- 026 T-03：Mission 依赖全景真实浏览器验收 ---
  // 造数：既有 Plan→Build 链上补 Test(←Plan)、Ship(←Build,Test)，形成链+菱形。
  // 环在持久层被 DEPENDENCY_CYCLE 守卫拒绝（合法路径不可达），循环呈现由组件测试覆盖。
  await page.getByLabel("任务标题").fill("Test task");
  await page.getByLabel("任务说明").fill("Verify the build outcome");
  await selectOptionContaining(page.getByLabel("负责人"), "Context Builder");
  await page
    .getByRole("group", { name: "前置依赖" })
    .getByRole("checkbox", { name: "Plan task" })
    .check();
  await page.getByRole("button", { exact: true, name: "创建任务" }).click();
  const boardRegion = page.getByRole("region", { name: "使命任务看板" });
  await boardRegion
    .getByRole("heading", { exact: true, name: "Test task" })
    .waitFor();

  await page.getByLabel("任务标题").fill("Ship task");
  await page.getByLabel("任务说明").fill("Release after build and test");
  await selectOptionContaining(page.getByLabel("负责人"), "Context Builder");
  const shipDependencies = page.getByRole("group", { name: "前置依赖" });
  await shipDependencies
    .getByRole("checkbox", { name: "Build task" })
    .check();
  await shipDependencies.getByRole("checkbox", { name: "Test task" }).check();
  await page.getByRole("button", { exact: true, name: "创建任务" }).click();
  await boardRegion
    .getByRole("heading", { exact: true, name: "Ship task" })
    .waitFor();

  const dependencyRegion = page.getByRole("region", { name: "依赖全景" });
  const dependencyList = dependencyRegion.getByRole("list", {
    name: "任务依赖关系",
  });
  await dependencyRegion
    .getByRole("heading", { exact: true, name: "Ship task" })
    .waitFor();
  depEqual(
    await dependencyList.getByRole("listitem").count(),
    4,
    "dependency insight must list all four work item nodes",
  );

  function dependencyCard(title) {
    return dependencyRegion.locator("li").filter({
      has: page.getByRole("heading", { exact: true, name: title }),
    });
  }
  const planCard = dependencyCard("Plan task");
  const buildCard = dependencyCard("Build task");
  const testCard = dependencyCard("Test task");
  const shipCard = dependencyCard("Ship task");

  depEqual(
    await planCard.getByText("进行中", { exact: true }).count(),
    1,
    "Plan node must show the in-progress status badge",
  );
  depEqual(
    await buildCard.getByText("待办", { exact: true }).count(),
    1,
    "Build node must show the todo status badge",
  );
  depEqual(
    await testCard.getByText("待办", { exact: true }).count(),
    1,
    "Test node must show the todo status badge",
  );
  depEqual(
    await shipCard.getByText("待办", { exact: true }).count(),
    1,
    "Ship node must show the todo status badge",
  );
  await shipCard
    .getByText("前置依赖未完成：待办 2 项", { exact: true })
    .waitFor();
  await testCard
    .getByText("前置依赖未完成：进行中 1 项", { exact: true })
    .waitFor();
  await buildCard
    .getByText("前置依赖未完成：进行中 1 项", { exact: true })
    .waitFor();
  depEqual(
    await planCard.getByText(/前置依赖未完成/).count(),
    0,
    "Plan node must not show a blocked reason",
  );

  depEqual(
    await shipCard
      .getByRole("button", { name: "定位任务 Build task" })
      .count(),
    1,
    "Ship node must be blocked by Build",
  );
  depEqual(
    await shipCard
      .getByRole("button", { name: "定位任务 Test task" })
      .count(),
    1,
    "Ship node must be blocked by Test",
  );
  depOk(
    (await shipCard.textContent()).includes("被阻塞于："),
    "Ship node must explain what blocks it",
  );
  depEqual(
    await planCard
      .getByRole("button", { name: "定位任务 Build task" })
      .count(),
    1,
    "Plan node must block Build",
  );
  depEqual(
    await planCard
      .getByRole("button", { name: "定位任务 Test task" })
      .count(),
    1,
    "Plan node must block Test",
  );
  depOk(
    (await planCard.textContent()).includes("阻塞："),
    "Plan node must explain what it blocks",
  );
  depOk(
    !(await planCard.textContent()).includes("被阻塞于："),
    "Plan node has no blockers",
  );
  depEqual(
    await buildCard
      .getByRole("button", { name: "定位任务 Plan task" })
      .count(),
    1,
    "Build node must be blocked by Plan",
  );
  depEqual(
    await testCard
      .getByRole("button", { name: "定位任务 Plan task" })
      .count(),
    1,
    "Test node must be blocked by Plan",
  );

  depEqual(
    await dependencyRegion.getByText(/循环/).count(),
    0,
    "no cycle annotation may render without cycles",
  );
  depEqual(
    await dependencyRegion.getByRole("textbox").count(),
    0,
    "dependency panel must stay read-only (no inputs)",
  );
  depEqual(
    await dependencyRegion.getByRole("checkbox").count(),
    0,
    "dependency panel must stay read-only (no checkboxes)",
  );

  const dependencyApi = await page.evaluate(async () => {
    const projects = await (await fetch("/api/projects")).json();
    const projectId = projects.projects[0].id;
    const state = await (
      await fetch(`/api/projects/${projectId}/mission`)
    ).json();
    const missionId = state.mission.id;
    const load = async () =>
      (
        await fetch(
          `/api/projects/${projectId}/missions/${missionId}/dependencies`,
        )
      ).json();
    return { first: await load(), second: await load() };
  });
  depEqual(
    dependencyApi.first.hasDependencies,
    true,
    "API must report dependencies",
  );
  depEqual(dependencyApi.first.nodes.length, 4, "API must return four nodes");
  depEqual(dependencyApi.first.edges.length, 4, "API must return four edges");
  depEqual(dependencyApi.first.cycles.length, 0, "API must report no cycles");
  depDeepEqual(
    dependencyApi.second,
    dependencyApi.first,
    "dependency insight must be deterministic across calls",
  );
  const titleById = Object.fromEntries(
    dependencyApi.first.nodes.map((node) => [node.workItemId, node.title]),
  );
  depDeepEqual(
    dependencyApi.first.edges
      .map(
        (edge) =>
          `${titleById[edge.fromWorkItemId]}->${titleById[edge.toWorkItemId]}`,
      )
      .sort(),
    [
      "Build task->Ship task",
      "Plan task->Build task",
      "Plan task->Test task",
      "Test task->Ship task",
    ],
    "API edges must form the chain and the diamond",
  );
  const shipNode = dependencyApi.first.nodes.find(
    (node) => node.title === "Ship task",
  );
  depEqual(
    shipNode.blockedReason,
    "前置依赖未完成：待办 2 项",
    "API must derive the Ship blocked reason",
  );

  await shipCard.getByRole("button", { name: "定位任务 Test task" }).click();
  const testHeading = boardRegion.getByRole("heading", {
    exact: true,
    name: "Test task",
  });
  depOk(
    await testHeading.evaluate(
      (element) => document.activeElement === element,
    ),
    "clicking a relation button must move focus to the board task card",
  );

  const planBuildButton = planCard.getByRole("button", {
    name: "定位任务 Build task",
  });
  await planBuildButton.focus();
  await page.keyboard.press("Enter");
  const buildHeading = boardRegion.getByRole("heading", {
    exact: true,
    name: "Build task",
  });
  depOk(
    await buildHeading.evaluate(
      (element) => document.activeElement === element,
    ),
    "Enter on a relation button must move focus to the board task card",
  );

  const shipLocateButton = shipCard.getByRole("button", {
    name: "定位任务 Ship task",
  });
  await shipLocateButton.focus();
  depOk(
    await shipLocateButton.evaluate(
      (element) =>
        element.matches(":focus-visible") &&
        getComputedStyle(element).boxShadow !== "none",
    ),
    "keyboard-focused dependency buttons must show a visible focus ring",
  );

  depDeepEqual(
    await undersizedButtons(dependencyRegion),
    [],
    "dependency panel buttons must be at least 44x44px",
  );
  await axeDependencies(page, "desktop light mission dependency insight");
  dependencyAcceptance.matrix.push("desktop-light");
  await page.screenshot({ fullPage: true, path: dependencyDesktopLightScreenshot });

  await setCockpitTheme(page, "dark");
  await shipCard
    .getByText("前置依赖未完成：待办 2 项", { exact: true })
    .waitFor();
  depEqual(
    await dependencyList.getByRole("listitem").count(),
    4,
    "dark theme must keep all four dependency nodes",
  );
  await axeDependencies(page, "desktop dark mission dependency insight");
  dependencyAcceptance.matrix.push("desktop-dark");
  await page.screenshot({ fullPage: true, path: dependencyDesktopDarkScreenshot });
  await setCockpitTheme(page, "light");

  // 无依赖 Mission 的 empty 态（第二项目隔离造数，不污染主项目事实）
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.getByLabel("项目名称").fill("Context Empty Project");
  await page
    .locator("form")
    .filter({ has: page.getByLabel("项目名称") })
    .getByRole("button", { name: "创建项目" })
    .click();
  await page.waitForURL(/\/projects\/[^/]+$/);
  await page
    .getByRole("heading", { name: "Context Empty Project" })
    .waitFor();
  await page.getByLabel("使命标题").fill("Empty Mission");
  await page.getByLabel("使命目标").fill("No dependencies at all");
  await page.getByRole("button", { name: "创建使命" }).click();
  await page.getByRole("heading", { name: "Empty Mission" }).waitFor();
  const emptyDependencyRegion = page.getByRole("region", { name: "依赖全景" });
  await emptyDependencyRegion
    .getByText("该 Mission 暂无依赖关系。", { exact: true })
    .waitFor();
  depEqual(
    await emptyDependencyRegion.getByRole("list").count(),
    0,
    "empty mission must not render a dependency list",
  );
  depEqual(
    await emptyDependencyRegion
      .getByRole("button", { name: /定位任务/ })
      .count(),
    0,
    "empty mission must not render locate buttons",
  );

  // 返回主项目：跨页导航后视图与事实源一致
  await page.goto(`${baseUrl}/projects/${missionState.projectId}`, {
    waitUntil: "networkidle",
  });
  await page
    .getByRole("heading", { name: "Context Smoke Mission" })
    .waitFor();
  const refreshedDependencies = page.getByRole("region", { name: "依赖全景" });
  await refreshedDependencies
    .getByRole("list", { name: "任务依赖关系" })
    .waitFor();
  depEqual(
    await refreshedDependencies.getByRole("listitem").count(),
    4,
    "dependency insight must stay consistent with the fact source after navigation",
  );
  await refreshedDependencies
    .getByText("前置依赖未完成：待办 2 项", { exact: true })
    .waitFor();
  console.log(
    "DEPENDENCY PANEL PASS: chain+diamond nodes, blocked reason, relations, locate navigation, empty state, refresh consistency",
  );

  const rightPanel = page.locator(".cockpit-context");
  await createMemory(rightPanel, {
    type: "目标",
    content: "Initial context goal",
    sourceType: "owner_input",
    sourceRef: "Owner baseline",
  });
  await createMemory(rightPanel, {
    type: "目标",
    content: "Current context goal",
    sourceType: "owner_input",
    sourceRef: "Owner revision",
    supersedes: "Initial context goal",
  });
  await createMemory(rightPanel, {
    type: "决策",
    content: "Use deterministic transitions",
    sourceType: "owner_input",
    sourceRef: "Owner decision",
  });
  await createMemory(rightPanel, {
    type: "事实",
    content: "Plan task started",
    sourceType: "work_item",
    sourceRef: planId,
  });
  await createMemory(rightPanel, {
    type: "产物",
    content: "Acceptance report",
    sourceType: "artifact_path",
    sourceRef: "docs/context-report.md",
  });
  await rightPanel.getByText("仅引用，尚未读取", { exact: true }).waitFor();

  await rightPanel.getByRole("tab", { name: "上下文预览" }).click();
  const memberSelect = rightPanel.getByLabel("预览成员");
  await selectOptionContaining(memberSelect, "Context Planner");
  const sharedRegion = rightPanel.getByRole("region", {
    name: "共享项目上下文",
  });
  await sharedRegion.waitFor();
  const plannerSharedText = await sharedRegion.textContent();
  await selectOptionContaining(memberSelect, "Context Builder");
  await rightPanel
    .getByRole("region", { name: "当前 Agent 私有配置" })
    .getByRole("heading", { name: "Context Builder" })
    .waitFor();
  const builderSharedText = await sharedRegion.textContent();
  assert.equal(builderSharedText, plannerSharedText);

  const snapshots = await page.evaluate(
    async ({ projectId }) => {
      const memberState = await (
        await fetch(`/api/projects/${projectId}/members`)
      ).json();
      return Promise.all(
        memberState.members.map(async (member) => ({
          agentId: member.agentId,
          snapshot: await (
            await fetch(
              `/api/projects/${projectId}/context?agentId=${member.agentId}`,
            )
          ).json(),
        })),
      );
    },
    { projectId: missionState.projectId },
  );
  assert.deepEqual(snapshots[0].snapshot.shared, snapshots[1].snapshot.shared);
  console.log("SHARED SNAPSHOT PASS: two member shared sections deeply equal");

  await page.evaluate(
    async ({ projectId, path }) => {
      await fetch(`/api/projects/${projectId}/workspace`, {
        body: `{"path":"${path}"`,
        headers: { "content-type": "application/json" },
        method: "PUT",
      });
    },
    { projectId: missionState.projectId, path: boundWorkspacePath },
  );

  await page.screenshot({ fullPage: true, path: desktopScreenshot });
  await page.screenshot({ fullPage: true, path: demoScreenshot });

  await page.reload({ waitUntil: "networkidle" });
  await page
    .getByRole("heading", { name: "Context Smoke Mission" })
    .waitFor();
  const persistedBoard = page
    .getByTestId("editor-surface")
    .getByRole("region", { name: "使命任务看板" });
  for (const title of ["Plan task", "Build task", "Test task", "Ship task"]) {
    await persistedBoard
      .getByRole("heading", { exact: true, name: title })
      .waitFor();
  }
  await page
    .locator(".cockpit-context")
    .getByRole("heading", { name: "Current context goal" })
    .waitFor();
  console.log("PERSISTENCE PASS: project context survived refresh");

  await page.setViewportSize({ height: 844, width: 390 });
  await page.reload({ waitUntil: "networkidle" });
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  });
  // 活动栏（设置/主题）在 DOM 中先于移动工具栏，Tab 序会经过其控件；
  // 此处验收三个抽屉入口按序键盘可达，而非钉死绝对 Tab 位次。
  async function tabUntilFocused(locator, label, attempts = 16) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const focused = await locator
        .evaluate((element) => document.activeElement === element)
        .catch(() => false);
      if (focused) return;
      await page.keyboard.press("Tab");
    }
    assert.ok(
      await locator.evaluate((element) => document.activeElement === element),
      `${label} must be reachable by keyboard Tab`,
    );
  }
  const projectsOpener = page.getByRole("button", {
    name: "打开项目导航",
  });
  await tabUntilFocused(projectsOpener, "打开项目导航");
  const editorOpener = page.getByRole("button", { name: "打开编辑" });
  await tabUntilFocused(editorOpener, "打开编辑");
  const contextOpener = page.getByRole("button", {
    name: "打开当前任务上下文",
  });
  await tabUntilFocused(contextOpener, "打开当前任务上下文");

  await projectsOpener.click();
  const projectsDialog = page.getByRole("dialog", { name: "项目导航" });
  await projectsDialog.waitFor();
  assert.notEqual(
    await page.getByTestId("editor-surface").getAttribute("inert"),
    null,
  );
  const narrowWorkspaceInput = projectsDialog.getByLabel(
    "本地工作区路径",
  );
  await narrowWorkspaceInput.fill(reboundWorkspaceDirectory);
  const rebindOpener = projectsDialog.getByRole("button", {
    name: "保存工作区",
  });
  await rebindOpener.click();
  let rebindConfirmation = page.getByRole("dialog", {
    name: "确认改绑工作区",
  });
  await rebindConfirmation.waitFor();
  assert.equal(
    await page.locator('[aria-modal="true"]').count(),
    1,
  );
  assert.equal(
    await rebindConfirmation
      .getByRole("button", { name: "确认改绑" })
      .evaluate((element) => document.activeElement === element),
    true,
  );
  await rebindConfirmation.getByRole("button", { name: "取消" }).click();
  await rebindConfirmation.waitFor({ state: "detached" });
  assert.equal(await page.locator('[aria-modal="true"]').count(), 1);
  assert.equal(
    await rebindOpener.evaluate(
      (element) => document.activeElement === element,
    ),
    true,
  );

  await rebindOpener.click();
  rebindConfirmation = page.getByRole("dialog", {
    name: "确认改绑工作区",
  });
  await rebindConfirmation.getByRole("button", { name: "确认改绑" }).click();
  await rebindConfirmation.waitFor({ state: "detached" });
  reboundWorkspacePath =
    (await projectsDialog
      .getByLabel("工作区绑定状态")
      .locator("code")
      .textContent()) ?? reboundWorkspacePath;
  assert.equal(await page.locator('[aria-modal="true"]').count(), 1);
  await page.keyboard.press("Escape");
  await projectsDialog.waitFor({ state: "detached" });
  assert.equal(
    await projectsOpener.evaluate(
      (element) => document.activeElement === element,
    ),
    true,
  );

  // --- 027 T-04 narrow：改绑后工作区浏览关键路径（narrow light） ---
  await projectsOpener.click();
  const browseProjectsDialog = page.getByRole("dialog", { name: "项目导航" });
  await browseProjectsDialog.waitFor();
  const narrowTree = browseProjectsDialog.getByRole("tree", {
    name: "工作区文件",
  });
  await narrowTree.waitFor();
  browseDeepEqual(
    await narrowTree.locator(".workspace-tree-name").allTextContents(),
    ["rebound-notes.txt"],
    "narrow drawer tree must reflect the rebound workspace root",
  );
  await narrowTree
    .getByRole("treeitem", { exact: true, name: "rebound-notes.txt" })
    .click();
  const narrowPreview = browseProjectsDialog.getByRole("region", {
    name: "文件预览",
  });
  const narrowPreviewContent = narrowPreview.locator(
    ".workspace-preview-content",
  );
  await narrowPreviewContent.waitFor();
  browseOk(
    ((await narrowPreviewContent.textContent()) ?? "").includes(
      "改绑后的工作区笔记。",
    ),
    "narrow drawer must preview a file from the rebound workspace",
  );
  browseDeepEqual(
    await narrowTree.getByRole("treeitem").evaluateAll((items) =>
      items
        .map((item) => item.getBoundingClientRect())
        .filter((rect) => rect.height < 44),
    ),
    [],
    "narrow tree items must be at least 44px tall",
  );
  await axeWorkspaceBrowse(page, "narrow light workspace browse drawer");
  browseAcceptance.matrix.push("narrow-light");
  await page.screenshot({ fullPage: true, path: browseNarrowLightScreenshot });
  await page.keyboard.press("Escape");
  await browseProjectsDialog.waitFor({ state: "detached" });

  // 暗色窄屏关键路径复核（抽屉外切换主题，避免 inert 背景）
  await setCockpitTheme(page, "dark");
  await projectsOpener.click();
  const browseProjectsDialogDark = page.getByRole("dialog", {
    name: "项目导航",
  });
  await browseProjectsDialogDark.waitFor();
  const narrowTreeDark = browseProjectsDialogDark.getByRole("tree", {
    name: "工作区文件",
  });
  await narrowTreeDark.waitFor();
  browseDeepEqual(
    await narrowTreeDark.locator(".workspace-tree-name").allTextContents(),
    ["rebound-notes.txt"],
    "narrow dark drawer must keep the rebound workspace tree",
  );
  await axeWorkspaceBrowse(page, "narrow dark workspace browse drawer");
  browseAcceptance.matrix.push("narrow-dark");
  await page.screenshot({ fullPage: true, path: browseNarrowDarkScreenshot });
  await page.keyboard.press("Escape");
  await browseProjectsDialogDark.waitFor({ state: "detached" });
  await setCockpitTheme(page, "light");
  console.log(
    "WORKSPACE BROWSE NARROW PASS: rebound tree + preview in drawer, 44px, axe",
  );

  await editorOpener.click();
  const editorDialog = page.getByRole("dialog", { name: "任务编辑" });
  await editorDialog.getByRole("tab", { name: "看板" }).click();
  await editorDialog
    .getByRole("heading", { name: "Context Smoke Mission" })
    .waitFor();
  assert.equal(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
    true,
  );

  // 026 T-03 narrow 矩阵：依赖全景在窄屏编辑抽屉内完整可达
  const narrowDependencies = editorDialog.getByRole("region", {
    name: "依赖全景",
  });
  await narrowDependencies
    .getByRole("list", { name: "任务依赖关系" })
    .waitFor();
  depEqual(
    await narrowDependencies.getByRole("listitem").count(),
    4,
    "narrow drawer must render all four dependency nodes",
  );
  await narrowDependencies
    .getByText("前置依赖未完成：待办 2 项", { exact: true })
    .waitFor();
  depDeepEqual(
    await undersizedButtons(narrowDependencies),
    [],
    "narrow dependency buttons must be at least 44x44px",
  );
  await axeDependencies(page, "narrow light mission dependency drawer");
  dependencyAcceptance.matrix.push("narrow-light");
  await page.screenshot({
    fullPage: true,
    path: dependencyNarrowLightScreenshot,
  });
  await page.keyboard.press("Escape");
  await editorDialog.waitFor({ state: "detached" });

  // 暗色窄屏关键路径复核（抽屉外切换主题，避免 inert 背景）
  await setCockpitTheme(page, "dark");
  await editorOpener.click();
  const editorDialogDark = page.getByRole("dialog", { name: "任务编辑" });
  await editorDialogDark.getByRole("tab", { name: "看板" }).click();
  const narrowDependenciesDark = editorDialogDark.getByRole("region", {
    name: "依赖全景",
  });
  await narrowDependenciesDark
    .getByRole("list", { name: "任务依赖关系" })
    .waitFor();
  await narrowDependenciesDark
    .getByText("前置依赖未完成：待办 2 项", { exact: true })
    .waitFor();
  await axeDependencies(page, "narrow dark mission dependency drawer");
  dependencyAcceptance.matrix.push("narrow-dark");
  await page.screenshot({
    fullPage: true,
    path: dependencyNarrowDarkScreenshot,
  });
  await page.keyboard.press("Escape");
  await editorDialogDark.waitFor({ state: "detached" });
  await setCockpitTheme(page, "light");

  await contextOpener.click();
  const contextDialog = page.getByRole("dialog", {
    name: "当前任务上下文",
  });
  await contextDialog.waitFor();
  const memoryTab = contextDialog.getByRole("tab", { name: "共享记忆" });
  await memoryTab.focus();
  await page.keyboard.press("End");
  assert.equal(
    await contextDialog
      .getByRole("tab", { name: "骨架运行" })
      .getAttribute("aria-selected"),
    "true",
  );
  await page.keyboard.press("Home");
  assert.equal(await memoryTab.getAttribute("aria-selected"), "true");
  await page.screenshot({ fullPage: true, path: narrowScreenshot });
  await page.keyboard.press("Escape");
  await contextDialog.waitFor({ state: "detached" });
  assert.equal(
    await contextOpener.evaluate(
      (element) => document.activeElement === element,
    ),
    true,
  );

  const auditOperations = readFileSync(auditPath, "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line).operation);
  assert.deepEqual(auditOperations, [
    "realpath",
    "stat",
    "access",
    "realpath",
    "stat",
    "access",
  ]);
  const operationAudit = {
    access: auditOperations.filter((operation) => operation === "access")
      .length,
    contentRead: 0,
    enumerate: 0,
    exec: 0,
    realpath: auditOperations.filter((operation) => operation === "realpath")
      .length,
    stat: auditOperations.filter((operation) => operation === "stat").length,
    write: 0,
  };
  assert.deepEqual(operationAudit, {
    access: 2,
    contentRead: 0,
    enumerate: 0,
    exec: 0,
    realpath: 2,
    stat: 2,
    write: 0,
  });
  console.log(
    `AUDIT PASS: ${JSON.stringify(operationAudit)}; content read/enumerate/write/exec=0`,
  );

  const serializedSnapshots = JSON.stringify(snapshots);
  const providerSecrets = [
    testApiKey,
    masterKey,
    validationToken,
    providerBaseUrl,
  ];
  for (const secret of providerSecrets) {
    assert.equal(countOccurrences(serializedSnapshots, secret), 0);
    assert.equal(countOccurrences(projectResponseBodies.join("\n"), secret), 0);
    assert.equal(countOccurrences(serverOutput, secret), 0);
  }
  // 027 T-04：.env canary 绝不出现在任何项目 API 响应或服务端日志
  assert.equal(
    countOccurrences(projectResponseBodies.join("\n"), browseCanary),
    0,
  );
  assert.equal(countOccurrences(serverOutput, browseCanary), 0);
  console.log(
    "WORKSPACE BROWSE SECURITY PASS: .env canary=0 across project API responses and server logs",
  );
  for (const path of new Set([
    workspaceDirectory,
    boundWorkspacePath,
    reboundWorkspaceDirectory,
    reboundWorkspacePath,
  ])) {
    assert.equal(countOccurrences(serverOutput, path), 0);
    assert.equal(countOccurrences(errorResponseBodies.join("\n"), path), 0);
  }
  for (const entry of snapshots) {
    assert.equal(
      entry.snapshot.shared.project.workspacePath,
      boundWorkspacePath,
    );
  }
  console.log(
    "SECURITY PASS: provider secrets=0 across snapshots/project responses/logs; full path=0 in errors/logs and allowlisted in workspace snapshots",
  );

  const database = new DatabaseSync(databasePath, { readOnly: true });
  const counts = Object.fromEntries(
    [
      "providers",
      "agents",
      "projects",
      "project_memberships",
      "missions",
      "work_items",
      "memory_entries",
    ].map((table) => [
      table,
      database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count,
    ]),
  );
  database.close();
  assert.deepEqual(counts, {
    agents: 2,
    memory_entries: 5,
    missions: 2,
    project_memberships: 2,
    projects: 2,
    providers: 1,
    work_items: 4,
  });

  writeFileSync(
    dependencyResultsPath,
    `${JSON.stringify(dependencyAcceptance, null, 2)}\n`,
    "utf8",
  );
  console.log(
    `DEPENDENCY ACCEPTANCE PASS: assertions=${dependencyAcceptance.assertions} axeStates=${dependencyAcceptance.axe.length} matrix=${dependencyAcceptance.matrix.join(",")}`,
  );

  writeFileSync(
    browseResultsPath,
    `${JSON.stringify(browseAcceptance, null, 2)}\n`,
    "utf8",
  );
  console.log(
    `WORKSPACE BROWSE ACCEPTANCE PASS: assertions=${browseAcceptance.assertions} axeStates=${browseAcceptance.axe.length} matrix=${browseAcceptance.matrix.join(",")}`,
  );

  console.log("BROWSER PASS: full S-3 desktop and narrow acceptance completed");
  console.log(`SMOKE SCREENSHOT: ${desktopScreenshot}`);
  console.log(`NARROW SCREENSHOT: ${narrowScreenshot}`);
  console.log(`DEMO SCREENSHOT: ${demoScreenshot}`);
} finally {
  await browser?.close();
  stopAppServer();
  if (provider.listening) await close(provider);
  rmSync(temporaryDirectory, { force: true, recursive: true });
}
