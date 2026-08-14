# 架构 — 能力画像

- 日期: 2026-08-15
- 对应规格: spec.md
- 用户确认: auto-approved 2026-08-15

## 对齐产品架构

落在 Identity & Capability（`CAP-IDC-03`）。洞察不得反向改写 Agent 角色、权限或业务终态（product/architecture.md）。读投影；Query 不要求 operation/version/lease。Mission 任务字段由入站路由经已公开 Mission 查询传入，不把任务所有权迁入 Identity。

## 本片模块与缝

- 纯函数 `buildCapabilityInsight(input)` 在 `src/modules/identity-capability/`（公开可测）。
- GET `app/api/projects/[projectId]/capability-insight/route.ts` 组装 membership + agents + mission state。
- `components/project-context/mission-board.tsx` 画像与建议 UI。

## 核心数据

无新表。DTO：`portraits[]`、`suggestions[]`（workItemId、agentId、score、reasons[]）。

## 关键流程

1. GET → 三查询 + 纯函数 → JSON。
2. 看板渲染画像；未指派 todo 显示建议。
3. 接受预填负责人；忽略隐藏。刷新后忽略状态不持久（可接受）。

## 横切偏离

无新 ADR。无 outbox。
