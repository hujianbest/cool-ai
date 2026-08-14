# 041 AUD-RUN code-review

- 固定点: `d21c1cb`（037/S-53 ship）
- 范围: 该点之后的 041 工作树（含未提交）
- 日期: 2026-08-15
- 评审人: 独立 subagent（Standards + Spec 双轴）；作者未自评通过

## Standards

1. **严重** `turn-orchestrator.ts` Provider 返回后重读 `agents.model`，可能把审计写成“最新”模型而非本次调用冻结值。违反 AGENTS.md 不可变 provenance。
2. **一般** `runtime/audit-event-outbox.ts` 使用 `as` 收窄 surface。
3. **一般** 三份 review 测试手写 `audit_event_outbox` DDL / 裸 `DatabaseSync(":memory:")`，未走共享内存库夹具。
4. **建议** 追加逻辑分散在多个 orchestrator；audit-panel domain 分派可登记化。

## Spec

1. **严重** `publicModel` 先截断再凭据分类，完整 API key 被截断后可能漏检，前缀可入列。
2. **严重（部分采纳）** Review slice 若干“HTTP 已成功但未落 `review_model_calls`”路径无 Runtime outbox。采纳：无领域 call 行则不同事务旁路写 outbox（A-295）；不把未持久化路径扩成第二套 call 事实。
3. **严重** HTTP 成功后的结构校验失败被映射为 `runtime_call_failed`，与 spec「callOpenAiChat 成败」不符。
4. **一般** smoke 跨项目隔离只复用 foreign 404。

## 结论

初审未通过。作者修复 Standards#1、Spec#1、Spec#3 与类型守卫后，独立复审 **PASS**（2026-08-15）。延期不阻塞：手写 DDL 夹具、面板 domain registry、A-299 无 call 行路径、smoke 第二项目 Runtime 过滤（037 已有项目隔离基础）。
