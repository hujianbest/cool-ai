# 020-test-execution-speed 规格

## Problem Statement

全量 Vitest 套件在 8 逻辑核机器上墙钟约 538 秒（2026-08-09 实测，架构收敛前的旧树基线：227 文件 / 1803 用例）。RED/GREEN 与最终全量确认都被拖慢。耗时分解显示三类结构性浪费：

1. `maxWorkers: 2` 把并行度压到 8 核的 1/4；
2. 全部测试文件强制 jsdom 环境，172+ 个纯服务端 `.ts` 文件各付 ~1.7s 的 jsdom 创建费（environment 累计 384s，占 38%）；
3. forks 池隔离使每个测试文件新建 Node 进程，setup.ts 无条件耦合 DOM（`window` 直接引用），把纯服务端测试绑死在 jsdom 上。

## Solution

测试基建切片（无产品行为变化）：

1. 移除 `maxWorkers: 2` 覆盖，使用 Vitest 默认并行度（按可用核数）；
2. 默认环境改为 `node`，55 个 `.test.tsx` UI 测试文件头部显式声明 `// @vitest-environment jsdom`；
3. `tests/setup.ts` 加 `typeof window` 守卫，使 node 环境下跳过 DOM 清理与 history 重置；
4. 磁盘 SQLite 夹具改内存库：119 个使用 `mkdtempSync` + `COCKPIT_DB_PATH` 临时文件的测试改为内存数据库（或等价的无磁盘 I/O 方案），需要 reopen 语义的用例保留文件库（用户 2026-08-09 明确要求纳入本切片）。

以"同一通过/失败用例集合、更低墙钟"为验收；先在新树（019 合并后）重测基线，再对比。

## User Stories

1. As a developer, I want the full suite to finish in minutes, so that final integration checks stay cheap.
2. As a developer, I want focused server-side tests to run without jsdom startup cost, so that RED/GREEN loops stay fast.

## Implementation Decisions

- 只动 `vitest.config.ts`、`tests/setup.ts` 与 `.test.tsx` 文件头注释；不改任何产品代码与测试断言。
- 已有 6 个文件冗余声明 `@vitest-environment jsdom`（全局 jsdom 时代的遗留），保留不删，与新模型自洽。
- 失败用例集合必须与基线完全一致：优化不允许"顺手修复"或掩盖既有失败。
- 明确不做：`mkdtempSync` 磁盘库改 `:memory:`（119 个文件，独立切片）、长尾定时器用例排查、browser smoke 提速。

## Testing Decisions

基建变更的"被测行为"是套件本身：

- 同树基线与优化后各跑一次完整 `npm test`，记录墙钟与 Vitest 阶段分解；
- 通过/失败文件与用例集合逐项比对，必须一致；
- `npm run build` 通过（setup.ts 为测试专用，但需确认无生产引用）。

## Out of Scope

- 既有失败用例（8 个）与 Windows 环境性失败的修复；
- Playwright 冒烟运行器提速；
- 产品代码的连接管理语义改动（夹具改造只能通过既有测试接缝进行）。

## Further Notes

- 用户确认: 2026-08-09（基于测试慢因分析报告直接指示优化）
