# Mission & Work 审计事件纵切（AUD-MWK）需求规格

- 日期: 2026-08-12
- 特性: 035-mission-work-audit-events
- 对应切片: S-23 的 AUD-MWK 纵切（CI-3.8 第三子片；按编号规则分配新实现片号 S-51）
- 模式: 建造
- 用户可感知: 是（审计中心扩展 Mission/任务事件）
- 执行模式: auto（用户不在场，问题按助手推荐处理并记录假设）
- 共享理解来源: `product/backlog.md` S-23 source-owner 纵切拆分（auto-approved 2026-08-10）；前置 `CAP-OPS-01/02`（028 AUD-MVP 已 ship）、`CAP-COL-07`（030 AUD-COL 已 ship，纵切模板）
- 公共行为接缝: Mission-Work Outbox Write（Mission & Work 原子写入）；审计列表 UI 扩展（Operations Projection 既有查询复用）
- 主子系统: Operations Projection（复用）；source owner: Mission & Work；主 Capability: `CAP-MWK-05`（本片建立：owner 可查询脱敏 Mission/任务事件并精确导航）

## 问题陈述

审计中心已覆盖 Safe Execution（028）与 Public Collaboration（030）事件；Mission/任务域——任务创建、状态流转、运行开始/结束、阻塞与完成——仍不可见，也无法从审计项跳回任务来源。

## 解决方案

复用 028 投影基座做第三个 source-owner 纵切，沿用 030 模板：Mission & Work 在写本域事实（`task_events` 及勘察确认的其他写入点）的同一事务内原子追加 outbox 行（source='mission_work'，payload 白名单）；consumer 零改动（source 无关）；审计中心 UI 扩展呈现 Mission/任务事件（类型可读文案、域徽标、任务/ Mission 来源定位）。schema identity 20→21 放宽 outbox source CHECK。

## 用户故事

1. **作为 owner，我想在审计中心看到 Mission/任务事件，从而理解任务域发生了什么。**
   - 审计列表同时呈现执行、协作与任务事件，域徽标区分；任务事件含类型可读文案（任务创建、状态流转、运行生命周期等既有事件词汇）。
   - payload 只含公开脱敏字段（任务标题、状态文案是公开内容，允许列入截断摘要；凭据/隐藏推理/原始 provider 响应绝不可见）。
2. **作为 owner，我想从审计项精确跳回任务来源，从而快速定位上下文。**
   - 任务事件定位到项目内任务/Mission 视图（复用既有规范目标身份路由）；定位失败如实提示不伪造跳转。
   - 跨项目 tuple 隔离不变；重启/重建后投影与源一致（基座既有保证，本片加任务事件的一致性断言）。

## 实现决策

- schema identity 20→21：`audit_event_outbox.source` CHECK 放宽加入 `'mission_work'`；同步全部引用（含 reopen 测试、unsupported-schema 夹具、ownership manifest 的 `sharedAppendWriters` 注释）；projection 表 source 列如有 CHECK 同步放宽（勘察后一致处理，与 030 先例一致）。
- Mission & Work 原子写：勘察 `task_events`、`work_items`、`missions` 的全部写入点（write owner: mission-work），同事务追加 outbox；payload 白名单集中一处（新文件 `mission-work/audit-event-outbox.ts`，028/030 同构模式）：type、actor、occurredAt、taskId/missionId/workItemId 引用、公开摘要（任务标题/状态文案 grapheme 截断 + 经既有 public-text 校验缝）。
- 事件选型（MVP 最薄）：覆盖任务创建、任务状态流转（task_events 的 status/message 流）、运行开始/结束等可观察事实；内部噪声（心跳、轮询、投影内部标记）不入 outbox——勘察后把选型清单记录到假设台账。
- Query/consumer 零改动（source 无关）；UI：审计面板域徽标 + 任务域文案映射 + 定位链接（任务规范身份路由，勘察 026 依赖全景/任务区的既有路由形态）。
- 不变量：复用既有 projection⊆outbox 等；无需新增。
- 同一 schema 迁移波次必须同步更新所有硬编码 identity 断言与 write-ownership manifest（A-237 教训）。

## 测试决策

- TDD 每轮一个公共缝 RED + 最小 GREEN；内存库夹具。
- **Outbox 写缝**：任务域事实写入 → outbox 同事务镜像；白名单无敏感；摘要截断；选型外类型不入列；seq 单调；reopen 幂等。
- **查询缝**：混合三域排序/分页/项目隔离（基座已有，本片加任务投影内容断言）。
- **UI 缝**：任务域文案映射、域徽标、任务定位链接 href、empty/loading/error 全态。
- **浏览器验收**：落点勘察后择定（候选 smoke:context——Mission/任务真实造数现成）——真实造数（创建任务 + 触发状态流转）→ 审计呈现任务事件+域徽标 → 定位跳任务 → 投影一致性（outbox==projection==API）；desktop/narrow、light/dark、keyboard、focus、44px、axe 无 serious/critical；秘密扫描零泄漏；一次性全量 + build。

## 范围外事项

- 其他 source owner 纵切（AUD-PWS、AUD-GOV、AUD-RUN 各自另起切片）；统一审计浏览器组合视图（S-23 汇总 AUD-UI）。
- 任务事件的全量历史回放；任务租约控制面（S-27）。

## 补充说明

- 单一用户结果（Mission/任务事件可查询可导航）；3 张票；基座与 030 模板已交付使本片保持最小。
- 评审按项目级 review 豁免跳过；默认选择记入 product/assumptions.md。
