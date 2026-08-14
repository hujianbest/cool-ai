# 产品演进 Backlog

本文件使用四级治理，避免把产品方向、架构能力、用户切片和实现票据混成同一层：

1. **产品主题**：一组长期用户结果及其边界；本轮用八个主题簇组织追踪别名。
2. **子系统能力**：由唯一事实 owner 通过公开 Capability Interface 提供的稳定领域能力；Application Workflow、入站/UI Adapter 和交付证据是架构单元，不冒充领域 Capability。
3. **可演示特性切片**：一个 actor、一个主要用户结果和一个主要架构单元形成的端到端结果；`S-*` 可以是已可实现切片，也可以是进入 `implement` 前必须拆分的历史产品追踪别名。
4. **RED/GREEN 票据**：为单个切片服务的最小行为增量；每票先有从公共缝失败的 RED，再做最小 GREEN，不在本文件把票据冒充产品需求。

准入规则：

- 真正进入 `implement` 的切片只允许一个主要 actor、一个主要用户结果和一个主要架构单元；领域切片标明唯一主子系统/主领域 Capability，其他子系统通过已公开 Capability Interface 参与。
- 只改变 Application Workflow、入站/UI Adapter 或交付证据、不新增领域事实的切片，必须写 `主领域 Capability: 不适用`，并列出主要架构单元、消费的真实 Capability 和不适用理由；追踪链为“产品主题 → 架构单元 + 消费 Capability → 可演示切片 → RED/GREEN 票据”。
- 历史 `S-*` 可以保留为产品追踪别名；如果其发布结果需要多个 owner producer 或超过治理阈值，必须在进入 `implement` 前拆成多个新编号的真正切片，每个子片重新满足单一主架构单元和票据阈值，别名本身不进入实现。
- D-40 之后新进入 `implement` 的切片通常拆为 3–8 张 RED/GREEN 票据；超过 12 张，或必须同时改变 3 个及以上子系统，应在进入实现前拆分。
- S-13 是 grandfathered 在途例外：它在 D-40 前已经批准并完成 16 张票，A-92/A-93 记录了唯一 writer 与 v8 migration 两个受控 expand-contract 波次；不追溯重拆。证据见 [`tickets.md`](../features/015-structured-messages-inline-decisions/tickets.md) 与 [`progress.md`](../features/015-structured-messages-inline-decisions/progress.md)。
- 未交付切片分别列出“已交付前置”和“本片建立”。只有清单中状态和证据成立的 Capability 才称为已交付；规划中的前置必须标为阻塞或待验证。
- 页面不作为架构依赖。切片编号只用于历史追踪；跨切片准入必须落到具名 Capability Interface 及其状态。
- 勾选只在切片 ship 后由 hf-ship 执行。未勾选项不得因规格、代码或评审存在而描述为已交付。
- S-1～S-12 保留已 ship 的历史记录和原演示判据；S-13～S-50 保留既有编号与用户结果，不改写已交付 feature 历史。

## Capability 清单

Capability ID 是稳定治理标识；owner 是唯一逻辑子系统，不等于页面或目录。状态只描述当前仓库：**已交付核心**可作为前置，**部分可用**必须限定已交付范围，**规划中**不能作为已可用前置。

### Identity & Capability

- `CAP-IDC-01` Provider / Agent / Skill Core — owner: Identity & Capability — 状态: 已交付核心 — 证据/建立切片: S-2；`src/adapters/outbound/sqlite/identity-capability/provider-service.ts`、`src/adapters/outbound/sqlite/identity-capability/agent-service.ts`、`tests/modules/identity-capability/providers.service.test.ts`
- `CAP-IDC-03` Capability & Rule Insight — owner: Identity & Capability — 状态: 部分可用（可解释能力画像与只读路由建议已交付；规则/注入检查未覆盖）— 证据/建立切片: S-33 [`progress.md`](../features/046-capability-insight/progress.md)；规则扩展 S-34

### Project & Workspace

- `CAP-PWS-01` Project / Workspace Binding Core — owner: Project & Workspace — 状态: 已交付核心 — 证据/建立切片: S-3；`src/adapters/outbound/sqlite/project-workspace/projects.ts`、`tests/modules/project-workspace/projects.service.test.ts`
- `CAP-PWS-02` Verified Workspace Browse — owner: Project & Workspace — 状态: 已交付核心（单绑定根浏览/预览；多根管理与 diff 预览未覆盖）— 证据/建立切片: S-22 [`progress.md`](../features/027-workspace-readonly-browser/progress.md)
- `CAP-PWS-03` Public Project Events — owner: Project & Workspace — 状态: 已交付核心 — 证据/建立切片: S-23 AUD-PWS（分配实现片号 S-52）[`progress.md`](../features/036-project-workspace-audit-events/progress.md)（6 类事件同事务 outbox、宿主路径脱敏 fail-closed、审计中心可查询并规范身份导航，复用已交付 `CAP-OPS-01/02`）

### Mission & Work

- `CAP-MWK-01` Mission / Work Core — owner: Mission & Work — 状态: 已交付核心 — 证据/建立切片: S-3～S-6；`src/adapters/outbound/sqlite/mission-work/mission-service.ts`、`tests/modules/mission-work/mission-crud.test.ts`
- `CAP-MWK-02` Mission Dependency Insight — owner: Mission & Work — 状态: 已交付核心 — 证据/建立切片: S-25 [`progress.md`](../features/026-mission-dependency-insight/progress.md)
- `CAP-MWK-03` SOP State Projection — owner: Mission & Work — 状态: 已交付核心 — 证据/建立切片: S-26 [`progress.md`](../features/043-sop-state-projection/progress.md)
- `CAP-MWK-04` Dispatch Lease Control — owner: Mission & Work — 状态: 已交付核心 — 证据/建立切片: S-27 [`progress.md`](../features/044-work-item-dispatch-lease/progress.md)
- `CAP-MWK-05` Public Mission / Work Events — owner: Mission & Work — 状态: 已交付核心 — 证据/建立切片: S-23 AUD-MWK（实现片号 S-51，与同日并行交付的整体 UI 改版片号双占，见 A-256）[`progress.md`](../features/035-mission-work-audit-events/progress.md)（7 类事件同事务 outbox、审计中心可查询并规范身份导航，复用已交付 `CAP-OPS-01/02`）

### Public Collaboration

- `CAP-COL-01` Public Collaboration Core — owner: Public Collaboration — 状态: 已交付核心 — 证据/建立切片: S-4、S-12；`src/adapters/outbound/sqlite/public-collaboration/thread-service.ts`、`tests/modules/public-collaboration/thread-message-api.test.ts`
- `CAP-COL-02` Thread Catalog & Lifecycle — owner: Public Collaboration — 状态: 已交付核心（Thread 创建、列表、切换、成员策略、回复引用与精确跳转、项目内标签与批量整理、回收站生命周期已交付）— 证据/建立切片: S-12 [`progress.md`](../features/014-persistent-project-threads/progress.md)、S-14 [`progress.md`](../features/022-reply-references/progress.md)、S-18 [`progress.md`](../features/032-thread-tags-bulk-organize/progress.md)、S-20 [`progress.md`](../features/033-thread-recycle-bin/progress.md)
- `CAP-COL-03` Structured Content & Inline Decision — owner: Public Collaboration — 状态: 已交付核心（S-13 于 2026-08-10 ship；File Reference 冻结、reopen 穷尽验证与 stale 对账由 017/018 子片加固）— 证据/建立切片: S-13 [`tickets.md`](../features/015-structured-messages-inline-decisions/tickets.md)、[`progress.md`](../features/015-structured-messages-inline-decisions/progress.md)
- `CAP-COL-04` Composer & Queue Continuity — owner: Public Collaboration — 状态: 已交付核心（按线程草稿、附件占位、输入历史与清除策略、线程内消息队列/重排/撤回/受控 steer 已交付）— 证据/建立切片: S-15 [`progress.md`](../features/023-thread-drafts/progress.md)、S-21 [`progress.md`](../features/034-thread-message-queue-steer/progress.md)
- `CAP-COL-05` Message Media — owner: Public Collaboration — 状态: 已交付核心（图片附件；非图片媒体未覆盖）— 证据/建立切片: S-16 [`progress.md`](../features/024-image-attachments/progress.md)
- `CAP-COL-07` Public Collaboration Events — owner: Public Collaboration — 状态: 已交付核心 — 证据/建立切片: S-23 AUD-COL [`progress.md`](../features/030-collaboration-audit-events/progress.md)（16 类事件同事务 outbox、审计中心可查询并规范身份导航，复用已交付 `CAP-OPS-01/02`）

### Safe Execution 与 Governance

- `CAP-EXE-01` Safe Execution Core — owner: Safe Execution — 状态: 已交付核心 — 证据/建立切片: S-5；`src/adapters/outbound/sqlite/safe-execution/execution-service.ts`、`src/adapters/outbound/workspace/windows-verified-execution-adapter.ts`、`tests/adapters/sqlite/safe-execution/execution-security-integration.test.ts`
- `CAP-EXE-02` Controlled Workspace Mutation — owner: Safe Execution — 状态: 规划中 — 建立切片: S-42
- `CAP-EXE-03` Interactive Process & Preview — owner: Safe Execution — 状态: 规划中 — 建立切片: S-43
- `CAP-EXE-04` Recovery Operations — owner: Safe Execution — 状态: 规划中 — 建立切片: S-44
- `CAP-EXE-05` Public Execution Events — owner: Safe Execution — 状态: 已交付核心（execution_events 15 写入点同事务白名单 outbox）— 证据/建立切片: S-23 AUD-MVP [`progress.md`](../features/028-audit-projection-mvp/progress.md)
- `CAP-GOV-01` Safe Execution Approval & Operation — owner: Governance — 状态: 部分可用（只覆盖 Safe Execution 冻结 execution/staged-merge 路径，不是通用 Governance）— 证据/建立切片: S-5；`src/adapters/outbound/sqlite/safe-execution/execution-approval-service.ts`、`tests/modules/safe-execution/execution-approvals.test.ts`
- `CAP-GOV-02` Unified Governance — owner: Governance — 状态: 已交付核心（执行+内联决策两域聚合/裁决分派/失效呈现）— 证据/建立切片: S-24 [`progress.md`](../features/029-unified-approval-center/progress.md)
- `CAP-GOV-03` Public Governance Events — owner: Governance — 状态: 已交付核心 — 证据/建立切片: S-23 AUD-GOV（分配实现片号 S-53）[`progress.md`](../features/037-governance-audit-events/progress.md)（5 类 Approval 生命周期事件同事务 outbox、审计中心可查询并规范 approval 身份导航，复用已交付 `CAP-OPS-01/02`）

