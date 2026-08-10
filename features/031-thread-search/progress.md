# 进度

- 特性: 031-thread-search（对应切片: S-17 / CI-2.5）
- 当前阶段: implement（T-01..T-04 全部完成）
- 执行模式: auto（用户 2026-08-09 明示：不在电脑前，问题按助手推荐处理）
- 已加载扩展: 无
- 下一步: 无（四票全绿；待用户决定 ship/commit）
- 用户可感知: 是
- 评审状态: 项目级 review 豁免（2026-08-09）；不伪造评审工件；spec/architecture 由主会话按 backlog S-17 已确认条目直接产出
- 共享理解: backlog S-17 条目视为 auto-approved 2026-08-10

## 实施记录

- 2026-08-10 特性开立：S-17 准入全部成立——`CAP-COL-01` 已交付核心，S-23 AUD-MVP（028）与 AUD-COL（030）今日 ship（CAP-OPS-01/02 基座 + CAP-COL-07 协作事件可查询/导航已证明）。本片是投影基座上的第二种投影（搜索索引），验证基座承载非审计投影的扩展性。
- 2026-08-10 T-01 完成（实现 subagent，不提交 git；项目级 review 豁免）：
  - **FTS5 勘察证据**（决策=A-169 普通表+LIKE，两轮独立实测一致）：node v24.14.0 实测 compile_options 含 ENABLE_FTS5、`CREATE VIRTUAL TABLE ... USING fts5(content)` 成功、英文 token MATCH 命中（'world'/'keyword'）；但 (a) unicode61 默认分词对中文 contains 无效（`MATCH '你好'` 对 '你好世界' 空集；复测 `MATCH '部署'` 对 '部署计划 Keyword rollout' 同样空集）；(b) 虚表产生 5 张影子表进 sqlite_master，与 exact-schema 校验器不兼容（CREATE_HEADER 无 VIRTUAL、行数精确比对必漂移）。LIKE 实测：ASCII 折叠 + 中文 contains 正常。
  - **schema**：identity 16→17，`thread_search_index`（project_id/thread_id/kind CHECK/message_id 可空/content/occurred_at/source_seq + UNIQUE 四列 + 条件 CHECK；部分唯一索引 `thread_search_one_title` 兜标题行 NULL 去重）；无 FK（A-140 投影语义），reopen 不变量新增两条（索引⊆threads、message 行⊆collaboration_messages）；全部 identity 引用同波次同步（rejection 矩阵 legacy 1..16/unsupported 18、unsupported-schema-input 联合、current-schema 双套件、execution-audit-outbox、五个 public-collaboration reopen/ source-api/favorite/outbox 套件、persistent-threads smoke）；write-ownership manifest 登记 operations-projection + 注记。
  - **consumer**：`src/adapters/outbound/sqlite/operations-projection/thread-search-index-consumer.ts` + `-store.ts`（写者锚点）；consumer_id `thread-search-index` 复用 checkpoints 协议（批次 500、BEGIN IMMEDIATE 批事务、rebuild CAS claim、rebuilding 拒绝、corrupt checkpoint fail-closed）；游标语义=outbox 全局单调 outbox_seq（message 行 source_seq=事件 outbox_seq，标题行恒 0）；catchUp 扫描全部 outbox 行按序前移游标，仅 source='public_collaboration' 事件消费——任一协作事件以 payload.threadId 捎带标题行（thread_created 不入 outbox 的增量补位，A-171），owner/agent_message 以 messageId 回查 collaboration_messages 取全文；rebuild=清表+threads 全量标题+outbox 重放，后置条件 titles==threads 数 ∧ messages==重放 distinct 键数，不符 PROJECTION_REBUILD_INCOMPLETE 回滚（A-172）。
  - **TDD**：RED① schema 断言（identity 17+表形态）→GREEN schema 落地；RED② consumer 9 用例（模块缺失→实现后又驱动出 source 列漏选缺陷：applied=0）→GREEN；rebuild 4 用例随 consumer 同批 GREEN；RED③ 不变量负例 2 条（孤儿线程行/孤儿消息行 reopen 不失败）→GREEN 加不变量。最终 18/18 绿。后续修复一处遗留不稳定断言：rebuild 全量用例期望行序曾依赖 randomUUID 文本序（约 50% 失败），改为按 INDEX_ROW_SELECT 确定性排序构造期望值。
  - **验证**：聚焦 tests/modules/operations-projection 全绿（69 过，含中文 contains/ASCII 折叠 LIKE 冒烟、幂等重放、rebuild 确定性/不动点、tuple 隔离、rebuilding 拒绝、corrupt checkpoint fail-closed、不变量负例）；tests/adapters/sqlite + tests/architecture 196 绿；tests/modules/public-collaboration 634 绿；`npx tsc --noEmit` 绿。
  - **假设**：A-169（FTS5 否决证据与 LIKE 基底）、A-170（表形态/无 FK/游标语义）、A-171（标题捎带增量来源）、A-172（rebuild 数据源与敏感边界——索引=已落库公开正文不二次分类）。
