# 架构 — 可审计系统规则与提示注入检查

- 日期: 2026-08-27
- 对应规格: `spec.md`
- 用户确认: auto-approved 2026-08-27

## 对齐产品架构

落在 `product/architecture.md` **Identity & Capability**（`CAP-IDC-03` 规则/注入扩展）。洞察不得反向改写 Agent 角色、权限或业务终态。只读 Query，无 operation/version/lease。

## 本片模块与缝

```text
GET /rule-insight
  → membership + agents + skills（既有公开查询）
  → Identity buildRuleInsight(portraits)
  → DTO findings[]
React /team 只消费公开 DTO
```

Identity sqlite Adapter 不为本片 SELECT 工作区或 Mission。

## 核心数据

无新表。DTO：`agents[]`（id、name、scope=project_member）、`findings[]`（id、agentId、sourceType=agent_prompt|skill_instruction、sourceId、code、severity、reason、excerpt）。

## 关键流程

1. GET 校验 projectId → 拉成员与配置 → 纯函数扫描 → JSON。
2. `/team` 渲染 region；block 发现项 alert。
3. 重新检查即再 GET。

## 横切偏离

无新 ADR。无 outbox。安全：摘录脱敏；启发式表冻结在模块内。
