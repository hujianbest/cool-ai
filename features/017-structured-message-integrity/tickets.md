# 任务票 — 结构化消息完整性

- 状态: 待 spec-review；草案不得进入 implement
- 规模: 5 张纵向 RED/GREEN 票；单一“reopen 后冻结、完整、无泄漏”用户结果
- 公共缝: `openDatabase(databasePath)`；Structured Message Source Public Read
- TDD: 每票先产生一个公共行为 RED，再以最小 GREEN 闭合；不得测试私有实现或弱化断言

- [ ] T-01 冻结并公开读取安全 File Reference 名称 — Blocked by: None
  - 公共缝: Structured Message Source Public Read。
  - RED: 经正式提交创建 File Reference，随后改名来源并创建 latest 版本；首次读取、再次读取与 process reopen 目前返回可变名称或错误版本。
  - GREEN: 提交事务内冻结脱敏、grapheme 限长 `publicName` 与明确 `sourceEntityVersion`；public read 只返回冻结 projection，不 join mutable name、不查 latest、不回退路径。
  - 验证: 正常/敏感/边界 ±1、改名/latest/reopen；响应、日志与 DOM 无绝对路径/凭据/raw 内容。
  - 命令: `npm test -- tests/structured-message-source-api.test.ts tests/structured-message-reopen.test.ts`；`git diff --check`

- [ ] T-02 让 current reopen 穷尽 source 与 state DAG — Blocked by: T-01
  - 公共缝: `openDatabase(databasePath)`。
  - RED: 从 owner fixture 建合法图后各做一个 orphan/duplicate/cross-tuple/source-version/head/branch/cycle corruption，证明至少一类非法 current 数据被 reopen 接受。
  - GREEN: 直接更新 `CURRENT_SCHEMA` identity/final manifest/fresh tests，并在一致快照从 block/state/source 全集做双向、恰好一次与完整字段验证；不 migration、不 repair。
  - 验证: fresh bootstrap、exact legal reopen、所有单一 corruption 稳定脱敏失败且数据库零写；fixture 不复制大型 SQL 图。
  - 命令: `npm test -- tests/current-schema.test.ts tests/structured-message-reopen.test.ts`；`git diff --check`

- [ ] T-03 穷尽 completed outcome 并限制 Checklist 单项方向 — Blocked by: T-02
  - 公共缝: `openDatabase(databasePath)` 与既有 Inline Decision command。
  - RED: 分别构造 completed 缺/多 Decision、Receipt、Fact、字段不一致，terminal conflict 带业务结果，以及 Checklist 缺目标/错方向/多项或内容漂移，证明当前 reopen 接受缺口。
  - GREEN: operation ↔ Decision ↔ Receipt ↔ Fact 全集双向一对一并逐字段核对；相邻 Checklist state 只允许目标 item checked 位按 action 合法改变。
  - 验证: completed 恰一组结果、same-hash replay 无第二动作、VERSION_CONFLICT 零结果；合法 check/uncheck 与全部非法 edge 矩阵。
  - 命令: `npm test -- tests/structured-message-reopen.test.ts tests/structured-message-decisions.test.ts`；`git diff --check`

- [ ] T-04 收口 rollback、Mission caller 与 SQLite 锁回归 — Blocked by: T-03
  - 公共缝: Review 公共事务行为、Mission create public command、`openDatabase`。
  - RED: 固定 review rollback 后非法 current 数据、5 个缺 `operationId/expectedVersion` 的旧 caller，以及已知 busy-timeout；每轮只选一个失败进入 RED/GREEN。
  - GREEN: 保证 fault 全回滚；caller 显式严格 UUID operation 与 `expectedVersion=0`；在 15 分钟、最多 10 次复现内定位锁持有/连接生命周期并做确定性释放修复。
  - 验证: 不恢复默认 operation/version，不增加无界 retry，不以扩大 timeout/skip 掩盖；若预算内无根因，记录复现率与停止证据并拆票，不继续循环。
  - 命令: 运行固定失败清单的聚焦 suites；`git diff --check`

- [ ] T-05 真实浏览器与集成验收并解除完整性阻塞 — Blocked by: T-04
  - 公共缝: Structured Message Source Public Read 与真实浏览器 fact-only transcript。
  - RED: browser fixture 创建 File Reference 后改名/reopen，先证明页面或证据未锁定冻结名称与零泄漏结果。
  - GREEN: 仅让既有 File Reference 展示消费冻结 `publicName`；复用 Cool tokens/components，无新视觉系统。
  - 验证: desktop/narrow、light/dark 中名称稳定；键盘与 axe 无 serious/critical；DOM/API/log/evidence 无宿主路径/credential。随后只运行一次受影响全量测试、typecheck、build 与 `smoke:structured`。
  - 命令: `npm run smoke:structured`；`npm test`；`npx tsc --noEmit`；`npm run build`；`git diff --check`
