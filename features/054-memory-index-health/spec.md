# 规格 — 记忆索引状态与健康诊断

- 切片: 054 / S-29
- 主用户结果: Owner 在项目「记忆」视图看到索引是否完整、陈旧或重建中，并能强确认安全重建；诊断异常时仍可访问和检索来源记忆。
- 主 Capability: `CAP-OPS-03`
- 来源: `product/backlog.md` S-29、`product/architecture.md` Operations Projection、`product/ui/UI设计.md` §9.2.4

## 范围

### 包含

1. 项目隔离的可重建 `memory_search_index`。
2. 独立 checkpoint/state：watermark、状态、版本、最后稳定错误码和更新时间。
3. active memory chain head 的覆盖率与内容 hash 一致性诊断。
4. 严格 GET health 与强确认 POST rebuild API。
5. 「记忆」治理视图中的健康条、降级说明和重建确认。
6. 重建 operation/version 幂等与并发失败关闭。

### 不包含

- FTS5、向量检索、embedding、语义召回率或相关性评分。
- 把 S-28 检索切换到新索引。
- 文件索引、任意宿主路径、sandbox 修复任务。
- 新的 Approval Center domain 或自动无人值守修复。
- Knowledge 来源事实回写、删除或自动 supersede。

## 领域口径

- **来源记忆**：Knowledge & Provenance 拥有的不可变 `memory_entries`。
- **记忆搜索索引**：Operations Projection 拥有、可丢弃重建的读模型。
- **active head**：不存在后继 superseding entry 的当前链头。
- **覆盖率**：索引中与 active head 身份及内容 hash 一致的行数 / active head 总数；总数为 0 时为 1。
- **健康**：`caught_up` 且覆盖率为 1、无稳定失败。
- **降级**：`behind`、`rebuilding`、`failed` 或覆盖/hash 不完整；canonical list/search 继续直查来源记忆。

## 功能需求

### FR-1 增量 catch-up

- 只读取 `memory_entries`，按稳定 `(created_at,id)` watermark 补齐或替换索引行。
- 索引行必须保留 project/memory/chain/version/type/content hash 与搜索文本。
- checkpoint 与批次写入同事务；重复执行幂等。
- 不得写 `memory_entries` 或把索引缺失解释为来源不存在。

### FR-2 重建

- 请求必须包含 `operationId`、`expectedVersion` 与精确确认词。
- acquire 以 CAS 将项目 state 置为 `rebuilding`；并发或陈旧版本稳定冲突。
- 在短事务中清理该项目索引并由来源记忆重建；finalize 仅在覆盖/hash 后置条件成立时置 `caught_up`。
- 失败保留来源记忆，state 置 `failed` 与稳定脱敏错误码；不得持久化原始异常。
- 同 operation + 同 hash 重放同一 receipt；同 operation + 不同 hash 冲突。

### FR-3 健康查询

`GET /api/projects/:projectId/memory-index/health`

```json
{
  "projectId": "project-id",
  "status": "caught_up",
  "version": 3,
  "freshness": { "status": "caught_up", "pending": 0 },
  "coverage": { "active": 12, "indexed": 12, "valid": 12, "ratio": 1 },
  "lastErrorCode": null,
  "updatedAt": "2026-08-19T00:00:00.000Z",
  "searchMode": "source_fallback"
}
```

- 项目不存在返回 404；路径/查询严格校验，响应 `no-store`。
- 查询可做有界 catch-up；`rebuilding` 不伪造成 caught-up。
- DTO 不含原始 Memory 正文、宿主路径、凭据或内部异常。

### FR-4 重建 API

`POST /api/projects/:projectId/memory-index/rebuild`

```json
{
  "operationId": "uuid",
  "expectedVersion": 3,
  "confirmation": "重建记忆索引"
}
```

- Content-Type、正文大小与严格 shape 校验。
- 成功返回新 health + receipt；并发、陈旧版本、确认词错误稳定失败。
- 重建只影响可恢复投影，不删除或修改来源记忆。

### FR-5 UI

- 健康条展示：已追平 / 落后 N 条 / 重建中 / 需要修复，以及 `有效/active` 覆盖。
- 降级时显示「来源记忆与检索仍可用」，不得显示数据已丢失。
- 「重建索引」打开强确认对话框，默认焦点在取消；确认期间禁用重复提交。
- 覆盖 loading / empty / error / disabled / success / focus；控件 ≥44px；亮/暗/窄屏与 axe 验收。

## 错误

- `PROJECT_NOT_FOUND`
- `MEMORY_INDEX_VERSION_CONFLICT`
- `MEMORY_INDEX_REBUILD_IN_PROGRESS`
- `MEMORY_INDEX_CONFIRMATION_REQUIRED`
- `MEMORY_INDEX_REBUILD_INCOMPLETE`
- `MEMORY_INDEX_CHECKPOINT_CORRUPT`
- `MEMORY_INDEX_UNAVAILABLE`

所有公共错误使用稳定、脱敏 envelope。

## 验收

1. 新项目无记忆显示健康空索引，不显示错误。
2. 新增/supersede Memory 后 health 显示 behind，catch-up 后覆盖率为 100%。
3. 篡改或缺失索引行显示 degraded；来源列表与 S-28 搜索仍可用。
4. 未确认、陈旧版本、并发重建均失败关闭。
5. 重建后只保留 active heads，hash 一致，重放不重复动作。
6. 跨项目不可见；响应与持久错误不泄漏正文、路径、凭据或异常。