- 2026-08-10 T-02 完成（实现 subagent，不提交 git；项目级 review 豁免）：
  - **查询缝**：`src/adapters/outbound/sqlite/operations-projection/thread-search-queries.ts`——`searchProjectThreads(databasePath, projectId, {query, limit?, before?})`；读路径=选项校验→tuple 404→同步 `catchUpThreadSearchIndex`→单读事务（028 audit-projection-queries 逐条同构）；匹配 `instr(lower(content), lower(?))>0` 字面包含（%/_/\ 无通配符语义，测试钉住 r%t/o_f 零命中）；排序 occurred_at DESC + (thread_id, message_id) ASC 全序决胜；游标 base64url(JSON [occurredAt, threadId, messageId]) 排他、模块内严格解码；limit 默认 20/上限 50、query trim 后 1..200 grapheme；snippet 标题命中=完整标题、消息命中=首个命中 ±60 grapheme 窗口+截断侧 …（asciiFold 与 SQLite lower() 对齐，码元偏移→grapheme 索引映射）；threadTitle 经 JOIN collaboration_threads 同库带出；响应 {results, nextCursor} 不内嵌 freshness（A-173）。
  - **路由**：`GET /api/projects/[projectId]/thread-search?q=&limit=&before=`（严格白名单、字段词汇 unknown/duplicate/required/invalid_format/invalid_range/too_long、before 路由浅校验+模块严格解码、全响应 no-store、404/409/400/500/503 映射同 A-145）；DTO 下沉 `src/shared/thread-search-contracts.ts`（zod strict），模块 dto.ts re-export；装配根登记 `threadSearchQueries`（A-174）。
  - **TDD**：RED① query 缝 18 用例（模块不存在）→GREEN 实现一次通过；RED② 路由缝 22 用例（路由不存在）→GREEN 一次通过。覆盖：读路径触发 catchUp、标题/内容命中、ASCII 折叠+trim、混合排序+同戳决胜、默认/显式 limit 分页（22 线程同戳不重不漏）、排他游标、snippet 三窗口（开头/中间/结尾）、通配符字面化、空结果、跨项目零泄漏、rebuilding 409 fail-closed、空查询/超长/坏 limit/坏游标 400、tuple 404、校验先于 tuple。
  - **验证**：聚焦 tests/modules/operations-projection + tests/architecture 12 文件 134 全绿；`npx tsc --noEmit` 绿；ReadLints 零告警。
  - **夹具**：新增共享 `tests/fixtures/collaboration/search-graph.ts`（参数化 provider+双 agent+项目脚手架），query/api 两测试文件复用（A-175）。
  - **假设**：A-173（查询/排序/游标/snippet 语义）、A-174（路由与 DTO）、A-175（共享测试夹具）。
