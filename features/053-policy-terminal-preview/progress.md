# 进度

- 特性: 053-policy-terminal-preview
- 对应切片: S-43
- 当前阶段: done
- 执行模式: auto
- 已加载扩展: 无
- 下一步: 无（已 ship）；产品下一片为 054/S-29 记忆索引状态与健康诊断。

## 状态记录

- 2026-08-18 052/S-42 ship 后按 `product/development-plan.md` P4 立项本片。Backlog 演示判据：owner 在任务内运行精确许可命令并查看本地预览；越界/未许可/外部发布失败关闭并要求审批。
- 准入：`CAP-EXE-01`、`CAP-PWS-01/02`、`CAP-OPS-01/02` 已交付。本片建立 `CAP-EXE-03`。
- `product/ui/UI设计.md` 未规定终端或浏览器预览主路径；实现前须补 UCD，不得另造未记录控件。
- 2026-08-19 spec/architecture/tickets 与 UCD §9.4.4 落盘：终端收窄为任务内结构化命令选择器 + 只读输出，无自由 shell；preview URL 只由冻结 loopback policy 生成；假设 A-393～A-396。进入 implement T-01。
- 2026-08-19 T-01 完成：有效 RED 证明 preview 边界未持久化；schema 26→27，Validation Policy append-only entry 增加 purpose/timeout/loopback/port/openPath，严格拒绝不完整或不安全 preview；政策 UI 可见配置边界。聚焦 32/32 + UI 4/4，tsc 绿。开始 T-02。
- 2026-08-19 T-02～T-04 完成：冻结命令目录按完整 tuple 分类 exact/deny/one-shot；Approval 按 consumer 分区且批准后单次消费；Policy Process 具备 acquire/start/status/output/stop/reconcile、version CAS、30～900s deadline、1 MiB 脱敏 UTF-8 输出检查点；preview 仅从冻结 loopback port/openPath 生成并探测 readiness。
- 2026-08-19 T-05 完成：Execution 卡片按需挂载「终端与预览」，提供策略摘要、只读增量输出、停止、one-shot 请求与本地预览入口；亮/暗/窄屏真实浏览器验收完成，演示 auto-approved。
- 2026-08-19 T-06 ship：code/security review 发现已收口（Approval consumer 隔离、executable identity、进程 version CAS、实时输出脱敏检查点）；聚焦 S-43/API/UI/架构测试全绿，`tsc` 与 `build` 绿；全量 308/309 文件、2820/2821 用例，唯一失败为既有 `review-browser-full-chain` UCD §9.5 残留（A-387）。
