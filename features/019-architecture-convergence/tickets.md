# 019 任务票 — 目标架构收敛

- 日期: 2026-08-09
- 规模: 16 票，按波次串行；每波 = 一个可独立验证切片 = 一次提交
- Review 豁免: 项目级 review 豁免（2026-08-09）；TDD/聚焦测试/最终全量/构建/浏览器 smoke 不豁免

- [x] T-01 冻结基线与清单：固定全量测试基线（227 文件/1803 测试；127 Windows 环境性失败 + 1 stale 架构断言，证据入 spec.md）与生产构建基线；从 `CURRENT_SCHEMA` 生成机器可读 write-ownership manifest（每张写表唯一 owner）与 src/server 全文件/依赖/route 编排清单；修复 `tests/architecture-boundaries.test.ts` stale 断言（构建基线阻塞缺陷：仍期待旧版 architecture.md 含 D-43/superseded 字样）；聚焦验证 `tests/architecture-boundaries.test.ts` + `tests/current-schema.test.ts` 通过。
- [x] T-02 目标骨架与机械护栏：创建 `src/modules/`、`src/application/workflows/`、`src/adapters/`、`src/composition/` 骨架与 `tests/architecture/`（imports/ownership/writers/dependency-graph 四组检查）；检查对已迁移项阻断、未迁移项报告；聚焦验证架构测试通过且生产构建通过。
- [x] T-03 收敛 current storage：`db.ts`、`storage/`（current-schema/bootstrap/validate/invariants/schema-error）、`storage/sqlite/sqlite-unit-of-work` 迁入 `src/adapters/outbound/sqlite/`；事务协调 Port（unit-of-work/transaction-context）归 `src/application/`；全部 ~140 个引用方 import 更新；schema/bootstrap/reopen 测试归 `tests/adapters/sqlite/`；聚焦验证 current-schema/current-schema-rejection/collaboration-operations 测试通过。
- [x] T-04 迁移 identity-capability：provider/agent/skill 服务迁入 `src/adapters/outbound/sqlite/identity-capability/`；credential-vault 迁 `src/modules/identity-capability/internal/`；public 面（errors/dto/commands/queries）与 index 建立；providers/agents/skills/credential-vault 测试归 `tests/modules/identity-capability/`；manifest 登记 providers/agents/skills/agent_skills（T-01 已含）；`MIGRATED_OWNERS` 加入 identity-capability；聚焦验证 identity-capability/architecture/agent-turn-credential/structured-repair-credential/agent-turn-schema 测试与生产构建通过。
- [x] T-05 迁移 project-workspace：projects/membership/workspace/context-snapshot 迁入；manifest 登记；聚焦验证 projects.service/workspace.service（Linux 环境性失败除外）/context 测试通过。
- [x] T-06 迁移 mission-work：mission-service/tasks/mission/public/sqlite capability 迁入；mission-review-effects 跨域调用登记为 T-13 待提取 Workflow 边；manifest 登记；聚焦验证 mission-crud/create-mission-workflow 测试通过。
- [x] T-07 迁移 knowledge-provenance：memory-service/memory-source-resolver 迁入；manifest 登记；聚焦验证 memory 测试通过。
- [x] T-08 迁移 governance：execution-approval-service 从 execution/ 提取入 `src/modules/governance/` + sqlite Adapter；Approval 写表改登记 governance owner；调用方（execution 控制路径）改经公开 Interface；聚焦验证 execution-approvals 测试通过。
- [x] T-09 迁移 safe-execution：execution/ 其余 36 文件迁入 `src/modules/safe-execution/` + `src/adapters/outbound/sqlite/safe-execution/` + 工作区 Adapter 候选（windows-*/node-file-tool-adapter/process-runner/path-guard/sandbox-* 归 `src/adapters/outbound/workspace/`）；manifest 登记；聚焦验证 command-policy/execution 非 Windows 测试通过（Windows 环境性失败保持原样）。
- [x] T-10 迁移 public-collaboration：collaboration/（除 openai-chat-client）+ structured-messages/ 迁入；thread-fact-store 唯一 writer seam 保持；manifest 登记；聚焦验证 thread-fact-store/thread-history-api/collaboration-operations/structured-message 测试通过。
- [x] T-11 迁移 review-delivery：review/ 20 文件迁入；sqlite-review-delivery-command-capability 归 Adapter；manifest 登记；聚焦验证 review 测试通过。
- [x] T-12 迁移 runtime/model-runtime Adapter：provider-verifier、openai-chat-client 归 `src/adapters/outbound/model-runtime/`；不建 runtime 空壳 Module；聚焦验证 provider-verifier/agent-turn 测试通过。
- [x] T-13 显式化 Application Workflow：create-mission-workflow 归 `src/application/workflows/`；mission-review-effects 等跨域编排提取为命名 Workflow；消除领域→领域 import 边（架构检查转阻断）；聚焦验证 create-mission-workflow/completion-gate 测试通过。
- [x] T-14 迁移入站与装配：`*-api.ts` 传输校验/错误映射归 `app/api/_shared/`；route 只依赖 Workflow entry contract 或 Module 公开 Interface；`src/composition/` 收编全部 concrete 构造（删除过渡口）；聚焦验证 API 测试 + 生产构建通过。
- [x] T-15 迁移并分治测试：tests/ 按目标树归位（modules/workflows/adapters/browser/architecture/fixtures）；删除只证明旧目录的测试；聚焦验证测试发现数不减少（除明示删除项）且通过。
- [ ] T-16 收缩与验收：删除 `src/server/` 与全部兼容 re-export/临时 alias；架构检查全阻断通过；全量测试不比冻结基线差；生产构建通过；现有浏览器 smoke（smoke:team/context/collaboration/execution/review/settings/onboarding/threads）通过；更新 product/backlog.md 证据索引与 CONTEXT/假设台账。
