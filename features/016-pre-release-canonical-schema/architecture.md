# 架构 — 首次发布前唯一 canonical schema

- 日期: 2026-08-09
- 对应规格: [`spec.md`](./spec.md)
- 状态: to-architecture；独立架构评审第 3 轮结论「通过」
- 进入 to-architecture 门禁: RESULT: PASS — 可进入 to-architecture（spec-review 通过并 auto-approved 2026-08-09）
- 用户确认: 2026-08-09 已确认产品决定；第 3 轮架构评审 auto-approved

## 架构目标

将当前“migration runner 拼接 v1～v8”替换为一个 current-schema SQLite Adapter：`openDatabase(databasePath)` 只编排空库 bootstrap、current exact reopen 与 fail-closed。schema 定义、错误类型和运行时领域 helper 各归其明确 owner；删除历史兼容代码时不削弱 current 数据不变量、业务恢复或 replay 证据。

## Module 与 Interface

### Database opener

- 保留公共 Interface `openDatabase(databasePath)`，它是唯一 schema 生命周期行为接缝。
- opener 负责安全打开连接、区分真正空库与非空库、调用 bootstrap/validator、设置必需 PRAGMA，并在失败时关闭连接。
- opener 不含逐版本分支，不调用 migration runner，不删除、覆盖、重命名或重建非空数据库。

### Current schema manifest

- 新位置：`src/server/storage/current-schema.ts`（后续目录收敛时可等价迁至 SQLite Adapter，但本片不做机会主义目录重写）。
- `CURRENT_SCHEMA.identity.userVersion` 初始固定为 `9`，与 legacy v1～v8 均不同；它是 current schema identity，不授权 8→9 migration。首次发布前每次直接改变 canonical schema 都必须同时更换 identity，使旧 canonical 快照成为 unsupported，而不是被同 identity validator 猜测修复。
- `CURRENT_SCHEMA.objects` 是完整、显式、穷尽的 canonical inventory。每一项恰含 `{kind, name, createSql, dependsOn}`，`kind` 只允许 `table | index | trigger`；每张最终表必须有一条独立、可从空库执行的最终 `CREATE TABLE`，不得引用旧 migration，也不得包含 `ALTER`、rename、copy、backfill 或临时 shadow object。
- inventory 的构造基线是“当前最终 v8 空库经全部既有升级后得到的 `sqlite_master` 快照”，作者必须逐对象核对后把最终形态重写成独立 `CREATE` DDL；该快照只是审计输入，不是生产 source of truth。约 66 张表仅作迁移清点提示，最终 table/index/trigger 数量全部由 `CURRENT_SCHEMA.objects` 按 kind 派生，禁止另设硬编码数量作为真理。
- canonical DDL 的最终且唯一 source of truth 只在 `CURRENT_SCHEMA.objects[*].createSql`。bootstrap 按 `dependsOn` 拓扑逐条消费；exact validator 从同一数组派生期望的 `(kind,name,normalizedSql)` 集合。不得保留另一份 `CREATE_V8`、`V8_TABLE_SQL`、`V8_OBJECT_SQL`、`EXPECTED_V8_SQL` 或由历史 migration 拼接的并行定义。
- manifest 自检在任何 DDL 执行前验证：`(kind,name)` 与 name 全局唯一、无 SQLite 保留名；每张表从其独立 DDL 的全部 `REFERENCES` 安全提取完整 FK dependencies，并验证目标存在且为表；index/trigger 的对象依赖必须存在且其执行图无环；每个 SQL 只创建声明的一个同 kind/name 对象、无禁止语句/多语句、identity 不在 1～8，且按 kind 派生的计数之和等于 inventory 长度。自引用与互相 FK 不伪装成无环对象图，而由 SQLite 可执行的完整 table stage 处理。自检失败是构建/测试错误，不接触数据库。
- exact validation 查询 `sqlite_master` 中所有 `name NOT LIKE 'sqlite_%'` 的 `table/index/trigger`；实际与 manifest 派生集合必须双向全等，额外、缺失、kind/name 或 normalized SQL 任一不等均失败。SQLite 自动内部对象只允许通过 `sqlite_%` 规则忽略；不存在其他 allowlist。
- SQL normalization 只消除 SQLite 持久化 DDL 的非语义格式差异；不能忽略 object、column、constraint、index predicate、trigger body 或默认值差异。

