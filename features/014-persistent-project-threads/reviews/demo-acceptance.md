# Demo 验收 (S-12 / 项目内持久线程与上下文续接)

- 日期: 2026-08-09
- 验收方式: subagent 检查真实浏览器机器证据
- 结论: 接受
- 用户确认: auto-approved 2026-08-09

## 证据

- `evidence/persistent-threads-results.json`
- `evidence/persistent-threads-desktop.png`
- `evidence/persistent-threads-narrow.png`
- `evidence/persistent-threads-policy-repair.png`

## 验收摘要

- JSON 总状态为 `passed`，11 个行为 assertions 全部为 `passed`；4 个 axe 状态的 `blocking`、`contrast` 均为空，`violationCount` 均为 0。
- 桌面证据可辨认项目内线程列表、稳定选中线程、显式 run 选择、当前成员策略及策略修复入口；创建、切换、继续协作等 CTA 清晰可见。
- 窄屏证据中的显式 run 选择、未选择状态、运行控制与策略管理 CTA 可读且可操作，未见内容重叠、截断或遮挡。
- 策略修复证据清楚显示不可用成员状态、当前策略与修复入口；修复后的协作表面、线程内容和后续 CTA 层级清晰，未见遮挡或影响阅读的问题。
