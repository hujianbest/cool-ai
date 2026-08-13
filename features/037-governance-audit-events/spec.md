# 037 AUD-GOV 规格

## 目标

Governance 域（execution_approvals 事实）作为第五个审计 source owner 接入统一审计投影：所有 Approval 生命周期写入点在同事务内向 `audit_event_outbox` 追加脱敏事件，owner 在审计中心可查询、识别并导航。

## 事件选型（状态事实入列，内容与噪声不入列）

入列（5 类，actor 恒为 owner，单 owner 驾驶舱内系统动作均代表 owner）：

| eventType | 写入点 | payload 白名单 |
| --- | --- | --- |
| `approval_requested` | insertCommandApprovalRequest / insertStagedMergeApprovalRequest | `kind`（command/staged_merge）、`riskLevel`（若 DTO 携带） |
| `approval_approved` | recordApprovalVerdict（approved 分支） | `kind`、`decision` |
| `approval_rejected` | recordApprovalVerdict（rejected 分支） | `kind`、`decision` |
| `approval_expired` | expireOpenApprovalById / expireApprovedApprovalById / expireOpenApprovalsForExecution(At) / expireOpenApprovalsForProjectExecution | `kind`、`scope`（single/execution/project） |
| `approval_consumed` | consumeApprovedApprovalById / consumeStagedMergeApproval | `kind` |

不入列：命令文本/参数全文、脚本内容、diff、宿主路径、provider 响应、隐藏推理（凭据与内容零泄漏纪律）；审批卡 UI 的只读浏览；expire 批量循环的逐行噪声（按调用点一行，scope 标注）。

## 约束

- schema identity 22→23；`audit_event_outbox.source` CHECK 加 `'governance'`；同波次迁移全部 identity 断言/夹具/manifest（A-237 纪律）。
- outbox 写入必须与领域写入同事务；payload 仅白名单键，经 grapheme 截断（200）与既有凭据分类缝；畸形输入 fail-closed。
- consumer 协议零改动；projection/API/UI 复用既有缝。
- 审计 UI：域徽标复用既有 status 语义类或裸 `.status-label` 中性基类（不新增视觉语言）；文案映射集中并兼作域分类器；定位=规范身份路由（执行审查面），畸形 payload 不渲染链接。
- 验收：smoke 段覆盖 API（五类齐备、单页、outbox==projection==API、foreign 404/跨项目隔离）+ 桌面明暗 UI + 窄屏 + axe 0 serious/critical + 秘密扫描零泄漏。
