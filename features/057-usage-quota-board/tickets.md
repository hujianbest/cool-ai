# 任务票 — 用量与配额看板

- 状态: done；T-01～T-05 已 ship
- 规模: 5 张纵向 RED/GREEN 票
- 公共缝: Operations Projection queries、`GET /api/usage`、Team 用量 region

- [x] T-01 用量配额查询 — Blocked by: None
  - RED: 无统一 DTO，无法按项目/Run/Provider 区分已报告用量与未报告/非法调用。
  - GREEN: `getUsageQuota` 组合既有调用表与 Agent 上限；无项目时 unknown + 空列表；零 schema；不伪造 token。
  - 验证: query 聚焦测试。

- [x] T-02 GET `/api/usage` — Blocked by: T-01
  - RED: Owner 无法经 API 读取用量与配额。
  - GREEN: 严格查询、可选 projectId、no-store、稳定错误；GET 无外部调用；恒含 `disclaimer: "not_invoice"`。
  - 验证: API 测试与 `npx tsc --noEmit`。

- [x] T-03 `/team` 用量 region — Blocked by: T-02
  - RED: 团队页没有用量看板，或把空项目画成已有合计。
  - GREEN: UCD §9.3.7；loading/empty/error/disabled/success/focus；≥44px；可见「基础用量不是账单」。
  - 验证: jsdom + axe。

- [x] T-04 预算深链 — Blocked by: T-03
  - RED: 看板展示上限但没有可达的既有配置入口。
  - GREEN: 「配置 Agent」深链 §9.3.2；本片无预算写 API。
  - 验证: jsdom + `smoke:settings` 亮/暗/窄屏。

- [x] T-05 收口 — Blocked by: T-04
  - 验证: 聚焦 → `npx tsc --noEmit` → `npm run build` → `npm run smoke:settings` → 全量 `npm test`。
  - review: 确认无跨 owner 写、无 GET 外部动作、无正文/路径/凭据泄漏、无伪造 token。
  - 进展: 回写 feature/product/backlog，ship 后进入下一计划切片（S-37）。
