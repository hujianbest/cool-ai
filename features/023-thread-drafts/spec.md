# 线程草稿恢复与输入历史需求规格

- 日期: 2026-08-10
- 特性: 023-thread-drafts
- 对应切片: S-15（CI-2.12）
- 模式: 建造
- 用户可感知: 是
- 执行模式: auto（用户不在场，问题按助手推荐处理并记录假设）
- 共享理解来源: `product/backlog.md` S-15 条目（auto-approved 2026-08-10）
- 公共行为接缝: Thread Draft Command/Query、Input History Command/Query（Public Collaboration，新 CAP-COL-04 部分）；fact-only Composer UI
- 主子系统: Public Collaboration；主 Capability: `CAP-COL-04`（本片建立其按线程草稿、输入历史与清除策略部分；消息队列/Steer 属 S-21）

## 问题陈述

当前 composer 刷新/切线程即丢失未发送文字、附件占位与回复意图；owner 也无法检索自己此前的输入或显式清除。没有持久草稿与历史，长线程协作中的撰写中断成本完全由 owner 承担。

## 解决方案

以线程为粒度持久化草稿：composer 内容经防抖自动保存（含附件占位与 `replyToMessageId` 链接），切换线程/刷新/重启后按规范 thread tuple 恢复原状；发送成功即清草稿。输入历史在每次 owner 成功发消息时记录一条正文快照，提供项目内搜索与一键显式清除；保存前经既有凭据分类器检查，命中敏感内容时跳过保存（不存秘密）并给出中性提示。保留策略采用最小决定：草稿始终按线程保留（发送/显式清除前不丢），历史可全局开关"记录新输入"，清除操作删除全部历史且只记录策略/清除事件本身而不记录内容。

## 用户故事

1. **作为 owner，我想未发送内容按线程恢复，从而中断后无损续写。**
   - 输入文字、附件占位与回复链接随输入自动保存（防抖）；切线程互不串扰；刷新/进程重启后恢复原内容、占位与回复目标。
   - 发送成功清空该线程草稿；显式清空（如清空按钮/Escape 约定）立即删除持久草稿。
   - 草稿内容命中敏感模式时不保存正文并给出中性提示，绝不写入秘密。
2. **作为 owner，我想搜索并管理自己的输入历史，从而复用措辞并保持可控。**
   - 每次成功发送 owner 消息记录一条输入历史（正文快照、thread/时间）；项目内按关键字搜索（大小写不敏感子串匹配即可），结果不跨项目。
   - 可显式清除全部历史；清除后列表为空，审计只记录"发生了清除"事件，不含被清内容。
   - 历史记录开关关闭时不再记录新输入；既有历史保留直至显式清除。
3. **作为 owner，我想这些能力服从现有界面层级，从而无需学习新视觉系统。**
   - 草稿恢复不改变消息壳布局；附件占位沿用 S-16 前的占位语义（仅存名称/大小占位元数据，不存文件内容）。
   - 历史入口在 composer 附近（如输入框工具区），桌面/窄屏均可用键盘完成搜索与清除；复用 Cool tokens/components。

## 实现决策

- 新表（唯一 current canonical 规则，identity 随变更更换）：`thread_drafts`（`(project_id, thread_id)` 唯一；content、附件占位 JSON、reply_to_message_id、version、updated_at）与 `input_history_entries`（id、project_id、thread_id、content、created_at；content 保存前凭据分类 fail-closed 跳过）。
- 草稿写入为幂等 upsert + version 递增；读取/恢复按 canonical tuple 校验；删除仅同 tuple。
- 历史只在 owner 消息正式提交成功的事务内同事务追加；重放同 operation 不产生第二条历史。
- 敏感策略：草稿正文与历史正文均过凭据分类器；命中即不落盘该文本（草稿降级为仅存占位/链接），UI 提示中性文案；不把敏感文本写入日志/错误。
- 开关（记录新输入历史）为本机非敏感偏好，沿用 S-9 偏好 Adapter 先例，不作为领域事实。
- UI 不引入第二状态机：composer 以服务端草稿为唯一恢复事实；本地编辑态经防抖提交。

## 测试决策

- TDD 每轮一个公共缝 RED + 最小 GREEN。
- **Draft seam**：保存/恢复/发送清除/显式清除/敏感跳过/附件占位与回复链接往返/跨 tuple 拒绝/重放幂等。
- **History seam**：发送同事务记录、同 operation 重放不重复、项目内搜索、跨项目隔离、显式清除、开关关闭不记录。
- **UI seam（jsdom）**：恢复填充、防抖保存触发、回复链接与占位 chips、敏感提示、历史搜索/清除交互、loading/empty/error/disabled/focus。
- **浏览器验收**：smoke 覆盖刷新恢复、发送清草稿、搜索与清除，desktop/narrow、light/dark、keyboard、axe 无 serious/critical；证据无凭据/宿主路径。

## 范围外事项

- 真实图片/文件附件上传（S-16）、消息队列与 steer（S-21）、历史分页浏览全量列表 UI 之外的统计、多设备同步。
- 对他人消息的引用通知、草稿的版本历史（只保留最新草稿）。

## 补充说明

- 单一用户结果（composer 连续性），两个同 Capability 内聚 seam，预计 5 张票，不触发拆片阈值。
- 评审按项目级 review 豁免跳过；默认选择记入 product/assumptions.md。
