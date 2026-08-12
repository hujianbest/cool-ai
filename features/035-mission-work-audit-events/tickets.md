# 任务票 — Mission & Work 审计事件纵切（AUD-MWK）

- 状态: 项目级 review 豁免生效，直接进入 implement
- 规模: 3 张纵向 RED/GREEN 票；单一「Mission/任务事件可查询可导航」用户结果
- 公共缝: Mission-Work Outbox Write、审计 UI 扩展
- TDD: 每票先一个公共行为 RED，再最小 GREEN；内存库夹具；consumer 协议零改动

- [x] T-01 任务域 outbox 原子写与 schema 放宽 — Blocked by: None
  - 公共缝: Mission-Work Outbox Write。
  - RED: source CHECK 拒绝 mission_work；任务域写入不产生 outbox。
  - GREEN: identity 20→21（source CHECK 加 'mission_work'，同波次迁移全部硬编码 identity 断言与 unsupported-schema 夹具）；勘察 mission-work 全部事实写入点（`task_events`、work_items 状态投影、missions 创建等）同事务追加 outbox（白名单集中 `mission-work/audit-event-outbox.ts`：type/actor/occurredAt/taskId/missionId/workItemId/公开摘要 grapheme 截断；选型清单常量集中：任务创建、状态流转、运行生命周期；噪声不入列）；write-ownership manifest 登记 sharedAppendWriters 放行 mission-work。
  - 验证: 原子性、白名单无敏感、摘要截断、选型外类型不入列、seq 单调、reopen 幂等。
  - 命令: 聚焦 tests/modules/mission-work/ + schema 套件 + tests/architecture；`npx tsc --noEmit`
  - 实施记录（2026-08-12）: 接线点=tasks.ts（createTask/appendState 镜像 task_events，复用事件行 id）、sqlite-mission-command-capability.ts（mission_created）、mission-service.ts（createWorkItemTx/createWorkItemBatchTx/transitionWorkItemTx/claimWorkItemTx）、work-item-status-effects.ts（mark*Tx 三处，actor=system）；选型=mission_created、task_created/started/completed/failed、work_item_created、work_item_status_changed（A-238）；030 套件同波次迁移为按 source 过滤 + 严格递增 seq 断言（A-239）。
  - 验证结果:
    - `npx vitest run tests/modules/mission-work tests/adapters/sqlite tests/architecture` ✅（29 文件/265 passed，2026-08-12 复跑确认）
    - `npx vitest run tests/modules/mission-work tests/modules/public-collaboration tests/modules/operations-projection tests/adapters/sqlite tests/architecture` ✅（97 文件/1122 passed）
    - `npx tsc --noEmit` ✅

- [x] T-02 审计 UI 任务域呈现与定位 — Blocked by: T-01
  - 公共缝: 审计列表 UI（jsdom）。
  - RED: 任务事件无文案/徽标/定位。
  - GREEN: audit-panel 扩展——域徽标（任务域复用既有 status 变体之一，勘察后定）、任务类型可读文案映射（未知兜底原文）、来源定位（任务/Mission 规范身份链接）、freshness 不变；empty/error 全态保持。
  - 验证: 混合三域渲染、文案映射、定位链接 href 断言、只读。
  - 命令: 聚焦 audit-panel 测试；`npx tsc --noEmit`
  - 实施记录（2026-08-12）: `MISSION_WORK_EVENT_TYPE_COPY` 集中映射兼作域分类器（DTO 零协议改动，未知类型兜底原文并保守归执行域）；域徽标=既有 `.status-label.status-completed`（030 已占 queued/running，A-240）；文案=使命已创建/任务已创建·已开始·已完成·已失败/看板任务已创建/看板任务状态已变更；摘要=任务域事件渲染 payload.title 摘录（030 同例 `.audit-event-excerpt`，空/畸形不渲染）；定位=规范资源身份路由——workItemId→`/projects/{id}/tasks/{workItemId}`（memory-source task 形态）、missionId→`missions/{id}`、taskId→`task-runs/{id}`（同源 catch-all 约定落 SourceReferencePage 诚实页），按 workItemId>missionId>taskId 优先级逐个严格校验、畸形跳过、全无效不渲染链接（A-240）；freshness/empty/error 全态与 030 协作定位零改动。
  - 验证结果:
    - RED 确认: 新增 3 用例先红（无文案/徽标/链接/摘录，2026-08-12）
    - `npx vitest run tests/browser/project-context` ✅（14 文件/78 passed，含新 3 用例，2026-08-12）
    - `npx tsc --noEmit` ✅

- [x] T-03 真实浏览器验收 + 全量 + ship — Blocked by: T-02
  - 公共缝: 真实任务造数 + 审计面板。
  - 验证: 真实造数（创建任务 + 状态流转）→ 审计呈现任务事件+域徽标 → 定位跳任务 → 投影一致性（outbox==projection==API）；desktop/narrow、light/dark、keyboard、focus、44px、axe 无 serious/critical；秘密扫描零泄漏；一次性全量 `npx vitest run` + `npx tsc --noEmit` + `npm run build`；progress/backlog/假设收口并 commit/push。
  - 命令: 勘察后选 smoke 落点（候选 smoke:context）；全量一次；`npm run build`
  - 实施记录（2026-08-12）: 落点 `tests/browser/context-browser-smoke.mjs`（026 段已造 mission×2/work_items×4/状态流转×1，真实度最高）；task_runs 生命周期经公共 API 最小补造（create→start→execute，deterministic executor 恒完成，task_failed 呈现留 jsdom 覆盖，A-241）。验收段结构=API 断言（单页 9 事件、caught_up、类型齐备、title 摘要逐字、被拒流转不入列、跨项目隔离+foreign 404、禁词标记零泄漏）→ DB 投影一致性（outbox==projection==API 按 project 作用域，checkpoint==maxSeq 全局，A-241）→ 桌面 UI（End 键选 tab+焦点、任务域徽标 status-completed 逐行、文案/摘录、三条定位 href、44px、焦点环、axe 明暗）→ 窄屏抽屉（呈现保持、定位 href、44px、axe、Escape 焦点回收）→ 秘密扫描（facing text 扫 fixture secrets、截图字节加扫宿主路径）→ 验收 JSON 落 `features/035-mission-work-audit-events/evidence/`。结果：99 assertions、axe 3 态 0 blocking、全 smoke 绿（第 3 轮；前两轮分别撞预存 flake「确认改绑工作区」超时与我方全局计数 bug，均已如实修正/复跑）。
  - 验证结果:
    - `npm run smoke:context` ✅（2026-08-12，含 MISSION-WORK AUDIT API/DESKTOP/NARROW/ACCEPTANCE 四段 PASS）
    - `npx vitest run` ✅（277 文件/2527 passed，一次性全量）
    - `npx tsc --noEmit` ✅
    - `npm run build` ✅（exit 0）
    - 工作树无意外工件（next-env.d.ts 脏痕迹已恢复基线，evidence 目录 gitignored）
