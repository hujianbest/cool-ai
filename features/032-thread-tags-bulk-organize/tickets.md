# 任务票 — 线程标签与批量整理

- 状态: 项目级 review 豁免生效，直接进入 implement
- 规模: 5 张纵向 RED/GREEN 票；单一「用标签把线程整理成可筛选主题视图」用户结果
- 公共缝: Thread Tag Command/Query、Thread List 筛选/投影、Thread Tag Batch、线程区整理 UI
- TDD: 每票先一个公共行为 RED，再最小 GREEN；内存库夹具（`tests/fixtures/sqlite/memory-database.ts`）；新树测试路径

- [x] T-01 标签 schema 与 CRUD 命令/查询 — Blocked by: None
  - 公共缝: Thread Tag Command/Query。
  - RED: `thread_tags`/`thread_tag_edges`/`thread_tag_operations` 不存在（schema 断言 identity 18）；`createThreadTag`/`listProjectTags`/`deleteThreadTag` 不存在。
  - GREEN: identity 17→18 纯增三表 + `thread_tag_edges_by_tag` 索引（零既有表改动），同波次同步全部 identity 引用（rejection 矩阵 legacy 1..17/unsupported 19、unsupported-schema-input 联合、current-schema 双套件、execution-audit-outbox、public-collaboration reopen/source-api/favorite/outbox 套件、persistent-threads smoke user_version——031 T-01 清单同例）与 write-ownership manifest（owners+notes）；reopen 不变量两条（edges⊆threads、edges⊆tags）；`createThreadTag`（trim、1..40 grapheme、name_key=NFC+大小写折叠、冲突幂等返回 `created:false`）；`listProjectTags`（可选 query instr 折叠 contains、threadCount、limit 默认 50 上限 100）；`deleteThreadTag`（同事务清边 + removedEdgeCount、跨项目 404）；`GET/POST /api/projects/[projectId]/thread-tags` 与 `DELETE …/thread-tags/[tagId]` 路由（严格校验/脱敏/no-store）；DTO 下沉 shared；装配根登记 `threadTagService`。
  - 验证: 折叠唯一矩阵（NFC/大小写/trim）、grapheme 上限与空白 400、幂等创建、contains 搜索与用量计数、删除清边计数与 FK 兜底、跨项目隔离、reopen 幂等与不变量负例。
  - 命令: 聚焦新 thread-tag 套件 + `tests/adapters/sqlite` schema 套件 + `tests/modules/public-collaboration`；`npx tsc --noEmit`

- [x] T-02 分配命令与列表筛选/投影 — Blocked by: T-01
  - 公共缝: Thread List 筛选/投影 + 分配命令。
  - RED: `setThreadTagAssignment` 不存在；`listThreads` 无 `tagId` 过滤与 `tags` 投影。
  - GREEN: `setThreadTagAssignment` 幂等 upsert/delete（receipt-less，025 收藏先例）+ `PUT …/threads/[threadId]/tags` 路由；`listThreads` rawInput 增 `tagId`（与 `favoritesOnly` 互斥 400 fields、排序不变故 cursor 兼容）；ThreadListItemDto 恒在 `tags`（页面线程 id 批量第二查询，无 N+1）；`GET …/threads` 白名单 +`tagId`（单值 RESOURCE_ID）；共享契约/组件 zod schema/测试夹具同波次更新。
  - 验证: 幂等切换矩阵、跨 tuple 404（他项目标签/线程）、互斥与游标语义、筛选结果确定性且普通列表排序不变、投影恒在（含空数组）、reopen 一致。
  - 命令: 聚焦 thread-tag/threads 列表与路由套件 + `tests/modules/public-collaboration`；`npx tsc --noEmit`

- [x] T-03 批量整理命令 — Blocked by: T-02
  - 公共缝: Thread Tag Batch。
  - RED: `applyThreadTagBatch` 与路由不存在。
  - GREEN: `thread_tag_operations` receipt（同 operationId 同 hash 重放返回存储响应 `replayed:true`、异 hash 409 OPERATION_CONFLICT）；单事务全量 tuple 校验（任一 thread/tag 跨项目整体 404 回滚）→ 幂等边 upsert/delete；上限 threadIds≤100、add+removeTagIds≤20 自动去重；响应 per-thread applied 摘要；`POST /api/projects/[projectId]/thread-tag-batch` 路由（严格 DTO/脱敏/no-store）。
  - 验证: 重放不重复生效（边幂等 + receipt 短路）、409 冲突、原子性负例（部分失配零生效且零边变化）、上限/去重 400、receipt 行持久可查（operationId 重查）。
  - 命令: 聚焦 thread-tag-batch 套件 + `tests/modules/public-collaboration`；`npx tsc --noEmit`

- [x] T-04 线程区整理 UI — Blocked by: T-03
  - 公共缝: 整理 UI（jsdom，`tests/browser/threads/thread-tags-ui.test.tsx` 新文件）。
  - RED: 无管理对话框/chips/筛选条/批量条/确认对话框。
  - GREEN: 线程区「管理标签」对话框（创建输入 trim+≤40 grapheme 校验提示、搜索 contains、列表带用量计数、删除强确认对话框如实显示「将解除 N 条分配」）；列表项标签 chips（复用 .status-label 徽章范式，不新增颜色）；筛选 chip 条（选中 tagId → GET `tagId=`，与已收藏视图互斥时回退「全部」）；「整理线程」多选模式 + 批量条（已选计数、加/去标签 picker、确认对话框、operationId=crypto.randomUUID、成功 role=status notice + 静默刷新、失败行内 role=alert 可重试）；样式全 tokens、44px、键盘/Enter/Space/Esc、focus-visible、loading/empty/error/disabled 全态；epoch+AbortController 防陈旧、projectId 切换全量重置；useModalSurface 分层 dismiss（031 A-180 先例）。
  - 验证: 交互矩阵、全态覆盖、键盘可达与焦点归还、互斥回退、确认文案计数如实、防陈旧、target switch 不串、CSS tokens 契约断言。
  - 命令: 聚焦 `tests/browser/threads` 相关套件；`npx tsc --noEmit`

- [x] T-05 真实浏览器验收标签整理 — Blocked by: T-04
  - 公共缝: 真实标签整理全链路（tuple-scoped route + UI）。
  - 验证: smoke:threads 新增标签验收段（内聚单块，置位对齐 031 A-179 先例零位移）：真实造数 → 创建/搜索/分配/筛选 → 多选批量加/去（含确认）→ 删除标签（确认 + 清边计数 + 刷新后各视图一致）→ restartApp 重启保持 → 跨项目隔离（他项目标签不可见、跨 tuple 404）；desktop/narrow × light/dark、keyboard、focus、44px、axe 无 serious/critical；秘密扫描（API 响应入 productApiBodies 终扫 + DOM 标签态文本 + 截图字节，证据落 `features/032-thread-tags-bulk-organize/evidence/`）；随后一次性全量 `npx vitest run` + `npx tsc --noEmit` + `npm run build`。
  - 命令: smoke:threads 验收段；全量一次；`npm run build`
