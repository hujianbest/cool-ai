# T-04 migration asset 分类清单

分类只描述测试语义，不以文件名中的 `legacy`、`v6`、`v7` 或 `migration` 机械判断。

## `tests/v6-fixture-db.ts`

### `schema-upgrade-only`（T-05 删除）

- `tests/context-migrations.test.ts`
- `tests/migrations-v4.test.ts`
- `tests/migrations-v5.test.ts`
- `tests/migrations-v6.test.ts`
- `tests/migrations-v8-contract.test.ts`
- `tests/v6-fixture-db.test.ts`

### `current-business-invariant`

- [x] `tests/collaboration-operations.test.ts` — operation replay/conflict/in-progress receipt；已改用 current `openDatabase` 与 Mission workflow
- [x] `tests/project-chat.api.test.ts` — project chat 公共 API；已改用 current opener 与 Mission workflow
- [x] `tests/validation-policy.test.ts` — current validation policy revision/invariant；已改用 current opener
- [x] `tests/members.service.test.ts` — membership 与 Mission owner 行为；已改用 current opener 与 Mission/Work Item 公共 service

## `tests/v7-fixture-graph.ts`

以下 caller 全部是 `current-business-invariant`；该 fixture 的版本 SQL rewrite/repair 不是待保留行为。

- [x] `tests/collaboration-read-api.test.ts`
- [x] `tests/collaboration-usage-budget.test.ts`
- [x] `tests/command-request.test.ts`
- [x] `tests/execution-actions.test.ts`
- [x] `tests/execution-approvals.test.ts`
- [x] `tests/execution-controls.test.ts`
- [x] `tests/execution-eligibility.test.ts`
- [x] `tests/execution-list-tool.test.ts`
- [x] `tests/execution-merge-route.test.ts`
- [x] `tests/execution-operations.test.ts`
- [x] `tests/execution-read-api.test.ts` — bounded reads、event union、tamper fail-closed；已在 current identity 上验证 current data
- [x] `tests/execution-read-tool.test.ts`
- [x] `tests/execution-sandbox-orchestrator.test.ts`
- [x] `tests/execution-slice.test.tsx`
- [x] `tests/execution-staging.test.ts`
- [x] `tests/execution-usage-budget.test.ts`
- [x] `tests/execution-write-stage-integration.test.ts`
- [x] `tests/execution-write-tool.test.ts`
- [x] `tests/merge-external-writer.test.ts`
- [x] `tests/merge-fault-injection.test.ts`
- [x] `tests/merge-journal-prepare.test.ts`
- [x] `tests/merge-recovery.test.ts`
- [x] `tests/process-runner.test.ts`
- [x] `tests/review-slice.test.tsx`
- [x] `tests/sandbox-snapshot.test.ts`
- [x] `tests/thread-readiness.test.ts`
- [x] `tests/validation-policy.test.ts`

所有直接 caller 已切到 execution owner 入口 `tests/fixtures/execution/current-graph.ts`，current identity 使用纯 data validator，Mission delivery 由 review owner fixture 建立。历史 SQL tuple rewrite 实现暂留 `v7-fixture-graph.ts`，作为 T-05 Contract 删除项，不再被业务测试直接 import。

## `tests/v7-advance-fixture.ts`

以下 caller 全部是 `current-business-invariant`，共同保留 collaboration run/turn 与 Structured Message 行为：

- [x] `tests/agent-task-actions.test.ts`
- [x] `tests/agent-turn-credential.test.ts`
- [x] `tests/collaboration-advance.api.test.ts`
- [x] `tests/execution-structured-repair.test.ts`
- [x] `tests/handoff-plan-ready.test.ts`
- [x] `tests/inline-decision-http.test.ts`
- [x] `tests/inline-decision.test.ts`
- [x] `tests/owner-handoff-plan-races.test.ts`
- [x] `tests/structured-message-http.test.ts`
- [x] `tests/structured-message-reopen.test.ts`
- [x] `tests/structured-message-store.test.ts`
- [x] `tests/structured-repair-credential.test.ts`
- [x] `tests/turn-acquire.test.ts`
- [x] `tests/turn-finalize.test.ts`

已迁至 collaboration owner fixture `tests/fixtures/collaboration/current-advance.ts`；Mission delivery 通过 Review Capability 建立，旧 version fixture 已无 caller 并删除。

## `tests/persistent-threads-v6-fixture.ts`

- [x] `tests/persistent-threads-browser-smoke.mjs` — `current-business-invariant`：已改由 current bootstrap、public thread service 与 collaboration owner fixture 建立持久 thread/run/message/fact、ownership 与 policy；旧 schema bootstrap 不再参与

## `tests/execution-frozen-fixture.ts`

以下 caller 全部是 `current-business-invariant`，保留 frozen public/private envelope、context hash 与来源 provenance：

- [x] `tests/execution-approvals.test.ts`
- [x] `tests/execution-usage-budget.test.ts`
- [x] `tests/merge-external-writer.test.ts`
- [x] `tests/merge-fault-injection.test.ts`
- [x] `tests/merge-journal-prepare.test.ts`
- [x] `tests/merge-recovery.test.ts`
- [x] `tests/review-escalation-integration.test.ts`
- [x] `tests/review-production-application.test.ts`
- [x] `tests/review-slice.test.tsx`

已迁至 owner fixture `tests/fixtures/execution/frozen-input.ts`，旧文件已无 caller 并删除。

## `tests/structured-messages-browser-fixture.ts`

- [x] `tests/structured-messages-browser-smoke.mjs` — `current-business-invariant`：已切到 Structured Message owner fixture 入口并从 `CURRENT_SCHEMA` 获取 corruption trigger；保留冻结 source/provenance、block/state/Decision/Receipt/fact 与未知 schema readonly 行为

## 分类统计

- migration assets：6
- caller 关系：62（同一测试可使用多个 asset）
- 唯一直接 caller：54
- `schema-upgrade-only`：6
- `current-business-invariant`：48 个唯一测试
- 已删除无 caller asset：`v7-advance-fixture.ts`、`execution-frozen-fixture.ts`

## T-05 Contract 清单

- [x] 删除全部 upgrade-only tests、`v6-fixture-db.ts` 与旧 Mission v6 initialization suite；`collaboration-slice` migration-only 断言已移除。
- [x] 将保留实现移入 owner 路径并删除旧路径：`fixtures/execution/current-graph.ts`、`fixtures/collaboration/persistent-threads-browser.ts`、`fixtures/structured-messages/browser.ts`。
- [x] 删除生产 `src/server/migrations*.ts`、runner、shadow-copy、legacy adoption/backfill 与 upgrade hooks；corruption DDL 统一从 `CURRENT_SCHEMA` 获取。
- [x] current data invariants 已迁到 `storage/current-data-invariants.ts`；生产 current path 无 migration import，identity 9 `CURRENT_SCHEMA` 是唯一 DDL source。
- [x] 全量回归 1791/1792；唯一失败是既有 5 秒测试预算与 5 秒 SQLite busy timeout 相撞，`mission-transaction-primitives.test.ts --testTimeout=10000` 单独 5/5 通过。
