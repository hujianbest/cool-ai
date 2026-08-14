# 041 AUD-RUN 任务票

- 状态: spec/architecture 项目级豁免；schema + 共享 outbox，implement 后必须 hf-code-review（A-286）
- 规模: 3 张纵向票；单一「Runtime session 可查询可导航」用户结果

- [x] T-01 Runtime 域 outbox + schema 23→24：`current-schema.ts` identity 24、`audit_event_outbox.source` CHECK 加 `'runtime'`；新增 `src/adapters/outbound/sqlite/runtime/audit-event-outbox.ts`；在 `callOpenAiChat` 的各领域同事务提交点接线 `runtime_call_succeeded` / `runtime_call_failed`；payload 白名单 `surface, model, errorCategory` 与导航 id；凭据/URL/正文永不入列；write-ownership sharedAppendWriters 加 runtime；同波次 identity 断言与 unsupported-schema 夹具。新聚焦套件 RED→GREEN。
- [x] T-02 审计 UI 运行时域呈现与定位：`RUNTIME_EVENT_TYPE_COPY` 兼分类器；裸 `.status-label` 文案「运行时」；定位按 surface 规范路由，畸形不渲染；摘要只呈现 model/errorCategory。聚焦 UI 测试 RED→GREEN + project-context 回归。
- [x] T-03 浏览器验收 + hf-code-review + ship：smoke 落点优先复用已有真实 `callOpenAiChat` 的 runner（smoke:execution 或 smoke:collaboration），不新增完整 Agent execution；API 两类齐备/outbox==projection==API/foreign 404/跨项目隔离 + 桌面明暗/窄屏/axe 0 serious/critical + 秘密扫描；全量 + tsc + build；然后由**独立** subagent 跑 hf-code-review；backlog `CAP-RUN-07` 勾选。
