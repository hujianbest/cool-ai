# 首次发布前唯一 canonical schema 需求规格

- 日期: 2026-08-09
- 特性: 016-pre-release-canonical-schema
- 模式: 建造
- 用户可感知: 否
- 执行模式: auto
- 公共行为接缝: `openDatabase(databasePath)`

## 问题陈述

Cool AI 尚未正式发布且没有用户，但当前 SQLite 打开路径仍维护 v1～v8 顺序 migrations、legacy adoption/backfill、旧 schema fixtures 和升级测试。该兼容矩阵只保护可丢弃的本地开发数据，却让 current schema 的定义散落于历史文件，并让 schema 错误与 Mission delivery 初始化等运行时领域行为依赖 migration 模块。继续扩展这条路径会把尚未作出的兼容承诺固化为产品约束，同时增加 partial migration、validator 分歧和误删业务恢复测试的风险。

## 解决方案

首次正式发布前只支持一个 current canonical SQLite schema。`openDatabase(databasePath)` 对不存在路径或空数据库原子 bootstrap 完整 current schema；对完全匹配 current exact schema 且满足全部 current 数据不变量的数据库幂等 reopen；任何非空 legacy、partial、drift、unsupported schema 或非法 current 数据都以稳定、脱敏的 schema 错误失败关闭，绝不迁移、adopt、backfill、删除或自动重建。

清理必须把 DDL、object manifest、exact validator 与 current data invariants 收敛到唯一 `CURRENT_SCHEMA` 来源；把 schema 错误和运行时领域 helper 移出历史 migration 模块；删除 v1～v8 migration 实现、升级测试与旧 fixtures，同时将仍证明业务历史、operation replay、恢复、tuple ownership、冻结来源或 current 数据不变量的测试迁到 canonical current-schema fixture。015/S-13 在此清理完成前不得 ship。

## 用户故事

1. **作为开发者，我想从不存在的数据库路径启动 current schema，从而无需执行任何历史升级链。**
   - Given `databasePath` 不存在，When 调用 `openDatabase(databasePath)`，Then 在单个原子 bootstrap 边界创建完整 `CURRENT_SCHEMA`、设置 current schema identity、验证 exact objects 与 data invariants 后返回可用连接。
   - Given bootstrap 任一步失败，When 再次检查路径，Then 不得留下一个被后续误认成 current 的 partial schema；错误稳定、脱敏且不含宿主路径、SQL 或数据内容。

2. **作为开发者，我想让空数据库按同一 canonical 定义初始化，从而不会因 SQLite 文件已存在而走不同契约。**
   - Given 路径指向没有任何业务 user object 的空 SQLite 数据库，When 打开，Then 结果与不存在路径 bootstrap 的 schema identity、objects、DDL 和不变量完全相同。
   - Given 数据库非空但 `user_version` 为 0 或只含 canonical schema 的一部分，When 打开，Then 视为 partial/unsupported schema 失败关闭，不 adoption、不补建。

3. **作为开发者，我想重复打开 current exact schema，从而确认进程重启不会改写数据或结构。**
   - Given 数据库的 schema identity、全部 objects/columns/indexes/triggers/constraints/DDL、foreign keys 和 current data invariants 精确匹配 `CURRENT_SCHEMA`，When 一次或多次调用 `openDatabase(databasePath)`，Then 每次在一个一致读快照中完成全部检查，成功前结束快照，且不执行 DDL、持久 PRAGMA、backfill、迁移或业务写入。
   - Given current exact schema 中存在合法业务历史、operation outcome、恢复状态、tuple 与冻结来源，When reopen，Then这些事实保持不变且仍由 current data-invariant validator 接受。
   - Given 第二连接在 reopen 验证期间尝试改变 schema 或数据，When 当前验证完成，Then 单次 reopen 只观察一个一致快照；失败路径关闭连接并保持数据库未被 opener 写入。

4. **作为开发者，我想让所有非 current schema 明确失败，从而不会把未知数据静默解释或改写成 current。**
   - Given 任一 v1～v8 legacy fixture、partial schema、对象/DDL drift、过新或未知 schema identity，When 打开，Then `openDatabase` 抛出稳定 schema 错误并保持数据库原样。
   - Given 非空数据库与 current schema 同名但缺少、增加或改变任一受管对象、column、index、trigger、constraint 或 canonical DDL，When 打开，Then exact validator 失败关闭，不执行修复 SQL。
   - Given current objects 精确但数据违反 ownership tuple、不可变历史、source、DAG、operation/version/lease、receipt 或恢复不变量，When 打开，Then data-invariant validator 失败关闭，不删除或回填数据。

