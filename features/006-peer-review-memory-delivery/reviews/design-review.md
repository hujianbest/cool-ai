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

# Design评审（第4轮）

- 日期: 2026-08-01
- 评审方式: subagent
- 结论: 需修改

## Findings

- [严重] `design.md` §4.2 `ReviewMaterialV1.ownerAnswer`（第 619～621、635 行）、§5.2（第 760～775 行）与 T-25（第 1556 行）: 同一个 result 可以经历“升级 → `continue_review` → 新 attempt → 再次升级”的多轮链，但冻结契约只能携带一个 `ownerAnswer`，也没有定义选择规则、回答版本或前序回答是否仍是后续上下文。现有生产实现已经按“最新一条 answer”查询，这会让第二轮之后的冻结材料丢失早先 owner 约束，material hash 也无法证明 Agent 看过完整回答历史；T-25 只验一次 continue，未覆盖 spec FR-5 与 FR-12 要求的多轮升级/回答可恢复历史。→ 将冻结字段改为按稳定顺序、带 `escalationId/answerId/action/createdAt`（及必要版本）的回答链，或明确可证明安全的 supersede 规则；workspace 同时区分 current open issue 与 answered history，并在 T-25 覆盖至少两轮同 result continue、不同新 attempt、刷新/重启、旧回答不可改写及材料 hash 随回答链变化。

- [严重] `design.md` §8.1“canonical vocabulary”约束（第 1042 行）、§8.5（第 1268～1296 行）与 T-24～T-26: 设计只说历史别名要显式映射，却没有列出当前已落库/可达生产别名及 payload 转换，也没有把每类 producer 的 canonical 验证分配给对应任务。当前代码可实际产生 `work_item_review_passed`、`review_escalated`、`mission_owner_terminated`、`delivery_generation_completed`、`delivery_generation_interrupted`、`mission_delivery_invalidated` 等非 DTO 名称；`escalation_answered` 等同名事件的 payload 也与 strict DTO 字段不一致。由于读取端对未知 type/extra key fail-closed，一条旧事件即可令整个公开 review-events page 返回 500，直接破坏 FR-12/FR-13，而 T-24 的三裁决路径不能覆盖 answer、delivery completion/interruption/invalidation。→ 增加“现有 producer/持久别名 → canonical type/payload”的穷尽迁移或读取适配表，规定未知值仍 fail-closed；把 review、answer、delivery、invalidation 各生产路径的 strict round-trip 测试分别落到 T-24/T-25/T-26（或拆出独立事件任务），并用含上述既有行的 v6 数据验证升级后历史可读。

- [一般] `design.md` §4.4、§8.1 第 1023～1043 行及 T-24/T-26: 公开 route 的输入虽然已限制为 owner 可提交字段，但 route 到内部 primitive 的服务端组装契约仍未定义。当前 `runReviewOperation` 需要 `attemptId/frozenMaterialJson/providerRequest/validationContext/trustedTokens/provider/credential` 等可信内部输入，`acquireDeliveryGeneration` 仍要求调用方提供完整 `DeliveryBuildInput`；仅写“必须进入 orchestrator”或“服务端组装”不足以确定这些值在哪个事务快照读取、谁解密凭据/构造 prompt、operation hash 只绑定哪些公开字段、组装后如何防止 context 在 acquire 前漂移。实现者仍需自行发明关键安全边界，客户端防伪也无法仅靠当前任务判据证明。→ 为 review 与 delivery 各定义一个 public-input application-service 签名和逐字段 server derivation 表，明确 DB/事务/凭据边界、path/body 的 canonical operation hash、内部 DTO 不可由 route body 覆盖以及组装与 acquire 的 CAS identity；T-24/T-26 增加伪造内部字段、组装中 context 变化和 same operation replay 的 route 级测试。

- [一般] `design.md` §12.1 第 1425 行、§14 T-24/T-28（第 1555、1559 行）与自检第 1590 行: TDD 边界和任务粒度仍不一致。现有 `evidence/t24-red-20260801T081018Z.log` 运行的是 `tests/review-browser-smoke.test.ts`，且 RED 明确断言已废弃的 project-review / attempt-escalation route；修订后该行为属于 T-28，而新的 T-24 判据是 `tests/review-production-orchestration.test.ts`。该日志既不能证明新 T-24 的行为缺失，也不能在修正 route contract 后充当 T-28 RED。与此同时 T-24 把 public adapter、两套 review 实现收口、三种 finalizer、memory 原子性、checkpoint replay 和跨域 canonical events 塞进一次 TDD，失败面彼此独立；T-28 又同时新增进程/provider/browser 基础设施、全业务链、重启和双 viewport/a11y，均不符合“一任务一次可控 TDD”。→ 明确旧 t24-red 作废；T-24 在任何产品代码变更前以其新专属测试重新 RED，T-28 在修正公开 route 断言后另取 RED。再把 T-24 至少拆为 production review application-service/finalizer 与 event compatibility 两个顺序任务，并把 T-28 拆为 smoke 基础设施+最薄真实 pass 链、其余 reject/escalate/restart/viewport 场景收口，随后同步覆盖索引。

