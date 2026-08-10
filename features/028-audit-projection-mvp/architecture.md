# 架构 — 审计投影 MVP（AUD-MVP）

- 日期: 2026-08-10
- 对应规格: [`spec.md`](./spec.md)
- 状态: 项目级 review 豁免生效；未送独立评审，不伪造工件

## 架构目标

引入投影模式的最小完整骨架：source-owner 原子 outbox → Operations Projection consumer/checkpoint/rebuild/freshness → 最薄只读查询与 UI。投影永不回写源事实；源 owner 不感知消费者。

## Module 与 Interface

- **Safe Execution（CAP-EXE-05）**：execution_events 写入点同事务追加 `audit_event_outbox`（payload 白名单提取函数集中一处，fail-closed：白名单外字段不得进入）。
- **Operations Projection（CAP-OPS-01/02）**：新领域模块 `src/modules/operations-projection/`（public/{commands,queries,dto,errors}.ts + index.ts）：
  - Commands：`catchUpAuditProjection`、`rebuildAuditProjection`（内部/装配用，不暴露 HTTP 写路由——MVP 由读路径触发 catchUp，rebuild 仅供测试/运维缝调用）。
  - Queries：`listProjectAuditEvents(databasePath, projectId, {limit, beforeSeq?})`、`getAuditProjectionFreshness(databasePath, projectId)`。
- **schema**：三表见 spec；identity 14→15；write-ownership manifest：outbox→safe-execution，projection+checkpoints→operations-projection。
- **不变量**：outbox_seq 全局唯一；checkpoint.last_outbox_seq ≤ max(outbox_seq)；projection ⊆ outbox（按 outbox_seq）；行数差 == lag。
- **API**：GET tuple 路由（`.../audit-events?limit=&before=`、`.../audit-events/freshness`）；严格校验、脱敏 envelope；读路径先 catchUp（同步 MVP）。

## 关键流程

1. Safe Execution 业务写 → execution_events + outbox（同事务提交）。
2. owner 打开审计面板 → catchUp（幂等追平）→ 查询投影 + freshness → 渲染列表与新鲜度。
3. rebuild（测试/运维缝）→ 互斥守卫 → 清空+重放 → 确定性一致校验。

## Seam 与测试点

- Seam 1 — outbox 原子写：tests/adapters/sqlite/safe-execution 现有事件写入测试扩展。
- Seam 2 — consumer/rebuild/freshness：tests/modules/operations-projection/（新）。
- Seam 3 — 查询路由 + UI：tests/browser/ 对应面板。
- Seam 4 — smoke 验收（选覆盖执行面板或项目面板的现有 smoke）。

## 横切约定

- 幂等/重放安全（INSERT OR IGNORE by outbox_seq）；确定性（同 outbox 同投影）；fail-closed（无半成品列表）；tokens/44px/键盘/全态；错误脱敏。

## ADR 链接

- 遵守 ADR-0003；本模式为后续 S-17/S-39/S-35 投影的范式基座，扩展时只加投影种类与新 source outbox 写点，不改 consumer 协议。
