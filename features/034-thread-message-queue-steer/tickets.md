# 任务票 — 消息队列、重排与 Steer

- 状态: 项目级 review 豁免生效，直接进入 implement
- 规模: 5 张纵向 RED/GREEN 票；单一「线程内待处理消息队列可控执行」用户结果
- 公共缝: Thread Queue Query / Command、Steer Guard、线程区队列 UI
- TDD: 每票先公共行为 RED，再最小 GREEN；数据库测试使用内存库夹具

- [x] T-01 队列 schema + 查询缝（listThreadQueue）— Blocked by: None
  - RED: 队列表/索引/查询不存在；线程查询无法返回 pending 队列。
  - GREEN: 新增 queue schema（identity +1）与 `listThreadQueue`，返回稳定顺序与状态字段。
  - 验证:
    - `npm test -- tests/adapters/sqlite/current-schema.test.ts tests/modules/public-collaboration/thread-queue-query.test.ts` ✅（16 passed）
    - `npx tsc --noEmit` ✅

- [x] T-02 入队与撤回命令 + 路由 — Blocked by: T-01
  - RED: enqueue/cancel 命令不存在或幂等错误。
  - GREEN: `enqueueThreadMessage`、`cancelQueuedMessage` 与 API 路由落地，保持 operation 语义。
  - 验证:
    - `npm test -- tests/modules/public-collaboration/thread-queue-command.test.ts tests/modules/public-collaboration/thread-queue-api.test.ts tests/modules/public-collaboration/thread-queue-query.test.ts` ✅（6 passed）
    - `npx tsc --noEmit` ✅

- [x] T-03 队列重排与消费接缝 — Blocked by: T-02
  - RED: 重排无序/重复消费。
  - GREEN: `reorderQueuedMessage` + 运行窗口消费队列头事务，确保顺序与去重。
  - 验证:
    - `npm test -- tests/modules/public-collaboration/thread-queue-command.test.ts tests/modules/public-collaboration/thread-run-start-api.test.ts tests/modules/public-collaboration/multi-thread-run-lifecycle.test.ts` ✅（28 passed）
    - `npx tsc --noEmit` ✅

- [x] T-04 steer 命令与线程区 UI — Blocked by: T-03
  - RED: 无 steer 控制或 UI 不可用。
  - GREEN: `steerQueuedMessage`（受治理边界）+ 队列面板（撤回/重排/steer）。
  - 验证:
    - `npm test -- tests/modules/public-collaboration/thread-queue-command.test.ts tests/browser/threads/thread-queue-ui.test.tsx` ✅（7 passed）
    - `npx tsc --noEmit` ✅

- [x] T-05 浏览器验收 + 全量验证 + ship — Blocked by: T-04
  - 验证: `smoke:threads` 新增队列段；`npx vitest run`、`npx tsc --noEmit`、`npm run build`。
  - 结果: `npm run smoke:threads` PASS（THREAD SMOKE PASS: assertions=57 axeStates=39 threads=4，034 桌面明/暗 + 窄屏三张证据图）；`npx vitest run` 276 文件 2512 用例全绿；`npx tsc --noEmit` 干净；`npm run build` 通过。同波次补齐 identity 19→20 断言迁移（12 文件）、write-ownership manifest 注册 `thread_message_queue`、review smoke 记忆断言作用域化与 team-skill-slice 用例级 timeout。
