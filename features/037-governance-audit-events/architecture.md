# 037 AUD-GOV 架构

模式与 030/035/036 完全一致，本片为模式第四根纵切（第五 source），不引入新架构元素。

## 边界与缝

- source owner: Governance（`src/adapters/outbound/sqlite/governance/approval-store.ts`，公开面 `GovernanceApprovalCommands`）。
- 新增 `src/adapters/outbound/sqlite/governance/audit-event-outbox.ts`：白名单集中的同事务 outbox 追加工具（镜像 035/036 同名文件形态）。
- 写入点（approval-store.ts 全部 11 个导出函数归入 5 类事件，见 spec 表）在同一事务内调用该工具；批量 expire 按调用点写一行（scope 区分 single/execution/project）。
- write-ownership manifest：`audit_event_outbox` 的 sharedAppendWriters 增加 governance 并登记 notes。
- consumer（operations-projection）零改动；`audit_event_projection.source` 无 CHECK 无需动。
- UI：`components/project-context/audit-panel.tsx` 增加治理域文案映射（兼作域分类器）与徽标类；定位链接锚定执行审查面规范路由。
- schema：`current-schema.ts` identity 22→23 + `audit_event_outbox.source` CHECK 加 `'governance'`；同波次更新所有 identity 断言、unsupported-schema 夹具 legacy 并集、rejection 套件 future identity 23→24。

## 关键流程

审批写入（safe-execution 服务 → GovernanceApprovalCommands → approval-store）→ 同事务 append outbox 行 → consumer 投影 → 项目作用域审计查询 API → 审计中心 UI（徽标/文案/摘要/定位）。

## 脱敏

payload 只含白名单枚举/计数字段；不含命令文本、脚本、diff、宿主路径。白名单键逐字段严格校验，畸形 fail-closed 不渲染 excerpt。
