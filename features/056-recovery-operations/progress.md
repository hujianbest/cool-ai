# 进度

- 特性: 056-recovery-operations
- 对应切片: S-44
- 当前阶段: done
- 执行模式: auto
- 已加载扩展: 无
- 下一步: 无（已 ship）；产品下一片为 S-36 用量与配额看板。

## 状态记录

- 2026-08-21 055/S-35 ship 后 S-44 健康阻塞解除。准入 `CAP-EXE-01/03`、`CAP-REV-01`、`CAP-OPS-03`、`CAP-GOV-01` 部分可用。
- 默认边界 A-406～A-411：代码冻结目录；首批无文件写；复用既有 Approval 与 Execution version；任务治理挂载 ExecutionPanel。
- 2026-08-21 T-01 完成：有效 RED 证明目录缺失；`recoveryActionsFor` / `listRecoveryActions` 按 status+reason_code 返回冻结条目，未知故障空目录，未知项目失败关闭。开始 T-02。
- 2026-08-21 T-02 完成：`previewRecoveryAction` 对已知动作返回不写文件的影响，未知 id 失败关闭。开始 T-03。
- 2026-08-21 T-03 完成：execute/undo 需确认词与 operation/version CAS；未知动作、跨项目、审批缺失与不可撤销 undo 失败关闭；复用 `execution_operations.kind=recover`。开始 T-04。
- 2026-08-21 T-04 完成：Execution 卡片「救援」按冻结目录打开 UCD §9.4.5 dialog；预览后执行；撤销 disabled；未知故障无入口。开始 T-05。
- 2026-08-21 T-05 ship：冻结目录 + preview/execute/undo API + 任务视图 Execution 卡片救援。写路径走 confirmation/CAS，高权限经 governance `consumeApprovedApprovalById`，首批不写文件、无自由命令。`tsc`/`build` 绿；jsdom 救援 UI；`smoke:execution` 记 A-412（P1 IA + 既有 color-contrast）。演示 auto-approved。安全复核：无自由命令解析、SQL project-scoped、错误脱敏、Approval 不跨 owner 直写。
