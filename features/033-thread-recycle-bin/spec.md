# 线程回收站、恢复与永久删除需求规格

- 日期: 2026-08-11
- 特性: 033-thread-recycle-bin
- 对应切片: S-20（CI-2.8）
- 模式: 建造
- 用户可感知: 是
- 执行模式: auto（用户不在场，问题按助手推荐处理并记录假设）
- 共享理解来源: `product/backlog.md` S-20 条目（auto-approved 2026-08-11）；阻塞前置 S-14（回复引用来源占位，022 已 ship）与 S-24（`CAP-GOV-02` 永久删除确认，029 已 ship）均已交付；同模块最新先例 S-18（032 于 2026-08-11 ship）
- 公共行为接缝: Thread Lifecycle Command（软删/恢复/永久删除）与 Recycle Bin Query（Public Collaboration）；现有线程缝的已删排除语义；线程区回收站 UI
- 主子系统: Public Collaboration；主 Capability: `CAP-COL-02`（本片建立其软删除、恢复、强确认永久删除与悬空引用规则）

## 问题陈述

线程只增不减：owner 无法清理误建或已完结的线程，列表越来越长；一旦将来能删，当前导航指向已删线程、搜索/收藏/标签/草稿等既有缝如何对待已删线程、回复引用与执行 provenance 如何处理，都没有规则。需要线程级回收站：软删除可恢复、回收站可管理、永久删除强确认且不可恢复，同时系统线程、当前导航与悬空引用都有明确、诚实的处理。

## 解决方案

在 Public Collaboration 线程目录上建立线程生命周期三段式：**软删除**（`collaboration_threads.deleted_at` 标记，幂等，非终态 run 守卫）使线程从全部现有缝（列表/搜索/收藏/标签/详情/消息/草稿/附件/输入历史）消失但数据完整保留；**回收站**（独立查询缝 + 线程区第三视图）列出已删线程并支持幂等**恢复**（还原全部组织事实与排序位）；**永久删除**（仅自回收站、UI 强确认、单事务原子级联 + 附件字节清理 + 搜索索引清理 + 执行 provenance 守卫）使内容不可恢复。软删/恢复/永久删除同事务写 `audit_event_outbox`（不可抵赖）；已删线程被当前导航或悬空引用指向时显示诚实占位（022/031 先例），跨 tuple 一律 404，跨项目绝不泄漏。

## 用户故事

1. **作为 owner，我想把不用的线程移入回收站，从而保持列表干净且可反悔。**
   - 软删除幂等：重复删除返回既有 `deletedAt`，不产生第二条审计事件；有非终态 run（running/waiting_owner/paused/planned）的线程拒绝删除（409），需先停止运行。
   - 软删后线程即刻从全部/已收藏/标签筛选列表、搜索、输入历史与各 thread 级缝消失；thread 级读写统一 404 并带稳定 `reason=thread_deleted` 标记；跨 tuple 仍是不带标记的 404。
2. **作为 owner，我想在回收站看到已删线程并恢复，从而误删零损失。**
   - 回收站按删除时间倒序列出（标题、删除时间、消息/附件计数），空态明确；恢复幂等（对已活跃线程返回 `restored:false`），恢复后线程回到列表原排序位，收藏/标签/草稿/附件/输入历史一并还原。
3. **作为 owner，我想在强确认后永久删除线程，从而真正清除内容。**
   - 永久删除仅自回收站发起（活跃线程 404）；确认对话框如实显示影响面（N 条消息、M 个附件）、不可恢复性与审计保留说明；确认后单事务原子清除全部协作图、附件文件字节与搜索索引行。
   - 已产生执行记录（executions provenance）的线程拒绝永久删除（409 稳定脱敏 + UI 如实文案），只能软删除；重试已成功的永久删除得到明确 404，不重复业务动作。
