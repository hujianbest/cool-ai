# 架构 — 浏览器通知

- 日期: 2026-08-15
- 对应规格: spec.md
- 用户确认: auto-approved 2026-08-15

## 对齐产品架构

落在 Runtime（`CAP-RUN-05`）。通知 Adapter 无业务写权，不替代 Governance Approval。偏好是本机非领域状态，不是 Identity/OPS 事实。

## 本片模块与缝

- `src/adapters/outbound/notification-media/browser-notification-adapter.ts`（或 `components/` 纯客户端模块，因 Notification 只在浏览器）：permission、show、dedupe。服务端不发通知。
- 设置 UI：团队/设置页新分区或现有设置导航增加「通知」。
- `public/manifest.webmanifest` + layout。

## 核心数据

localStorage key `cool-ai:notification-prefs:v1`：`{ version:1, approval:boolean, mission:boolean, seenEventIds:string[] }` seen 列表上限 200。

## 关键流程

1. Owner 打开开关 → 请求 Notification.permission。
2. 可见标签轮询审计 → 新 id 且类型匹配 → showNotification。
3. 点击 → location 既有来源 URL。denied → 设置页降级文案。

## 横切偏离

无新 ADR。不写 SQLite。hf-code-review 因权限边界。
