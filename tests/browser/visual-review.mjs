import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { chromium } from "playwright";

// Vision-model design review with UCD prototype references: captures key
// views of product/ui/preview-ucd.html as reference images, then sends each
// smoke screenshot PAIRED with the references plus a UCD excerpt to an
// OpenAI-compatible or Anthropic Messages multimodal endpoint
// (COCKPIT_VISUAL_REVIEW_API_STYLE selects the wire format) for semantic
// conformance review. Fails closed: missing provider config, capture/request
// failure, or unparsable verdicts never count as a pass.

const providerBaseUrl = process.env.COCKPIT_VISUAL_REVIEW_BASE_URL;
const providerApiKey = process.env.COCKPIT_VISUAL_REVIEW_API_KEY;
const providerModel = process.env.COCKPIT_VISUAL_REVIEW_MODEL;

const PROTOTYPE_VIEWS = [
  "chat",
  "tasks",
  "memory",
  "approval",
  "audit",
  "team",
  "review",
];

function failClosed(message) {
  console.error(`VISUAL REVIEW FAIL (fail-closed): ${message}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const argValue = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const screenshotDirectory = resolve(
  argValue("--dir") ?? "features/001-walking-skeleton/evidence",
);
const referenceDirectory = resolve("tests", "browser", "test-artifacts", "ucd-references");
const referenceViews = (argValue("--refs") ?? "chat")
  .split(",")
  .map((view) => view.trim())
  .filter(Boolean);
const captureOnly = args.includes("--capture-only");
const ucdPath = resolve("product", "ui", "UI设计.md");
const prototypePath = resolve("product", "ui", "preview-ucd.html");

if (captureOnly) {
  try {
    await captureUcdReferences();
  } catch (error) {
    failClosed(`UCD reference capture failed: ${String(error?.message ?? error)}`);
  }
  console.log("UCD REFERENCE CAPTURE DONE (capture-only mode, no review performed).");
  process.exit(0);
}

if (!providerBaseUrl || !providerApiKey || !providerModel) {
  failClosed(
    "vision review provider not configured. Set COCKPIT_VISUAL_REVIEW_BASE_URL, " +
      "COCKPIT_VISUAL_REVIEW_API_KEY and COCKPIT_VISUAL_REVIEW_MODEL " +
      "(OpenAI-compatible or Anthropic Messages multimodal endpoint). " +
      "A missing provider is never a pass.",
  );
}

const apiStyle = process.env.COCKPIT_VISUAL_REVIEW_API_STYLE ?? "openai";
if (!["openai", "anthropic"].includes(apiStyle)) {
  failClosed(
    `unknown COCKPIT_VISUAL_REVIEW_API_STYLE: ${apiStyle}. Use "openai" (default) or "anthropic".`,
  );
}

const invalidViews = referenceViews.filter((view) => !PROTOTYPE_VIEWS.includes(view));
if (invalidViews.length > 0) {
  failClosed(
    `unknown prototype view(s): ${invalidViews.join(", ")}. Available: ${PROTOTYPE_VIEWS.join(", ")}`,
  );
}

/**
 * Render product/ui/preview-ucd.html in headless Chromium and capture the
 * requested views as reference screenshots. The prototype's own control
 * banner is hidden; views are switched with the prototype's switchView().
 */
async function captureUcdReferences() {
  if (!existsSync(prototypePath)) {
    failClosed(`UCD prototype not found: ${prototypePath}`);
  }
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined;
  const browser = await chromium.launch({ executablePath });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page
      .goto(`file://${prototypePath}`, { waitUntil: "networkidle", timeout: 20_000 })
      .catch(async () => {
        await page.goto(`file://${prototypePath}`, { waitUntil: "load" });
      });
    await page.addStyleTag({ content: ".prototype-bar { display: none !important; }" });
    mkdirSync(referenceDirectory, { recursive: true });
    const captured = [];
    for (const view of referenceViews) {
      await page.evaluate((viewId) => window.switchView(viewId), view);
      const path = join(referenceDirectory, `ucd-${view}.png`);
      await page.screenshot({ path });
      captured.push(path);
      console.log(`UCD REFERENCE CAPTURED: ${path}`);
    }
    return captured;
  } finally {
    await browser.close();
  }
}

