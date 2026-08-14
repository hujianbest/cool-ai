# 037 AUD-GOV 进度

- 特性: 037-governance-audit-events（对应切片: S-53 / S-23 的 AUD-GOV 纵切）
- 当前阶段: done
- 执行模式: auto
- 已加载扩展: 无
- 下一步: 等待父会话提交；S-23 仍待 AUD-RUN 与 AUD-UI
- 用户可感知: 是；演示验收 auto-approved 2026-08-15
- 评审状态: 项目级 review 豁免（AGENTS.md 当前阶段条款）；未伪造评审工件

## 实施记录

- 2026-08-12 特性立项（项目级 review 豁免）：S-23 Governance source-owner 纵切，建立 `CAP-GOV-03`；选定 approval_requested/approved/rejected/expired/consumed 五类状态事实，actor 恒为 owner，敏感内容与内部噪声不入列。
- 2026-08-13 T-01 完成（项目级 review 豁免）：schema identity 22→23，`audit_event_outbox.source` CHECK 加 `'governance'`；新增治理 outbox 白名单工具；approval-store 11 个写入点同事务接线五类事件；同波次迁移 identity 断言/夹具与 write-ownership manifest。验证：新聚焦套件 9 例 + 聚焦 111 文件 1224 测试 + tsc 全绿。
- 2026-08-14～2026-08-15 因 038/S-54、039/S-55、040/S-56 连续交付暂停；这些切片 ship 后按用户 auto 指示恢复。
- 2026-08-15 T-02 完成（项目级 review 豁免）：审计面板增加治理域五类文案；`approval_requested` 以 payload `attemptNo` 区分 Safe Execution 与 Governance；治理徽标使用裸 `.status-label`；摘要只呈现 kind/decision/scope；定位使用规范 approval 身份路由，并限制旧「定位来源执行」按钮只属于执行域。验证：audit-panel 24 例、project-context 回归 93 例与 tsc 全绿；记录 A-290/A-291。
- 2026-08-15 T-03 完成并 ship（项目级 review 豁免）：落点 `npm run smoke:execution`（A-292），复用 029 的真实命令审批路径产生 requested/approved/consumed/expired 四类治理事实；该 runner 唯一拒绝事实是 Public Collaboration 的 inline proposal，不伪装成治理 rejection，故 `approval_rejected` 继续由 T-01 `governance-audit-outbox.test.ts` 证明，smoke 对未来出现的治理 rejection 保留条件呈现断言。验收覆盖 cursor-complete API、governance/source 与 project 作用域 outbox==projection==API、checkpoint==maxSeq、foreign 404、第二项目 approvalId 隔离、桌面明暗/窄屏治理文案/中性徽标/摘要/规范定位/44px、axe 3 态 0 serious/critical、API/DOM/截图秘密扫描零泄漏；日志 `GOVERNANCE AUDIT ACCEPTANCE PASS: assertions=31 axeStates=3`，wall clock 95.7s；证据目录 `features/037-governance-audit-events/evidence/`。同时修复 028 验收的两处现实回归：execution 定位只匹配 payload `attemptNo` 行；home direct project 存在后 outbox/projection 一致性改按当前项目计数（A-293）。
- 2026-08-15 最终门禁：`npx tsc --noEmit` 6.7s；`npx vitest run` 284 文件 / 2602 测试全绿，Vitest duration 127.32s（wall 130.1s）；`npm run build` 全绿，46.9s。T-01～T-03 全部勾选；`CAP-GOV-03` 更新为已交付核心；S-23 因 AUD-RUN 与 AUD-UI 尚未交付保持未勾选。演示 auto-approved 2026-08-15；commit 由父会话统一执行，本任务不 push。
