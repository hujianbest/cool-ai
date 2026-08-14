# 进度（产品层）

- 范围: product 产品层（产品定义、产品架构、决策、假设、backlog）
- 当前阶段: ready
- 执行模式: interactive
- 已加载扩展: 无
- 下一步: 产品架构已确认且架构收敛完成（D-45），2026-08-10 补全的第 13、14 节与 4+1 视图标注已经用户确认；后续工作按特性走主链（to-spec → to-architecture → to-tickets → implement → ship），切片准入对齐 `product/architecture.md` 第 11 节关键场景与 backlog 四级治理。

## 状态记录

- 2026-08-09 产品定义与目标架构经用户确认（`product/product.md`、`product/architecture.md` 确认行）；产品架构 Standards/Spec 评审第 6 轮通过（`product/reviews/modular-architecture-standards-review.md`、`product/reviews/modular-architecture-spec-review.md`）。
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
