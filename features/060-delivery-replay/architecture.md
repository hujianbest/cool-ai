# 架构 — 本地只读交付回放

## 边界

Operations Projection 拥有回放读模型。时间轴事件仍由既有投影提供。不写命令事实。

```text
listProjectTimeline（公开事件）
        │ filter runId
        ▼
GET /api/projects/:id/replay ──► 审计时间轴「打开回放」
```

## 数据

零 schema。`replayHash` = 去掉 hash 后的规范 JSON SHA-256。

## 协议

1. 校验 projectId + 必填 runId。
2. 读取时间轴；只保留 payload.runId 或 executionId 匹配的项。
3. 稳定排序（occurredAt, outboxSeq）；计算 replayHash。

## 测试接缝

- `getDeliveryReplay`
- GET replay 路由
- 审计时间轴回放入口
