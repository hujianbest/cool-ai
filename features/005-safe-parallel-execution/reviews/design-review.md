# 技术设计 评审 (第 14 轮)

- 日期: 2026-07-31
- 评审方式: subagent
- 结论: 通过
- 用户确认: auto-approved 2026-07-31

## Findings

无。第 13 轮两项 findings 均已闭合：

- descriptor 与 journal DDL 已统一为 strict ref JSON，完整持久化 stable root、handle-relative path、owner、parent/file identity、hash 与 size；canonical temp/post identity 的生成时点及仅凭 DB refs、journal root、canonical root 的重启恢复路径已明确。
- 生命周期签名已补 canonical target 定位、`NativeMutationResult` 分支和 canonical temp preparation，并明确映射 modified/added 的 apply、rollback、roll-forward 与 conditional cleanup；T-38 可独立按该 primitive 契约测试。

# 技术设计 评审 (第 15 轮)

- 日期: 2026-07-31
- 评审方式: subagent
- 结论: 需修改

## Findings

- [严重] `design.md` §7（verified sandbox manifest 生命周期）与 T-41：当前只要求“成功且可能改变文件的 command”在成功事实前刷新整树 manifest，但非零退出、超时后已确认终止等失败命令同样可能已经改写 sandbox；此时 attempt 缓存 hash 与 validation freshness 可继续停留在命令前状态，违反“整棵 sandbox 的唯一字节事实”和失败关闭。该段也未把 write/command/validation/stage 的唯一顺序及 CAS 失败结果写完整：`before_sandbox_hash` 来自哪次 verified refresh、attempt 旧 hash/lease/version/status 的 CAS 条件、validation 绑定 pre-command 还是 post-command hash、stage 是否只消费同一次 refresh 返回的 entries/hash，均仍需实现阶段自行发明。应明确：每次 write 与每个实际启动过且已确认终止的 command（不论 exit code）都执行受 lease/status/version/expected-current-hash 约束的 pre/post 整树 refresh；tool/action、attempt manifest 与 validation（若可产生）按一个明确 finalize 顺序提交，任一 CAS/refresh 失败均不得留下 succeeded tool/action/validation/stage；stage 仅使用其当次 verified refresh 的同一份 entries/hash 计算 observations。T-41 的单一测试还须覆盖成功/失败 command、validation 新鲜度、CAS 竞争/失败和 stage refresh 失败，而不只覆盖成功 write→validation→stage happy path；T-42 必须在 T-41 闭合后，T-43 再仅验证 T-42 已公开贯通的行为。

# 技术设计 评审 (第 16 轮)

- 日期: 2026-07-31
- 评审方式: subagent
- 结论: 通过
- 用户确认: auto-approved 2026-07-31

## Findings

无。第 15 轮 finding 已闭合：write 与所有实际启动且已确认终止的 command（成功、非零退出、timeout）均明确执行 verified pre/post 整树 refresh；finalize 已规定 lease/token、execution version/status、attempt status、preHash 的 CAS 与 tool/action、postHash validation、attempt manifest、receipt 的唯一事务顺序，refresh/CAS/termination 不确定均不留下成功事实且旧 attempt 不可 stage；validation 绑定同次 postHash，stage 只消费单次 refresh 的不可变 entries/hash。T-41 已在单一测试任务中覆盖成功/失败/timeout command、`sha256` 统一、validation 失鲜、stage、refresh/遍历失败及 lease/version/hash CAS 竞争，并保持 T-41→T-42→T-43 顺序。

# 技术设计 评审 (第 17 轮)

- 日期: 2026-07-31
- 评审方式: subagent
- 结论: 需修改

## Findings

- [严重] `design.md` §2 D-2 `ManifestEntry`、§3 `execution_attempts.baseline_manifest_path` 与 §7 canonical/sandbox manifest 契约互相冲突：`ManifestEntry` 和 §7 新段要求保留 `identity`，但 §7 仍明确把“baseline/当前 manifest 文件与 adapter DTO”限定为 `{path,size,sha256,modeTag}`，且没有写明 identity 随 baseline/current manifest 持久化、重启后如何读取并比较。这样实现既可合法地不序列化 identity，也无法保证重启后的 same-bytes-new-identity 被判 stale；T-42 也只要求缺失/替换场景，没有覆盖落盘重开。应统一持久 manifest/adapter entry 的 strict schema为含 `identity`，明确 baseline 与每次 current refresh 的 identity 持久化和重启读取路径，同时保留 byte-manifest hash 只输入 path/size/sha256；T-42 增加“落盘关闭并重开后 byte hash 相同、identity 不同仍 stale”的 production-adapter 测试。
- [严重] `design.md` §7 `stage_compute` 异常收口与 T-42 尚不具备唯一可实现契约：“staged/stale/paused/failed 的唯一状态”和“paused/failed”仍是结果集合，不是按分支确定的映射，也未解决 finalize lease CAS 已失败时 catch/finally 不可能再用同一 lease 完成 action/receipt 的情况。known guard（无变化、validation 不新鲜、pending action）、stale、adapter error、未知异常、lease/deadline/reconcile 胜出分别应落到哪个 action terminal status/error、execution status/resume_target/reason、receipt HTTP/body、attempt status仍需实现者发明，存在 action/receipt/execution 分裂或 pending/running 残留风险。应给出 acquire 后每一出口的精确矩阵，并明确 CAS 失手由 reconcile 以何种状态完成原 receipt；T-42 在 T-43/T-44 前逐支覆盖上述出口、事务注入、重开与 late finalizer，断言 running action=0、pending receipt=0、staged facts=0（非成功分支）及唯一 execution/attempt 状态。

