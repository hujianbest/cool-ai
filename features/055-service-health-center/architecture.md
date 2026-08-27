# 架构 — 服务健康与可观察性中心

## 边界

- Operations Projection 拥有聚合健康读模型。
- Identity、Knowledge、Safe Execution、schema bootstrap 仍是各自信号的事实 owner。
- 入站 API 只做传输校验；UI 只消费公开 DTO。
- 恢复入口是深链，不是新的命令 Interface。

```text
CURRENT_SCHEMA / openDatabase ──► app card
providers.verified_at          ──► providers card
S-29 memory index health       ──► memoryIndex card (project-scoped)
executions status counts       ──► execution card (project-scoped)
        │
        ▼
GET /api/health ──► /team 服务健康 region
```

## 数据

零 schema。不新增表、不写 outbox、不改 `memory_search_index` 契约。

Provider 健康只读持久 `verified_at`，不在 GET 上做连接探测。

## 协议

1. 校验可选 `projectId`。
2. 打开数据库；schema 失败映射 `app.failed`，其余卡片 `unknown`。
3. 计数已验证 Provider。
4. 有项目则调用既有 `getProjectMemoryIndexHealth`（可 catch-up）并投影状态。
5. 有项目则只读统计 Execution：非终态=`active`，终态失败=`failed`。
6. 组装 DTO；任何一步的未知保持 unknown。

## 安全

- SQL 全部参数化；项目卡先确认 Project。
- DTO 只含计数、稳定状态词和短脱敏 detail。
- 不把 GET 变成外部动作或修复命令。

## 测试接缝

- Operations Projection `getServiceHealth`。
- `GET /api/health` 严格查询与 no-store。
- Team 页健康 region 公共行为。
- `smoke:settings` 打开 `/team` 看到四卡。

## 取舍

- 不新增设置分区 id：避免 pinned-settings 机械迁移（A-402）。
- 不实时探测 Provider：健康查询不能成为隐藏的外部调用。
- 不在本片做救援命令：S-44 才建立 `CAP-EXE-04`。
