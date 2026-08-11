# 架构 — 线程回收站、恢复与永久删除

- 日期: 2026-08-11
- 对应规格: [`spec.md`](./spec.md)
- 状态: 项目级 review 豁免生效；未送独立评审，不伪造工件

## 架构目标

在 Public Collaboration 线程目录上加线程生命周期（软删/回收站/恢复/永久删除）；复杂性（级联图、不可变触发器门、序列不变量、附件字节）留在 SQLite Adapter；UI 只消费回收站投影与生命周期缝。既有缝零协议破坏：已删线程对全部现有缝不可见，purge 后 reopen 不变量逐条保持。

## 现状勘察结论（设计前提）

- `collaboration_threads` 无 deleted/kind 标记；全部线程经 `createThread` 由 owner 显式创建，**当前产品不存在系统创建线程**。
- 不可变触发器：`thread_fact_no_delete`、`thread_policy_revision_no_delete`、`thread_policy_member_no_delete` 在「项目存在」时 ABORT 一切 DELETE——**purge 必须扩展触发器门，否则 DB 级无法删除**；`thread_identity_no_update` 只锁 id/project_id/created_at 三列，软删 UPDATE `deleted_at` 合法。
- FK 级联图（自 threads CASCADE）：runs（→events/turns/decision_requests）、attempts（→model_calls）、operations、messages、policy_revisions（→members）、project_sequences、drafts、favorites、tag_edges、input_history_entries、attachment_events、message_attachments、facts。NO ACTION 横切边：facts→messages/events/revisions/decisions/receipts；blocks→messages；receipts→decisions；turns→attempts/messages；**executions→runs（NO ACTION，跨 owner provenance）**。
- `thread_search_index` 无 FK（derived-only，031 A-140 语义），reopen 不变量要求 `index⊆threads` 且 `message 行⊆messages`——purge 必须同事务清索引行；写 ownership 属 operations-projection，DELETE 只能经其 adapter 目录的 Tx 写入器。
- `collaboration_project_thread_sequences.next_activity_sequence = 1+max(项目全部 facts.activity_sequence)` 是 reopen 不变量；purge 删除 facts 后必须重算，否则 reopen 失败关闭。
- 附件字节落盘 `<attachmentsRoot>/<projectId>/<attachmentId>`（024 项目作用域），`removeAttachment` 先例：同事务 unlink、失败回滚。
- 030 `audit_event_outbox` 接受 source='public_collaboration' 的同事务追加（`appendCollaborationAuditOutboxRow`）；031 搜索 consumer 对任何带 threadId 的事件做 title hint（INSERT OR IGNORE … SELECT FROM threads，线程不存在则零插入，天然安全）。

## Module 与 Interface

- Commands（`src/modules/public-collaboration/public/commands.ts` 扩展；实现落新文件 `src/adapters/outbound/sqlite/public-collaboration/thread-lifecycle-service.ts`）：
  - `deleteThread(databasePath, projectId, threadId)` → `{threadId, deleted, deletedAt}`；幂等：已删返回 `deleted:false` + 原 `deletedAt`（冻结首删时间，零新审计事件）；守卫：线程存在非终态 run（status NOT IN ('failed','stopped')）→ 409 OPERATION_CONFLICT；成功路径同事务 UPDATE `deleted_at`/`updated_at`/`version` + 写 `thread_deleted` 审计事件。
  - `restoreThread(databasePath, projectId, threadId)` → `{threadId, restored}`；幂等：活跃线程返回 `restored:false`；成功路径同事务清 `deleted_at` + 写 `thread_restored` 事件。
  - `purgeThread(databasePath, attachmentsRoot, projectId, threadId)` → `{threadId, purged:true, removedMessageCount, removedAttachmentCount}`；仅自回收站（`deleted_at NOT NULL`，否则 404）；executions 预检 409；单事务级联（见关键流程）；重试已成功 purge → 404 明确失败（线程已不存在，无重复业务动作可能；审计事件即不可抵赖记录）。
