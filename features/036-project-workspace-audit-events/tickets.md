# 任务票 — Project & Workspace 审计事件纵切（AUD-PWS）

- 状态: 项目级 review 豁免生效，直接进入 implement
- 规模: 3 张纵向 RED/GREEN 票；单一「项目/工作区事件可查询可导航」用户结果
- 公共缝: Project-Workspace Outbox Write、审计 UI 扩展
- TDD: 每票先一个公共行为 RED，再最小 GREEN；内存库夹具；consumer 协议零改动

- [x] T-01 项目域 outbox 原子写与 schema 放宽 — Blocked by: None
  - 公共缝: Project-Workspace Outbox Write。
  - RED: source CHECK 拒绝 project_workspace；项目域写入不产生 outbox。
  - GREEN: identity 21→22（source CHECK 加 'project_workspace'，同波次迁移全部硬编码 identity 断言与 unsupported-schema 夹具）；勘察 project-workspace 全部事实写入点（projects 创建、workspace 绑定/改绑、memberships 变更、validation policy 修订）同事务追加 outbox（白名单集中 `project-workspace/audit-event-outbox.ts`；宿主路径只许脱敏形式；选型清单常量集中）；write-ownership manifest 登记 sharedAppendWriters 放行 project-workspace。
  - 验证: 原子性、白名单无敏感、路径脱敏、摘要截断、选型外类型不入列、seq 单调、reopen 幂等。
  - 命令: 聚焦 tests/modules/project-workspace/（或勘察后新套件路径）+ schema 套件 + tests/architecture；`npx tsc --noEmit`
  - 验证记录 2026-08-12: 新套件 `tests/modules/project-workspace/project-audit-outbox.test.ts`（10 例：schema/project_created/workspace 绑定+路径脱敏/成员增删/策略镜像/截断/凭据拒入/选型外噪声/reopen 幂等/拒绝原子性）；聚焦 `tests/modules/project-workspace + tests/adapters/sqlite + tests/architecture + mission-audit-outbox` 31 文件 284 测试通过；identity 波次 16 文件（含 035 套件 source 过滤适配）；operations-projection/safe-execution 消费方 24 文件 327 测试通过；`npx tsc --noEmit` 零错误。

- [x] T-02 审计 UI 项目域呈现与定位 — Blocked by: T-01
  - 公共缝: 审计列表 UI（jsdom）。
  - RED: 项目事件无文案/徽标/定位。
  - GREEN: audit-panel 扩展——域徽标（复用既有 status 变体，勘察 030/035 占用后定）、项目类型可读文案映射（未知兜底原文）、来源定位（项目规范身份链接）、freshness 不变；empty/error 全态保持。
  - 验证: 混合四域渲染、文案映射、定位链接 href 断言、只读。
  - 命令: 聚焦 audit-panel 测试；`npx tsc --noEmit`
  - 验证记录 2026-08-12: `PROJECT_WORKSPACE_EVENT_TYPE_COPY`（6 键兼作域分类器，与既有三域零冲突，未知兜底原文）；域徽标=裸 `.status-label` 中性基类（030=queued/execution=running/035=completed 已占，failed 为 danger 语义弃用；裸基类有 review/thread-policy 先例）；定位=`/projects/{projectId}` 规范身份（项目子面板无 URL 入口，018 先例），锚定面板 prop 非空校验、畸形不渲染；摘要按白名单键呈现（projectName/workspaceName/previous → new/agentDisplayName/修订 #N · M 项），畸形字段不渲染。聚焦 `tests/browser/project-context` 14 文件 82 测试通过（新套件 4 例 RED→GREEN）；`npx tsc --noEmit` 零错误。

- [x] T-03 真实浏览器验收 + 全量 + ship — Blocked by: T-02
  - 公共缝: 真实项目造数 + 审计面板。
  - 验证: 真实造数（创建项目/绑定工作区/成员或策略变更）→ 审计呈现项目事件+域徽标 → 定位跳项目 → 投影一致性（outbox==projection==API，project 作用域口径）；desktop/narrow、light/dark、keyboard、focus、44px、axe 无 serious/critical；秘密扫描（含宿主路径）零泄漏；一次性全量 `npx vitest run` + `npx tsc --noEmit` + `npm run build`；progress/backlog/假设收口。
  - 命令: 勘察后选 smoke 落点（候选 smoke:onboarding / smoke:settings）；全量一次；`npm run build`
  - 结果: 落点择定 smoke:context（复用 035 段同文件，审计 trail 改为四域混合并同步既有段断言）；验收段覆盖 API（8 项目域事件单页、六类型齐备、脱敏 basename/成员名、outbox==projection==API、foreign 404、跨项目隔离）+ 桌面明暗 UI（End 键选 tab、中性徽标/文案/摘要、定位 href、44px、焦点环）+ 窄屏抽屉 + axe 3 态 0 serious/critical + 秘密扫描（facing text + 截图字节含宿主路径）零泄漏——`PROJECT-WORKSPACE AUDIT ACCEPTANCE PASS: assertions=104 axeStates=3`；实现 subagent 在写完验收段后 resource_exhausted，主会话接管完成验证（syntax/tsc/smoke/全量/build 全绿）并收口；`npx vitest run` 277 文件 2542 用例全绿 118.4s、`npx tsc --noEmit` 绿、`npm run build` 绿。默认选择见 A-255。