### Review、Knowledge、Runtime 与 Projection

- `CAP-REV-01` Independent Review & Delivery Core — owner: Review & Delivery — 状态: 已交付核心 — 证据/建立切片: S-6；`src/adapters/outbound/sqlite/review-delivery/review-application-service.ts`、`src/adapters/outbound/sqlite/review-delivery/delivery-service.ts`、`tests/modules/review-delivery/review-production-application.test.ts`
- `CAP-KNW-01` Provenance Memory Core — owner: Knowledge & Provenance — 状态: 已交付核心 — 证据/建立切片: S-3、S-6；`src/adapters/outbound/sqlite/knowledge-provenance/memory-service.ts`、`tests/modules/knowledge-provenance/memory-source-navigation.test.ts`
- `CAP-KNW-02` Knowledge Search & Index Lifecycle — owner: Knowledge & Provenance — 状态: 部分可用（项目隔离记忆检索与证据定位已交付；专用 FTS 索引/checkpoint/健康诊断未覆盖）— 证据/建立切片: S-28 [`progress.md`](../features/045-knowledge-search/progress.md)；健康扩展 S-29
- `CAP-KNW-03` Collections & Provenance Graph — owner: Knowledge & Provenance — 状态: 规划中 — 建立切片: S-30、S-31
- `CAP-KNW-04` Agent Curation — owner: Knowledge & Provenance — 状态: 规划中 — 建立切片: S-32
- `CAP-RUN-01` OpenAI Runtime Core — owner: Runtime — 状态: 已交付核心 — 证据/建立切片: S-2、S-4；`src/adapters/outbound/model-runtime/provider-verifier.ts`、`tests/adapters/model-runtime/provider-verifier.test.ts`
- `CAP-RUN-02` External Runtime Host — owner: Runtime — 状态: 规划中 — 建立切片: S-45、S-46
- `CAP-RUN-03` MCP Host — owner: Runtime — 状态: 规划中 — 建立切片: S-47
- `CAP-RUN-04` Extension Lifecycle & Catalog — owner: Runtime — 状态: 规划中 — 建立切片: S-48、S-49
- `CAP-RUN-05` Browser Notification — owner: Runtime — 状态: 已交付核心（本机 Notification、按类型授权、去重、拒绝降级、可安装 manifest；无 Web Push）— 证据/建立切片: S-41 [`progress.md`](../features/048-browser-notifications/progress.md)
- `CAP-RUN-06` Voice Adapter — owner: Runtime — 状态: 规划中 — 建立切片: S-50
- `CAP-RUN-07` Public Runtime Events — owner: Runtime — 状态: 已交付核心 — 证据/建立切片: S-23 AUD-RUN（分配实现片号 S-57）[`progress.md`](../features/041-runtime-audit-events/progress.md)（`callOpenAiChat` 成败同事务脱敏 outbox、审计中心可查询并按 surface 规范导航，复用已交付 `CAP-OPS-01/02`）
- `CAP-OPS-01` Projection Consumer Foundation — owner: Operations Projection — 状态: 已交付核心（outbox/checkpoint/rebuild/freshness 基座）— 证据/建立切片: S-23 AUD-MVP [`progress.md`](../features/028-audit-projection-mvp/progress.md)；只消费 source owner 已提交事件，不拥有 producer
- `CAP-OPS-02` Audit / Search / Timeline Projection — owner: Operations Projection — 状态: 已交付核心（Safe Execution 审计最薄只读查询/展示、项目隔离线程搜索、统一审计按域筛选、跨任务去重时间轴已交付）— 证据/建立切片: S-23 AUD-MVP [`progress.md`](../features/028-audit-projection-mvp/progress.md)、S-17 [`progress.md`](../features/031-thread-search/progress.md)、S-58 AUD-UI [`progress.md`](../features/042-audit-browser-filters/progress.md)、S-39 [`progress.md`](../features/047-run-timeline/progress.md)
- `CAP-OPS-03` Health / Usage / Contribution Insight — owner: Operations Projection — 状态: 规划中 — 建立切片: S-29、S-35～S-37
- `CAP-OPS-04` Redacted Export & Delivery Replay — owner: Operations Projection — 状态: 规划中 — 建立切片: S-38、S-40

## 已交付切片记录

S-9～S-12 的 `依赖: S-*` 是原历史文字，只说明当时切片记录；下面新增的“目标架构映射”是 2026-08-09 的治理映射，不宣称这些 Capability Interface 当时已经按目标架构实现。

- [x] S-1 行走骨架 — 主子系统: Project & Workspace；主 Capability: `CAP-PWS-01`；票据: 未建立（[feature 状态](../features/001-walking-skeleton/progress.md)，目录无 `tickets.md`）；演示判据: owner 能按 README 一条命令启动应用，在温暖浅色的协作驾驶舱中创建示例项目并提交任务；左侧导航、中间事件流、右侧上下文形成真实端到端路径，确定性示例 Agent 的排队、运行、完成状态可见，刷新或重启后记录仍在
- [x] S-2 配置有技能的第一支 Agent 小队 — 主子系统: Identity & Capability；主 Capability: `CAP-IDC-01`；票据: 未建立（[feature 状态](../features/002-agent-team-configuration/progress.md)，目录无 `tickets.md`）；演示判据: owner 能添加并验证 OpenAI-compatible 服务，创建可复用文本技能，基于可编辑模板创建至少两个具有不同头像与强调色的角色 Agent，并配置模型、技能、工具权限与预算，刷新后配置仍在
- [x] S-3 创建项目、组队并建立共享上下文 — 主子系统: Project & Workspace；主 Capability: `CAP-PWS-01`；票据: 未建立（[feature 状态](../features/003-project-team-context/progress.md)，目录无 `tickets.md`）；演示判据: owner 能绑定本地产品工作区、选择角色 Agent 入组，并在项目页看到平等成员、使命看板，以及所有组员可读取且带来源的目标、决策、事实与产物记忆
- [x] S-55 打开本地文件夹即进入/恢复 Project — 主子系统: Project & Workspace；主 Capability: `CAP-PWS-01`；票据: [`features/039-folder-is-project/tickets.md`](../features/039-folder-is-project/tickets.md)；演示判据: owner 打开本机文件夹即进入该协作项目（显示名为目录名、工作区已绑定），再打开同一路径恢复而非复制；约束: 工作区=打开的目录即唯一绑定根，verified-handle=打开时必需，sandbox=打开不授予执行，凭据=错误脱敏，审批=不适用，独立复核=交付必需（项目级 review 豁免按 AGENTS.md 记录于 progress），审计=project_created 与 workspace_bound 同事务；不复制 Clowder 品牌、源码或资产
  - 排期: 2026-08-14 用户要求对齐 Codex/Cursor「打开的文件夹就是项目」，不再先填项目名称。
  - 准入: 已交付前置: `CAP-PWS-01` 名称创建与 bind、`CAP-PWS-02` 单根浏览；本片建立: owner 打开文件夹 create-or-resume（已交付）。
- [x] S-56 未选项目时单 Agent 聊天 — 主子系统: Project & Workspace；主 Capability: `CAP-PWS-01`；票据: [`features/040-home-direct-chat/tickets.md`](../features/040-home-direct-chat/tickets.md)；Ship: 2026-08-15；演示判据: owner 打开 `/` 未选文件夹项目时中栏是与一名 Agent 的聊天窗（有 Agent 则可发送；无 Agent 则引导配置）；不能在此态开展多 Agent 群聊或使命看板；打开文件夹项目后既有群聊不回归
  - 排期: 2026-08-14 对照 pi-agent 等 WebUI；2026-08-15 与 S-55 一并验证（A-285）。
  - 准入: 已交付前置: `CAP-PWS-01`、`CAP-COL-01`、`CAP-IDC-01`；本片建立: 个人对话容器 1 成员与 home 聊天列（已交付）。
- [x] S-58 统一审计浏览器按域筛选（S-23 AUD-UI） — 主子系统: 不适用；主领域 Capability: 不适用（只改变入站 UI Adapter，不新增领域事实）；主要架构单元: 入站 UI Adapter；消费 Capability: `CAP-EXE-05`、`CAP-PWS-03`、`CAP-COL-07`、`CAP-MWK-05`、`CAP-GOV-03`、`CAP-RUN-07`、`CAP-OPS-01`、`CAP-OPS-02`；票据: [`features/042-audit-browser-filters/architecture.md`](../features/042-audit-browser-filters/architecture.md)；Ship: 2026-08-15（客户端按域筛选，`smoke:execution` Runtime 23 断言 / axe 2 态 0 serious/critical）；演示判据: owner 能按执行/协作/任务/项目/治理/运行时筛选已交付审计来源并跳回精确来源；约束: 工作区=项目隔离，verified-handle=不适用，sandbox=只读，凭据=强制脱敏，审批=不适用，独立复核=交付必需（轻量级纯 UI，hf-code-review 豁免记录于 progress），审计=不新增写事实；不复制 Clowder 品牌、源码或资产
  - 排期: 2026-08-15 作为 S-23 最终组合纵切自动交付。
  - 准入: 已交付前置: 各 source event Capability 与 `CAP-OPS-01/02`；本片建立: 统一审计按域筛选（已交付）。
