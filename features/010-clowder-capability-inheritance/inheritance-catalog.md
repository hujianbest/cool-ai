# Clowder 能力继承目录

- 日期: 2026-08-08
- 阶段: T-3（owner 逐项决定已落盘）
- 证据范围: `D:/clowder-ai` 源码、Cool AI 当前源码、`product/product.md`、`product/architecture.md`、`product/decisions.md` 与 `features/008-ui-design-refresh/`
- 状态口径: Clowder 成熟度为 `成熟|部分成熟`；Cool 状态为 `已有|部分|缺失|冲突`。
- 决策纪律: 本文件 72 个正式条目均只按 owner 本会话 AskQuestion 的 8 类选择落盘，不从建议自行扩张。
- 复用边界: 只继承用户结果与通用原则；不复制 Clowder 名称、角色、猫形象、Logo、文案、图片、精灵、源码或其他品牌资产。
- 反向引用: 后续决定、产品决策和 backlog 必须引用本目录稳定 ID；组件、API helper 和同一能力的多个页面不拆成伪功能。

## 1. 应用外壳、导航与设计系统

类别确认完成: 2026-08-08 / 本会话 AskQuestion cat1_design_shell

| ID | 名称 | Clowder 状态/证据 | Cool 状态/依据 | 建议 | 风险/依赖 | 安全影响/依据 | 决定 | owner确认日期/引用 | 决定理由 |
|---|---|---|---|---|---|---|---|---|---|
| CI-1.1 | 常驻应用外壳与分层导航 | 成熟；`packages/web/src/components/ActivityBar.tsx` 提供 Chat/Memory/Mission/Signals/Settings 常驻入口，`docs/design/console-design-system.md` §4 规定 Rail、页面基底与工作区层级 | 已有；`components/activity-bar.tsx`、`components/project-panel.tsx`、`components/team-panel.tsx` 已有工作/团队入口和驾驶舱外壳 | 已有保持；只按 Cool 业务域扩展导航 | 新入口必须保持窄屏焦点、loading/empty/error 与信息架构一致 | 无新增；`product/product.md:15,25`、`product/architecture.md:13-15,39` | 已有保持 | 2026-08-08 / 本会话 AskQuestion cat1_design_shell | Cool 已有正式外壳与导航，按 all_formal 保持现有实现。 |
| CI-1.2 | 四级表面、语义状态与 token 治理 | 成熟；`packages/web/src/app/theme-tokens.css`、`console-tokens.css`、`console-shell.css` 被现行外壳消费，`docs/design/console-design-system.md` §1-3 规定表面、间距、圆角、状态和操作层级 | 已有；`app/tokens.css`、`app/cockpit.css` 及 `features/008-ui-design-refresh/plan.md` T-2~T-4 已实现四级暖色表面、语义状态、44px 控件与响应式层级 | 已有保持；复用原则而非 OKLCH 值、品牌色和 Cat Cafe 视觉 | 防止 token 漂移；继续由视觉与可访问性契约约束 | 无新增；`product/product.md:16,25,38`、`product/architecture.md:39` | 已有保持 | 2026-08-08 / 本会话 AskQuestion cat1_design_shell | Cool 已有 token 与表面体系，按 all_formal 保持且不复制品牌值。 |
| CI-1.3 | 设置二级导航、检索与固定入口 | 成熟；`SettingsNav.tsx` + `settings-nav-config.ts` 有 14 个分区、搜索和固定到 ActivityBar 的入口，`SettingsShell.tsx` 支持深链 | 部分；Cool `/team` 有 Skills/Providers/Agents 资源页签，但无统一设置检索、固定入口；见 `components/team-panel.tsx` 与附录 CC-N | 建议在设置域增长后采用统一分区与深链，不照搬 Clowder 分区 | 依赖后续正式设置能力；过早引入会产生空壳导航 | 无新增；`product/product.md:13-15,25`、`product/architecture.md:13-15,39` | 继承 | 2026-08-08 / 本会话 AskQuestion cat1_design_shell | all_formal 选择继承 Cool 尚缺的统一设置检索、深链与固定入口。 |
| CI-1.4 | 亮/暗主题切换 | 成熟；`ActivityBar.tsx` 的 `ThemeMenu`、`theme-tokens.css` 的 light/dark token 均接入正式外壳 | 缺失；Cool 现行 `app/tokens.css` 只有暖色主题，3 个页面入口与 56 个 API 入口均无主题设置，见附录 CC-P/CC-A | 可延后；若继承需新增独立 Cool 主题契约，不复制品牌调色盘 | 对比度、截图和所有语义 token 需双主题验证 | 无新增但需满足 `product/product.md:25` 与 `product/architecture.md:39-40` | 继承 | 2026-08-08 / 本会话 AskQuestion cat1_design_shell | all_formal 选择继承亮暗主题，但建立 Cool 自有主题契约。 |
| CI-1.5 | 渐进式首次使用引导与 Bootcamp | 成熟；`FirstRunQuestWizard.tsx` 完成模板、CLI、认证、模型配置，`first-run-quest/QuestBanner.tsx` 与 `BootcampListModal.tsx` 提供 11 阶段可恢复训练营；已注册 `first-run-quest.ts`、`bootcamp.ts` | 缺失；Cool 3 个页面与 56 个 API 入口无 onboarding/bootcamp 状态，见附录 CC-P/CC-A | 建议继承“在真实任务中渐进解锁”的 onboarding，不复制角色、训练营文案或固定软件流程 | 依赖空项目、Provider 未配置、失败重试和跳过/恢复语义 | 无新增权限；引导创建的 Provider、Agent、项目仍须遵守 `product/product.md:13-17,22` 与 `product/architecture.md:31,37-38` | 继承 | 2026-08-08 / 本会话 AskQuestion cat1_design_shell | all_formal 且 recommended 明列，继承真实任务中的渐进 onboarding，不复制角色文案。 |

## 2. 聊天、线程与 Agent 协作

类别确认完成: 2026-08-08 / 本会话 AskQuestion cat2_chat_agents

