# 规格 — 平等协作贡献视图

- 切片: 058 / S-37
- 主用户结果: Owner 按角色职责看到带上下文的工作项结果、复核质量与贡献证据，而不是无上下文的活跃度排行。
- 主 Capability: `CAP-OPS-03`
- 来源: `product/backlog.md` S-37、`product/architecture.md` Operations Projection、`product/ui/UI设计.md` §9.3.8、`product/词汇表.md`

## 范围

### 包含

1. 只读贡献投影与 `GET /api/contribution`。
2. 按项目成员 Agent 的角色职责分组：已完成/进行中工作项、复核通过/未通过（仅复核角色）、可导航证据。
3. 固定声明：不是排行榜；指标不改平等角色、派发或独立复核门槛。
4. `/team`「协作贡献」region；不新增图标轨项或 SETTINGS_SECTIONS id。
5. 项目作用域：合法 `projectId` 才投影；否则 unknown。

### 不包含

- 把用量/token/发言次数当成贡献分数（S-36 用量仍独立）。
- 改写 Agent 角色、派发租约、复核门槛或 Approval。
- 新 schema、outbox、排行榜、徽章竞赛或自动调权。
- 凭据、宿主路径、提示词、隐藏推理。

## 领域口径

- **贡献**：对已发生工作项结果与复核裁决的只读证据清单，按职责上下文展示。
- **不是**：活跃度竞赛、token 排行、完成率排名、可写绩效事实。
- 规划/实施看 Work Item 负责人结果；复核看 ReviewAttempt 裁决。缺失显示 0 + 空证据，不编造。

## 功能需求

### FR-1 聚合查询

`GET /api/contribution`

无项目：

```json
{
  "disclaimer": "not_ranking",
  "project": { "projectId": null, "detail": "需要打开项目" },
  "roles": []
}
```

有项目：`roles[]` 为项目成员，含 `agentId`、`name`、`role`、工作项计数、复核计数（非复核角色为 0）、最多 5 条证据（工作项或复核 id + 标题）。

- 可选 `projectId`；非法 400，未知项目 404。
- `no-store`；GET 无外部调用、无业务写。

### FR-2 指标不改权限

- 投影只读；不得调用派发/复核/Identity 写命令。
- UI 无「根据贡献调整权限」控件。

### FR-3 UI

- `/team` region「协作贡献」；声明「这不是排行榜」。
- loading / empty / error / success / focus；≥44px；亮/暗/窄屏与 axe。

## 错误

- `INVALID_INPUT`
- `PROJECT_NOT_FOUND`

## 验收

1. 无项目时不显示假排行。
2. 打开项目后按成员角色展示工作项/复核证据，他项隔离。
3. 用量数字不出现在贡献卡上当作分数。
4. GET 与 UI 不改角色、派发或复核门槛。