- [x] S-4 在群聊发起使命并观察自主编排 — 主子系统: Public Collaboration；主 Capability: `CAP-COL-01`；票据: 未建立（[feature 状态](../features/004-collaboration-orchestration/progress.md)，目录无 `tickets.md`）；演示判据: owner 在项目群聊提交真实目标后，至少两个 Agent 通过真实模型调用拆分带依赖的子任务、领取任务并结构化交棒；owner 可发言、@Agent、回答决策请求，并看到当前持棒者、用量和完整时间线
- [x] S-5 并行且安全地执行项目工作 — 主子系统: Safe Execution；主 Capability: `CAP-EXE-01`；票据: 未建立（[feature 状态](../features/005-safe-parallel-execution/progress.md)，目录无 `tickets.md`）；演示判据: 两名 Agent 能并行处理独立子任务，在绑定工作区产出隔离变更并按需运行验证；平台阻止重复接力、失效结果、预算越限和未合并冲突，越界或高风险动作只有 owner 批准后才能继续
- [x] S-6 同伴复核、沉淀记忆并交付结果 — 主子系统: Review & Delivery；主 Capability: `CAP-REV-01`；票据: 未建立（[feature 状态](../features/006-peer-review-memory-delivery/progress.md)，目录无 `tickets.md`）；演示判据: 非执行者 Agent 能复核各子任务并决定退回、升级或通过；通过后关键决策、事实、产物和经验进入共享记忆，owner 获得最终摘要与证据，应用重启后仍可追溯完整历史
- [x] S-7 完善项目文档与产品展示 — 主子系统: 不适用；主领域 Capability: 不适用（只改变仓库交付证据，不新增领域事实）；主要架构单元: 交付证据；消费 Capability: `CAP-PWS-01`、`CAP-COL-01`、`CAP-EXE-01`、`CAP-REV-01`（仅用于核对文档中的已交付事实）；票据: 未建立（[feature 状态](../features/007-project-documentation/progress.md)，目录无 `tickets.md`）；演示判据: 新用户能通过中英文 README 和中文 docs 准确理解产品定位、平台与安全边界、完整工作流和本地启动方式，并能查看不含测试数据、宿主路径或加载态的真实产品截图
- [x] S-8 改善协作驾驶舱 UI 设计 — 主子系统: 不适用；主领域 Capability: 不适用（只改变入站 UI Adapter，不新增领域事实）；主要架构单元: 入站 UI Adapter；消费 Capability: `CAP-PWS-01`、`CAP-MWK-01`、`CAP-COL-01`、`CAP-EXE-01`、`CAP-REV-01`；票据: 未建立（[feature 状态](../features/008-ui-design-refresh/progress.md)，目录无 `tickets.md`）；演示判据: owner 能在桌面与窄屏中更清晰地辨认导航、内容层级、状态、主次操作和当前上下文，同时保留 Cool AI 的温暖浅色身份且不复制 Clowder AI 品牌或资产
- [x] S-9 统一设置导航、检索与固定入口（CI-1.3） — 主子系统: 不适用；主领域 Capability: 不适用（只改变设置入站/UI Adapter 与本机非领域偏好，不新增领域事实）；主要架构单元: 入站 UI Adapter；消费 Capability: `CAP-IDC-01`、`CAP-PWS-01`；票据: 未建立（[feature 状态](../features/011-settings-navigation/progress.md)，目录无 `tickets.md`）；依赖: S-8；目标架构映射: 入站 UI Adapter + 真实 Capability 查询（非当时实现状态）；演示判据: owner 能通过可深链的统一设置入口检索分区、打开结果并固定常用入口，桌面与窄屏均可返回原上下文；约束: 工作区=不适用，verified-handle=不适用，sandbox=不适用，凭据=搜索结果不得显示密钥，审批=不适用，独立复核=交付必需，审计=设置写入可追溯；不复制 Clowder 品牌、源码或资产
- [x] S-10 Cool 自有亮暗主题（CI-1.4） — 主子系统: 不适用；主领域 Capability: 不适用（只改变设计 token/UI Adapter 与本机非领域偏好，不新增领域事实）；主要架构单元: 入站 UI Adapter；消费 Capability: `CAP-PWS-01`、`CAP-MWK-01`、`CAP-COL-01`、`CAP-EXE-01`、`CAP-REV-01`（仅呈现其产品面）；票据: 未建立（[feature 状态](../features/012-light-dark-theme/progress.md)，目录无 `tickets.md`）；依赖: S-8；目标架构映射: 入站 UI Adapter（非当时实现状态）；演示判据: owner 能切换亮/暗主题，刷新后偏好保持，关键页面的语义状态、焦点和 loading/empty/error 在两种主题下均清晰可见；约束: 工作区=不适用，verified-handle=不适用，sandbox=不适用，凭据=不适用，审批=不适用，独立复核=交付必需，审计=仅记录非敏感偏好；不复制 Clowder 品牌、源码、调色盘或资产
- [x] S-11 渐进式首次使用引导（CI-1.5） — 主子系统: 不适用；主领域 Capability: 不适用（只建立跨域引导 Workflow 与入站 UI Adapter，不新增第二套完成事实）；主要架构单元: Application Workflow + 入站 UI Adapter；消费 Capability: `CAP-IDC-01`、`CAP-PWS-01`、`CAP-MWK-01`、`CAP-COL-01`、`CAP-RUN-01`；票据: 未建立（[feature 状态](../features/013-progressive-onboarding/progress.md)，目录无 `tickets.md`）；依赖: S-9、S-10；目标架构映射: Application Workflow + 真实 Capability Interface（非当时实现状态）；演示判据: 新 owner 能在真实任务中完成 Provider、Agent、项目与首个目标配置，可跳过、失败重试并在刷新后恢复进度；约束: 工作区=仅引导绑定范围，verified-handle=绑定时必需，sandbox=首次执行仍隔离，凭据=只经现有密钥边界，审批=高风险步骤暂停，独立复核=交付必需，审计=引导动作可追溯；不复制 Clowder 品牌、源码、角色、文案或资产
- [x] S-12 项目内持久线程与上下文续接（CI-2.1） — 主子系统: Public Collaboration；主 Capability: `CAP-COL-02`；票据: [`features/014.../tickets.md`](../features/014-persistent-project-threads/tickets.md)；依赖: S-9；目标架构映射: `CAP-COL-01`、`CAP-COL-02`（非当时实现状态）；演示判据: owner 能在一个项目创建、切换并续接多个持久线程，重启后线程归属、成员策略和公开上下文保持一致；约束: 工作区=项目隔离，verified-handle=不适用，sandbox=不适用，凭据=不得进入消息，审批=不适用，独立复核=交付必需，审计=公开线程事件可追溯；不复制 Clowder 品牌、源码或资产
- [x] S-16 项目聊天图片附件（CI-2.10） — 主子系统: Public Collaboration；主 Capability: `CAP-COL-05`；票据: [`features/024.../tickets.md`](../features/024-image-attachments/tickets.md)；Ship: 2026-08-10（schema identity 12→13：message_attachments + attachment_events；magic-bytes 四格式校验、5 MiB/≤4 上限、项目作用域 verified 落盘、同 hash 复用、发送事务原子链接、tuple 投递白名单、reopen 附件边穷尽校验；smoke:threads 26 断言 / 14 axe 状态 0 违规）；演示判据: owner 能粘贴或选择受支持图片发送，看到类型/大小/数量校验、上传进度、失败恢复和重启后的项目内附件；约束: 工作区=附件限定项目存储，verified-handle=本地文件读取必需，sandbox=解析隔离（magic 嗅探，服务端不完整解码），凭据=不得嵌入或回显，审批=不适用，独立复核=交付必需，审计=上传来源与清理可追溯；不复制 Clowder 品牌、源码或资产
- [x] S-15 线程草稿恢复与输入历史（CI-2.12） — 主子系统: Public Collaboration；主 Capability: `CAP-COL-04`；票据: [`features/023.../tickets.md`](../features/023-thread-drafts/tickets.md)；Ship: 2026-08-10（schema identity 10→12：thread_drafts + input_history_entries/clear_events；敏感输入 fail-closed 不落盘；smoke:threads 20 断言 / 11 axe 状态 0 违规）；演示判据: owner 能按线程恢复文字、附件占位和回复引用草稿，搜索自己的输入历史并显式清除，重启后行为符合所选保留范围；约束: 工作区=项目隔离，verified-handle=不适用，sandbox=不适用，凭据=敏感输入不得保存，审批=不适用，独立复核=交付必需，审计=只记录清除/保留策略而不记录秘密；不复制 Clowder 品牌、源码或资产
- [x] S-14 回复引用与来源跳转（CI-2.11） — 主子系统: Public Collaboration；主 Capability: `CAP-COL-02`；票据: [`features/022.../tickets.md`](../features/022-reply-references/tickets.md)；Ship: 2026-08-10（schema identity 9→10，写时冻结回复快照，reopen 回复边全集校验，UI 引用片与精确跳转；smoke:threads 14 断言 / 7 axe 状态 0 违规）；演示判据: owner 能回复一条公开消息并从引用跳回精确来源，被删或不可用来源显示稳定占位而不伪造内容；约束: 工作区=项目隔离，verified-handle=不适用，sandbox=不适用，凭据=引用内容脱敏，审批=不适用，独立复核=交付必需，审计=来源 tuple 不可伪造；不复制 Clowder 品牌、源码或资产
- [x] S-13 结构化消息与就地决策（CI-2.3） — 主子系统: Public Collaboration；主 Capability: `CAP-COL-03`；票据: [`features/015.../tickets.md`](../features/015-structured-messages-inline-decisions/tickets.md)；Ship: 2026-08-10（017/018 review-remediation 子片先 done，按项目级 review 豁免收口）；演示判据: owner 能在消息流中查看带来源和版本的提案、diff、清单与交棒卡，并在原位完成允许的决定且重复提交不产生重复动作；约束: 工作区=文件卡仅限项目，verified-handle=文件来源必需，sandbox=变更预览来自隔离结果，凭据=内容脱敏，审批=高风险动作走正式审批，独立复核=交付必需，审计=operation/version/lease 可追溯；不复制 Clowder 品牌、源码或资产

