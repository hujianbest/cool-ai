# 架构 — Project & Workspace 审计事件纵切（AUD-PWS）

- 日期: 2026-08-12
- 对应规格: [`spec.md`](./spec.md)
- 状态: 项目级 review 豁免生效；未送独立评审，不伪造工件

## 架构目标

继续验证 028 基座的纵切扩展性（第四纵切）：只加"source owner 写点 + schema CHECK 放宽 + UI 文案/定位"，consumer/checkpoint/rebuild/freshness 协议零改动。

## Module 与 Interface

- Project & Workspace：本域事实写入点（projects 创建、workspace 绑定/改绑、memberships 变更、validation policy 修订）同事务追加 outbox（source='project_workspace'）；白名单提取集中一处（新文件 `src/adapters/outbound/sqlite/project-workspace/audit-event-outbox.ts`，028/030/035 同构）；事件选型清单常量集中；`project_validation_policy_audits` 复用/镜像取舍勘察后定论（避免双写语义漂移）。
- Operations Projection：零协议改动；UI 组件（audit-panel.tsx）扩展域徽标与文案映射表（项目事件类型 → 可读文案，未知兜底原文）。
- schema：identity 21→22，仅 outbox（及 projection 如有）source CHECK 放宽。
- 定位：项目事件 payload 带 projectId；UI 生成项目规范身份链接（`/projects/{projectId}` 或勘察后更精确形态）。
- 脱敏：宿主绝对路径不得进入 payload/投影（basename/占位），fail-closed。

## 关键流程

1. 项目域业务写 → 本域事实 + outbox（同事务）。
2. 审计面板 catchUp → 投影含项目事件 → 呈现 + 定位。
3. 重启/rebuild → 基座保证一致；本片加项目行数一致性断言。

## Seam 与测试点

- Seam 1 — project-workspace outbox 写：`tests/modules/project-workspace/` 新增聚焦套件。
- Seam 2 — 审计 UI 扩展：`tests/browser/project-context/audit-panel.test.tsx` 扩展。
- Seam 3 — smoke 验收段（候选 smoke:onboarding / smoke:settings，勘察后定）。

## 横切约定

- 幂等/重放安全继承基座；白名单 fail-closed；tokens/44px/键盘/全态；错误脱敏。
- identity 提升同波次迁移全部硬编码断言与 write-ownership manifest（A-237）。

## ADR 链接

- 遵守 ADR-0003；沿用 030/035 纵切模板。
