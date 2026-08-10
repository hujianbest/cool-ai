# 线程收藏与排序需求规格

- 日期: 2026-08-10
- 特性: 025-thread-favorites
- 对应切片: S-19（CI-2.7）
- 模式: 建造
- 用户可感知: 是
- 执行模式: auto（用户不在场，问题按助手推荐处理并记录假设）
- 共享理解来源: `product/backlog.md` S-19 条目（auto-approved 2026-08-10）
- 公共行为接缝: Thread Favorite Command/Query（Public Collaboration）；Thread List UI
- 主子系统: Public Collaboration；主 Capability: `CAP-COL-02`（本片建立其收藏与稳定排序部分）

## 问题陈述

线程列表目前只按既有顺序展示，owner 无法收藏关键线程或在独立视图稳定排序；高频线程淹没在列表中，重启后也没有任何收藏状态。

## 解决方案

线程列表项提供收藏/取消收藏动作（星标语义），收藏事实按 `(projectId, threadId)` 持久化（含收藏时刻）；独立"已收藏"视图按收藏时刻倒序稳定展示，普通列表保持现有顺序不变。所有写入幂等（重复收藏/取消不产生第二行或错误），跨 tuple 访问稳定 404。重启后收藏状态保持。

## 用户故事

1. **作为 owner，我想收藏/取消收藏线程，从而标记高优先讨论。**
   - 列表项有键盘可达的收藏切换控件（aria-pressed 语义），动作即时反馈且幂等。
   - 收藏操作失败（网络/冲突）时 UI 回滚乐观态并给出可感知错误。
2. **作为 owner，我想在独立视图按收藏顺序查看，从而快速回到关键线程。**
   - "已收藏"视图/过滤只列已收藏线程，按收藏时刻倒序（同刻按 threadId 稳定决胜）；取消收藏即从该视图消失。
   - 空收藏有 empty 状态；视图切换保留当前线程上下文，不重置消息区。
3. **作为 owner，我想重启后收藏保持，从而收藏是可信的长期状态。**
   - 收藏事实存于 canonical SQLite（非 localStorage），进程重启后一致。
   - 收藏/取消只影响本 tuple；审计上收藏写入可追溯（行内 created_at 足够，不另建事件表——与偏好类事实的最小审计一致）。

## 实现决策

- 新表 `thread_favorites`（`(project_id, thread_id)` 主键、`created_at`）；identity 13→14，fresh/exact 测试与引用同步。
- Commands：`setThreadFavorite(projectId, threadId, favorite: boolean)` 幂等 upsert/delete（version/operation 语义从简：收藏是幂等偏好类事实，不引入 operation/receipt——与草稿先例一致，记录假设）；Queries：`listThreads` 响应每项增加 `isFavorite`/`favoritedAt`（恒在），`listFavoriteThreads(projectId)` 或 listThreads 加 `favoritesOnly` 参数（择一，实现时选最少面扩张并在假设台账记录）。
- 排序：favorited_at DESC, thread_id ASC 稳定决胜；普通列表顺序完全不变。
- UI：列表项星标按钮（aria-pressed、可访问名称含线程名）、独立收藏视图入口复用现有线程区导航（抽屉/分段控件按现有组件形态）；tokens；44px。
- 错误稳定脱敏；tuple 校验一致。

## 测试决策

- TDD 每轮一个公共缝 RED + 最小 GREEN；内存库夹具。
- **Command/Query seam**：收藏/取消幂等、跨 tuple 404、列表投影 isFavorite/favoritedAt、收藏视图排序与决胜、普通列表不受影响。
- **UI seam（jsdom）**：切换控件状态与键盘、乐观更新与失败回滚、收藏视图过滤/排序/empty、重启恢复（经服务端 fake 重载）。
- **浏览器验收**：smoke:threads 增加收藏段：收藏→视图→取消→重启保持，desktop/narrow、light/dark、keyboard、axe。

## 范围外事项

- 手动拖拽排序、多维度排序选项、收藏分组/文件夹、收藏数量统计。
- 标签（S-18）与回收站（S-20）。

## 补充说明

- 单一用户结果，一个 Capability 内聚扩展，预计 3～4 张票。
- 评审按项目级 review 豁免跳过；默认选择记入 product/assumptions.md。
