# 消息队列、重排与 Steer 需求规格

- 日期: 2026-08-12
- 特性: 034-thread-message-queue-steer
- 对应切片: S-21（CI-2.9）
- 模式: 建造
- 用户可感知: 是
- 执行模式: auto（用户不在场，问题按助手推荐处理并记录假设）
- 共享理解来源: `product/backlog.md` S-21（前置 `CAP-COL-01`、`CAP-EXE-01`、`CAP-GOV-02`、`CAP-COL-03` 均已交付）
- 公共行为接缝: Thread Queue Command、Thread Queue Query、Steer Guard（Public Collaboration）
- 主子系统: Public Collaboration；主 Capability: `CAP-COL-04`

## 问题陈述

当前 owner 发送消息要么立即附着到活动运行，要么在无活动运行时触发新一轮。用户无法先组织一组待处理输入、调整先后顺序、撤回误发内容，也无法在“线程 A 活跃、线程 B 仍需补充输入”的场景下得到可解释的排队语义，导致协作流难以控节奏。

## 解决方案

在线程级引入显式 owner 消息队列：owner 发送到“待处理队列”而非直接驱动动作；当线程进入可执行窗口时按顺序消费。提供三种控制：撤回未消费消息、在队列内重排、对队列头执行 steer（继续/暂停/改派）并受运行与治理约束。所有队列写操作维持 operation/version 语义并写审计事件；跨线程有活动运行时，其他线程仍允许入队但不自动启动新运行。

## 用户故事

1. 作为 owner，我希望把输入先排队，再决定何时执行。
   - 在无活动运行或他线程活跃运行时，发送动作创建队列项，不自动开新运行。
   - 队列项显示创建时间、摘要、状态（pending/consumed/cancelled）。
2. 作为 owner，我希望撤回或重排尚未执行的输入，避免误操作。
   - 只能对 pending 队列项执行撤回与重排；已消费项不可变。
   - 重排后顺序立即可见，刷新/重启保持一致。
3. 作为 owner，我希望在高风险 steer 前看到明确边界。
   - steer 仅作用于队列头或显式选中 pending 项。
   - 与运行态冲突时失败关闭并返回稳定错误（不 silent fallback）。

## 验收判据

- 队列读写：入队、撤回、重排均具幂等/冲突语义；跨项目无泄漏。
- 消费语义：线程恢复可执行窗口后按顺序消费 pending 项；不跳项、不重复消费。
- UI：线程区可见队列、支持撤回/重排/steer，包含 loading/empty/error/disabled 状态。
- 安全：高风险 steer 不绕过既有治理；错误脱敏且可解释。
- 质量：受影响 browser 测试、模块测试、`npx tsc --noEmit`、`npm run build` 通过。

## 范围外事项

- 跨线程全局队列（本片仅线程内队列）。
- 队列项编辑历史与版本 diff 展示（保留后续切片）。
- 自动策略推荐重排（本片只支持 owner 显式操作）。