# Design评审（第5轮）

- 日期: 2026-08-01
- 评审方式: subagent
- 结论: 需修改

## Findings

- [严重] 第 4 轮第 2 项未闭合（`design.md` §8.5 第 1286～1328 行、T-25）: 兼容表既漏掉现有 producer 的 `work_item_completion_invalidated`，也没有穷尽“type 已同 canonical、payload 仍不兼容”的既有行。当前生产代码还会写出：`work_item_review_passed {headVersion,workItemId}`、`work_item_passed {decisionId,resultId,workItemId}`、`review_escalated {escalationId,...}`、`escalation_answered {escalationId,answerId,action,resultId,workItemId}`、`mission_owner_terminated {escalationId,missionId}`、`delivery_generation_completed {deliveryId,inputFingerprint,reused,version}`、`delivery_generation_interrupted {errorCode,operationId}`、两种不同 payload 的 `mission_delivery_invalidated`、`review_attempt_discarded {attemptId,reason,workItemId}`，以及缺 `category` 或 `inputFingerprint` 的现有 `delivery_generation_started|failed`。表中却假定若干不存在的旧字段（例如 `work_item_review_passed` 的 `resultId/decisionId/reasonCode`、`review_escalated` 的 `issueId`、termination 的 `reason`、interrupted 的 `inputFingerprint`、invalidation 的 `reasonCode/workItemIds`），无法按所写规则转换为 strict DTO；一条这类历史行仍会使公开 events page fail-closed。→ 以所有现有 review event producer 和已落库 fixture 为全集，列出每个 type+payload variant 的精确转换；缺失 canonical 必填值时明确从哪份同事务持久事实可信派生，无法无歧义派生则定义可审计的 legacy canonical variant/迁移失败规则。把 `work_item_completion_invalidated` 及上述同名旧 payload 全部纳入 T-25，并分别覆盖 review、answer、delivery completion/failure/interruption/invalidation 的 DB→DTO 历史 round-trip。
- [一般] 第 4 轮第 1 项未完全闭合（`design.md` §4.2 第 619～638 行、§8.2 第 1191～1204 行、T-26）: frozen material 已改为稳定排序的 `ownerAnswers[]`，含 escalation/answer/version/action/time，且明确全历史参与 hash；但 public `ReviewWorkspaceDto` 仍只有一个 `escalation` 及其单个 `answer`，没有正文所称的 `current open issue` 与 `answered history` 分离字段，也无法 strict 表达同一 result 两轮以上 continue 的回答历史。实现阶段仍需自行发明 workspace 契约，T-26 的“workspace 区分”没有 DTO 落点。→ 把 workspace 的 current open issue 与按稳定顺序返回的 immutable answered history 写成明确 strict DTO（包含 escalationId/answerId/action/version/createdAt，并绑定 result/attempt），并与 frozen `ownerAnswers` 的筛选、顺序和 hash 测试一一对应。
- [一般] 第 4 轮第 3 项未完全闭合（`design.md` §4.4 第 697～705 行、§8.1 第 1046～1061 行）: review/delivery 的 public-input application service、可信服务端派生、vault 边界和 acquire CAS identity 已有明确落点，但 operation hash 契约自相矛盾：§4.4 要求 request hash 不含 `operationId`，§8.1 又说 hash 包含“strict body”，而两个 strict body 都包含 `operationId`。这会让 receipt 冲突/重放的 canonical 输入在实现时仍需二选一，也不满足本轮要求的精确 path/body hash 边界。→ 为两个 service 分别列出 canonical hash tuple，并明确 `operationId` 只作 receipt key 还是也进入 hash；同步 T-24/T-27 的 same-id same/different-content 与 path-id 变化断言。

## 第 4 轮 Findings 闭合确认