| ID | 名称 | Clowder 状态/证据 | Cool 状态/依据 | 建议 | 风险/依赖 | 安全影响/依据 | 决定 | owner确认日期/引用 | 决定理由 |
|---|---|---|---|---|---|---|---|---|---|
| CI-2.1 | 持久对话、线程导航与上下文续接 | 成熟；`app/(chat)/page.tsx`、`app/(chat)/thread/[threadId]/page.tsx`、`ThreadSidebar.tsx`，以及已注册 `threads.ts`、`messages.ts`、`thread-member-strategy.ts` | 部分；Cool 以 Project/CollaborationRun 持久化群聊和事件，但没有独立线程列表和线程策略；`components/collaboration/collaboration-panel.tsx`、`app/api/projects/[projectId]/messages/route.ts` | 建议保留项目群聊为主，只有明确多线程用户结果时再扩展 | 需定义线程与 Project/Mission/Run 的归属，避免第二套会话事实源 | 适用契约；输入严格校验且隐藏思维链/原始 provider 响应不得持久化，见 `product/architecture.md:24-25,37-38` | 继承 | 2026-08-08 / 本会话 AskQuestion cat2_chat_agents | recommended 明列多线程组织，继承线程导航与上下文续接。 |
| CI-2.2 | 多 Agent 发言、@提及与显式交棒 | 成熟；聊天页及已注册 `thread-cats.ts`、`message-actions.ts`、`session-chain.ts`、`session-handoff-approve-routes.ts` | 已有；`components/collaboration/collaboration-panel.tsx` 展示 owner/Agent 消息、@参与和 handoff，领域模型为公开 TimelineEvents/Turns/Decisions | 已有保持；沿用平等 Agent、显式交棒，不复制角色人格 | 需持续防止平台变成隐藏总管 Agent | 适用契约；`product/product.md:18-20`、`product/architecture.md:24-25,32,37` | 已有保持 | 2026-08-08 / 本会话 AskQuestion cat2_chat_agents | owner 指定已有 A2A、@ 与显式交棒保持。 |
| CI-2.3 | 结构化消息块与就地决策 | 成熟；`components/rich/` 提供 diff、file、checklist、proposal、handoff 等正式消息块；已注册 `proposal-routes.ts`、`dispatch-proposal-routes.ts`、`approval-hub-routes.ts` | 部分；Cool 有 owner 决策请求、审批、验证和 review UI，但未形成通用富消息块协议；见 `collaboration-panel.tsx`、`components/execution/`、`components/review/` | 建议按 Cool 领域契约逐类引入，不建立任意 HTML/插件渲染 | 富内容来源、版本和动作幂等是前置依赖 | 适用契约；外部输入校验、写入 operation/version/lease、不得泄漏原始响应，见 `product/architecture.md:37-38` | 继承 | 2026-08-08 / 本会话 AskQuestion cat2_chat_agents | recommended 明列富消息，按 Cool 领域契约继承。 |
| CI-2.4 | 从消息创建对话分支 | 成熟；`MessageActions.tsx` 支持原文或编辑后分支，已注册 `thread-branch.ts` | 缺失；Cool 页面/API 枚举没有 branch 入口，见附录 CC-P/CC-A | 建议延后到多线程模型成立后 | 分支会影响消息、决策、任务和记忆来源一致性 | 适用契约；必须保留不可变版本与精确来源，见 `product/architecture.md:25-27,38` | 延后 | 2026-08-08 / 本会话 AskQuestion cat2_chat_agents | 分支不在 recommended 组合且非所选能力硬依赖，延后。 |
| CI-2.5 | 线程搜索与定位 | 成熟；`ThreadSidebar.tsx` 按标题、项目路径、ID 搜索并定位线程 | 缺失；Cool 页面/API 枚举无线程搜索入口，见附录 CC-P/CC-A | 建议在多线程成立时优先继承 | 搜索范围、分页与项目隔离必须明确 | 适用契约；搜索不得跨项目泄漏，见 `product/architecture.md:24-25,37` | 继承 | 2026-08-08 / 本会话 AskQuestion cat2_chat_agents | recommended 明列线程搜索。 |
| CI-2.6 | 线程标签与整理 | 成熟；`ThreadOrganizerModal.tsx` 支持搜索、创建/删除标签、批量分配，已注册 `labels.ts` | 缺失；Cool 页面/API 枚举无线程标签入口，见附录 CC-P/CC-A | 建议仅在多线程数量形成管理负担后继承 | 标签需要稳定 ID、删除语义和项目范围 | 适用契约；标签不得成为跨项目旁路，见 `product/architecture.md:24-25,37-38` | 继承 | 2026-08-08 / 本会话 AskQuestion cat2_chat_agents | recommended 明列线程标签与整理。 |
| CI-2.7 | 线程收藏 | 成熟；`ThreadSidebar.tsx` 有独立“收藏”页签与 favorite toggle | 缺失；Cool 页面/API 枚举无收藏字段/入口，见附录 CC-P/CC-A | 可作为轻量线程管理能力 | 依赖线程模型；需定义排序与重启持久化 | 无新增；仍受项目数据边界约束，见 `product/architecture.md:24-25,37` | 继承 | 2026-08-08 / 本会话 AskQuestion cat2_chat_agents | recommended 明列线程收藏。 |
| CI-2.8 | 线程回收站与恢复/永久删除 | 成熟；`ThreadSidebar.tsx` 加载 `deleted=true`、支持软删除、回收站与删除确认 | 缺失；Cool 页面/API 枚举无 thread trash 入口，见附录 CC-P/CC-A | 建议在线程删除前建立；恢复与永久删除必须分层 | 数据保留、当前线程跳转、系统线程保护和不可逆确认 | 适用契约；破坏性动作需明确审批/确认且失败关闭，见 `product/product.md:22,37`、`product/architecture.md:37-38` | 继承 | 2026-08-08 / 本会话 AskQuestion cat2_chat_agents | recommended 明列线程回收站；永久删除仍需强确认。 |
| CI-2.9 | 聊天队列、重排与 Steer | 成熟；`QueuePanel.tsx` 展示等待原因、暂停/恢复、撤回、重排、下一项、清空及 promote/defer steer，已注册 `queue.ts` | 缺失；Cool 有 Run/Execution 队列状态但无 owner 消息队列和 steer 入口，见 `components/collaboration/collaboration-panel.tsx` 与附录 CC-A | 建议只在同线程并发输入可观察后继承 | 队列项状态竞态、处理中不可 steer、附件/引用恢复与幂等 | 适用契约；队列写操作需 operation/version/lease、失败关闭，见 `product/architecture.md:25-26,38` | 继承 | 2026-08-08 / 本会话 AskQuestion cat2_chat_agents | recommended 明列消息队列与 steer。 |
| CI-2.10 | 图片附件发送 | 成熟；`ChatInput.tsx` 支持 PNG/JPEG/GIF/WebP、最多 5 张、粘贴/选择、上传状态与草稿恢复，已注册 `uploads.ts` | 缺失；Cool messages API 与聊天 UI 无图片附件契约，见附录 CC-A | 建议按项目内附件需求独立评估 | 文件类型/大小、恶意内容、存储清理和 provider 能力差异 | 适用契约；上传是外部输入，必须严格校验且不得越出工作区/持久化敏感内容，见 `product/product.md:22`、`product/architecture.md:37` | 继承 | 2026-08-08 / 本会话 AskQuestion cat2_chat_agents | recommended 明列图片附件，继承时严格校验文件。 |
| CI-2.11 | 回复引用与来源跳转 | 成熟；`ChatInput.tsx`、`ReplyPreviewBar.tsx`、`ReplyPill.tsx` 支持线程内 reply-to 草稿恢复和来源展示 | 缺失；Cool ProjectMessage 契约与 UI 无 replyTo 入口，见附录 CC-A | 建议继承为讨论可追溯性基础 | 被删消息、跨线程引用与版本显示 | 适用契约；引用必须保留精确来源且不得伪造，见 `product/architecture.md:25,27,37-38` | 继承 | 2026-08-08 / 本会话 AskQuestion cat2_chat_agents | recommended 明列回复引用，必须保留精确来源。 |
| CI-2.12 | 输入历史搜索与草稿恢复 | 成熟；`HistorySearchModal.tsx` 通过 Ctrl+R 搜索输入历史，`ChatInput.tsx` 按线程恢复文字/图片/引用草稿 | 缺失；Cool 聊天 composer 无输入历史/草稿持久化入口，见附录 CC-P/CC-A | 建议先做本地线程草稿，再评估跨重启输入历史 | 本地隐私、容量、清除入口和敏感输入残留 | 适用契约；不得保存凭据或隐藏数据，见 `product/architecture.md:37` | 继承 | 2026-08-08 / 本会话 AskQuestion cat2_chat_agents | recommended 明列输入历史与草稿恢复。 |
| CI-2.13 | 多目标私语 | 成熟；`WhisperCatSelector.tsx` 支持选择一个或多个非执行中 Agent，消息路由已有正式聊天接线 | 冲突；Cool 以公开 TimelineEvents 和结构化共享记忆同步组员，无私语可见性契约；`product/product.md:18-21,23-24`、`product/architecture.md:25,27` | 建议不继承；平等项目组的共享上下文优先 | 私语会破坏共享事实、审计可见性和独立复核上下文 | 冲突；`product/product.md:18-21,23-24`、`product/architecture.md:25,27,37` 要求公开协作轨迹和可审计交付 | 不继承 | 2026-08-08 / 本会话 AskQuestion cat2_chat_agents | owner 明确私语不继承，保持公开协作轨迹。 |
| CI-2.14 | Agent 投票 | 成熟；`VoteConfigModal.tsx`、`VoteActiveBar.tsx` 支持问题、2~10 选项、投票者、匿名与超时，已注册 `votes.ts` | 冲突；Cool 的正式方向由 owner 回答，结果由指定非执行 Agent 真实复核，不以投票替代；`product/product.md:18,24`、`product/decisions.md:D-12` | 建议不继承；正式决定仍由 owner，复核仍由指定非执行 Agent | 匿名性、超时、平票及投票不能替代 owner/复核裁决 | 冲突；`product/product.md:18,24`、`product/decisions.md:D-12`、`product/architecture.md:25,27` | 不继承 | 2026-08-08 / 本会话 AskQuestion cat2_chat_agents | owner 明确投票不继承，不能替代 owner 决策或独立复核。 |
| CI-2.15 | 多线程分屏协作 | 成熟；`SplitPaneView.tsx`、`SplitPaneCell.tsx`、`MiniThreadSidebar.tsx` 支持多线程并排、独立草稿和目标线程 | 缺失；Cool 页面/API 枚举无 split-pane 入口，见附录 CC-P/CC-A | 建议在线程模型成熟后再评估 | 焦点、消息目标、窄屏和多 Run 状态隔离复杂 | 适用契约；必须保持线程/项目隔离和动作目标明确，见 `product/architecture.md:24-25,37-38` | 延后 | 2026-08-08 / 本会话 AskQuestion cat2_chat_agents | 多线程分屏未列入 recommended 且非硬依赖，延后。 |
| CI-2.16 | 跨线程来源标注与导航 | 成熟；`MessageNavigator.tsx` 与跨线程 author/source 标签在正式聊天消费 | 缺失；Cool 页面/API 枚举无 cross-thread 来源导航，见附录 CC-P/CC-A | 建议仅在跨线程引用真实存在后继承 | 来源消失、权限和循环引用 | 适用契约；必须保留精确来源且不可伪造，见 `product/architecture.md:25,27,37-38` | 延后 | 2026-08-08 / 本会话 AskQuestion cat2_chat_agents | 跨线程能力未列入 recommended 且非所选能力硬依赖，延后。 |
| CI-2.17 | 消息软删除与永久删除 | 成熟；`MessageActions.tsx` 提供可恢复软删除和需输入对话标题确认的永久删除，已注册 `message-actions.ts` | 缺失；Cool messages API 无消息删除/恢复契约，见附录 CC-A | 建议如继承先做软删除与审计，永久删除另设强确认 | 引用悬空、审计保留、当前分支和不可逆清除 | 适用契约；破坏性动作必须明确确认、失败关闭且保留审计，见 `product/product.md:23-24,37`、`product/architecture.md:25,37-38` | 延后 | 2026-08-08 / 本会话 AskQuestion cat2_chat_agents | 消息级删除未列入 recommended，且不是线程回收站硬依赖，延后。 |

## 3. 项目、工作区与安全执行

类别确认完成: 2026-08-08 / 本会话 AskQuestion cat3_workspace_execution

