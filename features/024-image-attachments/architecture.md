# 架构 — 项目聊天图片附件

- 日期: 2026-08-10
- 对应规格: [`spec.md`](./spec.md)
- 状态: 项目级 review 豁免生效；未送独立评审，不伪造工件

## 架构目标

Public Collaboration 新增附件事实族（CAP-COL-05），字节存储经既有 verified 路径能力，消息链接原子化；UI 只消费 tuple-scoped 投递与命令 Interface。

## Module 与 Interface

- Commands：`uploadAttachment`（multipart 或裸二进制 + 元数据头）、`removeAttachment`（孤儿可移除）、发消息命令扩展 `attachmentIds`。
- Queries：`readAttachmentContent(tuple, attachmentId)`（投递）、消息读取 DTO 增加 `attachments: [{id, fileName, size, mimeType}]`。
- 实现：`src/adapters/outbound/sqlite/public-collaboration/attachment-service.ts`（元数据/事务/审计）+ 复用 workspace verified 路径工具族写字节；消息链接在 thread-service 提交事务内完成。

## 核心数据

- `message_attachments`：status 机 `uploaded → linked`（失败由客户端重试同 id 重新 PUT 内容或新 id）；`(thread_id, sha256)` 唯一（同线程同内容复用）。
- `attachment_events`：`(id, project_id, thread_id, attachment_id, type uploaded|linked|removed, created_at)`。
- 字节：`.data/attachments/<projectId>/<attachmentId>`（无扩展名依赖，读取以 DB mime 为准）。

## 关键流程

1. **上传**：选择/粘贴 → POST（XHR 进度）→ 服务端 magic 嗅探+限值校验 → 写盘 + 行（uploaded）+ 审计事件 → 返回附件 DTO。
2. **发送**：composer 携带 attachmentIds → 提交事务校验同 tuple/uploaded/未占用 → 链接（linked + message_id + linked_at + 事件）→ 消息 DTO 含附件。
3. **展示**：消息渲染附件区 → GET 投递（tuple + linked + 白名单头）→ `<img>` 渲染，alt 为文件名。
4. **草稿升级**：占位 chip → 上传成功换真附件 chip；草稿 attachments_json 存 `{attachmentId, name, size}` 形状（向后兼容纯占位：无 id 视为未上传占位，恢复后需重选）。

## Seam 与测试点

- Seam 1 — Upload/Remove Command 与投递 Read：tests/modules/public-collaboration/attachment-*.test.ts（新）。
- Seam 2 — 消息链接：thread-message 套件扩展。
- Seam 3 — reopen 不变量：tests/adapters/sqlite/ 扩展。
- Seam 4 — UI：tests/browser/collaboration/ 新套件 + smoke:threads 验收段。

## 横切约定

- 安全：verified 路径构造；magic bytes 为唯一类型事实；投递白名单头；宿主路径/凭据零回显；`.data/attachments/` 加入隐私/gitignore 检查清单（不提交）。
- 审计最小化：事件不含内容/路径细节，仅身份与类型。
- UI：tokens/键盘/44px/WCAG AA；图片区复用消息壳。

## ADR 链接

- 遵守 ADR-0003；无新增难逆转决定。
