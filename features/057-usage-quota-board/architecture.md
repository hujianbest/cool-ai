# 架构 — 用量与配额看板

## 边界

- Operations Projection 拥有用量/配额读模型。
- Public Collaboration、Safe Execution、Review & Delivery 仍是模型调用事实 owner。
- Identity 仍是 Agent `max_tokens` / `max_handoffs` 与 Provider 显示名的事实 owner。
- 入站 API 只做传输校验；UI 只消费公开 DTO。
- 预算变更入口是深链，不是新的命令 Interface。

```text
collaboration_model_calls  ──► reported tokens + invalid/unreported
execution_model_calls      ──► 同上，按 source_collaboration_run_id 归入 Run
review_model_calls         ──► 项目 + Provider；不虚构 Run
agents.max_tokens/handoffs ──► budgets[]
providers.name             ──► providers[].name（无凭据）
collaboration_runs.round_count + 已发布轮次上限
        │
        ▼
GET /api/usage ──► /team 用量与配额 region
```

## 数据

零 schema。不新增表、不写 outbox、不改调用事实。

合法 usage 判定与执行预算 CTE 一致：`prompt/completion/total` 均为非负整数且 `total = prompt + completion`。

冻结上限（与现命令侧常量对齐，投影侧只读副本，禁止从命令模块深导入）：

- 协作轮次 50
- 执行业务轮次 20
- 执行工具调用 40

## 协议

1. 校验可选 `projectId`。
2. 无项目：unknown 项目卡、空列表、`disclaimer: "not_invoice"`。
3. 有项目：确认 Project 存在；只读合计本项目调用；按 Run / Provider / Agent 分组。
4. 组装 DTO；未知项目失败关闭。

## 安全

- SQL 全部参数化；先确认 Project。
- DTO 只含计数、稳定 id、Provider/Agent 显示名与 `not_invoice`。
- 不把 GET 变成外部动作或预算写。

## 测试接缝

- Operations Projection `getUsageQuota`。
- `GET /api/usage` 严格查询与 no-store。
- Team 页用量 region 公共行为。
- `smoke:settings` 打开 `/team` 看到「用量与配额」与不是账单声明。

## 取舍

- 不新增设置分区 id：与 A-402 同类，避免 pinned-settings 机械迁移。
- 不写预算：backlog「预算变更需确认」落在既有 Agent 配置确认路径，本片只深链。
- 不估算缺失 token：遵守 A-43，估算只指标注「按已报告用量对照上限」，不是补数。
