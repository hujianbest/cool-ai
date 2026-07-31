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

# 技术设计 评审 (第 21 轮)

- 日期: 2026-07-31
- 评审方式: subagent
- 结论: 需修改

## Findings

- [严重] `design.md` §3.3 command request、§5.2 command request hash/snapshot 与 T-44：`request_hash` 排除 manifest、`approval.input_hash = tool.before_sandbox_hash = current attempt.sandbox_manifest_hash` 的字段语义已经正确，但生产事务/CAS 路径要求在“现有 command action lease”内先做 verified refresh，而真实 `action-orchestrator` 的 pending command 只来自已经终态且无 lease 的 model action；进入 `runCommandRequest` 时尚无 command action/parent pending receipt，one-shot 分支直到 refresh 后的 `requestExecutionCommand` 事务也只创建 completed advance receipt、`action_id=NULL` 的 tool 与 approval，不存在可供 refresh acquire/heartbeat/reconcile 的 action。当前设计既未定义 refresh 前如何原子创建 request-phase parent/action、该 action 使用哪个 kind/request hash/overall deadline，也未定义 refresh 失败、崩溃、同 operation 并发与 CAS 失手时 action/receipt 的唯一终态；若复用随后 consume 才创建的 command action则时序不可能，若新增 request action又需说明它为何不占用 `tool.action_id` 以及如何不被当作一次命令执行。因而 T-44 的公开生产链 RED/GREEN 仍需实现者发明持久协议，无法在一次 TDD 内按现有判据完成。应明确选择并写全协议：要么在 refresh 前以现有 v5 kind 建立独立 request-phase parent/action并给出 acquire→refresh→单事务 terminal action+tool+approval+events+waiting execution+receipt 的全分支 CAS/replay/reconcile矩阵；要么明确 verified refresh 是可安全重复的无 action 只读步骤，删除“action lease/heartbeat”要求并说明崩溃及同 operation 并发如何由事务内 receipt/CAS 唯一收口。相应让 T-44 从公开 `advanceExecution` 覆盖 refresh 期间崩溃/并发/replay且断言无 running action/pending receipt；若保留 action lease/deadline，还应补 FR-10/NFR-2 到 T-44 及覆盖索引。T-45/T-46 顺延和其余覆盖索引已正确，不构成额外 finding。

# 技术设计 评审 (第 22 轮)

- 日期: 2026-07-31
- 评审方式: subagent
- 结论: 通过
- 用户确认: auto-approved 2026-07-31

## Findings

无。第 21 轮 finding 已闭合：one-shot request 已明确选择无 action 的短事务协议，不做 FS refresh、不创建 lease/heartbeat/reconcile；manifest input 直接取事务内 current attempt 的缓存 hash，receipt/tool/approval/events/waiting execution 全有或全无，并补齐并发、崩溃、重放、事务注入与重开后的公开链 TDD 判据。standing exact 仍独立创建真实 command action，T-44 无需新增 FR-10/NFR-2 覆盖。

# 技术设计 评审 (第 23 轮)

- 日期: 2026-07-31
- 评审方式: subagent
- 结论: 需修改

## Findings

1. [严重] D-5 新增的 pre-acquire receipt 语义与现有 `executeMergePrepare` 调用边界不一致，`SANDBOX_UNVERIFIABLE` 无法按矩阵获得唯一、崩溃安全的幂等终态。design.md:283-298 要求所有通过 route 验证的请求先查 receipt，且 capability 失败属于 `has_external_actions=0`、action=0、journal=0 的 completed 422 receipt；但现有 `merge-journal-service.ts:1830-1857` 在 `validateAndBegin` 创建 operation/action 之前先执行 production adapter `assertCapability`，当前低层测试还明确断言该失败 operation=0。若 service 仅在 catch 后补拒绝 receipt，则 capability 调用期间崩溃或同 operation 并发没有 pending oracle；若把检查移到 acquire 后，又与 action=0 矩阵及 design.md:153 的“merge action/receipt completed 422”冲突。请明确唯一协议并同步 D-5、异常矩阵和 T-45 判据：capability 究竟是可重复的 preflight（需说明并发/崩溃窗口如何由 receipt 收口），还是持有 pending receipt/`merge_apply` lease 的外部步骤；相应规定 receipt/action 数量、`has_external_actions`、same-operation replay 与 fault 注入预期。

