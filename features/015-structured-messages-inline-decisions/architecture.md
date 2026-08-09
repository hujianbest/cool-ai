# 架构 — 结构化消息与就地决策

- 日期: 2026-08-09
- 对应规格: [`spec.md`](./spec.md)
- 进入门禁: RESULT: PASS — 可进入 to-architecture
- 用户确认: 待独立架构评审

## Module 与 Interface

- **Structured Message Codec / JCS Module**：统一 duplicate-key、I-JSON/JCS、strict schema、grapheme/bytes limits 与凭据规则；**Ingress Interface** `ingest(rawBytesOrString, mode) -> {value: BrandedKnown, canonicalBytes: BrandedCanonicalBytes}` 一次完成全部检查，size/hash 只接受该唯一 bytes；HTTP/Agent ingress 拒绝 unknown/invalid。
- **Persisted Read Interface**：`decodePersisted(raw) -> Known | UnknownSchema | Invalid`；Transcript 仅将 `UnknownSchema` 投影为不可执行占位，`Invalid` 视为持久损坏并失败关闭，禁止 closed union 猜测字段。
- **Thread Fact Store Module**：唯一分配 fact/activity/message 顺序并读写 tuple-scoped facts；**Interface** `appendBatchTx(database, FactIntent[]) -> StoredFact[]` 覆盖全部既有 fact intent 并在调用方事务内一次分配序列/更新 head，`readPage(tuple,cursor) -> FactPage`。
- **Agent Public Turn Committer Module**：在既有 attempt lease/context transaction 中提交公开 Agent turn；**Interface** `commitTx(database, ValidatedTurnContext) -> PublicTurnCommit`，Message、blocks、fact 与既有业务动作全有或全无。
- **Inline Decision Module**：封装 JCS intent hash、operation replay、state CAS、Decision 与 business Action Receipt；**Interface** `decide(tuple, intent) -> Completed | OperationConflict | VersionConflict`、`readOperation(tuple, id) -> DurableOutcome | NotFound`。
- **Verified Source Projection Module**：只从已落库 artifact、staged observation 或 handoff fact 生成冻结投影；**Interface** `resolve(tuple, SourceRef) -> Projection | Unavailable`、`executionHref(source) -> CanonicalProjectUrl`，不读取宿主文件。
- **Transcript Model Module**：把 fact page 解码为纯文本、五类 block 或 unknown placeholder，并产生 Inline Decision/执行表面导航意图；**Interface** `reduce(target, pages) -> TranscriptState`、`action(block, state) -> UiIntent`。
- **Current Schema Storage Module**：`CURRENT_SCHEMA`（identity 9）是唯一 DDL manifest；**Interface** `openDatabase(path)` 只允许空库原子 bootstrap 或 exact current reopen，并以稳定 `SchemaError` 拒绝 unsupported/partial/drift/data-invalid 数据。

## 核心数据

- current identity 9 包含 immutable blocks（logical id + `blockRevision` + `blockSchemaVersion` + position + JCS payload/hash + actor/source snapshot）、immutable state revisions（`stateVersion` + typed state）及其 head pointer。
- current identity 9 包含 Inline Decisions、成功专用 business Action Receipts 与 decision Thread Facts；Decision/Receipt 分别保存 schema version、from/to state、operation/hash 和 actor/source，Receipt 不复用通用 operation response。
- 复合 FK/UNIQUE 固定 project/thread/run/message/block/source ownership、block revision/position、state version、Decision、Receipt 与一事实一次投影；任何 tuple 缺失或混配失败关闭。
- `collaboration_messages.content` 继续非空，blocks 可选；规格只允许纯文本或文本 + blocks，因此 block-only Message 被 codec 拒绝。
- current 纯文本 Message/Fact 保持零 block；exact reopen 不得生成 block、Decision、Receipt 或 fact。

### 数据依赖 DAG 与状态

- 单向 FK：Block → Message/Source；StateRevision → Block/PriorRevision；StateHead → Block/CurrentRevision（CAS，迁移/插入可 deferred）；Decision → Operation/Block/FromRevision/ToRevision；BusinessReceipt → Decision；DecisionFact → Decision/Receipt。
- 初始 Block 必有 `stateVersion=1` revision 与指向它的 head；Proposal 仅 `pending→accepted|rejected` 且终态禁止后续 transition；Checklist 可按 allowlist 多次 transition，每次新增 revision、单调版本并 CAS head，不改 prior。
- 成功插入顺序：预生成 identity → StateRevision → head CAS → completed Operation → Decision → BusinessReceipt → DecisionFact；全部在一个事务，deferred FK 在 commit 前满足，失败整体回滚。
- exact data validator 验证 DAG 可达性、无断链/分叉版本、head 指最高合法 revision、Proposal/Checklist transition、operation outcome 行存在性与一 Decision/Receipt/Fact 唯一映射。