| ID | 名称 | Clowder 状态/证据 | Cool 状态/依据 | 建议 | 风险/依赖 | 安全影响/依据 | 决定 | owner确认日期/引用 | 决定理由 |
|---|---|---|---|---|---|---|---|---|---|
| CI-3.1 | 项目创建、导入与工作区绑定 | 成熟；Mission Hub 的导入项目入口；已注册 `projects.ts`、`projects-setup.ts`、`projects-bootstrap.ts`、`projects-mkdir.ts`、`external-projects.ts` | 已有；`components/project-panel.tsx`、`project-context/project-setup-panel.tsx`、`workspace-setup.tsx` 与 projects/workspace API | 已有保持；仅吸收导入流程的可用性原则 | Windows 路径、规范路径和重绑语义必须保持单一事实源 | 适用契约；只允许绑定工作区内操作，见 `product/product.md:17,22,37`、`product/architecture.md:18,33,37-38` | 已有保持 | 2026-08-08 / 本会话 AskQuestion cat3_workspace_execution | Cool 已有项目与工作区绑定，按 all_formal 保持。 |
| CI-3.2 | 工作区文件浏览与只读预览 | 成熟；`WorkspaceTree.tsx`、`WorkspaceFileViewer.tsx`、`CodeViewer.tsx`、`DiffViewer.tsx` 与已注册 `workspace.ts`、`preview.ts` | 部分；Cool 有任务内 diff、staged preview 与 artifact 查看，但无 owner 通用文件树；见 `components/execution/`、`components/review/` | 建议继承绑定工作区内的只读浏览，不默认开放写入 | 依赖 verified-handle、路径规范化、大文件和二进制策略 | 适用契约；不得越出绑定工作区，见 `product/product.md:22,37`、`product/architecture.md:18,33,37-38` | 继承 | 2026-08-08 / 本会话 AskQuestion cat3_workspace_execution | all_formal 继承多根目录浏览与预览；必须经 verified-handle 且不得越界。 |
| CI-3.3 | 隔离执行、动作审批与安全合入 | 部分成熟；Clowder 有 workspace/edit/git/terminal、authorization/audit/approval 路由，但安全模型不同且不能直接移植 | 已有；Cool 已有 sandbox、Approval、Validation、StagedChange、MergeJournal、stale/冲突检查；`components/execution/` 与执行 API | 已有保持；Cool 约束优先，不以 Clowder 能力扩大工具权限 | 任何继承项均需在 Cool 安全模型内重写 | 适用契约且为硬边界；`product/product.md:22,37`、`product/architecture.md:18,26,33,37-38` | 已有保持 | 2026-08-08 / 本会话 AskQuestion cat3_workspace_execution | Cool 安全执行链已有保持，并作为所有继承项不可绕过的硬边界。 |
| CI-3.4 | 外部运行会话管理 | 成熟；Settings Ops 的 runtime/agent sessions 与 `ExternalRuntimeSessionsPanel.tsx`，已注册 `external-runtime-sessions.ts`、`session-transcript.ts` | 缺失；Cool 无外部 CLI runtime session 管理，见附录 CC-A | 建议仅随原生 CLI Provider 一并评估 | 会话凭据、外部进程生命周期、跨重启一致性 | 适用契约；`product/product.md:23,34`、`product/architecture.md:25,37-38` | 继承 | 2026-08-08 / 本会话 AskQuestion cat3_workspace_execution | all_formal 继承外部会话管理，仍受 sandbox、凭据与审计边界。 |
| CI-3.5 | 工作区直接编辑与 Git 变更 | 成熟；`ChangesPanel.tsx`、`GitPanel.tsx` 及已注册 `workspace-edit.ts`、`workspace-git.ts` | 部分；Cool 仅允许 sandbox 中的 staged change 和受控 merge，不提供 canonical workspace 直接编辑；见 `product/architecture.md:18,26,33` | 建议不继承直接写 canonical workspace；只保留 Cool 安全合入 | 冲突、stale、回滚和不可逆 Git 操作 | 冲突；`product/product.md:22,37`、`product/architecture.md:18,26,33,38` 要求 sandbox、审批与 merge journal | 继承 | 2026-08-08 / 本会话 AskQuestion cat3_workspace_execution | owner 明确继承直接编辑/Git，但必须在 verified-handle、sandbox、审批、冲突检测和审计内重写，不照搬。 |
| CI-3.6 | 终端与浏览器运行工具 | 成熟；`TerminalTab.tsx`、`BrowserPanel.tsx` 及已注册 `terminal.ts`、`preview.ts` | 部分；Cool 可按任务运行验证命令，但无 owner 通用终端/浏览器控制台；见 execution API 与附录 CC-P | 建议只允许策略内命令和任务内预览，不提供无限制 shell | 命令注入、网络访问、凭据、端口和外部发布 | 适用契约且不得削弱；`product/product.md:22,37`、`product/architecture.md:18,33,37-38` | 继承 | 2026-08-08 / 本会话 AskQuestion cat3_workspace_execution | owner 明确继承 Web 终端/预览；仅允许精确命令政策、审批、sandbox 与审计内动作。 |
| CI-3.7 | 中断恢复与人工修复 | 成熟；Ops/runtime surfaces 与会话链路提供失败恢复；相关 events/session routes 已注册 | 已有；`components/execution/manual-recovery-surface.tsx`、executions recovery/files/resolve API 支持可审计恢复 | 已有保持；只吸收可解释恢复状态，不复制外部 CLI 细节 | 恢复必须绑定失败 attempt 和版本，不能补写旧动作 | 适用契约；`product/product.md:23-24`、`product/architecture.md:26-27,38` | 已有保持 | 2026-08-08 / 本会话 AskQuestion cat3_workspace_execution | Cool 已有可审计恢复，按 all_formal 保持。 |
| CI-3.8 | 审计事件与会话记录 | 成熟；`SessionEventsViewer.tsx`、`TranscriptPanel.tsx`，已注册 `audit.ts`、`events.ts`、`telemetry.ts` | 部分；Cool 有公开 TimelineEvents、执行事件和验证证据，但无统一审计浏览器；见 collaboration/execution/review 组件 | 建议统一现有 Cool 事件只读视图 | 日志体量、脱敏、来源和保留期 | 适用契约；凭据、隐藏思维链、原始 provider 响应不得展示或持久化，见 `product/architecture.md:25-27,37` | 继承 | 2026-08-08 / 本会话 AskQuestion cat3_workspace_execution | all_formal 继承统一审计视图，必须脱敏并保留来源。 |

## 4. Mission、任务与审批治理

类别确认完成: 2026-08-08 / 本会话 AskQuestion cat4_mission_governance

| ID | 名称 | Clowder 状态/证据 | Cool 状态/依据 | 建议 | 风险/依赖 | 安全影响/依据 | 决定 | owner确认日期/引用 | 决定理由 |
|---|---|---|---|---|---|---|---|---|---|
| CI-4.1 | Mission 生命周期与任务看板 | 成熟；`app/mission-hub/page.tsx`、`MissionControlPage.tsx` 的功能列表、状态统计与详情；已注册 `tasks.ts`、`backlog.ts` | 已有；`components/project-context/mission-board.tsx`、`task-panel.tsx` 及 missions/work-items/tasks API 已有负责人、依赖、状态和接力棒 | 已有保持；以 Cool Mission/WorkItem 模型为准 | 避免把 Feature 术语强加给非软件项目 | 适用契约；`product/product.md:19-20,23`、`product/architecture.md:24-26,32,38` | 已有保持 | 2026-08-08 / 本会话 AskQuestion cat4_mission_governance | owner 指定已有项目内 Mission 保持。 |
| CI-4.2 | Need Audit 与意图卡提取 | 成熟；`NeedAuditFrame.tsx`、`IntentCardDetail.tsx` 与已注册 `intent-card-routes.ts`、`external-projects.ts` | 缺失；Cool 页面/API 无产品需求审计入口，见附录 CC-P/CC-A | 建议作为软件项目可选技能，而非平台内置真相源 | AI 生成的具体性、原始需求来源和人工确认 | 适用契约；输出写入仍受工作区边界和审计约束，见 `product/product.md:22,37`、`product/architecture.md:18,37-38` | 延后 | 2026-08-08 / 本会话 AskQuestion cat4_mission_governance | owner 明确 Need Audit 与外部项目导入延后。 |
| CI-4.3 | 统一提案与审批中心 | 成熟；ActivityBar 审批 badge、Mission Hub 建议详情；已注册 proposal/approval/dispatch/session-handoff 路由 | 部分；Cool 有 owner decision 与 execution approval，但无统一跨域审批中心；见 collaboration/execution 组件与 API | 建议统一 Cool 已有审批事件入口，不复制 Clowder 提案模型 | 审批类型、失效规则和来源必须一致 | 适用契约；高风险动作必须暂停，写入失败关闭，见 `product/product.md:22-23,37`、`product/architecture.md:26,33,38` | 继承 | 2026-08-08 / 本会话 AskQuestion cat4_mission_governance | recommended 明列统一审批中心，沿用 Cool 审批事件契约。 |
| CI-4.4 | 任务依赖全景 | 成熟；`DependencyGraphTab.tsx` 与 Mission Hub 依赖页签展示依赖图、状态和阻塞 | 部分；Cool WorkItem 已有依赖字段和看板，但无全景图；`components/project-context/mission-board.tsx` | 建议在复杂 Mission 中增加只读依赖视图 | 大图可读性、循环依赖和状态同步 | 适用契约；依赖变更需保持版本约束，见 `product/product.md:19`、`product/architecture.md:24-26,38` | 继承 | 2026-08-08 / 本会话 AskQuestion cat4_mission_governance | 作为 owner 明列的跨项目 Mission 总览，继承只读依赖与阻塞全景。 |
| CI-4.5 | Resolution、Slice 与 Reflux 治理 | 成熟；`ResolutionQueue.tsx`、`SliceLadder.tsx`、`RefluxCapture.tsx`，已注册 `resolution-routes.ts`、`slice-routes.ts`、`reflux-routes.ts` | 缺失；Cool 无对应产品治理模型，见附录 CC-A | 建议只作为软件交付方法评估，避免复制 Clowder 内部 Feature 模型 | 容易与 HarnessFlow 和产品 backlog 形成双事实源 | 适用契约；任何文件写入仍受 `product/product.md:22,37` 与 `product/architecture.md:18,38` 约束 | 延后 | 2026-08-08 / 本会话 AskQuestion cat4_mission_governance | 未列入 recommended，且可能与 HarnessFlow 形成双事实源，按依赖延后。 |
| CI-4.6 | SOP 公告板与流程状态 | 成熟；`WorkflowSopPanel.tsx`、Mission Hub SOP 页签，已注册 `workflow-sop.ts`、`governance-status.ts` | 缺失；Cool 无平台内 SOP 公告板，见附录 CC-P/CC-A | 建议只展示仓库流程真实状态，不复制第二套状态机 | 状态陈旧、流程工具耦合和非软件项目适用性 | 无新增权限；状态必须来源可审计，见 `product/product.md:23-24`、`product/architecture.md:25,37-38` | 继承 | 2026-08-08 / 本会话 AskQuestion cat4_mission_governance | recommended 明列 SOP 可视化；只展示可审计真实状态。 |
| CI-4.7 | 任务自领、租约与派发控制 | 成熟；`SuggestionDrawer.tsx` 支持 self-claim/acquire/heartbeat/release/reclaim lease，dispatch routes 已注册 | 部分；Cool 有任务领取、显式交棒和并行执行，但无 owner 可见的完整租约控制面；见 collaboration timeline | 建议沿用 Cool 现有 lease 约束并补可见性 | 过期租约、重复领取、并发派发和回收权限 | 适用契约；写入使用 operation/version/lease，见 `product/architecture.md:25-26,38` | 继承 | 2026-08-08 / 本会话 AskQuestion cat4_mission_governance | recommended 明列 lease 可视化；沿用 Cool operation/version/lease。 |

## 5. 记忆、检索与知识管理

类别确认完成: 2026-08-08 / 本会话 AskQuestion cat5_memory

