# 任务票 — 首次发布前唯一 canonical schema

- 状态: to-tickets 已完成复核；implement 门禁 PASS
- 规模: 5 张受控 expand-contract 票；单一 SQLite Adapter 架构单元；唯一公共行为接缝 `openDatabase(databasePath)`
- TDD: 每票只推进一个有效 RED，再以最小 GREEN 闭合；不得以编译失败、删除断言或跳过测试制造 RED/GREEN

- [x] T-01 建立 fresh canonical bootstrap 与 exact reopen — Blocked by: None
  - 波次: Expand 1
  - 主要归属/路径: SQLite Storage Adapter；`src/server/storage/{current-schema,bootstrap-current-schema,validate-current-schema,schema-error}.ts` 与 `src/server/db.ts`
  - 公共缝: `openDatabase(databasePath)`
  - RED: 对不存在路径、空 SQLite、重复 reopen、partial/non-empty `user_version=0` 与第二连接并发变异各新增一个最高层行为测试；增加 manifest 自检与 `sqlite_master` 额外/缺失/改变对象测试，证明现有版本链缺少完整 inventory、独立 identity 和一致快照。
  - GREEN: 从最终 v8 空库快照逐对象审计，建立与 v1～v8 不同 identity 的 `CURRENT_SCHEMA`；inventory 显式穷尽每个 table/index/trigger 的最终单对象 `CREATE` 与依赖，数量按 kind 派生且 manifest 自检唯一/无环/无历史 SQL。空库在单个 `BEGIN IMMEDIATE` 内创建全部对象、最后写 `PRAGMA user_version`、验证后提交；current reopen 在 query-only 一致读事务内完成 identity、`sqlite_master` 双向全等、`foreign_key_check` 与 data invariants。
  - 验证: 实际非内部 `sqlite_master` 与 manifest 派生 `(kind,name,SQL)` 集合逐项双向全等；无第二 DDL source；bootstrap fault 不留下可接受 partial schema；并发 reopen 不混合快照，失败零写且关闭连接。
  - 验证命令: `npm test -- tests/current-schema.test.ts`；`git diff --check`

- [x] T-02 纵向闭合 unsupported schema 与稳定错误 — Blocked by: T-01
  - 波次: Expand 1
  - 主要归属/路径: SQLite Storage Adapter；`src/server/storage/schema-error.ts`、既有 schema error inbound adapters、`tests/fixtures/unsupported-schema-input.ts`
  - 公共缝: `openDatabase(databasePath)`
  - RED: 用目的受限的最小内存构造器分别构造 v1～v8 identity + 统一非空 marker、partial、单一 object/DDL drift、unsupported identity、FK 与 current data invalid，先证明至少一个现有输入被迁移、修补或错误泄漏。
  - GREEN: 将 `SchemaError` 迁至 current storage 边界，统一稳定脱敏 code/message；所有非空非 exact 输入失败关闭，关闭连接且绝不 migration/adoption/backfill/delete/rebuild。
  - 验证: 构造器不复制历史全库 DDL、不执行 migration/backfill、不导出给业务测试；每类输入断言文件仍存在且事实未改写，错误无 SQL、绝对路径、表内容或凭据；既有 inbound adapters 只映射稳定 `SchemaError`。
  - 验证命令: `npm test -- tests/current-schema-rejection.test.ts tests/schema-error-adapters.test.ts`；`git diff --check`

