# 开发进展

- 范围: 产品层（七份关键文档 + 决策/假设附录）
- 当前阶段: ready
- 执行模式: interactive
- 已加载扩展: 无
- 当前主切片: P0 的 051/S-61 暖金壳层（壳层已实现；目标环境全量绿 + 冒烟 + demo 验收待收尾）
- 下一步: 完成 P0 收尾后进入 P1（050/S-60 阶段 1 驾驶舱）。新上下文开发先读 [`development-plan.md`](./development-plan.md)，再读本文件与当前特性 `progress.md`。

## 当前快照（2026-08-15）

| 项 | 状态 |
|---|---|
| 产品文档 | 七件套：规格 / 词汇表 / 架构 / 特性分解 / 开发计划 / 进展 / UI 设计 |
| P0 暖金壳层 | 图标轨、会话侧栏、居中聊天、空状态、亮暗令牌已落地；视觉契约 25/25；tsc/build 绿 |
| P1–P5 既有切片 | 计划中列出的会话/整理/执行/知识能力多数已 ship，随 P0 壳层做表面集成 |
| 环境性失败 | 全量 2587/2719：失败归因 macOS 非目标 Windows x64 与沙箱端口限制，非本次回归 |
| 未交付高风险切片 | 受控编辑/Git、终端预览、救援、MCP/CLI、语音、知识集合/图谱等仍规划中（见特性分解清单） |

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
