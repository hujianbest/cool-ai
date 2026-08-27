# 062 知识图谱 code-review

- 范围: `getKnowledgeGraph`、`GET /api/projects/:projectId/knowledge-graph`、记忆视图「关系列表」
- 日期: 2026-08-21
- 评审人: 实现会话内只读投影 / 证据边复核

## Standards

1. 零 schema。GET 只读，不写 `memory_entries`、集合表、outbox 或工作区。
2. 边只来自 `supersedes_id` 与同集合成员当前 head 共现；缺节点边不投影为可导航关系。
3. 未知项目 404；额外查询键 400；`no-store`。
4. 判断项：DTO 未单独带 `href`/`sourceMissing` 字段，列表用两端节点是否存在作为可导航证据，定位走记忆卡片。不升严重。

## Spec

1. 项目隔离。他项记忆不出现在节点或边上。
2. 列表为主路径（A-433）；不把简图当主交互。

## 结论

PASS。无跨 owner 写、无推断边当事实。