4. **作为 owner，我想在导航或引用指向已删线程时看到诚实占位，从而不被伪造内容误导。**
   - 删除当前打开线程后 UI 清空选择返回项目根；陈旧 URL/他端删除后加载已删线程时显示「已移入回收站」占位面板（含恢复与返回动作），不伪造线程内容。
   - 搜索结果点击定位失败沿用 031 诚实占位；审计中心事件导航到已删线程同样落占位；系统线程现状与未来保护规则明确（当前产品无系统创建线程，架构记录未来约束）。

## 验收判据

- 软删：幂等语义（重复删除返回原 `deletedAt`、零重复审计）；非终态 run 守卫 409；删除后列表/搜索/收藏/标签/输入历史/详情缝一致排除；刷新与重启保持。
- 回收站：倒序、计数如实、空态、游标分页稳定；恢复幂等且还原全部组织事实与排序位；跨项目零泄漏（他项目回收站不可见、跨 tuple 操作 404）。
- 永久删除：强确认影响面如实；确认后消息/草稿/附件（含文件字节）/结构化块/内联决策/运行图/收藏/标签边/输入历史/搜索索引全部清除且 reopen 不变量全绿；executions 引用线程 409 拒绝；重试 404；审计事件（deleted/restored/purged）同事务落盘且不含敏感字段。
- 占位：当前导航删除即时清选；陈旧指向落诚实占位（可恢复/可返回）；022 回复边与 031 定位语义不被破坏。
- 质量：desktop/narrow × light/dark、键盘、focus、44px、axe 无 serious/critical；秘密扫描无泄漏；全量测试、类型检查、生产构建通过。

## 实现决策

- schema identity 18→19：`collaboration_threads` 增 `deleted_at TEXT` 可空列（ISO GLOB CHECK，既有行 NULL）+ 部分索引 `collaboration_threads_recycle_bin(project_id, deleted_at) WHERE deleted_at IS NOT NULL`；新增 `thread_purge_markers` 瞬时标记表；三个 no_delete 触发器（facts/policy_revisions/policy_members）WHEN 扩展为「项目存在且无 purge 标记则阻断」（canonical 唯一 schema 直接改定义，ADR-0003；无 migration/backfill）；reopen 不变量新增（purge markers 空表断言），identity 引用同波次同步（032 T-01 清单同例）。决策细节见 architecture.md 与 A-208/A-215。
- Commands（公开缝扩展，新 `thread-lifecycle-service.ts`）：`deleteThread`（幂等、非终态 run 守卫 409、同事务 `thread_deleted` 审计事件）；`restoreThread`（幂等、`thread_restored` 事件）；`purgeThread`（仅回收站、executions 预检 409、单事务显式级联序 + 附件字节同事务 unlink + 搜索索引行经 operations-projection Tx 写入器清除 + `next_activity_sequence` 重算 + `thread_purged` 事件）。Queries：`listDeletedThreads`（deleted_at DESC + id 决胜、游标分页、limit 默认 50 上限 100、消息/附件计数）。wire DTO 下沉 `src/shared/collaboration-contracts.ts`（A-122/A-145 先例）。
- 排除语义：所有 thread 级缝统一 `ensureActiveThread`（已删 404 + `details.reason="thread_deleted"`）；项目级列表/搜索缝统一 `deleted_at IS NULL` 谓词（含 031 搜索 HIT_SELECT JOIN 与输入历史搜索）；标签用量计数与 tagId 筛选只计活跃线程，边保留待恢复还原。
- 路由最少面：`DELETE /api/projects/[projectId]/threads/[threadId]`（软删）、`POST …/threads/[threadId]/restore`、`POST …/threads/[threadId]/purge`（严格空 JSON）、`GET …/thread-recycle-bin`（静态段零碰撞）；严格校验/脱敏 envelope/no-store 逐条对齐 025/032 先例；装配根登记 `threadLifecycleService`。
- 确认与治理：软删用轻确认对话框（如实「可从回收站恢复」）；永久删除用强确认对话框（影响面计数 + 不可恢复 + 审计保留说明），**不走 CAP-GOV-02 异步审批中心**（029 异步 pending/approve 生命周期面向执行/内联决策高风险域；purge 是同步原子单事务且前置回收站两道闸门；决策与理由见 architecture.md 与 A-213）。
- 审计：三类生命周期事件进 `audit_event_outbox`（payload 仅 threadId + 标题经 publicExcerpt 凭据分类截断；actor=owner）；历史 outbox/projection 行永久保留（不可变历史，purge 不清审计日志，UI 文案如实）；`AUDITABLE_COLLABORATION_EVENT_TYPES` 闭集 +3，审计中心标签同波次补齐。
- 搜索索引：软删保留索引行、读路径谓词排除；purge 同事务显式清行（reopen 不变量 `index⊆threads/messages` 保持）；consumer/rebuild 零改动（新事件类型的 title hint 对已 purge 线程天然零插入）。
- 系统线程：当前产品全部线程均 owner 显式创建、schema 无系统标记——本片不引入标记列，架构记录「未来系统/自动线程必须带不可删标记并在删除命令失败关闭」；本片真实保护规则为 executions provenance 守卫（A-221）。
- UI：线程区 tablist 第三视图「回收站」、列表项「移入回收站」动作、恢复/永久删除行内动作、强确认对话框、当前导航占位面板；tokens/44px/键盘/focus/全态/防陈旧/useModalSurface 分层 dismiss 沿用既有纪律。
- 错误稳定脱敏（复用 INVALID_INPUT/RESOURCE_NOT_FOUND/OPERATION_CONFLICT 既有词汇，零新错误码）；tuple 联合校验一致。

