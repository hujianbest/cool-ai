# 044 任务租约进度

- 特性: 044-work-item-dispatch-lease（S-27）
- 当前阶段: done
- 执行模式: auto
- 下一步: done
- 用户可感知: 是；演示验收 auto-approved 2026-08-15
- 评审: spec/architecture 豁免；hf-code-review 初审需修改后复审 PASS。

## 实施记录

- 2026-08-15 立项 auto。A-309～A-311。
- T-01～T-03 完成：identity 24→25，claim/heartbeat/release/reclaim，看板租约，`smoke:context` 5 断言。
- 代码门：去掉全局 SQL 改写、operationId 重放后独立复审 PASS。全量 289 文件 / 2652 用例 126.51s。`CAP-MWK-04` 已交付核心。
