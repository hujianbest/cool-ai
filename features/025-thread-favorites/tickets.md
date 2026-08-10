# 任务票 — 线程收藏与排序

- 状态: 项目级 review 豁免生效，直接进入 implement
- 规模: 3 张纵向 RED/GREEN 票；单一"收藏并稳定回到关键线程"用户结果
- 公共缝: Thread Favorite Command/Query、Thread List UI
- TDD: 每票先一个公共行为 RED，再最小 GREEN；内存库夹具；新树测试路径

- [x] T-01 收藏命令与列表投影 — Blocked by: None
  - 公共缝: Thread Favorite Command/Query。
  - RED: 收藏命令不存在；列表项无 isFavorite/favoritedAt；收藏视图查询缺失；跨 tuple 未 404。
  - GREEN: `thread_favorites` 表（identity 13→14，同步全部引用与 write-ownership manifest）；`setThreadFavorite` 幂等 upsert/delete；`listThreads` 恒在投影 + 收藏过滤参数（favorited_at DESC, thread_id ASC）；装配与路由（POST/DELETE 或 PUT 单端点，实现时选最少面并记录）。
  - 验证: 幂等矩阵、跨 tuple 404、排序与决胜、普通列表顺序不变、reopen 幂等。
  - 命令: 聚焦新 thread-favorite 套件 + schema 套件 + thread 列表套件；`npx tsc --noEmit`

- [x] T-02 列表星标与收藏视图 UI — Blocked by: T-01
  - 公共缝: Thread List UI（jsdom）。
  - RED: 无收藏控件/视图；失败无回滚；empty 缺失。
  - GREEN: 列表项星标按钮（aria-pressed、可访问名称含线程名、44px、键盘）；乐观更新+失败回滚+可感知错误；收藏视图（过滤/稳定排序/empty 态）；视图切换不重置当前线程上下文。
  - 验证: loading/error/disabled/focus；tokens；target switch 不串。
  - 命令: 聚焦 tests/browser/threads|collaboration 相关套件；`npx tsc --noEmit`

- [x] T-03 真实浏览器验收收藏 — Blocked by: T-02
  - 公共缝: 真实线程列表 + tuple-scoped route。
  - 验证: 收藏→视图→取消→重启保持；desktop/narrow、light/dark、keyboard、focus、44px、axe 无 serious/critical；证据无敏感泄漏；随后一次性全量 `npx vitest run` + `npx tsc --noEmit` + `npm run build`。
  - 命令: smoke:threads 验收段；全量一次；`npm run build`