- 2026-08-10 T-03 完成（实现 subagent，不提交 git；项目级 review 豁免）：
  - **搜索 UI**：`components/project-thread-navigation.tsx` 线程区顶部搜索框（aria-label「搜索线程」，300ms 防抖，Esc 清空恢复列表，44px 由全局 input min-height var(--control-min) 保证，样式全 tokens）；搜索激活时结果区（section aria-label「线程搜索结果」）替换全部/已收藏 tablist 与线程列表、清空恢复（A-176）；结果项=线程标题+kind 徽章（标题/内容，复用 .status-label）+snippet（仅内容命中）+zh-CN 可读时间；全态覆盖 loading「正在搜索…」/empty「无匹配结果。」/error 脱敏 role=alert+「重试搜索」；加载更多「加载更多搜索结果」追加式（before=nextCursor，失败行内 role=alert 保留已加载）；键盘=input ArrowDown 入列表、结果项 ArrowUp/Down 移动、Enter 激活、Esc 清空还焦；防陈旧=searchEpochRef+targetGuard AbortSignal 双闸，projectId 切换全量重置。
  - **URL/定位链路**：结果点击→`window.history.pushState`+`PopStateEvent` dispatch（同页参数缝，A-177）生成 `?thread=..[&message=..]`（标题命中仅 thread）；`parseProjectSelection` 扩展可选 message 参数（PATH_SAFE_ID、重复/非法/孤立 message/多余键整体回退 null，canonical 序 thread→run→message，向后兼容）；TaskPanel collaborationTarget 增 messageId 并向三处 CollaborationPanel 挂载传 `requestedMessageId`；CollaborationPanel 复用 022 messageRefs/setLocateMessageId 滚动+focus+高亮，未命中已加载集则沿 facts 排他游标回翻（backfillToRequestedMessage 与 jumpToReplyTarget 同构），穷尽未命中→role=status 占位「无法定位指定的消息：它不在当前可读取的协作历史中。」；每 (targetKey,messageId) 只定位一次，target 切换重置。
  - **TDD**：RED=新文件 `tests/browser/threads/thread-search-ui.test.tsx` 20 用例中 18 条行为用例按计划失败（2 条 parseProjectSelection 负例因既有「多余键回退」语义先行通过）；GREEN 首轮 18/20，修正测试侧两处防抖时序竞态（先等请求发出再断言）与时间文案断言（与实现同算法 Intl 计算）后 20/20 绿。
  - **验证**：聚焦 threads 浏览器套件 70/70 绿；team-settings+projects 回归 103/103 绿；`npx tsc --noEmit` 绿；全量套件 2366 中唯二新增 CSS `width: 100%` 触发 visual-tokens 契约，改 flex 等效（.stack 拉伸语义）后 visual-tokens+搜索套件 26/26 绿。
  - **假设**：A-176（搜索入口位置/tablist 替换关系/全态文案/键盘/防陈旧）、A-177（URL 缝选型/parseProjectSelection 扩展 message 参数语义）、A-178（面板定位消费：已渲染即 locate、未渲染沿 facts 游标回填、耗尽稳定占位、不伪造跳转）。