| ID | 名称 | Clowder 状态/证据 | Cool 状态/依据 | 建议 | 风险/依赖 | 安全影响/依据 | 决定 | owner确认日期/引用 | 决定理由 |
|---|---|---|---|---|---|---|---|---|---|
| CI-5.1 | 知识动态与记忆检索 | 成熟；`/memory`、`/memory/search`，`MemoryNav.tsx`；已注册 `memory.ts`、`knowledge-feed.ts`、`library.ts` | 部分；Cool 有项目共享记忆列表/创建和精确来源，但无全文检索与知识动态；`components/project-context/memory-panel.tsx`、memories API | 建议优先补项目内搜索与来源筛选，不引入全局人格记忆 | 需定义索引范围、删除/替代语义与权限边界 | 适用契约；结构化记忆只含可引用事实且不得含凭据/隐藏思维链，见 `product/product.md:21`、`product/architecture.md:25,27,37` | 继承 | 2026-08-08 / 本会话 AskQuestion cat5_memory | all_formal 继承项目内搜索、知识动态与 Event Memory 结果。 |
| CI-5.2 | 索引状态与记忆健康度 | 成熟；`/memory/status`、`/memory/health`、`IndexStatus.tsx`、`HealthReport.tsx`；已注册 `f163-admin.ts`、`f163-audit-routes.ts`、`recall-metrics.ts` | 缺失；Cool 只有项目记忆面板，无索引状态/健康入口，见附录 CC-P/CC-A | 建议优先继承失败可见性和修复动作 | 依赖真实检索管线、指标定义和降级策略 | 适用契约；诊断不得泄漏凭据、原始响应或跨项目记忆，见 `product/architecture.md:17,24-25,37` | 继承 | 2026-08-08 / 本会话 AskQuestion cat5_memory | all_formal 明确继承索引状态与健康诊断。 |
| CI-5.3 | 记忆来源、证据与版本链 | 成熟；memory/evidence/perspectives 路由与 Memory Hub 来源展示 | 已有；Cool 已有 review Agent 提议、精确来源 tuple、去重和 supersedes 版本链；`product/decisions.md:D-15,D-16`、review-memory 组件 | 已有保持；继续把来源作为不可变事实 | 来源失效、版本漂移和跨项目引用 | 适用契约；`product/product.md:21,24`、`product/architecture.md:25,27,37-38` | 已有保持 | 2026-08-08 / 本会话 AskQuestion cat5_memory | owner 指定已有来源、证据与版本链保持。 |
| CI-5.4 | 知识目录与集合管理 | 成熟；`/memory/catalog`、`CreateCollectionDialog.tsx`、Library components 及已注册 `library.ts`、`packs.ts` | 缺失；Cool 无目录/集合入口，见附录 CC-P/CC-A | 建议在项目记忆规模增长后引入项目内集合 | 集合归属、移动/删除与权限范围 | 适用契约；不得跨项目聚合敏感记忆，见 `product/architecture.md:24-25,37` | 继承 | 2026-08-08 / 本会话 AskQuestion cat5_memory | all_formal 明确继承目录与集合管理。 |
| CI-5.5 | 知识图谱 | 成熟；`/memory/graph`、`CollectionGraph.tsx` 提供集合关系图 | 缺失；Cool 无图谱页面/API，见附录 CC-P/CC-A | 建议延后到有明确导航任务和足够关系数据 | 图规模、关系可信度和可访问替代视图 | 适用契约；关系必须来源可追溯，见 `product/product.md:21`、`product/architecture.md:25,27,37` | 继承 | 2026-08-08 / 本会话 AskQuestion cat5_memory | all_formal 明确继承知识图谱，关系必须有来源。 |
| CI-5.6 | 自动提炼、反思与记忆发布 | 成熟；已注册 dossier/distillation/reflect/memory-publish/summaries 路由 | 部分；Cool 的 review Agent 可提议记忆，但无通用自动提炼、反思或发布 UI；`product/decisions.md:D-15,D-16` | 建议任何自动产物必须由真实 Agent 署名并经来源校验 | 自动摘要可能漂移、覆盖事实或污染共享记忆 | 适用契约；`product/product.md:21,24`、`product/architecture.md:25,27,37-38` | 继承 | 2026-08-08 / 本会话 AskQuestion cat5_memory | all_formal 明确继承自动提炼、反思与画像；必须由真实 Agent 署名并保留来源。 |

## 6. Provider、Skill、设置与运维

类别确认完成: 2026-08-08 / 本会话 AskQuestion cat6_settings_ops

| ID | 名称 | Clowder 状态/证据 | Cool 状态/依据 | 建议 | 风险/依赖 | 安全影响/依据 | 决定 | owner确认日期/引用 | 决定理由 |
|---|---|---|---|---|---|---|---|---|---|
| CI-6.1 | OpenAI-compatible Provider 账户、凭据与连接验证 | 成熟；Settings `accounts` 支持 provider profiles、API key/OAuth；已注册 `accounts.ts`、`config-secrets.ts`、`services.ts` | 已有；`components/provider-panel.tsx` 与 providers/verify API 支持 OpenAI-compatible 配置和验证 | 已有保持 | 密钥永不回显/入日志，验证失败不得伪造成功 | 适用契约；`product/product.md:13`、`product/architecture.md:23,31,37-38` | 已有保持 | 2026-08-08 / 本会话 AskQuestion cat6_settings_ops | owner 指定已有 Provider 配置保持。 |
| CI-6.2 | 本地 Skill 管理与 Agent 分配 | 成熟；Settings `skills` 与已注册 `skills.ts`、`skills-write.ts`、`skills-drift.ts`、`mount-rules.ts` | 已有；`components/skill-panel.tsx`、skills API 和 Agent 配置支持本地指令包 | 已有保持；明确不是市场插件或任意可执行扩展 | Skill 内容是提示输入，需防注入并限制工具权限 | 适用契约；`product/product.md:14,32`、`product/architecture.md:23,31,37` | 已有保持 | 2026-08-08 / 本会话 AskQuestion cat6_settings_ops | owner 指定已有 Skill 管理与分配保持。 |
| CI-6.3 | Agent 成员、能力画像与路由策略 | 成熟；Settings `members`/`profiles`，已注册 `cats.ts`、`capabilities.ts`、`dossier.ts`、`thread-member-strategy.ts` | 部分；Cool 有 AgentTemplate/Agent、职责、模型、技能、工具权限和稳定视觉身份，但无自动能力画像/路由信号；`components/agent-panel.tsx` | 建议保留 owner 配置为事实源；画像只作可解释建议 | 自动画像可能把推断当权限或角色事实 | 适用契约；`product/product.md:14,20`、`product/architecture.md:23-25,37-38` | 继承 | 2026-08-08 / 本会话 AskQuestion cat6_settings_ops | 保持已有 Agent 配置，并按 all_formal 继承缺失的可解释画像与路由信号。 |
| CI-6.4 | MCP 服务与工具管理 | 成熟；Settings `mcp` 的 `McpManageContent.tsx` 支持全局/项目作用域、发现同步、新增、工具查看和卸载；已注册 `capabilities.ts`、`mcp-drift.ts` | 冲突；`product/product.md:32` 明确首版不做第三方 MCP 市场和任意可执行插件，尚未定义受控 MCP 边界 | 建议仅按独立高风险切片评估受控 MCP，不与市场/插件捆绑决定 | command/http transport、环境变量、工具权限、工作目录与供应链 | 冲突；`product/product.md:32,37`、`product/architecture.md:18,37-38` 要求 sandbox、凭据保护、审批和审计 | 继承 | 2026-08-08 / 本会话 AskQuestion cat6_settings_ops | owner 新决定取代旧 MVP 排除；MCP 必须单独安全切片并受 sandbox、凭据、审批和审计约束。 |
| CI-6.5 | 系统配置、规则与提示注入检查 | 成熟；Settings `system`/`rules`，已注册 `config.ts`、`rules.ts`、`prompt-injection*.ts`、`agent-hooks.ts` | 部分；Cool 有 Provider/Agent/Skill 配置及 API 严格校验，但无统一系统规则/注入清单 UI | 建议仅继承可审计配置与安全检查，不开放任意全局注入 | 全局规则可能覆盖项目边界或泄漏凭据 | 适用契约；`product/product.md:14,22`、`product/architecture.md:31,37-38` | 继承 | 2026-08-08 / 本会话 AskQuestion cat6_settings_ops | all_formal 继承可审计系统配置与注入检查。 |
| CI-6.6 | 服务健康与可观察性中心 | 成熟；Settings Ops 的 observability/health、`HubObservabilityOverview.tsx`，已注册 `system-status.ts`、`eval-hub.ts`、`tool-usage.ts` | 部分；Cool 有验证、事件、错误三态和恢复，但无统一运维中心；见 execution/review 组件 | 建议聚合现有健康与失败状态，不增加隐藏遥测 | 指标口径、日志体量和脱敏 | 适用契约；`product/product.md:23-24`、`product/architecture.md:25-27,37` | 继承 | 2026-08-08 / 本会话 AskQuestion cat6_settings_ops | all_formal 明确继承高级运维与可观察性。 |
| CI-6.7 | 语音输入、输出与伴随模式 | 成熟；Settings `voice`、README Voice Companion，已注册 `audio-proxy.ts`、`tts.ts`、`ref-audio-upload.ts` | 冲突；`product/product.md:31,35` 排除语音伴侣与移动端外围体验 | 建议不继承当前 MVP | 音频上传、第三方 TTS 凭据、隐私和自动播放 | 冲突；`product/product.md:31,35`、`product/architecture.md:37` | 继承 | 2026-08-08 / 本会话 AskQuestion cat6_settings_ops | owner 新决定取代旧 MVP 排除；语音必须独立隐私、上传与凭据安全切片。 |
| CI-6.8 | 原生 Agent CLI / ACP Provider 适配 | 成熟；README Supported Agents 明示 Claude Code、Codex CLI、Antigravity CLI、Gemini CLI/ACP、opencode 已交付；`packages/api/src/domains/cats/services/agents/providers/` 有对应运行时 | 冲突；Cool 只承诺 OpenAI-compatible HTTP，`product/product.md:34` 明确不原生适配每家模型 API 或本地 Agent CLI | 建议保持不继承首版；未来每个 adapter 独立安全切片 | 本地进程、认证文件、CLI 版本、输出解析、MCP/ACP 与恢复差异 | 冲突；`product/product.md:34,37`、`product/architecture.md:18,37-38` | 继承 | 2026-08-08 / 本会话 AskQuestion cat6_settings_ops | owner 新决定取代旧 MVP 排除；每个 CLI/ACP adapter 必须独立安全切片。 |
| CI-6.9 | 已安装插件管理 | 成熟；Settings `plugins` 的 `PluginsContent.tsx` 支持插件状态、配置和启停，已注册 `plugin-routes.ts`、`connector-plugins.ts` | 冲突；`product/product.md:32` 排除任意可执行插件 | 建议不继承首版；与 MCP/市场分开决定 | 插件代码执行、外部服务凭据、生命周期与回滚 | 冲突；`product/product.md:32,37`、`product/architecture.md:18,37-38` | 继承 | 2026-08-08 / 本会话 AskQuestion cat6_settings_ops | owner 新决定取代旧 MVP 排除；插件管理必须独立供应链与执行安全切片。 |
| CI-6.10 | 能力市场搜索、安装计划与适配 | 成熟；Settings `marketplace` 的 `MarketplaceContent.tsx`/`marketplace-panel` 支持搜索、安装计划和多客户端 adapter；已注册 `marketplace.ts` | 冲突；`product/product.md:32` 明确排除技能/插件市场和第三方 MCP 市场 | 建议不继承首版 | 供应链签名、来源信任、安装预览、回滚和兼容性 | 冲突；`product/product.md:32,37`、`product/architecture.md:37-38` | 继承 | 2026-08-08 / 本会话 AskQuestion cat6_settings_ops | owner 新决定取代旧 MVP 排除；市场必须独立签名、预览、回滚与来源信任切片。 |
| CI-6.11 | 用量与配额看板 | 成熟；Settings Ops usage、Hub Quota Board，已注册 `quota.ts`、`usage.ts` | 部分；Cool CollaborationRun 有 Usage 和预算/轮次边界，但无统一配额看板；`product/architecture.md:25` | 建议显示基础用量与边界，不引入计费结算 | 多 provider 口径、估算误差和敏感账户信息 | 适用契约；`product/product.md:23,33`、`product/architecture.md:25,37` | 继承 | 2026-08-08 / 本会话 AskQuestion cat6_settings_ops | all_formal 继承统一用量与配额看板。 |
| CI-6.12 | 运维命令与救援操作 | 成熟；Settings Ops commands/rescue、`HubCommandsTab.tsx`、`HubClaudeRescueSection`，已注册 `commands.ts`、`claude-rescue.ts` | 部分；Cool 有受控恢复 API，但无通用运维命令面板 | 建议只保留领域化恢复动作，不开放任意命令 | 高权限命令、凭据、进程终止和误操作 | 适用契约且不得削弱；`product/product.md:22,37`、`product/architecture.md:18,37-38` | 继承 | 2026-08-08 / 本会话 AskQuestion cat6_settings_ops | all_formal 继承高级运维；命令必须精确许可、审批并审计。 |
| CI-6.13 | Agent 活跃度/贡献排行榜 | 成熟；Settings Ops leaderboard 和 README 展示排行榜，已注册 `leaderboard.ts`、`leaderboard-events.ts` | 冲突；Cool 强调平等角色协作、真实复核和任务结果，不把活跃度排名作为成功依据；`product/product.md:14,20,24`、`product/architecture.md:23-27` | 建议不继承；避免把平等协作变成无上下文竞赛 | 指标诱导、角色偏见和与成果质量脱节 | 冲突；`product/product.md:14,20,24`、`product/architecture.md:23-27` | 继承 | 2026-08-08 / 本会话 AskQuestion cat6_settings_ops | all_formal 覆盖全部正式运维能力；该项需独立指标治理切片，不得改变平等协作或复核规则。 |

