# 规格 — 可审计 SOP 与流程状态

- 特性: 043-sop-state-projection（S-26）
- 用户确认: auto-approved 2026-08-15
- 评审: spec/architecture/`hf-review` 豁免（AGENTS.md 选择性评审）；implement 后须 hf-code-review（verified-handle 读工作区文件）

## Problem Statement

Owner 无法在驾驶舱看到绑定仓库里真实流程文件的当前阶段、来源路径和是否与任务事实偏离。缺少这块时只能打开工作区文件或看板，两边容易各说各话。

## Solution

只读投影：用已交付的工作区浏览（verified-handle）发现 `features/*/progress.md`，解析声明阶段，并与同一项目 Mission 的 work item 事实对照。不新建任务状态机、不写 SOP、不执行流程命令、不改 schema。

## User Stories

1. As an owner, I want to see discovered SOP files with relative source path and declared stage, so that I know which real repo files drive process status.
2. As an owner, I want matching work item statuses shown beside each SOP file, so that status always comes from Mission facts.
3. As an owner, I want a stale hint when the file is unreadable or its declared stage diverges from matching work items, so that I do not trust a stale document.
4. As an owner, I want empty/unbound/error states that do not leak host paths or secrets.

## Implementation Decisions

- 发现范围仅 `features/<slug>/progress.md`（最多 20，路径排序）。`.github/workflows`、根 `SOP.md` 不在本片。
- 解析 `- 当前阶段:` 与 `- 特性:`；正文不回传 API。
- work item 匹配：标题包含 slug 或特性名（子串）。无匹配则只展示声明阶段，freshness=`current`（除非文件不可读）。
- 偏离：文件声明 `done` 但匹配项未全部 `done`；或声明非 `done` 且匹配项全部 `done`。
- 未绑定工作区：200 + `workspaceBound: false` + 空列表，不 404。
- 复用 `listWorkspaceDirectory` / `readWorkspaceFilePreview` + Windows verified-handle；越界 fail-closed。
- 敏感/非文本预览视为 `source_unreadable`。`readAt` 为本次读取时间。
- 不写 outbox。GET `/api/projects/:projectId/sop-state`。

## Testing Decisions

- 模块缝：`tests/modules/mission-work/` 真实临时工作区 + 内存库。
- UI 缝：jsdom mission board / SOP 面板。
- 浏览器：`smoke:context` 在既有 workspace 写入一条 progress.md，不加第二轮昂贵执行。

## Out of Scope

GitHub Actions 状态、SOP 编辑、第二任务状态机、时间轴、审计 outbox、多根工作区。
