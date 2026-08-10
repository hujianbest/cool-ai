# 项目聊天图片附件需求规格

- 日期: 2026-08-10
- 特性: 024-image-attachments
- 对应切片: S-16（CI-2.10）
- 模式: 建造
- 用户可感知: 是
- 执行模式: auto（用户不在场，问题按助手推荐处理并记录假设）
- 共享理解来源: `product/backlog.md` S-16 条目（auto-approved 2026-08-10）
- 公共行为接缝: Attachment Command（上传/清理）与 Attachment Public Read（投递/展示）；Thread Message Command（携带附件发送）；fact-only Composer/Transcript UI
- 主子系统: Public Collaboration；主 Capability: `CAP-COL-05`（本片建立其项目附件存储、媒体校验与恢复部分）
- 已交付前置: `CAP-COL-01`、`CAP-COL-04`（S-15 草稿附件占位）、`CAP-PWS-01`、`CAP-EXE-01`

## 问题陈述

S-15 只交付了附件"占位"语义（仅存名称/大小，不含内容）。owner 无法真正把图片带进项目讨论：无上传、无类型/大小/数量校验、无进度与失败恢复，重启后也没有可展示的附件实体。

## 解决方案

新增项目级图片附件事实：composer 选择/粘贴图片后立即上传（显示进度，可重试/移除），服务端经 verified 路径写入项目作用域存储，行级元数据（名称/大小/MIME/SHA-256/状态）入库；发送消息时携带附件 id 列表，同事务校验同 tuple、已上传、未被他消息占用并建立链接。读取只经 tuple-scoped 路由按允许类型投递（内联图片，CSP/Content-Type 收敛），重启后消息附件完整可见。占位草稿升级为真实附件引用；上传未发送的孤儿附件可显式移除，上传与清理动作写最小审计事件（不含内容）。

## 用户故事

1. **作为 owner，我想粘贴或选择图片发送，从而让讨论基于真实图像。**
   - 支持 PNG/JPEG/GIF/WebP；服务端以 magic bytes 校验真实类型（扩展名不一致以字节为准），单文件 ≤5 MiB、单消息 ≤4 个、单文件像素元数据不做可信假设（仅浏览器端渲染，服务端不做完整解码）。
   - 类型/大小/数量越界给出明确字段级错误；不合格文件不进入存储。
2. **作为 owner，我想看到上传进度并能从失败恢复，从而不发重复或丢失的附件。**
   - 每个附件 chip 显示进度；失败可重试或移除；成功后才允许随消息发送。
   - 重复选择同一文件不产生重复行（同线程同内容 hash 复用既有附件 id）。
3. **作为 owner，我想重启后附件仍在项目内可见，从而讨论记录完整。**
   - 消息展示附件图片（含可访问 alt 与类型/大小元信息）；附件存取限定项目作用域，跨项目/跨线程读取 404。
   - 上传来源（谁、何时、哪个线程、hash）可追溯；移除孤儿附件记录清理事件；任何时候不在 API/DOM/日志回显宿主绝对路径或凭据。
4. **作为 owner，我想草稿里的占位变成真附件，从而续写不丢上下文。**
   - S-15 的附件占位 chip 在选择文件后升级为已上传附件引用；刷新恢复草稿时显示真实附件状态（已上传/失败可重试）。
   - 发送成功后草稿与未发送占位的清理行为与 S-15 一致。

## 实现决策

- 存储：字节落盘于应用数据目录下项目作用域子目录（`.data/attachments/<projectId>/<attachmentId>`），不写绑定工作区；路径经既有 verified-handle/路径收敛工具构造与校验，禁止宿主绝对路径进入 API/DOM/日志。
- schema（唯一 current canonical）：`message_attachments`（id PK、project_id/thread_id、message_id NULL→发送时链接、file_name/size/mime_type/sha256/storage_relpath、status uploading→uploaded|failed→linked、created_at/linked_at）+ `attachment_events`（最小审计：uploaded/removed/linked 事件，无内容列）；identity 12→13。
- 上传路由：POST 二进制（Content-Type 收敛 + 64KiB…不，图片上限 5 MiB body 上限）；magic byte 嗅探失败 fail-closed；SHA-256 服务端计算。
- 消息命令扩展：`attachmentIds` 可选（≤4），同事务校验并链接；重放幂等（同 operation 不重复链接/不重复消息）。
- 读取投递：GET attachment 路由校验 canonical tuple + linked 状态，响应 `Content-Type` 白名单 + `X-Content-Type-Options: nosniff` + 合理缓存；未知/孤儿附件 404。
- `openDatabase` 不变量：附件行 tuple 合法；linked 必须指向同 tuple 既有消息且消息 attachments 一致；孤儿只允许 uploaded/failed 且 message_id NULL；storage_relpath 形状合法（相对、无 `..`）。
- 前端上传进度用 XHR upload progress；粘贴事件与文件选择共用同一上传通道。

## 测试决策

- TDD 每轮一个公共缝 RED + 最小 GREEN；内存库夹具；二进制夹具用确定性的最小合法 PNG/JPEG/GIF/WebP 字节序列。
- **Upload seam**：合法四格式、magic 不符/超限/超数/非法形状/跨 tuple/重复 hash 复用/孤儿移除与审计。
- **Message seam**：携带附件发送、链接原子性、重放幂等、他人附件/未上传/跨 tuple 拒绝。
- **Read seam**：投递白头/nosniff/缓存、孤儿与跨项目 404、reopen 附件边 corruption 矩阵。
- **UI seam**：进度/失败重试/移除/发送联动/图片渲染 alt/草稿升级恢复；loading/error/disabled/focus。
- **浏览器验收**：粘贴与选择两条路径、上传进度可见、发送后消息内图片渲染、刷新后仍在、axe 无 serious/critical、证据零宿主路径/凭据。

## 范围外事项

- 非图片附件（文件、音视频）、图片编辑/压缩/缩略图生成、附件下载管理页、大文件分片与断点续传、附件在 Agent 提示词中的多模态注入。
- 孤儿附件的定时自动清理任务（本片只提供显式移除 + 审计）。

## 补充说明

- 单一用户结果（把图片带进项目讨论），一个主 Capability，预计 5 张票；涉及真实二进制边界，安全约束（verified 路径、内容白名单、脱敏）为硬门禁。
- 评审按项目级 review 豁免跳过；默认选择记入 product/assumptions.md。
