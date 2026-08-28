# 架构 — Agent 署名的记忆提炼与发布

- 日期: 2026-08-27
- 对应规格: `spec.md`
- 用户确认: auto-approved 2026-08-27

## 对齐产品架构

落在 `product/architecture.md` **Knowledge & Provenance**（Memory 链、来源、supersedes、提炼发布状态）与 **Governance**（Approval 查询/分派，不拥有知识正文）。不越界写 Review 表或 Execution 审批表。场景对齐第 11 节独立复核与交付的「署名来源」约束：本片 Owner 裁决替代二次 ReviewAttempt（A-437）。

## 本片模块与缝

Knowledge 深模块：小接口 `proposeCuration` / `listCurationCandidates` / `decideCuration`。实现内完成成员校验、来源校验、diff、状态机、插入 `memory_entries`。

Governance 只增深一处：`listPendingApprovals` 经 Knowledge **公开查询缝**取 pending/replaced，与 `listPendingProposals` 同构。入站 Adapter 校验 DTO 后调上述缝。React 只消费公开 DTO。

```text
Agent/测试 ─► proposeCuration ─► candidates + sources（Knowledge）
Owner ─► listCurationCandidates（含 diff）
Owner ─► decideCuration(publish|reject)
              ├─ publish → memory_entries（agent proposer）
              └─ reject  → 无记忆行
Governance listPendingApprovals ──公开查询──► Knowledge pending
审批中心 / 记忆视图 ──同一 decide 路由──► Knowledge
```

## 核心数据

schema identity 29→30。

- `memory_curation_candidates`：`id`, `project_id`, `agent_id`, `type`, `content`, `supersedes_id?`, `status` (`pending|published|rejected|replaced`), `published_memory_id?`, `operation_id`, `request_hash`, `version`, `created_at`, `decided_at?`
- `memory_curation_sources`：`(candidate_id, position)` → `source_type`, `source_id`, `source_version?`；删除候选不删 `memory_entries`
- 既有 `memory_entries` 不改列；发布 INSERT 新行，不可变触发器保持

## 关键流程

1. **提出**：校验 Project、Agent 成员、≥1 条同源来源、可选 active 同型 supersedes → 插入 pending。非法不落行。
2. **对照**：列表按 `created_at DESC`；对 supersedes 目标算行级文本 diff。
3. **发布**：CAS pending；再校验来源与目标仍合法；同事务写记忆 + 候选 published；operation 重放不双写。目标失效 → replaced，409。
4. **中心**：pending+replaced 入列；落定 published/rejected 不出列。裁决只打 Knowledge 路由。

## 横切偏离

无。失败关闭、脱敏 envelope、`no-store`、write-ownership 登记新表。不启 sandbox / verified-handle。

## ADR 链接

无新 ADR。审批中心跨域聚合沿用 S-24；知识域扩展记 A-434/A-435。