### Bootstrap

- 新位置：`src/server/storage/bootstrap-current-schema.ts`。
- `bootstrapCurrentSchema(database, CURRENT_SCHEMA)` 只对真正空库调用。manifest 自检通过后，在单个 `BEGIN IMMEDIATE` 中先执行完整 table stage（SQLite 允许声明尚未创建、自引用或互相引用的 FK），再按无环对象依赖创建 index/trigger；全部对象创建完成后才在同一事务写 `PRAGMA user_version=9`，随后运行 exact schema、`PRAGMA foreign_key_check` 与 current data invariants，全部通过才 `COMMIT`。
- 失败时回滚并抛稳定 `SchemaError`。若 SQLite 文件本身在连接时由 SQLite 创建，应用可以留下空文件，但不得留下可被误认成 current 的 partial schema。

### Exact schema 与 data-invariant validator

- 新位置：`src/server/storage/validate-current-schema.ts`。
- `validateCurrentSchema(database, CURRENT_SCHEMA)` 分两层：
  1. exact object validation：`user_version` identity、`sqlite_master` 全体非内部对象集合与逐对象 canonical SQL 双向全等，并复核 columns、PK/FK、unique/index/trigger 与关键 constraints；
  2. integrity/data validation：`PRAGMA foreign_key_check` 必须零行，再检查现有 v8 validator 中仍有效的 tuple ownership、不可变关系、state DAG/head、operation outcome、Decision/Receipt/fact、来源、恢复等 current data invariants。
- reopen 在一个一致读事务内依次读取 identity、完整 `sqlite_master`、FK 与 data invariants；成功后先结束该快照，再恢复仅连接级设置并返回连接。验证期间启用连接级 `query_only=ON`，任何 validator 都不能写。bootstrap 在其写事务 commit 前复用同一验证逻辑，避免 fresh 与 reopen 两套规则。
- legacy/partial/drift/unsupported 不进入 data repair；非法 current 数据不 backfill。

### Schema error

- 新位置：`src/server/storage/schema-error.ts`。
- `SchemaError` 取代暗示升级能力的 `SchemaMigrationError`，稳定 code 至少覆盖 `SCHEMA_DRIFT`、`SCHEMA_DATA_INVALID`、`SCHEMA_UNSUPPORTED`、`STORAGE_UNAVAILABLE`。
- storage 边界负责把 SQLite/IO 失败映射为稳定 code；API adapters 只依赖 `SchemaError` 与 code，不导入 current manifest 或历史 migration。
- 公共 message 固定脱敏，不包含 SQL、绝对路径、表内容、凭据或原始异常。

### Mission creation Application Workflow 与 Capability Interfaces

- Application 层在 `src/server/application/transaction-context.ts` 声明不透明 `TransactionContext`，在 `src/server/application/unit-of-work.ts` 声明事务协调 Port `UnitOfWork.run<T>(work: (tx: TransactionContext) => T): T`。`TransactionContext` 只表示同一事务身份，不公开 `DatabaseSync`、SQL、commit/rollback 或 Adapter 类型；只有 `UnitOfWork` 决定 begin/commit/rollback。
- Mission owner 在唯一公开入口 `src/server/mission/public.ts` 提供 Capability Interface：
  - `MissionCommandCapability.createMission(tx: TransactionContext, command: CreateMissionCommand): MissionCreated`
  - `CreateMissionCommand` 保留既有 project identity、title/goal、actor/operation 语义；外部 HTTP DTO 必须包含客户端生成的严格 UUID `operationId` 与显式 `expectedVersion=0`。Mission service 规范化 title/goal 后从完整 command 派生 `requestHash`，不提供随机或默认 fallback；相同 operation/payload 重放原结果，payload 改变稳定冲突。`MissionCreated` 至少返回 `{projectId, missionId, occurredAt}`，供 Workflow 构造下一步命令。
  - 失败保持既有 Mission validation/conflict code；Implementation 只写 Mission owner facts，不初始化 Review & Delivery。