const systemPrompt =
  "你是严格但务实的 UI 设计评审员。你将收到同一产品的两组截图：第一组是 UCD 高保真原型" +
    "（product/ui/preview-ucd.html）的参考视图，最后一组之后标注的「实现截图」是真实浏览器中的运行效果。" +
    "请对照原型评审实现的设计符合性：整体布局结构（52px 图标轨 / 240px 会话侧栏 / 居中聊天流 / 48px header）、" +
    "三区比例、暖米 + 暖金视觉方向、组件形态（composer、卡片、徽标、选中态、图标）。" +
    "忽略以下差异，不作为问题：内容与数据差异（实现是真实动态数据或空态，原型是演示数据）、" +
    "亚像素/字体渲染差异、滚动条与焦点环。截图为空状态时按空状态评判，不因内容稀少而扣分。" +
    '只输出一个 JSON 对象，不要输出其他文字：{"status":"pass"|"fail",' +
    '"summary":"一句话结论","issues":[{"severity":"high"|"medium"|"low",' +
    '"area":"受影响区域","description":"相对原型的具体偏离与证据"}]}。' +
    "只有存在明确的结构性偏离、视觉方向偏离或布局缺陷（错位/重叠/溢出/未渲染）时才 fail。";

function imageBlock(style, filePath) {
  const data = readFileSync(filePath).toString("base64");
  return style === "anthropic"
    ? { type: "image", source: { type: "base64", media_type: "image/png", data } }
    : { type: "image_url", image_url: { url: `data:image/png;base64,${data}` } };
}

function buildUserContent(ucdExcerpt, referenceViews_, actualScreenshotPath, style) {
  const content = [
    {
      type: "text",
      text:
        "对照下方 UCD 原型参考视图，评审最后一张实现截图的设计符合性。\n\n" +
        `--- UCD 节选开始 ---\n${ucdExcerpt}\n--- UCD 节选结束 ---`,
    },
  ];
  for (const view of referenceViews_) {
    content.push({ type: "text", text: `参考原型视图：${view}` });
    content.push(imageBlock(style, join(referenceDirectory, `ucd-${view}.png`)));
  }
  content.push({ type: "text", text: "实现截图（真实应用状态）：" });
  content.push(imageBlock(style, actualScreenshotPath));
  return content;
}

async function reviewScreenshot(fileName, ucdExcerpt) {
  const screenshotPath = join(screenshotDirectory, fileName);
  const baseUrl = providerBaseUrl.replace(/\/+$/u, "");
  const endpoint =
    apiStyle === "anthropic" ? `${baseUrl}/v1/messages` : `${baseUrl}/chat/completions`;
  const headers =
    apiStyle === "anthropic"
      ? {
          "content-type": "application/json",
          "x-api-key": providerApiKey,
          "anthropic-version": "2023-06-01",
        }
      : {
          "content-type": "application/json",
          authorization: `Bearer ${providerApiKey}`,
        };
  const userContent = buildUserContent(ucdExcerpt, referenceViews, screenshotPath, apiStyle);
  const requestBody =
    apiStyle === "anthropic"
      ? {
          model: providerModel,
          max_tokens: 8192,
          system: systemPrompt,
          messages: [{ role: "user", content: userContent }],
        }
      : {
          model: providerModel,
          temperature: 0,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userContent },
          ],
        };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      signal: controller.signal,
      headers,
      body: JSON.stringify(requestBody),
    });
    if (!response.ok) {
      return {
        image: fileName,
        status: "error",
        issues: [
          {
            severity: "high",
            area: "provider",
            description: `HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`,
          },
        ],
        summary: "provider request failed",
      };
    }
    const payload = await response.json();
    const content =
      apiStyle === "anthropic"
        ? Array.isArray(payload?.content)
          ? payload.content
              .filter((block) => block?.type === "text" && typeof block.text === "string")
              .map((block) => block.text)
              .join("\n")
          : undefined
        : payload?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.trim() === "") {
      return {
        image: fileName,
        status: "error",
        issues: [
          {
            severity: "high",
            area: "provider",
            description: "response contained no message content",
          },
        ],
        summary: "provider response unparsable",
      };
    }
    const jsonText = content.slice(content.indexOf("{"), content.lastIndexOf("}") + 1);
    const verdict = JSON.parse(jsonText);
    assert.equal(typeof verdict.status, "string");
    assert.ok(["pass", "fail"].includes(verdict.status));
    return {
      image: fileName,
      status: verdict.status,
      summary: typeof verdict.summary === "string" ? verdict.summary : "",
      issues: Array.isArray(verdict.issues)
        ? verdict.issues.filter(
            (issue) => issue && typeof issue.description === "string",
          )
        : [],
    };
  } finally {
    clearTimeout(timeout);
  }
}

