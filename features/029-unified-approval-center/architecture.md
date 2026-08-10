# 架构 — 跨域统一审批中心

- 日期: 2026-08-10
- 对应规格: [`spec.md`](./spec.md)
- 状态: 项目级 review 豁免生效；未送独立评审，不伪造工件

## 架构目标

审批中心是 Governance 的跨域只读聚合 + 裁决分派：聚合查询留在 Governance 模块（JOIN 各域既有待决事实）；裁决零新写路径，UI 分派到各域既有裁决路由，原流程续接由各域保证。

## Module 与 Interface

- Governance 公开 Queries 新增 `listPendingApprovals(databasePath, projectId)` → `ApprovalCenterItemDto[]`：
  - 聚合源 1：`execution_approvals`（governance 自有表，直接读）：pending + 失效态（expired/replaced/revoked/rejected/consumed 按"是否在等 owner"过滤——pending 为主，失效项是否入列由演示判据"看清失效请求"决定：入列但 decisionHint=失效原因）。
  - 聚合源 2：内联决策 Proposal 待决（勘察 public-collaboration 现有 structured message / inline decision 查询缝；经其公开查询或只读 JOIN——若需跨模块读表，优先调对方公开查询缝，避免 governance 直读他域表；确需直读须在 imports/architecture 测试登记过渡边）。
  - 统一 DTO 落 `src/shared/`（UI 消费）；排序 createdAt DESC + approvalId 决胜；tuple 404。
- 裁决分派（UI 侧）：domain=execution → 既有执行审批路由（勘察 `app/api/projects/[projectId]/executions/` 下 approvals 路由）；domain=inline_decision → 既有 structured message resolve 路由（018 产物）。中心自身无 POST。
- 零 schema 变更；零新写路径；write-ownership 不变。

## 关键流程

1. owner 打开审批中心 → listPendingApprovals → 渲染两域待决/失效项。
2. 批准/拒绝 → 按 domain 调既有路由 → 成功后重取列表（项消失或转落定态）；失败显示脱敏错误。
3. 失效项 → 禁用裁决 + 原因 + 来源定位。

## Seam 与测试点

- Seam 1 — Pending Approval 聚合查询：tests/modules/governance/（新文件）。
- Seam 2 — 审批中心 UI：tests/browser/ 下对应面板（新文件）。
- Seam 3 — smoke 验收：复用执行审批造数的现有 smoke（smoke:execution 勘察）+ 内联决策造数（015/018 的 smoke:structured 勘察），择一主落点。

## 横切约定

- tokens/44px/键盘/focus；empty/loading/error 全态；错误脱敏；无第二状态机；裁决不绕审批。

## ADR 链接

- 遵守 ADR-0003；无新增难逆转决定。
