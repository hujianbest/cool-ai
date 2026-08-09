# 019 架构 — 收敛波次与文件归属清单

- 日期: 2026-08-09
- 对齐: `product/architecture.md` 第 7 节目录结构、第 9 节迁移顺序、第 10 节机械约束；本文件是产品架构的增量执行注解
- Review 豁免: 项目级 review 豁免（2026-08-09）

## 每波 Module 目标形态

```
src/modules/<m>/index.ts        # 唯一公开入口（只 re-export public/）
src/modules/<m>/public/         # commands.ts / queries.ts / dto.ts / errors.ts（无 node:sqlite、无 Adapter 类型）
src/modules/<m>/internal/       # 纯领域逻辑：校验、状态机、政策（无 SQL）
src/modules/<m>/ports/          # 本 Module 声明的持久化 Port（仅在有真实信任接缝时）
src/adapters/outbound/sqlite/<m>/   # 该 owner 的 SQL 实现（repository/capability 实现；唯一合法写该 owner 表的位置）
```

- 迁移纪律：函数体保持不变，只做物理移动 + import 更新 + 公开面类型化；SQL 与领域政策交织的函数整体归入 Adapter（它们是带守卫的持久化操作），可分离的纯校验/状态机进 internal/。
- 过渡期内调用方（route）可暂直接引用 Adapter 构造；T-14 把全部 concrete 构造收进 `src/composition/` 后该过渡口删除。

## 文件 → owner 归属清单（T-01 冻结，120 个 src/server 文件全量）

- **identity-capability**: agent-service, agent-api, skill-service, skill-api, provider-service, provider-api, credential-vault
- **project-workspace**: projects, membership-service, membership-api, workspace-service, execution/validation-policy-service（Validation Policy 事实归 Project & Workspace；分类逻辑留 safe-execution，T-05 建立跨域读过渡边）, execution/validation-policy-http（T-14）
- **mission-work**: mission-service, mission-api, task-api, tasks, mission/public, mission/sqlite-mission-command-capability
- **public-collaboration**: collaboration/（除 openai-chat-client）全部 20 个文件；structured-messages/ 全部 6 个文件
- **safe-execution**: execution/（除 execution-approval-service）全部 36 个文件
- **governance**: execution/execution-approval-service
- **review-delivery**: review/ 全部 20 个文件
- **knowledge-provenance**: memory-service, memory-api, memory-source-resolver
- **runtime（model-runtime outbound Adapter）**: provider-verifier, collaboration/openai-chat-client
- **SQLite Adapter 技术核心（无领域分支）**: db, storage/ 全部 6 个文件, storage/sqlite/sqlite-unit-of-work
- **Application Workflow 层**: application/create-mission-workflow, application/mission-review-effects, application/unit-of-work（事务协调 Port）, application/transaction-context, context-snapshot-service（跨 5 owner 的只读事实组合，T-13 归应用层读组合）, context-api（T-14）
- **composition root**: composition/server-composition
- **入站 HTTP 共享助手（T-14 归 app/api/_shared/）**: api-errors 及各 *-api.ts 的传输校验/错误映射部分
- **operations-projection**: 当前无已实现代码（CAP-OPS-01 规划中）——不创建空壳

## 波次（= tickets.md 票据；每波一次提交）

1. **T-01 冻结基线与清单**：固定测试/构建基线（含 127 Windows 环境性失败 + 1 stale 架构断言的证据与处置）；生成 write-ownership manifest（从 `CURRENT_SCHEMA` 派生全部写表→唯一 owner）与依赖清单；修复 stale 架构门禁断言（构建基线阻塞缺陷，证据见 spec.md）。
2. **T-02 目标骨架与机械护栏**：建 `src/modules/`、`src/application/workflows/`、`src/adapters/`、`src/composition/` 与 `tests/architecture/`（imports/ownership/writers/dependency-graph）；已迁移项逐波转阻断。
3. **T-03 收敛 current storage**：db/storage/unit-of-work → `src/adapters/outbound/sqlite/`；事务协调 Port 类型归 `src/application/`；schema 测试归 `tests/adapters/sqlite/`。
4. **T-04～T-12 领域 Module 波**：identity-capability → project-workspace → mission-work → knowledge-provenance → governance → safe-execution → public-collaboration → review-delivery → runtime(model-runtime Adapter)。每波：Interface/Implementation/Adapter/调用方/fixture/测试同迁，删旧入口，manifest 登记，架构检查扩展。
5. **T-13 显式化 Application Workflow**：跨 owner 用户结果从 route/跨域调用提取为命名 Workflow（create-mission 既有 seam 归位；mission-review-effects 等跨域编排显式化）；消除领域→领域 import 边。
6. **T-14 迁移入站与装配**：`*-api.ts` 传输/错误映射归 `app/api/_shared/`；route 只依赖 Workflow entry contract 或 Module 公开 Interface；`src/composition/` 为唯一装配根。
7. **T-15 迁移并分治测试**：tests/ 按目标树（modules/workflows/adapters/browser/architecture/fixtures）归位；删除只证明旧目录的测试。
8. **T-16 收缩与验收**：删除 `src/server/` 与全部兼容入口；架构检查全阻断；全量测试 + 生产构建 + 现有浏览器 smoke 通过。

## 关键默认（已按用户指示接受推荐并落盘假设台账）

- A-98: 本特性用户可感知=否；浏览器 smoke 作为 ADR-0004 验收一部分仍在 T-16 执行。
- A-99: 事务协调 Port（unit-of-work/transaction-context）归 `src/application/`（非业务 owner 的应用层接缝），实现归 sqlite Adapter。
- A-100: 入站 HTTP 共享助手归 `app/api/_shared/`（Next 下划线目录不参与路由），不新建业务目录。
- A-101: provider-verifier 与 openai-chat-client 归 `src/adapters/outbound/model-runtime/`（Runtime 的外部交互 Adapter），runtime 领域 Module 当前无自有事实表、不建空壳。
- A-102: 127 个 Windows-only 失败为环境性（A-60 设计失败关闭），不计入收敛回归判据；收敛判据为"不比冻结基线差"。
- A-103: 迁移期允许 route 暂引 Adapter 构造的过渡口，T-14 统一收编 composition；过渡期在 progress.md 逐波登记，不构成长期兼容层。
- A-104: 领域→领域 import 边在 T-04～T-12 期间以"改经对方公开 Interface"为过渡形态，T-13 提取 Workflow 后消除；架构检查对领域间命令边在 T-13 转阻断。