## 当前在途

（无；048/S-41 浏览器通知已于 2026-08-15 ship。）

## 主题簇一：公开协作

主子系统为 Public Collaboration；搜索等派生能力可使用 Operations Projection，但不得成为 Thread/Message 命令事实源。

- [x] S-17 线程搜索与精确定位（CI-2.5） — 主子系统: Operations Projection；主 Capability: `CAP-OPS-02`；票据: [`features/031.../tickets.md`](../features/031-thread-search/tickets.md)；Ship: 2026-08-11（schema identity 16→17：thread_search_index；FTS5 勘察后选 LIKE contains 方案（A-169），消费协作 outbox、rebuild 完整性 fail-closed、snippet 命中窗口、游标分页、?thread=..&message=.. 精确 URL 定位、分层 Escape 修复；smoke:threads 42 断言 / 26 axe 状态 0 serious/critical；全量 264 文件/2367 用例 108.2s）；演示判据: owner 能按标题、内容和项目范围搜索线程并定位匹配消息，结果绝不跨项目泄漏；约束: 工作区=项目隔离，verified-handle=不适用，sandbox=不适用，凭据=索引排除秘密，审批=不适用，独立复核=交付必需，审计=查询不记录敏感正文；不复制 Clowder 品牌、源码或资产
  - 准入: 已交付前置: `CAP-COL-01`（已交付核心）；阻塞: S-23 的 `AUD-MVP` 先交付 `CAP-OPS-01` 与最薄 `CAP-OPS-02`，再由 `AUD-COL` 纵切交付 `CAP-COL-07` 并证明 Collaboration 事件可查询/导航；本片建立: `CAP-OPS-02` 的项目隔离线程索引与定位（规划中）。
- [x] S-18 线程标签与批量整理（CI-2.6） — 主子系统: Public Collaboration；主 Capability: `CAP-COL-02`；票据: [`features/032.../tickets.md`](../features/032-thread-tags-bulk-organize/tickets.md)；Ship: 2026-08-11（schema identity 17→18 纯增 thread_tags/thread_tag_edges/thread_tag_operations 三表；折叠唯一幂等创建、contains 搜索+用量计数、同事务清边删除、幂等分配、listThreads tagId 筛选 + 恒在 tags 投影、receipt 批量整理重放安全/原子/上限；UI 管理对话框+chips+筛选条+多选批量条；顺手修 useModalSurface 抽屉暂停/恢复双缺陷（A-205）；smoke:threads 50 断言 / 32 axe 态 0 serious/critical；全量 267 文件/2431 用例 118.2s）；演示判据: owner 能创建、搜索、分配和删除项目内标签并批量整理线程，删除语义与刷新后状态一致；约束: 工作区=项目隔离，verified-handle=不适用，sandbox=不适用，凭据=不适用，审批=批量破坏性动作确认，独立复核=交付必需，审计=批量写入版本化；不复制 Clowder 品牌、源码或资产
  - 准入: 已交付前置: `CAP-COL-02` 的 Thread Catalog 核心；阻塞: `CAP-OPS-02` 线程查询（规划中，由 S-17 建立）与 `CAP-GOV-02` 批量破坏性确认（规划中，由 S-24 建立）；本片建立: `CAP-COL-02` 的标签与版本化批量整理（规划中）。
- [x] S-19 线程收藏与排序（CI-2.7） — 主子系统: Public Collaboration；主 Capability: `CAP-COL-02`；票据: [`features/025.../tickets.md`](../features/025-thread-favorites/tickets.md)；Ship: 2026-08-10（schema identity 13→14：thread_favorites；幂等收藏命令、列表恒在投影 + favorites=true 稳定排序、星标 aria-pressed 乐观回滚、tablist 收藏视图、重启保持；smoke:threads 30 断言 / 18 axe 状态 0 违规；全量 244 文件/2089 用例 110.9s）；演示判据: owner 能收藏/取消收藏线程并在独立视图稳定排序，重启后收藏状态保持；约束: 工作区=项目隔离，verified-handle=不适用，sandbox=不适用，凭据=不适用，审批=不适用，独立复核=交付必需（review 豁免记录于 progress），审计=收藏写入可追溯（行内 created_at）；不复制 Clowder 品牌、源码或资产
  - 准入: 已交付前置: `CAP-COL-02` 的 Thread Catalog 核心；已交付架构单元: S-9 的本机非敏感偏好 Adapter（不是领域 Capability）；本片建立: `CAP-COL-02` 的收藏与稳定排序（规划中）。
- [x] S-20 线程回收站、恢复与永久删除（CI-2.8） — 主子系统: Public Collaboration；主 Capability: `CAP-COL-02`；票据: [`features/033.../tickets.md`](../features/033-thread-recycle-bin/tickets.md)；Ship: 2026-08-12（schema identity 18→19；软删/恢复/永久删除命令与路由；全缝已删排除；回收站查询与线程区 UI；smoke:threads 生命周期验收 + 全量/tsc/build 通过）；演示判据: owner 能软删除线程、从回收站恢复，并在强确认后永久删除；系统线程、当前导航和悬空引用均有明确处理；约束: 工作区=项目隔离，verified-handle=不适用，sandbox=不适用，凭据=删除日志脱敏，审批=永久删除强确认，独立复核=交付必需，审计=删除/恢复不可抵赖；不复制 Clowder 品牌、源码或资产
  - 准入: 已交付前置: `CAP-COL-02` 的 Thread Catalog 核心；已交付阻塞: `CAP-COL-02` 来源占位（S-14）与 `CAP-GOV-02` 永久删除确认（S-24）；本片建立: `CAP-COL-02` 的软删除、恢复、强确认永久删除和悬空引用规则（已交付）。
- [x] S-21 消息队列、重排与 Steer（CI-2.9） — 主子系统: Public Collaboration；主 Capability: `CAP-COL-04`；票据: [`features/034.../tickets.md`](../features/034-thread-message-queue-steer/tickets.md)；Ship: 2026-08-12（schema identity 19→20：`thread_message_queue`；入队/撤回/重排/受控 steer 命令与路由、运行窗口队头消费、线程区队列面板；smoke:threads 57 断言 / 39 axe 状态 0 违规；全量 276 文件/2512 用例）；演示判据: owner 能看到同线程等待原因，暂停/恢复、撤回、重排或调整未执行消息，处理中项目拒绝不安全 steer 且竞态结果可解释；约束: 工作区=项目隔离，verified-handle=不适用，sandbox=后续工具动作仍隔离，凭据=队列内容脱敏，审批=高风险 steer 不绕过审批，独立复核=交付必需，审计=operation/version/lease 全记录；不复制 Clowder 品牌、源码或资产
  - 准入: 已交付前置: `CAP-COL-01`、`CAP-EXE-01`、`CAP-GOV-02`、`CAP-COL-03`（均已交付）；阻塞: 无；本片建立: `CAP-COL-04` 的队列、重排、撤回和安全 steer（已交付）。

## 主题簇二：可信工作区与治理

主子系统为 Project & Workspace、Safe Execution 或 Governance；每片只选其中一个主 owner，其他能力通过公开 Interface 参与。

- [x] S-22 绑定工作区只读浏览与预览（CI-3.2） — 主子系统: Project & Workspace；主 Capability: `CAP-PWS-02`；票据: [`features/027.../tickets.md`](../features/027-workspace-readonly-browser/tickets.md)；Ship: 2026-08-10（verified-handle 全程浏览/预览、越界与链接逃逸 fail-closed、512KiB 截断、四格式图片 dataUrl、敏感文件 mask-first 零内容探测、canary 泄漏扫描 0；smoke:context 71 断言 / 4 axe 状态 0 违规；全量 250 文件/2167 用例 116.6s）；演示判据: owner 能浏览已绑定根目录并只读预览文本、代码和支持的资产，越界、二进制和大文件得到明确拒绝或降级（diff 预览移交 S-42，多根管理随多绑定义务另行立项）；约束: 工作区=严格限定绑定范围，verified-handle=所有路径访问必需，sandbox=预览解析隔离，凭据=敏感文件默认遮蔽，审批=不适用，独立复核=交付必需（review 豁免记录于 progress），审计=读取来源可追溯；不复制 Clowder 品牌、源码或资产
  - 准入: 已交付前置: `CAP-PWS-01`、`CAP-EXE-01`（已交付核心，含 Windows verified-handle 证据）；本片建立: `CAP-PWS-02` 的多绑定根只读浏览、预览与敏感文件降级（规划中）。
