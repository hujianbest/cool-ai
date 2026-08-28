# 规格 — 可审计系统规则与提示注入检查

- 切片: 064 / S-34
- 主用户结果: Owner 能查看项目内 Agent/Skill 提示的生效范围、冲突与注入风险预览；越权覆盖安全边界的指令被明确拒绝原因标出，且检查结果不含凭据或提示全文。
- 主 Capability: `CAP-IDC-03`
- 用户确认: auto-approved 2026-08-27
- 评审: spec/architecture 按 A-286 豁免
- 来源: `product/backlog.md` S-34、`product/architecture.md` Identity、A-445～A-452

## Problem Statement

S-33 只展示技能名与工具布尔，不检查 system prompt / 技能说明是否试图绕过复核、扩权或诱使泄漏凭据。Owner 无法在团队页看到规则生效范围、冲突和注入风险；若把全文提示画到界面上，又会破坏脱敏。

## Solution

Identity 只读投影：对当前项目成员的 Agent `system_prompt` 与已绑定 Skill `instructions` 做确定性启发式检查。返回每条来源的作用域、冲突组、注入/越权发现项（稳定 code + 脱敏摘录 + 拒绝原因）。不写 Agent/Skill，不落规则表，不读工作区文件。

## User Stories

1. As Owner, I want to see which Agent/Skill texts are in scope for this project, so I know what rules actually apply.
2. As Owner, I want conflicts called out when two sources give incompatible instructions, so I can fix configuration rather than guess.
3. As Owner, I want injection and safety-boundary hits with clear reject reasons, so prompts cannot silently override review, tools, or secrets.
4. As Owner, I want the UI and API to never show full prompts or credentials, so inspection stays redacted.

## Implementation Decisions

- 零 schema。输入来自既有 Identity Agent/Skill 与项目 membership（A-446/A-447）。
- 深模块缝：`buildRuleInsight`（纯函数，Identity 公开）。入站 GET 组装成员 + agents + skills 后调用；Identity sqlite **不得**为了本片去 SELECT 工作区或 Mission 表。
- HTTP：`GET /api/projects/:projectId/rule-insight`；严格查询（无额外键）、`no-store`、未知项目 404。
- 冻结安全边界（A-449）命中 `severity=block`：绕过独立复核；要求未配置的 `can_write`/`can_execute`；索取或回显凭据。
- 注入启发式（A-450）`severity=warn|block`：忽略先前指令、角色劫持、隐藏覆盖（如 “ignore previous / you are now / hidden system” 的折叠匹配）。
- 冲突：同一 Agent 的 prompt 与其 Skill instructions 对同一边界给出相反要求时成组（例如一个要求写文件、配置却 `can_write=0`）。
- DTO 不含 `systemPrompt`/`instructions` 全文、密钥、宿主路径。摘录 ≤ 80 字且打码。
- UI：`/team` region「规则与注入检查」（A-451）；全态 loading/empty/error；block 用 `role=alert`。
- 审计：本片不写 outbox（只读投影，同 S-33/S-41 只读洞察）。

## UI 设计

- 挂载：`/team`，健康/用量/贡献附近的独立 region，不新增图标轨。
- 列表：按 Agent 分组；每条发现项显示 code、severity、拒绝原因、脱敏摘录、来源（Agent 或 Skill 名）。
- empty：「未发现规则冲突或注入风险。」
- 无 CTA 去编辑 prompt（编辑仍走既有 Agent 设置）。提供「重新检查」刷新。

## Testing Decisions

- 缝：`buildRuleInsight` + GET + team jsdom。
- 好测试：block 越权写文件；warn 忽略先前指令；DTO 无全文 prompt；跨项目 404。
- 范例：`tests/modules/identity-capability/rule-insight*.ts`、`tests/browser/team-settings/`。

## Out of Scope

- 可写项目/全局规则、规则文件 verified-handle 读取、模型分类器、S-45 族、自动改写 Agent。

## Further Notes

- 用户确认: auto-approved 2026-08-27
