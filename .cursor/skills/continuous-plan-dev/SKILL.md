---
name: continuous-plan-dev
description: Continues Cool AI development from product/development-plan.md and product/progress.md without pausing after each ticket. After finishing a slice or ticket, immediately start the next planned item. Use when developing, implementing, continuing, shipping, auto-dev, 继续, 开发, 按计划, or when progress.md execution mode is auto. Do not stop to summarize or ask whether to continue.
---

# 持续按计划开发

`product/` 已经明确了要开发的内容和开发计划。agent 持续按计划开发就行，不应该停下来。

完成一张票、一个切片或一次验收之后，立刻进入下一项。不要停下来总结，不要询问是否继续。

## 何时使用

- 本仓库里实现、继续、开发、auto、按计划推进
- `product/progress.md` 或当前特性 `progress.md` 的执行模式为 `auto`（本仓库默认如此）
- 刚勾完一张任务票、刚 ship 一个切片、刚写完一段进展

纯问答、只读解释、用户明确只要这一项时，不要用本技能开新切片。

## 循环（回合未完成，直到命中停止条件）

1. 读 `product/development-plan.md`：当前阶段、切片顺序、开发步骤规则。
2. 读 `product/progress.md` 与当前特性 `features/*/progress.md`：下一步，不靠聊天记忆。
3. 取**下一未完成项**（票 → 切片 → 计划中的下一阶段）。对照 `product/ui/UI设计.md` / `DESIGN.md` 与 `product/词汇表.md`。
4. 按 `AGENTS.md` 做完这一项（TDD、契约、前端须真实浏览器核对）。
5. 回写 `progress.md`：一行事实（做了什么、下一步是什么）。不是给用户的长总结。
6. **不要结束回合。** 马上从步骤 1 取下一项并开工。

面向用户的话只报当前在做哪一项，不要写成「本轮已完成，等你指示」。

## 禁止

- 做完一项后写长总结并等待
- 「需要我继续吗？」「要不要进入下一张票？」
- 把勾票、测试绿、ship、演示验收当成会话终点
- 用聊天历史代替 `progress.md` 判断下一步
- 另造计划外的主路径控件、文案或切片

## 只在这些情况停下

- 计划已穷尽，且 `progress.md` 写明无下一步
- 安全、密钥、不可假设的硬阻塞（写入 `progress.md` 后停）
- 用户本回合明确说停、只做这一项、或不要继续

上下文将满时：把状态压进 `progress.md`，下一句仍是正在开始的下一项，而不是回顾。

## 对错示例

**错（停下来）：**
> 已完成 T-03，聚焦测试 12/12，build 绿。需要我继续 T-04 吗？

**对（接着做）：**
> T-03 已回写 `progress.md`。按计划开始 T-04：会话侧栏回收站入口。

## 欠定点

人不在场。按 `AGENTS.md` 与产品文档默认选择，写入 `product/assumptions.md` 后继续。用户可感知演示记为 auto-approved，下次交互再呈上。