- [x] S-23 脱敏统一审计浏览器（CI-3.8） — 主子系统: 不适用；主领域 Capability: 不适用（保留的产品追踪别名/发布结果，跨多个 source owner，本身不得进入 implement）；主要架构单元: 发布结果；消费 Capability: `CAP-EXE-05`、`CAP-PWS-03`、`CAP-COL-07`、`CAP-MWK-05`、`CAP-GOV-03`、`CAP-RUN-07`、`CAP-OPS-01`、`CAP-OPS-02`；票据: 未创建；Ship: 2026-08-15（子片 AUD-MVP/PWS/COL/MWK/GOV/RUN/UI 全部 ship 后汇总勾选；AUD-UI 实现片号 S-58）；演示判据: owner 能按已交付来源域筛选公开事件并跳回精确来源，凭据、隐藏思维链和原始 provider 响应始终不可见；约束: 工作区=项目隔离，verified-handle=文件来源跳转必需，sandbox=执行事件只读，凭据=强制脱敏，审批=不适用，独立复核=交付必需，审计=来源、保留期和导出边界明确；不复制 Clowder 品牌、源码或资产
  - 准入: 已交付前置: `CAP-EXE-01`、`CAP-PWS-01`、`CAP-COL-01`、`CAP-MWK-01`（仅证明源事实存在，不证明公开 producer 已存在）；阻塞: 以下实现片尚未建立和 gate；本片建立: 不适用，S-23 只在子片全部 ship 后汇总发布验收。
  - 已交付子片: AUD-MVP、AUD-PWS/S-52、AUD-COL、AUD-MWK/S-51、AUD-GOV/S-53、AUD-RUN/S-57、AUD-UI/S-58 均已 ship。2026-08-15 AUD-UI [`042 progress`](../features/042-audit-browser-filters/progress.md) 交付统一审计按域筛选（全部/执行/协作/任务/项目/治理/运行时），客户端过滤已加载页，不改 API。S-23 作为发布别名汇总勾选。时间轴仍由 S-39 建立。
  - 纵切 MVP `AUD-MVP`：分类为领域纵切；actor 是 owner；独立用户结果是“owner 能在最薄只读展示中查询脱敏 Safe Execution 事件并跳到精确 execution 来源”。主子系统: Operations Projection；主 Capability: `CAP-OPS-02`；协作子系统/Capability: Safe Execution / `CAP-EXE-05`，producer 随既有 Safe Execution 命令事务原子提交 event envelope；同片建立其基础依赖 `CAP-OPS-01`，由它独立幂等消费已提交事件并维护 checkpoint/rebuild/freshness；入站 Adapter 直接通过 Operations Projection Query 查询 `CAP-OPS-02`，展示 freshness 与精确来源，只读路径不发起命令、不驱动消费。该片只涉及两个子系统，未达到跨 3 子系统拆分阈值，且全部工作服务同一个查询/导航用户结果；禁止先 ship 不可观察 producer；票据目标: 3–8。
  - source-owner 扩展纵切：Project & Workspace、Public Collaboration、Mission & Work、Governance、Runtime 分别建立独立 `AUD-PWS`、`AUD-COL`、`AUD-MWK`、`AUD-GOV`、`AUD-RUN` 草案。每片 actor 均为 owner，主要架构单元是对应 source owner 的领域 Capability，分别建立 `CAP-PWS-03`、`CAP-COL-07`、`CAP-MWK-05`、`CAP-GOV-03`、`CAP-RUN-07`；每片必须复用已 ship 的 `CAP-OPS-01/02`，以“owner 能查询该领域脱敏事件并精确导航”为独立可演示结果，各 3–8 票，禁止交付不可观察 producer 或合并多个 source owner。
  - 最终组合纵切 `AUD-UI`：actor 是 owner；独立用户结果是“owner 能在统一审计浏览器筛选所有已交付来源并精确导航”。主领域 Capability: 不适用（不新增领域写事实）；主要架构单元: 入站 UI Adapter；消费 Capability: 已 ship 的 `CAP-EXE-05`、各 source event Capability、`CAP-OPS-01/02`；只做查询组合、状态与导航，各 producer 缺失时不进入该发布片；票据目标: 3–8。
  - 编号规则: `AUD-*` 是拆分草案标识；进入 `to-spec/implement` 前为每个实现片分配新的未占用 `S-*`，S-23 保留为发布追踪别名，不复用为多 owner 实现片。
- [x] S-24 跨域统一审批中心（CI-4.3） — 主子系统: Governance；主 Capability: `CAP-GOV-02`；票据: [`features/029.../tickets.md`](../features/029-unified-approval-center/tickets.md)；Ship: 2026-08-10（零 schema/零新写路由：listPendingApprovals 跨域聚合+GET approvals/pending；审批 tab 分派既有裁决路由；续接端到端 7 场景零断裂；smoke:execution 69 断言 / 5 axe 状态 0 违规，顺手修复执行时间线 role=log 列表语义既有缺陷；全量绿、tsc/build 通过）；演示判据: owner 能在单一入口查看执行、内联决策等高风险请求的来源、影响与失效状态，批准或拒绝后原流程准确续接且过期请求失败关闭（"交棒"专门审批后续切片接入本中心）；约束: 工作区=显示精确目标，verified-handle=文件动作必需，sandbox=执行审批不解除隔离，凭据=请求内容脱敏，审批=本片核心且不可旁路，独立复核=交付必需（review 豁免记录于 progress），审计=裁决不可变；不复制 Clowder 品牌、源码或资产
  - 准入: 已交付前置: `CAP-EXE-01`、`CAP-COL-01`；`CAP-GOV-01` 只提供 Safe Execution scoped 现状证据，不是本片的通用 Governance 前置；阻塞: `CAP-OPS-01`/`CAP-OPS-02` 须由 S-23 拆分片建立；待验证: `CAP-COL-03` 高风险卡片来源（S-13 未 ship）；本片建立: `CAP-GOV-02` 的跨域 Approval 查询、裁决与来源 Workflow 续接（规划中）。
- [ ] S-42 受控工作区编辑与 Git 合入（CI-3.5）【高风险安全切片】 — 主子系统: Safe Execution；主 Capability: `CAP-EXE-02`；票据: 未创建；演示判据: owner 能从只读预览发起编辑，在 sandbox 查看 diff、处理 stale/冲突并经审批安全合入 canonical workspace，越界或不可逆 Git 动作失败关闭；约束: 工作区=仅绑定范围，verified-handle=所有路径必需，sandbox=强制，凭据=禁止读取/写入秘密，审批=合入与破坏性 Git 必需，独立复核=结果合入前必需，审计=StagedChange/MergeJournal 完整；不复制 Clowder 品牌、源码或资产
  - 准入: 已交付前置: `CAP-PWS-01`、`CAP-EXE-01`、`CAP-REV-01`（已交付）与 `CAP-GOV-01`（仅同一冻结 Safe Execution/staged-merge 路径部分可用）；阻塞: `CAP-PWS-02`（S-22）、`CAP-OPS-01`/`CAP-OPS-02`（S-23 拆分片）规划中；本片建立: `CAP-EXE-02` 的受控编辑、Git stale/conflict 和批准后合入（规划中）。
- [ ] S-43 策略内 Web 终端与浏览器预览（CI-3.6）【高风险安全切片】 — 主子系统: Safe Execution；主 Capability: `CAP-EXE-03`；票据: 未创建；演示判据: owner 能在任务内运行精确许可命令并查看本地预览，命令、网络、端口和超时政策可见；越界、未许可命令或外部发布被阻止并要求审批；约束: 工作区=仅绑定范围，verified-handle=工作目录必需，sandbox=强制，凭据=环境秘密隔离，审批=网络/破坏性/外部动作必需，独立复核=执行结果必需，审计=命令、输出摘要和退出码可追溯；不复制 Clowder 品牌、源码或资产
  - 准入: 已交付前置: `CAP-EXE-01`、`CAP-PWS-01`（已交付）与 `CAP-GOV-01`（仅同一冻结 Safe Execution 命令路径部分可用）；阻塞: `CAP-PWS-02`（S-22）、`CAP-OPS-01`/`CAP-OPS-02`（S-23 拆分片）规划中；本片建立: `CAP-EXE-03` 的策略内进程、端口、网络和预览生命周期（规划中）。

## 主题簇三：Mission 治理

主子系统为 Mission & Work；图、SOP 与租约控制面必须读取同一任务事实，不建立第二任务状态机。

- [x] S-25 Mission 依赖与阻塞全景（CI-4.4） — 主子系统: Mission & Work；主 Capability: `CAP-MWK-02`；票据: [`features/026.../tickets.md`](../features/026-mission-dependency-insight/tickets.md)；Ship: 2026-08-10（零 schema 变更纯派生读模型：getMissionDependencyInsight + GET dependencies 路由；Tarjan 循环检测、悬空依赖 missing 分类、阻塞原因派生；MissionBoard 只读依赖全景区 + 焦点缝导航；smoke:context 35 断言 / 4 axe 状态 0 违规；全量 246 文件/2111 用例 117.1s）；演示判据: owner 能查看复杂 Mission 的只读依赖图、循环与阻塞原因，并从节点定位现有任务而不产生第二套任务事实源；约束: 工作区=项目隔离，verified-handle=不适用，sandbox=不适用，凭据=不适用，审批=不适用，独立复核=交付必需（review 豁免记录于 progress），审计=图数据来源可追溯；不复制 Clowder 品牌、源码或资产
  - 准入: 已交付前置: `CAP-MWK-01`（已交付核心，mission service/tests）；本片建立: `CAP-MWK-02` 的只读依赖、循环与阻塞查询（规划中）。