5. **作为维护者，我想只有一份 current schema 定义，从而让 bootstrap 与 reopen 不会分歧。**
   - `CURRENT_SCHEMA` 是 canonical DDL、与 v1～v8 均不同的 schema identity、完整 table/index/trigger inventory、依赖顺序和 exact validation 期望的唯一事实源；每张最终表都有独立最终 `CREATE`，不得从 v1～v8 migration 片段或 `ALTER`/copy/backfill 拼装。
   - manifest 必须自证 object identity 唯一、依赖完整无环且单项 SQL 只创建声明对象；实际 `sqlite_master` 全部非内部 table/index/trigger 与 manifest 派生集合逐对象双向全等。对象数量只能从 inventory 按 kind 派生，不能以另一个硬编码表数作为真理。
   - schema 变化直接修改该 manifest 及其 fresh/reopen tests；首次发布前不得通过新增 migration、legacy branch 或旧 fixture 表达变化。
   - bootstrap 按 manifest 的依赖顺序在单个写事务执行，全部 DDL 完成后才在同一事务写 current `PRAGMA user_version`，并在提交前使用与 reopen 相同的 exact object、foreign key 与 current data-invariant validator。

6. **作为维护者，我想让运行时领域代码不再依赖 migration 模块，从而可以完整删除历史升级实现。**
   - Schema 错误类型与稳定 code 移至 current storage/schema 边界；既有 API adapters 继续只映射稳定、脱敏 code，不感知 migration 版本。
   - Mission 创建由命名 Application Workflow 通过 `UnitOfWork` 持有外层事务：它把同一个不透明 `TransactionContext` 依次传给 Mission owner 的 `MissionCommandCapability` 与 Review & Delivery owner 的 `ReviewDeliveryCommandCapability`。公开 Interface 不暴露 SQLite/Adapter 类型；后者只写自身事实、携带稳定 step identity 且不得自行提交。
   - composition root 注入 `UnitOfWork` 的 SQLite Adapter 和两个 Capability Implementations；Workflow 不依赖具体 Adapter，Mission 不得 import Review repository/SQL/private helper 或以任何 helper 跨 owner 写。
   - 清理后运行时代码不得导入 v1～v8 migration 模块，也不得把 migration runner 当作领域服务。

7. **作为维护者，我想删除无产品价值的升级资产但保留恢复保障，从而让清理不弱化业务不变量。**
   - 删除 v1～v8 migration 模块、顺序升级/legacy adoption/backfill 测试和只用于构造旧 schema 的 fixtures。
   - 保留并迁移证明 current 业务历史、不可变事实、operation replay/conflict、崩溃恢复、tuple ownership、冻结 provenance、Structured Message 状态/来源及 Mission delivery 恢复的测试。
   - 共享 canonical fixture 只负责通过 `openDatabase` 建立空 current schema；领域 facts builders 分属各 owner。保留测试逐一迁移到 owner fixture，不得使用万能数据库 builder、手写散落大型 SQL 或弱化断言。
   - 删除 legacy 全库 fixtures 后，`openDatabase` rejection tests 只可用目的受限的最小内存构造器表达 v1～v8 identity、非空 marker、单一 partial/drift/FK/data-invalid；该构造器不得复制历史 DDL、导出给业务测试或成为可重放 migration fixture。

8. **作为交付编排者，我想让 S-13 等待 schema 清理，从而避免基于即将删除的 v8 migration 证据 ship。**
   - 015/S-13 的已完成票据与既有评审结论保持历史不变。
   - 015 `progress.md` 明确 ship 被 016 阻塞；在 016 完成 canonical bootstrap/reopen、fixture 迁移、旧 migration 删除和完整验证前，不得宣称 S-13 ship。
   - 016 完成后，S-13 的 current schema、reopen 与恢复证据以 canonical current-schema tests 为准，不再以 v7→v8 migration 兼容为准。

## 实现决策

### Current schema 契约

- “空数据库”只指不存在路径，或 SQLite 中没有任何非内部 user object 的数据库；任何非空对象集合都必须按 current exact schema 验证，不能被当作可 bootstrap。
- `CURRENT_SCHEMA` 必须显式穷尽每个 table/index/trigger 的 kind/name/final create SQL/dependencies；identity 与 v1～v8 不同。validator 对全部非内部 `sqlite_master` 对象做集合与规范化 DDL 双向全等，并检查 manifest 自身唯一性、foreign keys 与关键 constraints；对象计数只从 inventory 派生。
- fresh bootstrap 在一个事务内按依赖顺序执行全部 canonical DDL，全部完成后才在同一事务设置 `PRAGMA user_version`，运行 exact object、`foreign_key_check` 与 data-invariant validation，最后提交。禁止逐版本调用或中途发布 partial schema。
- reopen 不做写入：identity、exact objects、`foreign_key_check` 与 data invariants 必须在同一个一致读事务中完成，成功前结束快照；schema identity 相同不能跳过其余检查。
- 分类与验证前只允许非持久、连接级 PRAGMA；`user_version` 只在空库 bootstrap 事务内写，unsupported/current reopen 均不得改写数据库头或创建持久 sidecar。
- legacy、partial、drift 与 unsupported 都是不可恢复输入；应用只报告如何由开发者人工处理，绝不自行删除、覆盖、重命名或重建非空数据库。

### 错误契约

