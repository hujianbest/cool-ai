# 任务票 — 来源可追溯知识图谱

- 状态: done
- 规模: 5 张纵向票

- [x] T-01 图查询 — Blocked by: None
  - RED: 无带来源的关系 DTO。
  - GREEN: `getKnowledgeGraph` 项目隔离；只含有证据边；零 schema。
  - 验证: query 聚焦测试。

- [x] T-02 GET knowledge-graph — Blocked by: T-01
  - GREEN: no-store、未知项目 404。
  - 验证: API + tsc。

- [x] T-03 关系列表 — Blocked by: T-02
  - GREEN: UCD §9.2.4 列表替代；可跳来源。
  - 验证: jsdom。

- [x] T-04 无来源推断 — Blocked by: T-03
  - GREEN: 不渲染无 href 的推断边。
  - 验证: query/jsdom。

- [x] T-05 收口 — Blocked by: T-04
  - 验证: 聚焦 → tsc → build → 记忆 jsdom → 全量。