## 7. 通知、外部集成与自动化

类别确认完成: 2026-08-08 / 本会话 AskQuestion cat7_integrations_automation

| ID | 名称 | Clowder 状态/证据 | Cool 状态/依据 | 建议 | 风险/依赖 | 安全影响/依据 | 决定 | owner确认日期/引用 | 决定理由 |
|---|---|---|---|---|---|---|---|---|---|
| CI-7.1 | 浏览器通知与 PWA 推送 | 成熟；Settings `notify`、`PushSettingsPanel`；已注册 `push.ts` | 缺失；Cool 页面/API 全集无 push/notification/service-worker 入口，见附录 CC-P/CC-A | 建议仅在明确后台提醒场景时引入，默认最小权限 | 浏览器权限、订阅密钥、重复提醒和离线语义 | 适用契约；凭据保护与失败关闭见 `product/architecture.md:37-38`，无人值守边界见 `product/product.md:36` | 继承 | 2026-08-08 / 本会话 AskQuestion cat7_integrations_automation | notifications_only 只选择浏览器通知/PWA。 |
| CI-7.2 | 外部 IM 与连接器消息 | 成熟；Settings `im`、README 明示 Feishu 正式可用；已注册 connector/callback/webhook/media 路由 | 冲突；`product/product.md:29-30` 明确首版单 owner Web、飞书/Telegram 延后 | 建议延后核心闭环后；不得复制外部品牌卡片资产 | webhook 鉴权、附件、身份映射、重放与出站审批 | 冲突；`product/product.md:29-30,37`、`product/architecture.md:37-38` | 不继承 | 2026-08-08 / 本会话 AskQuestion cat7_integrations_automation | notifications_only 明确外部 IM 与连接器不继承。 |
| CI-7.3 | 定时任务、值班简报与跨重启自动化 | 成熟；已注册 `schedule.ts`、`duty-briefing.ts`，workspace 有 SchedulePanel | 冲突；`product/product.md:36` 明确不做无人值守定时任务与跨重启自动后台运行 | 建议不继承首版；将来必须逐动作授权 | 无人值守外部写入、过期上下文、成本与停止语义 | 冲突；`product/product.md:36-37`、`product/architecture.md:37-38` | 不继承 | 2026-08-08 / 本会话 AskQuestion cat7_integrations_automation | owner 明确定时任务、daemon 与跨重启自动化不继承。 |
| CI-7.4 | Signals 资讯源与收件箱 | 成熟；`/signals`、`/signals/sources`、`SignalInboxView.tsx`/`SignalSourcesView.tsx` 支持源配置、分层筛选、已读/收藏/标注，已注册 `signals.ts`、`signal-collection-routes.ts` | 冲突；`product/product.md:31` 排除资讯流外围体验，Cool 入口全集无 Signals | 建议不继承；项目内调研应由目标驱动 | 外部内容信任、版权、抓取和提示注入 | 冲突；`product/product.md:21,31`、`product/architecture.md:37` | 不继承 | 2026-08-08 / 本会话 AskQuestion cat7_integrations_automation | notifications_only 明确 Signals 资讯流不继承。 |
| CI-7.5 | Signal 协作研读与研究报告 | 成熟；`StudyFoldArea.tsx`、`StudyTimeline.tsx` 支持笔记、关联线程和多 Agent 研究，已注册 `signal-study-routes.ts` | 缺失；Cool 无独立 Signal 研读入口，见附录 CC-P/CC-A | 建议未来以项目内调研任务实现，不引入资讯流前置依赖 | 来源引用、研究结论审校和跨项目记忆污染 | 适用契约；事实必须可引用并经复核，见 `product/product.md:21,24`、`product/architecture.md:25,27,37` | 不继承 | 2026-08-08 / 本会话 AskQuestion cat7_integrations_automation | notifications_only 排除 Signals 及其他集成自动化，故不继承。 |
| CI-7.6 | 研究播客生成 | 成熟；`PodcastPlayer.tsx` 与已注册 `signal-podcast-routes.ts` 支持研究内容音频化 | 冲突；`product/product.md:31` 排除资讯流/语音外围体验 | 建议不继承 | 音频生成成本、版权、TTS 凭据和隐私 | 冲突；`product/product.md:31`、`product/architecture.md:37` | 不继承 | 2026-08-08 / 本会话 AskQuestion cat7_integrations_automation | owner 明确播客不继承。 |
| CI-7.7 | 外部社区 issue 草拟与发布 | 成熟；`CommunityPanel.tsx`、`CommunityIssueDraftCard.tsx` 支持问题草拟、预览、决策队列与发布；已注册 community issue/config routes | 冲突；Cool 允许生成本地成果，但外部发布必须暂停等待 owner 审批，且无社区发布入口；`product/product.md:22,37` | 建议只继承“草拟+预览+显式审批”，不自动发布 | 外部仓库身份、内容泄漏、重复发布和撤销 | 冲突；`product/product.md:22,37`、`product/architecture.md:33,37-38` 要求外部发布审批与审计 | 不继承 | 2026-08-08 / 本会话 AskQuestion cat7_integrations_automation | owner 明确 GitHub/外部发布不继承。 |

## 8. 导出、回放、桌面形态与其他正式体验

类别确认完成: 2026-08-08 / 本会话 AskQuestion cat8_export_desktop

