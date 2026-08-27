# 任务票 — 本地只读交付回放

- 状态: done；T-01～T-05 已 ship
- 规模: 5 张纵向 RED/GREEN 票
- 公共缝: Operations Projection、`GET /api/projects/:projectId/replay`、审计时间轴

- [x] T-01 回放查询 — Blocked by: None
  - RED: 无按 run 冻结的回放 DTO。
  - GREEN: `getDeliveryReplay` 复用时间轴公开事件；顺序稳定；replayHash；零 schema；不补造。
  - 验证: query 聚焦测试。

- [x] T-02 GET replay — Blocked by: T-01
  - RED: Owner 无法经 API 读取回放。
  - GREEN: 必填 runId、no-store、未知项目 404。
  - 验证: API 测试与 `tsc`。

- [x] T-03 时间轴「打开回放」 — Blocked by: T-02
  - RED: 时间轴不能打开回放。
  - GREEN: UCD §9.2.6；无 run 时 disabled。
  - 验证: jsdom。

- [x] T-04 来源跳转 — Blocked by: T-03
  - RED: 回放条目无法跳到既有来源。
  - GREEN: 复用审计面板 href；不可达 disabled。
  - 验证: jsdom。

- [x] T-05 收口 — Blocked by: T-04
  - 验证: 聚焦 → tsc → build → 审计 jsdom → 全量 `npm test`。
  - 进展: ship 后取计划下一项。
