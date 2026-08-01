# 实现代码评审 (第 1 轮)

- 日期: 2026-08-01
- 评审方式: subagent
- 结论: 需修改

## 评审范围与证据

- 冷读 `frame.md`、`spec.md`、`design.md`（含 T-1..T-51），并逐文件核对 `git diff cd303e6..HEAD`；实际改动触及并发调度、SQLite v5、进程执行、文件/合入边界、审批、DTO 与 UI，和 frame 的档位 3 相符。
- 评审者通过 `hf_gate.py run --label review-suite` 重跑 `npm.cmd test`：`review-suite-20260801T021101Z.log`，123 个测试文件、845 个测试通过，exit 0。
- 评审者通过 `hf_gate.py run --label review-gate` 重跑双镜像 gate 单测：首次 `review-gate-20260801T021101Z.log` 因两个同名测试模块的 pytest import mismatch 在收集阶段 exit 2；随后使用 `--import-mode=importlib` 的 `review-gate-20260801T021314Z.log`，双镜像共 80 项通过，exit 0。
- 抽查 T-49、T-51 RED/GREEN：RED 是目标行为缺失，GREEN 为同一任务修复后的通过结果；日志具备 `# hf-gate-run`、label、command、started 和末尾 exit 的严格信封。
- 抽查 T-50 `[verification-only]`：`t50-readme-*`、`t50-build-*` 等均由 gate run 生成且至少一份严格信封 exit 0；T-51 的正反例覆盖精确 marker、任务边界、文件名/header 一致、重复/缺失字段、时间与末尾 exit。
- 核对 desktop/narrow 真实截图。desktop 展示执行、验证、变更与详情结构；narrow 展示 390px 下的单列详情、可见焦点目标和 loading 状态。代码中亦存在 loading/empty/error、disabled/success/focus 分支及 token 化样式；以下 UI findings 属于行为接线问题，不是截图真伪问题。

## Findings

- [一般] `app/api/projects/[projectId]/executions/route.ts:48`、`app/api/executions/[executionId]/advance/route.ts:24`、`app/api/executions/[executionId]/control/route.ts:28`、`app/api/executions/[executionId]/approvals/[approvalId]/route.ts:23`、`app/api/executions/[executionId]/recovery/resolve/route.ts:32`、`app/api/projects/[projectId]/validation-policy/route.ts:81`: 这些 mutation 仍调用无界的 `readExecutionJson()`，它在 `src/server/execution/execution-api.ts:5-18` 直接执行 `request.json()`；只有 merge route 使用 128 KiB reader。`design.md:1142` 明确规定所有请求 ≤128 KiB，因此无 `Content-Length` 的大 body 可在 schema 拒绝前被完整读入内存，资源边界未实现。→ 所有 S-5 mutation 统一使用 `readBoundedExecutionJson()`，并增加有/无 `Content-Length`、分块传输及 128 KiB±1 的 route 测试。

- [一般] `components/execution/execution-review.tsx:579-581,791-821`: `validations.items.filter(({ required }) => true)` 实际保留了所有验证而非仅 required 项；同时 `requiredFresh` 在 required 项为零时固定为 false。结果是可选验证失败会错误阻止 UI 合入，而服务端已判为 `auto_eligible` 且没有 required 验证时，UI 又完全不渲染“自动合入”按钮。列表还只加载首个 20 项页面，无法可靠代表最多 50 项政策。→ 修正为真正过滤 `required`，为零项采用 vacuous success，并让合入可用性依据服务端 staged readiness/完整 required 汇总，而不是首个分页的局部数据；补零 required、optional failed、超过 20 项的交互测试。

- [一般] `components/execution/execution-review.tsx:545-578,802-826` 与 `src/server/execution/execution-read-service.ts:1007-1051`: 审批列表按最旧 `created_at,id` 排序且 UI 只加载第一页 10 项后查找 `staged_merge`。同一 execution 曾产生 10 个以上 command approval 时，最新 staged approval 不在首屏，changes tab 会落入一个没有 `onClick` 的“批准当前 staged hash”按钮；该按钮甚至可能处于 enabled 状态但点击无效果。→ detail 直接返回绑定当前 staged hash 的 active approval，或提供 kind/status/stagedHash 过滤并优先返回当前审批；在审批尚未加载到时只显示明确 loading/error/retry，不显示无处理器的动作按钮，并覆盖 >10 历史审批场景。

- [一般] `src/server/execution/execution-frozen-input.ts:299-360` 与 `src/server/execution/action-orchestrator.ts:156-167`: 冻结 envelope 解析失败、缺字段或 fingerprint 不符时，stale guard 将其归为 `legacy` 并放行；随后模型推进只确认 `promptInput` 是 object 就强制转换为 `FrozenExecutionPromptInput`。这与 `design.md:973` 要求 frozen JSON 由对应 strict Zod schema 生成并在读取时再次 parse 不符，也使损坏/篡改的冻结输入绕过 context stale 检查后进入 prompt builder。→ 为 public/private envelope 和 `promptInput` 建立严格、带版本的 schema；当前 v5 记录解析失败必须 fail closed。若确需兼容历史数据，应以可证明的旧 schema/version 显式迁移，不能把任意 malformed 数据当作 legacy。

