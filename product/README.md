# Cool AI 产品文档

- 日期: 2026-08-16
- 状态: 生效。本目录是产品层事实源；实现与测试冲突时先保护数据与安全，再修正文档或另开行为变更切片。

## 七份关键文档

| 文档 | 路径 | 职责 |
|---|---|---|
| 产品规格说明书 | [`product.md`](./product.md) | 用户、价值、范围、原则、演进层与已确认边界 |
| 领域词汇表 | [`词汇表.md`](./词汇表.md) | **统一语言**：限界上下文用词、聚合、禁用同义 |
| 产品架构设计说明书 | [`architecture.md`](./architecture.md) | 领域模块化单体、事实所有权、不变量、上下文地图与适应度 |
| 特性分解清单 | [`backlog.md`](./backlog.md) | Capability、P0–P5 切片映射、已交付/在途/规划切片 |
| 开发计划 | [`development-plan.md`](./development-plan.md) | **交付顺序单一事实源**：步骤规则、阶段目标、前后端拆分与验收 |
| 开发进展 | [`progress.md`](./progress.md) | 产品层当前阶段、下一步与状态记录 |
| UI 设计 | [`ui/UI设计.md`](./ui/UI设计.md) | UCD：人物、旅程、信息架构、交互与全态；视觉令牌见 [`ui/DESIGN.md`](./ui/DESIGN.md) |

## 阅读顺序

- **理解产品**：规格说明书 → 领域词汇表 → 架构设计说明书 → UI 设计。
- **开始开发**：开发计划 → 开发进展 → 当前特性 `features/*/progress.md`。
- **拆分或排期**：特性分解清单（先看阶段映射，再看 Capability 与切片记录）。

## 附录（不是主路径）

历史台账不并入七份关键文档，避免把方向、实现增量和默认选择混在一层：

- [`decisions.md`](./decisions.md) — 已确认决策，只追加不删改。
- [`assumptions.md`](./assumptions.md) — agent 默认选择台账。
- [`ui/archive/`](./ui/archive/) — 已 superseded 的视觉分析。
- [`phases.md`](./phases.md) — 重定向到开发计划，保留旧链接。

`features/` 仍是各切片规格、架构、票据、评审与进度的工作区；切片 ship 后回写特性分解清单与开发进展，不把 feature 目录当成产品定义。
