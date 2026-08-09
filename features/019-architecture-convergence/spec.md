# 019 规格 — 目标架构收敛

- 日期: 2026-08-09
- 上游: `product/architecture.md` 第 7～10 节；`docs/adr/0004-architecture-first-convergence.md`；D-44
- Review 豁免: 项目级 review 豁免（AGENTS.md 当前开发阶段条款，2026-08-09）适用于本特性全部阶段

## 用户结果

本特性不产生新用户结果；它交付的"结果"是工程状态：目标架构从文档变为机械可阻断的现实，后续功能开发在收敛完成后恢复。验收判据即 ADR-0004 完成判据：

1. 所有当前生产代码位于目标角色目录，旧 `src/server/` 与兼容入口删除。
2. 每类命令事实和可写表有唯一 owner，运行时 writer 与 manifest 一致。
3. 跨 owner 命令只由命名 Application Workflow 协调，入站 Adapter 不直接依赖 repository 或具体 outbound Adapter。
4. 测试按 Module、Workflow、Adapter、browser、architecture 与 owner fixture 分治。
5. import、dependency、owner 与 writer 检查为阻断状态且通过。
6. 聚焦测试、全量测试、生产构建、现有浏览器 smoke 全部通过；Review 服从项目级豁免。

## 冻结基线（2026-08-09，本特性 T-01 固定）

- 全量测试基线: 227 个测试文件 / 1803 个测试；**22 个文件 / 128 个测试失败**，其中：
  - 127 个失败为 Windows-only 执行测试（`execution-*`、`merge-*`、`sandbox-*`、`workspace.service` 等）：本机为 Linux，verified-handle 按 A-60 设计失败关闭（SANDBOX_UNVERIFIABLE），属环境性失败，非回归。
  - 1 个失败为 `tests/architecture-boundaries.test.ts` 的 stale 断言（仍期待旧版 `product/architecture.md` 含 "D-43"/"superseded" 字样）：构建基线阻塞缺陷，T-01 修复（失败证据已落盘于本行）。
- 生产构建基线、浏览器 smoke 基线随 T-01 一并记录。

## 行为保持约束

- 只改变模块位置、依赖方向、Interface/Adapter 所有权和装配方式；公共行为、安全组合、错误 envelope、事务原子性与不可变历史保持不变。
- 每波退出门禁：适用的目录迁移完成判据（`product/architecture.md` 第 407～415 行）满足，聚焦测试与生产构建通过，该波旧入口已删除，不存在双写、双事实 owner、双 Interface 或长期兼容层。
- 首次发布前数据政策不变：唯一 `CURRENT_SCHEMA` 的 fresh bootstrap、exact reopen、非法非空数据库失败关闭。

## 规模检查

- 16 张票，按波次串行（每波一个可验证切片、一次提交）；超过 8 票属"基础模块重构"性质，已按 AGENTS.md 规模护栏以"有边界的扩张—收缩批次"处理：每波独立验证、保持构建通过，不堆叠到单一不可验证大批次。
- 例外记录: 用户明确要求按最新架构完成收敛（2026-08-09），规模例外与验证成本记录于 `progress.md`。
