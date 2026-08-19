# 进度

- 特性: 052-controlled-workspace-edit
- 对应切片: S-42
- 当前阶段: done
- 执行模式: auto
- 已加载扩展: 无
- 下一步: 无（052/S-42 已 ship）。按计划进入 S-43。

## 状态记录

- 2026-08-18 051 T-06 与 050 ship 收口后按 `product/development-plan.md` P4 立项本片。Backlog 演示判据：owner 从只读预览发起编辑，sandbox 看 diff、处理 stale/冲突，经审批合入 canonical workspace；越界或不可逆 Git 失败关闭。
- 准入：`CAP-PWS-02`（S-22）与 `CAP-OPS-01/02`（S-23 子片）已 ship，不再作为阻塞。本片建立 `CAP-EXE-02`。
- 项目级 spec/architecture 评审按 AGENTS.md 选择性条款：本片含安全边界与跨 owner 写，implement 后必须 hf-code-review，不豁免代码门。
- 2026-08-18 落盘 `spec.md`（API 先行：edits CRUD / diff / stage / merge / abandon；单文件 A-388）。
- 2026-08-18 落盘 `architecture.md` + `tickets.md`（T-01～T-05）。平行 MergeJournal 表，不放宽 execution 外键。公开 status 用规格词（A-389）。
- 2026-08-18 T-01：schema identity 25→26，`workspace_edit_sessions` + 一活跃/项目索引；POST/GET edits；verified-handle 拷入隔离草稿；敏感/越界/二进制失败关闭。
- 2026-08-18 T-02：PUT 只写隔离草稿；GET diff 区分 `ready_to_stage` / `stale` / `conflicted`。
- 2026-08-18 T-03：stage 不写 canonical；无审批 merge 拒绝；approve 后合入；abandon 丢草稿；operation 重放。A-390/A-391。
- 2026-08-18 T-04：文本预览「编辑」打开 sandbox textarea；放弃 / 申请合入。审批中心并入仍按 A-390 留待列表扩域。演示 auto-approved。下一步 T-05。
- 2026-08-18 T-05 安全评审：合入改走 `writeNativeVerifiedFile`，审批/journal/`merged` 同事务；canonical 已是 stagedHash 则跳过写盘。native read/write 共用 Koffi；write 根句柄去掉 DELETE（A-391）。聚焦 edit + native 61/61，`tsc`/`build` 绿。全量 2808 绿 / 2 失败（A-387 review-browser + 已修的 architecture import）。hf-code-review PASS。演示 auto-approved。
