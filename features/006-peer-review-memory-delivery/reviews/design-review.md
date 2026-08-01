# Design 评审 (第 1 轮)

- 日期: 2026-08-01
- 评审方式: subagent
- 结论: 需修改

## Findings

- [严重] `design.md` §4.2（第 517～584 行）与 §4.3（第 586～637 行）: 冻结材料只给 review Agent 变更计数/hash、validation stdout/stderr header、artifact header 和 audit event 引用；同时明确不内嵌 diff、stdout/stderr、artifact body 或 event payload，provider 调用也没有读取这些公开详情的工具协议。这样 Agent 实际看不到被复核产物、变更内容、验证输出或相关公开审计事实，却仍可返回 `pass`，会形成符合 schema 但没有审阅证据内容的伪裁决，未实现 spec FR-2/FR-3 的“读取公开变更/产物、验证结论及相关公开审计事实”。→ 在 2 MiB、redaction 与版本冻结边界内，明确可供 Agent 实际读取的 bounded public 内容（或冻结的受控读取工具/分块协议）、每类截断/缺失语义及其 source ref；并增加“只有 hash/header 时不得通过”的验收与任务覆盖。

- [严重] `design.md` §4.4 第 653～666 行、§5.3 第 715～729 行与 §10.2 第 1148 行: provider 调用和可信 usage 已先持久化，但合法结构化输出只在最终 pass 事务中使用；该事务发生 SQLite/memory fault 时整体回滚，fallback 把 attempt 标成 `failed`。随后 owner 只能新建 attempt，再次调用 provider。此路径重复了已经确认完成的外部动作，违反 spec FR-11“通过原子边界失败后不得重复调用已经确认完成的外部动作”，也使故障恢复无法从持久事实继续。→ 设计一个不保存 raw response/CoT、但可持久化已 strict-parse 且通过 redaction 的公开输出及其 hash 的 durable finalize checkpoint，或给出等价的可恢复提交协议；重试应只重放本地原子提交，不再次调用 provider，并补齐 crash/fault/restart 判据。

- [严重] `design.md` §3.1 第 141～147 行、§3.5 第 434～448 行、§5.1 第 680～685 行与 §9.2 第 1095～1099 行: head 的生命周期只覆盖“迁移时为既有 mission/result 回填”和“已有 `rework` head 合入下一版”。没有定义 v6 上线后新建 mission 时如何原子创建 `mission_delivery_heads`，也没有定义无历史 result 的新 work item 首次 merged result 如何创建 `work_item_review_heads`；现有 CAS 又要求 prior head/state。新使命将没有事件 sequence/delivery pointer，新任务的首次 S-5 merge 也无法进入 `pending_review`，核心正向链在非迁移数据上不可达。→ 明确接入现有 `createMission`、work item 与首次 merge 事务的 head 初始化 primitive、FK/版本/事件规则及并发 winner，并在任务中覆盖“全新 v6 mission/work item 首次执行→merge→review→delivery”，不能只测迁移 fixture 和返工版。

- [一般] `design.md` §8.2 第 958～1013 行、§8.3 第 1015～1029 行与 §10 第 1112～1161 行: strict public contract 尚不闭合。`ReviewAttemptDto` 只有聚合 usage，无法表示 primary/repair 各自的 calling/terminal 状态、`reported=false` 时的 nullable usage 和失败类别，而 UI 设计及 FR-2/FR-3 要求逐调用状态可见；错误矩阵也未收录设计正文实际使用的 `REVIEW_OUTPUT_REDACTED`、`REVIEW_TOKEN_BOUNDARY`、`DELIVERY_INTERRUPTED`、`LEGACY_DONE_UNREVIEWED` 等 code。实现阶段仍需自行发明 DTO/nullability、HTTP status 和固定中文错误映射。→ 补齐 strict `ReviewModelCallDto`、attempt/detail/workspace 的嵌套关系与 calling/failed usage 表达，并让所有可达错误 code 在 error matrix、error envelope、事件与 UI copy 中一一闭合。

- [一般] `design.md` §5.4 第 754～762 行、§5.5 第 764～780 行与 §7.3 第 885～907 行: 完成/交付失效规则仍有两处冲突或遗漏。其一，delivery fingerprint 和 frozen material 都包含 mission version，但 mission title/goal 更新未列入 `invalidateCompletionTx`，已完成使命可继续指向旧标题/目标的 current delivery；其二，completion predicate 要求 validation/artifact refs “可读”，而 manifest 又允许 optional evidence 为 failed/truncated/stale/missing 且不阻塞，未定义“可读”与 optional missing 的确定边界。→ 把 mission/context 版本变化纳入 calling attempt 与 completed delivery 的失效事务，并精确定义 required/optional evidence 对 predicate、manifest status 和 blocker 的同一判定表，补充更新/并发/重启测试。

