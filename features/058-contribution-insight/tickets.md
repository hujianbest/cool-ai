# 任务票 — 平等协作贡献视图

- 状态: done；T-01～T-05 已 ship
- 规模: 5 张纵向 RED/GREEN 票
- 公共缝: Operations Projection queries、`GET /api/contribution`、Team 贡献 region

- [x] T-01 贡献查询 — Blocked by: None
  - RED: 无按职责的贡献 DTO。
  - GREEN: `getContributionInsight` 组合工作项与复核；无项目 unknown；零 schema；不用用量当分数。
  - 验证: query 聚焦测试。

- [x] T-02 GET `/api/contribution` — Blocked by: T-01
  - RED: Owner 无法经 API 读取贡献。
  - GREEN: 严格查询、no-store、`disclaimer: "not_ranking"`。
  - 验证: API 测试与 `npx tsc --noEmit`。

- [x] T-03 `/team` 贡献 region — Blocked by: T-02
  - RED: 团队页没有贡献视图或画成排行榜。
  - GREEN: UCD §9.3.8；「这不是排行榜」；全态；≥44px。
  - 验证: jsdom。

- [x] T-04 证据导航 — Blocked by: T-03
  - RED: 证据无法跳到任务/复核既有入口。
  - GREEN: 每角色最多 5 条证据；工作项深链 `/projects/:id/tasks/:workItemId`，复核深链 `/projects/:id/reviews/:attemptId`；无项目时「打开任务」disabled。
  - 验证: jsdom + `smoke:settings`。

- [x] T-05 收口 — Blocked by: T-04
  - 验证: 聚焦 → `tsc` → `build` → `smoke:settings` → 全量 `npm test`。
  - 进展: ship 后取计划下一项。
