# 进度

- 特性: 063-agent-signed-memory-curation
- 对应切片: S-32
- 当前阶段: done
- 执行模式: auto
- 已加载扩展: hf-ui-design
- 下一步: 无（已 ship）；不进入 S-45 族
- 用户可感知: 是
- 评审状态: spec/architecture 按 A-286 豁免（不伪造评审工件）；implement 后须 hf-code-review（schema + 跨 owner 聚合 + 发布写）
- 共享理解: auto-approved 2026-08-27（A-434～A-442）

## 状态记录

- 2026-08-27 grill-with-docs：S-32 原「阻塞于 S-24 非执行域发布治理」按 Capability 现状重评——`CAP-GOV-02` 统一审批中心已 ship；本片建立 knowledge 发布域并接入中心（A-434）。默认 A-435～A-441。
- 2026-08-27 to-spec / to-architecture / to-tickets：规格、增量架构与 6 张纵向票落盘；spec/architecture 评审豁免 auto-approved。进入 T-01。
- 2026-08-27 T-01 完成：canonical schema identity 30，候选/有序来源表与 Agent confirmer 可空约束落盘；Knowledge `proposeCuration` 完成严格输入、项目成员/来源/supersedes 校验及 project-scoped operation 幂等。RED 因 adapter 模块不存在失败；GREEN 聚焦 20/20、知识回归 81/81、identity 回归 209/209、`tsc --noEmit` 全绿。
- 2026-08-27 T-02 完成：Knowledge `listCurationCandidates` 以 project-scoped SQL 返回 Agent 署名、有序来源与确定性逐行 LCS diff，按 `created_at DESC,id ASC` 排序；未知项目 404。RED 因 query export 缺失失败；GREEN 聚焦 8/8、Knowledge 回归 66/66、`tsc --noEmit` 全绿。
- 2026-08-27 T-03 完成：Knowledge `decideCuration` 同事务发布/驳回并持久化 Agent proposer + nullable confirmer 的 MemoryEntryV6；来源重验、陈旧 supersedes→replaced、终态幂等/冲突均失败关闭。新增严格 no-store GET/POST/publish/reject HTTP；RED 因 command/route 缺失失败；GREEN 聚焦 26/26、Knowledge+Review 回归 86/86、`tsc --noEmit` 全绿。
- 2026-08-27 T-04 完成：Knowledge `listPendingCurationApprovals` 经公开查询缝向 Governance 暴露 pending/replaced，统一中心扩展 knowledge/memory_publish、严格 sourceRef 与跨域排序；发布/驳回分派复用 T-03 路由，replaced 不可裁决。RED 因中心列表为空失败；GREEN 指定聚焦 45/45、cockpit fixture 13/13、`tsc --noEmit` 全绿；真实 Chrome 完成知识卡展示、发布与退列核对。未实现 T-05「提炼候选」region。
- 2026-08-27 T-05 完成：记忆视图在索引健康条后新增「提炼候选」region，仅展示 pending，覆盖 loading/empty/error/disabled/success/focus；Agent 署名、来源、令牌化 diff 与 publish/reject 接入 T-03 路由，发布后同步刷新候选和记忆并聚焦新记忆。RED 因 region 缺失失败；GREEN `memory-panel` 13/13、相关 review memory UI 5/5、`tsc --noEmit` 与 lint 全绿；真实 Chrome 验证 44px 操作、发布退列、Owner 审批 actor copy 与焦点。未执行 T-06 全量收口。
- 2026-08-27 hf-review 发现项修复：保持未发布 identity 30，候选冻结 Agent 署名快照并补齐 published-memory/终态约束；裁决持久化 operation/hash，支持同请求重放、跨候选冲突与终态新 UUID 幂等；Owner 批准的 legacy 来源不再伪造版本，review-confirmed 约束不变；三个 HTTP POST 统一严格 JSON/64 KiB/资源 ID，来源上限 8；记录 A-443 既有 sqlite 聚合模式。来源 RED 与 media-type RED 均按预期失败后转绿；指定 7 文件测试 69/69、`tsc --noEmit` 与 lint 全绿。仍停在 T-06 前沿，未执行 full-suite ship。
- 2026-08-27 hf-review round-2 修复：已发布 curation memory 的 Agent name/avatar/accent 改从候选快照投影，review-path 仍回退 live Agent；提炼候选 loading 改为无动画、纯令牌 skeleton。两轮 RED 均按预期失败后转绿；指定 4 文件测试 40/40、`tsc --noEmit` 与 lint 全绿；真实 Chrome 因本机缺 Playwright binary 且 CDN 下载停在 0% 未核对。identity 仍为 30，T-06 未勾选。
- 2026-08-27 hf-review round-3 修复：legacy 候选来源拒绝 caller-supplied version 并仅持久化 `source_version=NULL`；DTO 明示 `href=null`，候选 UI 按 MemoryEntryV6 同款规则显示身份/无版本且不编造深链（A-444）；空态新增 ≥44px「刷新提炼候选」但无 propose UI。来源与 UI RED 均按预期失败后转绿；指定 3 文件测试 34/34、`tsc --noEmit` 与 lint 全绿；identity 仍为 30，T-06 未勾选。
- 2026-08-27 hf-review round-4 修复：reject/publish 共用 stale supersedes→replaced 判定；identity 30 新增候选快照/来源 UPDATE、DELETE 不可变触发器且 lifecycle 写保持可用；裁决按钮按 action 显示「正在发布…/正在驳回…」、双禁用并标记 actions busy。生命周期、不可变与 disabled-reason RED 均按预期失败后转绿；指定 3 文件测试 46/46、`tsc --noEmit` 与 lint 全绿；T-06 未勾选。
- 2026-08-27 Standards round-5 test-only 补强：不可变快照用例逐列覆盖 trigger 的 12 个 frozen columns，并将 reject 成功用例改为 deferred POST，核对「正在驳回…」、双禁用、actions busy 与完成后 notice/空态；未改产品代码。指定 2 文件测试 31/31、`tsc --noEmit` 与 lint 全绿；T-06 未勾选。
- 2026-08-27 T-06 / ship：独立 hf-code-review 第 6 轮 Standards + Spec 通过（auto-approved）；聚焦 10/94、tsc、build 绿；全量 334 文件 2921/2922（A-387）。演示 auto-approved。`CAP-KNW-04` 已交付核心。