- Review & Delivery owner 在唯一公开入口 `src/server/review/public.ts` 提供 Capability Interface：
  - `ReviewDeliveryCommandCapability.initializeForMission(tx: TransactionContext, command: InitializeMissionDeliveryCommand): MissionDeliveryInitialized`
  - command 形状固定为 `{stepId, projectId, missionId, occurredAt}`，其中 `stepId = mission-review-initialized:<missionId>:v1`；返回至少 `{stepId, deliveryHeadVersion: 1, eventSequence: 1}`。
  - tuple/step 已存在或不一致统一失败为 `MISSION_INITIALIZATION_CONFLICT`；Implementation 只写 Review & Delivery owner 的 delivery head/review event，不写 Mission facts且不自行 begin/commit。
- 命名 Workflow 位于 `src/server/application/create-mission-workflow.ts`，构造参数只接受 `{unitOfWork: UnitOfWork, missionCommands: MissionCommandCapability, reviewDeliveryCommands: ReviewDeliveryCommandCapability}`。它在一次 `unitOfWork.run` 回调中把同一个 `TransactionContext` 依次传给两个 Capability Interface：Mission 返回 `MissionCreated` 后，Workflow 派生稳定 step command，再调用 Review & Delivery。任一步抛出/返回失败都由 UnitOfWork 回滚整个事务，不产生 partial Mission 或 delivery facts。
- SQLite 事务 Adapter 位于 `src/server/storage/sqlite/sqlite-unit-of-work.ts`，是唯一把 `TransactionContext` 解析为 transaction-scoped SQLite handle 并控制 `BEGIN/COMMIT/ROLLBACK` 的 Implementation；各 owner 的 SQLite repository 只能经其私有 transaction accessor 使用该上下文。Capability Interface、Workflow 与测试 fake 均不得看到 `DatabaseSync`。
- composition root 位于 `src/server/composition/server-composition.ts`：创建共享 SQLite UnitOfWork Adapter、Mission Capability Implementation 与 Review & Delivery Capability Implementation，再注入 `createMissionWorkflow`；只有 composition root 可同时 import concrete SQLite Adapter 与两个 Capability Interface。Workflow 只能 import Application transaction Port 和两个 owner 的公开入口；Mission 禁止 import Review public/private/repository/SQL，Review 禁止 import Mission repository/SQL，任一 owner 均禁止跨 owner helper 写。
- 相同 step identity 不能产生第二 head/event，异内容复用同 step 失败关闭。current schema Module 不得导入领域 Module，任何领域运行时也不得导入 schema 历史。

### Canonical fixture

- 唯一共享技术 fixture：`tests/fixtures/current-database.ts`，只公开 `openEmptyCurrentDatabase()`，通过 `openDatabase` 创建空的 canonical schema；它不提供任何跨 owner facts builder，不复制 DDL，也不调用私有 bootstrap/validator。
- 领域 facts builder 分属 owner，例如 `tests/fixtures/mission/*`、`collaboration/*`、`execution/*`、`review/*`；跨域测试只能组合 owner builder 或通过命名 Workflow 建立事实，禁止万能数据库 fixture。
- old-schema rejection 专用 `tests/fixtures/unsupported-schema-input.ts` 只在内存数据库构造最小输入：v1～v8 各自仅写对应 `PRAGMA user_version` 加一个统一最小非空 marker；partial/extra/missing/changed object 各只施加一个变异；FK/data-invalid 从 current 空库施加一个最小非法事实。它不得复制历史全库 DDL、导出给业务测试、包含 migration/backfill，或成为可重放升级 fixture。
- Contract 波次删除 `tests/v6-fixture-db.ts`、`tests/v7-fixture-graph.ts`、`tests/v7-advance-fixture.ts`、`tests/persistent-threads-v6-fixture.ts` 及其纯升级调用方；`tests/execution-frozen-fixture.ts` 与 `tests/structured-messages-browser-fixture.ts` 若证明 current 业务行为则改名/迁至对应 owner fixture，若只证明升级则删除。最终仓库不保留任何可重建 legacy 全库的 builder。

## Canonical DDL 依赖顺序

`CURRENT_SCHEMA.objects` 必须显式形成以下可执行阶段，并由测试证明 table DDL 的 FK dependencies 完整、所有目标存在，且 table stage 完成后 index/trigger 的依赖已满足：

