# 架构 — 线程收藏与排序

- 日期: 2026-08-10
- 对应规格: [`spec.md`](./spec.md)
- 状态: 项目级 review 豁免生效；未送独立评审，不伪造工件

## 架构目标

在 Public Collaboration 线程目录上加最小收藏事实；复杂性留在 SQLite Adapter；UI 只消费列表投影扩展。

## Module 与 Interface

- Commands：`setThreadFavorite(projectId, threadId, favorite)` 幂等；跨 tuple 404。
- Queries：`listThreads` 项扩展 `isFavorite: boolean`、`favoritedAt: string | null`；收藏视图查询参数（如 `favorites: true`）返回 favorited_at DESC, thread_id ASC。
- schema：`thread_favorites(project_id, thread_id, created_at)`，PK `(project_id, thread_id)`，FK 到 threads；identity 13→14。
- 不变量：favorites 行 tuple 合法（目标 thread 存在）——由 FK + reopen 检查覆盖；如发现缺口在实现票内补 invariant。

## 关键流程

1. 列表项星标 → setThreadFavorite(true) → 列表投影即时反映；失败回滚乐观态。
2. 收藏视图 → listThreads(favorites) → 稳定排序；取消即从视图消失。
3. 重启 → 事实在 canonical DB，列表与视图一致。

## Seam 与测试点

- Seam 1 — Favorite Command/Query：tests/modules/public-collaboration/thread-favorite*.test.ts（新）。
- Seam 2 — Thread List UI：tests/browser/threads/ 或 collaboration 现位套件扩展。
- Seam 3 — smoke:threads 验收段。

## 横切约定

- tokens/键盘/44px/aria-pressed；empty/loading/error/focus 全态；错误脱敏；无第二状态机。

## ADR 链接

- 遵守 ADR-0003；无新增难逆转决定。
