# 任务票 — 线程草稿恢复与输入历史

- 状态: 项目级 review 豁免生效，直接进入 implement
- 规模: 5 张纵向 RED/GREEN 票；单一 composer 连续性用户结果
- 公共缝: Thread Draft Command/Query、Input History Command/Query、fact-only Composer UI
- TDD: 每票先一个公共行为 RED，再最小 GREEN；内存库夹具；新树测试路径

- [x] T-01 草稿持久化命令与读取 — Blocked by: None
  - 公共缝: Thread Draft Command/Query。
  - RED: 保存草稿后读取为空/丢失附件占位与回复链接；敏感正文被落盘；跨 tuple 读写未被拒绝。
  - GREEN: `thread_drafts` 表（identity 10→11，fresh/exact 测试同步）；upsert+version；readThreadDraft 按 tuple 返回冻结内容；敏感正文 fail-closed 不保存（保留占位/链接）；不变量校验 draft 回复边。
  - 验证: 保存/恢复/覆盖版本递增/附件占位与 replyTo 往返/敏感跳过/跨 tuple 拒绝/同事务语义。
  - 命令: 聚焦新 thread-draft 套件 + tests/adapters/sqlite schema 套件；`npx tsc --noEmit`

- [x] T-02 发送联动：历史追加与草稿清除 — Blocked by: T-01
  - 公共缝: Thread Message Command 与 Input History Command。
  - RED: 成功发 owner 消息不产生历史、不清草稿；同 operation 重放产生第二条历史；敏感正文被记入历史。
  - GREEN: 发消息事务内追加 `input_history_entries`（敏感跳过）并删除该线程草稿；重放幂等；新增 history 搜索/清除查询与命令（项目隔离）。
  - 验证: 记录/重放/敏感跳过/搜索命中与隔离/清除后为空/审计只记事件。
  - 命令: 聚焦 thread-message + input-history 套件；`npx tsc --noEmit`

- [x] T-03 Composer 恢复与防抖保存 UI — Blocked by: T-01
  - 公共缝: fact-only Composer UI（jsdom）。
  - RED: 刷新/切换后草稿不恢复；输入不触发保存；回复链接与占位 chips 不恢复；敏感提示缺失。
  - GREEN: 挂载恢复；防抖 upsert；发送成功清空；敏感降级提示中性可感知；target switch abort/epoch 防止串线程写入。
  - 验证: loading/error/disabled/focus；键盘；tokens；无第二状态机。
  - 命令: 聚焦 tests/browser/collaboration/ composer 相关套件；`npx tsc --noEmit`

- [x] T-04 输入历史搜索与清除 UI — Blocked by: T-02
  - 公共缝: fact-only Composer UI。
  - RED: 无历史入口/搜索/清除；清除无确认；结果跨项目泄漏；回填不生效。
  - GREEN: composer 附近历史入口；关键字搜索列表；显式确认后清除全部；点击回填 composer 走正常草稿保存；记录开关读取偏好 Adapter。
  - 验证: empty/loading/error/disabled/focus；键盘完成搜索与清除；tokens。
  - 命令: 聚焦同上；`npx tsc --noEmit`

- [x] T-05 真实浏览器验收 composer 连续性 — Blocked by: T-03, T-04
  - 公共缝: 真实线程 transcript + tuple-scoped routes。
  - 验证: 刷新恢复、发送清草稿、历史搜索/清除；desktop/narrow、light/dark、keyboard、focus、44px、axe 无 serious/critical；证据无凭据/宿主路径。
  - 命令: 受影响 smoke（threads）；随后一次性全量 `npx vitest run` + `npx tsc --noEmit` + `npm run build`
