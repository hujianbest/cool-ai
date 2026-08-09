# 回复引用与来源跳转需求规格

- 日期: 2026-08-10
- 特性: 022-reply-references
- 对应切片: S-14（CI-2.11）
- 模式: 建造
- 用户可感知: 是
- 执行模式: auto（用户不在场，问题按助手推荐处理并记录假设）
- 共享理解来源: `product/backlog.md` S-14 条目（演示判据/约束/准入已在 backlog 治理中确认；视为 auto-approved，不重新访谈）
- 公共行为接缝: Thread Message Command（发消息）与 Thread Message Public Read；`openDatabase(databasePath)`；fact-only Transcript UI
- 主子系统: Public Collaboration；主 Capability: `CAP-COL-02`（本片建立其回复引用、精确跳转与不可用占位部分）

## 问题陈述

当前线程消息是纯顺序流，owner/Agent 无法回复某条具体消息，也无法从回复跳回精确来源；讨论分叉后上下文依赖人工复述，来源 tuple 无法被引用方可靠携带。若将来来源不可用时 UI 也没有稳定占位约定，容易伪造或误导向内容。

## 解决方案

写时把回复目标冻结为正式事实：提交消息时可选携带 `replyToMessageId`，同一事务内在同 thread tuple 下验证目标存在且为合法消息行，冻结 `{messageId, sequence, authorDisplayName, excerpt}` 公开快照（excerpt 复用现有凭据分类与 grapheme 限长脱敏）。读侧只投影冻结快照与规范跳转身份，绝不在读取时重新解释来源正文；UI 引用片点击后按 canonical message 身份精确滚动/高亮，跨分页时先加载目标所在页；来源不可用（目标缺失、跨 tuple、数据损坏）时显示稳定占位，不伪造内容。`openDatabase` 对回复边做全集双向校验：每条回复引用恰好指向同线程一条既有消息，快照与目标一致（消息 append-only 不可变），孤儿/跨 tuple/快照分歧失败关闭。

## 用户故事

1. **作为 owner，我想回复某条消息并让读者看到来源上下文，从而分叉讨论不失联。**
   - 提交消息可携带同线程既有消息的 `replyToMessageId`；目标不存在、跨 thread/project 或指向自身未来的消息均稳定脱敏失败，不产生任何写入。
   - 快照在提交事务内冻结：作者显示名、sequence、经脱敏与 grapheme 限长的 excerpt；目标消息为 Agent 消息时作者名同样冻结当时值。
2. **作为 owner，我想从引用一键跳回精确来源，从而核对原话。**
   - 引用片显示"回复 #sequence · 作者 · 摘要"，可键盘激活；点击滚动到目标消息并短暂高亮。
   - 目标不在当前已加载页时，先按其 sequence 加载所在页再定位；加载中/失败有明确状态，不静默丢失。
3. **作为 owner，我想来源不可用时看到稳定占位，从而不被伪造内容误导。**
   - 目标在读取时不可得（含数据损坏导致整条消息被裁掉）时，引用片显示中性占位（不含伪造作者/正文），跳转动作禁用且原因可感知。
   - 占位不写入新事实、不改变原消息任何字段。
4. **作为维护者，我想 reopen 拒绝非法回复边，从而 current 数据不会被误当成合法历史。**
   - 全集双向：每条带回复快照的消息必须存在同 tuple 目标消息；快照字段与目标当前事实逐字段一致（消息 append-only）。
   - 孤儿目标、跨 thread/project 引用、自引用、快照分歧、sequence 矛盾均失败关闭且 opener 零修复写。

## 实现决策

- Command Interface 扩展既有发消息命令（不新增第二命令面）：`replyToMessageId` 可选，校验失败复用稳定脱敏 envelope。
- schema 变化遵守唯一 current canonical 规则（ADR-0003）：直接在 `CURRENT_SCHEMA` 为 `collaboration_messages` 增加回复快照列并更换 identity；无 migration/backfill/legacy 分支；fresh bootstrap 与 exact reopen tests 同步。
- 快照冻结沿用 S-13/017 先例：写入时脱敏（凭据分类器拒绝敏感文本为 fail-closed）、grapheme 限长 fail-closed；读侧只解码冻结事实。
- 跳转身份使用 canonical `(projectId, threadId, messageId)` + sequence 锚点；前端经既有分页查询按 sequence 定位，不引入第二消息状态机。
- 回复仅针对普通文本/结构化消息行；run_event 等非消息 fact 不可作为回复目标。

## 测试决策

- TDD 每轮一个公共缝 RED + 最小 GREEN；不测试私有 helper；不弱化断言。
- **Command seam**：合法回复提交（owner/agent 目标各一）、目标缺失/跨 tuple/自引用/非法形状的拒绝矩阵；断言零写入与稳定错误码。
- **Read + `openDatabase` seam**：分页读取返回冻结快照；owner fixture 建合法图后做 orphan/cross-tuple/self/快照分歧单一 corruption，reopen 全部稳定脱敏失败。
- **UI seam（jsdom 组件测试）**：引用片渲染、键盘激活、jump 滚动与高亮、跨页加载定位、不可用占位、loading/error/disabled/focus 状态。
- **浏览器验收**：`smoke:threads` 或新增最小 smoke 段覆盖回复→跳转→占位，desktop/narrow、light/dark、keyboard、axe 无 serious/critical；DOM/API/log/证据无宿主路径/凭据。

## 范围外事项

- 回复通知、引用计数、多级嵌套视图、编辑/删除已发消息与回复、对 run_event 等非消息 fact 的引用。
- 消息删除能力本身（S-20 线程回收站只管线程级；消息级删除另行切片）。
- 搜索引用关系（S-17 范围）、批量操作。

## 补充说明

- 单一用户结果（回复并跳回来源）、两个紧密耦合公共 seam（命令/读取 + UI），预计 4 张票，不触发拆片阈值。
- 评审按项目级 review 豁免跳过；不伪造评审工件。
- 用户确认: backlog S-14 条目视为 auto-approved（2026-08-10 记录）。