| ID | 名称 | Clowder 状态/证据 | Cool 状态/依据 | 建议 | 风险/依赖 | 安全影响/依据 | 决定 | owner确认日期/引用 | 决定理由 |
|---|---|---|---|---|---|---|---|---|---|
| CI-8.1 | 对话与项目数据导出 | 成熟；`ExportButton.tsx` 与已注册 `export.ts`、`thread-export.ts`、`debug-invocation-export.ts` | 缺失；Cool 无通用线程/项目数据导出入口，见附录 CC-P/CC-A | 建议只导出用户可见消息与元数据，不导出内部调试原始数据 | 脱敏、版本、范围和大文件策略 | 适用契约；不得导出隐藏思维链、凭据或原始 provider 响应，见 `product/architecture.md:37` | 继承 | 2026-08-08 / 本会话 AskQuestion cat8_export_desktop | recommended 明列脱敏审计/数据导出；禁止导出隐藏或敏感数据。 |
| CI-8.2 | 运行/Feature 轨迹时间轴 | 成熟；Workspace `trajectory` 页签、`TrajectoryPanel.tsx` 聚合 event-stream/git-ref/historical 数据并可跳回线程，已注册 `feat-trajectory.ts` | 部分；Cool 有执行/协作 TimelineEvents，但无跨任务运行轨迹检索面板；见 collaboration/execution 组件 | 建议基于 Cool 现有事件建立只读轨迹，不复制 Feature 编号模型 | 多源排序、重复事件、来源和大规模查询 | 适用契约；轨迹只能展示公开可审计事件，见 `product/product.md:23-24`、`product/architecture.md:25-27,37` | 继承 | 2026-08-08 / 本会话 AskQuestion cat8_export_desktop | recommended 明列运行轨迹，基于 Cool 可审计事件继承。 |
| CI-8.3 | Electron 桌面壳、托盘与自动更新 | 成熟；`desktop/main.js` 启停 API/Web/Redis、托盘、单实例和安全 IPC；`UpdateManager` 启动后定时检查、下载/跳过/稍后及升级恢复，README 说明 Windows/macOS 安装包 | 冲突；`product/product.md:35` 明确首版不做桌面安装器，Cool 为本地 Web | 建议将桌面壳与自动更新作为同一延后决定；实施时仍拆安全任务 | 安装签名、更新源、下载校验、子进程、IPC、凭据和跨平台差异 | 冲突；`product/product.md:35,37`、`product/architecture.md:9,37-38` | 延后 | 2026-08-08 / 本会话 AskQuestion cat8_export_desktop | owner 明确桌面安装器与自动更新延后。 |
| CI-8.4 | 本地只读故事回放 | 成熟；`/story/[storyId]`、`FeatureStoryView.tsx` 提供鸟瞰、剧场、消息显微三级只读回放；已注册 `story-rendering.ts` | 缺失；Cool 无本地 replay 页面/API，见附录 CC-P/CC-A | 建议先以执行/交付回放为目标，不复制 Clowder 剧场品牌表达 | 不可变版本、事件顺序与缺失数据 | 适用契约；仅展示可审计事实且不得泄漏敏感信息，见 `product/product.md:23-24`、`product/architecture.md:25-27,37` | 继承 | 2026-08-08 / 本会话 AskQuestion cat8_export_desktop | recommended 明列本地只读回放；只继承审计结果，不继承品牌 Story。 |
| CI-8.5 | 公开只读分享 | 部分成熟；`/story/[storyId]/public` 提供无需主应用外壳的只读查看，但不在主导航 | 缺失；Cool 无 public-share 页面/API，见附录 CC-P/CC-A | 建议与本地回放分开决定并延后到脱敏/撤销契约明确后 | 公共链接、访问控制、撤销、索引、脱敏和过期 | 适用契约；不得公开凭据、隐藏思维链、原始响应或工作区敏感数据，见 `product/product.md:22-24,37`、`product/architecture.md:37-38` | 延后 | 2026-08-08 / 本会话 AskQuestion cat8_export_desktop | owner 明确公开分享延后。 |
| CI-8.6 | 交付包与 Artifact 导出 | 部分成熟；Clowder 有 artifacts workspace 和通用 export route，但交付包边界分散 | 已有；Cool `components/review/delivery-panel.tsx`、Delivery/Artifact/Validation 已形成最终摘要与证据 | 已有保持；如增加下载只序列化最终交付版本 | Artifact 大小、文件边界、hash 和验证证据一致性 | 适用契约；`product/product.md:24`、`product/architecture.md:26-27,37` | 已有保持 | 2026-08-08 / 本会话 AskQuestion cat8_export_desktop | Cool 已有交付包/Artifact 保持；可下载脱敏导出由 CI-8.1 继承。 |
| CI-8.7 | 回放注释 | 成熟；`AnnotationOverlay.tsx`、`AnnotationEditor.tsx` 与已注册 `story-annotations.ts` 支持在回放时间点记录注释 | 缺失；Cool 无 replay annotation 契约，见附录 CC-A | 建议与只读回放分开决定；如继承需形成不可变来源关联 | 注释权限、编辑历史、时间点漂移和公开分享可见性 | 适用契约；注释写入需版本约束且不得改写原始事件，见 `product/architecture.md:25-27,38` | 延后 | 2026-08-08 / 本会话 AskQuestion cat8_export_desktop | recommended 只选择本地只读回放，写入式回放注释不在组合内，延后。 |
| CI-8.8 | 团队游戏模式 | 部分成熟；README 将 Werewolf 描述为已可玩、Pixel Brawl 为 demo，正式聊天挂载 `GameOverlayConnector`，已注册 `games.ts`、`game-actions.ts`；Roadmap 仍标整体 In Progress | 冲突；`product/product.md:31` 明确排除游戏外围体验 | 建议不继承；Pixel Brawl 仍只留排除附录 | 游戏状态机、滥用 LLM 成本、角色/品牌资产与产品焦点 | 冲突；`product/product.md:31,38`、`product/architecture.md:37` | 不继承 | 2026-08-08 / 本会话 AskQuestion cat8_export_desktop | owner 要求娱乐化能力保持排除，正式游戏结果不继承。 |
| CI-8.9 | 主动值班助手与悬浮入口 | 成熟；`ConciergeHost.tsx` 全局挂载 `ConciergePanel.tsx`，ActivityBar 可召回，Settings `concierge` 可配置主动性；已注册 `concierge.ts` | 冲突；`product/product.md:31` 排除社交人格养成等外围体验，Cool 也不设置隐藏总管 Agent | 建议不继承当前形态；如需主动提醒，应由可审计规则/事件触发而非人格助手 | 隐藏调度权、主动消息噪声、上下文泄漏与品牌角色耦合 | 冲突；`product/product.md:20,31,38`、`product/architecture.md:25,37-38` | 不继承 | 2026-08-08 / 本会话 AskQuestion cat8_export_desktop | recommended 未选择品牌人格/主动助手，且要求品牌 Story 保持排除。 |

## 附录 A：Clowder 22 个 App Router 页面逐入口映射

页面全集来自 `packages/web/src/app/**/page.tsx`。正式入口映射到目录 ID；退役重定向、开发/演示和纯品牌内容只进入排除项。正式游戏结果单列 CI-8.8，仍为 demo 的 Pixel Brawl 页面不因此升级。

| 页面入口 | 映射/排除 ID | 判定 |
|---|---|---|
| `/(chat)/page.tsx` | CI-1.5, CI-2.1~CI-2.17 | 正式首页；聊天内能力由组件/API 继续细分 |
| `/(chat)/thread/[threadId]/page.tsx` | CI-1.5, CI-2.1~CI-2.17 | 正式线程页；聊天内能力由组件/API 继续细分 |
| `/mission-hub/page.tsx` | CI-4.1~CI-4.7 | 正式 Mission 工作页 |
| `/mission/page.tsx` | EX-P01 | 退役别名，仅 redirect 到 `/mission-hub` |
| `/mission-control/page.tsx` | EX-P02 | 退役别名，仅 redirect 到 `/mission-hub` |
| `/memory/page.tsx` | CI-5.1 | 正式知识动态 |
| `/memory/search/page.tsx` | CI-5.1 | 正式搜索 |
| `/memory/status/page.tsx` | CI-5.2 | 正式索引状态 |
| `/memory/health/page.tsx` | CI-5.2 | 正式健康度 |
| `/memory/catalog/page.tsx` | CI-5.4 | 正式目录 |
| `/memory/graph/page.tsx` | CI-5.5 | 正式知识图谱 |
| `/signals/page.tsx` | CI-7.4 | 正式 Signals 收件箱 |
| `/signals/sources/page.tsx` | CI-7.4 | 正式信号源 |
| `/settings/page.tsx` | CI-1.3, CI-6.1~CI-6.13, CI-7.1~CI-7.3 | 正式设置入口 |
| `/story/[storyId]/page.tsx` | CI-8.4, CI-8.7 | 正式本地故事播放器与注释，但非主导航 |
| `/story/[storyId]/public/page.tsx` | CI-8.5 | 正式公开只读查看 |
| `/story-export/page.tsx` | EX-P03 | 品牌角色内容集锦，不进入能力清单 |
| `/story-export/grep-hippocampus/page.tsx` | EX-P04 | 品牌角色内容演示，不进入能力清单 |
| `/showcase/f11-review/page.tsx` | EX-P05 | showcase 演示页 |
| `/showcase/f052-cross-thread-author-label/page.tsx` | EX-P06 | showcase 演示页 |
| `/dev/memory-status-preview/page.tsx` | EX-P07 | 开发预览页 |
| `/pixel-brawl/page.tsx` | EX-P08 | README 明示为 demo，且含品牌角色资产；正式游戏模式另见 CI-8.8 |

## 附录 B：导航入口逐项映射

### B.1 ActivityBar

| 源码入口 | 映射/排除 ID |
|---|---|
| Chat `/`、`/thread/*` | CI-1.1, CI-2.1~CI-2.17 |
| Memory `/memory*` | CI-1.1, CI-5.1, CI-5.2 |
| Mission Hub `/mission*` | CI-1.1, CI-4.1~CI-4.3 |
| Signals `/signals*` | CI-1.1, CI-7.4 |
| Settings `/settings` 与固定分区 | CI-1.3 |
| ApprovalHub badge/button | CI-4.3 |
| ThemeMenu | CI-1.4 |
| ConciergeRailToggle | CI-8.9（只映射通用主动助手结果，不复制猫猫球品牌/资产） |
| PresentationRailToggle | EX-N02（演示浮窗，不是独立业务能力） |
| lazy `OklchTuner` | EX-N03（开发调色器） |

### B.2 MemoryNav、SignalNav、SettingsNav

- `MemoryNav.tsx`: `feed→CI-5.1`、`search→CI-5.1`、`status→CI-5.2`、`health→CI-5.2`、`catalog→CI-5.4`、`graph→CI-5.5`。
- `SignalNav.tsx`: `signals→CI-7.4`、`sources→CI-7.4`；类型中的 `chat` 没有生成导航项，记为 `EX-N04`（未接通声明）。
- `settings-nav-config.ts` 14 项: `members→CI-6.3`、`profiles→CI-6.3`、`accounts→CI-6.1/CI-6.8`、`im→CI-7.2`、`skills→CI-6.2`、`mcp→CI-6.4`、`plugins→CI-6.9`、`marketplace→CI-6.10`、`voice→CI-6.7`、`system→CI-6.5`、`rules→CI-6.5`、`notify→CI-7.1`、`ops→CI-3.4/CI-3.8/CI-6.6/CI-6.11~CI-6.13`、`concierge→CI-8.9`。
- `SettingsContent.tsx` 对上述 14 项均有正式内容分派；默认 placeholder 仅用于未知分区，不把不存在的分区列为能力。
- `components/settings/primitives/` 的 Card/Row/Field/Toolbar/Status/Action 等复用模式支撑 CI-1.3，不按组件拆成伪功能。

