# 后续功能开发前完成目标架构收敛

- 状态: accepted
- 日期: 2026-08-09

## 背景

Cool AI 已确定领域模块化单体、Ports/Adapters、跨域 Application Workflow 和目标目录结构，但当前工程仍主要位于历史 `src/server/`、按技术或产品表面形成的目录以及 route 内编排中。若继续在旧结构上开发功能，每个新切片都会增加待迁调用方、writer、fixture 和依赖边，使目标架构长期停留在文档状态。

项目尚未正式发布且没有用户。ADR-0003 已确认首次发布前只支持唯一 current canonical SQLite schema，不承诺历史 schema 或本地开发数据兼容，因此架构收敛不需要维护版本间 migration、legacy adoption、backfill 或旧数据升级路径。

## 选项

### 选项 A：功能开发与架构迁移并行

每个后续产品切片顺带迁移其触及的旧代码。

短期功能吞吐较高，但新旧 Interface、目录和 writer 会长期并存；未被新功能触及的旧模块没有明确完成时间，机械约束也难以转为阻断。

### 选项 B：一次性大爆炸重写

冻结所有开发，在一个不可分割改动中重写目录、Interface、Adapter、Workflow 和测试。

目标直接，但长时间失去可构建基线，回归定位困难，也违反单个实现批次的上下文和验证预算。

### 选项 C：架构优先、分波收敛

暂停后续产品功能实现，把完整目标架构收敛设为阻塞前置；按 owner 和调用接缝拆成连续、可独立验证的迁移波次。每波同时迁移 Interface、Implementation、Adapter、调用方、fixture 与测试，不保留长期双写或双 Interface。全部旧入口删除并通过机械约束与全量验收后，才恢复功能开发。

## 决定

选择选项 C。

1. 当前工程的完整目标架构收敛成为下一项基础交付；在其完成前，后续产品特性不得进入 implement。只允许修复恢复既有行为、安全边界或构建基线所必需且具有独立票据、失败证据与聚焦验证的阻塞缺陷；非阻塞缺陷、体验扩展和新能力继续冻结。
2. 已经存在于当前源码中的实现，无论是否已 ship，都属于迁移基线；仍处于规格、架构或票据阶段且尚未实现的行为暂停，不作为迁移范围扩张。
3. 收敛目标是 `product/architecture.md` 第 7 节定义的物理结构、Interface、依赖方向和测试分治。只增加 wrapper、alias、barrel export 或空目录不算完成。
4. 执行按 owner/接缝分波；每波只有在适用目录迁移判据、聚焦测试和构建通过，该波旧入口删除，且不存在双写、双事实 owner、双 Interface 或长期兼容层时才能推进。
5. 首次发布前不迁移历史 SQLite schema 或本地开发数据。只保留 `CURRENT_SCHEMA` 的 fresh bootstrap、exact reopen 与非法非空数据库失败关闭；应用不得静默删除或重建非空数据库。
6. 全部生产代码、测试和 fixture 迁入目标结构，旧 `src/server/`、跨域 deep import、route 业务编排、重复 writer、兼容 re-export 和临时 alias 删除，架构检查、全量测试、构建、现有浏览器 smoke 与用户确认完成后，才解除功能冻结。Review 是否执行服从 `AGENTS.md` 当时生效的项目级政策，本 ADR 不静默恢复已豁免的 review。

## 后果

正向后果：

- 目标架构从“后续渐进方向”变成有终点和门禁的工程状态，不再让新功能扩大旧结构。
- owner、Interface、Adapter、Workflow 与测试归属可以在完整迁移后由机械规则阻断回退。
- 无历史数据兼容矩阵，storage 收敛只需证明 current bootstrap、exact reopen、数据不变量和失败关闭。
- 分波迁移保留短反馈环和可回归基线，避免一次性重写。

代价与约束：

- 后续产品功能交付暂停，直到架构收敛完成。
- 迁移会触及大部分生产代码和测试，必须拆为短小内聚波次并维护明确失败清单。
- “纯迁移”不得成为机会主义重构；公共行为变化必须单独记录和评审。
- 当前开发数据库在 current schema 改变或不匹配时需要开发者显式删除重建。

## 完成判据

- 所有当前生产代码位于目标角色目录，旧 `src/server/` 与兼容入口删除。
- 每类命令事实和可写表有唯一 owner，运行时 writer 与 manifest 一致。
- 跨 owner 命令只由命名 Application Workflow 协调，入站 Adapter 不直接依赖 repository 或具体 outbound Adapter。
- 测试按 Module、Workflow、Adapter、browser、architecture 与 owner fixture 分治。
- import、dependency、owner 与 writer 检查为阻断状态且通过。
- 聚焦测试、全量测试、生产构建、现有浏览器 smoke 和用户确认全部完成；Review 按届时 `AGENTS.md` 生效政策执行。

## 重新评估触发条件

只有出现已发布用户数据必须保留、外部发布承诺或架构收敛发现目标所有权模型无法表达现有业务不变量时，才重新评估本决定。单纯希望更快继续功能开发不构成绕过冻结的理由。
