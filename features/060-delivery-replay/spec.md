# 规格 — 本地只读交付回放

- 切片: 060 / S-40
- 主用户结果: Owner 打开某次协作运行的不可变只读回放，按时间查看公开事件并跳回来源；刷新后顺序一致。
- 主 Capability: `CAP-OPS-04`
- 来源: `product/backlog.md` S-40、`product/architecture.md` Operations Projection、`product/ui/UI设计.md` §9.2.6、`product/词汇表.md`

## 范围

### 包含

1. 只读回放投影与 `GET /api/projects/:projectId/replay?runId=`。
2. 条目来自已投影时间轴公开事件（按 `payload.runId` / `payload.executionId` 收窄），顺序冻结。
3. `formatVersion`、`replayHash`、范围说明。
4. 审计时间轴「打开回放」；可跳转既有来源入口。

### 不包含

- 重放命令、工具、Provider 调用或 Approval（A-428）。
- 挂载复核工作台（A-387 / A-426）。
- 新 schema、outbox、补造缺失事件。
- 修改 `smoke:execution` P1 IA（A-412）。

## 功能需求

### FR-1 查询

```json
{
  "formatVersion": 1,
  "scope": { "projectId": "p", "runId": "r", "detail": "只读回放" },
  "replayHash": "64-char hex",
  "items": []
}
```

- `runId` 必填；非法 400；未知项目 404；未知运行空 items + 诚实 detail，不补造。
- `no-store`；GET 无外部调用、无业务写。

### FR-2 UI

- 时间轴项「打开回放」；无 run 身份时 disabled。
- 回放列表只读；来源链接复用审计面板既有 href。

## 验收

1. 同一 runId 两次 GET 的 items 顺序与 replayHash 一致。
2. 不出现未在时间轴存在的事件。
3. 不触发执行或协作写。
