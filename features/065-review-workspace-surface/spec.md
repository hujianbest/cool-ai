# 规格 — 独立复核工作台表面

- 切片: 065 / S-62
- 主用户结果: Owner 能从图标轨任务视图打开某一工作项的独立复核工作台，查看冻结复核材料与 Attempt；无材料时看到明确空态，不再依赖已卸下的「运行详情」tab。
- 主 Capability: 不适用（入站 UI Adapter）；消费 `CAP-REV-01`
- 用户确认: auto-approved 2026-08-28
- 评审: spec/architecture 按 A-286/A-459 豁免
- 来源: `product/ui/UI设计.md` §9.5、A-387、A-411、A-453～A-459

## Problem Statement

S-6 已交付独立复核命令与 `ReviewProductSurface`，但 P0 会话优先壳层卸下第四栏后，「打开复核闭环」只藏在 Execution 已 merged 的卡片里，且冒烟仍找「运行详情」tab。Owner 无法从任务卡进入 UCD §9.5 工作台；无材料时也没有该视图的空态。

## Solution

在图标轨「任务」治理视图为每个工作项提供「打开复核」。点击后在同一治理面打开既有 `ReviewProductSurface`，chrome 对齐 UCD：标题 `独立复核工作台 · [任务标题]`，顶栏沿用 `← 返回对话`。无复核材料时展示「当前工作项无复核材料」。不新增 schema 或写 API。

## User Stories

1. As Owner, I want to open a work item's review workspace from the task board, so I do not have to find a merged execution card.
2. As Owner, I want the workspace titled as an independent review surface, so I can tell it apart from execution details.
3. As Owner, I want an empty state when a work item has no review material, so the entry is always honest.
4. As Owner, I want existing start/answer/pass/rework flows to keep working, so remounting does not fork the review lifecycle.

## Implementation Decisions

- 零 schema、零新写路由（A-454）。加载仍走 `GET /api/work-items/:workItemId/review`。
- 挂载：任务治理视图（A-455）。不新增 `GovernanceView` 或图标轨项。
- 入口：任务卡「打开复核」，不要求 Execution `merged`，不依赖「运行详情」tab（A-456）。
- Execution 卡片保留「打开复核闭环」深链，避免打断既有接线断言。
- 打开后复用 `ReviewProductSurface`（`ReviewWorkspace` / `ReviewAccessSurface`）；不复制裁决状态机。
- 交付摘要仍走看板 `MissionDeliverySurface`（A-457）。
- 不伪造 Thinking、完整 Markdown、迷你头像或新复核命令（A-458）。

## UI 设计

- 信息架构：图标轨「任务」→ 任务卡「打开复核」→ 同面工作台；`ESC` / `← 返回对话` 仍关闭治理视图。
- chrome：治理顶栏标题在打开复核时为 `独立复核工作台 · [任务标题]`；未打开时保持 `任务看板 · 项目`。
- 全态：loading 用既有无动画令牌骨架；empty「当前工作项无复核材料」+ ≥44px「刷新复核」；error 可重试；disabled 沿用既有非复核者原因；success 沿用既有裁决报告；focus 落在打开后的主操作（发起复核或提交裁决）。
- 控件 ≥44px；颜色/间距/焦点环只用 `tokens.css`；禁止 emoji 图标与硬编码色。
- 亮/暗/窄屏沿用治理视图既有壳。

## Testing Decisions

- 缝：任务看板 jsdom（「打开复核」存在并可打开工作台）+ 既有 review product wiring + `review-browser-full-chain` 改走任务视图。
- 好测试：任务卡不必等 merged execution；空态文案；打开后可见复核表面；冒烟不再找「运行详情」tab。
- 范例：`tests/browser/project-context/`、`tests/browser/review/review-product-wiring.test.tsx`、`tests/browser/review-browser-smoke.mjs`。

## Out of Scope

- S-45 族 / S-50；§9.5.2 交付导出重建；新复核命令；Thinking / 完整 Markdown。

## Further Notes

- 用户确认: auto-approved 2026-08-28
