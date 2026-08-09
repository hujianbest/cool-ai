# 架构 — 结构化消息完整性

- 日期: 2026-08-09
- 对应规格: [`spec.md`](./spec.md)
- 状态: 待 spec-review；架构草案，未送独立 architecture-review
- 用户确认: auto-approved 2026-08-09（不等于独立评审通过）

## 架构目标

以两个高杠杆 seam 共同闭合一个信任结果：写时冻结、读时只投影 File Reference；`openDatabase` 对全部 current 结构化事实做双向穷尽验证。复杂性留在 Public Collaboration 与 SQLite Adapter 的 deep Modules 内，不扩散到 UI caller。

## Module 与 Interface

### Structured Message Source Projection Module

- Write Interface 接受已验证的 project/thread/run/message/block 与 source tuple，解析明确 `sourceEntityVersion`，在业务事务内生成、脱敏、grapheme 限长并冻结 `publicName`。
- Public Read Interface 只返回持久化的冻结 source projection；调用方无需知道 artifact 表、宿主路径或名称演变。
- Implementation 禁止读取时 join mutable `name`、选择 latest、回退原路径或回显原始异常；File Reference UI 只消费 `{publicName, sourceEntityVersion, navigationIdentity}`。

### Current Schema Module

- `CURRENT_SCHEMA` 直接加入冻结 projection 所需 final shape/constraints 并更换 current identity；无 migration、ALTER、copy、backfill 或 legacy branch。
- fresh bootstrap 与 exact reopen 从同一 manifest 派生；非法非空输入只失败关闭。

### Current Data Integrity Module

- `openDatabase(databasePath)` 是唯一外部 schema 生命周期 Interface；validator 是其内部 Implementation，不另暴露测试 seam。
- validator 先枚举 operation、block、state revision/head、source、Decision、Business Receipt、decision Fact 全集，再建立 typed identity maps，检查集合基数、双向边与逐字段等式。
- state DAG 检查每个 block 的唯一初始 revision、连续版本、唯一后继、无环与 head=唯一末端；source 检查冻结 projection、source version 与 block identity 全等。
- completed outcome 检查 operation ↔ Decision ↔ Receipt ↔ Fact 恰好一对一；非成功终态不得拥有业务结果。
- Checklist transition 对相邻完整 state 做结构比较，仅允许目标 item 的 checked 位按 action 方向变化。

### Test Fixture Modules

- Structured Message owner fixture 经正式公共命令建立合法 current 图，只提供目的受限的单一 corruption 操作；不复制大型 direct SQL 图。
- Mission caller fixture 显式传 command identity/version；Review fault fixture 保持真实事务回滚 seam。
- Busy-timeout harness 只记录复现次数、锁阶段和连接生命周期，不成为生产重试策略。

## 核心数据

- File source projection: block/source identity、`sourceEntityVersion`、冻结 `publicName`、现有 canonical metadata/hash。
- Decision graph: operation outcome、block revision、state from/to、Decision、Business Receipt、decision Fact；每条成功链基数均为 1。
- Checklist state: stable item identity/order/text + checked state；一次 edge 只允许目标 checked 位变化。

## 关键流程

1. **提交/读取 File Reference**：验证 source tuple/version → 生成安全公开名称 → 与 block 原子冻结 → public read 仅解码冻结事实 → 改名/latest/reopen 不改变输出。
2. **Current reopen**：`openDatabase` 在一致 query-only 快照执行 exact schema/FK → 枚举全集 → 验证 source 与 state DAG → 验证 operation/result 双向矩阵与 Checklist edge → 成功结束快照或稳定脱敏失败且零写。
3. **回归收口**：正式测试入口建立 current facts → fault/caller/锁生命周期修复 → 聚焦测试 → 一次有目标的全量确认。

## Seam 与测试点

- **Seam 1 — `openDatabase(databasePath)`**：合法 fresh/reopen；每个集合的 orphan/duplicate/cross-tuple/field mismatch；Checklist 非法 edge；completed/terminal outcome 矩阵；失败关闭且无 repair。
- **Seam 2 — Structured Message Source Public Read**：写后读、source 改名、新 latest、process reopen、public response/DOM/log 泄漏检查。
- RED/GREEN 只跨这两个公开 Interface 及既有 Mission/Review 公共回归 seam；不直接断言私有 SQL 查询或 helper 调用。

## 横切约定

- 错误沿现有稳定脱敏 envelope；绝不包含 SQL、宿主路径、credential、raw Provider 或非法行内容。
- schema 改动遵守唯一 current canonical 规则；测试 fixture 从 owner public command 建图。
- SQLite busy-timeout 诊断墙钟 15 分钟、最多 10 次量化；若无明确根因，停止并记录证据/拆后续票，禁止加无界重试。
- File Reference 浏览器证据复用 Cool tokens/components 与既有消息壳，只展示冻结名称，无新视觉系统。

## ADR 链接

- 继续遵守 [ADR-0003](../../docs/adr/0003-pre-release-canonical-database-schema.md)；本片没有新增难以逆转的架构决定，不创建 ADR。
