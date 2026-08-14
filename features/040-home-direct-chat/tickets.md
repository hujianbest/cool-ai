# 任务票 — 无项目时单 Agent 聊天

- 状态: 项目级 review 豁免，直接进入 implement
- 规模: 5 张纵向 RED/GREEN 票
- 公共缝: Direct-home Command/Query；GET /api/home；TaskPanel 无项目中栏
- TDD: 每票一个行为 RED → 最小 GREEN；内存库；个人项目用 `createProject` + 未 bind

- [x] T-01 个人对话容器：单例 + 允许 1 成员 — Blocked by: None
  - 公共缝: Project & Workspace Command。
  - RED: 未绑定项目 `replaceMembers` 仍拒绝 1 人；没有 ensureDirectProject。
  - GREEN: `ensureDirectProject` 幂等创建名称「个人对话」且未绑定的 Project；`setDirectChatAgent` 仅对未绑定项目写入恰好 1 名成员；已绑定工作区的项目仍 too_small。无 Agent 时 set 失败关闭。零 schema bump。
  - 命令: `npm test -- tests/modules/project-workspace/`；`npx tsc --noEmit`
  - 验证: 11 files / 75 tests 通过；tsc 通过。

- [x] T-02 GET /api/home — Blocked by: T-01
  - 公共缝: 入站 route。
  - RED: 无该路由。
  - GREEN: 无 Agent → 稳定 `{ kind: "needs_agent" }`；有 Agent → 确保容器并返回 `{ kind: "ready", project, agent, threads }`（threads 可空数组）。未知错误脱敏。composition 导出。
  - 命令: 新 API 测试文件 + sanitization 如触及
  - 验证: home API 2 tests 与 fallback 脱敏覆盖通过。

- [x] T-03 无项目中栏改为 1:1 聊天列 — Blocked by: T-02
  - 公共缝: jsdom TaskPanel / ProjectPanel。
  - RED: 无 projectId 仍渲染「请先创建或选择项目，再运行任务」。
  - GREEN: 无 projectId 时拉 /api/home；ready 则渲染 CollaborationPanel（chat）；needs_agent 则引导配置 Agent；隐藏使命看板与执行面板；标题用 Agent 名。有 projectId 的群聊路径不回归。
  - 命令: 聚焦 task-panel / cockpit-layout / collaboration jsdom
  - 验证: home loading/needs-agent/ready/error+retry 组件状态 3 tests 通过。

- [x] T-04 `/` 左侧列出个人对话 Thread — Blocked by: T-03
  - 公共缝: jsdom 项目导航。
  - RED: 无项目时没有 Thread 目录。
  - GREEN: `/` 且 home ready 时 ProjectThreadNavigation 使用个人项目 id；可新建对话（既有 threads POST）。不在个人对话启用多人策略编辑。
  - 命令: 聚焦 project-panel / project-thread-navigation jsdom
  - 验证: direct home 导航 4 tests、线程目录 19 tests、单 Agent composer 7 tests 通过。

- [x] T-05 冒烟与收口 — Blocked by: T-04
  - 验证: 受影响 smoke（至少 `npm run smoke` 打开 `/` 见到聊天 composer 或 needs_agent 引导）；全量 vitest 一次；tsc；build。勾选票；progress/backlog。
  - 命令: `npm run smoke`；`npx vitest run`；`npx tsc --noEmit`；`npm run build`
  - 验证记录（2026-08-15）: `npm run smoke` 在 `/` 无 Agent 时保留「先配置一个 Agent，即可开始个人对话」并验证打开文件夹后进入 basename 项目；`npm run smoke:onboarding` 验证个人对话容器与文件夹项目并存时的未知写核对。最终 `npx tsc --noEmit`、284 files / 2598 tests 的 `npx vitest run`、两项 smoke 与 `npm run build` 全绿；首次失败分别定位为旧 production build、harness 取 `projects[0]` 命中个人容器，以及核对时未过滤「个人对话」，修复后均通过。