- [x] S-26 可审计 SOP 与流程状态（CI-4.6） — 主子系统: Mission & Work；主 Capability: `CAP-MWK-03`；票据: [`features/043-sop-state-projection/tickets.md`](../features/043-sop-state-projection/tickets.md)；Ship: 2026-08-15（零 schema：发现 `features/*/progress.md`、声明阶段对照 work item、陈旧提示、GET `/sop-state`、看板「流程状态」；`smoke:context` SOP 8 断言；hf-code-review PASS）；演示判据: owner 能看到仓库真实流程/SOP 的当前状态、来源和陈旧提示，刷新后与事实源一致且不建立第二状态机；约束: 工作区=只读绑定项目事实，verified-handle=读取流程文件必需，sandbox=不执行流程命令，凭据=不显示环境秘密，审批=不适用，独立复核=交付必需（hf-code-review 记录于 reviews），审计=状态来源和时间可追溯；不复制 Clowder 品牌、源码或资产
  - 准入: 已交付前置: `CAP-MWK-01`、`CAP-PWS-02`、`CAP-OPS-01`、`CAP-MWK-02`；本片建立: `CAP-MWK-03` 的来源化 SOP 状态与 freshness（已交付）。
- [x] S-27 任务租约与派发控制面（CI-4.7） — 主子系统: Mission & Work；主 Capability: `CAP-MWK-04`；票据: [`features/044-work-item-dispatch-lease/tickets.md`](../features/044-work-item-dispatch-lease/tickets.md)；Ship: 2026-08-15（schema 24→25；claim/heartbeat/release/reclaim；看板租约；`smoke:context` 5 断言；hf-code-review PASS）；演示判据: owner 能查看任务自领、心跳、释放、过期与回收，重复领取和并发派发按 operation/version/lease 确定性失败；约束: 工作区=项目隔离，verified-handle=不适用，sandbox=执行仍按任务隔离，凭据=不适用，审批=过期回收不走审批（A-310），独立复核=交付必需，审计=复用既有 status 变更；不复制 Clowder 品牌、源码或资产
  - 准入: 已交付前置: `CAP-MWK-01`、`CAP-EXE-01`、`CAP-MWK-02`、`CAP-GOV-02`；本片建立: `CAP-MWK-04`（已交付）。

## 主题簇四：知识生命周期

主子系统为 Knowledge & Provenance；检索与图形视图是可重建投影，来源、版本和 supersedes 链仍由知识 owner 维护。

- [x] S-28 项目知识动态与记忆检索（CI-5.1） — 主子系统: Knowledge & Provenance；主 Capability: `CAP-KNW-02`；票据: [`features/045-knowledge-search/tickets.md`](../features/045-knowledge-search/tickets.md)；Ship: 2026-08-15（零 schema：`searchMemories` + GET `/memories/search` + 共享记忆检索 UI；`smoke:context` 3 断言；hf-code-review 豁免）；演示判据: owner 能按正文、类型、来源和版本在当前项目搜索记忆，并从知识动态定位精确证据；搜索结果不跨项目且不含被替代事实的误导性展示；约束: 工作区=项目隔离，verified-handle=文件证据跳转复用已有 href（A-318），sandbox=不适用，凭据=不索引/不落查询日志，审批=不适用，独立复核=交付必需（轻量级豁免记录于 progress），审计=结果带来源身份；不复制 Clowder 品牌、源码或资产
  - 准入: 已交付前置: `CAP-KNW-01`、`CAP-PWS-02`、`CAP-OPS-01`（A-318）；本片建立: `CAP-KNW-02` 的项目隔离记忆检索和证据定位（已交付）；专用索引生命周期见 S-29。
- [ ] S-29 记忆索引状态与健康诊断（CI-5.2） — 主子系统: Operations Projection；主 Capability: `CAP-OPS-03`；票据: 未创建；演示判据: owner 能看到项目索引进度、失败、召回健康与安全修复动作，诊断降级时仍可访问原始可引用记忆；约束: 工作区=项目隔离，verified-handle=重建文件索引时必需，sandbox=修复任务隔离，凭据=诊断脱敏，审批=破坏性重建需确认，独立复核=交付必需，审计=修复动作可追溯；不复制 Clowder 品牌、源码或资产
  - 准入: 已交付前置: `CAP-KNW-01`、`CAP-KNW-02` 检索（S-28）、`CAP-OPS-01`、`CAP-GOV-02`；本片建立: `CAP-OPS-03` 的索引 checkpoint、健康、降级和修复投影（规划中）。
- [ ] S-30 项目知识目录与集合（CI-5.4） — 主子系统: Knowledge & Provenance；主 Capability: `CAP-KNW-03`；票据: 未创建；演示判据: owner 能在项目内创建集合、移动/移除记忆并查看集合目录，删除集合不会静默删除来源事实且不能跨项目聚合；约束: 工作区=项目隔离，verified-handle=文件来源跳转必需，sandbox=不适用，凭据=集合不得收录秘密，审批=破坏性删除确认，独立复核=交付必需，审计=集合变更版本化；不复制 Clowder 品牌、源码或资产
  - 准入: 已交付前置: `CAP-KNW-01`、`CAP-KNW-02` 检索（S-28）、`CAP-GOV-02`；本片建立: `CAP-KNW-03` 的集合、移动/移除和来源保留（规划中）。
- [ ] S-31 来源可追溯知识图谱（CI-5.5） — 主子系统: Knowledge & Provenance；主 Capability: `CAP-KNW-03`；票据: 未创建；演示判据: owner 能从项目知识图谱查看有证据的关系、定位来源并使用可访问的列表替代视图，缺少来源的推断不会显示为事实；约束: 工作区=项目隔离，verified-handle=文件证据跳转必需，sandbox=不适用，凭据=关系数据脱敏，审批=不适用，独立复核=交付必需，审计=边与来源不可分离；不复制 Clowder 品牌、源码或资产
  - 准入: 已交付前置: `CAP-KNW-01`（已交付）；阻塞: `CAP-KNW-02`（S-28）与 `CAP-KNW-03` 集合部分（S-30）规划中；本片建立: `CAP-KNW-03` 的证据边、图查询和可访问列表替代（规划中）。
- [ ] S-32 Agent 署名的记忆提炼与发布（CI-5.6） — 主子系统: Knowledge & Provenance；主 Capability: `CAP-KNW-04`；票据: 未创建；演示判据: 真实 Agent 能基于精确来源提出提炼/反思结果，owner 能看到署名、差异和 supersedes 链，未经来源校验的内容不能发布为共享记忆；约束: 工作区=项目隔离，verified-handle=文件证据必需，sandbox=提炼工具隔离，凭据=输入输出脱敏，审批=发布按现有治理确认，独立复核=发布前必需，审计=模型、来源和版本可追溯；不复制 Clowder 品牌、源码或资产
  - 准入: 已交付前置: `CAP-KNW-01`、`CAP-RUN-01`、`CAP-REV-01`（已交付）；阻塞: `CAP-KNW-02` 与索引健康（S-28、S-29），以及 `CAP-GOV-02` 的非执行域发布治理（S-24）规划中；本片建立: `CAP-KNW-04` 的 Agent 署名候选、差异、复核发布和 supersedes（规划中）。

## 主题簇五：Agent / 运维洞察

主子系统为 Operations Projection 或 Identity & Capability；洞察不得反向改写 Agent 角色、权限或业务终态。

- [x] S-33 可解释 Agent 能力画像与路由建议（CI-6.3） — 主子系统: Identity & Capability；主 Capability: `CAP-IDC-03`；票据: [`features/046-capability-insight/tickets.md`](../features/046-capability-insight/tickets.md)；Ship: 2026-08-15（零 schema：GET `/capability-insight` + 看板画像/建议；接受只预填负责人；`smoke:context` 4 断言；hf-code-review 豁免）；演示判据: owner 能查看基于实际配置的能力画像与路由理由，接受或忽略建议；推断绝不自动改写 Agent 角色、权限或 owner 配置；约束: 工作区=项目上下文隔离，verified-handle=不适用，sandbox=工具建议不授予权限，凭据=画像不含密钥，审批=权限变化仍需确认，独立复核=交付必需（轻量级豁免记录于 progress），审计=建议依据为配置证据标签；不复制 Clowder 品牌、源码或资产
  - 准入: 已交付前置: `CAP-IDC-01`、`CAP-RUN-01`、`CAP-REV-01`、`CAP-OPS-01`（A-322）；本片建立: `CAP-IDC-03` 的可解释能力画像与只读路由建议（已交付）。
- [ ] S-34 可审计系统规则与提示注入检查（CI-6.5） — 主子系统: Identity & Capability；主 Capability: `CAP-IDC-03`；票据: 未创建；演示判据: owner 能查看规则生效范围、冲突和注入风险预览，项目规则不能越权覆盖安全边界且拒绝原因清晰；约束: 工作区=规则按项目隔离，verified-handle=读取规则文件必需，sandbox=规则不扩权，凭据=检查结果脱敏，审批=全局规则变更需确认，独立复核=交付必需，审计=规则版本与来源可追溯；不复制 Clowder 品牌、源码或资产
  - 准入: 已交付前置: `CAP-IDC-01`、`CAP-PWS-01`（已交付）；阻塞: `CAP-PWS-02`（S-22）、`CAP-OPS-01`（S-23 拆分片）与 `CAP-GOV-02` 的全局规则变更治理（S-24）规划中；本片建立: `CAP-IDC-03` 的规则作用域、冲突和注入风险检查（规划中）。
