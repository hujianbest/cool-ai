# 架构 — 线程搜索与精确定位

- 日期: 2026-08-10
- 对应规格: [`spec.md`](./spec.md)
- 状态: 项目级 review 豁免生效；未送独立评审，不伪造工件

## 架构目标

第二种投影（搜索索引）复用 028 consumer 协议（checkpoint/catchUp/rebuild/freshness）；证明基座可承载非审计投影；复杂性（分词/索引/snippet）留在 Adapter。

## Module 与 Interface

- Operations Projection 扩展：
  - Commands：`catchUpThreadSearchIndex`、`rebuildThreadSearchIndex`（复用 checkpoints 表，consumer_id 独立；协议同 028）。
  - Queries：`searchProjectThreads(databasePath, projectId, {query, limit?, before?})` → 结果项（threadId、threadTitle、messageId|null、kind、snippet、occurredAt）+ nextCursor；tuple 404；读路径先 catchUp。
- schema：`thread_search_index`（identity 16→17）+ 可选 FTS5 虚表（勘察 node:sqlite 能力后定；LIKE 备选）。索引内容=线程标题 + 消息公开正文。
- 定位链路：URL `?thread=..&message=..`（parseProjectSelection 扩展）→ collaboration 面板消费 message 参数调用 022 定位缝（messageRefs/jumpToMessage）；URL 无 message 时行为不变。

## 关键流程

1. 协作事件落 outbox（030 已交付）→ search consumer catchUp → 消息事件回查 collaboration_messages 正文 → upsert 索引。
2. owner 搜索 → catchUp → 查询索引 → 结果列表。
3. 点击结果 → URL 深层链接 → 面板滚动定位消息。

## Seam 与测试点

- Seam 1 — search consumer：tests/modules/operations-projection/ 新文件。
- Seam 2 — search query + 路由：tests/modules/operations-projection/ + api 测试。
- Seam 3 — 搜索 UI + 消息定位 URL 入口：tests/browser/threads|collaboration 扩展。
- Seam 4 — smoke:threads 验收段。

## 横切约定

- 幂等/确定性/fail-closed 继承基座；tuple 强约束；tokens/44px/键盘/全态；查询不落日志。

## ADR 链接

- 遵守 ADR-0003；FTS5 vs LIKE 决策记 progress（可逆，schema 由 canonical 唯一版本承载）。
