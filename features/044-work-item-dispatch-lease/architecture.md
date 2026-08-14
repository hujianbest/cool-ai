# 架构 — 任务租约

- 日期: 2026-08-15
- 对应规格: spec.md
- 用户确认: auto-approved 2026-08-15

## 对齐

Mission & Work 唯一任务状态机。租约是 work item 行内字段，不是第二套状态。

## 模块与缝

- 扩展 `claimWorkItemTx` 写入 lease。
- 新命令：heartbeat / release / reclaim（version + operationId）。
- 查询：mission state 或独立 list，DTO 含 holder、expiresAt、lastHeartbeatAt、expired（派生：expiresAt < readAt）。
- 路由严格校验；identity 24→25 机械同步。

## 票

见 tickets.md。无新 ADR。
