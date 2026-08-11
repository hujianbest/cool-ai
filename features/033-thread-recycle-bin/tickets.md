# 任务票 — 线程回收站、恢复与永久删除

- 状态: 项目级 review 豁免生效，直接进入 implement
- 规模: 6 张纵向 RED/GREEN 票；单一「线程回收站—恢复—永久删除生命周期闭环」用户结果
- 公共缝: Thread Lifecycle Command、Recycle Bin Query、现有缝已删排除、线程区回收站 UI
- TDD: 每票先一个公共行为 RED，再最小 GREEN；内存库夹具（`tests/fixtures/sqlite/memory-database.ts`）；新树测试路径

- [x] T-01 schema identity 19 与现有缝已删排除 — Blocked by: None
  - 公共缝: schema + 现有线程缝排除语义。
  - RED: `deleted_at` 列/部分索引/`thread_purge_markers` 不存在（schema 断言 identity 19）；夹具直写 `deleted_at` 构造已删线程后，listThreads/搜索/收藏/标签/输入历史/详情族仍返回已删线程（泄漏断言失败）。
  - GREEN: identity 18→19——`collaboration_threads` 增 `deleted_at` 可空 ISO GLOB CHECK 列 + 部分索引 `collaboration_threads_recycle_bin(project_id,deleted_at) WHERE deleted_at IS NOT NULL` + 新表 `thread_purge_markers`（PK(project_id,thread_id)、FK→projects CASCADE、无 FK→threads）；三触发器（thread_fact_no_delete/thread_policy_revision_no_delete/thread_policy_member_no_delete）WHEN 扩展 purge 标记豁免；reopen 不变量 +1（markers 空表断言）；write-ownership manifest 登记；identity 引用同波次同步（rejection 矩阵 legacy 1..18/unsupported 20、unsupported-schema-input 联合、current-schema 双套件、execution-audit-outbox、public-collaboration reopen/source-api/favorite/outbox/tag 套件、persistent-threads smoke user_version 19——032 T-01 清单同例）。排除语义：thread 级缝统一 `ensureActiveThread`（已删 404 + `details.reason="thread_deleted"`，跨 tuple 无标记 404）；`listThreads`（含 favorites/tagId 变体）、`searchProjectThreads` HIT_SELECT、`searchInputHistory` 增 `deleted_at IS NULL`；`listProjectTags` threadCount 只计活跃线程。
  - 验证: schema 断言全绿；已删线程在全部现有缝的排除矩阵（列表/搜索/收藏/标签筛选/输入历史/详情/消息/facts/草稿/附件/运行/操作）；reason 标记仅在 tuple 内出现；reopen 幂等与不变量负例（含 markers 非空失败关闭）。
  - 命令: 聚焦 `tests/adapters/sqlite` schema 套件 + `tests/modules/public-collaboration` + operations-projection 搜索套件；`npx tsc --noEmit`

- [x] T-02 软删与恢复命令 + 路由 + 审计事件 — Blocked by: T-01
  - 公共缝: Thread Lifecycle Command（软删/恢复）。
  - RED: `deleteThread`/`restoreThread` 与路由不存在。
  - GREEN: `thread-lifecycle-service.ts`——`deleteThread`（幂等：已删返回 `deleted:false`+原 `deletedAt` 冻结首删时间；守卫：非终态 run（status NOT IN ('failed','stopped')）409 OPERATION_CONFLICT；同事务 UPDATE deleted_at/updated_at/version + `appendCollaborationAuditOutboxRow` 写 `thread_deleted`）；`restoreThread`（幂等：活跃返回 `restored:false`；同事务清 deleted_at + `thread_restored`）；审计 payload={threadId, 标题经 publicExcerpt 凭据分类+200 grapheme 截断}、actor=owner；`AUDITABLE_COLLABORATION_EVENT_TYPES` +3；审计中心 `COLLABORATION_EVENT_TYPE_COPY` 补三标签（域分类正确）；`DELETE …/threads/[threadId]` 与 `POST …/threads/[threadId]/restore` 路由（严格校验/脱敏/no-store）；DTO 下沉 shared；装配根登记 `threadLifecycleService`。
  - 验证: 幂等矩阵（重复删除零新审计事件、重复恢复 `restored:false`）、run 守卫（四非终态各一 + failed/stopped 放行）、审计事件落盘与载荷脱敏（无内容正文/凭据）、恢复后列表/搜索/收藏/标签/草稿还原且排序位不变、跨 tuple 404、路由严格校验（query/fragment/body 形态）。
  - 命令: 聚焦 thread-lifecycle 套件 + `tests/modules/public-collaboration` + threads 路由套件；`npx tsc --noEmit`

- [x] T-03 回收站查询 + 路由 — Blocked by: T-02
  - 公共缝: Recycle Bin Query。
  - RED: `listDeletedThreads` 与 `GET …/thread-recycle-bin` 不存在。
  - GREEN: `listDeletedThreads`（`deleted_at DESC, id ASC` 决胜、游标同构 listThreads 编码、limit 默认 50 上限 100、item 恒在 `messageCount`/`attachmentCount` 页面 id 批量第二查询无 N+1）；路由（静态段零碰撞、query 白名单单值、脱敏/no-store）；`RecycleBinItemDto`/`RecycleBinListResponseDto` 下沉 shared。
  - 验证: 倒序与决胜、游标翻页一致、计数如实（消息/附件）、空页 200、只含已删（活跃线程不出现）、跨项目隔离、重启一致。
  - 命令: 聚焦 thread-lifecycle/recycle-bin 套件 + `tests/modules/public-collaboration`；`npx tsc --noEmit`

