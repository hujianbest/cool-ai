# 061 知识集合 code-review

- 范围: schema 29 `memory_collections` / `memory_collection_members`、命令、记忆视图目录
- 日期: 2026-08-21
- 评审人: 实现会话内 schema / 跨表写复核

## Standards

1. Knowledge 唯一写集合表；成员 FK CASCADE 集合行，不 CASCADE `memory_entries`。
2. 加入成员只存 `chain_id`，列表解析当前 head；他项记忆 404。
3. 删除确认后才 DELETE；取消不请求。
4. 判断项：集合变更尚未写 Knowledge 审计 outbox（规格有审计句）。T-05 不阻塞 ship；记后续加厚。不升严重。

## 结论

PASS（删除不删来源已测）。审计事件可在后续加厚。
