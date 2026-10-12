// 冒烟套件编排器（npm run smoke:all）：一次生产构建 + 并行 lane 跑全部 10 个浏览器冒烟脚本。
// 背景：脚本各自 next dev 按需编译导致整轮 20-35 分钟；全部脚本统一 next start（.next 构建）
// 后，本编排器按 lane 并行消化，整轮收敛到分钟级。
// 约束：本编排器只改变「怎么跑」（构建一次 + 并行 + 端口隔离），不改任何脚本断言；
// 每个 lane 内脚本串行，各自使用独立端口（COCKPIT_SMOKE_*_PORT）与独立 SQLite 临时库，
// 互不共享状态；最终 DoD 仍要求全部脚本不带参全量绿。
// 用法：
//   npm run smoke:all                                # 预检 → 构建 → 并行全量
//   SMOKE_SUITE_SKIP_BUILD=1 npm run smoke:all       # 复用现有 .next 构建（迭代期）
//   node tests/browser/smoke-suite.mjs --list        # 只打印 lane 表
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const nextBin = join(root, "node_modules", "next", "dist", "bin", "next");
const logDirectory = join(root, "tests", "browser", "test-artifacts", "smoke-suite");
// 套件使用独立 dist 目录（next.config 读取 NEXT_DIST_DIR）：本轮构建不再触碰默认
// `.next`，与 vitest 内基于 next start 的测试（review 全链 / 主题水合）可安全并行，
// 也避免「套件重建 .next 期间别的 next start 拿不到构建」的调度冲突。
const suiteDistDirectory = ".next-smoke-suite";

// lane 权重按实测单脚本耗时排布（初次按脚本体量/等待密度估计，实测后可重排）。
// 端口统一使用 44xxx 段：仓库内没有任何脚本或服务使用该段，与独立运行的 pid/随机段不冲突。
const lanes = [
  { name: "lane1", scripts: [{ name: "threads", file: "persistent-threads-browser-smoke.mjs", port: 44011, providerPort: 44012 }] },
  { name: "lane2", scripts: [{ name: "context", file: "context-browser-smoke.mjs", port: 44021, providerPort: 44022 }] },
  { name: "lane3", scripts: [{ name: "collaboration", file: "collaboration-browser-smoke.mjs", port: 44031, providerPort: 44032 }] },
  {
    name: "lane4",
    scripts: [
      { name: "execution", file: "execution-browser-smoke.mjs", port: 44041 },
      { name: "settings", file: "settings-navigation-browser-smoke.mjs", port: 44043 },
    ],
  },
  {
    name: "lane5",
    scripts: [
      { name: "smoke", file: "browser-smoke.mjs", port: 44051 },
      { name: "review", file: "review-browser-smoke.mjs", port: 44052 },
    ],
  },
  {
    name: "lane6",
    scripts: [
      { name: "onboarding", file: "onboarding-browser-smoke.mjs", port: 44061 },
      { name: "team", file: "team-browser-smoke.mjs", port: 44062, providerPort: 44063, redirectPort: 44064 },
      { name: "structured", file: "structured-messages-browser-smoke.mjs", port: 44065, providerPort: 44066 },
    ],
  },
];

if (process.argv.includes("--list")) {
  for (const lane of lanes) {
    console.log(lane.scripts.map((s) => `${lane.name}:${s.name}@${s.port}`).join("  "));
  }
  process.exit(0);
}

const suiteStartedAt = Date.now();

