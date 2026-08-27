# 规格 — 来源可追溯知识图谱

- 切片: 062 / S-31
- 主用户结果: Owner 在项目内查看有证据的记忆关系，并能跳回来源；无来源的推断不出现。
- 主 Capability: `CAP-KNW-03`
- 来源: `product/backlog.md` S-31、`product/architecture.md` Knowledge、`product/ui/UI设计.md` §9.2.4、`product/词汇表.md`

## 范围

### 包含

1. 只读图投影与 `GET /api/projects/:projectId/knowledge-graph`。
2. 边类型：`supersedes`、`collection`（共现）、已有 `source` 导航。
3. 记忆视图可访问列表替代；节点可跳到来源。

### 不包含

- 新 schema、推断边、跨项目图、Agent 署名提炼（S-32）。
- 把图当第二记忆库。

## 功能需求

- 项目隔离；未知项目 404；`no-store`。
- 每条边带 `kind` 与可导航 `href` 或诚实 `sourceMissing`。
- 列表与（可选）简图同一数据。

## 验收

1. supersedes 链出现在图中并可跳转。
2. 无来源推断不出现。
3. 他项项目隔离。
