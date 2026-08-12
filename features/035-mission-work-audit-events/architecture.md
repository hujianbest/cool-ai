# 架构 — Mission & Work 审计事件纵切（AUD-MWK）

- 日期: 2026-08-12
- 对应规格: [`spec.md`](./spec.md)
- 状态: 项目级 review 豁免生效；未送独立评审，不伪造工件

## 架构目标

继续验证 028 基座的纵切扩展性（第三纵切）：只加"source owner 写点 + schema CHECK 放宽 + UI 文案/定位"，consumer/checkpoint/rebuild/freshness 协议零改动。

## Module 与 Interface

- Mission & Work：`task_events`（及勘察确认的本域事实写入点）写入处同事务追加 outbox（source='mission_work'）；白名单提取集中一处（新文件 `src/adapters/outbound/sqlite/mission-work/audit-event-outbox.ts`，028/030 同构模式）；事件选型清单常量集中。
- Operations Projection：零协议改动；UI 组件（audit-panel.tsx）扩展域徽标与文案映射表（任务事件类型 → 可读文案，未知兜底原文）。
- schema：identity 20→21，仅 outbox（及 projection 如有）source CHECK 放宽。
- 定位：任务事件 payload 带任务/ Mission 引用；UI 生成规范目标身份链接（项目内任务/Mission 路由，勘察 026 依赖全景导航缝与任务区 URL 形态后定）。

## 关键流程

1. 任务域业务写 → `task_events`（等本域事实）+ outbox（同事务）。
2. 审计面板 catchUp → 投影含任务事件 → 呈现 + 定位。
3. 重启/rebuild → 基座保证一致；本片加任务行数一致性断言。

## Seam 与测试点

- Seam 1 — mission-work outbox 写：`tests/modules/mission-work/` 新增聚焦套件。
- Seam 2 — 审计 UI 扩展：`tests/browser/project-context/audit-panel.test.tsx` 扩展。
- Seam 3 — smoke 验收段（候选 smoke:context，勘察后定）。

## 横切约定

- 幂等/重放安全继承基座；白名单 fail-closed；tokens/44px/键盘/全态；错误脱敏。
- identity 提升同波次迁移全部硬编码断言与 write-ownership manifest（A-237）。

## ADR 链接

- 遵守 ADR-0003；030 已证明基座纵切扩展成本，本片沿用同模板。