function elapsedLabel(from = suiteStartedAt) {
  const seconds = Math.round((Date.now() - from) / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function log(message) {
  console.log(`[${elapsedLabel()}] ${message}`);
}

mkdirSync(logDirectory, { recursive: true });

log("PREFLIGHT: 清理残留 next 进程与 .next 锁");
const preflight = spawnSync(process.execPath, [join(root, "tests", "browser", "smoke-preflight.mjs")], {
  stdio: "inherit",
});
if (preflight.status !== 0) {
  console.error(`PREFLIGHT FAILED (exit ${preflight.status})`);
  process.exit(1);
}

const skipBuild = process.env.SMOKE_SUITE_SKIP_BUILD === "1";
const buildLogPath = join(logDirectory, "build.log");
if (skipBuild && existsSync(join(root, suiteDistDirectory, "BUILD_ID"))) {
  log(`BUILD: skipped (SMOKE_SUITE_SKIP_BUILD=1，复用现有 ${suiteDistDirectory} 构建)`);
} else {
  const buildStartedAt = Date.now();
  log("BUILD: next build --webpack 开始（生产构建供全部 lane 复用）");
  const build = spawnSync(process.execPath, [nextBin, "build", "--webpack"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, NEXT_DIST_DIR: suiteDistDirectory },
  });
  writeFileSync(buildLogPath, `${build.stdout ?? ""}\n${build.stderr ?? ""}`);
  if (build.status !== 0) {
    console.error(`BUILD FAILED (exit ${build.status})，完整日志：${buildLogPath}`);
    const tail = (build.stderr ?? build.stdout ?? "").split("\n").slice(-30).join("\n");
    console.error(tail);
    process.exit(1);
  }
  log(`BUILD: ok (${Math.round((Date.now() - buildStartedAt) / 1000)}s)`);
}

const activeChildren = new Set();
let interrupted = false;
process.on("SIGINT", () => {
  interrupted = true;
  for (const child of activeChildren) child.kill("SIGTERM");
});

async function runScript(lane, spec) {
  const scriptLogPath = join(logDirectory, `${spec.name}.log`);
  const env = { ...process.env, NEXT_DIST_DIR: suiteDistDirectory };
  if (spec.port) env.COCKPIT_SMOKE_PORT = String(spec.port);
  if (spec.providerPort) env.COCKPIT_SMOKE_PROVIDER_PORT = String(spec.providerPort);
  if (spec.redirectPort) env.COCKPIT_SMOKE_REDIRECT_PORT = String(spec.redirectPort);
  const startedAt = Date.now();
  log(`▶ ${lane.name} ${spec.name} (port ${spec.port})`);
  try {
    await new Promise((resolveRun) => {
      const child = spawn(process.execPath, [join(root, "tests", "browser", spec.file)], {
        cwd: root,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      activeChildren.add(child);
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk.toString();
        if (output.length > 8_000_000) output = output.slice(-4_000_000);
      });
      child.stderr.on("data", (chunk) => {
        output += chunk.toString();
      });
      child.on("close", (code) => {
        activeChildren.delete(child);
        appendFileSync(scriptLogPath, output);
        resolveRun({ code, output });
      });
    });
    const seconds = Math.round((Date.now() - startedAt) / 1000);
    return { ...spec, seconds, status: "PASS" };
  } catch (error) {
    appendFileSync(scriptLogPath, `\nORCHESTRATOR ERROR: ${error?.stack ?? error}\n`);
    return { ...spec, seconds: Math.round((Date.now() - startedAt) / 1000), status: "ERROR" };
  }
}

async function runLane(lane) {
  const results = [];
  for (const spec of lane.scripts) {
    if (interrupted) break;
    const result = await runScript(lane, spec);
    results.push(result);
    log(`${result.status === "PASS" ? "✔" : "✘"} ${lane.name} ${spec.name} (${result.seconds}s)`);
    if (result.status !== "PASS") {
      const tail = (result.output ?? "").split("\n").filter(Boolean).slice(-25).join("\n");
      if (tail) console.error(`--- ${spec.name} 失败尾部 ---\n${tail}\n----------------------`);
    }
  }
  return results;
}

log(`SMOKE SUITE: ${lanes.reduce((total, lane) => total + lane.scripts.length, 0)} 个脚本 / ${lanes.length} lane 并行开始`);
const laneResults = await Promise.all(lanes.map(runLane));
const results = laneResults.flat();

const failed = results.filter((result) => result.status !== "PASS");
log("──────────────── smoke:all 结果 ────────────────");
for (const result of results.sort((a, b) => a.name.localeCompare(b.name))) {
  console.log(`${result.status === "PASS" ? "PASS" : "FAIL"}  ${String(result.seconds).padStart(4)}s  ${result.name}`);
}
log("────────────────────────────────────────────────");
log(
  `SMOKE SUITE ${failed.length === 0 ? "GREEN" : "RED"}：${results.length - failed.length}/${results.length} 绿，` +
    `整轮 ${Math.round((Date.now() - suiteStartedAt) / 1000)}s（目标 ≤300s），日志目录 ${logDirectory}`,
);
process.exitCode = failed.length === 0 ? 0 : 1;
