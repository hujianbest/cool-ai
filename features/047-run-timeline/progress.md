# 047 运行轨迹时间轴进度

- 特性: 047-run-timeline（S-39）
- 当前阶段: implement
- 执行模式: auto
- 下一步: 交父会话 ship（T-01～T-03 已勾选；未宣称 ship）
- 用户可感知: 是
- 评审: spec/architecture 豁免 2026-08-15；轻量级零 schema、只读、无新安全写边界 → implement 后 hf-code-review 豁免。

- 2026-08-15 立项 auto。A-327～A-332。S-39 原阻塞 source producer / OPS-01 / MWK-02 已交付。
- 2026-08-15 T-01 GREEN：`listProjectTimeline` + GET `/api/projects/:projectId/timeline`；先 catchUp；mission 过滤 / 去重 MIN seq / 正序 / sourceMissing / 跨项目 404 / 未知 query 400。游标按 A-333 仅首页+limit。聚焦 26 通过；`npx tsc --noEmit` 绿。schema identity 仍为 25。
- 2026-08-15 T-02 GREEN：审计面板「时间轴」视图切换、正序、来源链接/「来源缺失」、loading/empty/error。`audit-panel.test.tsx` 33 通过。
- 2026-08-15 T-03 GREEN：`npx tsc --noEmit` 绿；`npm run build` 绿（含 GET `/api/projects/:projectId/timeline`）；全量 `npx vitest run` 295 文件 / 2722 用例 / 133.83s；`npm run smoke:execution` 绿。`RUN TIMELINE ACCEPTANCE PASS: assertions=160`。阶段仍为 implement，交父会话 ship。
