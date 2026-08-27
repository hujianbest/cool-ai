# 任务票 — 项目知识目录与集合

- 状态: done；T-01～T-05 已 ship
- 规模: 5 张纵向票
- 公共缝: Knowledge commands/queries、记忆视图

- [x] T-01 schema 与创建集合 — Blocked by: None
  - RED: 无集合表/创建命令。
  - GREEN: schema 29；同项目创建；名称唯一；项目隔离。
  - 验证: schema + 命令聚焦测试。

- [x] T-02 加入/移出/目录 — Blocked by: T-01
  - RED: 无法把记忆放入集合或列出。
  - GREEN: 成员指向现存 chain head；未知记忆失败关闭。
  - 验证: 命令/查询测试。

- [x] T-03 删除保留来源 — Blocked by: T-02
  - RED: 删除集合可能删记忆。
  - GREEN: 只删关系；记忆仍可检索。
  - 验证: 命令测试。

- [x] T-04 记忆视图目录 — Blocked by: T-03
  - RED: 记忆视图无集合目录。
  - GREEN: UCD §9.2.4；确认删除；取消不请求。
  - 验证: jsdom；`smoke:context` 若仍可用（A-401 不作为本片门）。

- [x] T-05 收口 — Blocked by: T-04
  - 验证: 聚焦 → tsc → build → 记忆 jsdom → 全量。
  - review: schema + 跨表写；hf-code-review。