2. [严重] T-45 所要求的 recovery 可达性引用了不存在且语义不同的生产入口。design.md:274-275、293-295 要求过期原 action/receipt 先终结，再以新 `kind=recover` operation 创建 `merge_recover` action；T-45 又要求证明 route 产出的 journal 可经“既有 recover/resolution 入口”到达。但当前 execution API 只有 manual `/recovery/resolve`，没有 automatic recover route；`execution-read-service.ts:38-49` 是在 GET/read barrier 内直接调用 `recoverIncompleteMergeJournals`，该函数没有 `operationId` 输入，也不创建新的 recover receipt/action，而 `/api/runs/:runId/recover` 属于 collaboration run，不能作为 execution merge recovery。因而 crash/lease/deadline 行无法从公开 API 按所述 receipt/action 矩阵到达，T-45 的单个 RED/GREEN 也缺少 recover route、请求 schema、owner/expectedVersion、幂等 hash、原 receipt 终结顺序和 UI/读屏障触发规则。请选定并完整定义公开 recovery 协议（或把新入口拆为前置任务），并把现有 read-triggered helper 如何迁移/禁止自动外部写、same/different operation、并发 reconcile/late finalizer 及 route 测试判据写清后再实现。

3. [一般] route 的 owner 输入契约仍不可机械实现。design.md:283 要求“确认请求来自本地 owner mutation 边界”、缺失时 403 `OWNER_REQUIRED`，T-45 也要求覆盖 owner；但现有 execution routes 的 request/body/header 没有 owner credential/actor 字段，`readExecutionJson` 只解析 JSON，UI fetch 也不携带可验证 owner 身份。仅凭调用 `/merge` 或 Origin 不能区分 product UI owner 与其他本地调用者。请指定沿用的实际认证/边界机制及缺失/伪造判定，或明确本地单用户模型下 route 本身即 owner 边界并删除不可达的 403 分支；同时把测试如何构造 owner/no-owner 写入 T-45。当前任务还同时承担该新边界、route/service/UI、全 fault/recovery 链，待前两项协议闭合后应重新确认能否保持一个 TDD 任务。

# 技术设计 评审 (第 24 轮)

- 日期: 2026-07-31
- 评审方式: subagent
- 结论: 通过
- 用户确认: auto-approved 2026-07-31

## Findings

无。第 23 轮三项 findings 均已闭合：

1. capability 已明确为 operation/action acquire 前无副作用、可安全重复的 preflight；低层失败保持 operation/action/journal=0，production service 以唯一 completed 422 拒绝 receipt 收口，并补齐 same-operation 并发、receipt commit 前崩溃、unique insert/CAS 失手重读与重放语义，D-5、异常矩阵和 T-45 判据一致。
2. recovery 已明确选择既有 read barrier/helper 协议：只沿用原 journal、merge action 与 receipt，不新增 automatic recover route、`kind=recover` receipt 或 `merge_recover` action；T-45 收窄为同一 merge 调用进入 manual recovery 后经现有 `/recovery/resolve` 的公开可达性，T-46 与覆盖索引同步修正，任务粒度恢复为 route/service/UI 接线的一次 TDD。
3. owner 契约已明确为本地单用户模型下 merge route 本身即与现有 execution mutation routes 相同的 owner mutation 边界，不新增 credential/header/actor 字段，并删除不可构造的 403 `OWNER_REQUIRED` 分支及对应测试要求。
