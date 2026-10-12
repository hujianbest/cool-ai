import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";

import { PNG } from "pngjs";
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
  "trash",
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
    await captureUcdReferences(referenceViews);
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

// 审计截图（ui-audit-runner.mjs 产物）→ 原型参考视图 + UCD 分节映射。
// 目标：把「每个按钮点击后的页面」按所属表面送到模型视觉评审——每个 capture 用
// 对应视图的原型参考与 UCD 节选，而不是整目录共用一套参考（首条匹配生效）。
// 首条匹配生效；前缀带字母的变体（04b/11b/16a…）经双位前缀整体覆盖。
const CAPTURE_RULES = [
  { test: /^22b/, views: ["trash"], ucd: ["9.6.3"] },
  { test: /^01/, views: ["chat"], ucd: ["9.1.1"] },
  { test: /^0[2-7]/, views: ["team"], ucd: ["9.3.1", "9.3.2", "9.3.3", "9.3.6"] },
  { test: /^08/, views: ["team"], ucd: ["9.3.4", "9.3.6"] },
  { test: /^09/, views: ["chat"], ucd: ["9.1.1"] },
  { test: /^10/, views: ["chat"], ucd: ["9.1.5", "8.3"] },
  { test: /^11/, views: ["chat"], ucd: ["9.1.4"] },
  { test: /^12/, views: ["chat"], ucd: ["9.6.1"] },
  { test: /^13/, views: ["chat"], ucd: ["9.6.5"] },
  { test: /^14/, views: ["chat"], ucd: ["9.1.4"] },
  { test: /^15/, views: ["chat"], ucd: ["9.1.2"] },
  { test: /^16/, views: ["chat"], ucd: ["9.1.2", "9.1.3", "9.1.4"] },
  { test: /^1[78]/, views: ["tasks"], ucd: ["9.2.1"] },
  { test: /^19/, views: ["memory"], ucd: ["9.2.4"] },
  { test: /^20/, views: ["approval"], ucd: ["9.2.5"] },
  { test: /^21/, views: ["audit"], ucd: ["9.2.6"] },
  { test: /^22/, views: ["chat"], ucd: ["9.1.2"] },
  { test: /^23/, views: ["chat"], ucd: ["9.6.2"] },
  { test: /^24/, views: ["chat"], ucd: ["9.1.1"] },
  { test: /^25/, views: ["chat"], ucd: ["7.2"] },
  { test: /^26/, views: ["team"], ucd: ["9.3.1", "9.3.2", "9.3.3", "9.3.6"] },
  { test: /^27/, views: ["chat"], ucd: ["9.1.2"] },
  { test: /^28/, views: ["chat"], ucd: ["9.1.3", "8.3"] },
  { test: /^29/, views: ["memory"], ucd: ["9.2.4", "8.3"] },
  { test: /^30/, views: ["approval"], ucd: ["9.2.5"] },
  { test: /^31/, views: ["audit"], ucd: ["9.2.6"] },
  { test: /^32/, views: ["team"], ucd: ["9.3.1", "9.3.2", "8.3"] },
  { test: /^33/, views: ["chat"], ucd: ["9.1.5", "9.6.2"] },
];

function resolveCaptureRule(fileName) {
  return CAPTURE_RULES.find((rule) => rule.test.test(fileName)) ?? null;
}

