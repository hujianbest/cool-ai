# Mission 依赖与阻塞全景需求规格

- 日期: 2026-08-10
- 特性: 026-mission-dependency-insight
- 对应切片: S-25（CI-4.4）
- 模式: 建造
- 用户可感知: 是
- 执行模式: auto（用户不在场，问题按助手推荐处理并记录假设）
- 共享理解来源: `product/backlog.md` S-25 条目（auto-approved 2026-08-10）；前置 `CAP-MWK-01` 已交付核心
- 公共行为接缝: Mission Dependency Query（Mission & Work）；Mission 详情/依赖视图 UI
- 主子系统: Mission & Work；主 Capability: `CAP-MWK-02`（本片建立其只读依赖、循环与阻塞查询）

## 问题陈述

复杂 Mission 下 owner 无法整体看到任务之间的依赖关系、哪些任务被谁阻塞、是否存在循环依赖；只能逐个点开任务猜测全局状态，排障与排期都靠脑补。

## 解决方案

为 Mission 提供只读依赖全景查询与视图：以现有 Mission/Work Item 事实源（不建第二套任务事实）派生节点（任务）与边（依赖关系），输出每节点阻塞状态与原因、循环检测（循环中节点明确标注，不假装有拓扑序）、以及从节点跳回现有任务详情的定位。数据为实时派生读模型（非持久投影），刷新即与事实源一致。

## 用户故事

1. **作为 owner，我想查看 Mission 的只读依赖图/列表，从而理解任务先后关系。**
   - 视图列出全部任务节点与依赖边；每节点显示标题、现有状态、直接阻塞它/被它阻塞的任务。
   - 依赖关系若当前事实源没有显式字段，则从现有 work item 数据中的既有阻塞/关联语义派生；若完全没有可用依赖事实，视图如实显示"该 Mission 暂无依赖关系"empty 态，不伪造边。
2. **作为 owner，我想看到循环与阻塞原因，从而定位排障入口。**
   - 循环依赖被检测并明确标注（涉及节点列出、循环路径可读）；阻塞原因聚合现有状态语义（如依赖未完成、依赖失败）。
   - 无依赖环时正常拓扑分层展示；查询失败/无权限 tuple 稳定脱敏错误。
3. **作为 owner，我想从节点定位现有任务，从而不产生第二套任务事实源。**
   - 节点激活（点击/Enter）导航到现有任务详情/工作区视图（复用现有路由与 target-switch 语义）；依赖视图本身无任何编辑入口。
   - 刷新后视图与事实源一致；跨 project tuple 访问稳定 404。

## 实现决策

- 纯读模型：Mission & Work 模块公开查询 `getMissionDependencyInsight(projectId, missionId)`（名称实现时对齐现有 queries 风格），返回 nodes[]（id/title/status/blockedBy[]/blocking[]/blockedReason/inCycle）与 edges[]、cycles[]；不新增持久表、不改写既有命令。
- 依赖事实来源：实现前先勘察现有 work item/mission schema 是否已有依赖/阻塞字段；有则用之，无则在 spec 边界内用既有状态派生最小语义并把结论记录假设台账（不得为本片新增"任务依赖编辑"写能力——那属范围外）。
- UI：Mission 相关现有面板/详情内新增"依赖"只读区（或独立 tab，形态贴合现有组件）；列表化可访问呈现为先（节点列表+关系说明），不引入重型图形库；键盘可达；empty/loading/error/focus 全态。
- 循环检测：确定性算法（DFS/Tarjan 均可），输出稳定排序（按 task id 决胜），同输入同输出。
- 错误稳定脱敏；tuple 校验一致。

## 测试决策

- TDD 每轮一个公共缝 RED + 最小 GREEN；内存库夹具。
- **Query seam**：空依赖 empty、线性链、菱形、自环、多节点环、环与正常混合、阻塞原因派生、跨 tuple 404、排序确定性（同输入两遍同输出）。
- **UI seam（jsdom）**：节点/边呈现、循环标注、阻塞原因、empty/loading/error、节点导航触发、focus。
- **浏览器验收**：复用现有 smoke 套件中与 mission/work 相关者（若无则选最接近面板所在 smoke），desktop/narrow、light/dark、keyboard、axe。

## 范围外事项

- 依赖关系的创建/编辑/删除（写能力）、自动排期、关键路径计算、跨 Mission 依赖、图形化拖拽布局。
- 租约/派发（S-27）、SOP 状态（S-26）。

## 补充说明

- 单一用户结果（看懂并定位依赖阻塞），一个 Capability 内聚建立，预计 3 张票。
- 评审按项目级 review 豁免跳过；默认选择记入 product/assumptions.md。
