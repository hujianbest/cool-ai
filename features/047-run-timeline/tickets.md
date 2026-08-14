# 任务票 — 运行轨迹时间轴

- 状态: spec/architecture 豁免；轻量级零 schema，hf-code-review 豁免
- 规模: 3 张纵向票
- TDD: 每票一个行为 RED → 最小 GREEN；禁止全量套件直到 T-03

- [x] T-01 listProjectTimeline + GET — Blocked by: None
  - GREEN: 正序、mission 过滤、去重留最小 seq、sourceMissing、跨项目 404、未知 query 400
  - 命令: `npm test -- tests/modules/operations-projection/run-timeline.test.ts tests/modules/operations-projection/run-timeline.api.test.ts`；`npx tsc --noEmit`
  - 禁止 schema identity 变更；禁止写 outbox

- [x] T-02 审计面板时间轴视图 — Blocked by: T-01
  - jsdom audit-panel：视图切换「时间轴」；正序；来源链接与「来源缺失」；≥44px；loading/empty/error
  - 命令: `npm test -- tests/browser/project-context/audit-panel.test.tsx`（若文件名不同则对现有审计面板测试）

- [x] T-03 smoke:execution + 门禁 — Blocked by: T-02
  - 既有运行时/审计段：打开时间轴，断言至少一条正序轨迹、有定位或来源缺失、无密钥
  - `npx tsc --noEmit`、`npm run build`、一次 `npx vitest run`、`npm run smoke:execution`
  - 不为时间轴新开 Agent 执行。用例级 timeout 仅 5s flake。停，交父会话 ship