- [一般] `design.md` §14 第 1291～1335 行: 24 个任务没有全部满足“每个普通任务一次 TDD”。T-24 是普通任务语法，却自称“只验证前序行为”，完成判据只有全量 test/build/smoke 通过，没有指定可先失败、再通过的同任务行为测试；按 HarnessFlow 它既不是 `[verification-only]`，也缺少可判定的 red/green 边界。覆盖索引还与任务内覆盖声明不一致，例如索引写 `FR-13 → T-2 至 T-18`，但 T-4、T-12 等任务正文未声明覆盖 FR-13。→ 若 T-24 会新增/修改 smoke 行为，明确一个可先红后绿的 T-24 测试和单次 TDD 边界；若确实只运行既有验证，则必须改成精确 `[verification-only]`（但这不满足本轮要求的 24 任务各一次 TDD，应据用户要求选择前者）。同时机械校验每个任务的 inline 覆盖与索引完全一致，并把上述新增生命周期、可读材料、durable finalize 场景落到明确任务。

# Design 评审 (第 2 轮)

- 日期: 2026-08-01
- 评审方式: subagent
- 结论: 需修改

## Findings

- [一般] 第 1 轮第 4 项未完全闭合（`design.md` §8.2 第 1071～1097 行）: 持久状态和状态机已新增 `finalizing`，UI 也要求展示 checkpoint 待提交态，但 `ReviewAttemptDto.status` 仍只允许 `calling|rejected|escalated|passed|failed|interrupted|discarded`，无法 strict parse 正在等待本地重放的 attempt；同时所有 attempt 的 `finalize.retryRequiresProvider` 被声明为字面量 `false`，这对 checkpoint 前 failed/interrupted、需要新 provider attempt 的状态并不成立。→ 把 `finalizing` 纳入 attempt DTO，并把 retry 语义做成与 checkpoint/status 一致的 strict discriminated contract（checkpoint 后只本地 finalize，checkpoint 前显式新 attempt/provider）；同步校正 refine、workspace/history/detail 与 T-16 判据。

- [一般] 第 1 轮第 6 项未闭合（`design.md` §14 第 1468、1499 行）: inline 覆盖索引已校正，但 T-24 被改成 `[verification-only]`，明确“不伪造 RED”，仍不满足本轮原始约束“24 任务每个一次 TDD”，也没有落实第 1 轮 finding 已明确要求“据用户要求选择前者”。→ 将 T-24 恢复为普通任务，为 `smoke:review` 的真实 provider/browser harness 行为指定可先红后绿的同任务测试与唯一 TDD 边界；全量 test/build/smoke 可继续作为其 green 后收口判据。

## 第 1 轮 Findings 闭合确认

- 第 1 项已闭合：冻结材料现包含 bounded public diff、validation output、artifact body 与 typed event payload，精确绑定版本/hash，并明确 header-only 或 required 正文不完整时禁止 pass。
- 第 2 项已闭合：新增 durable public-output checkpoint；checkpoint 后 business finalize 故障只重放本地提交，不新增 provider/model call，并覆盖 restart/fault/replay。
- 第 3 项已闭合：补齐全新 v6 mission delivery head 初始化和首次 merged result/review head 原子创建、并发 winner、事件及测试路径。
- 第 4 项未完全闭合：逐 call usage/error registry 已补齐，但 attempt DTO 尚不能表达 `finalizing`，retry 字段也与 checkpoint 前状态冲突。
- 第 5 项已闭合：mission/context version 变化会原子失效 calling/finalizing attempt 与 current delivery；required/optional evidence 已统一为同一判定表。
- 第 6 项未闭合：覆盖索引已一致，但 T-24 仍绕过“24 个任务各一次 TDD”的明确要求。

# Design 评审 (第 3 轮)

- 日期: 2026-08-01
- 评审方式: subagent
- 结论: 通过
- 用户确认: auto-approved 2026-08-01

## Findings

无

## 第 2 轮 Findings 闭合确认

- 第 1 项已闭合：`ReviewAttemptDto` 已纳入 `finalizing`，并以 strict discriminated contract 区分 `local-finalize-only`、`new-provider-attempt` 与 `none`；checkpoint、retry 是否调用 provider、workspace/history/detail refine、UI 动作及 T-16 判据一致。
- 第 2 项已闭合：T-24 已恢复为普通任务，以缺失真实 provider/browser `smoke:review` harness contract 为 RED、实现公开全链为 GREEN，并在 green 后运行全量 test/build/smoke 收口，满足第 24 个任务的一次明确 TDD。
