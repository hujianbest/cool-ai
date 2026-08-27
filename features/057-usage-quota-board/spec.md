# 规格 — 用量与配额看板

- 切片: 057 / S-36
- 主用户结果: Owner 在 `/team` 按项目、协作运行与 Provider 查看基础用量、预算与轮次边界；估算显式标注，不会被当成账单。
- 主 Capability: `CAP-OPS-03`
- 来源: `product/backlog.md` S-36、`product/architecture.md` Operations Projection、`product/ui/UI设计.md` §9.3.7、`product/词汇表.md`

## 范围

### 包含

1. 只读用量/配额投影与 `GET /api/usage`。
2. 项目合计、协作运行（轮次边界）、Provider 分解。
3. 仅合计已报告、算术一致的 token；未报告与 `usage_invalid` 单独计数，不伪造数字。
4. `/team`「用量与配额」region：估算不是账单的固定声明；预算变更深链既有 Agent 配置。
5. 项目作用域：提供合法 `projectId` 才投影项目数字；否则 unknown / 空列表。

### 不包含

- 贡献视图（S-37）、完整计费、配额结算、商业订阅、Provider 账户余额。
- 新的预算写命令、新 Approval 域、新 schema、outbox 或回写 Identity / Collaboration / Execution。
- 对 Provider 做实时探测、拉取账单或补全缺失 usage。
- 凭据、宿主路径、提示词、隐藏推理或原始异常。

## 领域口径

- **用量**：对 Collaboration / Execution / Review 模型调用表中**已报告且合法** token 的只读合计。缺失或不一致不得补数（A-43）。
- **配额**：Identity 已配置的 `max_tokens` / `max_handoffs`，以及已发布的协作轮次上限（50）与执行业务轮次/工具上限（20 / 40）。本片只投影，不改配置。
- **估算标识**：对照上限的剩余或占比必须带 `not_invoice`；文案「基础用量不是账单」。
- **Run**：产品词协作运行（Collaboration Run）。Execution 用量按 `source_collaboration_run_id` 归入该运行。复核调用归项目与 Provider，不虚构运行归属。
- **Provider**：只暴露 `id` + 显示名，不含 URL、掩码以外的账户信息。

## 功能需求

### FR-1 聚合查询

`GET /api/usage`

```json
{
  "disclaimer": "not_invoice",
  "project": {
    "projectId": null,
    "detail": "需要打开项目",
    "totals": {
      "promptTokens": 0,
      "completionTokens": 0,
      "totalTokens": 0,
      "unreportedCalls": 0,
      "invalidCalls": 0
    }
  },
  "runs": [],
  "providers": [],
  "budgets": []
}
```

有项目时：

- `project.projectId` 为该项目；`detail` 为 null（无已报告用量时仍可为「尚无已报告用量」）。
- `runs[]`：该项目协作运行的 `id`、`roundCount`、`roundLimit`、已报告 totals。
- `providers[]`：`id`、`name`、已报告 totals（按 Agent / ReviewAttempt 的 Provider 归属）。
- `budgets[]`：项目成员 Agent 的 `maxTokens`、`maxHandoffs` 与该 Agent 已报告 `usedTokens`。

- 可选查询 `projectId`；非法值 400，未知项目 404。
- 响应 `no-store`；不含凭据、正文、路径、异常栈。
- GET 不得发起 Provider HTTP、进程或业务写。

### FR-2 不伪造用量、不伪装账单

- 只把 `prompt+completion=total` 且均为非负整数的调用计入 totals。
- 空 usage → `unreportedCalls`；`usage_invalid` 或算术不一致 → `invalidCalls`。
- 不得用平均值、上次调用或 Provider 价目表填 token。
- DTO 恒含 `disclaimer: "not_invoice"`；UI 可见声明「基础用量不是账单」。

### FR-3 UI

- `/team` 独立 region「用量与配额」，不新增 `SETTINGS_SECTIONS` id，不新增图标轨项。
- 项目卡、运行列表、Provider 列表；每处估算对照上限时标注不是账单。
- 预算变更入口深链既有 Agent 编排（§9.3.2），本片不提交预算写。
- 覆盖 loading / empty / error / disabled / success / focus；控件 ≥44px；亮/暗/窄屏与 axe。

## 错误

- `INVALID_INPUT`
- `PROJECT_NOT_FOUND`

## 验收

1. 未带 projectId 时项目卡为 unknown，runs/providers/budgets 为空，不显示假合计。
2. 打开项目后按项目隔离；他项调用不进入本项 totals。
3. 缺失/非法 usage 不增加 token 合计，并出现在 unreported/invalid 计数。
4. 响应与 UI 含「不是账单」标识；不含密钥、路径、Memory 正文或原始异常。
5. GET 不产生外部调用或业务写；不提供预算变更 API。
