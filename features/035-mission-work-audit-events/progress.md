# 进度

- 特性: 035-mission-work-audit-events（对应切片: S-51 / S-23 的 AUD-MWK 纵切，CI-3.8 第三子片）
- 当前阶段: done（T-01/T-02/T-03 全部勾选，ship 收口完成；commit/push 与 backlog S-51 标注由主会话统一执行）
- 执行模式: auto（用户 2026-08-09 明示：不在电脑前，问题按助手推荐处理）
- 已加载扩展: 无
- 下一步: 等待下一切片准入
- 用户可感知: 是
- 评审状态: 项目级 review 豁免（AGENTS.md 2026-08-09 起生效）；不伪造评审工件；spec/architecture/tickets 由主会话按 backlog S-23 已确认拆分直接产出
- 共享理解: backlog S-23 source-owner 纵切拆分 auto-approved 2026-08-10；编号规则要求实现片分配新 S-* 号，本片登记为 S-51

## 实施记录

- 2026-08-12 特性开立：034/S-21 ship 后按 backlog 顺序与风险选定——跳过 tracking-only 的 S-23 别名本身与高风险安全切片（S-42/S-43），取审计纵切线下一棒 AUD-MWK；前置 028（基座）、030（纵切模板）、S-22/S-24/S-25 均已 ship；进入 implement。
- 2026-08-12 T-01 完成（任务域 outbox 原子写与 schema 放宽）：schema identity 20→21，`audit_event_outbox.source` CHECK 加 `'mission_work'`（projection 表 source 列无 CHECK，无需同步）；同波次迁移全部硬编码 identity 断言与 `unsupported-schema-input.ts` 夹具（A-237 纪律）。新增 `src/adapters/outbound/sqlite/mission-work/audit-event-outbox.ts`（028/030 同构）：选型清单与白名单集中，摘要经 grapheme 200 截断 + 既有 public-text 凭据分类缝（fail-closed 落 `[redacted]`）。接线点覆盖全部本域事实写入：tasks.ts 的 task_events 镜像（task_created/started/completed/failed，复用事件行 id）、mission 创建（mission_created）、work_items 创建/批量创建/状态流转/认领（work_item_created、work_item_status_changed from/to）、work-item-status-effects 三处完成/重开投影（actor=system）。write-ownership manifest `sharedAppendWriters.audit_event_outbox` 登记 mission-work 并加 035 注释。030 套件同波次迁移：outboxRows 按 source 过滤、seq 断言改严格递增（跨源共享 seq 空间，A-239）。验证：聚焦 97 文件/1122 测试全绿 + `tsc --noEmit` 零错误；默认选择落 A-238/A-239。
- 2026-08-12 T-02 完成（审计 UI 任务域呈现与定位）：audit-panel 单文件扩展——`MISSION_WORK_EVENT_TYPE_COPY` 集中文案映射兼作任务域分类器（DTO 零协议改动，未知类型兜底原文并保守归执行域）；域徽标取既有 `.status-label.status-completed`（030 已占 queued/running，不新增视觉语言）；任务域事件渲染 payload.title 公开摘录（030 同例，空/畸形不渲染）；来源定位走规范资源身份路由 `/projects/{id}/tasks/{workItemId}`（memory-source task 形态）/`missions/{missionId}`/`task-runs/{taskId}`（同源 catch-all 落 SourceReferencePage 诚实页，026 focusWorkItemId 为面板内部缝无 URL 入口故不伪造页内跳转），按 workItemId>missionId>taskId 逐个严格校验、全无效不渲染链接。RED→GREEN：新增 3 用例先红后绿，聚焦 14 文件/78 测试全过 + `tsc --noEmit` 零错误；默认选择落 A-240。
- 2026-08-12 T-03 完成（真实浏览器验收 + 全量 + ship 收口）：落点 `smoke:context`（026 段真实造数最丰富：mission×2、work_items×4、Plan 流转 + 依赖守卫拒绝）；task_runs 生命周期经公共 API 补造（create→start→execute 恒完成，task_failed 呈现留 jsdom）。验收：API 9 事件单页、caught_up、类型齐备、摘要逐字、被拒 Build 流转不入列、跨项目隔离 + foreign 404、禁词零泄漏；投影一致性 outbox==projection==API（按 project 作用域）+ checkpoint==maxSeq（全局）；桌面 End 键选 tab+焦点、逐行 status-completed 徽标、文案/摘录、三条定位 href、44px、焦点环、axe 明暗 0 blocking；窄屏抽屉同口径 + Escape 焦点回收；秘密扫描扩 facing text（fixture secrets）+ 截图字节（加扫宿主路径）；证据落 `features/035.../evidence/`（gitignored）。全量 `npx vitest run` 277/2527 ✅、`tsc --noEmit` ✅、`npm run build` ✅ 一次性通过；默认选择落 A-241。遗留：smoke 窄屏段「确认改绑工作区」曾现一次性超时 flake（第 1 轮，后续两轮通过，与本片无关，未大修）。
