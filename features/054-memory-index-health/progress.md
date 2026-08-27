# 进度

- 特性: 054-memory-index-health
- 对应切片: S-29
- 当前阶段: done
- 执行模式: auto
- 已加载扩展: ui-ux-pro-max
- 下一步: 无（已 ship）；产品下一片为 055/S-35 服务健康与可观察性中心。

## 状态记录

- 2026-08-19 053/S-43 ship 后按未交付依赖顺序立项本片。准入 `CAP-KNW-01`、`CAP-KNW-02`、`CAP-OPS-01`、`CAP-GOV-02` 均已交付。
- 2026-08-19 现状证据：S-28 直接查询 active `memory_entries`，无专用索引、checkpoint、健康 API 或重建入口；Operations Projection 已有可重建投影协议，但 audit outbox 不含 Knowledge 来源。
- 默认边界 A-397～A-400：专用 watermark；canonical 搜索保持直查作为降级路径；coverage/hash 作为健康口径；SQLite 投影重建使用强确认，不扩展 Approval 域。
- 2026-08-19 spec/architecture/5 张纵向票与 UCD §9.2.4 健康条落盘，grill-with-docs 完成，进入 implement T-01。
- 2026-08-19 T-01 完成：有效 RED 证明 consumer 缺失；schema 27→28 新增 Operations Projection 拥有的 memory index/state，project-scoped active-head 扫描、SHA-256 一致性、watermark 与幂等 catch-up 落地；schema/consumer/ownership/writer 54/54，tsc 绿。开始 T-02。
- 2026-08-19 T-02 完成：project-scoped health query + no-store GET API 返回 freshness、active/indexed/valid coverage、稳定状态与 source fallback，不暴露 Memory 正文；query/API 聚焦测试与 tsc 绿。
- 2026-08-19 T-03 完成：强确认 rebuild service/POST API 以 operation hash + expectedVersion CAS 重建 active heads，完成 receipt 可重放，冲突/并发/错误稳定失败且不改来源；聚焦 3/3，tsc 绿。开始 T-04。
- 2026-08-19 T-04 完成：有效 RED 证明记忆视图无健康表面；健康条、coverage/降级文案、默认聚焦取消的强确认对话框与 rebuild 状态落地，来源列表/检索保持；MemoryPanel 6/6、tsc 绿。开始 T-05。
- 2026-08-21 T-05 ship：code/security review 通过（Knowledge 只读、project-scoped SQL、health DTO 不含正文、operation/version 重放、来源记忆保留；单事务 rebuild 崩溃回滚到 idle，不自动重放）。记忆面板测试按 URL 隔离 health fetch。`tsc`/`build` 绿；`smoke:settings` 19 steps + 9 axe 态 0 critical（含健康条亮/暗/窄屏）；全量 312/313 文件、2826/2827，唯一失败为既有 A-387。`smoke:context` 仍在桌面主路径等待已卸下的工作区绑定条（A-401）。演示 auto-approved。
