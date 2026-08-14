# 041 AUD-RUN 架构

模式与 030/035/036/037 一致，本片为第五根 source-owner 纵切。非轻量级：schema + 共享 outbox。

## 边界与缝

- source owner: Runtime。新增 `src/adapters/outbound/sqlite/runtime/audit-event-outbox.ts`（白名单同事务追加）。
- HTTP 唯一出口仍是 `callOpenAiChat`。outbox 不在无 DB 的 HTTP 客户端内写，而在各领域 orchestrator 于同一事务提交 `*_model_calls` 成败之后调用追加工具（保持「业务写与 outbox 同事务」）。
- 已知接线点（勘察后可增、不得漏）：
  - `safe-execution/execution-structured-repair.ts` 与 `action-orchestrator.ts` 的 structured execution action
  - `review-delivery/review-orchestrator.ts`、`review-slice-service.ts`、`review-structured-repair.ts`
  - `public-collaboration/internal/structured-repair.ts` 以及主协作 turn 中实际调用 `callOpenAiChat` 的提交点（若主 turn 走同一 structured 路径则只接一处）
- write-ownership：`sharedAppendWriters.audit_event_outbox` 增加 `runtime`；notes 声明不夺取 `*_model_calls` 所有权。
- consumer 零改动。
- UI：`audit-panel.tsx` 增加 `RUNTIME_EVENT_TYPE_COPY` 兼分类器；徽标复用裸 `.status-label`（queued/running/completed/bare 已占用），文案「运行时」。
- schema：identity 23→24；source CHECK 加 `'runtime'`；同波次全部 identity 断言/夹具。

## 定位

payload 严格校验后：

- surface=execution + executionId → `/projects/{projectId}/executions/{executionId}`
- surface=review + 可校验 review/attempt id → `/projects/{projectId}/reviews/{id}`（或既有 catch-all 形态）
- surface=collaboration + threadId/runId → `/projects/{projectId}?thread=&run=`
- 畸形不渲染

## 脱敏

禁止 baseUrl、apiKey、message 正文、provider 响应进入 payload。`model` 经 grapheme 200 + 凭据分类缝；失败只留公开 `errorCategory`。
