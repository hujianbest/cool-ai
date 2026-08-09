# 016 — 首次发布前唯一 canonical schema

- 模式: 建造
- 用户可感知: 否
- 执行模式: auto
- 主架构单元: SQLite 持久化 Adapter
- 公共行为接缝: `openDatabase(databasePath)`
- 依赖: 当前 v8 运行时行为与 S-13 已实现数据不变量
- 阻塞: S-13（015）进入 ship

## 目标

在首次正式发布前把 SQLite 持久化收敛为一个 current canonical schema：空库可完整 bootstrap，完全匹配 current schema 的数据库可 reopen，其他非空 schema 一律失败关闭；删除没有用户兼容价值的 v1～v8 顺序升级路径、legacy adoption/backfill 与旧 schema fixtures，同时保留业务历史、崩溃恢复和重放不变量。

## 范围

- 以 `openDatabase(databasePath)` 为唯一公共行为接缝定义 fresh bootstrap、exact reopen 与 fail-closed 矩阵。
- 建立唯一 `CURRENT_SCHEMA` manifest、canonical bootstrap、exact object validator 与 current data-invariant validator。
- 将稳定且脱敏的 schema 错误从历史 migration 模块迁至 current schema 边界。
- 将 `initializeMissionDeliveryTx` 等运行时领域 helper 迁出 migration 模块，避免运行时代码依赖被删除的历史升级实现。
- 删除 v1～v8 migration 模块、legacy adoption/backfill、顺序升级测试和旧 schema fixtures。
- 将仍证明业务历史、operation replay、恢复、tuple、来源与数据不变量的测试改用 canonical current-schema fixture。
- 更新 015/S-13 的活跃文档，使其 ship 明确受本特性阻塞且不再承诺 v7→v8 兼容。

## 非目标

- 不修改任何用户可见功能、HTTP 或 UI 契约。
- 不由应用静默删除、重命名、覆盖或重建非空数据库。
- 不保留任何首次发布前的版本间 migration、legacy adoption/backfill 或旧 schema fixture。
- 不削弱 exact-schema、数据不变量、原子事务、tuple ownership、operation/version/lease、恢复或失败关闭要求。
- 不建立首次正式发布后的升级兼容政策；该政策必须由新的 ADR 和规则变更另行决定。

## 用户确认

- 2026-08-09：用户确认系统从未正式发布、无人使用、本地开发数据库可丢弃；禁止继续维护 v1～v8 升级兼容，并要求以唯一 current canonical schema 清理实现。
