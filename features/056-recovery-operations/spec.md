# 规格 — 领域化运维命令与救援

- 切片: 056 / S-44
- 主用户结果: Owner 从明确 Execution 故障选择精确许可的救援动作、预览影响并执行或撤销可恢复步骤；任意命令与未知路径被拒绝。
- 主 Capability: `CAP-EXE-04`
- 来源: `product/backlog.md` S-44、`product/architecture.md` Safe Execution、`product/ui/UI设计.md` §9.4.5

## 范围

### 包含

1. 按 `status + reason_code` 冻结的救援目录（代码登记，非用户编写）。
2. 只读影响预览。
3. 严格 POST execute / undo（operation/version、确认词）。
4. Execution 卡片「救援」表面。
5. 既有 Approval 复用（高权限条目）；审计前后状态。

### 不包含

- 自由 shell、任意 executable、S-43 政策命令目录扩展。
- 新 Approval 域、跨项目救援、自动无人值守修复。
- 用量看板（S-36）或健康探测。

## 目录（首批）

| id | 适用 | 可撤销 | 审批 |
|---|---|---|---|
| `resume_queued` | `stale` / `STALE_EXECUTION` | 否 | 否 |
| `abandon_unverified` | `paused` / `SANDBOX_UNVERIFIABLE` | 否 | 是 |
| `resolve_merge_old` | merge `manual_recovery` | 否 | 是 |
| `resolve_merge_new` | merge `manual_recovery` | 否 | 是 |

未知 id 稳定拒绝。后续动作另开票，不在本片临时加码。

## 功能需求

- `GET .../executions/:id/recovery-actions` 返回适用目录 + 当前故障摘要。
- `POST .../recovery-actions/:actionId/preview` 返回结构化影响，不执行。
- `POST .../recovery-actions/:actionId/execute` 需 `operationId`、`expectedVersion`、确认词。
- `POST .../recovery-actions/:actionId/undo` 仅当目录声明可撤销。
- DTO 不含宿主路径、凭据、sandbox 根或原始异常。
- 文件类动作必须 verified-handle + sandbox（本片首批无文件写）。

## 验收

1. 无匹配故障时入口不出现或目录为空，不提供自由输入。
2. 目录外 id、陈旧 version、并发冲突失败关闭。
3. preview 不改变 Execution。
4. 执行后状态与审计可追溯；跨项目 404。
