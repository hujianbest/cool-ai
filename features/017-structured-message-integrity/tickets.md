# 任务票 — 结构化消息完整性

- 状态: 项目级 review 豁免生效；已全部完成（2026-08-10 done）
- 规模: 5 张纵向 RED/GREEN 票；单一“reopen 后冻结、完整、无泄漏”用户结果
- 公共缝: `openDatabase(databasePath)`；Structured Message Source Public Read
- TDD: 每票先产生一个公共行为 RED，再以最小 GREEN 闭合；不得测试私有实现或弱化断言

- [x] T-01 冻结并公开读取安全 File Reference 名称 — Blocked by: None
  - 公共缝: Structured Message Source Public Read。
  - RED: 经正式提交创建 File Reference，随后改名来源并创建 latest 版本；首次读取、再次读取与 process reopen 目前返回可变名称或错误版本。
  - GREEN: 提交事务内冻结脱敏、grapheme 限长 `publicName` 与明确 `sourceEntityVersion`；public read 只返回冻结 projection，不 join mutable name、不查 latest、不回退路径。
  - 验证: 正常/敏感/边界 ±1、改名/latest/reopen；响应、日志与 DOM 无绝对路径/凭据/raw 内容。
  - 结果: 冻结落在不可变 payload_json（userVersion 保持 9）；新增 tests/modules/public-collaboration/structured-message-source-api.test.ts（5 用例）与 tests/fixtures/structured-messages/file-reference.ts 构建器；聚焦 51 文件 515 用例全绿。

- [x] T-02 让 current reopen 穷尽 source 与 state DAG — Blocked by: T-01
  - 公共缝: `openDatabase(databasePath)`。
  - RED: 从 owner fixture 建合法图后各做一个 orphan/duplicate/cross-tuple/source-version/head/branch/cycle corruption，证明至少一类非法 current 数据被 reopen 接受。实际 5 类曾被接受：branch/cycle/duplicate/source-version/state-kind。
  - GREEN: current-data-invariants.ts 落盘全集双向 DAG 验证（1..N 连续、恰好一次、prior=v-1、head=唯一末端）+ source 全字段一致性；不 migration、不 repair。
  - 验证: fresh bootstrap、exact legal reopen、8 类单一 corruption 稳定脱敏失败且数据库零写；聚焦 58 文件 591 用例全绿；schema identity 未变。

- [x] T-03 穷尽 completed outcome 并限制 Checklist 单项方向 — Blocked by: T-02
  - 公共缝: `openDatabase(databasePath)` 与既有 Inline Decision command。
  - RED: 8 类 outcome/Checklist 非法图全部被 reopen 接受（missing-decision、conflict-result、outcome-field、orphan-state、check-missing-target、check-wrong-direction、check-multiple、check-content-drift）。
  - GREEN: current-data-invariants.ts 新增 structuredOutcomesAreValid：operation ↔ Decision ↔ Receipt ↔ Fact 全集双向一对一逐字段核对（canonical JCS 深比较）；Checklist 相邻 state 仅目标 item checked 位按 action 合法方向变化；proposal 精确 pending→accepted/rejected。
  - 验证: completed 恰一组结果、same-hash replay 无第二动作、VERSION_CONFLICT 零结果；reopen 文件 32/32，聚焦 58 文件 600 用例全绿。

- [x] T-04 收口 rollback、Mission caller 与 SQLite 锁回归 — Blocked by: T-03
  - 公共缝: Review 公共事务行为、Mission create public command、`openDatabase`。
  - 结果: busy-timeout 3/3 复跑稳定（已被 020 内存库消除，记录在案）；Mission caller 已由 021 修复并复验通过；review-fault-injection fixture 合法化（原 seed 在 foreign_keys=OFF 下产生非法图），新增全 7 个 finalize 步 fault 后「全回滚 + openDatabase 合法」回归。
  - 验证: 聚焦 45 文件 348 用例全绿；未恢复默认 operation/version，未加无界 retry。

- [x] T-05 真实浏览器与集成验收并解除完整性阻塞 — Blocked by: T-04
  - 公共缝: Structured Message Source Public Read 与真实浏览器 fact-only transcript。
  - 结果: transcript-model 强制映射 payload.publicName → fileName，File Reference 卡片直显冻结名；smoke:structured PASS（14 断言 / 3 axe 状态 / 0 违规），改名+reopen 后名称稳定、renamed-later.txt 零泄漏；全量 1852/1853（唯一失败为无关既有 flaky，复跑通过）、tsc/build 通过。
