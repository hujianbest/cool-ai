# 任务票 — 领域化运维命令与救援

- 状态: done
- 规模: 5 张纵向 RED/GREEN 票
- 公共缝: Safe Execution recovery commands/queries、recovery API、Execution 卡片

- [x] T-01 冻结目录查询 — Blocked by: None
  - RED: 无法按故障列出精确许可动作。
  - GREEN: project-scoped catalog；未知故障空目录；无自由输入字段。
  - 验证: query 聚焦测试。

- [x] T-02 只读预览 — Blocked by: T-01
  - RED: 执行前看不到影响。
  - GREEN: preview DTO；不改 Execution；未知 action 拒绝。
  - 验证: preview 测试。

- [x] T-03 execute/undo API — Blocked by: T-02
  - RED: 无法安全执行或拒绝未知路径。
  - GREEN: 确认词、operation/version、Approval 复用、跨项目 404、无自由命令。
  - 验证: command/API + 并发/重放。

- [x] T-04 Execution「救援」UI — Blocked by: T-03
  - RED: 卡片没有救援表面。
  - GREEN: UCD §9.4.5；选择器/预览/执行/撤销；未知不出现自由输入。
  - 验证: jsdom + 真实浏览器亮/暗/窄屏。

- [x] T-05 收口 — Blocked by: T-04
  - 验证: 聚焦 → tsc → build → `npm run smoke:execution` → 全量 `npm test`。
  - review: 高风险写路径；禁止自由命令与跨 owner 写。
