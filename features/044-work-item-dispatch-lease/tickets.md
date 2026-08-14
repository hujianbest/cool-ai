# 任务票 — 任务租约

- [x] T-01 schema 24→25 + claim 写租约 + heartbeat/release/reclaim + 查询 — Blocked by: None
  - RED: 租约字段不存在；重复领取/过期回收未定义
  - GREEN: canonical manifest、exact reopen、claim 写入 token/expiry/heartbeat；冲突 409；过期 reclaim 成功、未过期 reclaim 422；聚焦 mission-work 测试；禁止全量 vitest
- [x] T-02 HTTP + 看板租约可见/释放回收 — Blocked by: T-01
- [x] T-03 smoke:context 既有任务断言 + build + 一次全量 vitest + hf-code-review — Blocked by: T-02
