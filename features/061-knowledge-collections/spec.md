# 规格 — 项目知识目录与集合

- 切片: 061 / S-30
- 主用户结果: Owner 在当前项目创建集合、把记忆移入/移出并查看目录；删除集合不删除来源记忆。
- 主 Capability: `CAP-KNW-03`
- 来源: `product/backlog.md` S-30、`product/architecture.md` Knowledge、`product/ui/UI设计.md` §9.2.4、`product/词汇表.md`

## 范围

### 包含

1. `memory_collections` / `memory_collection_members`（schema 28→29）。
2. 创建集合、加入/移出当前项目记忆、列出目录。
3. 删除集合：确认后只删成员关系与集合行，不删 `memory_entries`。
4. 记忆视图集合筛选与目录。

### 不包含

- 跨项目集合、图谱（S-31）、Agent 署名提炼（S-32）。
- 把集合当第二记忆库或复制正文。
- 新 Approval 域（A-431）。

## 功能需求

- 集合 `name` 1..80 字、项目内唯一（大小写折叠）。
- 成员指向现存 `memory_entries` 的 `chain_id` 当前 head；未知记忆 404。
- 删除须确认；取消不写。
- 变更写 Knowledge owner 审计事件（集合创建/成员变更/删除）。

## 验收

1. 创建集合并加入记忆后，目录可见。
2. 删除集合后记忆仍在检索中。
3. 他项项目隔离。
