# 规格 — Agent 署名的记忆提炼与发布

- 切片: 063 / S-32
- 主用户结果: 项目内真实 Agent 基于精确来源提出提炼候选；Owner 看到署名、相对链头的差异与 supersedes；来源未校验或未经治理确认的内容不能成为共享记忆。
- 主 Capability: `CAP-KNW-04`
- 用户确认: auto-approved 2026-08-27
- 评审: spec/architecture 按 A-286 豁免
- 来源: `product/backlog.md` S-32、`product/architecture.md` Knowledge / Governance、`product/ui/UI设计.md` §9.2.4 / §9.2.5、`product/词汇表.md`、A-434～A-442

## Problem Statement

共享记忆目前只有两条写入：Owner 手工 `createMemory`（提议者恒为 owner），以及复核通过后的 `review_memory_candidates` 沉淀。Agent 无法在复核工作项之外，带着自己的署名和精确来源提出提炼/反思；Owner 也没有对照链头的差异和治理确认入口。若允许无来源或自发布内容进入 `memory_entries`，会破坏「聊天不会自动升级为知识」与「执行者不能独自宣布成功」的同类约束。

## Solution

Knowledge 拥有**提炼候选**：绑定项目内真实 Agent、至少一条已校验来源、可选 supersedes 目标。候选不是共享记忆。Owner 在记忆视图对照署名与文本 diff，并在统一审批中心或记忆视图批准/驳回。只有批准才插入 `memory_entries`（`proposer_actor_type=agent`）。Governance 经 Knowledge 公开查询缝聚合 `domain=knowledge`，零新 Governance 表。

## User Stories

1. As an Agent (project member), I want to propose a sourced curation candidate, so that my attribution is frozen before anything is shared.
2. As Owner, I want to see the proposing Agent, source links, and a diff against the current chain head, so I can decide whether to publish or supersede.
3. As Owner, I want publish to fail closed when any source is missing, cross-project, or unverifiable, so unverified text cannot become Memory.
4. As Owner, I want to approve or reject in the approval center or memory view, so there is one decision state and Agents cannot self-publish.
5. As Owner, I want published memories to show Agent attribution and the supersedes chain, so later retrieval and the graph stay honest.

## Implementation Decisions

- schema identity **29→30**。新表 `memory_curation_candidates`（提案正文与状态）+ `memory_curation_sources`（有序来源边）。不复用 `review_memory_candidates`（Review owner，绑定 attempt）。
- 深模块缝（Knowledge）：`proposeCuration` / `listCurationCandidates` / `decideCuration`（publish|reject）。校验、diff、写入记忆藏在实现内；调用方只传 project、agent、类型、正文、来源、可选 supersedes、operation。
- `createMemory` 手工路径保持 owner 提议；禁止经该缝把 proposer 写成 agent（A-440）。
- 来源类型复用既有 Memory source 白名单与 `validateSource`；至少一条；跨项目/缺失 → 明确错误，不写候选。
- Agent 必须是当前项目成员；模型调用不在本片（A-436）。
- 相对 supersedes 目标（须同项目、同类型、active）计算纯文本 diff（行级，DTO 字段 `diff`）；无目标则为新建，`diff` 为全文新增。
- 发布：同源再校验 → INSERT `memory_entries`（agent proposer、`confirming_review_attempt_id` 空、`persistence_actor=platform`、supersedes 若有）→ 候选 `published`。驳回：`rejected`，零记忆行。目标不再 active → `replaced`，不可裁决。
- 幂等：同一 `operationId` 重放返回同一结果，不重复插入记忆。
- Governance：`listPendingApprovals` 增加经 Knowledge 公开查询缝的 pending/replaced 项；`domain=knowledge`，`kind=memory_publish`，`approvalId=candidateId`。`sourceRef` 增补可空 `candidateId` / `memoryId`（既有四键保持）。裁决分派 POST Knowledge 发布/驳回路由，零新写路由在 Governance。
- 无 TTL（A-441）；replaced 映射 `decisionHint=replaced`。
- HTTP：`GET/POST /api/projects/:projectId/memory-curation-candidates`；`POST .../:candidateId/publish` 与 `.../reject`；严格 JSON、`no-store`、脱敏 envelope。
- 审计：Knowledge 已有记忆写入路径可复用公开事件；候选提出/发布/驳回不得写入凭据、提示词或宿主绝对路径。

## UI 设计

- 挂载：图标轨「记忆」视图（UCD §9.2.4），不装回复核工作台。
- 分组：健康条/检索之下、记忆卡片之上增加 region「提炼候选」。
- 全态：loading 用既有骨架；empty「暂无待发布的提炼候选」；error `role=alert`；success 候选出列并聚焦新记忆卡；提交中按钮 disabled。
- 候选项：Agent 显示名、类型、正文、来源链接、相对链头的文本 diff、`批准发布` / `驳回`（≥44px）。纯图标须 `aria-label`。令牌走 `tokens.css`，不硬编码色/间距，不用 emoji 当图标。
- 已发布卡片：提议者为 Agent 且无复核 confirmer 时文案「Agent {name} 提议 · Owner 经审批发布 · 平台持久化」。
- 审批中心：知识域徽标「知识」；标题为正文截断；影响为「新建」或「将取代 V{n}」；批准/驳回分派本片路由。Needs Me 计入 pending knowledge 项。

## Testing Decisions

- 缝：Knowledge 公开命令/查询；Governance `listPendingApprovals`；HTTP 路由；memory-panel 与 approval-center jsdom。
- 好测试：无来源/跨项目/非成员 Agent 不能落候选；重复 operation 不双写记忆；驳回后检索不到新记忆；中心与记忆视图同一候选状态。
- 范例：`tests/modules/knowledge-provenance/`、`tests/modules/governance/approval-center*.ts`、`tests/browser/project-context/` 记忆与审批面板。
- 浏览器：记忆 jsdom 为主；`smoke:context` 若仍受 A-401 限制则不作为本片门，改 jsdom + 真实渲染核对。

## Out of Scope

- 对话中自动模型提炼、sandbox 提炼工具、verified-handle 读文件（A-436）。
- 把候选绑到 ReviewAttempt / 非执行者二次复核（A-437）。
- 新 Governance 表、TTL、手工 createMemory 改 proposer。
- S-34 规则注入、S-45 族、跨项目知识。

## Further Notes

- 用户确认: auto-approved 2026-08-27
