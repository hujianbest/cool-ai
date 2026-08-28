# 架构 — 独立复核工作台表面

- 日期: 2026-08-28
- 对应规格: `spec.md`
- 用户确认: auto-approved 2026-08-28

## 对齐产品架构

落在入站 UI Adapter。领域事实仍由 Review & Delivery（`CAP-REV-01`）拥有。本片不新增 Query/Command，不改 schema，不写 outbox。

## 本片模块与缝

```text
任务看板工作项卡
  → 「打开复核」
  → 同面 ReviewProductSurface(missionId, projectId, workItemId)
  → GET /api/work-items/:id/review（既有）
```

Mission / Execution sqlite Adapter 不为本片增加跨 owner 读。

## 核心数据

无新表。UI 状态仅：当前打开的 `workItemId`（可选）与既有 `ReviewProductSurface` 内部态。

## 关键流程

1. Owner 打开图标轨任务视图，点击任务卡「打开复核」。
2. 治理标题切到 `独立复核工作台 · [任务标题]`，挂载既有复核表面。
3. 表面按既有 DTO 渲染材料 / Attempt / 空态 / 错误。
4. `← 返回对话` 关闭治理视图；再次点任务回到看板。

## 横切偏离

无新 ADR。安全：不扩大复核写面，不回显凭据或隐藏推理。
