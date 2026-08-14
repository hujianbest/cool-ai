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
const emptyWorkspaceDirectory = join(
  temporaryDirectory,
  "context-empty-workspace",
);
mkdirSync(emptyWorkspaceDirectory);
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
mkdirSync(join(workspaceDirectory, "features", "demo-sop"), { recursive: true });
writeFileSync(
  join(workspaceDirectory, "features", "demo-sop", "progress.md"),
  ["- 特性: 演示 SOP", "- 当前阶段: implement", ""].join("\n"),
  "utf8",
);
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

// --- 043 T-03：SOP 状态投影验收助手 ---
const sopAcceptance = { assertions: 0 };

function sopOk(value, message) {
  sopAcceptance.assertions += 1;
  assert.ok(value, message);
}

function sopEqual(actual, expected, message) {
  sopAcceptance.assertions += 1;
  assert.equal(actual, expected, message);
}

function sopDeepEqual(actual, expected, message) {
  sopAcceptance.assertions += 1;
  assert.deepEqual(actual, expected, message);
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
  await page.getByLabel("文件夹路径").fill(workspaceDirectory);
  await page
    .locator("form")
    .filter({ has: page.getByLabel("文件夹路径") })
    .getByRole("button", { name: "打开文件夹" })
    .click();
  await page.waitForURL(/\/projects\/[^/]+$/);
  await page
    .getByRole("heading", { name: "real-workspace" })
    .waitFor();

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
    ["assets", "docs", "features", ".env", "app.bin", "large.txt", "notes.txt"],
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
    ["assets", "docs", "inner", "guide.md", "features", ".env", "app.bin", "large.txt", "notes.txt"],
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
    const projectId = new URL(window.location.href).pathname.split("/").at(-1);
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

  const leaseAcceptance = { assertions: 0 };
  function leaseOk(value, message) {
    leaseAcceptance.assertions += 1;
    assert.ok(value, message);
  }
  const planLeaseCard = page.getByRole("region", { name: "进行中" }).locator("li").filter({
    has: page.getByRole("heading", { exact: true, name: "Plan task" }),
  });
  await planLeaseCard.getByText("租约持有者").waitFor();
  leaseOk(
    (await planLeaseCard.getByText("租约持有者").count()) > 0,
    "in-progress Plan task must show 租约持有者",
  );
  const releaseLease = planLeaseCard.getByRole("button", { name: "释放租约" });
  leaseOk(await releaseLease.isEnabled(), "释放租约 must be enabled");
  const releaseLeaseBox = await releaseLease.boundingBox();
  leaseOk(
    releaseLeaseBox !== null
      && releaseLeaseBox.height >= 44
      && releaseLeaseBox.width >= 44,
    "释放租约 must be at least 44x44",
  );
  leaseOk(
    await planLeaseCard.getByRole("button", { name: "回收过期租约" }).isDisabled(),
    "回收过期租约 must stay disabled while the lease is live",
  );
  const planLeaseText = await planLeaseCard.innerText();
  leaseOk(
    !planLeaseText.includes(workspaceDirectory)
      && !planLeaseText.includes(canonicalWorkspace)
      && !planLeaseText.includes(boundWorkspacePath),
    "lease copy must not leak host workspace paths",
  );
  console.log(
    `WORK ITEM LEASE ACCEPTANCE PASS: assertions=${leaseAcceptance.assertions}`,
  );

  const missionState = await page.evaluate(async () => {
    const projectId = new URL(window.location.href).pathname.split("/").at(-1);
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
    const projectId = new URL(window.location.href).pathname.split("/").at(-1);
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

  // --- 043 T-03：SOP 状态投影（既有绑定工作区 + 既有 mission 页；复用随后 axe） ---
  const sopRegion = page.getByRole("region", { name: "流程状态" });
  await sopRegion.waitFor();
  sopOk(await sopRegion.isVisible(), "SOP region 流程状态 must be visible");
  await sopRegion
    .getByText("features/demo-sop/progress.md", { exact: true })
    .waitFor();
  sopEqual(
    await sopRegion
      .getByText("features/demo-sop/progress.md", { exact: true })
      .count(),
    1,
    "SOP source must be the workspace-relative progress path",
  );
  sopEqual(
    await sopRegion.getByText("implement", { exact: true }).count(),
    1,
    "SOP declared stage must be implement",
  );
  sopEqual(
    await sopRegion.getByText("未发现流程文件。", { exact: true }).count(),
    0,
    "bound project must not show SOP empty copy",
  );
  sopEqual(
    await sopRegion
      .getByText("未绑定工作区，无法读取流程文件。", { exact: true })
      .count(),
    0,
    "bound project must not show SOP unbound copy",
  );
  const sopText = await sopRegion.innerText();
  sopOk(
    !sopText.includes(workspaceDirectory)
      && !sopText.includes(canonicalWorkspace)
      && !sopText.includes(boundWorkspacePath),
    "SOP region must not leak host workspace paths",
  );
  const sopHeadingBox = await sopRegion
    .getByRole("heading", { name: "流程状态" })
    .boundingBox();
  const sopRegionBox = await sopRegion.boundingBox();
  sopOk(
    (sopHeadingBox
      && sopHeadingBox.height >= 44
      && sopHeadingBox.width >= 44)
      || (sopRegionBox
        && sopRegionBox.height >= 44
        && sopRegionBox.width >= 44),
    "SOP heading or region must be at least 44x44",
  );
  sopDeepEqual(
    await undersizedButtons(sopRegion),
    [],
    "SOP controls must be at least 44x44px",
  );
  console.log(
    `SOP STATE ACCEPTANCE PASS: assertions=${sopAcceptance.assertions}`,
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
  await page.getByLabel("文件夹路径").fill(emptyWorkspaceDirectory);
  await page
    .locator("form")
    .filter({ has: page.getByLabel("文件夹路径") })
    .getByRole("button", { name: "打开文件夹" })
    .click();
  await page.waitForURL(/\/projects\/[^/]+$/);
  await page
    .getByRole("heading", { name: "context-empty-workspace" })
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
      .getByRole("tab", { name: "审计" })
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

  // ---- MISSION-WORK AUDIT ACCEPTANCE (feature 035 T-03) ----
  // Landing spot: smoke:context already produces the richest real
  // mission/work-item facts (026 section above); the task-run lifecycle is
  // seeded here through the public API (the deterministic executor always
  // completes, so task_failed rendering stays jsdom-covered). The copy map
  // mirrors components/project-context/audit-panel.tsx exactly.
  const missionWorkAuditAcceptance = { assertions: 0, axe: [], matrix: [] };
  const missionWorkAuditOk = (value, message) => {
    missionWorkAuditAcceptance.assertions += 1;
    assert.ok(value, message);
  };
  const missionWorkAuditEqual = (actual, expected, message) => {
    missionWorkAuditAcceptance.assertions += 1;
    assert.equal(actual, expected, message);
  };
  const axeMissionWorkAudit = async (state) => {
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
    missionWorkAuditAcceptance.axe.push({
      blocking,
      state,
      violationCount: scan.violations.length,
    });
    assert.deepEqual(blocking, [], `${state}: axe critical/serious must be 0`);
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
  // Mirrors PROJECT_WORKSPACE_EVENT_TYPE_COPY in
  // components/project-context/audit-panel.tsx exactly (feature 036).
  const PROJECT_WORKSPACE_AUDIT_EVENT_TYPE_COPY = {
    member_joined: "成员已加入",
    member_removed: "成员已移除",
    project_created: "项目已创建",
    validation_policy_changed: "验证政策已变更",
    workspace_bound: "工作区已绑定",
    workspace_rebound: "工作区已改绑",
  };
  const missionWorkEvidenceDirectory = resolve(
    "features",
    "035-mission-work-audit-events",
    "evidence",
  );
  mkdirSync(missionWorkEvidenceDirectory, { recursive: true });
  const missionWorkAuditDesktopScreenshot = join(
    missionWorkEvidenceDirectory,
    "mission-work-audit-desktop.png",
  );
  const missionWorkAuditDarkScreenshot = join(
    missionWorkEvidenceDirectory,
    "mission-work-audit-dark.png",
  );
  const missionWorkAuditNarrowScreenshot = join(
    missionWorkEvidenceDirectory,
    "mission-work-audit-narrow.png",
  );
  const missionWorkAuditResultsPath = join(
    missionWorkEvidenceDirectory,
    "mission-work-audit-acceptance.json",
  );

  const seededTask = await page.evaluate(async (projectId) => {
    const create = await fetch(`/api/projects/${projectId}/tasks`, {
      body: JSON.stringify({ goal: "审计验收骨架任务" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const created = await create.json();
    if (!create.ok) return { status: create.status };
    const start = await fetch(`/api/tasks/${created.task.id}/start`, {
      method: "POST",
    });
    if (!start.ok) return { status: start.status };
    const execute = await fetch(`/api/tasks/${created.task.id}/execute`, {
      method: "POST",
    });
    const executed = await execute.json();
    if (!execute.ok) return { status: execute.status };
    return { status: 200, task: executed.task };
  }, missionState.projectId);
  missionWorkAuditEqual(
    seededTask.status,
    200,
    "task-run lifecycle seeding must succeed",
  );
  missionWorkAuditEqual(
    seededTask.task.status,
    "completed",
    "deterministic executor must complete the task",
  );
  const seededTaskId = seededTask.task.id;

  const missionWorkAuditApi = await page.evaluate(async (projectId) => {
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
  }, missionState.projectId);
  missionWorkAuditEqual(
    missionWorkAuditApi.status,
    200,
    JSON.stringify(missionWorkAuditApi.error),
  );
  missionWorkAuditEqual(
    missionWorkAuditApi.pages.length,
    1,
    "all mission-work events must fit on a single page",
  );
  // Feature 036: this trail is now mixed — project/workspace facts
  // (project_created, workspace_bound, member_joined, workspace_rebound)
  // legitimately share the project-scoped feed. The full list drives
  // ordering/DOM counts; mission-work assertions filter by source type set.
  const auditEvents = missionWorkAuditApi.pages.flatMap(
    ({ events }) => events,
  );
  const missionWorkAuditEvents = auditEvents.filter((event) =>
    Object.hasOwn(MISSION_WORK_AUDIT_EVENT_TYPE_COPY, event.eventType));
  const projectWorkspaceAuditEvents = auditEvents.filter((event) =>
    Object.hasOwn(PROJECT_WORKSPACE_AUDIT_EVENT_TYPE_COPY, event.eventType));
  missionWorkAuditOk(
    missionWorkAuditEvents.length > 0,
    "real mission/work facts must produce audit events",
  );
  missionWorkAuditEqual(
    missionWorkAuditApi.pages[0].freshness.status,
    "caught_up",
    JSON.stringify(missionWorkAuditApi.pages[0].freshness),
  );
  for (let index = 1; index < auditEvents.length; index += 1) {
    missionWorkAuditOk(
      auditEvents[index - 1].outboxSeq
        > auditEvents[index].outboxSeq,
      "audit events must be globally descending by outbox_seq",
    );
  }
  // This smoke runs no execution/collaboration work, so every projected event
  // is mission-work or project-workspace sourced.
  for (const event of auditEvents) {
    missionWorkAuditOk(
      Object.hasOwn(MISSION_WORK_AUDIT_EVENT_TYPE_COPY, event.eventType)
        || Object.hasOwn(PROJECT_WORKSPACE_AUDIT_EVENT_TYPE_COPY, event.eventType),
      `unexpected event type ${event.eventType}`,
    );
    missionWorkAuditEqual(event.executionId, null);
  }
  const missionWorkEventTypes = new Set(
    missionWorkAuditEvents.map((event) => event.eventType),
  );
  for (const required of [
    "mission_created",
    "task_completed",
    "task_created",
    "task_started",
    "work_item_created",
    "work_item_status_changed",
  ]) {
    missionWorkAuditOk(
      missionWorkEventTypes.has(required),
      `audit trail must include ${required}`,
    );
  }
  const missionCreatedEvent = missionWorkAuditEvents.find(
    (event) => event.eventType === "mission_created",
  );
  missionWorkAuditEqual(
    missionCreatedEvent.payload.title,
    "Context Smoke Mission",
    "mission excerpt must be verbatim",
  );
  missionWorkAuditEqual(
    missionCreatedEvent.payload.missionId,
    missionState.state.mission.id,
  );
  const planTransitionEvent = missionWorkAuditEvents.find(
    (event) => event.eventType === "work_item_status_changed",
  );
  missionWorkAuditEqual(planTransitionEvent.payload.workItemId, planId);
  missionWorkAuditEqual(
    planTransitionEvent.payload.title,
    "Plan task",
    "work item excerpt must be verbatim",
  );
  missionWorkAuditEqual(planTransitionEvent.payload.fromStatus, "todo");
  missionWorkAuditEqual(planTransitionEvent.payload.toStatus, "in_progress");
  // The rejected Build-task start (dependency guard) must not enter the trail.
  missionWorkAuditOk(
    !missionWorkAuditEvents.some(
      (event) =>
        event.eventType === "work_item_status_changed"
        && event.payload.title === "Build task",
    ),
    "rejected transitions must not produce audit rows",
  );
  const seededTaskEvents = missionWorkAuditEvents.filter(
    (event) => event.payload.taskId === seededTaskId,
  );
  missionWorkAuditEqual(
    seededTaskEvents.length,
    3,
    "task lifecycle must mirror created/started/completed",
  );
  missionWorkAuditEqual(
    seededTaskEvents[0].eventType,
    "task_completed",
    "latest task event must sort first",
  );
  missionWorkAuditEqual(
    seededTaskEvents[0].payload.title,
    "审计验收骨架任务",
    "task excerpt must be verbatim",
  );
  // The second project's facts must stay isolated from this project's trail.
  missionWorkAuditOk(
    !auditEvents.some((event) => event.payload.title === "Empty Mission"),
    "cross-project mission events must stay isolated",
  );
  missionWorkAuditOk(
    !auditEvents.some(
      (event) => event.payload.projectName === "context-empty-workspace",
    ),
    "cross-project project events must stay isolated",
  );
  const missionWorkAuditApiText = JSON.stringify(missionWorkAuditApi.pages);
  for (const value of [
    testApiKey,
    masterKey,
    `Bearer ${testApiKey}`,
    validationToken,
    temporaryDirectory,
    workspaceDirectory,
    boundWorkspacePath,
    reboundWorkspaceDirectory,
    reboundWorkspacePath,
    "Authorization:",
  ]) {
    missionWorkAuditOk(
      !missionWorkAuditApiText.includes(value),
      "audit API payload leaked a forbidden marker",
    );
  }
  const foreignMissionWorkAudit = await page.evaluate(async () => {
    const response = await fetch("/api/projects/foreign-project/audit-events", {
      cache: "no-store",
    });
    return { body: await response.json(), status: response.status };
  });
  missionWorkAuditEqual(
    foreignMissionWorkAudit.status,
    404,
    "foreign project audit read must 404",
  );
  missionWorkAuditOk(
    !JSON.stringify(foreignMissionWorkAudit.body).includes(temporaryDirectory),
    "404 envelope must not echo host paths",
  );
  // Row counts are project-scoped (the API is project-scoped): the second
  // project's "Empty Mission" row legitimately lives in the same global
  // outbox, while checkpoint/maxSeq stay global consumer facts.
  const missionWorkAuditCounts = (() => {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const scalar = (sql, ...params) =>
        Number(database.prepare(sql).get(...params).value);
      return {
        checkpoint: scalar(
          "SELECT last_outbox_seq AS value FROM audit_projection_checkpoints"
            + " WHERE consumer_id='audit-event-projection'",
        ),
        maxSeq: scalar(
          "SELECT COALESCE(MAX(outbox_seq),0) AS value FROM audit_event_outbox",
        ),
        missionWork: scalar(
          "SELECT COUNT(*) AS value FROM audit_event_outbox"
            + " WHERE source='mission_work' AND project_id=?",
          missionState.projectId,
        ),
        outbox: scalar(
          "SELECT COUNT(*) AS value FROM audit_event_outbox WHERE project_id=?",
          missionState.projectId,
        ),
        projection: scalar(
          "SELECT COUNT(*) AS value FROM audit_event_projection WHERE project_id=?",
          missionState.projectId,
        ),
      };
    } finally {
      database.close();
    }
  })();
  missionWorkAuditEqual(
    missionWorkAuditCounts.outbox,
    auditEvents.length,
    "API must expose every project outbox event",
  );
  missionWorkAuditEqual(
    missionWorkAuditCounts.missionWork,
    missionWorkAuditEvents.length,
    "mission-work source count must match the filtered API events",
  );
  missionWorkAuditEqual(
    missionWorkAuditCounts.missionWork + projectWorkspaceAuditEvents.length,
    auditEvents.length,
    "mission-work + project-workspace events must partition the trail",
  );
  missionWorkAuditEqual(
    missionWorkAuditCounts.projection,
    missionWorkAuditCounts.outbox,
    "read path must catch up the projection",
  );
  missionWorkAuditEqual(
    missionWorkAuditCounts.checkpoint,
    missionWorkAuditCounts.maxSeq,
    "checkpoint must be caught up",
  );
  console.log(
    `MISSION-WORK AUDIT API PASS: events=${missionWorkAuditEvents.length}, single page, outbox==projection==API, checkpoint caught up, foreign 404`,
  );

  // Desktop: reload before asserting the panel (A-237 — the API-side seeding
  // bypasses any mounted panel), then exercise the audit tab end to end.
  await page.setViewportSize({ height: 1100, width: 1600 });
  await page.reload({ waitUntil: "networkidle" });
  const missionWorkContextPanel = page.locator(".cockpit-context");
  await missionWorkContextPanel
    .getByRole("tab", { name: "共享记忆" })
    .focus();
  await page.keyboard.press("End");
  const missionWorkAuditTab = missionWorkContextPanel.getByRole("tab", {
    name: "审计",
  });
  missionWorkAuditEqual(
    await missionWorkAuditTab.getAttribute("aria-selected"),
    "true",
    "End key must select the audit tab",
  );
  missionWorkAuditOk(
    await missionWorkAuditTab.evaluate(
      (node) => document.activeElement === node,
    ),
    "End key must move focus to the audit tab",
  );
  const missionWorkAuditList = missionWorkContextPanel.getByRole("list", {
    name: "审计事件",
  });
  await missionWorkAuditList.waitFor();
  await missionWorkContextPanel
    .getByText("已追平", { exact: true })
    .waitFor();
  await page.waitForFunction(
    (expected) =>
      document.querySelectorAll(".audit-event-list > li").length === expected,
    auditEvents.length,
  );
  const missionWorkAuditRows = missionWorkAuditList.getByRole("listitem");
  const firstMissionWorkRow = missionWorkAuditRows.first();
  await firstMissionWorkRow
    .getByRole("heading", { name: "任务已完成" })
    .waitFor();
  missionWorkAuditEqual(
    await firstMissionWorkRow.locator(".audit-event-excerpt").innerText(),
    "审计验收骨架任务",
    "first row must render the verbatim task excerpt",
  );
  missionWorkAuditOk(
    await firstMissionWorkRow
      .getByText("任务", { exact: true })
      .evaluate(
        (node) =>
          node.classList.contains("status-label")
          && node.classList.contains("status-completed"),
      ),
    "first row badge must use the completed status variant",
  );
  missionWorkAuditEqual(
    await missionWorkAuditList.locator(".status-label.status-completed").count(),
    missionWorkAuditEvents.length,
    "every mission-work row must carry the task domain badge",
  );
  missionWorkAuditEqual(
    await missionWorkAuditList
      .locator(".status-label:not(.status-queued):not(.status-running):not(.status-completed):not(.status-failed)")
      .count(),
    projectWorkspaceAuditEvents.length,
    "every project-workspace row must carry the neutral project badge",
  );
  const planLocateLink = missionWorkAuditRows
    .nth(auditEvents.indexOf(planTransitionEvent))
    .getByRole("link", { name: "定位来源任务" });
  missionWorkAuditEqual(
    await planLocateLink.getAttribute("href"),
    `/projects/${missionState.projectId}/tasks/${planId}`,
  );
  const missionLocateLink = missionWorkAuditRows
    .nth(auditEvents.indexOf(missionCreatedEvent))
    .getByRole("link", { name: "定位来源使命" });
  missionWorkAuditEqual(
    await missionLocateLink.getAttribute("href"),
    `/projects/${missionState.projectId}/missions/${missionState.state.mission.id}`,
  );
  const taskLocateLink = firstMissionWorkRow.getByRole("link", {
    name: "定位来源任务",
  });
  missionWorkAuditEqual(
    await taskLocateLink.getAttribute("href"),
    `/projects/${missionState.projectId}/task-runs/${seededTaskId}`,
  );
  const missionWorkAuditTabBox = await missionWorkAuditTab.boundingBox();
  missionWorkAuditOk(
    missionWorkAuditTabBox
      && missionWorkAuditTabBox.height >= 44
      && missionWorkAuditTabBox.width >= 44,
    "audit tab must be at least 44x44",
  );
  const planLocateBox = await planLocateLink.boundingBox();
  missionWorkAuditOk(
    planLocateBox && planLocateBox.height >= 44 && planLocateBox.width >= 44,
    "locate link must be at least 44x44",
  );
  await planLocateLink.focus();
  missionWorkAuditOk(
    (await planLocateLink.evaluate((node) => getComputedStyle(node).boxShadow))
      !== "none",
    "focused locate link must show a visible focus ring",
  );
  await axeMissionWorkAudit("desktop light mission-work audit panel");
  missionWorkAuditAcceptance.matrix.push("desktop-light");
  await page.screenshot({
    fullPage: true,
    path: missionWorkAuditDesktopScreenshot,
  });
  const missionWorkAuditFacingText = await page.locator("html").innerText();
  await setCockpitTheme(page, "dark");
  await missionWorkContextPanel
    .getByText("已追平", { exact: true })
    .waitFor();
  await missionWorkAuditRows
    .first()
    .getByRole("heading", { name: "任务已完成" })
    .waitFor();
  await axeMissionWorkAudit("desktop dark mission-work audit panel");
  missionWorkAuditAcceptance.matrix.push("desktop-dark");
  await page.screenshot({
    fullPage: true,
    path: missionWorkAuditDarkScreenshot,
  });
  await setCockpitTheme(page, "light");
  console.log(
    "MISSION-WORK AUDIT DESKTOP PASS: keyboard End, badge/copy/excerpt, locate hrefs, 44px, focus ring, axe light+dark",
  );

  await page.setViewportSize({ height: 844, width: 390 });
  await page.reload({ waitUntil: "networkidle" });
  const missionWorkContextOpener = page.getByRole("button", {
    name: "打开当前任务上下文",
  });
  await missionWorkContextOpener.focus();
  await page.keyboard.press("Enter");
  const missionWorkContextDrawer = page.getByRole("dialog", {
    name: "当前任务上下文",
  });
  const narrowMissionWorkAuditTab = missionWorkContextDrawer.getByRole("tab", {
    name: "审计",
  });
  await narrowMissionWorkAuditTab.focus();
  await page.keyboard.press("Enter");
  missionWorkAuditEqual(
    await narrowMissionWorkAuditTab.getAttribute("aria-selected"),
    "true",
    "Enter must select the narrow audit tab",
  );
  const narrowMissionWorkAuditList = missionWorkContextDrawer.getByRole(
    "list",
    { name: "审计事件" },
  );
  await narrowMissionWorkAuditList.waitFor();
  await missionWorkContextDrawer
    .getByText("已追平", { exact: true })
    .waitFor();
  await page.waitForFunction(
    (expected) =>
      document.querySelectorAll(".audit-event-list > li").length === expected,
    auditEvents.length,
  );
  const narrowMissionWorkRows = narrowMissionWorkAuditList.getByRole(
    "listitem",
  );
  await narrowMissionWorkRows
    .first()
    .getByRole("heading", { name: "任务已完成" })
    .waitFor();
  missionWorkAuditEqual(
    await narrowMissionWorkRows
      .first()
      .locator(".audit-event-excerpt")
      .innerText(),
    "审计验收骨架任务",
    "narrow drawer must keep the task excerpt",
  );
  const narrowTaskLocate = narrowMissionWorkRows
    .first()
    .getByRole("link", { name: "定位来源任务" });
  missionWorkAuditEqual(
    await narrowTaskLocate.getAttribute("href"),
    `/projects/${missionState.projectId}/task-runs/${seededTaskId}`,
  );
  const narrowTaskLocateBox = await narrowTaskLocate.boundingBox();
  missionWorkAuditOk(
    narrowTaskLocateBox
      && narrowTaskLocateBox.height >= 44
      && narrowTaskLocateBox.width >= 44,
    "narrow locate link must be at least 44x44",
  );
  const narrowMissionWorkTabBox = await narrowMissionWorkAuditTab.boundingBox();
  missionWorkAuditOk(
    narrowMissionWorkTabBox
      && narrowMissionWorkTabBox.height >= 44
      && narrowMissionWorkTabBox.width >= 44,
    "narrow audit tab must be at least 44x44",
  );
  await axeMissionWorkAudit("narrow light mission-work audit drawer");
  missionWorkAuditAcceptance.matrix.push("narrow-light");
  await page.screenshot({
    fullPage: true,
    path: missionWorkAuditNarrowScreenshot,
  });
  const narrowMissionWorkAuditFacingText = await page
    .locator("html")
    .innerText();
  await page.keyboard.press("Escape");
  await missionWorkContextDrawer.waitFor({ state: "detached" });
  missionWorkAuditOk(
    await missionWorkContextOpener.evaluate(
      (node) => document.activeElement === node,
    ),
    "Escape must return focus to the context drawer opener",
  );
  console.log(
    "MISSION-WORK AUDIT NARROW PASS: drawer presentation kept, locate href, 44px, axe",
  );

  // Secret scan: facing text is captured on the project page, which
  // legitimately renders the allowlisted workspace path, so facing text is
  // scanned for fixture secrets only; screenshot bytes are also scanned for
  // host paths (compressed pixels cannot contain page text).
  const missionWorkAuditScreenshotBytes = [
    missionWorkAuditDarkScreenshot,
    missionWorkAuditDesktopScreenshot,
    missionWorkAuditNarrowScreenshot,
  ]
    .map((path) => readFileSync(path).toString("latin1"))
    .join("\n");
  for (const surface of [
    missionWorkAuditFacingText,
    narrowMissionWorkAuditFacingText,
    missionWorkAuditScreenshotBytes,
  ]) {
    for (const secret of [
      testApiKey,
      masterKey,
      `Bearer ${testApiKey}`,
      validationToken,
      providerBaseUrl,
    ]) {
      missionWorkAuditOk(
        !surface.includes(secret),
        "mission-work audit surface leaked a fixture secret",
      );
    }
  }
  for (const hostPath of [
    temporaryDirectory,
    workspaceDirectory,
    boundWorkspacePath,
    reboundWorkspaceDirectory,
    reboundWorkspacePath,
  ]) {
    missionWorkAuditOk(
      !missionWorkAuditScreenshotBytes.includes(hostPath),
      "mission-work audit screenshot bytes leaked a host path",
    );
  }
  writeFileSync(
    missionWorkAuditResultsPath,
    `${JSON.stringify(
      {
        assertions: missionWorkAuditAcceptance.assertions,
        axe: missionWorkAuditAcceptance.axe,
        events: missionWorkAuditEvents.length,
        matrix: missionWorkAuditAcceptance.matrix,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  console.log(
    `MISSION-WORK AUDIT ACCEPTANCE PASS: assertions=${missionWorkAuditAcceptance.assertions} axeStates=${missionWorkAuditAcceptance.axe.length} matrix=${missionWorkAuditAcceptance.matrix.join(",")}`,
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
    access: 3,
    contentRead: 0,
    enumerate: 0,
    exec: 0,
    realpath: 3,
    stat: 3,
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
    project_memberships: 3,
    projects: 3,
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

  // ---- PROJECT-WORKSPACE AUDIT ACCEPTANCE (feature 036 T-03) ----
  // Landing spot: smoke:context already produces real project/workspace facts
  // (project creation, workspace bind + rebind, member joins); the two facts
  // it cannot produce are seeded here through the public API — a temp agent
  // join/remove (both real members carry work-item assignments, so removal
  // needs an unassigned agent) and a saved validation-policy revision. Runs
  // after the table-count assertions above because the temp agent
  // legitimately moves the agents count. The copy map mirrors
  // components/project-context/audit-panel.tsx exactly.
  const projectWorkspaceAuditAcceptance = { assertions: 0, axe: [], matrix: [] };
  const projectAuditOk = (value, message) => {
    projectWorkspaceAuditAcceptance.assertions += 1;
    assert.ok(value, message);
  };
  const projectAuditEqual = (actual, expected, message) => {
    projectWorkspaceAuditAcceptance.assertions += 1;
    assert.equal(actual, expected, message);
  };
  const projectAuditDeepEqual = (actual, expected, message) => {
    projectWorkspaceAuditAcceptance.assertions += 1;
    assert.deepEqual(actual, expected, message);
  };
  const axeProjectWorkspaceAudit = async (state) => {
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
    projectWorkspaceAuditAcceptance.axe.push({
      blocking,
      state,
      violationCount: scan.violations.length,
    });
    assert.deepEqual(blocking, [], `${state}: axe critical/serious must be 0`);
  };
  const projectWorkspaceEvidenceDirectory = resolve(
    "features",
    "036-project-workspace-audit-events",
    "evidence",
  );
  mkdirSync(projectWorkspaceEvidenceDirectory, { recursive: true });
  const projectAuditDesktopScreenshot = join(
    projectWorkspaceEvidenceDirectory,
    "project-workspace-audit-desktop.png",
  );
  const projectAuditDarkScreenshot = join(
    projectWorkspaceEvidenceDirectory,
    "project-workspace-audit-dark.png",
  );
  const projectAuditNarrowScreenshot = join(
    projectWorkspaceEvidenceDirectory,
    "project-workspace-audit-narrow.png",
  );
  const projectAuditResultsPath = join(
    projectWorkspaceEvidenceDirectory,
    "project-workspace-audit-acceptance.json",
  );

  const projectAuditSeed = await page.evaluate(
    async ({ projectId, executable }) => {
      const agentsResponse = await fetch("/api/agents", { cache: "no-store" });
      const agentsBody = await agentsResponse.json();
      if (!agentsResponse.ok) return { stage: "agents", status: agentsResponse.status };
      const planner = agentsBody.agents.find(
        (agent) => agent.name === "Context Planner",
      );
      const createAgent = await fetch("/api/agents", {
        body: JSON.stringify({
          accentToken: planner.accentToken,
          avatarText: planner.avatarText,
          maxHandoffs: planner.maxHandoffs,
          maxTokens: planner.maxTokens,
          model: planner.model,
          name: "Audit Temp Agent",
          permissions: planner.permissions,
          providerId: planner.providerId,
          reviewCapable: planner.reviewCapable,
          role: planner.role,
          skillIds: planner.skillIds,
          systemPrompt: planner.systemPrompt,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const createdAgent = await createAgent.json();
      if (createAgent.status !== 201) {
        return { stage: "create-agent", status: createAgent.status };
      }
      const membersResponse = await fetch(
        `/api/projects/${projectId}/members`,
        { cache: "no-store" },
      );
      const membersState = await membersResponse.json();
      if (!membersResponse.ok) {
        return { stage: "members-get", status: membersResponse.status };
      }
      const currentAgentIds = membersState.members.map(
        (member) => member.agentId,
      );
      const join = await fetch(`/api/projects/${projectId}/members`, {
        body: JSON.stringify({
          agentIds: [...currentAgentIds, createdAgent.agent.id],
          expectedProjectVersion: membersState.projectVersion,
        }),
        headers: { "content-type": "application/json" },
        method: "PUT",
      });
      const joinedState = await join.json();
      if (!join.ok) return { stage: "member-join", status: join.status };
      const remove = await fetch(`/api/projects/${projectId}/members`, {
        body: JSON.stringify({
          agentIds: currentAgentIds,
          expectedProjectVersion: joinedState.projectVersion,
        }),
        headers: { "content-type": "application/json" },
        method: "PUT",
      });
      if (!remove.ok) return { stage: "member-remove", status: remove.status };
      const policyResponse = await fetch(
        `/api/projects/${projectId}/validation-policy`,
        { cache: "no-store" },
      );
      const policyState = await policyResponse.json();
      if (!policyResponse.ok) {
        return { stage: "policy-get", status: policyResponse.status };
      }
      const save = await fetch(
        `/api/projects/${projectId}/validation-policy`,
        {
          body: JSON.stringify({
            entries: [{
              args: ["--version"],
              executable,
              required: false,
              workdir: ".",
            }],
            expectedVersion: policyState.policy.version,
            operationId: crypto.randomUUID(),
            warningAccepted: true,
          }),
          headers: { "content-type": "application/json" },
          method: "PUT",
        },
      );
      const saved = await save.json();
      if (!save.ok) return { stage: "policy-save", status: save.status };
      return {
        agentId: createdAgent.agent.id,
        outcome: saved.outcome,
        reasonCode: saved.reasonCode,
        revisionNo: saved.policy.revisionNo,
        status: 200,
      };
    },
    { executable: process.execPath, projectId: missionState.projectId },
  );
  projectAuditEqual(
    projectAuditSeed.status,
    200,
    `project audit seeding must succeed: ${JSON.stringify(projectAuditSeed)}`,
  );
  projectAuditEqual(
    projectAuditSeed.outcome,
    "saved",
    "policy save must be accepted (node --version is standing-eligible)",
  );

  const projectAuditApi = await page.evaluate(async (projectId) => {
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
  }, missionState.projectId);
  projectAuditEqual(
    projectAuditApi.status,
    200,
    JSON.stringify(projectAuditApi.error),
  );
  projectAuditEqual(
    projectAuditApi.pages.length,
    1,
    "all project events must fit on a single page",
  );
  const projectAuditEvents = projectAuditApi.pages.flatMap(
    ({ events }) => events,
  );
  const projectDomainEvents = projectAuditEvents.filter((event) =>
    Object.hasOwn(PROJECT_WORKSPACE_AUDIT_EVENT_TYPE_COPY, event.eventType));
  projectAuditEqual(
    projectDomainEvents.length,
    8,
    "project domain trail must be created/bound/rebound + 3 joins + 1 remove + 1 policy change",
  );
  projectAuditEqual(
    projectAuditApi.pages[0].freshness.status,
    "caught_up",
    JSON.stringify(projectAuditApi.pages[0].freshness),
  );
  for (const required of Object.keys(PROJECT_WORKSPACE_AUDIT_EVENT_TYPE_COPY)) {
    projectAuditOk(
      projectDomainEvents.some((event) => event.eventType === required),
      `project audit trail must include ${required}`,
    );
  }
  const projectCreatedEvent = projectDomainEvents.find(
    (event) => event.eventType === "project_created",
  );
  projectAuditEqual(
    projectCreatedEvent.payload.projectName,
    "real-workspace",
    "project creation excerpt must be verbatim",
  );
  const boundEvents = projectDomainEvents.filter(
    (event) => event.eventType === "workspace_bound",
  );
  projectAuditEqual(
    boundEvents.length,
    1,
    "the same-path workspace re-assert must not produce a second bound row",
  );
  projectAuditEqual(boundEvents[0].payload.workspaceName, "real-workspace");
  projectAuditEqual(
    boundEvents[0].payload.previousWorkspaceName,
    undefined,
    "initial binding must not carry a previous workspace name",
  );
  const reboundEvent = projectDomainEvents.find(
    (event) => event.eventType === "workspace_rebound",
  );
  projectAuditEqual(reboundEvent.payload.workspaceName, "rebound-real-workspace");
  projectAuditEqual(
    reboundEvent.payload.previousWorkspaceName,
    "real-workspace",
    "rebound must carry the redacted previous basename",
  );
  const joinedNames = projectDomainEvents
    .filter((event) => event.eventType === "member_joined")
    .map((event) => event.payload.agentDisplayName)
    .sort();
  projectAuditDeepEqual(
    joinedNames,
    ["Audit Temp Agent", "Context Builder", "Context Planner"],
    "member joins must carry redacted display names",
  );
  const removedEvents = projectDomainEvents.filter(
    (event) => event.eventType === "member_removed",
  );
  projectAuditEqual(removedEvents.length, 1);
  projectAuditEqual(
    removedEvents[0].payload.agentDisplayName,
    "Audit Temp Agent",
  );
  projectAuditEqual(
    removedEvents[0].payload.agentId,
    projectAuditSeed.agentId,
    "member removal must reference the temp agent id",
  );
  const policyEvent = projectDomainEvents.find(
    (event) => event.eventType === "validation_policy_changed",
  );
  projectAuditEqual(policyEvent.payload.revisionNo, projectAuditSeed.revisionNo);
  projectAuditEqual(policyEvent.payload.entryCount, 1);
  projectAuditEqual(policyEvent.payload.warningAccepted, true);
  projectAuditOk(
    /^[0-9a-f]{64}$/.test(policyEvent.payload.policyHash),
    "policy change must carry the public policy hash",
  );
  projectAuditOk(
    !("executable" in policyEvent.payload)
      && !("workdir" in policyEvent.payload),
    "policy entry executables/workdirs must never enter the payload",
  );
  for (const event of projectDomainEvents) {
    projectAuditEqual(event.actorType, "owner");
    projectAuditEqual(event.executionId, null);
  }
  projectAuditOk(
    !projectAuditEvents.some(
      (event) => event.payload.projectName === "context-empty-workspace",
    ),
    "cross-project project events must stay isolated",
  );
  const projectAuditApiText = JSON.stringify(projectAuditApi.pages);
  for (const value of [
    testApiKey,
    masterKey,
    `Bearer ${testApiKey}`,
    validationToken,
    providerBaseUrl,
    temporaryDirectory,
    workspaceDirectory,
    boundWorkspacePath,
    reboundWorkspaceDirectory,
    reboundWorkspacePath,
    process.execPath,
    "Authorization:",
  ]) {
    projectAuditOk(
      !projectAuditApiText.includes(value),
      `project audit API payload leaked a forbidden marker: ${value.slice(0, 24)}`,
    );
  }
  const foreignProjectAudit = await page.evaluate(async () => {
    const response = await fetch("/api/projects/foreign-project/audit-events", {
      cache: "no-store",
    });
    return { body: await response.json(), status: response.status };
  });
  projectAuditEqual(
    foreignProjectAudit.status,
    404,
    "foreign project audit read must 404",
  );
  projectAuditOk(
    !JSON.stringify(foreignProjectAudit.body).includes(temporaryDirectory),
    "404 envelope must not echo host paths",
  );
  // The second project carries its own project_created fact; both directions
  // of project scoping must hold.
  const emptyProjectAudit = await page.evaluate(async () => {
    const projects = await (await fetch("/api/projects", { cache: "no-store" }))
      .json();
    const empty = projects.projects.find(
      (project) => project.name === "context-empty-workspace",
    );
    const response = await fetch(
      `/api/projects/${empty.id}/audit-events`,
      { cache: "no-store" },
    );
    return { body: await response.json(), status: response.status };
  });
  projectAuditEqual(emptyProjectAudit.status, 200);
  projectAuditDeepEqual(
    emptyProjectAudit.body.events.map((event) => [
      event.eventType,
      event.payload.projectName
        ?? event.payload.title
        ?? event.payload.workspaceName,
    ]),
    [
      ["mission_created", "Empty Mission"],
      ["workspace_bound", "context-empty-workspace"],
      ["project_created", "context-empty-workspace"],
    ],
    "the second project trail must hold only its own facts",
  );
  // Project-scoped counts: the second project's project_created row
  // legitimately lives in the same global outbox, while checkpoint/maxSeq
  // stay global consumer facts.
  const projectAuditCounts = (() => {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const scalar = (sql, ...params) =>
        Number(database.prepare(sql).get(...params).value);
      return {
        checkpoint: scalar(
          "SELECT last_outbox_seq AS value FROM audit_projection_checkpoints"
            + " WHERE consumer_id='audit-event-projection'",
        ),
        maxSeq: scalar(
          "SELECT COALESCE(MAX(outbox_seq),0) AS value FROM audit_event_outbox",
        ),
        outbox: scalar(
          "SELECT COUNT(*) AS value FROM audit_event_outbox WHERE project_id=?",
          missionState.projectId,
        ),
        projectWorkspace: scalar(
          "SELECT COUNT(*) AS value FROM audit_event_outbox"
            + " WHERE source='project_workspace' AND project_id=?",
          missionState.projectId,
        ),
        projection: scalar(
          "SELECT COUNT(*) AS value FROM audit_event_projection WHERE project_id=?",
          missionState.projectId,
        ),
      };
    } finally {
      database.close();
    }
  })();
  projectAuditEqual(
    projectAuditCounts.outbox,
    projectAuditEvents.length,
    "API must expose every project outbox event",
  );
  projectAuditEqual(
    projectAuditCounts.projectWorkspace,
    projectDomainEvents.length,
    "project_workspace source count must match the filtered API events",
  );
  projectAuditEqual(
    projectAuditCounts.projection,
    projectAuditCounts.outbox,
    "read path must catch up the projection",
  );
  projectAuditEqual(
    projectAuditCounts.checkpoint,
    projectAuditCounts.maxSeq,
    "checkpoint must be caught up",
  );
  console.log(
    `PROJECT-WORKSPACE AUDIT API PASS: projectEvents=${projectDomainEvents.length}, single page, six types, redacted basenames/members, outbox==projection==API, foreign 404, cross-project isolation`,
  );

  // Desktop: reload before asserting the panel (A-237 — the API-side seeding
  // bypasses any mounted panel), then exercise the audit tab end to end.
  await page.setViewportSize({ height: 1100, width: 1600 });
  await page.reload({ waitUntil: "networkidle" });
  const projectContextPanel = page.locator(".cockpit-context");
  await projectContextPanel
    .getByRole("tab", { name: "共享记忆" })
    .focus();
  await page.keyboard.press("End");
  const projectAuditTab = projectContextPanel.getByRole("tab", {
    name: "审计",
  });
  projectAuditEqual(
    await projectAuditTab.getAttribute("aria-selected"),
    "true",
    "End key must select the audit tab",
  );
  projectAuditOk(
    await projectAuditTab.evaluate(
      (node) => document.activeElement === node,
    ),
    "End key must move focus to the audit tab",
  );
  const projectAuditList = projectContextPanel.getByRole("list", {
    name: "审计事件",
  });
  await projectAuditList.waitFor();
  await projectContextPanel.getByText("已追平", { exact: true }).waitFor();
  await page.waitForFunction(
    (expected) =>
      document.querySelectorAll(".audit-event-list > li").length === expected,
    projectAuditEvents.length,
  );
  const projectAuditRows = projectAuditList.getByRole("listitem");
  const firstProjectRow = projectAuditRows.first();
  await firstProjectRow
    .getByRole("heading", { name: "验证政策已变更" })
    .waitFor();
  projectAuditEqual(
    await firstProjectRow.locator(".audit-event-excerpt").innerText(),
    `修订 #${projectAuditSeed.revisionNo} · 1 项`,
    "policy row must render the revision/entry-count summary",
  );
  projectAuditOk(
    await firstProjectRow
      .getByText("项目", { exact: true })
      .evaluate(
        (node) =>
          node.classList.contains("status-label")
          && node.classList.length === 1,
      ),
    "project domain badge must use the bare neutral status-label",
  );
  projectAuditEqual(
    await projectAuditList.locator(".status-label.status-completed").count(),
    projectAuditEvents.length - projectDomainEvents.length,
    "mission-work rows must keep the completed status variant",
  );
  projectAuditEqual(
    await projectAuditList
      .locator(".status-label:not(.status-queued):not(.status-running):not(.status-completed):not(.status-failed)")
      .count(),
    projectDomainEvents.length,
    "every project row must carry the neutral project badge",
  );
  const projectCreatedRow = projectAuditRows.nth(
    projectAuditEvents.indexOf(projectCreatedEvent),
  );
  projectAuditEqual(
    await projectCreatedRow.locator(".audit-event-excerpt").innerText(),
    "real-workspace",
    "project creation row must render the verbatim project name",
  );
  const reboundRow = projectAuditRows.nth(
    projectAuditEvents.indexOf(reboundEvent),
  );
  projectAuditEqual(
    await reboundRow.locator(".audit-event-excerpt").innerText(),
    "real-workspace → rebound-real-workspace",
    "rebound row must render redacted basenames only",
  );
  const removedRow = projectAuditRows.nth(
    projectAuditEvents.indexOf(removedEvents[0]),
  );
  await removedRow.getByRole("heading", { name: "成员已移除" }).waitFor();
  projectAuditEqual(
    await removedRow.locator(".audit-event-excerpt").innerText(),
    "Audit Temp Agent",
    "member removal row must render the display name",
  );
  const projectLocateLinks = projectAuditList.getByRole("link", {
    name: "定位来源项目",
  });
  projectAuditEqual(
    await projectLocateLinks.count(),
    projectDomainEvents.length,
    "every project row must render the project locate link",
  );
  const projectLocateLink = projectCreatedRow.getByRole("link", {
    name: "定位来源项目",
  });
  projectAuditEqual(
    await projectLocateLink.getAttribute("href"),
    `/projects/${missionState.projectId}`,
    "project locate link must land on the canonical project identity route",
  );
  const projectAuditTabBox = await projectAuditTab.boundingBox();
  projectAuditOk(
    projectAuditTabBox
      && projectAuditTabBox.height >= 44
      && projectAuditTabBox.width >= 44,
    "audit tab must be at least 44x44",
  );
  const projectLocateBox = await projectLocateLink.boundingBox();
  projectAuditOk(
    projectLocateBox && projectLocateBox.height >= 44 && projectLocateBox.width >= 44,
    "project locate link must be at least 44x44",
  );
  await projectLocateLink.focus();
  projectAuditOk(
    (await projectLocateLink.evaluate((node) => getComputedStyle(node).boxShadow))
      !== "none",
    "focused locate link must show a visible focus ring",
  );
  await axeProjectWorkspaceAudit("desktop light project-workspace audit panel");
  projectWorkspaceAuditAcceptance.matrix.push("desktop-light");
  await page.screenshot({
    fullPage: true,
    path: projectAuditDesktopScreenshot,
  });
  const projectAuditFacingText = await page.locator("html").innerText();
  await setCockpitTheme(page, "dark");
  await projectContextPanel.getByText("已追平", { exact: true }).waitFor();
  await projectAuditRows
    .first()
    .getByRole("heading", { name: "验证政策已变更" })
    .waitFor();
  await axeProjectWorkspaceAudit("desktop dark project-workspace audit panel");
  projectWorkspaceAuditAcceptance.matrix.push("desktop-dark");
  await page.screenshot({
    fullPage: true,
    path: projectAuditDarkScreenshot,
  });
  await setCockpitTheme(page, "light");
  console.log(
    "PROJECT-WORKSPACE AUDIT DESKTOP PASS: keyboard End, neutral badge/copy/excerpts, locate hrefs, 44px, focus ring, axe light+dark",
  );

  await page.setViewportSize({ height: 844, width: 390 });
  await page.reload({ waitUntil: "networkidle" });
  const projectContextOpener = page.getByRole("button", {
    name: "打开当前任务上下文",
  });
  await projectContextOpener.focus();
  await page.keyboard.press("Enter");
  const projectContextDrawer = page.getByRole("dialog", {
    name: "当前任务上下文",
  });
  const narrowProjectAuditTab = projectContextDrawer.getByRole("tab", {
    name: "审计",
  });
  await narrowProjectAuditTab.focus();
  await page.keyboard.press("Enter");
  projectAuditEqual(
    await narrowProjectAuditTab.getAttribute("aria-selected"),
    "true",
    "Enter must select the narrow audit tab",
  );
  const narrowProjectAuditList = projectContextDrawer.getByRole("list", {
    name: "审计事件",
  });
  await narrowProjectAuditList.waitFor();
  await projectContextDrawer.getByText("已追平", { exact: true }).waitFor();
  await page.waitForFunction(
    (expected) =>
      document.querySelectorAll(".audit-event-list > li").length === expected,
    projectAuditEvents.length,
  );
  const narrowProjectRows = narrowProjectAuditList.getByRole("listitem");
  await narrowProjectRows
    .first()
    .getByRole("heading", { name: "验证政策已变更" })
    .waitFor();
  projectAuditEqual(
    await narrowProjectRows
      .first()
      .locator(".audit-event-excerpt")
      .innerText(),
    `修订 #${projectAuditSeed.revisionNo} · 1 项`,
    "narrow drawer must keep the policy summary",
  );
  const narrowProjectLocate = narrowProjectRows
    .nth(projectAuditEvents.indexOf(projectCreatedEvent))
    .getByRole("link", { name: "定位来源项目" });
  projectAuditEqual(
    await narrowProjectLocate.getAttribute("href"),
    `/projects/${missionState.projectId}`,
  );
  const narrowProjectLocateBox = await narrowProjectLocate.boundingBox();
  projectAuditOk(
    narrowProjectLocateBox
      && narrowProjectLocateBox.height >= 44
      && narrowProjectLocateBox.width >= 44,
    "narrow locate link must be at least 44x44",
  );
  const narrowProjectTabBox = await narrowProjectAuditTab.boundingBox();
  projectAuditOk(
    narrowProjectTabBox
      && narrowProjectTabBox.height >= 44
      && narrowProjectTabBox.width >= 44,
    "narrow audit tab must be at least 44x44",
  );
  await axeProjectWorkspaceAudit("narrow light project-workspace audit drawer");
  projectWorkspaceAuditAcceptance.matrix.push("narrow-light");
  await page.screenshot({
    fullPage: true,
    path: projectAuditNarrowScreenshot,
  });
  const narrowProjectAuditFacingText = await page.locator("html").innerText();
  await page.keyboard.press("Escape");
  await projectContextDrawer.waitFor({ state: "detached" });
  projectAuditOk(
    await projectContextOpener.evaluate(
      (node) => document.activeElement === node,
    ),
    "Escape must return focus to the context drawer opener",
  );
  console.log(
    "PROJECT-WORKSPACE AUDIT NARROW PASS: drawer presentation kept, locate href, 44px, axe",
  );

  // Secret scan: facing text is captured on the project page, which
  // legitimately renders the allowlisted workspace path, so facing text is
  // scanned for fixture secrets only; screenshot bytes are also scanned for
  // host paths (compressed pixels cannot contain page text).
  const projectAuditScreenshotBytes = [
    projectAuditDarkScreenshot,
    projectAuditDesktopScreenshot,
    projectAuditNarrowScreenshot,
  ]
    .map((path) => readFileSync(path).toString("latin1"))
    .join("\n");
  for (const surface of [
    projectAuditFacingText,
    narrowProjectAuditFacingText,
    projectAuditScreenshotBytes,
  ]) {
    for (const secret of [
      testApiKey,
      masterKey,
      `Bearer ${testApiKey}`,
      validationToken,
      providerBaseUrl,
    ]) {
      projectAuditOk(
        !surface.includes(secret),
        "project-workspace audit surface leaked a fixture secret",
      );
    }
  }
  for (const hostPath of [
    temporaryDirectory,
    workspaceDirectory,
    boundWorkspacePath,
    reboundWorkspaceDirectory,
    reboundWorkspacePath,
  ]) {
    projectAuditOk(
      !projectAuditScreenshotBytes.includes(hostPath),
      "project-workspace audit screenshot bytes leaked a host path",
    );
  }
  writeFileSync(
    projectAuditResultsPath,
    `${JSON.stringify(
      {
        assertions: projectWorkspaceAuditAcceptance.assertions,
        axe: projectWorkspaceAuditAcceptance.axe,
        events: projectAuditEvents.length,
        matrix: projectWorkspaceAuditAcceptance.matrix,
        projectEvents: projectDomainEvents.length,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  console.log(
    `PROJECT-WORKSPACE AUDIT ACCEPTANCE PASS: assertions=${projectWorkspaceAuditAcceptance.assertions} axeStates=${projectWorkspaceAuditAcceptance.axe.length} matrix=${projectWorkspaceAuditAcceptance.matrix.join(",")}`,
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