- [ ] S-35 服务健康与可观察性中心（CI-6.6） — 主子系统: Operations Projection；主 Capability: `CAP-OPS-03`；票据: 未创建；演示判据: owner 能在统一视图看到应用、Provider、索引和执行服务的真实健康、失败原因与恢复入口，未知状态不伪造成成功；约束: 工作区=项目指标隔离，verified-handle=工作区检查时必需，sandbox=执行指标不开放控制，凭据=日志脱敏，审批=恢复动作按风险确认，独立复核=交付必需，审计=指标口径和来源明确；不复制 Clowder 品牌、源码或资产
  - 准入: 已交付前置: `CAP-RUN-01`、`CAP-EXE-01`、`CAP-KNW-01`（已交付）；阻塞: `CAP-OPS-01`（S-23 的 `AUD-MVP` 纵切）、索引健康基础（S-29）规划中；本片建立: `CAP-OPS-03` 的应用、Provider、索引和执行健康投影（规划中）。
- [ ] S-36 用量与配额看板（CI-6.11） — 主子系统: Operations Projection；主 Capability: `CAP-OPS-03`；票据: 未创建；演示判据: owner 能按项目、Run 和 Provider 查看基础用量、预算与轮次边界，估算值显式标注且不会被误解为账单；约束: 工作区=项目隔离，verified-handle=不适用，sandbox=不适用，凭据=账户信息脱敏，审批=预算变更需确认，独立复核=交付必需，审计=计量来源可追溯；不复制 Clowder 品牌、源码或资产
  - 准入: 已交付前置: `CAP-COL-01`、`CAP-RUN-01`（已交付可见用量与 Provider 调用事实）；阻塞: `CAP-OPS-01`（S-23 的 `AUD-MVP` 纵切）与健康投影（S-35）规划中；本片建立: `CAP-OPS-03` 的项目/Run/Provider 计量口径和估算标识（规划中）。
- [ ] S-37 平等协作贡献视图（CI-6.13） — 主子系统: Operations Projection；主 Capability: `CAP-OPS-03`；票据: 未创建；演示判据: owner 能按角色职责查看带上下文的任务结果、复核质量和贡献证据，而非无上下文活跃度竞赛；指标不改变平等角色、派发权限或独立复核门槛；约束: 工作区=项目隔离，verified-handle=不适用，sandbox=不适用，凭据=不适用，审批=不适用，独立复核=指标定义必需，审计=指标来源可追溯；不复制 Clowder 品牌、源码或资产
  - 准入: 已交付前置: `CAP-IDC-01`、`CAP-REV-01`、`CAP-MWK-01`、`CAP-IDC-03` 画像（S-33）；阻塞: 用量投影（S-36）规划中；本片建立: `CAP-OPS-03` 的带上下文贡献和复核质量证据（规划中）。
- [ ] S-44 领域化运维命令与救援（CI-6.12）【高风险安全切片】 — 主子系统: Safe Execution；主 Capability: `CAP-EXE-04`；票据: 未创建；演示判据: owner 能从明确故障选择精确许可的恢复动作、预览影响并执行/撤销可恢复步骤，任意命令输入和未知救援路径被拒绝；约束: 工作区=按故障目标限制，verified-handle=文件动作必需，sandbox=强制，凭据=不回显且最小注入，审批=高权限动作必需，独立复核=恢复结果必需，审计=动作前后状态完整；不复制 Clowder 品牌、源码或资产
  - 准入: 已交付前置: `CAP-EXE-01`、`CAP-REV-01`（已交付）与 `CAP-GOV-01`（仅同一冻结 Safe Execution 恢复动作路径部分可用）；阻塞: `CAP-OPS-03` 健康（S-35）与 `CAP-EXE-03` 进程控制（S-43）规划中；本片建立: `CAP-EXE-04` 的 allowlist 救援、影响预览和可恢复撤销（规划中）。

## 主题簇六：证据导出与回放

主子系统为 Operations Projection 或 Review & Delivery；导出和回放只读取已公开、脱敏、冻结来源，不重放命令。

- [ ] S-38 脱敏对话与项目数据导出（CI-8.1） — 主子系统: Operations Projection；主 Capability: `CAP-OPS-04`；票据: 未创建；演示判据: owner 能选择项目/线程范围导出用户可见消息、事件与元数据，导出包有版本和范围说明且不含凭据、隐藏思维链或原始 provider 响应；约束: 工作区=仅当前项目数据，verified-handle=导出目标选择必需，sandbox=打包隔离，凭据=强制脱敏，审批=大范围导出确认，独立复核=交付必需，审计=导出者、范围和 hash 可追溯；不复制 Clowder 品牌、源码或资产
  - 准入: 已交付前置: `CAP-COL-01`、`CAP-KNW-01`、`CAP-REV-01`（已交付）；阻塞: `CAP-OPS-01`（S-23 拆分片）、知识检索（S-28）与 `CAP-GOV-02` 的非执行域大范围导出治理（S-24）规划中；本片建立: `CAP-OPS-04` 的范围化脱敏导出、包版本和 hash（规划中）。
- [x] S-39 跨任务运行轨迹时间轴（CI-8.2） — 主子系统: Operations Projection；主 Capability: `CAP-OPS-02`；票据: [`features/047-run-timeline/tickets.md`](../features/047-run-timeline/tickets.md)；Ship: 2026-08-15（零 schema：GET `/timeline` 正序去重、来源缺失占位、审计面板时间轴视图；`smoke:execution` 160 断言；hf-code-review 豁免）；演示判据: owner 能按项目和 Mission 检索公开运行轨迹、去重排序并跳回线程/任务/证据，缺失来源明确显示而不补造事件；约束: 工作区=项目隔离，verified-handle=文件事件跳转复用已有 href，sandbox=只读，凭据=轨迹脱敏，审批=不适用，独立复核=交付必需（轻量级豁免记录于 progress），审计=事件来源不可变；不复制 Clowder 品牌、源码或资产
  - 准入: 已交付前置: `CAP-COL-01`、`CAP-MWK-01`、`CAP-EXE-01`、`CAP-OPS-01`、`CAP-MWK-02`、各 source event Capability（A-332）；本片建立: `CAP-OPS-02` 的跨任务去重时间轴和 Frozen Source 导航（已交付）。
- [ ] S-40 本地只读交付回放（CI-8.4） — 主子系统: Operations Projection；主 Capability: `CAP-OPS-04`；票据: 未创建；演示判据: owner 能打开某次已交付运行的不可变本地回放，按时间查看公开消息、动作、验证和结果并跳回来源，刷新后顺序一致；约束: 工作区=项目隔离，verified-handle=文件证据跳转必需，sandbox=只读且不重放动作，凭据=回放脱敏，审批=不适用，独立复核=交付必需，审计=回放版本与来源固定；不复制 Clowder 品牌、源码、故事包装或资产
  - 准入: 已交付前置: `CAP-REV-01`、`CAP-COL-01`、`CAP-EXE-01`、`CAP-OPS-02` 时间轴（S-39）；本片建立: `CAP-OPS-04` 的冻结交付只读回放和稳定顺序（规划中）。

## 主题簇七：通知 / 多模态

主子系统为 Runtime 或 Public Collaboration；通知和媒体 Adapter 不获得业务写权，也不替代 owner Approval。

- [x] S-41 最小权限浏览器通知与 PWA（CI-7.1） — 主子系统: Runtime；主 Capability: `CAP-RUN-05`；票据: [`features/048-browser-notifications/tickets.md`](../features/048-browser-notifications/tickets.md)；Ship: 2026-08-15（本机 Notification、无 Web Push；`smoke:settings` 18 steps；hf-code-review PASS）；演示判据: owner 能按事件类型授权浏览器通知、收到去重提醒并从通知返回对应审批/任务，拒绝权限或离线时有清晰降级且不会无人值守执行动作；约束: 工作区=通知不泄漏项目正文，verified-handle=不适用，sandbox=不适用，凭据=无订阅密钥（A-334），审批=通知不能代替审批，独立复核=交付必需，审计=不写 outbox（A-339）；不复制 Clowder 品牌、源码或资产
  - 准入: 已交付前置: `CAP-COL-01`、`CAP-OPS-01`、`CAP-GOV-02`；本片建立: `CAP-RUN-05` 的最小内容通知 Adapter、去重、权限拒绝和离线降级（已交付）。
- [ ] S-50 隐私安全的语音输入、输出与伴随模式（CI-6.7）【高风险安全切片】 — 主子系统: Runtime；主 Capability: `CAP-RUN-06`；票据: 未创建；演示判据: owner 能显式启用语音输入/输出、查看录音与第三方处理边界、停止播放并删除本地音频；默认关闭、权限拒绝和服务失败均安静降级；约束: 工作区=语音只进入当前项目线程，verified-handle=本地音频文件必需，sandbox=音频解析隔离，凭据=TTS/STT 密钥受保护，审批=首次上传/第三方处理必需，独立复核=隐私与可访问性必需，审计=同意、上传和删除结果可追溯；不复制 Clowder 品牌、源码、声音或资产
  - 准入: 已交付前置: `CAP-RUN-01`、`CAP-COL-01`、`CAP-EXE-01`、`CAP-RUN-05`（S-41）；阻塞: `CAP-GOV-02` 的第三方处理同意、规则检查（S-34）、健康投影（S-35）规划中；本片建立: `CAP-RUN-06` 的受控音频 Adapter、显式同意、删除和安静降级（规划中）。

## 主题簇八：外部运行时与扩展生态

主子系统为 Runtime；每个 Adapter 或供应链能力必须独立切片，并服从受控端口、最小权限、隔离、审批、撤销和审计。

