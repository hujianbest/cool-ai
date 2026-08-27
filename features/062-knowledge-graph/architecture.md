# 架构 — 来源可追溯知识图谱

## 边界

Knowledge 只读投影。不写 `memory_entries`。

```text
memory_entries + memory_collection_members
        │
        ▼
GET /api/projects/:id/knowledge-graph
        │
        ▼
记忆视图「关系列表」
```

## 数据

零 schema（A-432）。节点为当前项目 active/head 记忆；边来自 supersedes_id 与集合成员共现。

## 测试接缝

- `getKnowledgeGraph`
- GET 路由
- memory-panel 列表
