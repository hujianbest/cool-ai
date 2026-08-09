# 架构评审（第 1 轮）
- 日期: 2026-08-09
- 评审方式: subagent
- 结论: 需修改

## 发现项

- [一般] `architecture.md`「Module 与 Interface／关键流程／Seam 与测试点」（第 10、29～35 行）: `decode(input, context)` 与 `canonicalBytes(value)` 是两个可被调用方分开使用的宽接口，无法机械保证 raw HTTP/Provider JSON 在普通解析丢失重复键之前完成 I-JSON 拒绝，也无法保证 16 KiB 校验与 hash 消费同一份 bytes；同一 `strict codec` 又同时承担未知 schema 必须拒绝的写入入口和未知 schema 必须占位的历史读取，未定义两种结果如何分流，容易与客户端 closed-union/strict parse 冲突 → 将写入接口收紧为“raw bytes/string → strict parse + validated branded value + 唯一 canonical bytes”的一次性结果，hash/size 只接受该 bytes；另定义 persisted/read decode 的 `Known | UnknownSchema | Invalid` 结果，并明确 HTTP/Agent ingress 拒绝 `UnknownSchema`、Transcript 只把它投影为不可执行占位。
- [一般] `architecture.md`「核心数据」（第 20～23 行）: 只列出 block、state revision/head、Decision、Receipt、fact、operation 和“复合 FK/UNIQUE”，没有给出引用方向、终态矩阵或可达性不变量；因此无法判断 head↔revision、operation↔Decision/Receipt↔fact 是否形成循环 FK，也无法证明初始 state、Proposal 终态、Checklist 多次转换以及 `version-conflict` 零 Decision/Receipt/fact 均可达且只能以一种合法形态落库 → 增补一张精简的数据依赖 DAG 与状态/行存在矩阵，锁定 FK 单向关系、head CAS 责任、插入顺序及每种 operation 终态允许/禁止存在的 Decision、state revision、business Receipt 和 fact，并把这些关系列入 exact data validator。
- [一般] `architecture.md`「V8 Migration Module／核心数据／V7→V8/Reopen Seam」（第 16、22～25、39 行）: 虽声明独立 v8 manifest、不得改 v7 manifest及 reopen 测试，但未规定 7→8 必须在单个事务中完成、何时写 `user_version=8`、如何拒绝 partial-v8 object，以及 exact object/data validation 的唯一 manifest 来源；同时重建全局 `collaboration_operations` 时没有按 kind 保留 v7 `advance` 的合法 pending 和既有 completed 错误结果，只描述了 inline-decision success/version-conflict，迁移可能把合法 v7 数据变成不可迁移状态 → 明确独立 `V8_OBJECT_SQL/EXPECTED_V8_SQL`（或等价唯一来源）、单个 `BEGIN IMMEDIATE` shadow/rebuild/validate/最后置版本流程、partial-v8 失败关闭与重复 reopen 规则，并给出按 operation kind 的兼容 status/outcome CHECK 矩阵。
- [一般] `architecture.md`「Thread Fact Store Module／Agent Commit Seam」（第 11、37 行）: “所有 fact producer 收敛”被写成最终目标而非前置依赖；窄读现有 seam 可见 `thread-service.ts` 与 `run-service.ts` 仍有多处 direct fact SQL，且当前 helper 只覆盖部分 Agent/run-event 类型。若先加入 block/decision fact，旧 writer 与新 Store 会继续分别分配 fact/activity sequence、更新 thread head 并维护一事实一次投影，无法从接口上保证唯一 writer → 把现有 producer 收敛列为 v8 schema与新 fact 类型之前的显式 prerequisite/迁移波次，令 Store interface 支持同事务批量 append 和全部既有 fact intents，并以仓库级调用约束/测试证明除 migration 外不存在 direct fact SQL。

# 架构评审（第 2 轮）
- 日期: 2026-08-09
- 评审方式: subagent
- 结论: 通过
- 用户确认: auto-approved 2026-08-09

## 首轮 Findings 状态

1. **Ingress/read codec 与 canonical bytes：已闭合。** Ingress 一次产出 branded value 与唯一 branded canonical bytes，size/hash 只能消费该 bytes；persisted read 独立返回 `Known | UnknownSchema | Invalid`，写入拒绝 unknown/invalid，Transcript 只将 unknown 投影为不可执行占位，duplicate-key 与 closed-union 分歧均有公共 seam 测试。
2. **数据 DAG 与 outcome matrix：已闭合。** 单向 FK、state revision/head CAS、成功插入顺序、Proposal/Checklist 可达转换及 exact data validator 已明确；completed success 恰有一组新 state/Decision/Receipt/fact，version-conflict 四类业务行均为零且只重放 terminal envelope。
3. **v8 原子兼容迁移：已闭合。** `V8_OBJECT_SQL` 派生 expected manifest/validator且不修改 v7；7→8 在单个 `BEGIN IMMEDIATE` 中 precheck、shadow/rebuild/copy、全量验证并最后置版本，partial-v8/drift/invalid legacy 原子失败；v7 pending advance、completed success/error 与原重放语义均保留。
4. **fact writer 前置收敛：已闭合。** prerequisite wave 明确先提供覆盖全部既有 intent 的 batch Store，迁移现有 producers，并以仓库约束测试禁止 migration 外 direct fact SQL；完成后才允许引入 v8 schema 与新 fact type。

## 发现项

无。修订后的架构正文共 66 行，仍在 80 行量级内；FR/NFR、量化边界、Agent lease/context、受控来源导航、UI stale 防护及 Browser/Axe 均有明确落点。ADR-0001 仍与规范化不可变状态模型一致，`proposed` 状态适合当前评审通过前的阶段，三项记录条件保持成立；未发现新的严重或一般问题。

> Superseded note（2026-08-09）：本评审中的 v7→v8 migration 描述是历史快照。当前存储要求由 016 Contract 取代：identity 9 `CURRENT_SCHEMA` 唯一 DDL、fresh 原子 bootstrap、exact reopen，以及 unsupported/partial/drift/data-invalid fail-closed；原评审正文与结论不改写。