- [ ] S-45 受控原生 Agent CLI / ACP Provider（CI-6.8）【高风险安全切片】 — 主子系统: Runtime；主 Capability: `CAP-RUN-02`；票据: 未创建；演示判据: owner 能配置并验证一个明确支持的 CLI/ACP adapter、发起受控会话并看到版本/能力/失败恢复；每增加一种 adapter 必须另起独立 frame→ship 切片和单独提交，不在本片捆绑复制；约束: 工作区=按项目限制，verified-handle=可执行文件与工作目录必需，sandbox=子进程强制隔离，凭据=认证文件最小暴露，审批=外部进程与高风险工具必需，独立复核=adapter 交付必需，审计=版本、调用和退出完整；不复制 Clowder 品牌、源码或资产
  - 准入: 已交付前置: `CAP-IDC-01`、`CAP-RUN-01`、`CAP-EXE-01`（已交付）；阻塞: `CAP-GOV-02` 的外部 Runtime 正式 Approval（S-24）、能力画像（S-33）、健康投影（S-35）、`CAP-EXE-03`（S-43）规划中；本片建立: `CAP-RUN-02` 的首个 CLI/ACP Adapter、能力协商和受控会话入口（规划中）。
- [ ] S-46 外部运行会话管理（CI-3.4）【高风险安全切片】 — 主子系统: Runtime；主 Capability: `CAP-RUN-02`；票据: 未创建；演示判据: owner 能查看、恢复和终止受控 CLI/ACP 会话，跨重启状态与真实进程一致，失联、过期和凭据失效均明确失败而不伪造在线；约束: 工作区=会话绑定项目，verified-handle=进程/工作目录必需，sandbox=强制，凭据=会话令牌不回显，审批=终止或重连高风险会话必需，独立复核=会话生命周期必需，审计=创建/恢复/终止可追溯；不复制 Clowder 品牌、源码或资产
  - 准入: 已交付前置: `CAP-EXE-01`（已交付）；阻塞: `CAP-GOV-02` 的外部 Runtime 终止/重连 Approval（S-24）与 `CAP-RUN-02` 的 Adapter/会话入口（S-45）规划中；本片建立: `CAP-RUN-02` 的持久会话 acquire/checkpoint/finalize、恢复和终止（规划中）。
- [ ] S-47 受控 MCP 服务与工具管理（CI-6.4）【高风险安全切片】 — 主子系统: Runtime；主 Capability: `CAP-RUN-03`；票据: 未创建；演示判据: owner 能在全局或项目作用域配置受支持 transport、验证服务、查看工具权限并卸载；未授权工具、环境变量、工作目录或漂移状态被阻止；约束: 工作区=项目 MCP 限定范围，verified-handle=command transport 必需，sandbox=服务/工具强制隔离，凭据=环境变量与令牌受保护，审批=安装及高风险工具必需，独立复核=服务接入必需，审计=配置、调用和漂移完整；不复制 Clowder 品牌、源码或资产
  - 准入: 已交付前置: `CAP-IDC-01`、`CAP-PWS-01`、`CAP-EXE-01`（已交付）；阻塞: `CAP-GOV-02` 的 MCP 安装/工具 Approval（S-24）、规则检查（S-34）、健康投影（S-35）、`CAP-EXE-03`（S-43）规划中；本片建立: `CAP-RUN-03` 的 MCP transport、tool 权限、漂移检测与卸载（规划中；MCP 能力不是前置）。
- [ ] S-48 已安装插件生命周期管理（CI-6.9）【高风险安全切片】 — 主子系统: Runtime；主 Capability: `CAP-RUN-04`；票据: 未创建；演示判据: owner 能查看已安装插件的来源、权限、状态和配置，并安全启停/卸载；未知来源、扩权、执行失败或回滚失败均关闭而不影响核心流程；约束: 工作区=权限按项目限制，verified-handle=插件文件必需，sandbox=插件执行强制隔离，凭据=按插件最小授权，审批=启用/扩权/卸载必需，独立复核=供应链与执行必需，审计=来源、版本和生命周期完整；不复制 Clowder 品牌、源码或资产
  - 准入: 已交付前置: `CAP-IDC-01`、`CAP-EXE-01`（已交付）；阻塞: `CAP-GOV-02` 的扩展启用/扩权/卸载 Approval（S-24）、规则检查（S-34）、健康投影（S-35）、`CAP-RUN-03`（S-47）规划中；本片建立: `CAP-RUN-04` 的进程外扩展来源、权限、启停、撤销和卸载（规划中）。
- [ ] S-49 能力市场搜索与安全安装计划（CI-6.10）【高风险安全切片】 — 主子系统: Runtime；主 Capability: `CAP-RUN-04`；票据: 未创建；演示判据: owner 能搜索能力、查看可信来源/签名/兼容性/权限与安装计划，在审批后安装并可回滚；未签名、来源不明或不兼容能力不能执行；约束: 工作区=安装作用域明确，verified-handle=落盘必需，sandbox=安装预检与运行强制隔离，凭据=市场和能力凭据分离，审批=安装/更新/扩权必需，独立复核=供应链必需，审计=来源、签名、计划和回滚完整；不复制 Clowder 品牌、源码或资产
  - 准入: 已交付前置: `CAP-EXE-01`（已交付）；阻塞: `CAP-GOV-02` 的安装/更新/扩权 Approval（S-24）、`CAP-RUN-03`（S-47）与 `CAP-RUN-04` 生命周期（S-48）规划中；本片建立: `CAP-RUN-04` 的市场搜索、签名/兼容性检查、安装计划和回滚（规划中）。

## 主题簇九：UI 与设计系统

主子系统: 不适用（只改变设计令牌与入站 UI Adapter，不新增领域事实）；主要架构单元为设计令牌单一事实源 + 入站 UI Adapter；消费已交付 UI 呈现面。

- [x] S-51 整体 UI 改版：DESIGN.md 设计基座与应用壳层 — 主子系统: 不适用；主领域 Capability: 不适用（只建立设计令牌单一事实源并改变入站 UI Adapter，不新增领域事实）；主要架构单元: DESIGN.md（设计令牌/组件规范单一事实源）+ 入站 UI Adapter；消费 Capability: 已交付的 `CAP-PWS-01`、`CAP-MWK-01`、`CAP-COL-01/02/03/04/05`、`CAP-EXE-01`、`CAP-REV-01`、`CAP-GOV-02` 等 UI 呈现面；票据: [`features/035-design-md-ui-redesign/tickets.md`](../features/035-design-md-ui-redesign/tickets.md)；Ship: 2026-08-12，DESIGN.md 落为产品级设计契约、tokens.css 全映射 + 扩展 token、明暗 preview 页面与应用壳层收敛、视觉回归 29/29、typecheck/build 通过；演示判据: owner 能打开 DESIGN.md 配套的 preview/preview-dark 页面看到统一设计语言，应用壳层与公共组件与 token 单一事实源一致，亮暗主题、键盘操作与 axe 关键路径不回归；约束: 工作区=不适用，verified-handle=不适用，sandbox=不适用，凭据=不适用，审批=不适用，独立复核=交付必需（项目级 review 豁免按 AGENTS.md 记录于 progress），审计=不适用；不复制 Clowder 品牌、源码或资产
  - 排期: 2026-08-12 用户指示追加到既有在途切片之后（A-242），同日又指示立即自动完成（A-244 覆盖排队语义）；注：S-51 片号与同日并行交付的 AUD-MWK 审计实现片双占（双 035 特性号同理），见 A-256。
  - 准入: 已交付前置: 既有在途切片完成后解锁（共享 `app/tokens.css`/组件面，避免并行写冲突）；本片建立: DESIGN.md、tokens.css 对齐、preview.html 与应用壳层/公共组件收敛（规划中；grill 收尾后进入 to-spec）。

- [x] S-54 暖陶工作台驾驶舱（左对话 / 中群聊 / 右看板） — 主子系统: 不适用；主领域 Capability: 不适用（只改变设计令牌与入站 UI Adapter，不新增领域事实）；主要架构单元: 入站 UI Adapter；消费 Capability: 已交付的 `CAP-PWS-01`、`CAP-MWK-01`、`CAP-COL-01/02/03/04/05`、`CAP-EXE-01`、`CAP-GOV-02`、`CAP-KNW-01` 等 UI 呈现面；票据: [`features/038-warm-terracotta-cockpit/tickets.md`](../features/038-warm-terracotta-cockpit/tickets.md)；Ship: 2026-08-14，case 暖陶色板替换 Apple 蓝、`DESIGN.md` 重写并归档 Apple 原文、桌面栅格 `56/236/1fr/304`、三栏 chrome 对齐 case、preview 暖陶目录、`npm test` 2577 / build 绿、smoke:context 与 cockpit smoke 绿、smoke:threads 57 断言 / 39 axe；演示判据: owner 打开项目驾驶舱时看到与 `product/ui/cool-ai-design-md-case.html` 一致的暖陶四列——左 Thread 对话目录、中项目群聊、右使命看板/审批/记忆状态——亮暗主题、键盘与 axe 关键路径不回归；约束: 工作区=不适用，verified-handle=不适用，sandbox=不适用，凭据=不适用，审批=不适用，独立复核=交付必需（项目级 review 豁免按 AGENTS.md 记录于 progress），审计=不适用；不复制 Clowder 品牌、源码或资产
  - 排期: 2026-08-14 用户指示以 case 为布局与颜色约束立即调整 UI；同日指示自动完成并 commit/push（A-263）；037/S-53 AUD-GOV 暂停于 T-02。
  - 准入: 已交付前置: 035/S-51 设计基座与壳层 token；本片建立: case 暖陶色板投影、桌面四列栅格与三栏视觉对齐（已交付）。

- 2026-08-10 [发现] tests/browser 下 review-browser-full-chain 存在既有不稳定选择器（记忆标题同现于复核与上下文两面板，strict-mode 冲突，复跑即过）；建议按面板 scope 收敛选择器。来源：017 T-05 全量验证。
- 2026-08-10 [发现] run-start 路径（POST /runs）不接受 replyToMessageId，启动新一轮时无法携带回复链接（composer 已给中性字段错误兜底）。来源：023 T-03。
