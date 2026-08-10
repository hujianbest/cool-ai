# 任务票 — 审计投影 MVP（AUD-MVP）

- 状态: 项目级 review 豁免生效，直接进入 implement
- 规模: 4 张纵向 RED/GREEN 票；单一"查看 Safe Execution 审计并知其新鲜度"用户结果 + 投影基座
- 公共缝: Audit Outbox Write、Projection Consumer、Audit Query、审计列表 UI
- TDD: 每票先一个公共行为 RED，再最小 GREEN；内存库夹具；新树测试路径

- [x] T-01 Outbox schema 与 Safe Execution 原子写 — Blocked by: None
  - 公共缝: Audit Outbox Write。
  - RED: outbox 表不存在；execution 事件写入不产生 outbox 行。
  - GREEN: identity 14→15 三表（outbox/checkpoints/projection，同步全部引用与 write-ownership manifest）；勘察 execution_events 全部写入点并同事务追加 outbox（payload 白名单提取集中一处、fail-closed）；outbox_seq 事务内 `COALESCE(MAX,0)+1` 单调；不变量（seq 唯一、checkpoint 上界、projection⊆outbox）。
  - 验证: 原子性（业务写失败 outbox 不留痕）、payload 无白名单外字段、seq 单调、reopen 幂等。
  - 命令: 聚焦 safe-execution 事件相关套件 + schema 套件；`npx tsc --noEmit`

- [x] T-02 Consumer、checkpoint、rebuild 与 freshness — Blocked by: T-01
  - 公共缝: Projection Consumer。
  - RED: catchUp/rebuild/freshness 不存在。
  - GREEN: operations-projection 新模块骨架 + consumer 实现（幂等追平 INSERT OR IGNORE、批次 checkpoint、rebuild 互斥守卫与确定性重放、freshness lag）；装配根登记。
  - 验证: 两遍 catchUp 同结果、重放无重复、rebuild 后投影==outbox、lag 计算、互斥负例、损坏 checkpoint fail-closed。
  - 命令: 聚焦 tests/modules/operations-projection/；`npx tsc --noEmit`

- [x] T-03 审计查询与 API — Blocked by: T-02
  - 公共缝: Audit Query。
  - RED: 查询/路由不存在。
  - GREEN: `listProjectAuditEvents`（倒序 before-seq 分页、tuple 404）+ `getAuditProjectionFreshness`；GET 路由（严格校验、脱敏）；读路径同步 catchUp。
  - 验证: 分页边界、tuple 隔离、空项目 empty、freshness 各态。
  - 命令: 聚焦 operations-projection 套件；`npx tsc --noEmit`

- [x] T-04 审计列表 UI 与真实浏览器验收 — Blocked by: T-03
  - 公共缝: 审计列表 UI + 真实执行造数。
  - GREEN: 项目面板"审计"区（事件列表倒序、类型可读文案、actor/时间、新鲜度徽标、来源 execution 定位、empty/loading/error/focus、键盘、44px、tokens）。
  - 验证: smoke（复用执行造数）呈现+新鲜度+导航+只读；desktop/narrow、light/dark、keyboard、axe 无 serious/critical；秘密扫描（payload 无凭据/隐藏推理）；一次性全量 `npx vitest run` + `npx tsc --noEmit` + `npm run build`。
  - 命令: 聚焦 UI 测试；对应 smoke；全量一次；`npm run build`