1. **基础 identity 与根事实**：schema identity、Project 及无外键根对象。
2. **配置与成员**：Provider、Skill、Agent、membership 及其关联。
3. **Mission/Work 与协作容器**：Mission、Work Item、Thread、policy、Run、Message 与 Thread Fact 根关系。
4. **Execution/Validation/Artifact**：execution、lease、staged observation、validation、artifact 与 recovery facts。
5. **Review/Delivery/Memory**：review attempts/events、delivery heads/versions、memory 与来源链。
6. **Structured Message**：block、state revision/head、Decision、Business Receipt 与 decision fact，遵循 source → block → state revision → head → decision → receipt → fact 的 FK 方向。
7. **Operations/Audit/Indexes/Triggers**：依赖表完成后创建 operation outcome 约束相关对象、全部 indexes 与 immutable/guard triggers。

表间自引用或互相 FK 在完整 table stage 中合法声明；数据写入仍须服从 DDL 中的 immediate/deferred 约束。index/trigger 不允许借 table-cycle 规避自己的无环依赖；不得依赖历史 migration 中“对象恰好已存在”的隐式顺序。

## 关键流程

### Fresh bootstrap

1. `openDatabase` 打开路径；分类前只允许不会写数据库头或创建 sidecar 的连接级 PRAGMA：`foreign_keys=ON`、`trusted_schema=OFF`、`busy_timeout`。禁止在接受 current 前设置 `journal_mode`、`application_id`、`user_version`、`auto_vacuum` 或其他持久 PRAGMA。
2. 检查 user objects；只有集合为空才进入 bootstrap。
3. manifest 自检通过后 `BEGIN IMMEDIATE`，按 `CURRENT_SCHEMA` 拓扑执行 canonical DDL。
4. 全部对象完成后在同一事务写 `PRAGMA user_version=9`；该写入是 bootstrap 的唯一 identity 写，reopen 永不改写它。
5. 在同一未提交事务运行 exact object、`foreign_key_check` 与 current data invariants。
6. 成功 commit 并返回连接；任一步失败 rollback、关闭连接并抛脱敏 `SchemaError`。

### Current reopen

1. 发现数据库非空。
2. 启用连接级 `query_only=ON`，执行 `BEGIN`；首次 identity/schema 读取建立一致快照。
3. 在同一快照读取 `PRAGMA user_version`；缺失、1～8、未知或不匹配立即失败。
4. 在同一快照对完整 `sqlite_master` 做双向 exact equality，再运行 `PRAGMA foreign_key_check` 与全部 current data invariants。
5. 全部通过后 `COMMIT` 结束读快照，恢复 `query_only=OFF`，返回连接；失败则 `ROLLBACK`（如事务已开始）并关闭连接。全流程不写 identity、schema 或业务数据。
6. 并发测试用第二连接在验证各阶段尝试 schema/data 变异，证明一次 reopen 只观察一个快照；变异只能在快照结束后生效，下一次 reopen 必须接受完整新 current 状态或失败关闭，不能混合观察。

### Unsupported input

- v1～v8 legacy、`user_version=0` 非空、partial current、额外/缺失/drift objects 和非法 current data 都走失败关闭。
- opener 不尝试识别“可迁移到哪个版本”，不调用 backfill，不移动或删除文件。
- 稳定错误可提示开发者人工删除本地 `.data/`，但该动作永远不由应用执行。

## 受控 expand-contract 顺序

### Expand 1：建立新 current seam

- 先为 `openDatabase` 增加 fresh、exact reopen 与 fail-closed RED tests。
- 新增 `SchemaError`、完整 inventory/identity `CURRENT_SCHEMA`、manifest 自检、bootstrap 和两层 validator；此时旧 migration 文件可暂存，但新 opener 不再通过版本链创建 fresh schema。
- 建立仅打开空 current schema 的共享技术 fixture、owner fixtures 和目的受限的 unsupported-input 构造器，证明 current representative database 可重复 reopen且 v1～v8 identity 被拒绝。

### Expand 2：迁移运行时与保留测试

- 将所有 API adapters 从 `SchemaMigrationError` 切到 `SchemaError`。
- 先建立不透明 `TransactionContext`、`UnitOfWork` Port/SQLite Adapter、两个 owner 的公开 Capability Interface 与 composition root 装配；再把 Mission 创建入口迁至 Create Mission Application Workflow，最后把旧 migration helper 收入 Review & Delivery 私有 Implementation 并删除 Mission 的跨 owner import。
- 对旧 fixtures/tests 建立清单：删除候选仅含 upgrade compatibility；保留候选证明业务历史/恢复/replay/tuple/source。
- 逐批把保留候选迁到对应 owner fixture，每批先 RED 后 GREEN，不复制 canonical DDL；unsupported-input 构造器只服务 `openDatabase` rejection contract。

