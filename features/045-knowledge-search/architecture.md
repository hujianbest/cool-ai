# 架构 — 记忆检索

- 日期: 2026-08-15
- 对应规格: spec.md
- 用户确认: auto-approved 2026-08-15

## 对齐产品架构

落在 Knowledge & Provenance（`CAP-KNW-02`）。记忆事实仍唯一来自 `memory_entries`；检索是 Query Interface，不要求 operation/version/lease。不写入 Operations Projection 索引表（线程搜索那套留给协作；记忆索引生命周期是 S-29）。来源跳转复用已交付 `resolveMemorySource` / 面板 href，不新开 verified-handle 路径。

## 本片模块与缝

- `searchMemories(databasePath, projectId, options)` 加到 `KnowledgeProvenanceQueries`，实现于既有 memory-service。
- GET `app/api/projects/[projectId]/memories/search/route.ts` 严格 query DTO。
- `components/project-context/memory-panel.tsx` 检索 UI。

## 核心数据

无新表。过滤：`project_id`、active 派生（无 child supersedes）、content contains、可选 type/source_type/version。

## 关键流程

1. Owner 输入 q（及可选过滤）→ HTTP 校验 → `searchMemories` → 结果列表。
2. 点击命中 → 滚动既有 `#memory-{id}`；来源链接不变。
3. 被取代条目不出现在默认结果中。

## 横切偏离

无。查询失败关闭、脱敏 envelope。无新 ADR。
