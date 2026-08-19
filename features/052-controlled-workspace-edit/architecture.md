# 架构 — 受控工作区编辑与 Git 合入

- 日期: 2026-08-18
- 对应规格: [`spec.md`](./spec.md)
- 状态: 项目级 review 豁免生效；未送独立评审，不伪造工件
- 高风险：跨 owner 写路径；实现后必须 hf-code-review（安全/跨 owner 写）

## 架构目标

Owner 对已绑定工作区的**单文件**编辑与合入，走与 Agent 执行相同的受控写模型：verified-handle → 草稿隔离 → 显式 diff → stage → 既有审批 → MergeJournal 合入。复杂性（路径安全、mtime 冲突、journal、Git 探测）留在 Adapter；模块只暴露会话命令/查询；UI 只消费 DTO。

不复用 `executions` 行伪造 owner 编辑（该表强制 collaboration thread / mission / agent）。合入复用 `execution_merge_*` 的**算法与文件备份模式**，但会话主键独立。

## Module 与 Interface

Owner：**Project & Workspace**（会话生命周期、草稿、diff、abandon）。
合入执行：**Safe Execution** 出站 Adapter 抽出的 MergeJournal 服务（现 `merge-journal-service.ts`），经 Workspace 命令调用，不经 chat/execution 路由。

公开命令/查询（`src/modules/project-workspace`）：

- `createWorkspaceEdit(databasePath, projectId, { relativePath, operationId })`
- `getWorkspaceEdit(databasePath, projectId, sessionId)`
- `putWorkspaceEditDraft(databasePath, projectId, sessionId, { expectedVersion, content, operationId })`
- `getWorkspaceEditDiff(databasePath, projectId, sessionId)`
- `stageWorkspaceEdit(databasePath, projectId, sessionId, { expectedVersion, operationId })`
- `requestWorkspaceEditMerge(databasePath, projectId, sessionId, { expectedVersion, operationId })` — 创建/复用审批项
- `abandonWorkspaceEdit(databasePath, projectId, sessionId, { expectedVersion, operationId })`

入站：`app/api/projects/[projectId]/workspace/edits/**` 只做 DTO 校验与脱敏 envelope。

## 数据

`CURRENT_SCHEMA` 新增（空库 bootstrap；非空 drift fail-closed）：

- `workspace_edit_sessions`：id, project_id, relative_path, path_key, status (`editing|ready_to_stage|stale|conflicted|staged|awaiting_approval|merging|merged|abandoned`), expected_mtime, baseline_hash, draft_locator_json, version, latest_operation_id, created_at, updated_at
- 部分唯一：同一 `project_id` 至多一条活跃会话（status ∉ `merged|abandoned`）
- 公开 status 用规格词（`editing` / `ready_to_stage`），不用内部 `draft`（A-389）
- 草稿字节落在既有 sandbox / journal 根下，不写工作区；DTO 不回传绝对路径
- 合入行：复用 `execution_merge_journals` **或** 平行表 `workspace_edit_merge_journals`（实现时选其一；若复用必须增加可空 `workspace_edit_session_id` 且放宽 `execution_id` 非空——优先平行表，避免污染 execution 不变量）

**ADR（本特性）**：平行 merge journal 表，不放宽 `executions` / `execution_merge_journals` 的 execution 外键。算法代码与 CAP-EXE-01 共享函数，表分开。

## 关键流程

1. 预览「编辑」→ POST edits（文件须存在、非敏感、文本可编辑）→ 读 verified 基线 + mtime/hash → draft 会话。
2. PUT draft → 版本冲突则 409；写隔离草稿。
3. GET diff → 工作区副本 vs 草稿；工作区 mtime/hash 变则 `conflicted`，禁止 stage。
4. POST stage → 生成 staged 产物（单 path）；Git 探测记入 DTO，不跑 Git 命令。
5. POST merge → 走既有审批中心（无自动放行）；批准后 MergeJournal 应用到 verified 根。
6. POST abandon → 丢草稿；不改工作区。进行中 journal 走与执行相同的 recovery 语义。

## Seam 与测试点

- Seam 1 — 会话/草稿/diff/abandon：`tests/modules/project-workspace/`，临时目录真实文件。
- Seam 2 — stage/merge/审批挂钩：`tests/adapters/` 或 modules 集成；复用 memory-database。
- Seam 3 — 预览「编辑」UI：`tests/browser/` + 真实浏览器核对。
- Seam 4 — 路由校验：非法 path、越界、敏感、二进制、无绑定。

## 横切

- 无自由 Git CLI；无宿主绝对路径；失败关闭；operation/version；tokens 与 UCD 文案。
- 实现后 hf-code-review：路径逃逸、草稿泄漏、journal 双写、审批绕过。
