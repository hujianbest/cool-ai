# 架构 — SOP 状态投影

- 日期: 2026-08-15
- 对应规格: [`spec.md`](./spec.md)
- 用户确认: auto-approved 2026-08-15
- 状态: spec/architecture 豁免；verified-handle 故 implement 后 hf-code-review

## 对齐产品架构

落在 Mission & Work（`CAP-MWK-03` 读投影）。消费 Project & Workspace `CAP-PWS-02` 浏览 Interface，不夺取文件所有权。不新增写表。对齐 `product/architecture.md`：SOP 读投影可变，任务状态机不变。

## 本片模块与缝

- Mission & Work Queries 新增 `getSopStateProjection(databasePath, projectId)`。
- Adapter：`src/adapters/outbound/sqlite/mission-work/sop-state-projection.ts` 读 `getMissionState`，经 workspace browse + verified-handle 列 `features/`、读各 `progress.md`。
- 入站：`GET /api/projects/[projectId]/sop-state`（无 query、严格 DTO）。
- UI：使命看板只读区 `流程状态`，定位匹配任务复用看板已有 locate。

## 核心数据

```
SopStateProjection { workspaceBound, readAt, items[] }
SopStateItem {
  relativePath, title, declaredStage,
  freshness: current | stale,
  staleReason: null | source_unreadable | declared_stage_diverges,
  workItems: [{ workItemId, title, status }]
}
```

无新表。relativePath 永不含宿主盘符。

## 关键流程

1. UI 打开使命看板 → GET sop-state → 列表 + 陈旧提示。
2. 未绑定 / 无 `features/` → empty，不报 404。
3. 点击匹配任务 → 现有任务定位，无写入口。

## 横切

tokens / 44px / 键盘 / empty-loading-error；错误脱敏；敏感文件不解析。

## ADR

无新 ADR。遵守 ADR-0003（零 schema）。