- Queries（`queries.ts` 扩展）：
  - `listDeletedThreads(databasePath, projectId, rawInput{cursor?, limit?})` → `{threads: RecycleBinItemDto[], nextCursor}`；`WHERE project_id=? AND deleted_at IS NOT NULL`，排序 `deleted_at DESC, id ASC`（决胜），游标复用 listThreads 同构编码；limit 默认 50 上限 100；item 恒在投影 `messageCount`/`attachmentCount`（页面线程 id 批量第二查询，无 N+1，032 tags 投影先例）。
- 排除语义（现有缝同波次收口）：
  - thread 级缝统一 `ensureActiveThread`（thread-service/run-service/draft/attachment/favorite/tag/inline-decision 全部命令与查询）：tuple 存在但 `deleted_at NOT NULL` → 404 RESOURCE_NOT_FOUND + `details:{reason:"thread_deleted"}`；tuple 不存在或跨项目 → 既有无标记 404（不泄漏删除态差异给他项目）。
  - 项目级缝谓词：`listThreads`（含 favoritesOnly/tagId 两变体）与 `searchProjectThreads` HIT_SELECT 增 `deleted_at IS NULL`；`searchInputHistory` 排除已删线程条目；`listProjectTags` 的 threadCount 只计活跃线程（边保留，恢复即还原）。
- schema identity 18→19（canonical 唯一 manifest 直接改定义，ADR-0003；零 migration/backfill/legacy 分支）：
  - `collaboration_threads` 增列 `deleted_at TEXT CHECK(deleted_at IS NULL OR deleted_at GLOB '????-??-??T??:??:??.???Z')`（既有行 NULL，语义零变化）。
  - 部分索引 `collaboration_threads_recycle_bin(project_id, deleted_at) WHERE deleted_at IS NOT NULL`（回收站查询与排除谓词共用）。
  - 新表 `thread_purge_markers(project_id TEXT NOT NULL, thread_id TEXT NOT NULL, created_at ISO GLOB CHECK, PRIMARY KEY(project_id,thread_id), FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE)`——purge 事务内瞬时标记；**无 FK→threads**（标记必须先于线程行消失而插入、提交前删除）。
  - 触发器门扩展（ WHEN 增「且无 purge 标记」）：`thread_fact_no_delete` / `thread_policy_revision_no_delete` / `thread_policy_member_no_delete` 变为 `WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id) AND NOT EXISTS(SELECT 1 FROM thread_purge_markers m WHERE m.project_id=OLD.project_id AND m.thread_id=OLD.thread_id)`；其余不可变触发器零改动（purge 不触碰 review/memory/mission 等域）。
  - reopen 数据不变量 +1：`thread_purge_markers` 在任何一致快照必须为空（`SELECT 1 FROM thread_purge_markers` 命中即 SCHEMA_DATA_INVALID——标记只存在于 purge 事务内，崩溃即回滚）；既有不变量零改动（purge 后各 thread 不变量对消失 tuple 真空成立；project sequences 不变量由重算保持）。
  - write-ownership manifest：`thread_purge_markers` 登记 public-collaboration（owners+notes）；identity 引用同波次同步（rejection 矩阵 legacy 1..18/unsupported 20、unsupported-schema-input 联合、current-schema 双套件、execution-audit-outbox、public-collaboration reopen/source-api/favorite/outbox/tag 套件、persistent-threads smoke user_version 19——032 T-01 清单同例扩展）。
