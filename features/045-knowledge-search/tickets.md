# 任务票 — 记忆检索

- 状态: spec/architecture 豁免；轻量级零 schema，收口前 hf-code-review 豁免
- 规模: 3 张纵向票；单一「搜到并定位项目记忆」用户结果
- TDD: 每票一个行为 RED → 最小 GREEN；内存库；禁止全量套件直到 T-03

- [x] T-01 searchMemories 查询 + GET search — Blocked by: None
  - 公共缝: `searchMemories` + GET `/api/projects/:projectId/memories/search`
  - RED: 查询不存在；跨项目/被取代/过滤未定义
  - GREEN: contains 命中、ASCII 折叠、中文子串、type/sourceType/version 过滤、默认排除 superseded、跨项目 404、未知 query 400、snippet、limit、空结果；装配根经既有 `memoryService`
  - 命令: `npm test -- tests/modules/knowledge-provenance/memory-search.test.ts tests/modules/knowledge-provenance/memory-search.api.test.ts`；`npx tsc --noEmit`
  - 禁止: 全量 vitest；第二个 next dev；schema identity 变更

- [x] T-02 共享记忆检索 UI — Blocked by: T-01
  - 公共缝: jsdom `memory-panel.test.tsx`
  - GREEN: 检索框与过滤；loading/empty/error；结果 snippet；点击定位 `#memory-{id}`；控件 ≥44px；不展示被取代命中
  - 命令: `npm test -- tests/browser/project-context/memory-panel.test.tsx`

- [x] T-03 smoke:context + 门禁 — Blocked by: T-02
  - 既有 5 条记忆上搜索「Current context goal」，断言命中当前目标、不出现「Initial context goal」、可定位卡片；不为检索新开 Agent
  - 一次 `npm run build`、一次 `npx vitest run`、`npx tsc --noEmit`、`npm run smoke:context`
  - 若全量套件单文件明显拖慢（远超既有 ~2min），先加用例级 timeout 或收窄 I/O，禁止放宽全局 testTimeout
  - 然后停，交父会话 ship（hf-code-review 豁免已记录）
