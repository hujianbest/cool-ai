# 任务票 — 脱敏对话与项目数据导出

- 状态: done；T-01～T-05 已 ship
- 规模: 5 张纵向 RED/GREEN 票
- 公共缝: Operations Projection queries、`GET /api/projects/:projectId/export`、审计导出确认

- [x] T-01 导出组装 — Blocked by: None
  - RED: 无带范围/版本/hash 的脱敏导出 DTO。
  - GREEN: `getRedactedExport` 组合公开消息与审计事件；项目隔离；超限失败关闭；零 schema。
  - 验证: query 聚焦测试。

- [x] T-02 GET `/api/projects/:projectId/export` — Blocked by: T-01
  - RED: Owner 无法经 API 下载导出包。
  - GREEN: 严格路径/查询、no-store、未知项目 404；可选 threadId。
  - 验证: API 测试与 `npx tsc --noEmit`。

- [x] T-03 审计「导出脱敏包」 — Blocked by: T-02
  - RED: 审计视图没有导出入口。
  - GREEN: UCD §9.2.6；确认范围后下载；取消不请求。
  - 验证: jsdom。

- [x] T-04 脱敏与 hash — Blocked by: T-03
  - RED: 包可能泄漏凭据/路径/隐藏推理，或缺少可核对 hash。
  - GREEN: 禁止泄漏标记；`contentHash` 对规范 JSON 稳定。
  - 验证: query/API 聚焦测试。

- [x] T-05 收口 — Blocked by: T-04
  - 验证: 聚焦 → `tsc` → `build` → 审计 jsdom → 全量 `npm test`。
  - review: 安全边界（脱敏、无工作区写、无跨 owner 写）；hf-code-review。
  - 进展: ship 后取计划下一项（S-40）。
