# Cool AI 架构地图

- 日期: 2026-08-08
- 来源: 由当前代码、产品定义与已交付切片反推
- 用户确认: auto-approved 2026-08-06

## 系统形态

- 本地优先的 Next.js/React/TypeScript 单仓 Web 应用；App Router 同时承载页面与 JSON API，SQLite 保存业务状态，Windows verified-handle 适配器守护真实工作区操作。

## 模块边界

- Web 外壳与设计系统（`app/layout.tsx`、`app/tokens.css`、`app/cockpit.css`）：三栏协作驾驶舱、响应式布局、共享 light/dark token 与首绘前主题恢复。
- 用户界面（`components/`）：项目、团队配置、渐进式首次引导、协作、使命看板、安全执行、同伴复核与交付视图。
- HTTP 边界（`app/api/`）：把用户操作映射为严格校验、可重试的项目/Agent/运行/执行/复核 API。
- 领域与编排（`src/`）：项目上下文、Agent 协作、任务 DAG、执行生命周期、复核与交付规则。
- 持久化（`src/` 内数据库与迁移模块、`.data/` 运行数据）：SQLite schema、不可变版本链、事务与重放恢复。
- 安全执行（`src/` 内 execution/sandbox/merge 模块）：隔离工作区、受控工具、审批、验证、冲突检测与可恢复合入。
- 验证（`tests/`）：Vitest 单元/集成/组件测试与 Playwright 浏览器 smoke。

## 核心数据模型

- Provider、Skill、AgentTemplate 与 Agent 组成可复用团队资源；Agent 身份与模型绑定分离。
- Project 绑定一个规范工作区并拥有 Members、Mission、WorkItems、Memories 与 ValidationPolicy。
- CollaborationRun 由公开 TimelineEvents、Turns、Decisions、Usage 和显式 handoff 串成可恢复接力。
- Execution/Attempt/Action 在隔离 sandbox 产出 Validation、StagedChange、Approval、Artifact 与 MergeJournal。
- Result 经非执行者 ReviewAttempt 裁决后形成版本链，并把带精确来源的记忆与 Delivery 留在项目中。

## 关键流程

- 配置团队：页面 → providers/skills/agents API → 校验与密钥边界 → SQLite → 团队资源视图。
- 首次引导：URL 状态机 → 既有 Provider/Agent/Project/Workspace/Members 事实检测与原表面配置 → Mission+CollaborationRun 目标受理；本地偏好只保存非敏感控制事件，未知写入只 GET 对账。
- 协作交付：owner 目标 → 项目上下文与使命看板 → 多 Agent 接力/并行执行 → 审批与验证 → 独立复核 → 记忆和最终交付。
- 安全合入：任务快照 → 隔离 sandbox 工具动作 → stale/冲突检查 → staged preview/审批 → merge journal → canonical workspace。

## 横切约定

- 所有外部输入在 API 边界严格校验；凭据、隐藏思维链和原始 provider 响应不得进入 UI、日志或持久化。
- 写操作使用 operation/version/lease 等确定性约束；失败关闭，重试不得补写旧动作或伪造成功。
- UI 复用 `tokens.css`，保持 Cool 自有暖色 light/dark 层级、Agent 身份色、44px 控件、可见焦点与 loading/empty/error 三态；主题偏好仅保存非敏感枚举/修订并在首次绘制前恢复。
- 新行为按 `tests/` 中对应领域测试先红后绿；全量 `npm test`、`npm run build` 与浏览器 smoke 作为交付证据。
