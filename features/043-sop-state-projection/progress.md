# 043 SOP 状态投影进度

- 特性: 043-sop-state-projection（S-26）
- 当前阶段: done
- 执行模式: auto
- 下一步: done
- 用户可感知: 是；演示验收 auto-approved 2026-08-15
- 评审: spec/architecture/`hf-review` 豁免 2026-08-15；hf-code-review 初审需修改后复审 PASS。

## 实施记录

- 2026-08-15 立项 auto：阻塞项 S-22 / AUD-MVP / S-25 已交付，S-26 准入。默认 A-302～A-308。
- 2026-08-15 T-01 GREEN：`getSopStateProjection` + GET sop-state；聚焦 12 passed。
- 2026-08-15 T-02 GREEN：看板「流程状态」；聚焦 14 passed。
- 2026-08-15 T-03 GREEN：`smoke:context` SOP 8 断言；build 绿；onboarding fetch 补 sop-state stub；verified-handle 审计循环 2→3；home 项目使 projects 计数 2→3。全量套件负载下 4 条既有 I/O 超时，隔离 58/58 后加 15s timeout。
- 2026-08-15 hf-code-review：去掉 MWK 对 PWS 私有 browse 的 import，改为公开 Query 注入；独立复审 PASS。`CAP-MWK-03` 已交付核心。
