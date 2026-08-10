# 架构 — Mission 依赖与阻塞全景

- 日期: 2026-08-10
- 对应规格: [`spec.md`](./spec.md)
- 状态: 项目级 review 豁免生效；未送独立评审，不伪造工件

## 架构目标

只读派生读模型：从现有 work item `dependencyIds` 事实派生 Mission 依赖全景；零新表、零写能力；复杂性留在 Mission & Work 模块查询实现。

## Module 与 Interface

- Mission & Work 公开 Queries 新增 `getMissionDependencyInsight(projectId, missionId)`：
  - 入参 tuple 校验；mission 不存在/跨 tuple 稳定 404。
  - 返回 `MissionDependencyInsightDto`：`nodes[]`（workItemId、title、status、blockedByIds、blockingIds、blockedReason、cycleId?）、`edges[]`（from→to，稳定序）、`cycles[]`（id、memberIds、路径）、`hasDependencies`。
  - DTO 进 `src/modules/mission-work/public/dto.ts`；如需跨边界共享则落 `src/shared/`。
- 依赖边语义：work item A `dependencyIds` 含 B ⇒ 边 B→A（B 阻塞 A）。blockedReason 从依赖项现有状态派生（未完成/失败等既有状态词汇，不新造状态）。
- 循环检测：确定性（节点按 id 排序后 DFS/Tarjan），输出稳定；循环节点 `cycleId` 标注，拓扑展示时循环整体成组。

## 关键流程

1. UI 进入 Mission 依赖区 → GET tuple 路由 → 查询派生 → 渲染节点/边列表。
2. 循环存在 → 循环组明确标注；无循环 → 分层（按深度）列表。
3. 节点激活 → 复用现有任务详情导航；视图无任何写入口。

## Seam 与测试点

- Seam 1 — Dependency Query：`tests/modules/mission-work/` 新增测试（空/链/菱形/自环/多环/混合/404/确定性）。
- Seam 2 — 依赖视图 UI：现有 mission/work UI 测试位置扩展（jsdom）。
- Seam 3 — 浏览器验收：复用覆盖 mission 面板的现有 smoke（勘察后定）。

## 横切约定

- tokens/键盘/44px/可访问名称；empty/loading/error/focus 全态；错误脱敏；无第二状态机；不引入图形库（列表化呈现）。

## ADR 链接

- 遵守 ADR-0003；无新增难逆转决定。