- [x] T-03 迁出运行时领域 helper 并建立 canonical fixture — Blocked by: T-01, T-02
  - 波次: Expand 2
  - 主要归属/路径: Create Mission Application Workflow、Mission 与 Review & Delivery owners；`src/server/application/*`、`mission/public.ts`、`review/public.ts`、`storage/sqlite/sqlite-unit-of-work.ts`、`composition/server-composition.ts`
  - 公共缝: `openDatabase(databasePath)`；Mission 创建公共领域接缝
  - RED: Workflow seam 先以 fake `UnitOfWork`、`MissionCommandCapability`、`ReviewDeliveryCommandCapability` 冻结同一 `TransactionContext`、调用顺序、Mission 返回值到稳定 step command 的映射及任一步失败整体 rollback；架构测试先证明现状仍有 migration helper import、SQLite 类型穿透或 Mission→Review deep import。
  - GREEN: 依序建立 `application/transaction-context.ts` 的不透明 context、`application/unit-of-work.ts` 的事务协调 Port、`mission/public.ts` 与 `review/public.ts` 两个 Capability Interface、`storage/sqlite/sqlite-unit-of-work.ts` Adapter、`composition/server-composition.ts` 装配及 Create Mission Application Workflow。Workflow 构造参数只接受 UnitOfWork 和两个 Capability；Review Implementation 只写自身 facts 且不提交。最后删除 Mission 对 migration/Review helper 的 import，并新增共享 `openEmptyCurrentDatabase()` 技术 fixture与 owner builders。
  - Interface 契约: `createMission(tx, command) -> {projectId, missionId, occurredAt}`；`initializeForMission(tx, {stepId, projectId, missionId, occurredAt}) -> {stepId, deliveryHeadVersion, eventSequence}`；后者冲突为 `MISSION_INITIALIZATION_CONFLICT`。公开类型不得包含 `DatabaseSync`、SQL 或 Adapter。
  - 验证: Workflow fake seam 验证同 context/顺序/映射/rollback；真实 SQLite composition + fault injection 证明 Mission/delivery facts 全有或全无且 Capability 不自行提交；import-boundary 检查禁止 Workflow→SQLite Adapter、Mission→Review repository/SQL/helper、SQLite 类型穿过 Capability。相同 step 不重复；共享 fixture 无 facts builder，运行时领域模块不再导入版本 migration。
  - 验证命令: `npm test -- tests/create-mission-workflow.test.ts tests/mission-transaction-composition.test.ts tests/architecture-boundaries.test.ts`；`git diff --check`

- [x] T-04 迁移保留的业务历史与恢复测试 — Blocked by: T-03
  - 波次: Expand 2
  - 主要归属/路径: 各事实 owner 的 test fixtures；`tests/fixtures/{mission,collaboration,execution,review}/` 与受影响恢复 suites
  - 公共缝: `openDatabase(databasePath)` 及各测试原有业务公共接缝
  - RED: 建立 migration asset 清单，将测试标为“仅 schema upgrade”或“仍证明 current 业务不变量”；逐批把后者切到 canonical fixture，确保 fixture 未满足时测试先因缺失 current setup 有效失败。
  - GREEN: 迁移 operation replay/conflict、lease/recovery、tuple ownership、冻结 source/provenance、Mission delivery、Structured Message state/Decision/Receipt/fact 等保留测试到对应 owner fixtures；计划删除 `v6-fixture-db.ts`、`v7-fixture-graph.ts`、`v7-advance-fixture.ts`、`persistent-threads-v6-fixture.ts`，并将仍证明 current 行为的 `execution-frozen-fixture.ts`、`structured-messages-browser-fixture.ts` 改名/迁入 owner 目录，否则删除。
  - 验证: 每批对应聚焦 suites 通过；保留行为与旧 fixture 下等价；清单中不存在未分类 caller、万能 fixture 或可重放 legacy 全库 builder；不得以散落 direct SQL 复制大型图。
  - 验证命令: `npm test -- tests/collaboration-operations.test.ts tests/run-recover-tuple.test.ts tests/structured-message-reopen.test.ts tests/delivery-service.test.ts tests/current-mission-initialization.test.ts`；`git diff --check`

- [x] T-05 收缩删除 v1～v8 兼容面并解除 S-13 阻塞 — Blocked by: T-04
  - 波次: Contract
  - 主要归属/路径: SQLite Storage Adapter contract；删除历史 `src/server/migrations*.ts`、旧 fixtures/升级 tests，并更新 015 活跃文档
  - 公共缝: `openDatabase(databasePath)`
  - RED: 架构约束测试枚举仍存在的 migration modules/runners、legacy adoption/backfill、列明的旧 fixtures、upgrade-only tests、运行时 migration imports、万能 fixture 与第二 DDL manifest，并先对当前树失败。
  - GREEN: 删除全部 v1～v8 migration 兼容资产、可重放 legacy fixtures 和不可达分支；只保留自检的 `CURRENT_SCHEMA`、current validators、空 current 技术 fixture、owner fixtures、最小 unsupported-input 构造器与业务恢复测试；更新 015/S-13 活跃文档以 canonical reopen 证据取代 v7→v8 兼容。
  - 验证: inventory/identity/fresh/一致快照 exact/fail-closed matrix、v1～v8 最小 identity rejection、全部受影响 schema/recovery suites通过；仓库约束证明无旧 migration/legacy fixture/runtime import；016 完成后方可让 015 重新检查 ship 门禁。
  - 验证命令: `npm test`；`npx tsc --noEmit`；`npm run build`；`git diff --check`