### Contract：删除历史兼容面

- 删除 v1～v8 migration modules、runner、legacy detection/adoption/backfill、upgrade hooks、旧 fixture builders 和纯升级 tests。
- 删除/改名 Canonical fixture 节列出的旧 fixture；最终 rejection matrix 只保留最小内存 identity/单变异构造器，不能重放 migration。
- 删除运行时对 migration 文件的 imports，并以仓库约束测试锁定。
- 更新 015/S-13 当前文档与 reopen 证据，明确 canonical current schema 取代 v7→v8 兼容。
- 最后运行聚焦 schema/recovery、全量 tests、typecheck、build 与 diff 检查；只有 contract 波次完成后 016 才可解除 S-13 ship 阻塞。

中间阶段不得同时保留两个可选 schema writer；旧代码仅作为尚待删除的不可达资产短暂存在。若保留测试尚未迁完，不得提前删除其业务证据。

## Seam 与测试点

- **唯一公共 seam**：`openDatabase(databasePath)`。
- **Fresh**：不存在路径、空 SQLite、manifest uniqueness/完整 inventory/依赖顺序、bootstrap fault/rollback、identity 最后写入、同一 validator 接受新库。
- **Reopen**：一致读事务内 identity + `sqlite_master` exact equality + FK + data invariants，第二连接并发变异，多次/多进程 reopen，失败零写、成功前结束快照。
- **Fail-closed**：最小构造器逐一覆盖 v1～v8 identity、partial、extra/missing/changed object、FK/data invalid；稳定 code/message、原文件仍存在且内容未被应用改写。
- **Architecture constraints**：运行时无 migration imports；current DDL 只有一个 manifest 且自检唯一；Mission Workflow 只经两个 owner 的公开 Capability Interface，并只经 `UnitOfWork` Port 获得事务；共享 fixture 不含 facts builder，legacy builder 不可重放。
- **Mission Workflow Seam**：用 fake UnitOfWork 与两个 fake Capability 验证调用顺序、同一个不透明 `TransactionContext`、`MissionCreated`→initialize command 映射、稳定 step identity，以及任一步失败触发整体 rollback；不得 mock owner 私有 repository。
- **Mission SQLite integration Seam**：通过 composition root 与真实 SQLite Adapter fault injection，证明 Mission/delivery 两 owner facts 全有或全无、Capability 不自行提交；架构测试禁止 `DatabaseSync` 穿过公开 Interface、Workflow import SQLite、Mission import Review repository/SQL/helper。
- **Preservation**：operation replay/conflict、lease/recovery、tuple/source、immutable history、Mission delivery 与 Structured Message state graph 继续由 current fixture 测试。

## 风险与控制

- **误删恢复测试**：先按“schema compatibility / business invariant”分类并迁移后删除；tickets 设置显式 contract 依赖。
- **manifest 与 SQLite 实际 SQL 分歧**：fresh 和 reopen 共用 exact validator，测试逐对象变异。
- **inventory 漏项或重复**：从最终 v8 空库快照逐对象审计，manifest 自检唯一/拓扑/单对象 DDL，`sqlite_master` 实际集合与派生期望双向全等；数量仅作派生诊断。
- **空库误判**：只允许无 user object 集合进入 bootstrap；任何部分对象都失败。
- **并发 reopen 混合状态**：所有读取位于一个 query-only 一致快照，第二连接变异测试锁定；持久 PRAGMA 在接受前禁止。
- **跨 owner 私写**：Create Mission Workflow 只编排 `UnitOfWork` 与两个公开 Capability Interface；不透明 `TransactionContext` 保持同事务但不泄漏 SQLite。composition root 是唯一装配 concrete Adapter 的位置，导入规则阻止 Mission/Review 互相访问 repository、SQL 或 helper。
- **错误泄漏**：SchemaError 统一映射且 API 聚焦测试断言无 SQL/path/content。

## ADR 链接

- [ADR-0003：首次发布前采用唯一 canonical database schema](../../docs/adr/0003-pre-release-canonical-database-schema.md)（accepted）。
- ADR-0002 的领域模块化单体和事实 owner 规则继续有效；本片把 schema 技术能力与 Mission/Review Delivery 领域 helper 分开。
