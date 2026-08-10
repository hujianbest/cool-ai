# 跨域统一审批中心需求规格

- 日期: 2026-08-10
- 特性: 029-unified-approval-center
- 对应切片: S-24（CI-4.3）
- 模式: 建造
- 用户可感知: 是
- 执行模式: auto（用户不在场，问题按助手推荐处理并记录假设）
- 共享理解来源: `product/backlog.md` S-24 条目（auto-approved 2026-08-10）；前置 `CAP-EXE-01`、`CAP-COL-01` 已交付，`CAP-OPS-01/02`（AUD-MVP 2026-08-10 ship）已交付，`CAP-COL-03`（S-13 已 ship）高风险卡片来源已验证
- 公共行为接缝: Pending Approval 跨域查询（Governance）；Approval 裁决分派（复用各领域既有裁决路由）；审批中心 UI
- 主子系统: Governance；主 Capability: `CAP-GOV-02`（本片建立其跨域 Approval 查询、裁决与来源 Workflow 续接）

## 问题陈述

高风险请求分散在各域界面里：执行审批在运行详情、内联决策在消息流里；owner 没有单一入口回答"现在有什么在等我拍板"，容易漏批，也看不清每个请求的来源、影响与是否已失效。

## 解决方案

建立跨域统一审批中心：项目级单一入口聚合所有待决请求（本片两域：Safe Execution 的 command/staged_merge 审批 + Public Collaboration 的内联决策 Proposal），每项显示来源（域/线程/执行）、影响摘要（公开脱敏字段）与失效状态（pending/已被取代/已过期/版本冲突）；批准/拒绝经既有各领域裁决路由执行（审批中心不建旁路写路径），原流程准确续接；失效请求拒绝裁决并如实显示。裁决事实可追溯（既有 audit/outbox 已覆盖执行域）。

## 用户故事

1. **作为 owner，我想在单一入口看到全部待决请求，从而不漏批。**
   - 列表按创建时间倒序（稳定决胜），每项含域徽标、标题/影响摘要、来源定位、当前状态；空态明确。
   - 只含当前项目 tuple；跨项目绝不泄漏；请求内容经既有公开脱敏字段呈现。
2. **作为 owner，我想直接在中心批准/拒绝，从而原流程准确续接。**
   - 裁决调用既有域路由（执行审批 approve/reject、内联决策 resolve）；成功后项从待决消失，原流程（执行续跑/消息块落定）按既有语义推进。
   - 裁决失败（冲突/过期/并发）显示脱敏错误并可刷新；不得出现"裁决成功但流程未续接"。
3. **作为 owner，我想看清失效请求，从而不对死请求做决定。**
   - 已过期/已被取代/版本冲突的请求以失效态呈现且禁止裁决动作（disabled + 原因）；过期请求在域内失败关闭（既有语义），中心如实反映。
   - 失效项可定位来源查看上下文；列表刷新与事实源一致。

## 实现决策

- Governance 模块新增公开只读查询 `listPendingApprovals(projectId)`（命名对齐现有风格）：聚合 execution_approvals（pending 及失效态）+ 内联决策 Proposal 待决项（勘察 structured message/inline decision 现有查询缝复用）；统一 DTO `ApprovalCenterItemDto`（approvalId、domain: "execution"|"inline_decision"、kind、title/impact 摘要（公开字段）、sourceRef（thread/execution/message 定位信息）、status、createdAt、decisionHint（可裁决/失效原因））。
- 裁决：不建新写路由；UI 按 domain 分派到既有路由（执行：`.../executions/.../approvals/...` 现有 approve/reject 路由；内联决策：structured message 现有 resolve 路由——勘察后确认路径）。审批中心只读聚合 + 分派。
- 失效状态：执行审批用既有 status（pending/expired/replaced/revoked 等）；内联决策用 018 的 VERSION_CONFLICT/stale 语义；中心如实映射，不新造状态。
- UI：项目面板新增"审批"区/tab；列表 + 项内批准/拒绝按钮（强确认沿用各域既有确认形态——执行域若已有确认模式则复用）；freshness 不要求（审批是事实直读，非投影）。
- 错误稳定脱敏；tuple 校验一致。

## 测试决策

- TDD 每轮一个公共缝 RED + 最小 GREEN；内存库夹具。
- **Query seam**：两域聚合、排序与决胜、失效态映射、tuple 隔离、空态、摘要不含敏感字段。
- **UI seam（jsdom）**：列表呈现、域徽标、批准/拒绝分派（mock 既有路由）、失效禁用、错误与刷新、只读来源导航。
- **浏览器验收**：真实造数（一次执行审批 + 一次内联决策）→ 中心呈现 → 分别批准/拒绝 → 原流程续接断言（执行续跑、消息块落定）→ 过期请求失败关闭呈现；desktop/narrow、light/dark、keyboard、axe。

## 范围外事项

- 其他域新审批类型（交棒专门审批、MCP/插件/导出审批——后续切片各自接入本中心）；批量裁决；审批委托/策略自动化；通知（S-41）。
- 统一审计浏览器组合视图（S-23 汇总片）。

## 补充说明

- 单一用户结果（单一入口看待决并裁决）；4 张票；写路径零新增（复用域路由）是本片关键边界。
- 评审按项目级 review 豁免跳过；默认选择记入 product/assumptions.md。
