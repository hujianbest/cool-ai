# 任务票 — SOP 状态投影

- 状态: spec/architecture 豁免，直接 implement；verified-handle 故收口前 hf-code-review
- 规模: 3 张纵向票；单一「看来源化流程状态」用户结果
- TDD: 每票一个行为 RED → 最小 GREEN；内存库 + 真实临时工作区；禁止全量套件直到 T-03

- [x] T-01 SOP 查询读模型 — Blocked by: None
  - 公共缝: `getSopStateProjection` + GET `/api/projects/:projectId/sop-state`
  - RED: 查询不存在；发现/匹配/陈旧/未绑定未定义
  - GREEN: 发现最多 20 个 `features/*/progress.md`；解析阶段与特性名；匹配 work item；freshness；未绑定 200；宿主路径与正文不泄漏；装配根登记
  - 命令: `npm test -- tests/modules/mission-work/sop-state-projection.test.ts`；相关 API 测试；`npx tsc --noEmit`
  - 禁止: `npx vitest run` 全量；启动第二个 next dev

- [x] T-02 流程状态 UI — Blocked by: T-01
  - 公共缝: jsdom 使命看板 SOP 区
  - GREEN: region「流程状态」；来源相对路径、声明阶段、匹配任务状态、陈旧提示、empty/unbound/loading/error；44px；定位任务
  - 命令: `npm test -- tests/browser/project-context/sop-state-panel.test.tsx tests/browser/project-context/mission-board.test.tsx`

- [x] T-03 浏览器验收 + 门禁 — Blocked by: T-02
  - 在 `smoke:context` 既有 `real-workspace` 写入 `features/demo-sop/progress.md`，断言面板与 axe；不为 SOP 新开 Agent 执行
  - 一次 `npm run build`、一次 `npx vitest run`、`npx tsc --noEmit`
  - 然后停，交父会话做 hf-code-review
