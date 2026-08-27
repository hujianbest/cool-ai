# 任务票 — 服务健康与可观察性中心

- 状态: done；T-01～T-05 已 ship
- 规模: 5 张纵向 RED/GREEN 票
- 公共缝: Operations Projection queries、`GET /api/health`、Team 健康 region

- [x] T-01 聚合健康查询 — Blocked by: None
  - RED: 无统一 DTO，无法区分 app/provider/index/execution 或 unknown。
  - GREEN: `getServiceHealth` 组合既有信号；无项目时索引/执行 unknown；零 schema。
  - 验证: query 聚焦测试。

- [x] T-02 GET `/api/health` — Blocked by: T-01
  - RED: Owner 无法经 API 读取健康。
  - GREEN: 严格查询、可选 projectId、no-store、稳定错误；GET 无外部调用。
  - 验证: API 测试与 `npx tsc --noEmit`。

- [x] T-03 `/team` 健康 region — Blocked by: T-02
  - RED: 团队页没有四卡或把 unknown 画成成功。
  - GREEN: UCD §9.3.6；loading/empty/error/disabled/success/focus；≥44px。
  - 验证: jsdom + axe。

- [x] T-04 恢复深链 — Blocked by: T-03
  - RED: 卡片没有可达的既有恢复入口。
  - GREEN: 模型服务→providers；索引→记忆视图重建（需项目）；执行→审批/审计；不可达时 disabled。
  - 验证: jsdom + `smoke:settings` 亮/暗/窄屏。

- [x] T-05 收口 — Blocked by: T-04
  - 验证: 聚焦 → `npx tsc --noEmit` → `npm run build` → `npm run smoke:settings` → 全量 `npm test`。
  - review: 确认无跨 owner 写、无 GET 外部动作、无正文/路径泄漏。
  - 进展: 回写 feature/product/backlog，ship 后进入下一计划切片。