- [x] T-04 永久删除命令 + 路由 — Blocked by: T-03
  - 公共缝: Thread Lifecycle Command（purge）。
  - RED: `purgeThread` 不存在；且无标记时 facts/policy 删除被触发器 ABORT（钉住触发器门负例）。
  - GREEN: `purgeThread` 单事务——tuple+回收站校验（活跃线程 404）→ executions 预检 409 `fields.threadId="has_executions"` → INSERT purge marker → 显式删除序（facts → state_heads/state_revisions/blocks → business_action_receipts → inline_decisions → operations-projection `deleteThreadSearchIndexRowsTx` 清索引行，跨 owner 边登记）→ 收集附件 storage_relpath → DELETE threads 行级联余图 → 同事务 unlink 附件字节（失败整体回滚，024 先例）→ 重算 `next_activity_sequence=1+COALESCE(MAX(剩余 facts),0)` → DELETE marker → `thread_purged` 审计事件 → COMMIT；`POST …/threads/[threadId]/purge` 路由（严格空 JSON/脱敏/no-store）。
  - 验证: 逐表零残留断言（messages/facts/runs/events/attempts/operations/drafts/favorites/tag_edges/input_history/attachments/attachment_events/blocks/revisions/heads/decisions/receipts/policy_revisions/members/project_sequences/search_index）；触发器门负例（无标记 DELETE facts 仍 ABORT）；executions 引用 409 且 FK 兜底；附件文件字节消失；搜索零命中且 reopen 不变量全绿（含 sequence 重算等式）；重试 404 明确失败；审计事件落盘；跨 tuple 404。
  - 命令: 聚焦 thread-purge 套件 + `tests/adapters/sqlite`（reopen/不变量）+ `tests/modules/public-collaboration`；`npx tsc --noEmit`

- [x] T-05 线程区回收站 UI + 当前导航占位 — Blocked by: T-04
  - 公共缝: 回收站 UI（jsdom，`tests/browser/threads/thread-recycle-bin-ui.test.tsx` 新文件）。
  - RED: 无回收站视图/删除动作/确认对话框/占位面板。
  - GREEN: `components/project-thread-navigation.tsx`——tablist 第三视图「回收站」（列表含标题/删除时间/消息与附件计数、空态「回收站为空。」、游标分页）；列表项「移入回收站」动作 + 轻确认对话框（如实「可从回收站恢复」；成功后 notice + 静默刷新，删除当前线程则清空选择回项目根）；回收站行内「恢复」（notice + 还原）与「永久删除」强确认对话框（如实影响面「将永久删除 N 条消息、M 个附件。此操作不可恢复；删除操作会记录在审计日志中。」、初始焦点落「取消」、确认按钮「永久删除」；409 has_executions 行内 `role=alert` 如实「该线程已产生执行记录，不可永久删除」）；当前导航占位面板（detail 404 `reason=thread_deleted` →「该线程已移入回收站。」+「恢复线程」+「返回线程列表」）；样式全 tokens、44px、键盘/Enter/Space/Esc、focus-visible、loading/empty/error/disabled 全态；epoch+AbortController 防陈旧、projectId 切换全量重置（回收站/确认/占位态）；useModalSurface 分层 dismiss（031 A-180/032 A-205 先例）。
  - 验证: 交互矩阵、全态覆盖、键盘可达与焦点归还、确认文案计数如实、防陈旧、target switch 不串、CSS tokens 契约断言。
  - 命令: 聚焦 `tests/browser/threads` 相关套件；`npx tsc --noEmit`

- [x] T-06 真实浏览器验收回收站生命周期 — Blocked by: T-05
  - 公共缝: 真实回收站全链路（tuple-scoped route + UI）。
  - 验证: smoke:threads 新增回收站验收段（内聚单块，置位对齐 031 A-179/032 A-204 零位移先例，置于 032 标签段之后、终扫之前）：真实造数 → 软删（列表/搜索/收藏/标签/输入历史一致消失、当前线程删除清选）→ 回收站可见（倒序/计数）→ 恢复（各视图与排序位还原）→ 再删 → 永久删除（强确认影响面如实、审计事件断言、搜索零命中、附件字节消失、重启后 reopen 不变量）→ executions 引用线程 409 呈现 → restartApp 重启保持 → 跨项目隔离（他项目回收站不可见、跨 tuple 删除/恢复/purge 全 404）；desktop/narrow × light/dark、keyboard、focus、44px、axe 无 serious/critical；秘密扫描（生命周期 API 响应入 productApiBodies 终扫 + DOM 回收站态文本 + 截图字节，证据落 `features/033-thread-recycle-bin/evidence/`）；随后一次性全量 `npx vitest run` + `npx tsc --noEmit` + `npm run build`。
  - 命令: smoke:threads 验收段；全量一次；`npm run build`
  - 收口: 已清理既有阻塞并完成一次性全量验证（`npm run smoke:threads` PASS；`npx vitest run` PASS；`npx tsc --noEmit` PASS；`npm run build` PASS）。