## 附录 C：API route 候选与 `index.ts` 注册核对

核对规则: `packages/api/src/routes/*.ts` 共 201 个候选；只有被 `routes/index.ts` 导出并由 `packages/api/src/index.ts` 注册，或被 `index.ts` 直接/动态导入后注册的入口，才作为正式 API 证据。helper、schema、未注册或仅被内部调用的文件统一给排除 ID。

### C.1 正式注册入口（逐文件映射）

- `CI-1.5`: `first-run-quest.ts`, `bootcamp.ts`。
- `CI-2.1`: `messages.ts`, `threads.ts`, `thread-member-strategy.ts`, `invocations.ts`。
- `CI-2.2`: `cats.ts`, `thread-cats.ts`, `message-actions.ts`, `session-chain.ts`, `session-handoff-approve-routes.ts`, `session-hooks.ts`, `session-strategy-config.ts`。
- `CI-2.3`: `proposal-routes.ts`, `dispatch-proposal-routes.ts`, `approval-hub-routes.ts`, `guide-action-routes.ts`, `profile-update-decision-routes.ts`, `frustration-issue-routes.ts`, `community-issue-draft-routes.ts`。
- `CI-2.4`: `thread-branch.ts`。
- `CI-2.5`: `threads.ts`。
- `CI-2.6`: `labels.ts`, `threads.ts`。
- `CI-2.7`: `threads.ts`。
- `CI-2.8`: `threads.ts`, `message-actions.ts`。
- `CI-2.9`: `queue.ts`。
- `CI-2.10`: `uploads.ts`, `messages.ts`。
- `CI-2.11`: `messages.ts`, `message-actions.ts`。
- `CI-2.13`: `messages.ts`, `thread-cats.ts`。
- `CI-2.14`: `votes.ts`。
- `CI-2.16`: `messages.ts`。
- `CI-2.17`: `message-actions.ts`。
- `CI-3.1`: `projects.ts`, `projects-setup.ts`, `projects-bootstrap.ts`, `projects-mkdir.ts`, `external-projects.ts`。
- `CI-3.2`: `workspace.ts`, `preview.ts`。
- `CI-3.3`: `authorization.ts`, `audit.ts`, `disable-impact.ts`, `brake.ts`。
- `CI-3.4`: `external-runtime-sessions.ts`, `session-transcript.ts`。
- `CI-3.5`: `workspace-edit.ts`, `workspace-git.ts`。
- `CI-3.6`: `terminal.ts`, `preview.ts`。
- `CI-3.7`: `session-chain.ts`, `events.ts`。
- `CI-3.8`: `audit.ts`, `events.ts`, `telemetry.ts`, `execution-digests.ts`, `session-transcript.ts`。
- `CI-4.1`: `tasks.ts`, `task-outcome.ts`, `backlog.ts`, `feature-doc-detail.ts`。
- `CI-4.2`: `intent-card-routes.ts`, `external-projects.ts`。
- `CI-4.3`: `proposal-routes.ts`, `dispatch-proposal-routes.ts`, `approval-hub-routes.ts`, `session-handoff-approve-routes.ts`。
- `CI-4.4`: `tasks.ts`, `backlog.ts`。
- `CI-4.5`: `resolution-routes.ts`, `slice-routes.ts`, `reflux-routes.ts`。
- `CI-4.6`: `workflow-sop.ts`, `governance-status.ts`。
- `CI-4.7`: `tasks.ts`, `dispatch-proposal-routes.ts`。
- `CI-5.1`: `memory.ts`, `knowledge-feed.ts`, `library.ts`。
- `CI-5.2`: `f163-admin.ts`, `f163-audit-routes.ts`, `recall-metrics.ts`, `tool-usage.ts`。
- `CI-5.3`: `memory.ts`, `evidence.ts`, `perspectives.ts`。
- `CI-5.4`: `library.ts`, `packs.ts`。
- `CI-5.5`: `library.ts`。
- `CI-5.6`: `dossier.ts`, `dossier-observations.ts`, `dossier-distillations.ts`, `distillation-opportunities.ts`, `distillation-routes.ts`, `reflect.ts`, `memory-publish.ts`, `summaries.ts`。
- `CI-6.1`: `accounts.ts`, `config-secrets.ts`, `services.ts`。
- `CI-6.2`: `skills.ts`, `skills-write.ts`, `skills-drift.ts`, `mount-rules.ts`, `drift.ts`。
- `CI-6.3`: `capabilities.ts`, `dossier.ts`, `avatars.ts`, `thread-member-strategy.ts`。
- `CI-6.4`: `capabilities.ts`, `mcp-drift.ts`。
- `CI-6.5`: `config.ts`, `rules.ts`, `prompt-injection.ts`, `prompt-injection-manifest.ts`, `prompt-injection-preview.ts`, `prompt-captures.ts`, `agent-hooks.ts`。
- `CI-6.6`: `system-status.ts`, `eval-hub.ts`, `tool-usage.ts`, `services.ts`。
- `CI-6.7`: `audio-proxy.ts`, `tts.ts`, `ref-audio-upload.ts`。
- `CI-6.8`: `accounts.ts`, `services.ts`, `capabilities.ts`。
- `CI-6.9`: `plugin-routes.ts`, `connector-plugins.ts`。
- `CI-6.10`: `marketplace.ts`。
- `CI-6.11`: `quota.ts`, `usage.ts`。
- `CI-6.12`: `commands.ts`, `claude-rescue.ts`。
- `CI-6.13`: `leaderboard.ts`, `leaderboard-events.ts`。
- `CI-7.1`: `push.ts`。
- `CI-7.2`: `callbacks.ts`, `callback-auth.ts`, `callback-auth-debug.ts`, `callback-docs-routes.ts`, `connector-hub.ts`, `connector-media.ts`, `connector-plugins.ts`, `connector-webhooks.ts`。
- `CI-7.3`: `schedule.ts`, `duty-briefing.ts`。
- `CI-7.4`: `signals.ts`, `signal-collection-routes.ts`。
- `CI-7.5`: `signal-study-routes.ts`。
- `CI-7.6`: `signal-podcast-routes.ts`。
- `CI-7.7`: `community-issue-draft-routes.ts`, `community-issues.ts`, `community-repo-config.ts`。
- `CI-8.1`: `export.ts`, `thread-export.ts`, `debug-invocation-export.ts`。
- `CI-8.2`: `feat-trajectory.ts`。
- `CI-8.4`: `story-rendering.ts`。
- `CI-8.5`: `story-rendering.ts`。
- `CI-8.6`: `export.ts`。
- `CI-8.7`: `story-annotations.ts`。
- `CI-8.8`: `games.ts`, `game-actions.ts`。
- `CI-8.9`: `concierge.ts`。
- 其他已注册、但只支撑上述能力且不单列伪功能: `world.ts→CI-2.2/CI-4.1`, `callbacks.ts→CI-7.2`, `story-export.ts→EX-A02`, `limb-node-routes.ts→EX-A04`, `plugin-routes.ts→CI-6.9`, `ref-audio-upload.ts→CI-6.7`, `connector-media.ts→CI-7.2`, `community-repo-config.ts|community-issues.ts→CI-4.2/CI-7.7`。

### C.2 未注册、helper/schema 或排除能力候选（逐文件排除）

- `EX-A00`（聚合索引，不是 route）: `index.ts`。
- `EX-A01`（游戏内部拦截 helper；正式游戏结果见 CI-8.8）: `game-command-interceptor.ts`。
- `EX-A02`（品牌故事导出）: `story-export.ts`。
- `EX-A03`（主动助手内部 hold-ball helper；正式结果见 CI-8.9）: `hold-ball-source.ts`, `hold-ball-cancel.ts`, `wake-delay-bucket.ts`。
- `EX-A04`（隐藏多节点后端，无正式用户入口）: `limb-node-routes.ts`。
- `EX-A05`（API 内部 helper/schema；不独立注册）: `anchor-adoption-rollup.ts`, `anchor-event-log.ts`, `anchor-telemetry.ts`, `backlog-doc-import.ts`, `callback-a2a-trigger.ts`, `callback-anchor-helpers.ts`, `callback-auth-prehandler.ts`, `callback-auth-schema.ts`, `callback-auth-system-message.ts`, `callback-auth-telemetry.ts`, `callback-bootcamp-routes.ts`, `callback-document-routes.ts`, `callback-errors.ts`, `callback-game-routes.ts`, `callback-guide-routes.ts`, `callback-hold-ball-c1-emit.ts`, `callback-hold-ball-cancel-routes.ts`, `callback-hold-ball-routes.ts`, `callback-lark-action-routes.ts`, `callback-limb-routes.ts`, `callback-memory-routes.ts`, `callback-multi-mention-routes.ts`, `callback-propose-profile-update-routes.ts`, `callback-propose-session-handoff-routes.ts`, `callback-propose-thread-routes.ts`, `callback-quest-routes.ts`, `callback-runtime-session-routes.ts`, `callback-scope-helpers.ts`, `callback-task-routes.ts`, `callback-thread-cats-routes.ts`, `callback-wecom-action-routes.ts`, `callback-workflow-sop-routes.ts`, `capabilities-mcp-write.ts`, `community-decision-queue-read-model.ts`, `community-decision-queue.ts`, `config-cat-order.ts`, `connector-plugin-routes.ts`, `connector-route-helpers.ts`, `cross-thread-affordance.ts`, `evidence-helpers.ts`, `feat-index-doc-import.ts`, `gate-keeping-cross-store.ts`, `gate-keeping-guard.ts`, `git-doc-reader.ts`, `hold-ball-source.ts`, `image-upload.ts`, `mcp-probe.ts`, `messages.schema.ts`, `parse-multipart.ts`, `profile-update-card-block.ts`, `prompt-injection-hooks.ts`, `proposal-approve-dispatch.ts`, `proposal-approve-overrides.ts`, `proposal-card-block.ts`, `proposal-enrich-header.ts`, `proposal-stale-recovery.ts`, `push-route-helpers.ts`, `schedule-governance.ts`, `services-lifecycle-audit-routes.ts`, `services-lifecycle-helpers.ts`, `services-lifecycle-lock.ts`, `services-lifecycle-port.ts`, `services-lifecycle-routes.ts`, `thread-cats-core.ts`, `user-mention.ts`。
- `EX-A06`（存在文件但 `packages/api/src/index.ts` 无注册调用）: `callback-lark-action-routes.ts`, `callback-wecom-action-routes.ts`, `connector-plugin-routes.ts`, `cross-thread-affordance.ts`, `feat-index-doc-import.ts`, `image-upload.ts`, `mcp-probe.ts`, `proposal-stale-recovery.ts`, `schedule-governance.ts`, `services-lifecycle-routes.ts`, `user-mention.ts`。

