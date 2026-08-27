# 任务票 — 记忆索引状态与健康诊断

- 状态: done；T-01～T-05 已 ship
- 规模: 5 张纵向 RED/GREEN 票
- 公共缝: Operations Projection commands/queries、memory-index API、MemoryPanel

- [x] T-01 索引 schema 与增量 consumer — Blocked by: None
  - RED: 无专用索引/state，新增或 supersede Memory 后无法判定/补齐 active-head coverage。
  - GREEN: schema 27→28；普通 SQLite index/state；watermark catch-up 幂等；hash/invariant/owner 登记；不写 Knowledge 来源。
  - 验证: consumer + current-schema + data-invariant + architecture 聚焦测试。

- [x] T-02 健康查询与 GET API — Blocked by: None
  - RED: Owner 无法区分 empty/caught-up/behind/rebuilding/failed 或索引漂移。
  - GREEN: project-scoped health DTO、coverage/hash/freshness、稳定脱敏错误、no-store；canonical search 不依赖索引。
  - 验证: query/API 测试与 `npx tsc --noEmit`。

- [x] T-03 强确认重建命令 — Blocked by: None
  - RED: 无安全修复入口；重复、并发与陈旧请求不可判定。
  - GREEN: strict POST；operation/hash + expectedVersion；acquire/checkpoint/finalize；确认词；失败保留来源并显式状态；完成 receipt 可重放。
  - 验证: rebuild service/API、崩溃点、并发、跨项目与脱敏测试。

- [x] T-04 「记忆」视图健康条与修复交互 — Blocked by: None
  - RED: 记忆视图没有索引状态、降级说明或修复入口。
  - GREEN: UCD §9.2.4 健康条；覆盖/落后/错误；强确认对话框；重建后刷新；S-28 搜索在 degraded 时保持。
  - 验证: jsdom loading/empty/error/disabled/success/focus + axe；亮/暗/窄屏真实浏览器。

- [x] T-05 收口 — Blocked by: T-04
  - 验证: 聚焦测试 → `npx tsc --noEmit` → `npm run build` → `npm run smoke:settings`（含记忆健康条亮/暗/窄屏）→ 全量 `npm test`。
  - review: schema / 投影重建写路径触发 code review；检查跨 owner 写、hash/正文泄漏、operation 重放与来源保留。
  - 进展: 回写 feature/product/backlog，ship 后立即进入下一计划切片。