- schema 边界提供独立、稳定的 `SchemaError`（或等价 current-schema 命名），至少区分 schema drift/data invalid/unsupported 与 storage unavailable；不得继续使用暗示可迁移的运行时类型名。
- 对外只暴露稳定 code 与通用脱敏 message；原始 SQLite 异常、SQL、表内容、凭据和绝对宿主路径不得进入 API envelope、日志或 UI。
- 所有失败都必须关闭连接并保持非空数据库原样；错误映射不得把 unsupported schema 当作首次启动。

### 删除与保留边界

- 删除对象是 schema 版本兼容机制：v1～v8 runners/manifests、顺序升级 hooks、legacy detection/adoption/backfill、旧 schema builders 和只断言升级结果的 tests。
- 保留对象是 current 业务契约：owner Capability Implementation 与命名 Application Workflow、current DDL 所需 constraints、exact/data validators，以及与历史 schema 版本无关的业务恢复、重放和不变量测试。
- 若某测试同时依赖旧 fixture 并证明 current 业务行为，先迁到 canonical fixture 并确认同一行为 RED/GREEN，再删除旧 fixture；不得整文件粗暴删除。

### Mission 跨 owner Interface

- `TransactionContext` 是 Application 层声明的不透明事务身份；`UnitOfWork.run(work)` 是唯一事务协调 Port。两者均不得包含 `DatabaseSync`、SQL 或 commit/rollback 方法。
- `MissionCommandCapability.createMission(tx, command)` 返回至少 `{projectId, missionId, occurredAt}`；`ReviewDeliveryCommandCapability.initializeForMission(tx, {stepId, projectId, missionId, occurredAt})` 返回至少 `{stepId, deliveryHeadVersion, eventSequence}`，冲突稳定为 `MISSION_INITIALIZATION_CONFLICT`。
- Mission create HTTP 写入口要求客户端提供严格 UUID `operationId` 和显式 `expectedVersion=0`；服务端从规范化后的 `{projectId,title,goal,operationId,expectedVersion}` 派生稳定 `requestHash`，不得随机生成 operation identity 或默认 create version。相同 operation 与相同规范化 payload 稳定重放，相同 operation 与不同 payload 返回稳定 `OPERATION_CONFLICT` envelope。
- Workflow 必须在一次 `UnitOfWork.run` 内向两个 Capability 传递同一 `TransactionContext`；任一步失败整体回滚。只有 composition root 可同时看见 concrete SQLite UnitOfWork Adapter 与两个 owner Implementations。
- 测试通过 Workflow Interface 验证同 context、顺序、command 映射、错误回滚；通过真实 SQLite composition 验证两 owner facts 全有或全无；架构约束禁止 SQLite 类型穿透、Workflow 依赖 Adapter、Mission deep-import Review。

## 测试决策

唯一公共行为接缝是 `openDatabase(databasePath)`。所有 schema 生命周期验收都通过真实临时 SQLite 路径观察该接缝，不测试私有 bootstrap/validator 函数。

1. **fresh matrix**：不存在路径与空 SQLite 文件均创建完整 current schema；fault injection 证明 partial bootstrap 不可被后续接受。
2. **exact reopen matrix**：合法 current schema 含代表性业务历史时重复 reopen；第二连接并发变异证明 identity/object/FK/data 检查来自同一读快照；断言结构与事实不变、无 DDL/持久 PRAGMA/backfill/业务写入。
3. **fail-closed matrix**：用最小、不可重放的内存构造器覆盖 v1～v8 identity、`user_version=0` 非空、partial、额外/缺失/改变对象、unsupported identity、FK 与非法 current 数据；断言稳定脱敏错误、原文件未删除且内容未改写。
4. **fixture migration matrix**：共享技术 builder 只创建空 current schema，所有保留的业务恢复/重放/tuple/source tests 改用 owner fixtures 后仍证明原行为；仓库约束测试禁止万能 fixture、legacy 全库 builder、migration 模块和运行时 migration import。
5. **验证层级**：每票先跑聚焦 RED/GREEN；收缩完成后运行受影响 schema/recovery suites、全量 tests、typecheck、build 与 `git diff --check`。本特性无用户可感知 UI，不要求新增 browser demo。

## 范围外事项

- 首次正式发布后的数据升级、备份恢复、支持窗口和跨发布 schema compatibility。
- 自动导入旧开发数据库、尽力修复 drift、导出转换工具或开发数据库迁移 CLI。
- 应用自动删除、覆盖、重命名或重建任何非空数据库。
- 修改 Structured Message、Mission、Review、Execution 或其他领域的业务行为。
- 放宽 exact-schema、current data invariants、事务原子性、tuple ownership、operation/version/lease、冻结 provenance 或错误脱敏。
- 清理与 schema compatibility 无关的业务历史、恢复或 replay tests。

## 补充说明

- ADR-0003 与 D-43 是本规格的已确认决策来源；不是 auto 默认，不写入 `product/assumptions.md`。
- 本切片只有一个基础设施结果、一个公共行为接缝和五张计划票，未触发拆片阈值。
- 独立规格评审与 `check --to to-architecture` 已通过；`architecture.md` 正在独立复审，复审与 `check --to to-tickets` 通过前不得进入拆票或实现。
- 用户确认: 2026-08-09