### Operation outcome matrix

- current 非 inline-decision kinds 的合法 pending advance、completed success/error 均保持原重放语义。
- `inline_decision + completed`：必须且仅有一个新 StateRevision、Decision、BusinessReceipt、DecisionFact，并返回 Receipt；四者缺一即 data-invalid。
- `inline_decision + version_conflict`：只有持久 terminal sanitized error envelope，四类业务行均为零；同 hash 重放该 envelope，异 hash 不修改原 operation。
- `inline_decision` 禁止 pending；同步 unknown-write 只查询 completed/version_conflict/not-found。重建 CHECK 按 kind/outcome 约束 schema version、HTTP status 与 response shape，Inline Decision 无 lease。

## 关键流程

0. **Prerequisite wave**：Thread Fact Store 支持全部既有 intent/batch，thread-service、run-service、action committer/orchestrator 等 producer 已收敛；仓库约束测试证明 owner 外无 direct `collaboration_thread_facts` writer。
1. **Agent turn**：raw strict output → Ingress Interface 产出 branded value + 唯一 canonical bytes → source validation → existing attempt lease/context check → Agent Public Turn Committer 单事务提交 Message + blocks + fact；任一失败只返回 sanitized error。
2. **Inline Decision**：32 KiB wire → strict intent → 同一 JCS bytes 做 16 KiB/hash → operation lookup → `expectedStateVersion` CAS → Decision + state revision + business Action Receipt + decision fact；same-hash completed replay 原 Receipt，stale 重放 terminal envelope，unknown-write 查 operation。
3. **读取与投影**：Thread Fact Store page → Persisted Read Interface → Transcript Model；仅 UnknownSchema 成为稳定不可执行 placeholder，Invalid 终止该损坏读取。Diff/File 只解析已落库 observation/artifact，Handoff 只解析既有 fact。
4. **fresh/exact reopen**：空库在单个事务中按 `CURRENT_SCHEMA` 建立对象、验证并最后写 identity 9；非空库只接受 identity 9 exact object/FK/current-data validation。v1～v8、partial、drift、unsupported 与非法 current 数据均不迁移、不修补并稳定失败关闭。

## Seam 与测试点

- **Codec Seam**：duplicate keys、五类 schema、JCS/I-JSON vectors、wire/domain bytes、limits、credential/raw rejection；断言 size/hash 只消费返回的 BrandedCanonicalBytes，并穷尽 Known/UnknownSchema/Invalid 分流。
- **Tuple/HTTP Adapter Seam**：跨 project/thread/run/message/block/source 同形失败；operation completed/version-conflict/not-found 与 hash/stale envelope 可判定，零部分写入。
- **Fact Store/Agent Commit Seam**：batch sequence/head、lease/context stale、单 block 失败、owner race 与 fault injection 全回滚；仓库约束测试禁止 owner 外 direct fact SQL。
- **Fact-only UI Seam**：分页去重、纯文本兼容、unknown placeholder、loading/empty/error/disabled/success/focus、target abort/epoch；File/Approval 只产生受控导航意图。
- **Canonical/Reopen Seam**：identity 9 inventory/fresh/exact reopen、v1～v8 minimal identity rejection、partial/drift/unsupported、非法 DAG/tuple/version/JCS 与一致快照验证；current 旧文本保持零 block。
- **Browser/Axe Seam**：真实 Proposal/Checklist replay/stale、Diff/File/Handoff、execution Approval 跳转、desktop/narrow、键盘、44px、light/dark 与 WCAG AA。

## 横切约定

- 大小与 hash 复用 RFC 8785 JCS bytes；错误、fact、audit、DOM 不含 raw Provider、凭据、hidden reasoning、宿主路径或私密原 diff，且绝不 latest fallback。
- business Action Receipt 与通用 operation durable outcome 是不同类型；Inline Decision `leaseApplicability=not_applicable`，Agent/Approval 只引用既有 lease。
- UI 只用既有 tokens/语义控件；canonical target identity + abort/epoch 保护读、poll、decision、focus 与导航。

## ADR 链接

- [ADR-0001：结构化消息采用规范化不可变状态模型](../../docs/adr/0001-normalized-immutable-structured-messages.md)（proposed）。该选择迁移后难逆转，脱离上下文会意外，且明确舍弃 Message JSON 内嵌/单行可变状态，满足三条件。
