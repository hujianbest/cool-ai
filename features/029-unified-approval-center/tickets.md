# 任务票 — 跨域统一审批中心

- 状态: 项目级 review 豁免生效，直接进入 implement
- 规模: 4 张纵向 RED/GREEN 票；单一"单一入口看待决并裁决"用户结果
- 公共缝: Pending Approval 跨域查询、裁决分派（复用域路由）、审批中心 UI
- TDD: 每票先一个公共行为 RED，再最小 GREEN；内存库夹具；零 schema 变更、零新写路由

- [x] T-01 跨域待决聚合查询 — Blocked by: None
  - 公共缝: Pending Approval Query。
  - RED: 查询不存在；聚合/失效映射未定义。
  - GREEN: `listPendingApprovals(databasePath, projectId)`：聚合 execution_approvals（pending+失效态）与内联决策 Proposal 待决（优先调 public-collaboration 公开查询缝；确需直读则登记过渡边）；统一 DTO（domain/kind/摘要/sourceRef/status/decisionHint）；createdAt DESC + id 决胜；tuple 404；摘要零敏感字段。
  - 验证: 两域聚合、排序决胜、失效态映射矩阵（expired/replaced/revoked/consumed/版本冲突）、tuple 隔离、空态。
  - 命令: 聚焦 tests/modules/governance/；`npx tsc --noEmit`

- [x] T-02 审批中心 UI 列表与裁决分派 — Blocked by: T-01
  - 公共缝: 审批中心 UI（jsdom）。
  - RED: 无审批区；裁决不分派；失效未禁用。
  - GREEN: 项目面板"审批"区：列表（域徽标、摘要、来源定位、状态/失效原因）、批准/拒绝按钮按 domain 分派既有路由（勘察确认现有执行审批与内联决策裁决路由路径）、成功后重取、失败脱敏错误+刷新、失效项禁用+原因；empty/loading/error/focus 全态；tokens/44px/键盘。
  - 验证: 呈现、分派（mock 两域路由断言请求）、失效禁用、错误路径、只读来源导航。
  - 命令: 聚焦对应 UI 测试；`npx tsc --noEmit`

- [x] T-03 原流程续接端到端验证 — Blocked by: T-02
  - 公共缝: 既有域裁决路由（真实调用链）。
  - 验证: 模块/集成层断言裁决后原流程续接——执行审批批准后执行状态推进（复用现有执行测试断言方式）、内联决策 resolve 后消息块落定（018 语义）；过期请求裁决失败关闭；中心列表同步反映。
  - 命令: 聚焦 governance + safe-execution/structured 相关套件；`npx tsc --noEmit`

- [x] T-04 真实浏览器验收 — Blocked by: T-03
  - 公共缝: 真实审批中心 + 两域造数。
  - 验证: 一次执行审批 + 一次内联决策真实造数 → 中心呈现 → 批准/拒绝 → 原流程续接断言 → 过期/失效呈现禁用；desktop/narrow、light/dark、keyboard、focus、44px、axe 无 serious/critical；秘密扫描无泄漏；一次性全量 `npx vitest run` + `npx tsc --noEmit` + `npm run build`。
  - 命令: smoke:execution/structured 勘察后择主落点；全量一次；`npm run build`
