# 任务票 — 项目聊天图片附件

- 状态: 项目级 review 豁免生效，直接进入 implement
- 规模: 5 张纵向 RED/GREEN 票；单一"把图片带进项目讨论"用户结果
- 公共缝: Attachment Command/Read、Thread Message Command、`openDatabase`、fact-only Composer/Transcript UI
- TDD: 每票先一个公共行为 RED，再最小 GREEN；内存库夹具；确定性最小图片字节夹具

- [x] T-01 上传命令与项目作用域存储 — Blocked by: None
  - 公共缝: Attachment Command。
  - RED: 上传路由/表不存在；magic 不符、超 5 MiB、非法形状未被稳定拒绝；宿主路径可回显。
  - GREEN: `message_attachments` + `attachment_events` 表（identity 12→13，同步全部 identity 引用）；`.data/attachments/<projectId>/<id>` verified 写盘；PNG/JPEG/GIF/WebP magic 嗅探为唯一类型事实；上传审计事件；同线程同 sha256 复用既有附件。
  - 验证: 四格式合法上传、magic/大小/形状拒绝矩阵、hash 复用、审计事件可查、路径收敛（无 `..`/绝对路径回显）。
  - 命令: 聚焦新 attachment 套件 + schema 套件；`npx tsc --noEmit`

- [x] T-02 消息链接与投递 — Blocked by: T-01
  - 公共缝: Thread Message Command 与 Attachment Public Read。
  - RED: 发消息携带 attachmentIds 被拒/丢失；链接非原子；孤儿/跨 tuple 附件可被投递。
  - GREEN: 提交事务内校验同 tuple/uploaded/未占用并链接（linked+message_id+事件）；重放幂等；GET 投递路由（tuple+linked+Content-Type 白名单+nosniff）；消息 DTO 含 attachments。
  - 验证: 链接原子性（fault 回滚）、重放、拒绝矩阵、投递头与 404 矩阵、≤4 数量上限。
  - 命令: 聚焦 thread-message + attachment 套件；`npx tsc --noEmit`

- [x] T-03 reopen 附件边穷尽校验 — Blocked by: T-02
  - 公共缝: `openDatabase(databasePath)`。
  - RED: 合法图做孤儿 linked/跨 tuple 链接/消息 attachments 与附件行不一致/非法 storage_relpath 单一 corruption，至少一类被接受。
  - GREEN: current-data-invariants 全集校验附件边（tuple 合法、linked 指向同 tuple 既有消息、双向一致、relpath 相对无越界、status 机合法）。
  - 验证: 合法 fresh/reopen 幂等；全部 corruption 稳定脱敏失败且零写。
  - 命令: 聚焦 tests/adapters/sqlite + public-collaboration；`npx tsc --noEmit`

- [x] T-04 Composer 上传与展示 UI — Blocked by: T-02
  - 公共缝: fact-only Composer/Transcript UI（jsdom）。
  - RED: 选择/粘贴无上传；无进度 chip；失败不可重试；消息不渲染图片；草稿占位不升级。
  - GREEN: 选择/粘贴共用上传通道（XHR 进度）；chip 进度/失败重试/移除；发送携带 attachmentIds；消息附件区 `<img>` 渲染（alt=文件名，元信息可访问）；草稿占位升级为真实附件引用并随草稿恢复。
  - 验证: loading/error/disabled/focus；tokens；键盘；无硬编码视觉值。
  - 命令: 聚焦 tests/browser/collaboration/；`npx tsc --noEmit`

- [x] T-05 真实浏览器验收图片附件 — Blocked by: T-04
  - 公共缝: 真实线程 transcript + 上传/投递路由。
  - 验证: 粘贴与选择两条路径、进度可见、发送后消息内图片渲染、刷新仍在、desktop/narrow、light/dark、keyboard、axe 无 serious/critical、证据零宿主路径/凭据；随后一次性全量 `npx vitest run` + `npx tsc --noEmit` + `npm run build`。
  - 命令: smoke:threads 验收段；全量一次；`npm run build`
