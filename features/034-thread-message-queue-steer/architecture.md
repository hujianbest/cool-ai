# 架构 — 消息队列、重排与 Steer

- 日期: 2026-08-12
- 对应规格: [`spec.md`](./spec.md)
- 状态: 项目级 review 豁免生效；未送独立评审，不伪造工件

## 架构目标

在不破坏现有 run/message 事实模型的前提下，引入可审计的线程内 owner 队列，并把“发送”从即时执行改为“可消费事实”。复杂性留在 Public Collaboration SQLite Adapter；UI 仅消费新队列查询与命令响应。

## 方案概览

1. 新增队列表（thread-scoped）与顺序键（position）。
2. 新增公开缝：
   - Query: `listThreadQueue`
   - Commands: `enqueueThreadMessage`, `cancelQueuedMessage`, `reorderQueuedMessage`, `steerQueuedMessage`
3. 与既有运行编排接缝：
   - 当线程进入可执行窗口时，从 pending 队列头消费一条，映射到既有 owner_message/run 事实流。
4. UI：
   - 在线程区新增“待处理消息”面板，支持撤回、上移/下移、steer。

## 数据与事务

- 新表建议（identity +1）：
  - `thread_message_queue`
  - 关键列：`id`, `project_id`, `thread_id`, `content`, `position`, `status`, `created_at`, `updated_at`, `operation_id`
  - 约束：`UNIQUE(project_id, thread_id, position)`；`status IN ('pending','consumed','cancelled')`
- 重排在单事务内执行，保持 `position` 连续与唯一。
- 消费在单事务内标记 `consumed` 并追加既有事实，避免重复执行。

## 接口边界

- 仅 owner 可写队列命令；agent 不直接入队。
- 线程已删除（S-20）统一复用 `ensureActiveThread`。
- 错误保持既有 envelope（`INVALID_INPUT` / `OPERATION_CONFLICT` / `RESOURCE_NOT_FOUND`）。

## 测试策略

- 模块测试：命令幂等、冲突、重排稳定性、消费顺序。
- adapter/schema 测试：identity、约束、不变量与 reopen。
- browser 测试：UI 交互 + 可访问性。
- smoke（threads）增加队列段，验证跨线程活跃运行时“可入队但不自动起跑”。
