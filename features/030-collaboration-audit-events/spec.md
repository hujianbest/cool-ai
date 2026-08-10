# 协作审计事件纵切（AUD-COL）需求规格

- 日期: 2026-08-10
- 特性: 030-collaboration-audit-events
- 对应切片: S-23 的 AUD-COL 纵切（CI-3.8 第二子片）
- 模式: 建造
- 用户可感知: 是（审计中心扩展协作事件）
- 执行模式: auto（用户不在场，问题按助手推荐处理并记录假设）
- 共享理解来源: `product/backlog.md` S-23 与 `CAP-COL-07` 条目（auto-approved 2026-08-10）；前置 `CAP-OPS-01/02`（028 AUD-MVP 已 ship）
- 公共行为接缝: Collaboration Outbox Write（Public Collaboration 原子写入）；审计列表 UI 扩展（Operations Projection 既有查询复用）
- 主子系统: Operations Projection（复用）；source owner: Public Collaboration；主 Capability: `CAP-COL-07`（本片建立：owner 可查询脱敏 Thread/Run 事件并精确导航）

## 问题陈述

AUD-MVP 只覆盖 Safe Execution 事件；协作域（线程/Run）发生了什么——owner 消息、agent 消息、run 生命周期、handoff、decision 等——在审计中心不可见，也无法从审计项精确跳回线程/消息来源。

## 解决方案

复用 028 投影基座做第二个 source-owner 纵切：Public Collaboration 在写 `collaboration_events`（及适用的 thread facts）的同一事务内原子追加 outbox 行（source='public_collaboration'，payload 白名单）；consumer 无需改动（source 无关）；审计中心 UI 扩展呈现协作事件（类型可读文案、线程/Run 来源定位、精确跳转到消息/线程）。schema identity 15→16 放宽 outbox source CHECK。

## 用户故事

1. **作为 owner，我想在审计中心看到协作事件，从而理解线程/Run 发生了什么。**
   - 审计列表同时呈现执行与协作事件，域徽标区分；协作事件含类型可读文案（owner/agent 消息、run 开始/停止/暂停/恢复、handoff、decision 等既有事件词汇）。
   - payload 只含公开脱敏字段（消息正文摘要是公开对话内容，允许列入截断摘要；凭据/隐藏推理/原始 provider 响应绝不可见）。
2. **作为 owner，我想从审计项精确跳回来源，从而快速定位上下文。**
   - 协作事件定位到线程（并尽可能精确到消息/运行）；复用现有线程导航缝（规范目标身份）；定位失败如实提示不伪造跳转。
   - 跨项目 tuple 隔离不变；重启/重建后投影与源一致（基座既有保证，本片加协作事件的一致性断言）。

## 实现决策

- schema identity 15→16：`audit_event_outbox.source` CHECK 放宽为 `('safe_execution','public_collaboration')`；同步全部引用。projection 表 source 列无 CHECK 或同步放宽（勘察后一致处理）。
- Public Collaboration 原子写：勘察 `collaboration_events` 全部写入点（write owner: public-collaboration），同事务追加 outbox；payload 白名单集中一处（复用 028 的集中模式）：type、actor、occurredAt、threadId/runId/messageId 引用、公开摘要（消息正文 grapheme 截断 + 经既有 public-text 校验缝）；敏感/超限内容按既有脱敏语义 fail-closed 或降级占位。
- 事件选型（MVP 最薄）：覆盖 run 生命周期（run_started/run_stopped/run_paused/run_resumed/failed 相关）、owner_message/agent_message（摘要）、handoff、decision_requested/decision_answered；其余类型（model_call_*、usage_recorded 等噪声）不入 outbox——记录选型清单到假设台账。
- Query/consumer 零改动（source 无关）；UI：审计面板域徽标 + 协作文案映射 + 定位链接（thread 规范身份路由；message 精确跳转若有缝则复用 022 的跳转弯）。
- 不变量：复用既有 projection⊆outbox 等；无需新增。

## 测试决策

- TDD 每轮一个公共缝 RED + 最小 GREEN；内存库夹具。
- **Outbox 写缝**：collaboration_events 写入 → outbox 同事务镜像；白名单无敏感；消息摘要截断；选型外类型不入列。
- **查询缝**：混合两域排序/分页/tu多项目隔离（基座已有，本片加协作投影内容断言）。
- **UI 缝**：协作文案、域徽标、线程定位链接、empty/loading/error。
- **浏览器验收**：smoke:threads 或 smoke:execution 的审计段扩展——真实协作造数（发消息/run）→ 审计呈现 → 跳转线程 → desktop/narrow、light/dark、keyboard、axe、秘密扫描。

## 范围外事项

- 其他 source owner 纵切（Mission/Governance/Runtime/Project）；统一审计浏览器组合视图（S-23 汇总）；线程内容搜索（S-17 复用基座另建索引投影）。
- 协作事件的全量历史回放。

## 补充说明

- 单一用户结果（协作事件可查询可导航）；3～4 张票；基座已交付使本片显著小于 AUD-MVP。
- 评审按项目级 review 豁免跳过；默认选择记入 product/assumptions.md。
