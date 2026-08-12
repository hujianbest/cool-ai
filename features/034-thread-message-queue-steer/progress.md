# 进度

- 特性: 034-thread-message-queue-steer（对应切片: S-21 / CI-2.9）
- 当前阶段: done
- 执行模式: auto（用户 2026-08-09 明示：不在电脑前，问题按助手推荐处理）
- 已加载扩展: 无
- 下一步: 等待下一切片准入
- 用户可感知: 是
- 评审状态: 项目级 review 豁免（AGENTS.md 2026-08-09 起生效）

## 实施记录

- 2026-08-12 特性开立：基于 backlog S-21，前置 `CAP-COL-01`、`CAP-EXE-01`、`CAP-GOV-02`、`CAP-COL-03` 已满足；进入 implement。
- 2026-08-12 T-01 完成：落地 `thread_message_queue` canonical schema（identity 19→20）与 pending 索引，新增 public-collaboration 查询缝 `listThreadQueue`（只读，稳定排序 `position ASC, id ASC`，暴露状态字段 `pending|consumed|cancelled`）；补齐 DTO/query 公共接口与聚焦测试。
- 2026-08-12 T-01 验证：
  - `npm test -- tests/adapters/sqlite/current-schema.test.ts tests/modules/public-collaboration/thread-queue-query.test.ts` 通过（16 passed）
  - `npx tsc --noEmit` 通过
- 2026-08-12 T-02 完成：新增 `enqueueThreadMessage` / `cancelQueuedMessage` 命令缝（thread tuple 守卫 + operationId 幂等 + expectedVersion 冲突检查），并落地队列命令路由 `POST /api/projects/:projectId/threads/:threadId/queue` 与 `POST /api/projects/:projectId/threads/:threadId/queue/:queueItemId/cancel`（严格 JSON 输入、脱敏错误、`cache-control: no-store`）。
- 2026-08-12 T-02 验证：
  - `npm test -- tests/modules/public-collaboration/thread-queue-command.test.ts tests/modules/public-collaboration/thread-queue-api.test.ts tests/modules/public-collaboration/thread-queue-query.test.ts` 通过（6 passed）
  - `npx tsc --noEmit` 通过
- 2026-08-12 T-03 完成：新增 `reorderQueuedMessage` 命令缝（仅 pending 可重排、`expectedVersion` 冲突守卫、线程内 pending 队列稳定重排并保持 position 唯一/连续），并在 `startThreadRun` 进入可执行窗口时接入“按 position 消费 pending 队列头”事务接缝（同事务标记 consumed + 复用既有 owner_message/run fact 流，重复触发走 operation 重放避免重复消费）。
- 2026-08-12 T-03 验证：
  - `npm test -- tests/modules/public-collaboration/thread-queue-command.test.ts tests/modules/public-collaboration/thread-run-start-api.test.ts tests/modules/public-collaboration/multi-thread-run-lifecycle.test.ts` 通过（28 passed）
  - `npx tsc --noEmit` 通过
- 2026-08-12 T-04 完成：新增 `steerQueuedMessage` 命令缝（仅 pending 可操作、线程内提升到队列头、受治理边界限制：当 dispatch 非 ready 明确 `ACTION_CONFLICT` 禁用），并补齐队列路由 `GET /queue`、`POST /queue/:queueItemId/reorder`、`POST /queue/:queueItemId/steer`；线程区新增“待处理消息队列”面板（展开加载、empty/error、撤回/重排/steer 操作、steer 禁用提示、键盘可达）。
- 2026-08-12 T-04 验证：
  - `npm test -- tests/modules/public-collaboration/thread-queue-command.test.ts tests/browser/threads/thread-queue-ui.test.tsx` 通过（7 passed）
  - `npx tsc --noEmit` 通过
- 2026-08-12 T-05 完成（项目级 review 豁免，主会话收口）：`smoke:threads` 新增 034 队列验收段——API 入队三条 → UI 展开队列面板 → steer 提升队头（≥44px 控件断言）→ 下移重排 → 撤回 → 列表状态/位置逐项断言 → API 触发运行消费队头（`startThreadRun` 返回被消费内容、队列项转 consumed）→ 桌面明/暗 axe + 截图 → 窄屏「任务编辑·群聊」抽屉内复核 consumed 状态 + axe + 截图 + Escape 焦点归还；密钥/宿主路径泄漏扫描覆盖新增队列快照。三轮红绿式修复：桌面段运行由 API 触发后面板不自刷新（改 reload + 重新展开断言 consumed）；窄屏队列面板在「任务编辑·群聊」抽屉而非「当前任务上下文」抽屉（对齐 023/024 窄屏模式）；消费后内容同时出现在时间线与队列（断言作用域收窄到队列 region）。同波次迁移修补：identity 19→20 硬编码断言 12 文件、write-ownership manifest 注册 `thread_message_queue`（T-01 漏迁下游，全量红暴露）；预存 flake 加固——review smoke 记忆 marker 断言作用域到 `review-access-background`（context-surface 同文案歧义）、team-skill-slice I/O 重型用例补 case 级 timeout 20s；tsconfig include 的 smoke distDir 残留条目改泛化 glob 根治中断运行后的脏树噪声。验证：`npm run smoke:threads` PASS（57 断言 / 39 axe 状态 0 违规 / 034 三证据图）；`npx vitest run` 276 文件 2512 用例全绿（132.5s）；`npx tsc --noEmit` 通过；`npm run build` 通过。实现默认落台账 A-237。
