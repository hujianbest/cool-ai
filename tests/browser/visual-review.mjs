import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// Vision-model design review: sends smoke screenshots plus a UCD excerpt to
// an OpenAI-compatible multimodal endpoint and writes a structured report.
// Fails closed: missing provider config, request failure, or unparsable
// verdicts never count as a pass.

const providerBaseUrl = process.env.COCKPIT_VISUAL_REVIEW_BASE_URL;
const providerApiKey = process.env.COCKPIT_VISUAL_REVIEW_API_KEY;
const providerModel = process.env.COCKPIT_VISUAL_REVIEW_MODEL;

function failClosed(message) {
  console.error(`VISUAL REVIEW FAIL (fail-closed): ${message}`);
  process.exit(1);
}

if (!providerBaseUrl || !providerApiKey || !providerModel) {
  failClosed(
    "vision review provider not configured. Set COCKPIT_VISUAL_REVIEW_BASE_URL, " +
      "COCKPIT_VISUAL_REVIEW_API_KEY and COCKPIT_VISUAL_REVIEW_MODEL " +
      "(OpenAI-compatible multimodal endpoint). A missing provider is never a pass.",
  );
}

const args = process.argv.slice(2);
const screenshotDirectory = resolve(
  args[args.indexOf("--dir") + 1] ?? "features/001-walking-skeleton/evidence",
);
const reportDirectory = resolve("tests", "browser", "visual-review-report");
const ucdPath = resolve("product", "ui", "UI设计.md");

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

const systemPrompt =
  "你是严格但务实的 UI 设计评审员。你将看到本地协作驾驶舱应用的真实浏览器截图，" +
  "以及产品设计文档（UCD）的节选。请只依据截图中可度量的视觉证据评审，" +
  "不臆测看不见的交互；截图为空状态时按空状态评判，不因内容稀少而扣分。" +
  '只输出一个 JSON 对象，不要输出其他文字：{"status":"pass"|"fail",' +
  '"summary":"一句话结论","issues":[{"severity":"high"|"medium"|"low",' +
  '"area":"受影响区域","description":"具体可见的问题与证据"}]}。' +
  "只有存在对照 UCD 的明确偏离、布局缺陷（错位/重叠/溢出/未渲染）、可读性或对比度问题时才 fail。";

const userPrompt =
  "对照以下 UCD 节选评审这张截图（暖米 + 暖金设计方向、三区布局、" +
  "52px 图标轨 / 240px 会话侧栏 / 居中聊天流、治理收轨、亮暗令牌语义）：\n\n" +
  `--- UCD 节选开始 ---\n${ucdExcerpt}\n--- UCD 节选结束 ---`;

async function reviewScreenshot(fileName) {
  const dataUrl = `data:image/png;base64,${readFileSync(join(screenshotDirectory, fileName)).toString("base64")}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  try {
    const response = await fetch(
      `${providerBaseUrl.replace(/\/+$/u, "")}/chat/completions`,
      {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${providerApiKey}`,
        },
        body: JSON.stringify({
          model: providerModel,
          temperature: 0,
          messages: [
            { role: "system", content: systemPrompt },
            {
              role: "user",
              content: [
                { type: "text", text: userPrompt },
                { type: "image_url", image_url: { url: dataUrl } },
              ],
            },
          ],
        }),
      },
    );
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
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
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

const results = [];
for (const fileName of screenshots) {
  console.log(`VISUAL REVIEW: reviewing ${fileName} ...`);
  try {
    results.push(await reviewScreenshot(fileName));
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
  screenshotDirectory,
  model: providerModel,
  overall: passed ? "pass" : "fail",
  results,
};

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
