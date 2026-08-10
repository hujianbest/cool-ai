# 任务票 — 协作审计事件纵切（AUD-COL）

- 状态: 项目级 review 豁免生效，直接进入 implement
- 规模: 3 张纵向 RED/GREEN 票；单一"协作事件可查询可导航"用户结果
- 公共缝: Collaboration Outbox Write、审计 UI 扩展
- TDD: 每票先一个公共行为 RED，再最小 GREEN；内存库夹具；consumer 协议零改动

- [x] T-01 协作 outbox 原子写与 schema 放宽 — Blocked by: None
  - 公共缝: Collaboration Outbox Write。
  - RED: source CHECK 拒绝 public_collaboration；协作写入不产生 outbox。
  - GREEN: identity 15→16（source CHECK 放宽，同步全部引用）；勘察 collaboration_events 全部写入点同事务追加 outbox（白名单集中一处：type/actor/occurredAt/threadId/runId/messageId/公开摘要 grapheme 截断；选型清单常量：run 生命周期、owner/agent_message、handoff、decision_*；噪声类型不入列）；writer manifest 无需变（outbox 写者扩展登记 public-collaboration——勘察 manifest 结构后更新）。
  - 验证: 原子性、白名单无敏感、摘要截断、选型外类型不入列、seq 单调、reopen 幂等。
  - 命令: 聚焦 tests/modules/public-collaboration/ + schema 套件；`npx tsc --noEmit`
  - 结果: identity 16 + CHECK 放宽落盘；5 个 live 事件写入点（thread-service startThreadRun、run-service controlThreadRun/answerThreadDecision、turn-orchestrator 与 action-committer 的 appendEvent）+ owner_message 事实单点镜像（appendBatchTx）全部同事务追加；选型 16 类型全覆盖 14 用例（含原子回滚/截断/redacted/噪声排除/seq 单调/reopen 幂等）；writers 登记以 manifest `sharedAppendWriters` 永久机制放行；聚焦 14/14、tests/adapters/sqlite 170、tests/architecture 25、public-collaboration+operations-projection 685 全绿，`npx tsc --noEmit` 绿；修复前序会话遗留 grapheme 截断 segment 对象 join 缺陷与测试文件重复块；legacy 项目级死路径不接线（A-161）。默认选择见 A-159～A-163。

- [x] T-02 审计 UI 协作呈现与定位 — Blocked by: T-01
  - 公共缝: 审计列表 UI（jsdom）。
  - RED: 协作事件无文案/徽标/定位。
  - GREEN: audit-panel 扩展——域徽标（执行/协作）、协作类型可读文案映射（未知兜底原文）、来源定位（thread 规范身份链接；有 message 缝则精确跳转）、freshness 不变；empty/error 全态保持。
  - 验证: 混合两域渲染、文案映射、定位链接 href 断言、只读。
  - 命令: 聚焦 audit-panel 测试；`npx tsc --noEmit`
  - 结果: 4 轮 RED/GREEN 落盘——①16 类协作类型可读文案映射（`COLLABORATION_EVENT_TYPE_COPY` 集中一处并入 `EVENT_TYPE_COPY`，未知兜底原文）②域徽标（执行→status-running/协作→status-queued 复用 `.status-label` 既有变体，类型映射集兼作域分类器，DTO 零协议改动）③messageExcerpt 仅消息类渲染、`.audit-event-excerpt` 单行 ellipsis tokens 截断样式 ④协作来源定位=规范目标身份链接 `/projects/{projectId}?thread=…[&run=…]`（message 精确缝不可复用：018/022 messageRefs 系面板内部机制且 parseProjectSelection 只接受 thread/run；payload 引用畸形不渲染链接；执行域焦点缝定位零改动）。新增 4 用例（文案映射表/混合两域徽标/摘要呈现/定位 href 与回归），聚焦 12/12、tests/browser/project-context 14 文件 74 用例全绿，`npx tsc --noEmit` 绿。默认选择见 A-165～A-167。

- [x] T-03 真实浏览器验收 — Blocked by: T-02
  - 公共缝: 真实协作造数 + 审计面板。
  - 验证: 真实造数（发 owner 消息 + run 生命周期事件）→ 审计呈现协作事件+域徽标 → 定位跳线程 → 投影一致性（74+新增协作行==outbox==projection）；desktop/narrow、light/dark、keyboard、focus、44px、axe 无 serious/critical；秘密扫描（消息摘要可见属预期，凭据/推理零泄漏）；一次性全量 `npx vitest run` + `npx tsc --noEmit` + `npm run build`。
  - 命令: 勘察后选 smoke 落点；全量一次；`npm run build`
  - 结果: 落点勘察后择定 smoke:threads（真实协作造数现成：7 owner 消息/2 run 生命周期/decision/回复/附件；smoke:execution 保留执行域审计段）——验收段置于 favorites 重启段之后、终扫之前。API 走查：14 协作事件单页、freshness=caught_up、全局 DESC、五必备类型（owner/agent_message、run_started/stopped、decision_requested）齐备、messageExcerpt 逐字投影、run 事件携 threadId+runId、run-less owner 消息 runId=null、foreign-project 404 无宿主路径回显、API JSON 秘密扫描零泄漏；DB 一致性：outbox==projection==API==14、checkpoint==MAX、source 全为 public_collaboration、噪声类型（model_call_*/usage_recorded/attempt_interrupted）零 outbox 行。桌面：tablist End 键选中审计 tab（activeElement 实核）→ 14 行全渲染、每行协作徽标、摘要行呈现、定位链接 href 规范身份（run 事件带 run、run-less 消息仅 thread）→ 链接 focus 可见焦点环 + Enter 真实导航落 `?thread=…&run=…`（运行选择器值实核）→ 44px（tab/链接）→ axe desktop light/dark 各一次全零违规。窄屏：抽屉键盘开启→tab Enter 选中→首行文案/摘要/链接 href/44px→axe 一次→Escape 焦点归还 opener。axe 22 态 blocking/contrast 全零；唯二违规为既有 aria-allowed-role:minor@task-context-drawer（A-125/A-135/A-148 同例，窄屏抽屉既有模式，低于门禁不修）；审计面板三态（desktop light/dark/narrow）零违规，同页 memory tab 基线零违规确认无chrome 归因需求。秘密扫描面扩展 auditFacingText/narrowAuditFacingText/三张审计截图字节，终扫全绿。证据：features/030-collaboration-audit-events/evidence/ 三截图 + 014 results.json（34 断言全过）。一次性全量：vitest 260 文件 2287 用例全绿 109.32s（回落基线内）、`npx tsc --noEmit` 绿、`npm run build` 绿。无生产缺陷。默认选择见 A-168。