- 第 1 项部分闭合：冻结材料已保存稳定排序的全部 immutable continue answers，回答链参与 canonical material hash，T-26 也覆盖两轮 continue、不同 attempt、刷新/重启与不可改写；但 workspace strict DTO 尚未表达 answered history。
- 第 2 项未闭合：已增加别名表并把事件兼容独立为 T-25，但表与现有 producer 的 type/payload 全集不一致，仍不能保证升级后历史可读。
- 第 3 项部分闭合：review/delivery application service 的服务端派生、凭据边界、内部字段防伪和 acquire CAS 已明确；operation hash 是否包含 `operationId` 仍矛盾。
- 第 4 项已闭合：旧 `t24-red-20260801T081018Z.log` 已明确仅作诊断且不计入任何新任务 RED；T-24～T-30 已拆成 review application、event compatibility、escalation 多轮链、delivery application/API、产品树 wiring、最薄 smoke 基础设施/pass 链、完整裁决/重启/双 viewport 链，均有独立先红后绿边界，且 T-24～T-30 inline 覆盖与覆盖索引一致。

# Design评审（第6轮）

- 日期: 2026-08-01
- 评审方式: subagent
- 结论: 需修改

## Findings

- [严重] 第 5 轮第 1 项仍未闭合（`design.md` §8.5 第 1329～1341 行）: type+payload variants 现已覆盖实际 producer，包括 `work_item_completion_invalidated`、同名不兼容的 pass/answer/discarded/started/failed、delivery completed/interrupted 及两种 invalidated；但关键历史派生仍不可信。`work_item_review_passed` 要从 review head“在该 headVersion 所指”事实派生 result/decision，`work_item_completion_invalidated` 要从该 work item 的 current head/“最近唯一 decision”派生，而两类事件之后 head 可继续递增、current result 可被返工新版替换，设计又没有 review-head 历史快照，重启后无法按所写查询恢复事件发生时的唯一 result/decision。两种 `mission_delivery_invalidated` 要与“当时 head”核对也有同样问题：current head 已在同事务被清空/递增，未定义可重建的持久时点。另有 `review_attempt_discarded.reason→category` 与 delivery `errorCode→category` 只引用未穷举的共享 mapping，尚未给出每个现有值的确定结果。→ 把派生锚定到不会漂移的持久事实，例如同 mission sequence 中严格在前且唯一匹配的 immutable decision/pass/started 事件、attempt/decision/delivery/operation row，并写出歧义与缺失判据；逐值列出 reason/errorCode mapping。若现存字段不足以唯一恢复，必须定义可审计 legacy canonical variant 或 migration `SCHEMA_DATA_INVALID`，不能查询当前 head 猜历史。T-25 应逐 variant 覆盖“事件后又发生返工/新版/再次交付再重启”的 DB→DTO round-trip。
- [一般] 第 5 轮第 2 项仍有内部矛盾（`design.md` §5.2 第 756～759 行、§8.2 第 1192～1224 行）: strict DTO 已加入 workspace/detail 的 `currentEscalation` 与 `answeredEscalations`，answered history 对 current result 的筛选、`(answer.createdAt,answer.answerId)` 排序及 `continue_review` 投影到 `ownerAnswers`/material hash 已闭合；但 §5.2 明确 escalate 后 `head.currentAttemptId=null`，§8.2 又要求 `currentEscalation` 绑定 current result/**current attempt**。在 `waiting_owner` 正向状态下 `currentAttempt` 必为 null，因此该 refine 按字面无法成立。→ 明确 open escalation 绑定的是 current result 与产生它的 immutable escalated attempt，而不是 head 的 currentAttempt；分别写清 workspace 与 attempt detail 的筛选（detail 是否只在该 escalated attempt 返回 open/answered 记录），并让 T-26 断言 `waiting_owner.currentAttempt=null` 仍可 strict 返回 open issue。
- [一般] 第 5 轮第 3 项只在正文闭合、任务验证未闭合（`design.md` §4.4 第 697～700 行、§8.1 第 1048～1061 行、T-24/T-27 第 1604、1607 行）: review/delivery 均已一致规定 `operationId` 仅作 receipt key，不进入 hash，canonical tuple 分别为 `["review.v1",workItemId,resultId,reviewerAgentId,expectedHeadVersion]` 与 `["delivery.v1",missionId,expectedHeadVersion]`，正文的 same/different/path 语义也一致；但 T-24 只要求 same-operation/checkpoint replay，T-27 只要求 same-operation 幂等，均没有第 5 轮要求的 same id + different tuple 以及仅 path id 变化的冲突/零副作用断言。→ 在 T-24、T-27 各自明确三组 route 级判据：same id + same tuple 返回原 receipt，same id + 任一非 path tuple 字段变化返回 `OPERATION_CONFLICT`，same id + path `workItemId|missionId` 变化也返回冲突；同时断言 provider/generation/attempt/receipt 之外业务副作用不增加。

## 第 5 轮 Findings 闭合确认

- 第 1 项部分闭合：现有 producer 的 type+payload variants 已列全，但若干转换仍依赖不可回溯的 current/“当时” head，reason/errorCode 的值域映射也未穷尽，不能证明历史 strict 可读。
- 第 2 项部分闭合：strict DTO、answered history、ownerAnswers 筛选/排序/hash 已有明确落点，但 open escalation 与已被清空的 currentAttempt 约束冲突。
- 第 3 项部分闭合：`operationId` receipt-only 与两个 canonical tuple 已统一；T-24/T-27 尚未同步 different-content/path-id 断言。

# Design评审（第7轮）

- 日期: 2026-08-01
- 评审方式: subagent
- 结论: 需修改

## Findings

- [一般] 新增阻塞（`design.md` §8.1 第 1059 行、§8.3 第 1240～1272 行）: `startPublicReview` 在服务端组装与 acquire 之间发生 head/material/reviewer config 漂移时明确返回 `REVIEW_CONTEXT_STALE`，但该 code 未进入设计声明的 S-6 唯一 error registry；错误矩阵没有它的 HTTP status、固定中文 message、event/blocker 与持久副作用，而相邻的 `MISSION_CONTEXT_CHANGED`、`DELIVERY_CONTEXT_CHANGED` 也不能按字面覆盖 review acquire 前的组装漂移。实现阶段仍需自行发明公开错误契约，且 strict route/receipt/UI 无法一一闭合。→ 将 `REVIEW_CONTEXT_STALE` 明确纳入 error matrix 和共享 mapping，并在 T-24 的组装漂移 route 判据中断言其 HTTP/code/message、零 provider/attempt/receipt/业务副作用；或改用已有且语义准确的 registry code，并同步正文与任务。

## 第 6 轮 Findings 闭合确认

- 第 1 项已闭合：两种 legacy canonical variant 明确保留旧投影而不猜 result/decision；每个实际 producer 的 payload variant 均以 payload 自身、同 mission 更小 sequence 的 immutable event，或 immutable attempt/operation/delivery row 转换，不读取 current head；唯一前驱缺失/重复或关联不一致 fail-closed。`reason`/`errorCode` 逐值闭合，未列值统一 `SCHEMA_DATA_INVALID`，T-25 覆盖后续返工、新 result、再次 delivery 与重启 round-trip。
- 第 2 项已闭合：open escalation 明确绑定 current result 与产生它的 immutable `status="escalated"` attempt；workspace 允许 `waiting_owner.currentAttempt=null` 时返回唯一 open issue。attempt detail 只对该产生 issue 的 escalated attempt 返回对应 open/answered 记录，其他 attempt 返回 null/空数组；answered history 与 frozen ownerAnswers 的 result 筛选、稳定顺序及 hash 投影一致，T-26 有直接判据。
- 第 3 项已闭合：T-24 与 T-27 均写明 route 级三组判据：same id + same tuple 返回原 receipt，same id + 非 path tuple 变化返回 `OPERATION_CONFLICT`，仅 path `workItemId|missionId` 变化也冲突；并分别约束 provider/attempt/receipt 外及 generation/delivery/receipt 外业务副作用不增加。

# Design评审（第8轮）

- 日期: 2026-08-01
- 评审方式: subagent
- 结论: 通过
- 用户确认: auto-approved 2026-08-01

## Findings

无

## 第7轮 Finding 闭合确认

- 已闭合：`REVIEW_CONTEXT_STALE` 已进入 §8.3 声明的 S-6 唯一 error registry，固定为 HTTP 409、code `REVIEW_CONTEXT_STALE`、中文 message“复核上下文已变化，请基于最新内容重试”、无 event，并明确组装/acquire 间 CAS 失败时 provider、attempt、receipt 及业务写均为 0。
- 已闭合：T-24 直接断言上述 HTTP/code/message 与零 provider/attempt/receipt/业务副作用，和 §8.1 application service 的漂移语义一致。
- 本轮按复审范围未发现新增阻塞。

# Design评审（第9轮）

- 日期: 2026-08-01
- 评审方式: subagent
- 结论: 需修改

## Findings

- [严重] `design.md` §12.1 T-30 fixture contract（第 1476 行）与任务 T-30（第 1615 行）: 所写 RED “旧测试自建 `user_version=6` 数据库缺 head 而被生产 validator 拒绝”在当前 WIP 前已经是生产既有行为，而 WIP 中 `tests/v6-fixture-db.ts` helper 也已经存在，因此按当前判据直接开始不会得到一个证明 helper 行为缺失的独立 RED。更重要的是，设计只靠“故意坏库、migration/invariant 测试绕过 helper”约束调用方；现有 helper 会捕获生产 `SCHEMA_DATA_INVALID`，对任意文件库补缺失 mission head 后再次调用生产 `openDatabase`，没有 fixture 身份、精确缺口 allowlist 或修复前完整前置校验。一旦故意坏库误经 helper，恰好缺 head 的生产不变量失败可被掩盖，不能证明 helper 与生产 validator 隔离。→ 把 helper 设计成显式 opt-in 的合法 fixture 构造/补种 primitive，而不是包裹生产 `openDatabase` 的通用自动修复入口；规定它只接受可机械识别的测试 fixture，并在补种前验证除明确允许缺口外的完整 schema/data，不得吞掉或改写其他 `SCHEMA_DATA_INVALID`。T-30 增加同一批故意坏库分别直连生产入口和误经 helper 仍 fail-closed、生产模块不导入 helper、helper 不改生产 validator/DB 的断言；同时明确如何撤销既有 WIP helper/迁移后先取得新 `t30-red`，或改用一个当前确实失败且先于修复的隔离契约作为 RED。

- [严重] `design.md` §12.1 证据说明（第 1479 行）、T-32（第 1617 行）与 Design Checklist 自检（第 1648 行）: 旧 T-30 WIP 的作废边界和重新 TDD 链没有闭合。第 1479 行仍写“T-30 再以场景覆盖缺失取得 RED”，与当前 T-30=fixture、T-32=full-chain 冲突；T-32 只声明旧 `t30-red/green` 为诊断，未覆盖同轮 `t30-build` 及随后失败的真实 `smoke`，也未防止旧精确 `t30-red/green` 被机械门禁误认成新 fixture 任务证据。当前 `tests/review-browser-full-chain.test.ts` 只是读取 harness 并匹配字符串，旧 RED/green 已证明这种 contract 可绿而真实 `smoke:review` 仍在 reject 终态 UI empty 处失败；而完整 reject/escalate/restart/narrow harness 代码也已由原 WIP 写入，T-31 修复后 T-32 按现有描述未必还能重新取得 RED。→ 明确列出原 T-30 全部 red/green/build 与对应 suite/smoke 的归属和作废语义，要求新 T-30、新 T-31、新 T-32 各自在本任务产品/测试改动前产生时间更晚、测试文件与行为唯一对应的新 RED，并规定人工复核不得仅凭 gate 对旧同名 label 的命中推进。T-32 的 RED 必须实际启动并执行真实 provider/Next/SQLite/browser 链，在缺少完整 reject→新 result→escalate→answer/new attempt→pass→memory→delivery→独立进程重启→desktop/narrow 键盘/截图任一运行行为时失败，不能再用源码字符串存在性代替；同时明确先撤销原 WIP full-chain 实现或选择一个当前真实缺失的运行行为取得 RED。同步修正第 1479 行和第 1648 行后，才能声称 T-1 至 T-32 均有明确独立红绿边界且覆盖索引/自检一致。

## 本轮其余核对

- T-31 的产品 surface 判定范围是最小且与故障事实一致：加载完成后，`currentEscalation`、成功动作或非空 terminal history 任一存在即为 ready；只有无 issue、无 history 才为 empty，同时保留 loading/error 优先级。其 inline 覆盖与任务覆盖索引一致。
- T-30、T-31、T-32 的 inline FR/NFR 覆盖与第 1619～1638 行逐项索引在集合上相互一致；当前不一致发生在第 1479 行任务编号、旧证据归属及第 1648 行“均有独立 RED”的自检结论。

# Design评审（第10轮）

- 日期: 2026-08-01
- 评审方式: subagent
- 结论: 需修改

## Findings

- [严重] 第 9 轮第 1 项未完全闭合（`design.md` §12.1 第 1476 行、T-30 第 1615 行）: 修订已要求 helper 为 test-only 显式 opt-in、仅处理 v6 head 缺口、在同一事务补种后调用生产 `validateV6`，并让带“额外”schema/data 损坏的库经 helper 仍回滚失败；当前 WIP 也确实能用这些新隔离断言取得 RED。但设计仍未定义可机械识别的 fixture 身份或允许缺口的精确实例集合，只写“唯一缺口为 mission delivery/review head”。因此一个故意验证“仅缺 mission/review head”生产不变量的坏库若误经 helper，恰好会被当成合法 fixture 补种并通过，而不是按第 9 轮要求仍 fail-closed；实现者仍需自行发明 fixture 标记、opt-in 签名以及哪些 mission/latest result head 可缺。→ 明确 helper 的公开测试签名与不可伪混的 fixture 身份（例如构造时生成并校验的 test-fixture marker/handle），把 allowlist 写成可判定的缺失 tuple：哪些 mission 可缺唯一 delivery head、哪些 work item 的当前 latest result 可缺唯一 review head，除此之外少/多/错配/已有部分 head 均拒绝；补种前先在同一事务验证 marker、`user_version=6`、完整 schema 与“仅这些精确缺口”数据谓词，补种后再以生产 `validateV6` 复核，任一步失败整笔回滚并原样抛错。T-30 必须包含“唯一损坏就是允许形状的缺 head、但没有合法 fixture 身份”的故意坏库，直连生产和误经 helper 都失败且行数不变。

## 第 9 轮 Findings 闭合确认

- 第 1 项部分闭合：显式 opt-in、事务补种后生产 `validateV6`、额外损坏回滚、生产模块不导入 helper，以及针对当前 WIP 可取得的新安全契约 RED 已落到 T-30；但 fixture 身份、精确实例 allowlist 与“仅缺 head 的故意坏库误经 helper仍失败”尚未闭合。
- 第 2 项已闭合：原 T-30 的全部 `t30-red/green/build`、对应三份 suite 与两份 smoke 已明确只作诊断；T-30/T-31/T-32 各需更晚且行为唯一的新 RED/GREEN。T-32 先恢复已提交 T-29 最薄 harness，再由测试真实 spawn `npm run smoke:review -- --full`，不再读取源码字符串，并覆盖完整 provider/Next/SQLite/browser、重启、desktop/narrow 与截图链。
- T-31 仍具有独立测试与 RED/GREEN 边界；T-30/T-31/T-32 inline 覆盖与任务索引一致，测试策略、任务描述和自检除上述 T-30 未闭合点外未发现冲突。

# Design评审（第11轮）

- 日期: 2026-08-01
- 评审方式: subagent
- 结论: 通过
- 用户确认: auto-approved 2026-08-01

## Findings

无

## 第10轮 Finding 闭合确认

- 已闭合：`design.md` §12.1 与 T-30 已固定测试 helper 签名为 `createV6FixtureHandle(path,{missingDeliveryHeadMissionIds,missingReviewHeadResultIds})` 返回由 module-private `WeakSet` 认证的 branded handle，且只有 `openV6FixtureDatabase(handle)` 可进入补种；普通 path/plain object 与无合法 handle 的库不能获得修复路径。
- 已闭合：allowlist 已收紧为实际缺口集合全等的精确 mission/result id 集合；mission 必须存在且唯一缺 delivery head，result 必须属于对应 project/work item、是当前 latest 且唯一缺 review head。少报、多报、重复、已有部分 head、非 latest 及跨 project/work-item/result 错配均拒绝。
- 已闭合：helper 在同一事务内依次验证 brand、`user_version=6`、完整 schema、实际缺口与 allowlist 全等，补种后调用生产 `validateV6`；任一步失败整体回滚并保持行数不变。T-30 明确覆盖仅缺 head 但无合法 handle 的故意坏库直连生产入口和误经 helper 均失败，且当前通用自动修复 WIP 恰能为该新隔离契约提供独立 RED。
- 可实现性成立：handle 身份、输入边界、缺口谓词、事务顺序、失败原子性、生产 validator 复核及测试命令均已具体到实现无需再发明关键安全语义，并与 T-30 的新 RED/GREEN 边界一致。
- T-31/T-32 无回归：T-31 的 terminal history ready/empty 判定与独立 RED/GREEN 保持不变；T-32 仍要求恢复 T-29 最薄 harness 后真实 spawn 完整 provider/Next/SQLite/browser 链取得新 RED，旧 T-30 证据只作诊断，任务覆盖索引与自检仍一致。
