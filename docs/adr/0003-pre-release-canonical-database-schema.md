# 首次发布前采用唯一 canonical database schema

- 状态: accepted
- 日期: 2026-08-09

## 背景

Cool AI 尚未正式发布且没有用户。现有 SQLite v1～v8 顺序升级实现、legacy adoption/backfill、旧 schema fixtures 与升级测试只服务可丢弃的本地开发数据，却持续扩大持久化代码、测试矩阵和跨模块耦合。运行时代码还从 migration 模块导入 schema 错误和 Mission delivery 初始化 helper，使历史升级实现成为业务运行时依赖。

用户已明确确认：现有本地开发数据库可以人工丢弃，不存在升级迁移需求；首次正式发布前不得继续维护历史 SQLite schema 或开发数据兼容。现有 exact-schema、数据不变量、原子事务、恢复与失败关闭要求仍然有效。

## 选项

### 选项 A：继续维护 v1～v8 顺序 migrations

保留所有历史 manifest、升级分支、backfill、fault injection 与旧 fixture，后续 schema 继续递增版本。

这能保留开发数据库，但把尚未对用户作出的兼容承诺固化为长期成本，并让每次 current schema 变化都乘上无实际消费者的升级矩阵。

### 选项 B：启动时静默删除或自动重建不兼容数据库

检测到 legacy、partial 或 drift 后由应用删除数据库并创建 current schema。

实现简单，但会把损坏、误指路径或未来真实数据问题伪装成成功，违反失败关闭与“应用不得静默丢数据”的安全边界。

### 选项 C：首次发布前只支持唯一 current canonical schema

不存在的路径或空数据库按唯一 canonical manifest 原子 bootstrap；完全匹配 current schema 且满足数据不变量的数据库可幂等 reopen；任何其他非空 schema 以稳定、脱敏错误失败关闭。开发者需要时人工删除并重建 `.data/`。

## 决定

选择选项 C。

1. `openDatabase(databasePath)` 是公共行为接缝，只接受两类输入：
   - 不存在的路径或空数据库：原子创建完整 current canonical schema，验证后才可使用；
   - current exact schema：执行 exact object validation 与 current data invariants 后 reopen。
2. 非空 legacy、partial、drift、unsupported schema 以及非法 current 数据一律失败关闭；不迁移、不 adoption/backfill、不静默删除或重建。
3. 首次正式发布前只维护一份 `CURRENT_SCHEMA` manifest。DDL、期望对象清单、bootstrap 与 exact validator 必须从该唯一来源一致地产生或消费。
4. 删除 v1～v8 版本间 migration 模块、旧 schema fixture 和只证明升级兼容的测试。证明业务历史、operation replay、恢复、tuple、冻结来源及其他 current 数据不变量的测试继续保留，并迁至 current-schema fixture。
5. schema 错误移到独立 current storage 边界；Mission delivery 等运行时领域 helper 移回其事实 owner 模块，运行时代码不得依赖历史 migration 文件。
6. 本决定 supersede D-35 中“未来继续支持旧 schema 升级兼容”的要求，但不删除或改写 D-35 作为 S-12 当时交付历史的记录。

## 后果

正向后果：

- schema 行为只有 fresh bootstrap、exact reopen 与 fail-closed 三类，公共契约和测试矩阵显著收敛。
- current DDL 与 validator 不再跨 v1～v8 文件拼接，减少 partial schema、顺序依赖和运行时误导。
- 非空不兼容数据库不会被应用静默破坏；错误保持稳定且不泄漏宿主路径、SQL 或数据内容。
- 业务恢复和不可变历史不变量继续通过 current schema 数据测试验证，而不是与历史升级兼容绑定。

代价与约束：

- 当前开发数据库在 schema 变化后可能无法打开，开发者必须明确选择人工删除并重建。
- schema 改动必须同步更新 canonical manifest、exact validator、fresh bootstrap 与 reopen tests；不能用 migration 补丁掩盖 manifest 不一致。
- 删除 migration fixtures 时必须区分“只证明旧版本升级”与“仍证明业务历史/恢复”，后者不得误删或弱化。
- 清理采用受控 expand-contract：先建立 current seam 与共享 fixture，再迁移调用方和保留测试，最后删除旧实现，避免中间状态失去验证。

## 拒绝的行为

- 拒绝继续维护或新增 v1～v8 及后续首次发布前版本间 migration。
- 拒绝 legacy adoption、backfill、旧 schema fixture 和“尽力修复”分支。
- 拒绝应用在启动时静默删除、覆盖、重命名或自动重建非空数据库。
- 拒绝以放宽 exact-schema、数据不变量或错误脱敏来换取 reopen 成功。

## 重新评估触发条件

首次正式发布后，出现需要让已发布用户保留真实数据跨版本升级的产品承诺时，必须在实现任何兼容代码前：

1. 新建 ADR，明确支持窗口、升级路径、备份/回滚、失败与恢复语义、测试矩阵和所有权；
2. 修改根 `AGENTS.md` 的首次发布前规则；
3. 以独立特性重新设计 migration/adoption 策略。

仅有本地开发便利、旧 fixture 存在或历史 migration 代码尚未删除，不构成重新评估理由。
