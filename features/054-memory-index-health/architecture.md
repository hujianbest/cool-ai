# 架构 — 记忆索引状态与健康诊断

## 边界

- Knowledge & Provenance 继续唯一拥有 `memory_entries`、来源、版本和 supersedes 链。
- Operations Projection 拥有 `memory_search_index`、`memory_search_index_state` 与 rebuild operation receipt。
- 入站 API 只做传输校验与错误映射；React 只消费公开 DTO。
- S-28 `searchMemories` 保持 Knowledge 查询，不依赖投影可用性。

```text
memory_entries (Knowledge, source of truth)
        │ read-only scan
        ▼
memory-index consumer (Operations Projection)
        │ checkpoint + hash
        ▼
memory_search_index / memory_search_index_state
        │
        ├── GET health ──► Memory UI health strip
        └── confirmed rebuild command

S-28 search ─────────────► memory_entries (degrade path unchanged)
```

## 数据

schema identity 27→28。

### `memory_search_index`

- `project_id`, `memory_id`, `chain_id`, `memory_version`
- `memory_type`, `search_text`, `content_sha256`
- `source_created_at`, `indexed_at`
- 主键 `(project_id,memory_id)`；普通 SQLite 表，不使用 FTS5。

索引只能包含真实 `memory_entries`；project/chain/version/hash 必须匹配。重建后只保留 active heads。

### `memory_search_index_state`

- `project_id` 主键
- `status`: `idle | rebuilding | failed`
- `version`
- watermark: `source_created_at`, `source_memory_id`
- `last_error_code`, `updated_at`
- `active_count`, `valid_count`
- `operation_id`, `operation_hash`, `operation_result_json` 用于完成重放

不复用 `audit_projection_checkpoints.last_outbox_seq`：Memory 没有对应 outbox sequence，强行复用会制造错误语义。

## 协议

### Catch-up

1. 校验 Project。
2. 读取 state；`rebuilding` 时返回明确 freshness，不并发写。
3. 按 watermark 有界扫描不可变来源行，并重新计算受 supersedes 影响的 chain head。
4. 同事务 upsert/delete 索引、更新 watermark/version/count。
5. 健康查询另做全量轻量身份/hash 聚合，防止 watermark 正确但索引漂移。

### Rebuild

1. **acquire**：严格校验 confirmation、operation/hash、expectedVersion；CAS `idle/failed → rebuilding`。
2. **checkpoint**：按项目清空并批量扫描来源；每批只写投影，不持有外部资源。
3. **finalize**：重新计算 active heads 与 hash；只有完全一致才写 `idle`、新 version 与 receipt。
4. 崩溃/错误：下次 health 将遗留 `rebuilding` 显示为需要修复；不得自动重放。Owner 用新 operation 显式重试。

## 安全

- SQL 全部 project-scoped；API 先确认 Project 身份。
- 索引文本与来源 Memory 同一 SQLite 信任边界，不进入日志、错误或 health DTO。
- content hash 使用 SHA-256，仅做一致性，不作为授权或秘密安全证明。
- 重建不触碰宿主文件，不需要 verified-handle/sandbox；未来文件索引不继承本豁免。
- 强确认不是 Governance Approval；它只授权丢弃并重建可恢复投影。

## 测试接缝

- Operations Projection 公共 commands/queries。
- 严格 route DTO 与稳定错误。
- current schema / data invariant / write ownership。
- MemoryPanel 公共用户行为。
- browser smoke 打开图标轨「记忆」并完成 health→confirm rebuild→search。

## 取舍

- 不引入 Knowledge outbox：本片只需本地 immutable source scan；增加公开事件会扩大 source-owner 写面。
- 不切换检索：索引生命周期先可观测、可修复，后续专用检索切片再用真实性能证据决定读取路径。
- 不声称语义 recall：健康仅表示 active-head coverage 与内容一致性。