if (captureOnly) {
  await captureUcdReferences();
  console.log("UCD REFERENCE CAPTURE DONE (capture-only mode, no review performed).");
  process.exit(0);
}

if (!existsSync(screenshotDirectory)) {
  failClosed(`screenshot directory not found: ${screenshotDirectory}`);
}
const screenshots = readdirSync(screenshotDirectory)
  .filter((name) => name.endsWith(".png"))
  .sort();
if (screenshots.length === 0) {
  failClosed(`no .png screenshots found in ${screenshotDirectory}`);
}

const ucdExcerpt = existsSync(ucdPath)
  ? readFileSync(ucdPath, "utf8").slice(0, 9000)
  : failClosed(`UCD document not found: ${ucdPath}`);

try {
  await captureUcdReferences();
} catch (error) {
  failClosed(`UCD reference capture failed: ${String(error?.message ?? error)}`);
}

const results = [];
for (const fileName of screenshots) {
  console.log(
    `VISUAL REVIEW: reviewing ${fileName} against ucd references [${referenceViews.join(", ")}] ...`,
  );
  try {
    results.push(await reviewScreenshot(fileName, ucdExcerpt));
  } catch (error) {
    results.push({
      image: fileName,
      status: "error",
      summary: "request or verdict parsing failed",
      issues: [
        {
          severity: "high",
          area: "provider",
          description: String(error?.message ?? error).slice(0, 300),
        },
      ],
    });
  }
  console.log(
    `VISUAL REVIEW: ${fileName} -> ${results.at(-1).status.toUpperCase()} ${results.at(-1).summary}`,
  );
}

const passed = results.every((result) => result.status === "pass");
const report = {
  generatedAt: new Date().toISOString(),
  apiStyle,
  screenshotDirectory,
  referenceViews,
  model: providerModel,
  overall: passed ? "pass" : "fail",
  results,
};

const reportDirectory = resolve("tests", "browser", "visual-review-report");
mkdirSync(reportDirectory, { recursive: true });
const jsonPath = join(reportDirectory, "visual-review-report.json");
const markdownPath = join(reportDirectory, "visual-review-report.md");
writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(
  markdownPath,
  [
    `# 视觉模型评审报告 (${report.generatedAt})`,
    "",
    `- 模型: ${providerModel}`,
    `- 原型参考视图: ${referenceViews.join(", ")}`,
    `- 截图目录: ${screenshotDirectory}`,
    `- 总体结论: **${report.overall.toUpperCase()}**`,
    "",
    ...results.map((result) =>
      [
        `## ${result.image} — ${result.status.toUpperCase()}`,
        "",
        result.summary ? `${result.summary}` : "",
        ...(result.issues.length > 0
          ? ["", ...result.issues.map((issue) => `- [${issue.severity}] ${issue.area}: ${issue.description}`)]
          : []),
        "",
      ].join("\n"),
    ),
  ].join("\n"),
);
console.log(`VISUAL REVIEW ${passed ? "PASS" : "FAIL"}: report written to ${jsonPath}`);
process.exit(passed ? 0 : 1);
