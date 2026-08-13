# 037 AUD-GOV 进度

- 2026-08-12 特性立项（项目级 review 豁免，AGENTS.md 当前阶段条款）：S-23 第四根 source-owner 纵切，建立 `CAP-GOV-03`；事件选型 5 类（approval_requested/approved/rejected/expired/consumed），actor 恒为 owner；命令文本/脚本/diff/宿主路径不入列；模式对齐 030/035/036。下一步：T-01 委派实现 subagent（RED→GREEN）。
- 2026-08-13 T-01 完成（项目级 review 豁免）：schema identity 22→23，`audit_event_outbox.source` CHECK 加 `'governance'`；新增 `governance/audit-event-outbox.ts` 白名单工具；approval-store 11 个写入点全接线（5 类事件，批量 expire 按调用点一行，verdict/expire/consume 以 `changes>0` 门控）；payload 白名单 `approvalId, decision, executionId, kind, riskLevel, scope`（riskLevel 预留，今日 DTO 不产生）；同波次迁移 identity 断言与夹具；write-ownership manifest sharedAppendWriters 加 governance。验证：新聚焦套件 9 例 + 聚焦 111 文件 1224 测试通过 + tsc 零错误。下一步：T-02。
