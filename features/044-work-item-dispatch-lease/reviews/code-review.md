# 044 任务租约 code-review

- 固定点: `48a0e02`（043/S-26 ship）
- 范围: 该点之后的 044 工作树
- 日期: 2026-08-15
- 评审人: 独立 subagent 双轴；作者未自评通过

## Standards

1. **严重（已修复）** `tests/setup.ts` 曾猴补丁 `DatabaseSync` 改写 `work_items` INSERT，掩盖 CHECK。已删除全局补丁；rewriter 仅显式夹具调用；补 CHECK 失败用例。
2. **严重（已修复）** heartbeat/release/reclaim 丢弃 `operationId`。已按 `transitionWorkItem` 持久化并重放；不同 hash → 409。
3. **一般** 路由 content-type/体大小、个别 `as` 收窄。不阻塞。

独立复审 **PASS**（2026-08-15）。

## Spec

初审 3 一般：上次心跳未展示、operationId 丢弃、非持有者可释放。心跳展示与持有者/owner 演员限制已修；operationId 与 Standards#2 同修。

## 结论

初审需修改；修复后独立复审 PASS。全量 Vitest 289 文件 / 2652 通过，126.51s。
