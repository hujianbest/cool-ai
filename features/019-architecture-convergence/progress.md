# 进度

- 特性: 019-architecture-convergence
- 当前阶段: implement
- 执行模式: auto
- 已加载扩展: 无
- 下一步: 执行 T-01（冻结基线与清单 + 修复 stale 架构门禁断言）
- 门禁输出: RESULT: FAIL（仅缺 spec-review/architecture-review 评审记录）— 项目级 review 豁免（AGENTS.md 当前开发阶段条款，2026-08-09）：豁免 spec review、architecture review、hf-review 与 hf-code-review；不伪造评审工件
- 共享理解: auto-approved 2026-08-09（用户指示有待确认项按推荐结果接受）
- 用户可感知: 否（纯结构调整；ADR-0004 验收仍要求浏览器 smoke）
- 阻塞关系: 收敛完成前，015/017/018 及全部后续产品特性不得进入 implement
- 规模检查: 16 票超 8 票阈值，属基础重构性质；按 AGENTS.md 以有边界扩张—收缩批次处理（每波独立验证、保持构建通过）；例外与验证成本已记录（用户 2026-08-09 明确要求按最新架构完成收敛）
- 评审状态: 项目级豁免（2026-08-09）；不伪造 spec-review、architecture-review 或 code-review

## 波次登记

- 2026-08-09 T-01 启动：冻结基线（spec.md 已落盘：227 文件/1803 测试，127 Windows 环境性失败 + 1 stale 架构断言）。
- 2026-08-09 T-01 ✅ 提交：manifest + writer 清单 + stale 断言修复。
- 2026-08-09 T-02 ✅ 提交：目标骨架 + tests/architecture 四组检查（含过渡棘轮）。
- 2026-08-09 T-03 ✅ 提交：storage 收敛（9 文件 + ~200 引用更新）；聚焦 94+16 测试绿、构建绿。
- 2026-08-09 T-04 ✅ 提交：identity-capability（4 文件）；聚焦 69+57 测试绿、构建绿。
- 2026-08-09 T-05 ✅ 提交：project-workspace（4 文件，含 validation-policy 归属裁决）；聚焦测试绿（1 个 Windows 环境性失败与基线一致）、构建绿。
- 2026-08-09 T-06 ✅ 提交：mission-work（3 文件 + collaboration_operations 跨 owner 写提取为 public-collaboration 能力）；聚焦测试绿（1 个 mission-transaction-primitives 超时经 master 对照为既有失败）、构建绿。
- 2026-08-09 T-07 ✅ 提交：knowledge-provenance（3 文件，含 review/memory-committer 归属裁决）；聚焦测试绿（1 个 review-production-application 失败经 master 对照为既有失败）、构建绿。
- 2026-08-09 T-08 ✅ 提交：governance（execution_approvals 全部 11 处写 SQL 提取为 approval-store 能力，execution 域零直接写）；聚焦 33+10 测试绿、构建绿。
- 2026-08-09 T-09 ✅ 提交：safe-execution（36 文件：15 领域服务入 SQLite Adapter、14 工作区技术 Adapter 归位、3 纯逻辑入 internal）；聚焦 394 测试中 116 失败均为 Windows 环境性（与基线一致）、构建绿。
- 进行中：T-10 public-collaboration（26 文件，含 S-12/S-13 在途代码）。

## 过渡口登记（T-13/T-14 收编，非长期兼容层）

- `tests/architecture/imports.test.ts` ALLOWED_MODULE_INTERNAL_EDGES：adapter→本模块 internal（实现→自有 helper）；跨 owner internal 读两条（safe-execution→identity credential-vault；project-workspace→safe-execution command-policy），T-13 收编。
- TRANSITIONAL_ADAPTER_EDGES：sandbox-executor 直开 sqlite connection，T-13/T-14 收编为事务协调 Port。
- adapter→adapter 调用边：mission-work→public-collaboration（mission-control-receipts）；review-delivery→knowledge-provenance（memory-committer）；review-delivery→mission-work（work-item-status-effects，T-11 建立）；safe-execution→governance（approval-store）。T-13/T-14 收编为 Workflow/composition 注入。
- 跨 owner 只读 SQL（context-snapshot 读五 owner 表、provider-service 读 collaboration active-run、memory-service 读 projects/work_items）：T-13 收编为应用层读组合/公开查询 Interface。
- 2026-08-09 T-08 ✅ 提交：governance（execution_approvals 全部写 SQL 提取为 approval-store 能力）。
- 2026-08-09 T-09 完成实现（待主会话验收后提交）：safe-execution 36 文件迁移——15 含 SQL 领域服务入 `sqlite/safe-execution/`、14 工作区技术 Adapter 入 `workspace/`、3 纯领域逻辑入 `modules/safe-execution/internal/`，D 类 3 个 *-api 留原地待 T-14；公开面（errors/dto/commands/queries/index）建档，10 个错误类原样迁入 public/errors.ts 并由实现文件 import+re-export；调用方 72 文件 import 更新；测试归位 modules/safe-execution（14）、adapters/workspace（10）、adapters/sqlite/safe-execution（10）；writers.test.ts `MIGRATED_OWNERS` 加入 safe-execution；imports.test.ts 登记 T-09 过渡豁免（同 owner sqlite↔workspace 边、sandbox-executor 直开 connection、action-orchestrator 读 credential-vault、validation-policy-service 读 command-policy），writers.test.ts 登记 validation-policy-service 写 execution_operations 过渡边（均注 T-13/T-14 收编）。验收：聚焦 394 测试 116 失败均为 Windows 环境性（与基线逐文件一致）、消费方 26/26 绿、tsc 与生产构建绿、非 D 类 `@/src/server/execution/` import 零命中。
