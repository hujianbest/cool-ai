# 开发进展

- 范围: 产品层（七份关键文档 + 决策/假设附录）
- 当前阶段: ready
- 执行模式: auto
- 已加载扩展: 无
- 当前主切片: 无
- 下一步: 规划中仅余 S-45 族与 S-50（高风险）；不进入。

## 当前快照（2026-08-18）

| 项 | 状态 |
|---|---|
| 产品文档 | 七件套：规格 / 词汇表 / 架构 / 特性分解 / 开发计划 / 进展 / UI 设计 |
| P0 暖金壳层 | 051/S-61 已 ship：T-01～T-06 在目标 Windows x64 收口，tsc/build 绿，全量 2790/2791，`npm run smoke` 绿 |
| P1 阶段 1 驾驶舱 | 050/S-60 已 ship：原生选夹、三名自带 Agent、聊天优先、GET `/api/home` 只读 |
| P2–P5 既有切片 | 计划中列出的会话/整理/执行/知识核心能力已 ship；规划中加厚项见特性分解清单 |
| 环境/IA 残留 | `review-browser-full-chain` 因 UCD §9.5 未挂载（A-387）；`smoke:onboarding` 引导按钮被时间线条目挡住；`smoke:context` 桌面主路径等待已卸下的工作区绑定条（A-401）；`smoke:execution` P1 IA + 既有 color-contrast（A-412） |
| 未交付高风险切片 | S-42、S-43、S-35、S-44、S-36、S-37、S-38、S-40、S-30、S-31、S-32、S-34 已 ship；高风险为 S-45 族与 S-50 |

## 状态记录

