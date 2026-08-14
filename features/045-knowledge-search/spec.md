# 规格 — 项目知识动态与记忆检索

- 特性: 045-knowledge-search（S-28）
- 用户确认: auto-approved 2026-08-15
- 评审: spec/architecture 豁免；轻量级零 schema，implement 后 hf-code-review 豁免

## Problem

Owner 只能在共享记忆列表里人工翻条目。无法按正文、类型、来源或版本检索当前项目记忆，也无法从检索结果定位精确证据。被替代记忆若与当前版本混在一起会造成误导。

## Solution

在 Knowledge & Provenance 上增加项目隔离的记忆检索查询：对已落库 `memory_entries` 做 contains 匹配与类型/来源/版本过滤，默认只返回 active（链头）记忆。共享记忆面板增加检索入口；结果带 snippet，可跳到既有记忆卡片与来源链接。不新建索引表或第二事实源。

## User Stories

1. As owner, I want to search current-project memories by content, type, source type, and version so I can find evidence quickly.
2. As owner, I want results to exclude superseded memories by default so I am not misled by replaced facts.
3. As owner, I want to jump from a hit to the memory card and existing source href so evidence stays frozen and project-scoped.

## Decisions

- 零 schema（identity 保持 25）。检索直接读 `memory_entries`，不建 `memory_search_index`（A-312、A-319）。
- 匹配：`instr(lower(content), lower(q))` ASCII 折叠 contains；转义不走 LIKE 通配（A-314）。
- 默认仅 active（无 superseding child）。不提供 search 的 includeInactive（A-313）。
- GET `/api/projects/:projectId/memories/search`：必填 `q`（trim 后 ≥1 grapheme，≤200）；可选 `type`、`sourceType`、`version`（正整数）、`limit`（默认 20，最大 50）。未知 query key 拒绝。跨项目 404。
- 结果：`{ results: [{ memory, snippet }] }`，按 `created_at DESC, id ASC`。snippet 命中前后各约 60 grapheme。不落查询日志、不回宿主路径或凭据。
- UI：共享记忆 tab 检索框 + 类型/来源/版本过滤；region「知识动态」或检索结果列表；点击滚动到 `#memory-{id}`；来源继续用既有 href（A-316）。
- 浏览器：`smoke:context` 在既有 5 条记忆上搜唯一正文，断言命中、不出现被取代条目、可定位卡片；不新开 Agent 执行（A-317）。

## Testing

- 公共缝：`searchMemories` + GET search + memory-panel jsdom + smoke:context。
- RED/GREEN 每票一个行为失败测试。内存库夹具。禁止每票全量 vitest。

## Out of Scope

FTS5 虚表、索引 checkpoint/健康/重建（S-29）、集合/图谱（S-30/S-31）、Agent 提炼发布（S-32）、跨项目搜索、查询审计 outbox。