- 2026-08-11 T-04 完成（真实浏览器验收 + 一次性全量；项目级 review 豁免；不提交 git）：
  - **生产缺陷（顺手修）**：分层 Escape——窄屏导航抽屉内搜索激活时按 Esc，useModalSurface 挂在 dialog 元素上的原生 keydown 先于 React 合成处理器触发，整个抽屉被关闭而非仅清空搜索（违 input-history-panel 分层 dismiss 先例）。RED=`tests/browser/threads/thread-search-ui.test.tsx` 新增分层 Esc 用例（enclosing keydown 不得触发→清空还焦→第二次 Esc 透传关抽屉）按计划失败；GREEN=`project-thread-navigation.tsx` 搜索区 section 挂原生 keydown，激活时 stopPropagation 消费（清空+焦点还输入框），合成处理器 Esc 分支删除收编；threads 套件 71/71 绿。smoke 窄屏段实核双层语义（A-180）。
  - **smoke 基础设施加固**：首跑暴露既有 cutFactsHandler 二次 fulfill 竞态——拦截器注册后常驻，后续 facts 轮询全经过它；导航中止在途轮询使首个 fulfill 抛错、落入 JSON.parse 的 catch 后再次 fulfill，进程以 "Route is already handled" 崩溃。修复=解析/fulfill 分置两层 try、中止即丢弃 route，语义不变（A-181）。
  - **验收造数**（A-179，置于审计段后防断言位移；三独特词零碰撞）：quokka=firstThread 内容命中（POST 真实消息）、云雀=新线程「云雀发布计划」标题命中、walrus=经公开 API 新建外部项目（POST /api/projects→PUT members→POST threads→POST messages）独有词。
  - **验收断言**（8 条新增全过，套件 42 断言/26 axe 态）：`thread-search-api-kinds-snippet-cross-project-isolation`（内容/标题命中 kind+snippet+messageId/threadId 实核、walrus 外部命中∧legacy 零结果、云雀反向隔离零结果、unknown 项目 404 PROJECT_NOT_FOUND、四响应体无 apiKey/masterKey）；`thread-search-desktop-light-keyboard-locate-44px-axe`（输入框/结果 ≥44px、ArrowDown 焦点入列表、focus-visible 焦点环非 none、Enter 激活、URL=thread&message、定位 li 高亮类+真实 focus+滚入视口）；`thread-search-title-hit-navigation`（标题徽章、点击 URL 仅 thread 无 message）；`thread-search-empty-state-foreign-keyword`（walrus→「无匹配结果。」零结果项）；`thread-search-loading-state`（page.route 延迟 1.2s 实核「正在搜索…」后到达结果，finally unroute）；`thread-search-desktop-dark-light-axe`；`thread-search-narrow-44px-focus-layered-escape-axe`（抽屉内 44px、ArrowDown 焦点环、axe、Esc 清空抽屉保持开+焦点还输入框、再 Esc 关抽屉焦点归还开启器）；`thread-search-narrow-result-navigation-locate`（抽屉内点击结果 URL 实核、关闭抽屉后编辑面群聊 tab 实见 quokka 消息）。
  - **axe**：4 个新态 blocking(critical/serious)=0、color-contrast=0；唯「narrow thread search drawer」残留 `aria-allowed-role:minor` 1 条，与 narrow favorites/audit 抽屉既有基线逐字节同签名（A-125/A-135/A-148 低于门禁归因先例，非本片引入）。
  - **矩阵覆盖**：desktop light（结果/定位）+desktop dark（结果）+narrow light（抽屉全流程）；键盘（Tab/ArrowDown/Enter/Esc 双层）、focus-visible 环、44px、empty/loading/隔离。
  - **秘密扫描**：搜索 API 响应随 productApiBodies 全量入终扫+逐体显式断言；DOM 搜索态文本（searchFacingText）与三截图字节入 surfaces；全面零泄漏（`no-secret-db-api-dom-evidence` 过）。
  - **一次性全量**：`npx vitest run` 264 文件 2367 测试全绿 108.16s；`npx tsc --noEmit` 绿；`npm run build` 绿（Next 16.2.12 webpack 编译 10.9s + TS 19.7s）。
  - **证据**：features/031-thread-search/evidence/{thread-search-desktop,thread-search-dark,thread-search-narrow}.png；断言/axe 入 features/014-persistent-project-threads/evidence/persistent-threads-results.json。
  - **假设**：A-179（验收段落点/造数/扫描面）、A-180（分层 Escape 修复）、A-181（cutFactsHandler 加固）。