- 路由（最少面，校验/脱敏/no-store 逐条对齐 favorite/thread-tag 先例）：
  - `DELETE /api/projects/[projectId]/threads/[threadId]`（无 body，双路径参数 RESOURCE_ID）→ 200 软删响应。
  - `POST /api/projects/[projectId]/threads/[threadId]/restore`（严格空 JSON `{}`）→ 200。
  - `POST /api/projects/[projectId]/threads/[threadId]/purge`（严格空 JSON `{}`）→ 200；409（executions 引用）/404（非回收站线程或不存在）。
  - `GET /api/projects/[projectId]/thread-recycle-bin?cursor=&limit=`（静态段与 `[threadId]` 零碰撞，thread-tag-batch 先例；query 白名单单值）。
  - 装配根登记 `threadLifecycleService` 命名空间（threadTagService 先例）；DTO 下沉 `src/shared/collaboration-contracts.ts`：`ThreadDeleteResponse`、`ThreadRestoreResponse`、`ThreadPurgeResponse`、`RecycleBinItemDto`、`RecycleBinListResponseDto`（zod strict，组件侧 schema 与同波次夹具同步）。
- 跨 owner 边（随 architecture tests 登记）：purge 经 `operations-projection/thread-search-index-store.ts` 新导出 `deleteThreadSearchIndexRowsTx(database, {projectId, threadId})` 清索引行（DELETE SQL 文本留在 owner 目录，writers 守卫通过；public-collaboration 侧仅函数调用，action-committer→mission-service 既有跨 owner 调用先例）；executions 预检为跨 owner 只读 SELECT（ownership 测试只管写，只读边在 architecture 评审记录）。

## 关键流程

1. 软删：列表项「移入回收站」→ 轻确认对话框（如实「可从回收站恢复」）→ DELETE → 200 → 线程从各视图即刻消失 + `role=status` notice；若删除的是当前打开线程，清空选择回项目根；非终态 run 409 → 行内 `role=alert` 如实文案。
2. 回收站：tablist 第三视图「回收站」→ GET thread-recycle-bin → 倒序列表（标题/删除时间/消息与附件计数）→ 「恢复」幂等还原（线程回列表原排序位，组织事实一并还原）→ notice + 静默刷新。
3. 永久删除：回收站行内「永久删除」→ 强确认对话框（如实「将永久删除 N 条消息、M 个附件。此操作不可恢复；删除操作会记录在审计日志中。」；初始焦点落「取消」，032 A-203 先例）→ POST purge → 单事务：
   1. 校验 tuple + `deleted_at NOT NULL`（否则 404）；
   2. executions 预检（`EXISTS executions WHERE (project_id, source_collaboration_thread_id)`）→ 409 `fields.threadId="has_executions"`；
   3. INSERT purge marker；
   4. 显式删除序（每条语句结束时 NO ACTION 自洽）：`collaboration_thread_facts` → `structured_message_state_heads`/`structured_message_state_revisions`/`structured_message_blocks` → `business_action_receipts` → `inline_decisions` → `deleteThreadSearchIndexRowsTx`；
   5. 收集 `message_attachments.storage_relpath` 清单；
   6. DELETE `collaboration_threads` 行——级联 runs/events/turns/decision_requests/attempts/model_calls/operations/messages/policy_revisions/members/project_sequences/drafts/favorites/tag_edges/input_history/attachment_events/message_attachments（facts/revisions/members 已显式清除，级联为空集）；
   7. 同事务按清单 unlink 附件字节（任一失败 → 整体回滚 + 稳定脱敏错误，024 removeAttachment 先例扩展）；
   8. 重算 `collaboration_project_thread_sequences.next_activity_sequence = 1+COALESCE(MAX(剩余 facts.activity_sequence),0)`；
   9. DELETE purge marker；写 `thread_purged` 审计事件（payload=threadId+标题摘录）；COMMIT。
4. 占位：陈旧 URL/他端删除 → detail 404 `reason=thread_deleted` → 占位面板「该线程已移入回收站。」+「恢复线程」（调 restore 后正常加载）+「返回线程列表」；审计中心/搜索结果导航到已删线程同落此占位。

## Seam 与测试点