- 2026-08-09 产品定义与目标架构经用户确认（`product/product.md`、`product/architecture.md` 确认行）；产品架构 Standards/Spec 评审第 6 轮通过。
- 2026-08-09 架构收敛完成（特性 019，PR #1），用户确认解除架构优先冻结（D-45）。
- 2026-08-09 按 hf-to-product-architecture 刷新产品架构：第 8 节现状证据更新为收敛后现实，第 9 节压缩为收敛完成记录，新增第 11 节关键场景与第 12 节横切约定；backlog 证据路径同步修正。本次为已确认架构的落盘完善，项目级 review 豁免（AGENTS.md 当前开发阶段条款，2026-08-09）：不伪造评审工件；架构实质决策（D-36～D-45）不变。
- 2026-08-10 按 hf-to-product-architecture 补全产品架构：第 2 节十个子系统补「封住的易变性」声明，第 11 节五条关键场景标注验证特征（AC-1～AC-5），新增第 13 节架构特征（驱动力，各配质量属性场景）与第 14 节演进与适应度（演进路径、适应度函数、量化复核触发）；编辑性默认记录 A-106。本次为已确认架构的落盘补全，项目级 review 豁免（AGENTS.md 当前开发阶段条款，2026-08-09）：不伪造评审工件；架构实质决策（D-36～D-45、ADR-0002～0004）不变，新增节待用户确认。
- 2026-08-10 应用户问询显式标注 4+1 视图裁剪：第 2～3 节=逻辑视图、第 7 节=开发视图、第 11 节=场景视图；过程视图并入第 3、4 节协议与不变量，物理视图因部署拓扑非硬约束省略（A-107）；若未来并发/部署成为硬约束，按技能规则补视图并记 ADR。
- 2026-08-10 用户确认第 13 节架构特征、第 14 节演进与适应度及 4+1 视图标注（确认行已写入 `product/architecture.md` 头部），产品架构补全闭环。
- 2026-08-12 应用户指示，035/S-51 整体 UI 改版（DESIGN.md 设计基座 + 应用壳层）已立项并追加到既有切片之后排队（A-238）；当前阶段 grill-with-docs，未并行实现，避免冲突。
- 2026-08-12 035/S-51 完成 implement 与 ship：DESIGN.md (Apple 设计系统) 作为产品级设计契约落盘，tokens.css 完全映射核心 token，亮暗双套投影完成，应用壳层按新 token 收敛，preview.html/preview-dark.html 设计目录页创建，视觉契约测试 29/29 通过，typecheck 与 build 成功；所有任务票 T-01～T-05 勾选完成。
- 2026-08-12 036/S-52 Project&Workspace 审计事件纵切（AUD-PWS）完成 implement 与 ship：schema identity 21→22、`audit_event_outbox.source` 加 `'project_workspace'`，projects/workspace/membership/validation-policy 四处写入点同事务 outbox，宿主路径末段目录名 + 凭据分类双闸 fail-closed 脱敏，审计 UI 项目域徽标/文案/「定位来源项目」，smoke:context 验收 104 断言 + axe 3 态 0 serious/critical，全量 277 文件 2542 用例全绿、build 绿；推送集成时发现与并行 UI 改版切片 035/S-51 双占，按 A-256 改号假设并在 backlog 双侧消歧。
- 2026-08-14 用户指示继续 `product/ui` 并以 case 为布局/颜色目标；立项 038/S-54 暖陶工作台驾驶舱（grill-with-docs）。037/S-53 AUD-GOV 暂停于 T-02。
- 2026-08-14 038/S-54 完成 implement 与 ship：暖陶 DESIGN.md 替换 Apple 蓝、桌面四列 56/236/1fr/304、左对话/中群聊/右看板 chrome 对齐 case、preview 暖陶目录；`npm test` 2577、build、smoke:context 与 cockpit smoke 绿；演示 auto-approved（A-263）。037/S-53 仍暂停于 T-02。
- 2026-08-14 用户指示打开本地文件夹即项目（对齐 Codex/Cursor），立项 039/S-55；037 继续暂停。
- 2026-08-14 用户改口：未选项目时中间默认单 Agent 聊天。039 暂停于 T-01；立项 040/S-56。
- 2026-08-15 用户澄清两条路径都要：打开本地文件夹作为项目，同时支持不选项目直接 1:1 聊天（A-285）。039/S-55 与 040/S-56 均已 ship；`npx vitest run` 284/2598、`npm run smoke`、`smoke:onboarding`、build 绿。037 仍暂停于 T-02。
- 2026-08-14 用户指示「按建议优化」后完成流程规则修订（非特性交付）：(1) 评审策略由「全部豁免」改为选择性评审——恢复 `hf-code-review` 代码门于 schema 变更/安全边界/跨 owner 写/>8 票切片，spec/architecture/hf-review 与纯 UI/机械/文档切片继续豁免（AGENTS.md + hf-workflow + hf-implement + hf-ship 同步，A-286）；(2) 机械性改动豁免行为性 RED（AGENTS.md TDD 节 + hf-tdd，A-287）；(3) 轻量级切片路径：≤3 票且无 schema/安全/跨 owner 写切片合并 spec+architecture 为一页、跳过 to-tickets（AGENTS.md + hf-to-spec/to-architecture/to-tickets，A-288）；(4) subagent 时间预算按切片类型浮动，UI/验收类 45～60 分钟（AGENTS.md，A-289）；(5) hf-code-review 双轴输出上限由 400 字改为按严重级别配额（严重项不设限、总 600 字内）。全部规则变更已落盘并记录假设，未触碰任何产品代码。
- 2026-08-15 037/S-53 Governance 审计事件纵切（AUD-GOV）完成 implement 与 ship：schema identity 23、Governance 五类 Approval 生命周期同事务脱敏 outbox、审计面板治理徽标/摘要/规范 approval 定位；`smoke:execution` 31 断言 + axe 3 态 0 serious/critical（真实 requested/approved/consumed/expired，rejected 由 T-01 证明）、全量 284 文件/2602 用例、tsc/build 全绿；演示 auto-approved。`CAP-GOV-03` 已交付核心；S-23 仍待 AUD-RUN 与 AUD-UI。
- 2026-08-15 041/S-57 Runtime 审计事件纵切（AUD-RUN）完成 implement 与 ship：schema identity 24、`callOpenAiChat` 成败同事务脱敏 outbox、审计面板运行时徽标/摘要/规范定位；独立 hf-code-review 初审需修改后复审通过；`smoke:execution` Runtime 20 断言 + axe 2 态；全量 285 文件/2617 用例 127.52s；`CAP-RUN-07` 已交付核心。S-23 仍待 AUD-UI。
- 2026-08-15 042/S-58 统一审计浏览器按域筛选（AUD-UI）完成 implement 与 ship：审计面板「全部/执行/协作/任务/项目/治理/运行时」客户端筛选；轻量级纯 UI，hf-code-review 豁免；`smoke:execution` Runtime 23 断言 + axe 2 态；S-23 子片全部交付并汇总勾选。时间轴仍待 S-39。
- 2026-08-15 043/S-26 SOP 状态投影立项并进入 implement（A-302～A-308）；阻塞项已交付。
- 2026-08-15 043/S-26 可审计 SOP 与流程状态完成 implement 与 ship：零 schema 来源化投影、GET `/sop-state`、看板「流程状态」；`smoke:context` SOP 8 断言；hf-code-review 复审 PASS；`CAP-MWK-03` 已交付核心。
- 2026-08-15 044/S-27 任务租约与派发控制面完成 implement 与 ship：schema identity 24→25，claim/heartbeat/release/reclaim 与看板租约；`smoke:context` 5 断言；hf-code-review 复审 PASS；全量 289/2652 126.51s；`CAP-MWK-04` 已交付核心。
- 2026-08-15 045/S-28 项目知识动态与记忆检索完成 implement 与 ship：零 schema `searchMemories` + GET `/memories/search` + 共享记忆检索 UI；`smoke:context` 3 断言；全量 291/2685 122.39s；hf-code-review 豁免；`CAP-KNW-02` 检索核心已交付。
- 2026-08-15 046/S-33 可解释 Agent 能力画像与路由建议进入 implement（轻量级零 schema；A-321～A-326）。
- 2026-08-15 046/S-33 可解释 Agent 能力画像与路由建议完成 implement 与 ship：只读 GET + 看板画像/建议；`smoke:context` 4 断言；全量 293/2693 124.66s；hf-code-review 豁免；`CAP-IDC-03` 画像核心已交付。
- 2026-08-15 047/S-39 跨任务运行轨迹时间轴进入 implement（轻量级零 schema；A-327～A-332）。
- 2026-08-15 047/S-39 跨任务运行轨迹时间轴完成 implement 与 ship：GET `/timeline` + 审计面板时间轴；`smoke:execution` 160 断言；全量 295/2722 125.45s；hf-code-review 豁免；`CAP-OPS-02` 时间轴已交付。
- 2026-08-15 048/S-41 最小权限浏览器通知与 PWA 进入 implement（A-334～A-339）。
- 2026-08-15 048/S-41 最小权限浏览器通知与 PWA 完成 implement 与 ship：本机 Notification + PWA manifest；hf-code-review 复审 PASS；全量 298/2736 131.14s；`CAP-RUN-05` 已交付核心。
- 2026-08-15 用户否定 049 HelpTip/手输路径，要求按第一性原理分阶段上线并完成阶段 1（原生选夹、自带 Agent、聊天优先、使命/记忆不在前端）。049/S-59 superseded；立项 050/S-60（见 `product/development-plan.md`、D-49）。
- 2026-08-15 用户确认全局 UI 方向（暖米 + 暖金、治理收进图标轨、DESIGN.md 先行）并立项 051/S-61（见 `features/051-warm-gold-cockpit/progress.md`）。
- 2026-08-15 用户指示基于最新交付顺序系统重写产品设计文档与交付计划：新建 `product/development-plan.md`（P0–P5 交付顺序单一事实源，含每切片前后端拆分与验收）；重写 `product/phases.md` 为发布阶段摘要；`product/product.md` 增补「开发与交付方式」（API 契约先行、先闭环再变厚、治理收轨）；`AGENTS.md` 新增「新上下文开始开发先读 product/development-plan.md」硬规则。051/S-61 暂停等待 P0 计划恢复。
- 2026-08-15 按计划执行 P0（051/S-61）：52px 图标轨（治理入口 + 按需视图）、240px 会话侧栏、桌面 header 与居中聊天流、欢迎空态、亮/暗暖金令牌全部落地；`tsc`/`build`/聚焦测试/真实渲染验证通过，视觉契约 25/25。P1–P5 为既有 ship 切片，随 P0 壳层做表面集成与回归核对（见 `features/051-warm-gold-cockpit/progress.md`）。
- 2026-08-15 P0–P5 按 `product/development-plan.md` 处理：P0 壳层实现完成（见 051）；P1–P5 逐阶段核对既有 ship 切片与壳层集成（治理收轨、聊天主路径、审计/记忆/审批/任务按需视图），浏览器目录 646/656 仅剩环境性失败；全量 2587/2719，失败全部归因为 macOS 平台不适用与沙箱端口限制，非本次改动回归。P0 收尾（目标环境全量绿 + 冒烟 + demo 验收）留待环境就绪。
- 2026-08-15 用户指示整理 product 目录：六份关键文档落盘为产品规格说明书 / 产品架构设计说明书 / 特性分解清单 / 开发计划 / 开发进展 / UI 设计；`phases.md` 并入开发计划并改为重定向；独立 Gemini agent 产出 UCD（`product/ui/UI设计.md`）；路径名保持稳定以免打断架构测试与历史引用（D-51）。同日确认不保留 `product/reviews/`。
- 2026-08-16 补齐 DDD 统一语言：新增 [`词汇表.md`](./词汇表.md) 为第七份关键文档；架构说明书追加第 15 节限界上下文 / 子域 / 上下文地图 / 聚合目录（D-52）。不另写事件风暴墙或逐上下文 Canvas。
- 2026-08-16 对照 Pi / DeepSeek Harness / ChatGPT / Codex / OpenClaw 刷新词汇表：公开协作容器改称 **对话（Session）**，停用产品文案「线程」；Turn 对齐为交还 owner 前的回合（D-53）。
- 2026-08-16 D-53 术语落盘（机械性文案豁免，A-287）：components 六组件、src 两处注释、README.zh-CN.md、docs/ 五文件、CONTEXT.md 术语定义的用户可见「线程→对话」「群聊→对话」替换完成；tests 断言与 tests/browser/*.mjs 冒烟脚本断言同步（仅字符串，未弱化断言）；代码标识（Thread/threadId、文件名、/threads 路径）按词汇表 §244 不重命名。验证：build 绿、public-collaboration + operations-projection + shared 模块测试绿。遗留：2 个壳层测试（persistent-thread-list-ui / thread-policy-ui）与 4 条冒烟的失败为 P0 壳层重构旧 DOM 断言（Cursor 并行改动所致基线问题），并入 S-61 T-06 收尾修复，非本次术语改动回归。
- 2026-08-16 产品开发以 UCD 为基准写入 `AGENTS.md`；P0/051 图标轨按 UCD §7.1 收口为对话/任务/记忆/审批/审计 + 团队/设置/主题，首次使用引导改到大厅空状态。
- 2026-08-16 按 UCD §8.4 / §8.7 落地返回对话：项目页「对话」留在当前项目；治理视图支持 `ESC` 与 `Cmd/Ctrl+1` 回对话、`Cmd/Ctrl+2–5` 打开任务/记忆/审批/审计。聚焦测试 29/29，`build` 绿。
- 2026-08-16 按 UCD §8.1 落地图标轨选中态：左侧 3px 暖金垂直指示条（`--rail-indicator-width` / `--rail-indicator-radius`），`DESIGN.md` 与 UCD 对齐。聚焦测试 20/20，`build` 绿。
- 2026-08-16 按 UCD §7.1 / §14.2 落地 Needs Me：待处理审批时 Header 暖金徽标与图标轨「审批」红点同时亮起，点击徽标打开审批中心。聚焦测试 53/53，`build` 绿。
- 2026-08-16 按 UCD §9.1.5 收口会话侧栏：全部/收藏/标签 Tab、底部回收站、「新对话」与 `Cmd/Ctrl+N`。聚焦测试 44/44，`build` 绿。
- 2026-08-16 按 UCD §8.7 落地 `Cmd/Ctrl+O` 调起系统文件夹选择器。cockpit-layout 9/9。
- 2026-08-16 按 UCD §8.6 落地 Composer：`Enter` 发送、`Shift+Enter` 换行、键入 `@` 补全 Agent。collaboration-chat 8/8，`build` 绿。
- 2026-08-16 按 UCD §7.1 / §9.1.2 落地 Header 语境：`未选择项目 · 个人对话` 或 `[项目名] · [对话标题]`。cockpit-layout 10/10。
- 2026-08-16 按 UCD §8.1 / §9.1.5 落地对话列表选中态：左侧 3px 暖金条 + `--color-surface-pearl` 底 + 字重 600；`AGENTS.md` 写入前端必须在真实浏览器核对。聚焦测试 54/54。
- 2026-08-16 按 UCD §7.1 收口会话侧栏只留「对话」：桌面侧栏不再列出文件夹项目；打开/切换项目只走 Header「打开文件夹」。聚焦测试与 `build` 绿。
- 2026-08-16 按 UCD §7.1 / §9.1.4 / §9.1.5 收口主路径壳层视觉：Header 固定 48px、「打开文件夹」带文件夹图标胶囊；浮起 Composer（左 `+`、自适应输入、右暖金发送箭头，placeholder 对齐 UCD）；侧栏头仅「对话」+「+」，搜索改 `Cmd/Ctrl+K` 呼出，对话项展示相对时间。真实浏览器核对。聚焦测试 146/146，`build` 绿。遗留：消息流仍为协作事实卡片，尚未改为 UCD 头像气泡。
- 2026-08-16 用户切换 auto。按 UCD §9.1.2 / §9.1.3 落地消息流头像气泡（Owner 暖金头像 + pearl 气泡；系统事实安静行）。演示 auto-approved 2026-08-16。
- 2026-08-16 主路径聊天区耗尽分页后「已加载全部事实」改为 `sr-only`，不再占用可见 chrome。演示 auto-approved 2026-08-16。
- 2026-08-16 消息「回复」改为悬停/焦点显现，空闲态与 UCD 原型一致。演示 auto-approved 2026-08-16。
- 2026-08-16 `Cmd/Ctrl+K` 呼出居中会话搜索浮层（UCD §9.6.1）。演示 auto-approved 2026-08-16。
- 2026-08-17 用户指示按 UCD 开发完后进入长任务。治理视图收口全宽顶栏（`← 返回对话`、无「治理视图」eyebrow、标题 `任务看板 · 项目` 等）、泳道计数与 pearl 任务卡；内层重复 h2 改为 `sr-only`。文案对齐：新建任务 / 沉淀新记忆 / 批准执行 / 驳回。localhost:3002 对照 `preview-ucd.html` 核对任务/记忆/审批空态。长任务已关 050 HelpTip 与 GET `/api/home` 的 Identity ensure 写。未伪造 TTL/Diff/Thinking/迷你头像（A-371～A-375）。演示 auto-approved 2026-08-17。
- 2026-08-17 拉取 `ffe659b` 后继续长任务：引导「查看已受理使命」打开任务治理视图（A-378）；`GET /api/home` 只读，`POST /api/home` 幂等确保个人对话（A-377）。跨 owner 分事务按 A-376 保持三步编排。聚焦 home.api / direct-project / home-direct-chat 17、onboarding T-1 绿。演示 auto-approved 2026-08-17。
- 2026-08-18 按 UCD §9.1.5 落地会话项「更多」菜单（打标进批量整理、移入回收站；不展示重命名 A-379）。聚焦线程列表/回收站/标签 46/46，`tsc` 绿。演示 auto-approved 2026-08-18。
- 2026-08-18 按 UCD §9.1.1 收口欢迎卡：「欢迎使用 Cool AI」+ 打开文件夹/1:1 直聊。collaboration-chat / cockpit-layout 21/21。演示 auto-approved 2026-08-18。
- 2026-08-18 Composer 占位对齐 UCD：1:1「与助手直接对话」；项目「@ 提及 Agent 发起协作」。Enter 仍走既有发送键，不写进占位。collaboration-chat + placeholder 契约 9/9。演示 auto-approved 2026-08-18。
- 2026-08-18 按 UCD §9.1.4 落地空 Composer `↑` 打开输入历史；有草稿不拦截。可见「历史」按钮保留（A-373/A-382）。input-history 8/8。演示 auto-approved 2026-08-18。
- 2026-08-18 按 UCD §9.1.1 落地消息「复制」：Owner/Agent 气泡悬停复制纯文本，成功显示「已复制」。不引入 Markdown（A-383）。collaboration-chat 9/9。演示 auto-approved 2026-08-18。
- 2026-08-18 按 UCD §9.1.2 落地 Proposal 焦点内 `A` 批准 / `R` 驳回（A-384）。structured-decision 12/12。演示 auto-approved 2026-08-18。
- 2026-08-18 按 UCD §9.1.1 落地闭合围栏代码块与块内复制；无高亮、无其余 Markdown（A-385）。collaboration-chat 10/10。演示 auto-approved 2026-08-18。
- 2026-08-18 051 T-06 在目标 Windows x64（Node 24.14 / npm 11.9）收口：`tsc`/`build` 绿；全量 303/304 文件、2790/2791；`npm run smoke` 绿（A-386）。团队编辑器改为 `modal-surface`；Composer textarea 去掉非法 combobox ARIA。残留：`review-browser-full-chain`（A-387）、`smoke:onboarding` 引导钮被时间线挡住。演示 auto-approved。
- 2026-08-18 ship 050/S-60 与 051/S-61：阶段 1 驾驶舱与暖金会话优先壳层勾选为已交付；当前无活跃在途切片。UCD 主路径不伪造 DTO 的缺口已收口。未交付高风险能力仍规划中。
- 2026-08-18 052/S-42 受控工作区编辑完成 implement + ship：schema 26、sandbox 编辑/diff/stage、审批后 `writeNativeVerifiedFile` 合入、预览「编辑」。安全评审 HIGH/MEDIUM 已修（A-391）；hf-code-review PASS；`tsc`/`build` 绿；全量 2808/2810（A-387）。演示 auto-approved。下一步 S-43。
- 2026-08-19 053/S-43 完成 grill-with-docs：spec/architecture/6 张纵向票与 UCD §9.4.4 落盘；策略终端收窄为任务内精确命令选择器 + 只读脱敏输出，本地预览仅由冻结 loopback policy 生成（A-393～A-396）。进入 implement T-01。
- 2026-08-19 053/S-43 完成 implement + ship：schema 27、冻结策略命令目录、exact/deny/one-shot Approval、Policy Process 生命周期与脱敏增量输出、loopback preview、任务内终端 UI 全部落地；code/security review 发现已收口；`tsc`/`build` 绿，全量 308/309 文件、2820/2821 用例（唯一失败为既有 A-387）；演示 auto-approved。下一片按未交付依赖顺序进入 054/S-29。
- 2026-08-19 054/S-29 完成 grill-with-docs：专用 index/state watermark、不切换 S-28 canonical search、active-head coverage/hash 健康口径、强确认 SQLite 投影重建（A-397～A-400）；spec/architecture/5 张票与 UCD §9.2.4 落盘，进入 implement T-01。
- 2026-08-21 054/S-29 完成 implement + ship：schema 28、memory index/state、health GET、强确认 rebuild、记忆视图健康条；code review 收口跨 owner 写与正文泄漏；`tsc`/`build` 绿，`smoke:settings` 含亮/暗/窄屏健康条，全量 2826/2827（A-387）；`smoke:context` 记 A-401。演示 auto-approved。下一片按未交付依赖顺序进入 055/S-35。
- 2026-08-21 055/S-35 完成 grill-with-docs：`/team` 健康 region、零 schema 组合信号、GET 不探测 Provider、unknown 不映射 ok（A-402～A-405）；spec/architecture/5 张票与 UCD §9.3.6 落盘，进入 implement T-01。
- 2026-08-21 055/S-35 完成 implement + ship：GET `/api/health` 聚合应用/Provider/索引/执行；`/team` 健康四卡与深链；`tsc`/`build` 绿，`smoke:settings` 20 steps，全量 2832/2833（A-387）。演示 auto-approved。S-44 健康阻塞解除。
- 2026-08-21 056/S-44 完成 grill-with-docs：冻结目录、只读预览、execute/undo、Execution「救援」表面与 UCD §9.4.5（A-406～A-408）。进入 implement T-01。
- 2026-08-21 056/S-44 完成 implement + ship：冻结救援目录、preview/execute/undo（confirmation + version CAS，高权限经既有 Approval）、任务治理 Execution 卡片「救援」；ExecutionPanel 挂在图标轨任务视图（A-411）。`tsc`/`build` 绿；全量 318/319、2853/2854（A-387）；`smoke:execution` 记 A-412。演示 auto-approved。下一片 S-36 用量与配额看板。
- 2026-08-21 057/S-36 完成 grill-with-docs：零 schema 用量投影、GET `/api/usage`、`/team` §9.3.7、估算不是账单（A-413～A-416）。进入 implement T-01。
- 2026-08-21 058/S-37 完成 grill-with-docs：按职责贡献投影、GET `/api/contribution`、`/team` §9.3.8、不是排行榜（A-417～A-420）。进入 implement T-01。
- 2026-08-21 058/S-37 完成 implement + ship：零 schema GET `/api/contribution`；`/team`「协作贡献」按职责展示工作项/复核，声明不是排行榜，证据深链既有任务/复核入口。`tsc`/`build` 绿；`smoke:settings` 22 steps；全量 324/325、2868/2869（A-387）。演示 auto-approved。下一片 S-38 脱敏导出。
- 2026-08-21 059/S-38 完成 grill-with-docs：当前项目脱敏导出、GET `/api/projects/:id/export`、审计「导出脱敏包」、浏览器下载（A-421～A-425）。进入 implement T-01。
- 2026-08-21 059/S-38 完成 implement + ship：零 schema GET `/api/projects/:id/export`；审计确认后下载脱敏 JSON（版本/范围/hash）；不写工作区。`tsc`/`build` 绿；全量 326/327、2873/2874（A-387）。演示 auto-approved。下一片 S-40 交付回放。
- 2026-08-21 060/S-40 完成 grill-with-docs：时间轴只读回放、GET `/api/projects/:id/replay`、不重放动作（A-426～A-428）。进入 implement T-01。
- 2026-08-21 060/S-40 完成 implement + ship：零 schema GET `/api/projects/:id/replay`；时间轴「打开回放」；来源 href 复用审计面板。`tsc`/`build` 绿；全量 328/329、2878/2879（A-387）。演示 auto-approved。下一片 S-30 知识集合。
- 2026-08-21 061/S-30 完成 grill-with-docs：集合目录、schema 29、删除保留来源（A-429～A-431）。进入 implement T-01。
- 2026-08-21 061/S-30 完成 implement + ship：schema 29 集合表；记忆视图目录；删除不删来源。`tsc`/`build` 绿；全量 328/330、2881/2883（A-387；composer-draft 偶发已复跑通过）。演示 auto-approved。下一片 S-31 知识图谱。
- 2026-08-21 062/S-31 完成 implement + ship：零 schema GET `/api/projects/:id/knowledge-graph`；记忆「关系列表」；supersedes 与集合共现；缺节点边不渲染。`tsc`/`build` 绿；全量 331/332、2887/2888（A-387）。演示 auto-approved。`CAP-KNW-03` 已交付核心。
- 2026-08-27 063/S-32 立项并进入 implement：按 A-318 同口径重评准入——`CAP-GOV-02` 中心已交付，本片建立 knowledge 发布域（A-434～A-442）。grill/spec/architecture/tickets 同批落盘；spec/architecture 评审豁免。进入 T-01。
- 2026-08-27 063/S-32 T-01 完成：schema identity 30 + `proposeCuration`，成员、来源、supersedes 与 project-scoped operation 均失败关闭/幂等；聚焦、知识/identity 回归与 tsc 全绿。停在 T-02 前沿。
- 2026-08-27 063/S-32 T-02 完成：`listCurationCandidates` 提供项目隔离、Agent 署名、有序来源与链头逐行 diff；聚焦 8/8、Knowledge 66/66 与 tsc 全绿。停在 T-03 前沿。
- 2026-08-27 063/S-32 T-03 完成：`decideCuration` 发布/驳回、Agent nullable-confirmer MemoryEntryV6 与严格 no-store HTTP 落地；聚焦 26/26、Knowledge+Review 86/86 与 tsc 全绿。停在 T-04 前沿。
- 2026-08-27 063/S-32 T-04 完成：Knowledge pending/replaced 经公开缝接入统一审批中心，knowledge/memory_publish 契约、跨域排序与 publish/reject 分派落地；指定聚焦 45/45、cockpit fixture 13/13、tsc 与真实 Chrome 核对全绿。停在 T-05 前沿。
- 2026-08-27 063/S-32 T-05 完成：记忆视图「提炼候选」落地 Agent/来源/diff、全态与 publish/reject，发布后同步刷新并聚焦新记忆；`memory-panel` 13/13、相关 review UI 5/5、tsc/lint 与真实 Chrome 核对全绿。停在 T-06 前沿，尚未运行全量收口。
- 2026-08-27 063/S-32 完成 implement + ship：schema identity 30；提炼候选/发布/驳回；审批中心 knowledge 域；记忆视图署名与 diff。独立 hf-code-review 第 6 轮通过；`tsc`/`build` 绿；全量 334/2921（A-387）。演示 auto-approved。`CAP-KNW-04` 已交付核心。下一片 S-34。
- 2026-08-27 064/S-34 立项并进入 implement：按 A-318 口径重评准入（A-445～A-452）。grill/spec/architecture/tickets 同批落盘；spec/architecture 评审豁免。进入 T-01。
- 2026-08-27 064/S-34 完成 implement + ship：零 schema GET `/rule-insight` + `/team`「规则与注入检查」；独立 hf-code-review 通过；全量仅余 A-387。演示 auto-approved。`CAP-IDC-03` 规则/注入只读核心已交付。不进入 S-45 族。
