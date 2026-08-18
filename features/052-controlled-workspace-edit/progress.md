# 进度

- 特性: 052-controlled-workspace-edit
- 对应切片: S-42
- 当前阶段: to-spec
- 执行模式: auto
- 已加载扩展: 无
- 下一步: 写 `spec.md`（API 契约先行：受控编辑、sandbox diff、stale/冲突、审批合入、失败关闭）。高风险：须 hf-code-review。不在无规格时实现写路径。

## 状态记录

- 2026-08-18 051 T-06 与 050 ship 收口后按 `product/development-plan.md` P4 立项本片。Backlog 演示判据：owner 从只读预览发起编辑，sandbox 看 diff、处理 stale/冲突，经审批合入 canonical workspace；越界或不可逆 Git 失败关闭。
- 准入：`CAP-PWS-02`（S-22）与 `CAP-OPS-01/02`（S-23 子片）已 ship，不再作为阻塞。本片建立 `CAP-EXE-02`。
- 项目级 spec/architecture 评审按 AGENTS.md 选择性条款：本片含安全边界与跨 owner 写，implement 后必须 hf-code-review，不豁免代码门。
