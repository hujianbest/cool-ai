# 任务票 — 线程搜索与精确定位

- 状态: 项目级 review 豁免生效，直接进入 implement
- 规模: 4 张纵向 RED/GREEN 票；单一"搜到并直达讨论"用户结果
- 公共缝: Thread Search Consumer、Thread Search Query、搜索 UI + 消息定位 URL 入口
- TDD: 每票先一个公共行为 RED，再最小 GREEN；内存库夹具

- [x] T-01 搜索索引投影 consumer — Blocked by: None
  - 公共缝: Thread Search Consumer。
  - RED: 索引表/consumer 不存在。
  - GREEN: identity 16→17 `thread_search_index`（同步全部引用与 write-ownership manifest）；FTS5 可用性勘察（证据记 progress，不可用则 LIKE 方案）；`catchUpThreadSearchIndex`/`rebuildThreadSearchIndex`（复用 checkpoints 协议）；消息事件回查正文入索引、线程标题入索引；reopen 不变量（索引⊆事实源）。
  - 验证: 入索引、幂等重放、rebuild 确定性、敏感降级不泄漏、tuple 隔离。
  - 命令: 聚焦 tests/modules/operations-projection/ + schema 套件；`npx tsc --noEmit`

- [x] T-02 搜索查询与 API — Blocked by: T-01
  - 公共缝: Thread Search Query。
  - RED: 查询/路由不存在。
  - GREEN: `searchProjectThreads`（标题+内容命中、snippet 命中窗口截断、稳定排序、游标分页、tuple 404、读路径同步 catchUp）；GET 路由（严格校验 query 必填/长度上限、脱敏 envelope、no-store）。
  - 验证: 命中矩阵、snippet、排序决胜、空查询 400、空结果、分页、跨项目隔离。
  - 命令: 聚焦 operations-projection 套件；`npx tsc --noEmit`

- [x] T-03 搜索 UI 与消息定位 URL 入口 — Blocked by: T-02
  - 公共缝: 搜索 UI（jsdom）+ 消息定位。
  - RED: 无搜索框；结果不渲染；message URL 参数不被消费。
  - GREEN: 线程区搜索框（防抖、键盘、44px、tokens）；结果列表（标题/摘要/时间、empty/loading/error）；点击 → `?thread=..&message=..`；parseProjectSelection 扩展 message 参数 + collaboration 面板消费（复用 022 定位缝滚动到消息，消息不存在/不可用显示稳定占位提示）。
  - 验证: 交互、渲染、URL 生成与消费、定位/占位、状态矩阵、target switch 防串。
  - 命令: 聚焦 tests/browser/threads|collaboration；`npx tsc --noEmit`

- [x] T-04 真实浏览器验收 — Blocked by: T-03
  - 公共缝: 真实搜索全链路。
  - 验证: smoke:threads 搜索段：真实造数 → 标题/内容搜索 → 结果 → 跳转定位消息（焦点/滚动实核）→ 跨项目隔离（他项目关键词零结果）→ desktop/narrow、light/dark、keyboard、focus、44px、axe 无 serious/critical；秘密扫描；一次性全量 `npx vitest run` + `npx tsc --noEmit` + `npm run build`。
  - 命令: smoke:threads；全量一次；`npm run build`
