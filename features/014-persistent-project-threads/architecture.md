# 架构 — 项目内持久线程与上下文续接

- 日期: 2026-08-09
- 对应规格: [`spec.md`](./spec.md)
- 兼容来源: [`design.md`](./design.md)（旧流程完整技术设计，已独立批准）
- 用户确认: auto-approved 2026-08-09
- 性质: 仅为 HarnessFlow 兼容索引；不替代旧设计，不引入新决策或改变行为边界。

## 模块边界

- **v7 持久化模块**（`src/server/migrations-v7.ts`）：唯一持有最终 DDL manifest、v6→v7 原子迁移、规范化 schema/data 校验；`migrations.ts` 只调用一次 6→7 升级。
- **线程协作模块**（`src/server/collaboration/`）：`thread-service` 统一分配项目活动序号、线程 fact/message 序号、policy revision 与 receipt；run/orchestrator/committer 不旁路写线程事实。
- **协作 HTTP 与共享契约模块**：所有入口以 `{projectId,threadId,runId}` 完整 tuple 校验并调用领域接口；旧 run-only/project-only 协作入口不兼容执行。
- **上下文编排模块**：prompt 只读取所选线程消息，Mission、看板和 active memory 仍读取项目共享事实；Provider 调用与结构化修复服从公开文本凭据检查。
- **来源追溯模块**：execution、review、delivery 只沿冻结 `SourceTuple` 追溯，不以项目最新 run 替代明确来源。
- **导航与呈现模块**：URL 是 thread/run 选择事实；UI 只渲染 thread facts，并以 canonical target identity、abort/epoch 防止陈旧读写。

## 缝与测试点

- `V7_OBJECT_SQL`/`validateV7` 接缝：以相同 manifest 驱动迁移与 exact-schema 校验；用 fault injection、重复打开、非法 legacy fixture 验证原子性与失败关闭。
- strict request/response schema → route → tuple-scoped service/SQL 接缝：验证 path/query/body、跨项目 tuple 同形 404、receipt replay、并发版本冲突与零部分写入。
- `thread-service` 公共接口接缝：验证同名稳定身份、确定活动排序、不可变 policy revision、连续 fact/message 序号和幂等 operation。
- prompt/orchestrator 接缝：验证线程上下文互斥、项目共享事实、policy readiness、同项目单一非终态 run、重启不重发 Provider。
- `classifyPublicText` 与 Provider adapter 接缝：在 owner ingress、primary/repair raw、完整 AgentTurn 公开字段验证 A-72 的拒绝/放行集合及无原文泄漏。
- URL props/`targetKey` 与事实页接缝：验证深链、显式 run、fact-only 去重渲染、切换清空、延迟响应失效、键盘/焦点/窄屏/axe。
- frozen `SourceTuple` 接缝：验证 execution retry/rework、review material、delivery 来源与返回链接均保持原 project/thread/run。

## 核心数据

- `collaboration_threads` 属于 project，持有 active policy head、版本、next fact sequence 与 last activity sequence；项目级 sequence 提供确定列表顺序。
- policy revision/member 不可变并保存成员显示名快照；live roster 仅决定当前 readiness，不改写历史。
- run、operation、message、attempt、turn、decision、event 均携带 project/thread（适用时 run）复合归属；复合 FK/UNIQUE 强制隔离与唯一性。
- `collaboration_thread_facts` 是唯一公开渲染流；message 与 run event 保持独立存储和冻结引用，每项业务事实只映射一次。
- `SourceTuple={projectId,threadId,runId}` 是 execution/review/delivery 的冻结来源身份。

## 关键流程

1. **升级恢复**：在单个 `BEGIN IMMEDIATE` 中创建/校验 shadow、确定回填每项目默认线程及历史 policy/run/message/fact/receipt，再建最终表并仅在全量校验后写 v7；任一步失败全部回滚。
2. **线程续接**：URL 选择 thread/run → tuple-scoped 读取 facts/policy/readiness → owner 消息原子写 operation+message+fact；Agent dispatch 还须 policy 可用、目标 Agent Provider 可用且项目无其他非终态 run。
3. **Agent 输出**：先检查 primary raw，必要时才 repair 且先检查 repair raw，再原子检查全部公开字段；命中凭据只产生 sanitized terminal outcome，不提交业务事实。
4. **来源下游**：run 归属线程并冻结 source tuple → execution 保存该来源 → review/delivery 由冻结来源恢复材料与链接；任何 tuple mismatch 安全失败且不 fallback。

## 横切约定

- 写入使用事务、operation/request hash、version/lease 与事实重放；重试不重复业务动作，序列与来源不漂移。
- 未知资源和跨归属访问同形失败；错误、日志、DOM、receipt 不含 Provider raw、凭据、prompt、主机路径或隐藏推理。
- 历史身份、策略、事实与来源不可变；损坏 schema/data、非法 legacy 归属或顺序一律失败关闭。
- UI 复用现有 token/语义控件，覆盖 loading/empty/error/disabled/success/focus、44×44px、WCAG AA、desktop/narrow；切换目标先 abort、递增 epoch 并清空旧缓存/草稿。
- 测试只跨上述公共接口，定向覆盖迁移、tuple、幂等/并发、重启、凭据与 stale response，最终执行旧设计第 8 节的全套 test/build/smoke。

## ADR 链接

- 无新增 ADR；不可逆选择沿用旧设计的 [D-1～D-5](./design.md#2-关键决策)，细节与权威契约继续以 [`design.md`](./design.md) 为准。
- 产品行为由 [`product/assumptions.md` A-68～A-73](../../product/assumptions.md) 确认，并迁入 [`product/decisions.md` D-30～D-35](../../product/decisions.md)。
- 独立批准记录：[`reviews/design-review.md`](./reviews/design-review.md)；规格批准记录：[`reviews/spec-review.md`](./reviews/spec-review.md)。
