# 019 — 目标架构收敛（架构优先冻结的执行特性）

- 模式: 建造
- 用户可感知: 否（纯结构调整，公共行为保持；ADR-0004 完成判据仍要求现有浏览器 smoke 通过）
- 执行模式: auto
- 对应决策: D-44 / ADR-0004（后续功能开发前完成目标架构收敛）
- 主架构单元: 全部十个逻辑子系统 Module + Application Workflow + Adapter + composition root
- 公共行为接缝: 既有公共命令/查询/API 行为不变；fresh bootstrap / exact reopen / operation/version/lease / tuple 与安全组合不变
- 依赖: 产品层目标架构 `product/architecture.md` 第 7～10 节已确认（2026-08-09）
- 阻塞: 全部后续产品特性（015/S-13 第 4 轮 review、017、018 及 S-14 以后）在收敛完成前不得进入 implement

## 目标

把当前全部生产代码、测试、writer 与装配迁入 `product/architecture.md` 第 7 节目标目录结构并删除旧入口，使 import、owner、writer、依赖图机械约束转为阻断且通过。

## 范围

- 按 owner/接缝分波迁移：清单与护栏 → current storage → 九个已有代码的领域 Module → runtime/model-runtime Adapter → Application Workflow → 入站与装配 → 测试分治 → 收缩旧结构验收。
- 每波同时迁移 Interface、Implementation、Adapter、调用方、fixture 与测试，并删除该波旧入口。
- 建立机器可读 write-ownership manifest 与可执行 dependency manifest；架构检查逐波转阻断。
- 只允许修复恢复既有行为、安全边界或构建基线所必需的阻塞缺陷（独立票据、失败证据、聚焦验证）。

## 非目标

- 不新增产品能力、Capability 或 Adapter；规格/架构/票据阶段的未实现行为不借迁移落地。
- 不迁移历史 SQLite schema 或本地开发数据；不保留版本间 migration、legacy adoption/backfill。
- 不建立长期双写、双事实 owner、双 Interface 或仅转发旧实现的兼容层。
- 不做机会主义重构；公共行为变化必须单独记录。

## 用户确认

- auto-approved 2026-08-09：用户不在电脑前，明确指示"如果有待确认项，则按推荐结果接受"；默认选择记录于 `product/assumptions.md` A-98～A-104。
