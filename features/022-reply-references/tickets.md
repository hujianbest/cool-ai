# 任务票 — 回复引用与来源跳转

- 状态: 项目级 review 豁免生效，直接进入 implement
- 规模: 4 张纵向 RED/GREEN 票；单一"回复并跳回来源"用户结果
- 公共缝: Thread Message Command / Public Read、`openDatabase`、fact-only Transcript UI
- TDD: 每票先产生一个公共行为 RED，再以最小 GREEN 闭合；不得测试私有实现或弱化断言
- 注意: 测试一律使用新树路径（tests/modules/、tests/adapters/、tests/browser/）与内存库夹具

- [x] T-01 提交回复并冻结来源快照 — Blocked by: None
  - 公共缝: Thread Message Command。
  - RED: 携带 `replyToMessageId` 提交消息，旧代码 400 拒为未知键（回复关系无法提交）；拒绝矩阵未稳定区分 not_found；敏感/边界/重放断言先失败（7 failed / 29）。
  - GREEN: `CURRENT_SCHEMA` 为 `collaboration_messages` 加 `reply_to_message_id/sequence/author_display_name/excerpt` 四可空列（+自引用 FK 纵深防御），identity 9→10；提交事务内 `resolveReplyToSnapshot` 验证目标同 tuple 存在且合法，冻结脱敏限长快照；requestHash 纳入 replyToMessageId；非法输入稳定脱敏失败且零写入。
  - 验证: owner/agent 目标各一合法提交；缺失/跨 thread/跨 project/自引用/非消息目标拒绝矩阵；敏感文本与 160±1 grapheme 边界 fail-closed（CREDENTIAL_CONTENT_REJECTED 422）；幂等/重放行为不变。聚焦 10 套件 185 用例全绿。
  - 默认记录: product/assumptions.md A-109。

- [x] T-02 读取投影与 reopen 回复边穷尽校验 — Blocked by: T-01
  - 公共缝: Thread Message Public Read 与 `openDatabase(databasePath)`。
  - RED: 分页读取不返回 `replyTo` 快照；owner fixture 合法图做 orphan/cross-tuple/self/快照分歧/sequence 矛盾单一 corruption，至少一类被 reopen 接受。
  - GREEN: `ThreadMessageDto.replyTo` 只解码冻结列；current-data-invariants 新增全集双向校验（四列同 null/同非 null、目标存在、非自引、快照与目标逐字段一致——excerpt 按 trim 后内容比对、目标 sequence 严格小于本消息）。
  - 验证: 合法 fresh/reopen 幂等；全部单一 corruption 稳定脱敏失败且零写；无回复消息 `replyTo: null` 行为不变。
  - 命令: 聚焦 tests/modules/public-collaboration + tests/adapters/sqlite；`npx tsc --noEmit`

- [x] T-03 Transcript UI 引用片与精确跳转 — Blocked by: T-02
  - 公共缝: fact-only Transcript UI（jsdom 组件测试经公共 read/command fake 驱动）。
  - RED: 消息无引用片、点击无法跳转/高亮、跨页目标不加载、来源不可用无稳定占位。
  - GREEN: 引用片 `#sequence · 作者 · excerpt`（tokens、button 语义、键盘激活）；点击按 sequence 定位（已加载 scrollIntoView+短暂高亮；未加载先取目标所在页再定位）；不可用来源稳定中性占位且跳转禁用、原因可访问。
  - 验证: loading/error/disabled/focus 状态；target switch abort/epoch 不把旧定位写到新目标；无硬编码视觉值；无第二消息状态机。
  - 命令: 聚焦 tests/browser/collaboration/ 相关 UI 套件；`npx tsc --noEmit`
  - 默认记录: product/assumptions.md A-111。

- [x] T-04 真实浏览器验收回复引用 — Blocked by: T-03
  - 公共缝: 真实线程 transcript + tuple-scoped route。
  - RED: smoke 场景中回复→跳转→不可用占位判据先锁定失败点。
  - GREEN: 仅补足 smoke fixture/交互所需最小实现。
  - 验证: desktop/narrow、light/dark、keyboard-only、focus visible、44px、axe 无 serious/critical；DOM/API/log/证据无宿主路径/凭据。随后一次性全量 `npx vitest run` + `npx tsc --noEmit` + `npm run build`。
  - 命令: 受影响 smoke（threads/structured 视落点）；全量测试一次；`npm run build`
  - 默认记录: product/assumptions.md A-112。
