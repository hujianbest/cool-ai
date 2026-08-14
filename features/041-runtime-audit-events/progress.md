# 041 AUD-RUN 进度

- 特性: 041-runtime-audit-events（对应切片: S-57 / S-23 的 AUD-RUN 纵切）
- 当前阶段: done
- 执行模式: auto
- 已加载扩展: 无
- 下一步: done
- 用户可感知: 是；演示验收 auto-approved 2026-08-15
- 评审状态: spec/architecture/`hf-review` 豁免；hf-code-review 独立双轴后复审通过（固定点 `d21c1cb`）；一般项（手写 DDL、面板登记化、A-299）延期不阻塞。

## 实施记录

- 2026-08-15 特性立项（auto grill）：建立 `CAP-RUN-07`；事件选型 2 类 runtime_call_succeeded/failed；全局 Provider verify 无 project_id 不入列；`*_model_calls` 所有权不变。默认见 A-294～A-297。下一步 T-01。
- 2026-08-15 T-01 完成：schema identity 23→24，`audit_event_outbox.source` CHECK 加 `runtime`；新增 Runtime 白名单 writer（surface/model/errorCategory + 严格导航 id，model 200 grapheme + public-text credential seam，秘密字段不入列）；同事务接线 collaboration `persistCallAudit`、execution `finishCallingFact`、review orchestrator `terminalCall`/`checkpoint`、legacy review slice 的 provider failure/redaction/success写点，`action-orchestrator` 由 structured execution seam 覆盖；`review-structured-repair` 无生产持久化调用方，未在无 DB 的 HTTP helper 内旁路写 outbox。write-ownership 注册 runtime；全部硬编码 identity 断言同步为 24，legacy fixture 并集加入 23，future rejection 24→25。identity/fixture 同步按 A-287 作为机械性 RED 豁免；新 Runtime 行为真实 RED：1 文件 8 例中 7 例按预期失败（1.30s），GREEN 1 文件 8/8（1.31s）；schema/architecture 聚焦 9 文件 78/78（24.78s）；最终跨域写点聚焦 9 文件 78/78（3.46s）；`npx tsc --noEmit` 通过（9.36s）。主要文件：`current-schema.ts`、`runtime/audit-event-outbox.ts`、三域四个持久化服务、write-ownership manifest、identity/unsupported-schema fixtures、`runtime-audit-outbox.test.ts`。下一步 T-02。
- 2026-08-15 T-02 完成：审计面板加入 `RUNTIME_EVENT_TYPE_COPY` 兼运行时域分类器，两类事件使用「运行时调用已成功/已失败」文案与裸 `.status-label`「运行时」徽标；按严格 surface/非空字符串 id 生成 execution、review catch-all、collaboration thread/run 定位链接，畸形引用与空 projectId 不渲染链接；摘要只读取非空 `model`，失败事件可追加非空 `errorCategory`，既有 execution 定位按钮仍仅属于 execution 域。新增四例 Runtime UI 契约覆盖六域混排/只读、三类定位、畸形引用、摘要与 foreign-key 隔离。真实 RED：1 文件 28 例中 3 例按预期失败、25 例通过（3.18s）；GREEN：1 文件 28/28（3.22s）；project-context 回归 15 文件 97/97（10.75s）；`npx tsc --noEmit` 通过（11.85s）；编辑文件无 linter 错误。未新增假设。下一步 T-03。
- 2026-08-15 T-03 浏览器验收完成：`npm run smoke:execution` 复用 028/037 cursor-complete `auditEvents` 与真实 `callOpenAiChat`，新增 041 Runtime 紧凑验收段；44 个 `runtime_call_succeeded` 事件通过 source=`runtime` 项目 outbox==过滤 API、项目 outbox==完整 API、全局 checkpoint==maxSeq、foreign 404、payload apiKey/baseUrl/宿主路径零泄漏，以及桌面审计行「运行时」裸徽标、中文文案、model 摘要、规范 execution 定位、44px；复用同一列表的桌面明暗 axe 两态，0 serious/critical。runner 无 Provider fault injection，未额外新增完整执行，`runtime_call_failed` 由 T-01 单元套件覆盖（A-298）。日志 `RUNTIME AUDIT ACCEPTANCE PASS: assertions=20 axeStates=2`，wall 100.3s；证据 `features/041-runtime-audit-events/evidence/`；演示 auto-approved 2026-08-15。
- 2026-08-15 T-03 门禁记录：首次 smoke 因 `.next` 仍是无 Runtime 代码的旧 bundle 失败，单次生产 build 刷新后 smoke 全绿；`npm run build` 通过（49.3s），`npx tsc --noEmit` 通过（6.7s，测试夹具修复后复核亦通过）。按用户要求仅运行一次全量 `npx vitest run`：285 文件中 283 通过、2615 例中 2610 通过，124.80s（wall 127.6s）；5 个失败均为 T-01 新 Runtime 行使共享 outbox 全局 seq 后的旧测试预期（2 个 thread-search cursor/source_seq、3 个 execution source 未过滤），已机械修复并以对应聚焦 2 文件 28/28（2.54s）确认；未第二次运行全量套件。当前阶段仍为 implement，强制 hf-code-review 待父会话独立执行，不宣称 ship/code-review 通过。
- 2026-08-15 hf-code-review 结论「需修改」后作者修复：协作主调用在 HTTP 请求前冻结同一 `model` 值并传入 finalize/outbox，不再重读 `agents.model`；Runtime model 对完整字符串先走凭据分类、通过后才截断 200 grapheme，补长前缀+尾部秘密回归；Runtime surface 改为显式 union + type guard，移除不安全断言；execution/review/collaboration 的 Runtime 成败改以 `callOpenAiChat` 结果为准，HTTP 成功后的 structured/response validation 失败仍记 `runtime_call_succeeded`，领域 `*_model_calls.status` 保持 `response_invalid`。Review slice 未持久化领域 call 行的路径不新增 outbox，按 A-299 维持同事务纪律；未增加第四次 execution smoke，037 已覆盖第二项目隔离基础。当前仍为 implement，待独立复审；未勾 ship 或 CAP-RUN-07。
- 2026-08-15 修复验证：用户指定聚焦命令 4 文件 37/37 通过（Runtime、Safe Execution、Review、Public Collaboration），`npx tsc --noEmit` 通过；未运行全量 Vitest，未 commit。
- 2026-08-15 独立复审 PASS（固定点 `d21c1cb`）：冻结模型、先分类后截断、HTTP 成败语义、surface type guard 均已落地。全量 `npx vitest run` 285 文件 / 2617 测试通过，127.52s。`CAP-RUN-07` 已交付核心。S-23 仍待 AUD-UI。