说明: C.2 中 helper 可能被正式 route 内部调用，但不会因此成为独立用户能力；若同一文件同时符合 helper 与未注册，保留更具体的 `EX-A06` 语义。C.1 的 route 只证明后端已注册，必须与页面/导航或正式设置内容共同判断成熟度，不能把隐藏后端提升为正式条目。

## 附录 D：现行设计规范与 token 入口

| 入口 | 映射/排除 ID | 依据 |
|---|---|---|
| `docs/design/console-design-system.md` | CI-1.1, CI-1.2, CI-1.3 | 现行组件和 `console-*` class/token 直接消费 |
| `packages/web/src/app/theme-tokens.css` | CI-1.2, CI-1.4 | light/dark、四级 surface、语义色、阴影被现行外壳消费 |
| `packages/web/src/app/console-tokens.css` | CI-1.2 | console 语义 alias 被 `console-shell.css` 和组件消费 |
| `packages/web/src/app/console-shell.css` | CI-1.1, CI-1.2 | 现行 `.console-*` 外壳、卡片、导航、状态规则 |
| `packages/web/src/components/settings/primitives/` | CI-1.3 | 现行 Settings Card/Row/Field/Toolbar/Status/Action 复用层；属于设置体验实现支撑，不拆成独立能力 |
| `docs/design-system.md` | EX-D01 | 含旧 Cat Café 品牌、固定角色与资产规范；只可识别通用可访问性意图，不得复制角色/品牌/资产 |
| `docs/design/clowder-ai-brand.md` | EX-D02 | 纯品牌规范 |
| `docs/design/naming-contract.md` | EX-D03 | 品牌/命名契约，不属于待继承用户能力 |
| `docs/design/hero-prism-motion.md` | EX-D04 | 品牌 Hero 动效；非现行应用工作流能力 |
| `docs/design/F090-pixel-cat-brawl-visuals.md` | EX-D05 | 游戏视觉资产 |

Cool 对照: `app/tokens.css`、`app/cockpit.css`、`features/008-ui-design-refresh/plan.md`、`reviews/code-review.md` 和 `reviews/demo-acceptance.md` 已证明 CI-1.2 在 Cool 中为已有；仅保留“层级、密度、语义状态、token、可访问性”原则，不复制 Clowder 色值、角色或资产。

## 附录 E：Cool 入口核对与状态合规

- `CC-P`: Cool App Router 页面共 3 个：`app/page.tsx`、`app/team/page.tsx`、`app/projects/[projectId]/[[...resource]]/page.tsx`。
- `CC-A`: Cool App Router API 共 56 个 `route.ts`，覆盖 projects、workspace、members、missions、work-items、runs、messages、decisions、executions、validation、approvals、staged changes、merge、recovery、review、memory、delivery、providers、skills、agents；未发现 theme、onboarding、独立 thread/queue/steer、附件、reply-to、输入历史、私语、投票、thread branch/search/label/favorite/trash、原生 CLI adapter、MCP/plugin/marketplace、push、connector、schedule、signal、trajectory、story replay/public share、game、concierge 或 desktop/update 入口。
- `已有`: 必须引用 Cool 实现路径；本目录的已有项均已引用组件/API/产品决定。
- `部分`: 必须引用已实现子集和明确缺口；本目录的部分项均同时给出实现路径和缺口。
- `缺失`: 必须引用 `CC-P/CC-A` 入口全集核对；本目录缺失项均如此处理。
- `冲突`: 必须引用 `product/product.md`、`product/decisions.md` 或 `product/architecture.md` 的边界；本目录冲突项均给出具体依据。

## T-2/T-3 自查结论

- 8/8 类均有正式条目、完整条目契约和 `2026-08-08 / 本会话 AskQuestion <cat id>` 类别确认。
- 正式条目由首轮 32 项细化为 72 项；保留原稳定 ID，并为可独立决定的用户结果追加新 ID。
- 22/22 个 Clowder 页面均映射到正式 ID 或排除 ID。
- `ActivityBar`、`MemoryNav`、`SignalNav`、`SettingsNav`、`settings-nav-config.ts` 的全部生成入口均已映射或排除。
- API 候选以 `routes/index.ts` + `packages/api/src/index.ts` 注册为正式性门槛；注册 route 映射到业务 ID，helper/未注册/品牌外围映射到排除 ID。
- 现行设计规范/token 与旧品牌/游戏/动效规范已分开映射。
- 粒度复核已把聊天队列/steer、附件、回复引用、输入历史、onboarding、私语、投票、线程搜索/标签/收藏/回收站、原生 CLI、MCP/插件/市场、运行轨迹、本地回放、公开分享拆为独立决定；另按安全/依赖差异拆分工作区读/写/运行、Mission 治理、记忆管理、运维、Signals、外部发布、游戏与主动助手。
- 72/72 个正式条目均有唯一合法决定、非空理由和对应类别的 owner 确认引用；未留未确认占位。
- 未复制 Clowder 品牌、角色、文案、资产或源码；未修改 product 层。

## 附录 F：获批继承项实施切片覆盖索引

本索引只覆盖最终决定为“继承”的 42 项。`已有保持` 11 项不重复实现，`延后` 9 项和`不继承` 10 项不进入未完成 backlog。每个切片均在 `product/backlog.md` 中声明用户可见演示判据、依赖、品牌/源码/资产禁用边界，以及工作区、verified-handle、sandbox、凭据、审批、独立复核和审计的适用性。高风险能力均排在基础能力之后并拆为独立安全切片。

| 获批 ID | 实施切片 | 覆盖的独立用户结果 |
|---|---|---|
| CI-1.3 | S-9 | 设置导航、检索、深链与固定入口 |
| CI-1.4 | S-10 | Cool 自有亮暗主题 |
| CI-1.5 | S-11 | 可跳过、恢复和重试的渐进式首次使用引导 |
| CI-2.1 | S-12 | 项目内持久线程与上下文续接 |
| CI-2.3 | S-13 | 结构化消息块与就地决策 |
| CI-2.5 | S-17 | 项目内线程搜索与定位 |
| CI-2.6 | S-18 | 线程标签与批量整理 |
| CI-2.7 | S-19 | 线程收藏与稳定排序 |
| CI-2.8 | S-20 | 线程回收站、恢复和强确认永久删除 |
| CI-2.9 | S-21 | 可观察消息队列、重排与 Steer |
| CI-2.10 | S-16 | 严格校验的项目聊天图片附件 |
| CI-2.11 | S-14 | 回复引用与精确来源跳转 |
| CI-2.12 | S-15 | 按线程草稿恢复、输入历史与清除 |
| CI-3.2 | S-22 | verified-handle 守护的绑定工作区只读浏览 |
| CI-3.4 | S-46 | 受控外部运行会话生命周期 |
| CI-3.5 | S-42 | sandbox、审批和 MergeJournal 内的编辑/Git 合入 |
| CI-3.6 | S-43 | 策略内 Web 终端与本地浏览器预览 |
| CI-3.8 | S-23 | 统一、脱敏且可定位来源的审计浏览器 |
| CI-4.3 | S-24 | 跨域统一审批中心 |
| CI-4.4 | S-25 | Mission 依赖与阻塞全景 |
| CI-4.6 | S-26 | 以真实事实源驱动的 SOP/流程状态 |
| CI-4.7 | S-27 | 任务租约、心跳、回收与派发可见性 |
| CI-5.1 | S-28 | 项目知识动态、记忆检索与来源定位 |
| CI-5.2 | S-29 | 记忆索引状态、健康诊断与安全修复 |
| CI-5.4 | S-30 | 项目知识目录与集合管理 |
| CI-5.5 | S-31 | 来源可追溯知识图谱及可访问替代视图 |
| CI-5.6 | S-32 | 真实 Agent 署名、带来源的提炼与发布 |
| CI-6.3 | S-33 | 不自动扩权的可解释能力画像与路由建议 |
| CI-6.4 | S-47 | 受控 MCP 服务、作用域、工具权限与漂移管理 |
| CI-6.5 | S-34 | 可审计规则配置与提示注入检查 |
| CI-6.6 | S-35 | 真实服务健康与可观察性中心 |
| CI-6.7 | S-50 | 默认关闭、显式同意的隐私安全语音能力 |
| CI-6.8 | S-45 | 隔离的原生 Agent CLI/ACP Provider；后续每个 adapter 另起切片 |
| CI-6.9 | S-48 | 已安装插件的安全启停、配置、卸载与回滚 |
| CI-6.10 | S-49 | 能力市场搜索、签名/权限预览、安装计划与回滚 |
| CI-6.11 | S-36 | 基础用量、预算和配额边界看板 |
| CI-6.12 | S-44 | 精确许可、可审计的领域化运维救援 |
| CI-6.13 | S-37 | 不改变平等协作和复核规则的贡献证据视图 |
| CI-7.1 | S-41 | 最小权限浏览器通知与 PWA 降级 |
| CI-8.1 | S-38 | 范围明确且强制脱敏的数据导出 |
| CI-8.2 | S-39 | 跨任务公开运行轨迹与来源导航 |
| CI-8.4 | S-40 | 不重放动作的本地只读交付回放 |

### F.1 T-5 机械核对口径

- 新切片编号必须从现有 S-8 后连续为 S-9~S-50，且未完成切片恰为 42 个。
- 上表 ID 集合必须与正文中 `决定=继承` 的 42 个 ID 全等；每个 ID 至少映射一个新切片且无 `已有保持|延后|不继承` ID。
- 每个新切片必须同时含获批 `CI-*`、`依赖`、`演示判据`、七项约束标记及“不复制 Clowder 品牌、源码…资产”。
- CI-3.5、CI-3.6、CI-6.4、CI-6.7、CI-6.8、CI-6.9、CI-6.10 必须是独立的“高风险安全切片”，编号晚于基础能力切片。
- 外部 IM/连接器、Signals/研读/播客、daemon/定时自动化、桌面壳/自动更新和公开分享不得出现在未完成 backlog。
