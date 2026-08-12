# Project & Workspace 审计事件纵切（AUD-PWS）需求规格

- 日期: 2026-08-12
- 特性: 036-project-workspace-audit-events
- 对应切片: S-23 的 AUD-PWS 纵切（CI-3.8 第四子片；按编号规则分配新实现片号 S-52）
- 模式: 建造
- 用户可感知: 是（审计中心扩展项目/工作区事件）
- 执行模式: auto（用户不在场，问题按助手推荐处理并记录假设）
- 共享理解来源: `product/backlog.md` S-23 source-owner 纵切拆分（auto-approved 2026-08-10）；前置 `CAP-OPS-01/02`（028 已 ship）、纵切模板 030/035 已 ship
- 公共行为接缝: Project-Workspace Outbox Write（Project & Workspace 原子写入）；审计列表 UI 扩展（Operations Projection 既有查询复用）
- 主子系统: Operations Projection（复用）；source owner: Project & Workspace；主 Capability: `CAP-PWS-03`（本片建立：owner 可查询脱敏项目/工作区事件并精确导航）

## 问题陈述

审计中心已覆盖 Safe Execution（028）、Public Collaboration（030）与 Mission & Work（035）事件；项目/工作区域——项目创建、工作区绑定与改绑、成员变更、验证策略变更——仍不可见，owner 无法回答"这个项目/绑定什么时候、被谁改过"。

## 解决方案

复用 028 投影基座做第四个 source-owner 纵切，沿用 030/035 模板：Project & Workspace 在写本域事实（`projects`、`project_memberships`、工作区绑定、`project_validation_policy_*` 等写入点）的同一事务内原子追加 outbox 行（source='project_workspace'，payload 白名单）；consumer 零改动；审计中心 UI 扩展呈现项目/工作区事件（类型可读文案、域徽标、项目来源定位）。schema identity 21→22 放宽 outbox source CHECK。

## 用户故事

1. **作为 owner，我想在审计中心看到项目/工作区事件，从而理解项目配置与工作区绑定发生了什么。**
   - 审计列表同时呈现执行、协作、任务与项目事件，域徽标区分；项目事件含类型可读文案（项目创建、工作区绑定/改绑、成员加入/移除、验证策略变更等既有事件词汇）。
   - payload 只含公开脱敏字段（项目名称、成员显示名等公开内容允许列入截断摘要；宿主绝对路径必须脱敏为占位/相对形式、凭据绝不可见）。
2. **作为 owner，我想从审计项精确跳回项目来源，从而快速定位上下文。**
   - 项目事件定位到项目视图（规范身份路由）；定位失败如实提示不伪造跳转。
   - 跨项目 tuple 隔离不变；重启/重建后投影与源一致（基座既有保证，本片加项目事件一致性断言）。

## 实现决策

- schema identity 21→22：`audit_event_outbox.source` CHECK 放宽加入 `'project_workspace'`；同波次迁移全部硬编码 identity 断言、unsupported-schema 夹具与 write-ownership manifest（A-237 纪律）。
- Project & Workspace 原子写：勘察 `src/adapters/outbound/sqlite/project-workspace/` 全部写入点（projects.ts 创建、workspace-service.ts 绑定/改绑、membership-service.ts 成员变更、validation-policy-service.ts 策略修订与 `project_validation_policy_audits`），同事务追加 outbox；白名单提取集中 `project-workspace/audit-event-outbox.ts`（028/030/035 同构）；注意 `project_validation_policy_audits` 已是审计型表——勘察后决定复用镜像还是直接以其为源，避免双写语义漂移。
- 宿主路径脱敏：工作区绑定路径属宿主绝对路径，payload 只允许脱敏形式（如 basename/哈希/占位），勘察 027 只读浏览的脱敏先例；fail-closed。
- 事件选型（MVP 最薄）：项目创建、工作区绑定/改绑、成员加入/移除、验证策略变更；内部噪声不入列——勘察后把选型清单记录到假设台账。
- Query/consumer 零改动；UI：审计面板域徽标 + 项目域文案映射 + 定位链接（项目规范身份路由 `/projects/{projectId}` 或勘察后的更精确形态）。
- 不变量：复用既有 projection⊆outbox 等；无需新增。

## 测试决策

- TDD 每轮一个公共缝 RED + 最小 GREEN；内存库夹具。
- **Outbox 写缝**：项目域事实写入 → outbox 同事务镜像；白名单无敏感；路径脱敏；摘要截断；选型外类型不入列；seq 单调；reopen 幂等。
- **查询缝**：混合四域排序/分页/项目隔离（基座已有，本片加项目投影内容断言）。
- **UI 缝**：项目域文案映射、域徽标、定位链接 href、empty/loading/error 全态。
- **浏览器验收**：落点勘察后择定（候选 smoke:onboarding/smoke:settings——项目创建与工作区绑定真实造数现成）——真实造数 → 审计呈现+域徽标 → 定位跳项目 → 投影一致性；desktop/narrow、light/dark、keyboard、focus、44px、axe 无 serious/critical；秘密扫描（含宿主路径）零泄漏；一次性全量 + build。

## 范围外事项

- 其他 source owner 纵切（AUD-GOV、AUD-RUN 各自另起切片）；统一审计浏览器组合视图（S-23 汇总 AUD-UI）。
- 项目事件的全量历史回放；多绑定根管理。

## 补充说明

- 单一用户结果（项目/工作区事件可查询可导航）；3 张票；030/035 模板已交付使本片保持最小。
- 评审按项目级 review 豁免跳过；默认选择记入 product/assumptions.md。
