# 架构 — 运行轨迹时间轴

- 日期: 2026-08-15
- 对应规格: spec.md
- 用户确认: auto-approved 2026-08-15

## 对齐产品架构

落在 Operations Projection（`CAP-OPS-02` 时间轴扩展）。只消费已提交审计投影，不拥有 producer。不回写源事实。

## 本片模块与缝

- `listProjectTimeline` 加到 `OperationsProjectionQueries`，实现于 audit-projection-queries 旁或 timeline-queries.ts（同 consumer catchUp）。
- GET `app/api/projects/[projectId]/timeline/route.ts`。
- `components/project-context/audit-panel.tsx` 时间轴视图。

## 核心数据

无新表。过滤/去重/正序在投影表上完成。

## 关键流程

1. GET → ensureProject → catchUp → SQL 过滤/去重/正序 → DTO。
2. UI 切换时间轴 → 渲染；点击已有 href；sourceMissing 占位。

## 横切偏离

无新 ADR。
