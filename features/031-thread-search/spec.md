# 线程搜索与精确定位需求规格

- 日期: 2026-08-10
- 特性: 031-thread-search
- 对应切片: S-17（CI-2.5）
- 模式: 建造
- 用户可感知: 是
- 执行模式: auto（用户不在场，问题按助手推荐处理并记录假设）
- 共享理解来源: `product/backlog.md` S-17 条目（auto-approved 2026-08-10）；前置 `CAP-COL-01`（已交付核心）、S-23 AUD-MVP（028 已 ship）+ AUD-COL（030 已 ship）
- 公共行为接缝: Thread Search Projection Consumer（Operations Projection）；Thread Search Query；线程区搜索 UI
- 主子系统: Operations Projection；主 Capability: `CAP-OPS-02`（本片建立其项目隔离线程索引与定位部分）

## 问题陈述

线程与消息越积越多，owner 无法按标题或内容找回讨论；只能人工翻列表。搜索必须项目隔离、能定位到匹配消息，且索引绝不包含敏感内容。

## 解决方案

在 028 投影基座上建立线程搜索索引投影：消费协作 outbox 事件（线程创建/消息），把可检索文本（线程标题、消息正文）派生进搜索索引表；提供项目作用域搜索查询（标题+内容、匹配摘要、稳定排序）；线程区新增搜索入口，结果可精确跳转到线程与消息。索引只读派生、可确定性 rebuild（复用基座协议），敏感内容（写路径已 [redacted] 降级/脱敏的消息）不进入索引正文。

## 用户故事

1. **作为 owner，我想按标题和内容搜索当前项目线程，从而快速找回讨论。**
   - 搜索框输入即时查询（防抖）；结果含线程标题、匹配消息摘要（命中上下文片段）、时间；稳定排序（消息时间倒序+id 决胜）。
   - 空结果/加载/错误全态；查询不记录敏感正文（查询日志不落正文——本片无查询日志，记假设）。
2. **作为 owner，我想从结果精确定位匹配消息，从而直达上下文。**
   - 点击结果跳转到线程并滚动定位到该消息（复用/扩展 022 的消息定位机制到 URL 深层链接）。
   - 被删或不可用来源显示稳定占位（消息不可变，主要来自 022 的不可用语义）。
3. **作为 owner，我相信搜索绝不跨项目泄漏，从而放心检索。**
   - 索引行与查询都按 project_id 强约束；tuple 校验与跨项目 404；reopen 不变量覆盖索引⊆事实源。

## 实现决策

- schema identity 16→17：新表 `thread_search_index`（project_id、thread_id、message_id（线程标题行可为空语义或单独 kind 列）、kind: "thread_title"|"message"、content TEXT、occurred_at、source_seq（来源游标：消息 sequence/事件 outbox_seq——勘察后定）、UNIQUE 约束）；write-ownership 登记 operations-projection。
- 索引方式：先验证 node:sqlite FTS5 可用性（`CREATE VIRTUAL TABLE ... USING fts5`）；可用则用 FTS5 虚表（内容列 + 外部内容或独立行），不可用则 LIKE contains + 大小写折叠（SQLite LIKE 仅 ASCII 折叠——中文 contains 语义可接受，记录假设）。决策与证据记 progress。
- Consumer：新 consumer_id（如 "thread_search"）复用 checkpoints 表协议；catch-up 触发源=outbox 协作消息事件（messageId）→ 回查 `collaboration_messages` 取正文（同库只读派生，不回写源）；线程标题取自线程创建/现有 threads 表（rebuild 时全量扫，增量由事件驱动；标题改名事件若无则 rebuild 兜底——勘察 threads 更新路径）。
- 敏感边界：源消息正文经写路径既有 public-text 校验（敏感 fail-closed 或 [redacted]）；索引只存已落库的公开正文，不再二次分类（与审计投影同源语义一致，记假设）。
- Query：`searchProjectThreads(databasePath, projectId, {query, limit, cursor?})`：title+content 匹配、snippet（命中前后文窗口截断）、稳定排序、tuple 404；读路径同步 catchUp（MVP 同 028 先例）。
- UI：线程区顶部搜索框（现有线程面板内，形态贴合）；结果列表（键盘可达、44px）；点击 → 扩展项目选择 URL `?thread=..&message=..`（parseProjectSelection 扩展 message 参数）→ collaboration 面板滚动定位该消息（复用 022 内部 ref 缝，加 URL 入口）。
- 错误稳定脱敏；查询超时保护（limit 上限）。

## 测试决策

- TDD 每轮一个公共缝 RED + 最小 GREEN；内存库夹具。
- **Consumer 缝**：消息/标题入索引、幂等重放、rebuild 确定性、敏感降级不入正文、tuple 隔离。
- **Query 缝**：标题命中、内容命中、snippet 窗口、排序决胜、空查询/空结果、分页、跨项目 404。
- **UI 缝**：搜索交互、结果渲染、键盘、跳转 URL 生成与消息定位、状态矩阵。
- **浏览器验收**：smoke:threads 增加搜索段：真实造数 → 搜索标题/内容 → 结果呈现 → 跳转定位消息 → 跨项目隔离 → desktop/narrow、light/dark、keyboard、axe。

## 范围外事项

- 全文高亮多关键词、过滤面（按作者/时间/类型）、跨项目搜索、知识记忆搜索（S-28）、搜索索引健康诊断（S-29）。
- 中文分词与相关性排序调优。

## 补充说明

- 单一用户结果（搜到并直达讨论）；4 张票；基座复用使本片聚焦索引与定位。
- 评审按项目级 review 豁免跳过；默认选择记入 product/assumptions.md。
