# 进度

- 特性: 064-auditable-rules-injection
- 对应切片: S-34
- 当前阶段: done
- 执行模式: auto
- 已加载扩展: hf-ui-design
- 下一步: 无（已 ship）；不进入 S-45 族
- 用户可感知: 是
- 评审状态: spec/architecture 按 A-286 豁免；implement 后须 hf-code-review（安全边界）
- 共享理解: auto-approved 2026-08-27（A-445～A-452）

## 状态记录

- 2026-08-27 grill-with-docs：S-34 原「阻塞于 S-22/S-23/S-24 全局规则治理」按 Capability 现状重评——浏览、审计基座与审批中心已 ship；本片先做只读检查（A-445/A-446）。默认 A-447～A-452。
- 2026-08-27 to-spec / to-architecture / to-tickets：规格、增量架构与 4 张纵向票落盘；spec/architecture 评审豁免 auto-approved。进入 T-01。
- 2026-08-27 implement：T-01 完成。`buildRuleInsight` 通过 Identity 公共入口导出；确定性检查覆盖越权写/执行、绕过复核、凭据外泄与三类注入警告，返回 ≤80 grapheme 脱敏摘录且不回传提示字段。聚焦测试与 `npx tsc --noEmit` 通过；按用户要求停在 T-02 前。
- 2026-08-27 implement：T-02 完成。新增只读 `GET /api/projects/:projectId/rule-insight`，仅组装项目成员 Agent 与其绑定 Skill 后调用 `buildRuleInsight`；未知项目 404，查询键/fragment 400，所有响应 `no-store`，响应不含存储的 prompt/凭据。T-01/T-02 聚焦测试与 `npx tsc --noEmit` 通过；按用户要求停在 T-03 前。
- 2026-08-27 implement：T-03 完成。`/team` 在协作贡献后挂载「规则与注入检查」region，覆盖无项目、loading、empty、error/retry 与按 Agent 分组的警告/阻断发现项；阻断项 `role=alert`，重试按钮沿用 ≥44px 令牌类，无编辑 prompt CTA。指定聚焦测试、`npx tsc --noEmit` 与真实浏览器 `smoke:team` 通过；按用户要求停在 T-04 前。
- 2026-08-27 hf-review round-1 修复：摘录改为失败关闭脱敏且永不返回全文，扩展路径/直接命令检测，补齐 prompt-skill 冲突组、来源名 DTO/UI；3 个聚焦文件共 4 个测试与 `npx tsc --noEmit` 通过，T-04 未勾选。
- 2026-08-27 hf-review 剩余项修复：摘录窗口至少遮蔽半数 grapheme，短提示不再作为子串泄漏；冲突 finding id/dedup 纳入 boundary 并覆盖同源 write+execute 双组，3 个聚焦文件共 4 个测试与 `npx tsc --noEmit` 通过，T-04 仍未勾选。
- 2026-08-27 Standards round-3 修复：rule-insight projectId 改用严格 RESOURCE_ID/路径拒绝，前端以 `ruleInsightSchema.safeParse` 对畸形响应失败关闭；3 个聚焦文件共 5 个测试与 `npx tsc --noEmit` 通过，T-04 仍未勾选。
- 2026-08-27 T-04 / ship：独立 hf-code-review 通过（auto-approved）；聚焦绿、tsc、build 含 GET `/rule-insight`；全量 337 文件仅余 A-387，其余失败文件隔离复跑 25/25。演示 auto-approved。`CAP-IDC-03` 规则/注入只读检查已交付核心。不进入 S-45 族。