- Seam 1 — schema + 排除语义：`tests/adapters/sqlite` schema 套件 + `tests/modules/public-collaboration` 现有缝扩展（夹具 `deleted_at` 直写构造）+ operations-projection 搜索套件。
- Seam 2 — Lifecycle 命令/路由：`tests/modules/public-collaboration/thread-lifecycle*.test.ts`（新）+ threads 路由套件。
- Seam 3 — Recycle Bin 查询/路由：同上新套件 + thread-recycle-bin 路由套件。
- Seam 4 — Purge：`tests/modules/public-collaboration/thread-purge*.test.ts`（新；逐表零残留断言、触发器门负例、executions 409、字节清理、sequence 重算、reopen 不变量）。
- Seam 5 — 回收站 UI：`tests/browser/threads/thread-recycle-bin-ui.test.tsx`（新，jsdom）。
- Seam 6 — smoke:threads 验收段（persistent-threads-browser-smoke.mjs 内聚单块，置位对齐 031 A-179/032 A-204 零位移先例）。

## 横切约定

- 幂等（软删/恢复 receipt-less，025 先例；purge 原子单事务 + 重试 404 明确失败）；tuple 联合校验与跨项目 404；错误稳定脱敏 envelope（零新错误码：INVALID_INPUT 400 / RESOURCE_NOT_FOUND 404 / OPERATION_CONFLICT 409 既有词汇；`reason=thread_deleted` 与 `has_executions` 为 details 词汇扩展而非新码）。
- 审计不可抵赖：三事件同事务落 outbox；payload 仅 threadId + 标题经 `publicExcerpt`（凭据分类 + 200 grapheme 截断，fail-closed 占位）；历史 outbox/projection 行永久保留（不可变历史，purge 不清审计）。
- tokens/44px/键盘/focus/全态；epoch+AbortController 防陈旧（029 A-154 先例）；useModalSurface 分层 dismiss（031 A-180/032 A-205 先例）；projectId 切换全量重置回收站/确认/占位态。

## 决策记录（随架构冻结，台账见 `product/assumptions.md` A-207 起）

- 软删=列标记而非状态机：`deleted_at` 可空列语义最小（无第二状态词汇），排除谓词机械统一；既有行 NULL 零漂移（A-208）。
- 排除=所有现有缝「已删即不存在」：thread 级 404+reason 标记、项目级谓词过滤；回收站是唯一可见缝——比「各缝各自展示已删态」诚实且爆炸半径最小（A-209）。
- 永久删除确认走 **UI 强确认**，不走 CAP-GOV-02 审批中心：029 中心服务异步 pending/approve 生命周期的高风险域（执行/内联决策裁决）；purge 同步原子、前置软删+回收站两道闸门、单 owner 本机操作；backlog「审批=永久删除强确认」由显式 UI 强确认兑现（032 A-185 同族决策）（A-213）。
- purge 触发器门=**瞬时标记表**而非依赖级联时序：projects-WHEN 模式在「项目级联删除」路径从未被生产代码执行过（无 DELETE FROM projects），其级联时序假设未验证；`thread_purge_markers` 把「允许删除」显式化、事务内自清理，不依赖 SQLite 级联求值次序（A-215）。
- executions provenance 守卫：预检 409 + FK NO ACTION 兜底；已产生执行记录的线程只可软删——冻结 provenance 优先于删除自由（AGENTS.md 不可变历史条款）（A-217）。
- `next_activity_sequence` 重算而非单调保留：activity_sequence 仅是活数据内排序键（列表游标/事实序），purge 后旧值行已消失，复用无外部可观测性；reopen 不变量保持精确等式，不引入高水位台账表（A-218）。
- 审计日志保留：purge 清除协作内容图但不动 outbox/projection 历史行（含既有消息摘录）——「删除/恢复不可抵赖」与「不可变历史」优先；UI 确认文案如实说明（A-219）。
- 搜索索引：软删留行+读路径排除、purge 同事务清行、consumer/rebuild 零改动（A-220）。
- 系统线程：当前无系统创建线程，不引入标记列；未来系统/自动线程必须带不可删标记并在删除命令失败关闭（A-221）。

## ADR 链接

- 遵守 ADR-0003（canonical 唯一 schema：列/索引/表/触发器定义直接入 manifest，identity 18→19，无 migration）；无新增难逆转决定。
