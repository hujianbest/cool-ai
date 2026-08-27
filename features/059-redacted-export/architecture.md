# 架构 — 脱敏对话与项目数据导出

## 边界

- Operations Projection 拥有导出读模型。
- Public Collaboration 仍拥有消息；审计投影仍拥有公开事件。
- 不写工作区、不写 outbox、不新增 Approval。

```text
collaboration 用户可见消息     ──► messages[]
audit_event_projection 事件    ──► events[]
project (+ optional thread)    ──► scope
canonical JSON SHA-256         ──► contentHash
        │
        ▼
GET /api/projects/:id/export ──► 审计视图「导出脱敏包」
```

## 数据

零 schema。不持久化导出包。

## 协议

1. 校验 `projectId`；可选 `threadId`。
2. 确认 Project（及 Thread 属于该项目）。
3. 读取公开消息与审计事件；超 5000 失败关闭。
4. 组装 DTO（先无 hash）→ 规范 JSON → SHA-256 → 填 `contentHash`。
5. `exportedAt` 用传入时钟，测试可注入；生产用请求时刻。

## 安全

- SQL 参数化；复用审计脱敏与公开消息块。
- GET 不是命令。
- 响应扫描测试禁止凭据/路径/prompt/reasoning 标记。

## 测试接缝

- `getRedactedExport`
- `GET /api/projects/:projectId/export`
- 审计面板导出确认
- 聚焦 jsdom；不把 A-412 `smoke:execution` 当本片门

## 取舍

- 挂在审计视图而非 `/team`：UCD 行 12 / §9.2.6 把导出与审计同面（A-425）。
- 浏览器下载而非 DirectoryPicker：避免把包写进项目根（A-422）。
- 当前项目 only：不新造大范围导出 Approval（A-421）。
