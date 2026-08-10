# 架构 — 协作审计事件纵切（AUD-COL）

- 日期: 2026-08-10
- 对应规格: [`spec.md`](./spec.md)
- 状态: 项目级 review 豁免生效；未送独立评审，不伪造工件

## 架构目标

验证 028 基座的纵切扩展性：只加"source owner 写点 + schema CHECK 放宽 + UI 文案/定位"，consumer/checkpoint/rebuild/freshness 协议零改动。

## Module 与 Interface

- Public Collaboration：collaboration_events 写入点同事务追加 outbox（source='public_collaboration'）；白名单提取集中一处（新文件，028 同构模式）；事件选型清单常量集中。
- Operations Projection：零协议改动；UI 组件（audit-panel.tsx）扩展域徽标与文案映射表（协作事件类型 → 可读文案，未知兜底原文）。
- schema：identity 15→16，仅 outbox（及 projection 如有）source CHECK 放宽。
- 定位：协作事件 DTO 已带 payload 引用（threadId/runId/messageId）；UI 生成规范目标身份链接（/projects/{id}?thread=…&run=…；有 message 精确缝则用）。

## 关键流程

1. 协作域业务写 → collaboration_events + outbox（同事务）。
2. 审计面板 catchUp → 投影含协作事件 → 呈现 + 定位。
3. 重启/rebuild → 基座保证一致；本片加协作行数一致性断言。

## Seam 与测试点

- Seam 1 — collaboration outbox 写：tests/modules/public-collaboration/ 扩展。
- Seam 2 — 审计 UI 扩展：tests/browser/project-context/audit-panel.test.tsx 扩展。
- Seam 3 — smoke 验收段（smoke:threads 审计段或 smoke:execution 扩展，勘察后定）。

## 横切约定

- 幂等/重放安全继承基座；白名单 fail-closed；tokens/44px/键盘/全态；错误脱敏。

## ADR 链接

- 遵守 ADR-0003；本片证明基座纵切扩展成本，作为后续 AUD-* 纵切模板。