## 测试决策

- TDD 每轮一个公共缝 RED + 最小 GREEN；需要数据库的测试一律用 `tests/fixtures/sqlite/memory-database.ts` 内存库夹具；夹具构建器同波次扩展（`deleted_at` 直写构造已删线程）。
- **Schema/排除缝**：identity 19 断言；夹具构造已删线程后现有缝（列表/搜索/收藏/标签/输入历史/详情族）泄漏 RED→谓词 GREEN；reopen 幂等与不变量负例。
- **Lifecycle 命令缝**：软删幂等矩阵、run 守卫、恢复幂等与还原、审计事件载荷脱敏、跨 tuple 404、路由严格校验。
- **Recycle Bin 查询缝**：倒序/决胜/游标、计数如实、空页、跨项目隔离。
- **Purge 缝**：级联图全清断言（逐表零残留）、触发器门（无标记删除仍 ABORT）、executions 409、附件字节消失、搜索索引行清理、sequence 重算不变量、重试 404、审计事件落盘。
- **UI 缝（jsdom）**：回收站视图、确认对话框、占位面板、全态与键盘、target switch 防串。
- **浏览器验收**：smoke:threads 增加回收站段（内聚单块、零位移先例）：软删→各视图消失→恢复→还原→永久删除（确认/影响面/审计/字节/索引）→重启保持→跨项目隔离；desktop/narrow × light/dark、keyboard、focus、44px、axe。

## 范围外事项

- 消息级删除/编辑（单条消息生命周期另行切片）；批量删除/批量永久删除（回收站批量操作后续切片评估）。
- 回收站保留期/自动清理（无 TTL，恢复窗口无限期）；删除通知（S-41 范畴）。
- 系统线程实体本身（当前不存在；仅记录未来约束）；标签回收站（032 A-182 已决策不建）。
- 审计中心对生命周期事件的筛选/聚合增强（030 汇总片范畴，本片只补标签映射）。

## 补充说明

- 单一用户结果（线程的回收站—恢复—永久删除生命周期闭环）；6 张票。
- 评审按项目级 review 豁免跳过（AGENTS.md 2026-08-09 起生效，不伪造评审工件）；默认选择记入 `product/assumptions.md`（A-207 起）。
