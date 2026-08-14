# 规格 — 任务租约与派发控制面

- 特性: 044-work-item-dispatch-lease（S-27）
- 用户确认: auto-approved 2026-08-15
- 评审: spec/architecture 豁免；schema 变更故 implement 后 hf-code-review

## Problem

Owner 看不到任务领取后的租约、心跳、过期与回收。现有 `claimWorkItemTx` 只改 assignee/status，重复领取靠 version 冲突，没有 lease_token 时间线。

## Solution

在同一 work item 事实上增加租约字段（不建第二任务状态机）。领取写入 lease；心跳续期；持有者/owner 可释放；过期后 owner 可回收。确定性 operation/version 冲突。

## User Stories

1. As owner, I want to see holder, expiry, and last heartbeat on in-progress work items.
2. As owner, I want release and reclaim of expired leases to fail closed on version mismatch.

## Decisions

- Schema identity 24→25：`work_items` 增加 `lease_token`、`lease_expires_at`、`last_heartbeat_at`（ISO）。`in_progress` 且有 assignee 则三字段非空；其他 status 则三字段为空。
- TTL 默认 15 分钟（A-309）。心跳把 expires 设为 now+TTL。
- 过期回收不走审批（A-310）；未过期回收拒绝。
- 不新增 outbox 类型；释放/回收走既有 status 变更审计。
- GET 投影挂在 mission state 或 `GET /api/projects/:id/work-item-leases`。UI：使命看板进行中列显示租约与释放/回收。
- 浏览器：`smoke:context` 既有任务上断言租约文案，不新开 Agent 执行。

## Out of Scope

执行 sandbox 租约、Governance 通用回收、自动后台过期扫描进程（读取时派生 expired 即可）。
