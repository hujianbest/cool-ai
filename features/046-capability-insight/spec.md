# 规格 — 可解释 Agent 能力画像与路由建议

- 特性: 046-capability-insight（S-33）
- 用户确认: auto-approved 2026-08-15
- 评审: spec/architecture 豁免；轻量级零 schema，implement 后 hf-code-review 豁免

## Problem

Owner 只能在设置里看 Agent 配置，无法在项目上下文看到可解释的能力画像，也不能根据任务得到只读路由建议。推断若静默改角色/权限会破坏平等配置。

## Solution

只读投影：项目成员的能力画像（技能、工具权限、可否复核、模型名）带证据标签；对未指派 todo 任务给出最多 3 条路由建议与理由。接受只预填已有负责人控件；忽略只藏会话内 UI。绝不写 Agent/Skill/权限。

## User Stories

1. As owner, I want a capability portrait per project member so I understand declared skills and tools without opening settings.
2. As owner, I want routing suggestions with reasons for unassigned todo work items so I can pick an assignee faster.
3. As owner, I want accept/ignore to never change Agent roles or permissions so inference cannot rewrite configuration.

## Decisions

- 零 schema。画像只来自 Identity 已有 Agent/Skill/权限事实（A-321）。不用用量/复核结果计数（留给 S-37）。
- HTTP GET `/api/projects/:projectId/capability-insight` 只读。入站路由分别调用 membership / agent / mission 查询，再调用 Identity 纯函数 `buildCapabilityInsight`。Identity sqlite Adapter **不得** SELECT `work_items`（A-323）。
- 画像不含凭据、systemPrompt 全文、宿主路径。可含 model 名、skill 名、工具布尔、reviewCapable。
- 打分确定性（A-325）：技能名与 title/description ASCII 折叠子串 +3；复核能力且任务含 复核|review|检查 +2；writeFiles 且含 写入|文件|file|edit +2；runCommands 且含 命令|测试|command|test +2；role 子串 +1。score≤0 不建议。同 score 用 agentId ASC。每任务最多 3 条。仅未指派且 status=todo 的项目内任务。
- 接受：预填该卡片已有负责人 select，不调用 Agent 写命令、不自动保存任务（A-324）。忽略：会话 state 隐藏该建议。
- UI：使命看板 region「能力画像」+ 未指派 todo 卡上「路由建议」。
- 浏览器：`smoke:context` 已有 Planner/Builder 与 Plan task（A-326）。不为洞察新开 Agent 执行。

## Testing

- 缝：`buildCapabilityInsight` 纯函数 + GET + mission-board jsdom + smoke:context。
- 断言：建议不出现密钥；跨项目 404；接受后 Agent 列表权限不变。

## Out of Scope

自动改写 Agent、权限变化审批、S-34 规则注入检查、S-37 贡献统计、跨项目路由。