# 技术设计 评审 (第 18 轮)

- 日期: 2026-07-31
- 评审方式: subagent
- 结论: 通过
- 用户确认: auto-approved 2026-07-31

## Findings

无。第 17 轮两项 findings 均已闭合：

- baseline/current manifest 与 adapter entry 已统一为含 `identity` 的 strict 持久契约，新增 `sandbox_manifest_path` 并明确 refresh 的原子指针/hash 更新、重启 strict parse；byte-manifest hash 仍仅输入 path/size/sha256。T-42 已覆盖关闭数据库/adapter后重开及 same-bytes-new-identity stale。
- `stage_compute` acquire 后已按 success、stale、no-changes、validation stale、adapter/identity/parse error、未知异常、lease/deadline/reconcile、late finalizer 给出唯一 action/receipt/execution/attempt/staged-facts 出口，并明确事务回滚后的 reconcile 收口。T-42 已逐支覆盖且保持 T-42→T-43→T-44 顺序。

# 技术设计 评审 (第 19 轮)

- 日期: 2026-07-31
- 评审方式: subagent
- 结论: 需修改

## Findings

- [严重] `design.md` §5.2 第 3 步/精确因果链、§10 审批→进程集成与 T-43：契约要求 command action 自身绑定并参与 `inputHash` 相等/篡改检查，但既有严格 v5 DDL 中 `execution_actions` 只有 `request_hash`，没有 `input_hash`；`execution_tool_calls` 也没有名为 `input_hash` 的列，实际输入事实是 `before_sandbox_hash`，只有 `execution_approvals` 存在 `input_hash`。当前 consume 事务可用 `approval.tool_call_id → tool.action_id`、三表复合 execution/attempt 身份、共同 `request_hash`，以及 `approval.input_hash = tool.before_sandbox_hash = consume 时 attempt.sandbox_manifest_hash` 建立因果链，却不能按文字比较不存在的 action/tool `inputHash`。照现设计实现会迫使 T-43 临时修改已冻结的 v5 DDL/严格列校验并扩大到 migration 测试，或把不存在的字段伪装进 JSON，均超出任务判据，因而不能在一次 TDD 内确定完成。应把持久绑定逐字段映射到现有真实列，明确 action 通过 `tool.action_id` 与复合身份间接绑定 input hash、action 只直接持有 `request_hash`；相应把 §10/T-43 的逐字段 tamper 改为可实际篡改的 `approval.input_hash`、`tool.before_sandbox_hash`、`tool.action_id`、action identity/request_hash/operation/action-index/lease，除非明确新增迁移任务并更新完整 v5 DDL、validator、迁移测试与任务顺序。
- [严重] `design.md` §5.2 异常终态矩阵、§6.4、§8 与 T-43：consume 后分支仍不唯一且与既有 timeout/owner-control/reconcile 契约冲突。已确认终止的 timeout 在 §5.2 没有唯一一行，§8 又写成 `paused/failed`；`PROCESS_TERMINATION_UNCONFIRMED` 在 §5.2 指定 receipt 500，而 §6.4 把它列为 503；矩阵新增的 `COMMAND_AUTHORIZATION_INVALID`、`COMMAND_PROCESS_FAILED` 未进入 §6.4 error code 集。更关键的是，§5.2 将 spawn/运行异常收口为普通 paused，却在 §8 要求“显式 retry 新 attempt”，而 3.2/现有 owner control 只允许 interrupted/deadline 类 paused retry；generic reconcile 对非 model action目前只终结 action/receipt，不定义 command tool、execution、attempt 的唯一状态，矩阵的“保留 reconcile 胜者状态”因此仍要求实现者发明。应为成功、非零退出、已确认终止 timeout、spawn/运行异常、终止不确定、pre/post manifest、persist、owner pause、owner stop、command lease/deadline reconcile 分别给出唯一 action/receipt HTTP+code/execution resume target+reason/attempt/tool/manifest/validation 结果，并统一 §6.4 与 §8；明确普通 paused 是 continue 还是将 reason 纳入 retry eligibility。T-43 测试逐行覆盖该唯一矩阵，并因其重新验证 command 120 秒 timeout/lease 边界而补记 FR-10（必要时 NFR-2）覆盖及任务覆盖索引。

# 技术设计 评审 (第 20 轮)

- 日期: 2026-07-31
- 评审方式: subagent
- 结论: 通过
- 用户确认: auto-approved 2026-07-31

## Findings

无。第 19 轮两项 findings 均已闭合：

- one-shot 因果链已完全映射到真实 v5 列：`approval.input_hash = tool.before_sandbox_hash = attempt.sandbox_manifest_hash`，action 仅直接持有共同 `request_hash`，并通过 `tool.action_id`、复合 identity、operation/action-index/lease 间接绑定；§10 与 T-43 的 tamper 集同步改为现有字段，明确不改 DDL，任务可在既定 TDD 边界内实现。
- §5.2 已为 success、nonzero、已确认终止 timeout、spawn/run、终止不确定、pre/post manifest、persist、owner pause/stop、lease/deadline reconcile 与 late finalizer 分别给出唯一 action/receipt HTTP+code、execution/resume/reason、attempt/tool、manifest/validation 结果；§6.4 与 §8 已统一，continue/retry 语义明确，T-43 及覆盖索引已补 FR-10/NFR-2。
