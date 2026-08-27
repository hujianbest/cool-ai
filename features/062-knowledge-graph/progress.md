# 进度

- 特性: 062-knowledge-graph
- 对应切片: S-31
- 当前阶段: done
- 执行模式: auto
- 已加载扩展: 无
- 下一步: 无（已 ship）；产品下一片 S-32 阻塞于 S-24 非执行域发布治理。

## 状态记录

- 2026-08-21 061/S-30 ship 后立项。准入检索与集合已交付。默认 A-432～A-433：零 schema、列表为主路径。进入 T-01。
- 2026-08-21 T-01 完成：有效 RED 证明图查询缺失；`getKnowledgeGraph` 投影 supersedes 边、项目隔离。聚焦 1/1。开始 T-02。
- 2026-08-21 T-02 完成：GET `/api/projects/:projectId/knowledge-graph` no-store、未知项目 404、额外查询键 400。聚焦 2/2。开始 T-03。
- 2026-08-21 T-03 完成：记忆视图「关系列表」列出有两端节点的 supersedes 边，并可定位记忆卡片；缺节点边不渲染。开始 T-04。
- 2026-08-21 T-04 完成：集合成员共现边；他项/集外记忆不入边；UI 不渲染缺节点边。开始 T-05。
- 2026-08-21 T-05 ship：零 schema GET `/api/projects/:id/knowledge-graph`；记忆「关系列表」；supersedes + 集合共现。`tsc`/`build` 绿；记忆 jsdom 13/13；全量 331/332、2887/2888（A-387）。演示 auto-approved。
