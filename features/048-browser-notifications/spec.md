# 规格 — 最小权限浏览器通知与 PWA

- 特性: 048-browser-notifications（S-41）
- 用户确认: auto-approved 2026-08-15
- 评审: spec/architecture 豁免；通知权限故 implement 后 hf-code-review

## Problem

Owner 离开驾驶舱后看不到新审批或任务提醒。没有按类型授权、去重、拒绝权限降级，也没有可安装的最小 PWA 壳。

## Solution

本机 Notification API（仅当前打开的 Origin，不接 Web Push）。设置里按事件类型授权；新的审批/任务审计事件弹出最小标题（无项目正文）；点击回到已有审批/任务定位 URL。权限拒绝或 Notification 不可用时静默降级文案。可安装 web manifest。通知不能批准任何事。

## User Stories

1. As owner, I want to enable notifications for 审批 and/or 任务 so I am reminded without leaking body text.
2. As owner, I want click-through to the existing approval or task locate URL so I can act in the cockpit.
3. As owner, I want deny/unavailable to show a stable degraded message and never auto-execute or auto-approve.

## Decisions

- 不使用 Web Push / 服务端订阅密钥（A-334）。无新 schema。偏好进本机 localStorage，与 settings preferences 同类非领域偏好（A-335）。
- 事件源：已打开项目时轮询 GET audit-events 或 timeline（间隔 ≥15s，页面可见才轮询）（A-336）。去重键 = 投影事件 `id`。
- 通知标题固定短文案如「待处理审批」「任务有更新」；body 不含记忆/消息/路径/密钥；tag=event id。
- 类型开关：`approval`（governance 域事件）、`mission`（mission-work 域）。默认全关。
- 点击：`/projects/{id}/approvals/{approvalId}` 或既有 tasks/missions href；无身份则只聚焦驾驶舱，不编造。
- PWA：`public/manifest.webmanifest` + layout link；theme 用已有 token 色；SVG 图标自建，不复制外部品牌。不做离线缓存业务数据（A-337）。
- 浏览器验收：`smoke:settings` 或 `smoke:context` 用 stubbed Notification；不为通知新开 Agent（A-338）。
- 审计：偏好变更写 settings preference 事件流（已有 pin 事件先例）或 progress 记录「本片不落领域 outbox」（A-339：不写 audit outbox，避免 Runtime 越权写投影）。

## Testing

- 缝：通知 Adapter 纯函数（permission/dedupe/copy）+ settings UI + smoke stub。
- 断言：关闭开关不弹；denied 不抛；body 无秘密；点击不调用审批 POST。

## Out of Scope

Web Push、后台 daemon、语音（S-50）、通知代替审批。
