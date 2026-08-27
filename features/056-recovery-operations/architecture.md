# 架构 — 领域化运维命令与救援

## 边界

- Safe Execution 拥有救援目录、execute/undo 与 Execution 状态迁移。
- Governance 只提供既有 Approval 消费，不新开域。
- Operations Projection 只读健康卡可深链到任务/Execution，不执行救援。
- UI 只消费公开 DTO。

```text
execution status + reason_code
        │
        ▼
frozen recovery catalog (Safe Execution)
        ├── GET actions
        ├── POST preview (read-only)
        └── POST execute/undo (operation/version, optional Approval)
```

## 数据

零新表优先：复用 `executions` version/status/reason_code、`execution_merge_journals`、既有 operation receipt。

若 execute receipt 无法安全落在现有 operation 表，再在本片补最小 `execution_recovery_operations` 并升 schema。默认先复用。

## 协议

1. 校验 project/execution tuple。
2. 目录过滤：只返回当前故障匹配的动作。
3. preview：计算影响 DTO，不写。
4. execute：确认词 + CAS version；需要 Approval 的条目必须有未消费匹配 Approval。
5. 失败关闭：不部分改文件；本片首批无文件写。

## 安全

- 无自由命令解析。
- SQL project-scoped。
- 错误脱敏。
- sandbox/verified-handle：首批无文件写，不继承 S-29 投影重建豁免到未来文件救援。

## 测试接缝

- Safe Execution public commands/queries。
- 严格 route。
- Execution 卡片救援 UI。
- `smoke:execution` 打开救援 → preview → 拒绝未知动作。
