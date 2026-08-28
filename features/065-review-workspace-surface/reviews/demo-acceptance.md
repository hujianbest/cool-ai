# 演示验收 — 065 独立复核工作台表面

- 日期: 2026-08-28
- 结论: 接受
- 确认: auto-approved 2026-08-28（下次交互呈上）

## 对照

- 图标轨「任务」→ 任务卡「打开复核」打开工作台，不要求 Execution merged，不依赖「运行详情」tab。
- 标题 `独立复核工作台 · [任务标题]`；无材料时「当前工作项无复核材料」+「刷新复核」。
- Execution 卡片「打开复核闭环」深链仍在（窄屏冒烟）。

## 证据

- mission-board / review wiring / cockpit-layout jsdom 绿
- `npx tsc --noEmit` 通过
- `npm run build` 绿
- `review-browser-full-chain` 1/1（`REVIEW FULL CHAIN PASS` + desktop/narrow 截图）
- 全量 337 文件 / 2929 用例全绿（A-387 关闭）
