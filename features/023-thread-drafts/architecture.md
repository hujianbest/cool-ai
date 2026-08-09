# 架构 — 线程草稿恢复与输入历史

- 日期: 2026-08-10
- 对应规格: [`spec.md`](./spec.md)
- 状态: 项目级 review 豁免生效；未送独立评审，不伪造工件

## 架构目标

在 Public Collaboration 深模块内新增 CAP-COL-04 的草稿/历史两个内聚事实族；复杂性留在 Module + SQLite Adapter；composer UI 只消费只读/命令 Interface，不建第二状态机。

## Module 与 Interface

### Public Collaboration Module（扩展）

- Commands：`saveThreadDraft`（upsert + version）、`clearThreadDraft`、`clearInputHistory`；发消息命令同事务追加 input history（敏感跳过）。
- Queries：`readThreadDraft(projectId, threadId)`、`searchInputHistory(projectId, query)`。
- DTO：`ThreadDraftDto { content, attachments[], replyToMessageId, version, updatedAt }`；`InputHistoryEntryDto { id, threadId, content, createdAt }`。均项目隔离、脱敏。

### Current Schema（扩展）

- `thread_drafts`：`(project_id, thread_id)` 主键；`content TEXT NOT NULL`、`attachments_json TEXT NOT NULL DEFAULT '[]'`、`reply_to_message_id TEXT NULL`、`version INTEGER NOT NULL`、`updated_at TEXT NOT NULL`；FK 到 threads。
- `input_history_entries`：`id` 主键、`project_id/thread_id/content/created_at`；FK 到 projects/threads。
- identity 10→11；fresh bootstrap/exact reopen 测试同步；`current-data-invariants` 增补：draft 的 reply_to_message_id 若非空必须指向同 tuple 既有消息；history 行 tuple 合法。不校验 content 内容（append-only 之外无派生一致性要求）。

### Composer UI（入站 Adapter）

- composer 挂载时经 `readThreadDraft` 恢复；输入防抖（约 500ms）调用 `saveThreadDraft`；发送成功路径调用方清草稿（由发送事务内联动或发送后显式 clear，以不双写为准：发送成功后服务端同事务删草稿）。
- 附件占位 chips：仅存 `{name, size}` 元数据（S-16 前的占位语义）；回复链接复用 S-14 `replyToMessageId`。
- 历史入口：搜索框 + 结果列表 + "清除全部"（确认后 DELETE）；命中项点击回填 composer（视为新编辑，随后走正常草稿保存）。记录开关沿用偏好 Adapter。
- 状态：loading/empty/error/disabled/focus 全态；tokens；键盘可达；44px。

## 关键流程

1. **恢复**：打开线程 → GET draft → 填充文字/占位/回复链接 → 用户继续编辑 → 防抖 upsert。
2. **发送**：正式发消息事务内追加 history（敏感则跳过）并删除该线程草稿 → UI 清空。
3. **清除历史**：DELETE input-history → 列表为空；审计只记清除事件。

## Seam 与测试点

- Seam 1 — Draft Command/Query：tests/modules/public-collaboration/thread-draft*.test.ts（新）。
- Seam 2 — History Command/Query：tests/modules/public-collaboration/input-history*.test.ts（新）。
- Seam 3 — Composer UI：tests/browser/collaboration/（新 jsdom 套件）+ smoke:threads 验收段。

## 横切约定

- 错误稳定脱敏；内容敏感 fail-closed 跳过且不写日志；schema 唯一 canonical；内存库夹具。
- UI tokens/键盘/44px/WCAG AA；无新视觉系统。

## ADR 链接

- 遵守 ADR-0003；无新增难逆转决定。