- [一般] `src/server/execution/execution-read-service.ts:147-181,693-733`: 公共 event DTO 的 `type` 只是任意非空字符串，payload schema 仅覆盖 `action_started`、`action_finished`、`action_reconciled`、`status_changed` 四类；`merged`、`tool_*`、`approval_*`、`validation_finished`、`boundary_paused`、`usage_recorded` 等未知类型直接跳过 payload 校验。这不满足 `design.md:1225-1240` 的“每种 payload 单独 strict schema”，且损坏行或意外附加字段可原样进入公共 API。→ 以完整 event type enum/discriminated union 对所有类型和 payload 严格解析，未知类型/额外字段 fail closed，并增加逐类型 round-trip 与数据库篡改测试。

# 实现代码评审 (第 2 轮)

- 日期: 2026-08-01
- 评审方式: subagent
- 结论: 需修改

## 复审范围与证据

- 仅复核第 1 轮五项 findings；冷读修复提交 `084c85b`、`b2e0052`、`c3d0caf`、`4cd3084`、`6c9fcc7` 的 diff、对应新测试与 T-52..T-56 证据，未扩大评审范围。
- 评审者通过 `hf_gate.py run --label review-suite` 重跑当前 `npm.cmd test`：`review-suite-20260801T030610Z.log`，124 个测试文件、900 个测试通过，exit 0。
- 核对最新 production build `build-20260801T030256Z.log` 与运行时 smoke `smoke-20260801T030335Z.log`，均 exit 0；smoke 同时产出并核对 `demo-execution-desktop.png`、`demo-execution-narrow.png`。

## Findings 闭合情况

- 第 1 项已闭合：六个 mutation route 已统一使用流式、128 KiB 有界 reader；七条 mutation 路径覆盖有/无 `Content-Length`、chunked 与边界两侧，T-52 green/regression 及本轮全量套件通过。
- 第 2 项已闭合：required validation readiness 改由 detail 的服务端完整汇总提供，零 required 为 vacuous success，可选失败不阻断，超过 20 项不再依赖首屏；T-53 的 API/UI 用例与回归通过。
- 第 3 项已闭合：detail 直接返回绑定当前 attempt 与 staged hash 的唯一 active approval；UI 在缺失时只呈现明确错误与 retry，不再渲染无 handler 动作；`>10` 历史审批的 API/UI 用例及 T-54 回归通过。
- 第 4 项已闭合：public/private envelope 与 `promptInput` 均使用 strict、带 v5 版本的 Zod schema，读取、fingerprint 与模型推进均 fail closed；malformed、缺失、额外字段、错误版本及篡改测试和 T-55 安全回归通过。
- [一般] 第 1 轮第 5 项未完全闭合，定位 `tests/execution-read-api.test.ts:40-116,307-369`：生产代码已在 `src/shared/execution-contracts.ts:29-329` 建立 33 种 event 的完整 enum/discriminated union，未知类型、额外字段和数据库篡改也已 fail closed；但所谓“complete persisted event union”的 round-trip fixture 实际仅列出 18 种，缺少 `sandbox_preflight`、`sandbox_ready`、`attempt_interrupted`、`model_call_started`、`model_call_succeeded`、`model_call_failed`、`tool_rejected`、`approval_consumed`、`validation_recorded`、`staged_created`、`merge_prepared`、`merge_recovered`、`manual_recovery_required`、`manual_recovery_resolved`、`operation_replayed`。`executionEventDtoSchema.options` 与 enum 名称集合相等的断言只能证明分支存在，不能证明这 15 种持久化 payload 能经数据库/API round-trip。→ 把 fixture 补齐为全部 33 种并让逐类型 round-trip、strict extra-field 与数据库篡改断言覆盖每个分支后再复审。

# 实现代码评审 (第 3 轮)

- 日期: 2026-08-01
- 评审方式: subagent
- 结论: 通过
- 用户确认: auto-approved 2026-08-01

## 复审范围与证据

- 仅复核第 2 轮唯一未闭合项；冷读修复提交 `4dbe702` 的完整测试 diff 与 T-57 red/green/regression 证据，未扩大评审范围。
- `tests/execution-read-api.test.ts:40-218` 以手写、独立的 `expectedPersistedEventTypes` 固定 33 种期望，并显式提供 33 份 payload fixture；期望集合不是从生产 `executionEventTypeSchema` 或 `executionEventDtoSchema` 生成，因此不存在以生产 union 自证的恒真断言。
- `tests/execution-read-api.test.ts:409-503` 验证 fixture 数量和类型集合恰为 33，逐项写入数据库后经分页公共读取 round-trip；同一组 33 种 fixture 逐项验证 payload extra-field 被 strict schema 拒绝，并逐项执行数据库篡改后确认读取 fail closed。
- 评审者通过 `hf_gate.py run --label review-event-fixtures` 独立重跑 `npm.cmd test -- tests/execution-read-api.test.ts`：`review-event-fixtures-20260801T031342Z.log`，17 项通过，exit 0。

## Findings

无。第 2 轮唯一未闭合项已闭合。
