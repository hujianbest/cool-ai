# 任务票 — 能力画像

- 状态: spec/architecture 豁免；轻量级零 schema，收口前 hf-code-review 豁免
- 规模: 3 张纵向票
- TDD: 每票一个行为 RED → 最小 GREEN；禁止全量套件直到 T-03

- [x] T-01 buildCapabilityInsight + GET — Blocked by: None
  - RED: 函数/路由不存在
  - GREEN: 成员画像；未指派 todo 建议与理由；已指派/非 todo 不建议；跨项目 404；DTO 无密钥/systemPrompt；Identity 代码不 SQL work_items
  - 命令: `npm test -- tests/modules/identity-capability/capability-insight.test.ts tests/modules/identity-capability/capability-insight.api.test.ts`；`npx tsc --noEmit`

- [x] T-02 看板画像与建议 UI — Blocked by: T-01
  - jsdom mission-board：region「能力画像」；建议 接受预填负责人、忽略隐藏；≥44px；loading/empty/error
  - 命令: `npm test -- tests/browser/project-context/mission-board.test.tsx`

- [x] T-03 smoke:context + 门禁 — Blocked by: T-02
  - 断言 Planner/Builder 画像可见；Plan task 或未指派任务上建议或 empty 可解释；无密钥泄漏
  - `npx tsc --noEmit`、`npm run build`、一次 `npx vitest run`、`npm run smoke:context`
  - 用例级 timeout 仅当 5s flake；禁止全局 testTimeout
  - 停，交父会话 ship
