# 架构 — 平等协作贡献视图

## 边界

- Operations Projection 拥有贡献读模型。
- Mission & Work 仍拥有 Work Item；Review & Delivery 仍拥有复核裁决；Identity 拥有角色显示名。
- 不读取用量 totals 作为贡献分（A-417）。

```text
work_items (assignee + status)     ──► 规划/实施结果
review_attempts / decisions        ──► 复核质量
project_memberships + agents.role  ──► 职责分组
        │
        ▼
GET /api/contribution ──► /team 协作贡献 region
```

## 数据

零 schema。不写 outbox、不改命令事实。

## 协议

1. 校验可选 `projectId`。
2. 无项目：unknown + 空 roles + `not_ranking`。
3. 有项目：确认 Project；按成员聚合工作项与复核；证据截断 5 条。

## 安全

- SQL 参数化；DTO 只含 id、显示名、计数与标题。
- GET 不是命令。

## 测试接缝

- `getContributionInsight`
- `GET /api/contribution`
- Team 贡献 region
- `smoke:settings` 看到「这不是排行榜」

## 取舍

- 放在 `/team` 而非任务看板：与健康/用量同属 CAP-OPS-03 观测面，不新增轨项（A-418）。
- 证据条数上限 5：避免把投影做成第二套任务列表。