// 按 `## N` / `### N.x` / `#### N.x.y` 标题切分 UCD 文档；`###` 节含其 `####` 子节。
function loadUcdSections(markdown) {
  const sections = new Map();
  let currentKey = null;
  let buffer = [];
  const flush = () => {
    if (currentKey) sections.set(currentKey, buffer.join("\n"));
    buffer = [];
  };
  for (const line of markdown.split("\n")) {
    const match = /^(#{2,4})\s+(\d+(?:\.\d+)*)\b/.exec(line);
    if (match) {
      flush();
      currentKey = match[2];
      buffer = [line];
      continue;
    }
    if (currentKey) buffer.push(line);
  }
  flush();
  return sections;
}

function composeUcdExcerpt(sections, keys) {
  const blocks = [];
  // 全视图共用基准：§7 信息架构（三区定义 + 响应式断点）。
  for (const base of ["7.1", "7.2"]) {
    if (sections.has(base)) blocks.push(sections.get(base));
  }
  for (const key of keys) {
    if (sections.has(key)) blocks.push(sections.get(key));
  }
  const text = blocks.join("\n\n");
  return text.length > 6_000 ? `${text.slice(0, 6_000)}\n…（节选截断）` : text;
}

/**
 * Render product/ui/preview-ucd.html in headless Chromium and capture the
 * requested views as reference screenshots. The prototype's own control
 * banner is hidden; views are switched with the prototype's switchView().
 */
async function captureUcdReferences(views) {
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
    for (const view of views) {
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

// 图像降载：宽 > 900px 的 PNG 先做盒式缩放并缓存（.w900.png），降低单请求 token
// 与传输负担（provider 限流环境下显著提速）；评审内容为布局/色彩/结构，900px 足够。
const DOWNSCALE_WIDTH = 900;

function downscaledPath(filePath) {
  const withSuffix = `${filePath.replace(/\.png$/i, "")}.w${DOWNSCALE_WIDTH}.png`;
  // 缓存仅在比源图新时可用：重采后源图字节已换，沿用旧降载会把过期证据送进评审。
  if (existsSync(withSuffix)) {
    const cache = statSync(withSuffix);
    const source = statSync(filePath);
    if (cache.mtimeMs >= source.mtimeMs) return withSuffix;
  }
  const source = PNG.sync.read(readFileSync(filePath));
  if (source.width <= DOWNSCALE_WIDTH) return filePath;
  const ratio = source.width / DOWNSCALE_WIDTH;
  const targetWidth = DOWNSCALE_WIDTH;
  const targetHeight = Math.max(1, Math.round(source.height / ratio));
  const target = new PNG({ height: targetHeight, width: targetWidth });
  for (let y = 0; y < targetHeight; y += 1) {
    for (let x = 0; x < targetWidth; x += 1) {
      const srcX = Math.min(source.width - 1, Math.floor(x * ratio));
      const srcY = Math.min(source.height - 1, Math.floor(y * ratio));
      const srcIndex = (source.width * srcY + srcX) << 2;
      const dstIndex = (targetWidth * y + x) << 2;
      target.data[dstIndex] = source.data[srcIndex];
      target.data[dstIndex + 1] = source.data[srcIndex + 1];
      target.data[dstIndex + 2] = source.data[srcIndex + 2];
      target.data[dstIndex + 3] = source.data[srcIndex + 3];
    }
  }
  writeFileSync(withSuffix, PNG.sync.write(target));
  return withSuffix;
}

function imageBlock(style, filePath) {
  const effectivePath = filePath.toLowerCase().endsWith(".png")
    ? downscaledPath(filePath)
    : filePath;
  const data = readFileSync(effectivePath).toString("base64");
  return style === "anthropic"
    ? { type: "image", source: { type: "base64", media_type: "image/png", data } }
    : { type: "image_url", image_url: { url: `data:image/png;base64,${data}` } };
}

function buildUserContent(ucdExcerpt, referenceViews_, actualScreenshotPath, style, viewNote) {
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
  if (viewNote) {
    content.push({ type: "text", text: `评审口径注记：${viewNote}` });
  }
  content.push({ type: "text", text: "实现截图（真实应用状态）：" });
  content.push(imageBlock(style, actualScreenshotPath));
  return content;
}

async function reviewScreenshot(fileName, ucdExcerpt, viewsForCapture) {
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
  // 窄屏截图按 UCD §7 响应式规范评审：参考原型是桌面骨架，不得以 240px 侧栏/
  // 48px header/居中三区作为窄屏结构性要求；仍裁空白主表面、缺 Composer/空态
  // 引导、错位/重叠/溢出与视觉方向偏离。
  const viewNote = /narrow/i.test(fileName)
    ? "本次实现截图为 390px 窄屏视口。按 UCD §7 响应式规范：会话侧栏收起为抽屉" +
      "（默认收起、不占位）、图标轨 52px 常驻、聊天流 100% 宽度、顶部为移动工具栏" +
      "（图标按钮）。不要以桌面 240px 会话侧栏、48px header 或居中三区骨架作为窄屏" +
      "结构性要求；应裁真实缺陷：主表面空白或未渲染、缺少 Composer 或空态引导、" +
      "错位/重叠/溢出、暖米+暖金视觉方向偏离。"
    : /^(20|30)/.test(fileName)
      ? "本次实现截图是统一审批中心。UCD §9.2.5 已登记数据模型缺口（U-20）：线框中的" +
        "TTL 倒计时、红绿 Diff 比较器、风险等级徽标依赖尚未建立的审批有效期/变更预览/" +
        "风险评估数据模型，当前实现以类型/状态徽标 + 影响摘要 + 来源定位呈现，**不得**" +
        "把这三项的缺失计为界面不符合（缺口已登记，数据模型落库前不伪造展示）。应评审：" +
        "顶栏（返回对话 + 统一审批中心 · 项目名 + 状态筛选 + 刷新列表）、裁决按钮组" +
        "（驳回到左、批准执行在右）、卡片徽标/时间/影响摘要/来源定位、暖米+暖金视觉方向、" +
        "错位/重叠/溢出/未渲染。"
      : "";
  const userContent = buildUserContent(ucdExcerpt, viewsForCapture, screenshotPath, apiStyle, viewNote);
  const requestBody =
    apiStyle === "anthropic"
      ? {
          model: providerModel,
          max_tokens: 8192,
          // 有界思考预算：保留推理但封顶延迟（provider 长思考曾令单请求分钟级）。
          thinking: { budget_tokens: 2048, type: "enabled" },
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
  const timeout = setTimeout(() => controller.abort(), 600_000);
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

if (!existsSync(screenshotDirectory)) {
  failClosed(`screenshot directory not found: ${screenshotDirectory}`);
}
const screenshots = readdirSync(screenshotDirectory)
  .filter((name) => name.endsWith(".png") && !/\.w\d+\.png$/i.test(name))
  .sort();
if (screenshots.length === 0) {
  failClosed(`no .png screenshots found in ${screenshotDirectory}`);
}

const ucdMarkdown = existsSync(ucdPath)
  ? readFileSync(ucdPath, "utf8")
  : failClosed(`UCD document not found: ${ucdPath}`);
const ucdSections = loadUcdSections(ucdMarkdown);
const fallbackExcerpt = ucdMarkdown.slice(0, 9000);

// --only <regex>：迭代时只评审匹配的 capture（最终闸门必须不带参全量跑）。
// --report <name>：报告文件名（分片并行评审时各自落盘，最后合并）。
const onlyPattern = argValue("--only");
const onlyRegex = onlyPattern ? new RegExp(onlyPattern) : null;
const reportName = argValue("--report") ?? "visual-review-report";
const reportDirectory = resolve("tests", "browser", "visual-review-report");
mkdirSync(reportDirectory, { recursive: true });
const jsonPath = join(reportDirectory, `${reportName}.json`);
const markdownPath = join(reportDirectory, `${reportName}.md`);

const resume = args.includes("--resume");
const priorResults = new Map();
if (resume) {
  const priorPath = join(reportDirectory, `${reportName}.json`);
  if (existsSync(priorPath)) {
    try {
      const prior = JSON.parse(readFileSync(priorPath, "utf8"));
      for (const entry of prior.results ?? []) priorResults.set(entry.image, entry);
    } catch {
      // 报告损坏则从零开始。
    }
  }
}
const selectedScreenshots = (onlyRegex
  ? screenshots.filter((name) => onlyRegex.test(name))
  : screenshots).filter((name) => !priorResults.has(name));
if (selectedScreenshots.length === 0) {
  failClosed(`--only ${onlyPattern} matched no screenshots in ${screenshotDirectory}`);
}

// 需要的原型参考视图 = 各 capture 映射视图 ∪ --refs（未匹配 capture 的回退视图）。
const neededViews = new Set(referenceViews);
for (const fileName of selectedScreenshots) {
  const rule = resolveCaptureRule(fileName);
  if (rule) for (const view of rule.views) neededViews.add(view);
}

try {
  await captureUcdReferences([...neededViews]);
} catch (error) {
  failClosed(`UCD reference capture failed: ${String(error?.message ?? error)}`);
}


const results = [...priorResults.values()].sort((a, b) => a.image.localeCompare(b.image));
for (const fileName of selectedScreenshots) {
  const rule = resolveCaptureRule(fileName);
  const viewsForCapture = rule ? rule.views : referenceViews;
  const excerptForCapture = rule
    ? composeUcdExcerpt(ucdSections, rule.ucd)
    : fallbackExcerpt;
  console.log(
    `VISUAL REVIEW: reviewing ${fileName} against ucd references [${viewsForCapture.join(", ")}] ...`,
  );
  // 瞬时 provider 错误（429/5xx/超时/解析失败）有界重试一次；仍失败按 error 记入
  // 结论（fail-closed，不把传输失败当通过）。
  let attempt = 0;
  let outcome;
  let lastError = "";
  const captureStartedAt = Date.now();
  for (;;) {
    attempt += 1;
    try {
      const verdict = await reviewScreenshot(fileName, excerptForCapture, viewsForCapture);
      if (verdict.status !== "error" || attempt >= 3) {
        outcome = { ...verdict, views: viewsForCapture };
        break;
      }
    } catch (error) {
      lastError = String(error?.message ?? error).slice(0, 160);
      if (attempt >= 3) {
        outcome = {
          image: fileName,
          status: "error",
          summary: "request or verdict parsing failed",
          views: viewsForCapture,
          issues: [
            {
              severity: "high",
              area: "provider",
              description: String(error?.message ?? error).slice(0, 300),
            },
          ],
        };
        break;
      }
    }
    console.log(
      `VISUAL REVIEW: retrying ${fileName} (attempt ${attempt + 1}) after transient provider error` +
        ` :: ${String(outcome?.issues?.[0]?.description ?? lastError ?? "request threw").slice(0, 160)}`,
    );
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5_000));
  }
  results.push(outcome);
  console.log(
    `VISUAL REVIEW: ${fileName} -> ${results.at(-1).status.toUpperCase()} ` +
      `(${Math.round((Date.now() - captureStartedAt) / 1000)}s, ${attempt} attempt(s)) ${results.at(-1).summary}`,
  );
  // 增量落盘：长跑被中断时仍保留已完成结论。
  writeFileSync(
    join(reportDirectory, `${reportName}.json`),
    `${JSON.stringify({ generatedAt: new Date().toISOString(), partial: true, results }, null, 2)}\n`,
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
        result.views ? `参考视图: ${result.views.join(", ")}` : "",
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
