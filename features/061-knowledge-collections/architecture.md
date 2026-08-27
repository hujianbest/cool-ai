# 架构 — 项目知识目录与集合

## 边界

Knowledge & Provenance 拥有集合表与命令。记忆正文仍只在 `memory_entries`。

```text
create/list/add/remove/delete collection
        │
        ▼
memory_collections + memory_collection_members
        │ FK memory_entries.chain_id（同项目）
        ▼
记忆视图目录 / 筛选
```

## 数据

schema identity 28→29。

### `memory_collections`

- `id`, `project_id`, `name`, `name_fold`, `version`, `created_at`, `updated_at`
- UNIQUE `(project_id, name_fold)`

### `memory_collection_members`

- `collection_id`, `chain_id`, `added_at`
- PK `(collection_id, chain_id)`
- 删除集合 CASCADE 成员行；不 CASCADE 到 `memory_entries`

## 协议

1. 所有写在 Knowledge 事务内，operation/version。
2. 跨项目 chain 拒绝。
3. GET 列表只读。

## 测试接缝

- 集合命令/查询
- API
- memory-panel 目录
