# 在群聊发起使命并观察自主编排 技术设计

- 日期: 2026-07-29
- 规格: ./spec.md

## 1. 架构总览

S-4 增加“客户端驱动、服务端单轮原子提交”的持久编排器。浏览器在 run 为 running 时顺序调用一次 `advance`，每次服务端最多执行一个业务 turn（内部允许一次格式修复调用）；页面关闭不会丢状态，重新打开后从持久 run 恢复。没有后台 worker，也没有 workspace 工具。

```text
CollaborationCockpit
  ├─ ChatComposer / MentionPicker
  ├─ CollaborationTimeline
  ├─ BatonAndUsage
  ├─ DecisionRequest
  └─ RunControls
           ↓
collaboration Route Handlers + operation dedupe
           ↓
run-service / turn-orchestrator / action-committer
           ↓                 ↓
prompt-builder          openai-chat-client
           ↓                 ↓
S-3 context allowlist    S-2 vault/provider
           └────── SQLite v4 orchestration facts
```

新增:

- `src/server/collaboration/run-service.ts`: run/message/control/decision 状态机与写操作去重。
- `turn-orchestrator.ts`: 单 turn 获取占用、provider 调用、格式修复、finalize/CAS。
- `prompt-builder.ts`: 当前 Agent 私有配置 + prompt-safe shared + 公开消息窗口。
- `openai-chat-client.ts`: `/chat/completions`、manual redirect、90 秒 abort、1 MiB response、usage 校验与 sanitized errors。
- `agent-turn-schema.ts`: strict Zod 结构与业务动作预校验。
- `action-committer.ts`: 在一个数据库事务中验证并提交 Agent 消息、任务、领取和 disposition。
- `timeline-service.ts`: typed public event append/read、稳定 sequence、usage aggregate。
- `src/shared/collaboration-contracts.ts`: DTO、状态/事件/error code；无 provider secret/raw prompt。
- `components/collaboration/**`: 群聊、时间线、决策、usage、持棒者与控制。

## 2. 关键决策

### D-1: 执行载体
- 方案 A: Next 请求内一次跑完整自治循环。取舍: 调用简单，但长请求不可干预，崩溃恢复和 decision pause 困难。
- 方案 B: 每个 `advance` 只跑一轮，客户端在 running 时自动顺序推进。
- 选择: B。run/attempt 全部持久化；页面关闭只停止自动推进，不改变 run。每次外部模型调用都在 120 秒持久占用保护下，HTTP 客户端 90 秒先超时。

### D-2: 写操作幂等
- 方案 A: 各 endpoint 临时查询是否重复。取舍: 重试边界不一致。
- 方案 B: 所有 mutation 使用统一 operation receipt。
- 选择: B。客户端每个逻辑提交生成 UUID `operationId` 并在网络重试时复用；服务端保存 kind + SHA-256 canonical request hash + 状态/HTTP status/公开响应。相同 id/hash 返回原 status/body，相同 id/不同 hash → `OPERATION_CONFLICT`。`advance` 的 pending receipt 与 attempt 一一关联：未过 lease 时返回 `OPERATION_IN_PROGRESS`；finalize、失败路径或过期 reconcile 中只有 CAS 胜者可把 receipt 完成。所有 mutation handler 先 reconcile 本 run 的过期 attempt，因此原 operation 重发在 lease 到期后一定得到持久 `interrupted` 响应，不会永久 pending。

### D-3: Provider 调用与状态事务
- 方案 A: 数据库事务跨网络请求。取舍: 能锁住状态，但长事务会阻塞全部本地写入。
- 方案 B: 先短事务 acquire attempt/lease，网络在事务外，最后短事务 CAS finalize。
- 选择: B。finalize 必须匹配 attempt status、随机 lease token、run execution epoch 和 acquire context hash。普通 owner 消息不改变 execution epoch，因此可在 finalize 按稳定消息 sequence reconcile；pause/stop/retry 改变 epoch 并使旧结果失效。使命/看板事实变化使 context hash 失配并丢弃旧结果；非终态 run 存在时成员删除/替换被 membership service 拒绝。Agent/provider 配置更新不追溯取消已发出的请求，只影响下一 attempt。停止、暂停、过期、context 失配或已 finalize 时只记录允许的 call/usage 审计，不提交业务 turn。

### D-4: 模型动作语言
- 方案 A: 从自由文本猜任务与交棒。取舍: 兼容强但不可审计。
- 方案 B: strict JSON object + 一次 repair。
- 选择: B。可见 message 与 disposition 必填；unknown keys 拒绝。invalid raw response 只在内存中交给同一 provider repair，不写日志/数据库/DOM；两次无效即暂停。

### D-5: owner 优先
- 方案 A: owner 消息立即取消 calling request。取舍: 很多 provider 不支持可靠取消，可能产生幽灵结果。
- 方案 B: calling 不取消；owner 消息持久排队，在任何下一 provider 请求前进入 prompt，并按 spec 覆盖 disposition。
- 选择: B。attempt 记录启动时纳入 prompt 的最大 message sequence；成功业务提交后才把实际纳入窗口的 owner messages 标 consumed。失败/暂停时消息仍待消费。多个 pending mention 取 message sequence 最新者作为下一棒覆盖。

### D-6: prompt 历史
- 方案 A: 全量 timeline。取舍: 最多 50 轮 × 20k 字符，无确定上界。
- 方案 B: 完整使命/看板/active memory + 最近 30 条公开 chat 且总计≤60000 字符。
- 选择: B。按最新向前取整条消息，达到字符上限即停止，不截断单条；更早消息仅审计可见，不生成未经验证的摘要。prompt hash 持久化，raw prompt 不持久化。

## 3. 数据与状态

### 3.1 SQLite version 4

v3→v4 在验证完整 v3 后单事务创建:

```sql
CREATE TABLE collaboration_runs(
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN
    ('running','waiting_owner','paused','failed','planned','stopped')),
  current_agent_id TEXT NOT NULL REFERENCES agents(id),
  round_count INTEGER NOT NULL DEFAULT 0,
  next_event_sequence INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1,
  execution_epoch INTEGER NOT NULL DEFAULT 1,
  pause_reason TEXT,
  pause_category TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX collaboration_one_active_project
  ON collaboration_runs(project_id)
  WHERE status IN ('running','waiting_owner','paused','failed');

CREATE TABLE collaboration_operations(
  id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES collaboration_runs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','completed')),
  http_status INTEGER,
  response_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(project_id,id)
);

CREATE TABLE collaboration_project_sequences(
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  next_message_sequence INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE collaboration_messages(
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES collaboration_runs(id) ON DELETE SET NULL,
  author_type TEXT NOT NULL CHECK(author_type IN ('owner','agent')),
  author_agent_id TEXT REFERENCES agents(id),
  author_display_name TEXT NOT NULL,
  content TEXT NOT NULL,
  mention_agent_id TEXT REFERENCES agents(id),
  mention_display_name TEXT,
  sequence INTEGER NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(project_id,sequence)
);

CREATE TABLE collaboration_attempts(
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES collaboration_runs(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  operation_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN
    ('calling','committed','failed','interrupted','discarded')),
  lease_token TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  prompt_hash TEXT NOT NULL,
  acquire_execution_epoch INTEGER NOT NULL,
  acquire_context_hash TEXT NOT NULL,
  included_message_sequence INTEGER NOT NULL,
  error_category TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  UNIQUE(run_id,operation_id),
  FOREIGN KEY(project_id,operation_id)
    REFERENCES collaboration_operations(project_id,id)
);
CREATE UNIQUE INDEX collaboration_one_calling_attempt
  ON collaboration_attempts(run_id) WHERE status='calling';

CREATE TABLE collaboration_model_calls(
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES collaboration_attempts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('primary','repair')),
  call_index INTEGER NOT NULL CHECK(call_index IN (1,2)),
  status TEXT NOT NULL CHECK(status IN
    ('succeeded','provider_failed','response_invalid','usage_invalid')),
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  total_tokens INTEGER,
  error_category TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(attempt_id,call_index)
);

CREATE TABLE collaboration_turns(
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL UNIQUE REFERENCES collaboration_attempts(id),
  run_id TEXT NOT NULL REFERENCES collaboration_runs(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  round_number INTEGER NOT NULL,
  message_id TEXT NOT NULL UNIQUE REFERENCES collaboration_messages(id),
  disposition TEXT NOT NULL CHECK(disposition IN
    ('handoff','decision_request','plan_ready')),
  created_at TEXT NOT NULL,
  UNIQUE(run_id,round_number)
);

CREATE TABLE decision_requests(
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES collaboration_runs(id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL UNIQUE REFERENCES collaboration_turns(id),
  requesting_agent_id TEXT NOT NULL REFERENCES agents(id),
  question TEXT NOT NULL,
  options_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('open','answered')),
  answer TEXT,
  answer_message_id TEXT REFERENCES collaboration_messages(id),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  answered_at TEXT
);
CREATE UNIQUE INDEX collaboration_one_open_decision
  ON decision_requests(run_id) WHERE status='open';

CREATE TABLE collaboration_events(
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES collaboration_runs(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  type TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK(actor_type IN ('owner','agent','system')),
  actor_id TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(run_id,sequence)
);
```

项目另有单行 `collaboration_project_sequences(project_id PRIMARY KEY,next_message_sequence)`，在 owner/Agent 消息事务中分配稳定 message sequence。消息保存提交时 author/mention 显示名快照；改名或离组不改变历史，读取时可额外计算 `mentionMemberStatus`。messages 是跨 run 的项目公开对话事实，events 是单 run UI 审计事实；二者通过 payload 中的 `messageId/messageSequence` 关联，不靠时间戳拼接。event payload 只能由第 6 节对应 Zod public schema 生成，禁止任意 error/raw body 入库。

迁移协议不是“见缺补建”。打开 v3 时先用现有 validator 完整验证 projects/memberships/mission/work-items/memory 及列、FK、CHECK/index；不完整即 `SCHEMA_DRIFT` 且不写 DDL/user_version。完整 v3 才在一个 `BEGIN IMMEDIATE` 内创建全部 v4 对象、验证对象存在和 SQL 约束、设 `user_version=4` 并提交；任何 DDL/验证失败 rollback。打开 v4 时完整验证每张表、列、复合 FK、CHECK、三个 partial unique index 和 project message unique index；不自动修补。测试覆盖空 v3、含既有 S-3 数据、partial v3、漂移、DDL 故障回滚、重开幂等。

### 3.2 Run 状态机

```text
start -> running
running -> waiting_owner | paused | failed | planned | stopped
waiting_owner -> running (answer) | stopped
paused -> running (continue only manual pause, or retry after precondition) | stopped
failed -> running (explicit retry after repair) | stopped
planned/stopped -> terminal
```

- 每个 project 最多一个 active row。
- `current_agent_id` 在所有非终态始终是成员；handoff/mention/answer override 在同一事务变更。
- `planned` 只表示编排完成并交 S-5，不更新 mission/work item 为 done。
- manual pause 与 provider/budget pause 以 `pause_category` 区分；continue 只接受 manual，其他类别用 retry 并重新检查 provider/budget。

竞态与 revision 规则:

| calling 期间写入 | revision/guard | finalize |
|---|---|---|
| 普通 owner 消息 | 只分配 message/event sequence，不改 execution epoch | 接受业务动作；本 attempt 已纳入消息标 consumed，新消息留给下轮 |
| owner mention | 同上 | 接受任务/消息；按最新未消费 mention 覆盖 handoff/plan-ready 下一棒，decision 仍等待 |
| pause / stop | CAS run version 并递增 execution epoch | call/usage 可记，attempt discarded，原 advance receipt 完成为 discarded |
| retry / continue | 仅无 calling 时允许；递增 version/epoch | 不会与合法 calling finalize 并存 |
| 使命/任务 owner 编辑 | S-3 transaction 写入后事实 hash 改变 | acquire context hash 失配，动作 discard 并暂停 `context_changed` |
| 成员添加 | 允许；名册事实 hash 改变 | hash 失配，discard；下一 attempt 使用新名册 |
| 成员删除/替换 | 非终态 run 时拒绝 `COLLABORATION_ACTIVE` | current agent 成员不变量始终成立 |
| Agent/provider 配置或凭据更新 | 自身 version 递增，已 acquire snapshot 不撤销 | 本 attempt 按捕获配置完成；下一 attempt 使用新版本；删除 active run 任一成员/其 provider 被服务层拒绝 |

`version` 是公开状态 optimistic concurrency；消息追加不递增。`execution_epoch` 是旧 provider 结果失效令牌，只由 pause/stop/retry/continue 等执行控制递增。attempt 保存 acquire epoch、共享 context hash 和已纳入的最大 message sequence。finalize 的核心 CAS 为 `UPDATE collaboration_attempts ... WHERE id=? AND status='calling' AND lease_token=?`，随后断言 run `status='running' AND execution_epoch=?`、lease 未过期和当前 context hash 一致；每步必须检查 affected rows=1。

## 4. Provider 与 Prompt

### 4.1 Prompt allowlist

按顺序构造 OpenAI messages:

1. 平台 system：只要求可见结论/动作，不要求 chain-of-thought；附 strict output contract。
2. 当前 Agent system：自己的 role/systemPrompt、按配置顺序的技能 name/instructions、权限说明（S-4 工具全部 unavailable）。
3. 项目 context system：project id/name、`workspaceBound:true`（不含绝对 path）、公开平等 roster、mission/work items/dependencies、active memory。roster 只含公开 identity/skill names/permission summary，不含任何 Agent 私有 prompt/技能正文。
4. 最近公开 chat：稳定顺序最近 30 条且总≤60000 字符；owner mention 以 stable agent id/name 描述。
5. 当前 handoff/decision answer 作为公开 context；不含 raw provider response或内部 error。

出站测试 provider 域允许 Authorization bearer 和当前 Agent 私有 prompt；产品域禁止这些值。

### 4.2 Chat request/response

`POST <normalizedBaseUrl>/chat/completions`:

```json
{
  "model": "<agent.model>",
  "messages": [],
  "response_format": {"type": "json_object"}
}
```

- `redirect:"manual"`、90 秒 abort、response 最大 1 MiB。
- 所有 HTTP body（含错误）都以流式计数读取，最大 1 MiB；超限立即 abort，不持久化 body。2xx 要求 JSON、`choices[0].message.content` string 1..1MiB；非 2xx 不读取 content，只做错误分类与 usage 提取。
- usage 若存在必须是非负 safe integer 且 `total_tokens = prompt_tokens + completion_tokens`。2xx usage 缺失/无效 → `usage_invalid`；401/403/429/5xx body 中的合法 usage 仍累计，无/无效 usage 记 unreported 但不覆盖原错误类别；网络/超时无 response 一律 unreported。每次真实 HTTP 恰好插入一条 model-call，status 区分 `succeeded/provider_failed/response_invalid/usage_invalid`。
- HTTP/error 映射沿用 S-2并转为 spec category；logger 只写 correlationId/code/runId/attemptId。
- model call row 永不保存 URL、headers、raw request/response或 key。

### 4.3 Structured turn schema

```ts
type ProposedTask = {
  clientKey: string;          // 1..64, ^[A-Za-z0-9_-]+$
  title: string;              // S-3 bounds
  description: string;
  dependsOnKeys: string[];
};

type AgentTurn = {
  message: string;            // 1..20000 grapheme
  tasks: ProposedTask[];      // 0..20
  claim: null | (
    {source:"existing"; workItemId:string} |
    {source:"proposed"; clientKey:string}
  );
  disposition:
    | {type:"handoff"; targetAgentId:string; summary:string; reason:string}
    | {type:"decision_request"; question:string; options:string[]}
    | {type:"plan_ready"};
};
```

`.strict()` 全层拒绝 unknown keys。decision_request 要求 tasks=[]、claim=null；handoff/plan_ready 可带 tasks/claim。summary/reason 各 1..5000；question 1..1000；2..8 options、每项 1..500、trim 后唯一。

repair request只含原始 invalid content 与同一 schema 指令；不再附全量 project prompt。repair 合法结果替代 primary content；两个 call usage 都记录。

## 5. Turn 编排与原子动作

### 5.1 Acquire

`advance` 事务:

1. 处理同 operation receipt。
2. 检查 run=running、无 calling attempt、无 open decision。
3. 将已过 120 秒 calling attempt 标 interrupted、run paused(`interrupted`)、append event；本次 advance 返回暂停而不自动再 call。
4. 检查 50 rounds、current Agent token/handoff已达边界；命中则 run paused + event，不发 provider。
5. 在同一连接读取 current Agent、其版本化配置、项目 context snapshot/context hash 和截至当前最大 message sequence 的公开消息，构造不可变内存 prompt 与 hash，创建含 epoch/hash/sequence 的 calling attempt 和 pending operation，append `model_call_started`，提交事务。
6. 在事务外只使用 acquire 已生成的不可变 prompt 调用 provider，不重新读取事实。进程崩溃后不重建/重放该请求；lease 过期由 reconcile 中断，owner 显式 retry 创建新 operation/attempt。

### 5.2 Usage 与预算

- 每次 primary/repair 有合法 usage 都写 model call并计入 Agent/run aggregate，无论业务 turn 成功。
- 无 usage 的网络失败写 null + “未报告”；usage invalid 写 `usage_invalid` 并暂停。
- maxTokens 比较 Agent 在该 run 所有合法 model calls 的 total sum；调用前已达到则不 call，调用后越过则 attempt 标 discarded，保留 call/usage + `budget_exceeded` event，不写 message/turn/actions。
- maxHandoffs 只计已 committed handoff turns；50 只计 committed business turns；repair 不增加二者。

### 5.3 Action commit

finalize `BEGIN IMMEDIATE`:

1. CAS attempt calling + lease token；断言 lease 未过期，读取 run status/execution epoch 并重算 context hash。
2. 若 stopped → attempt discarded；若 paused →记录 call/usage后 discarded，不写业务动作。
3. 解析/repair 后先在内存完成**全部** schema 与领域校验。
4. Proposed tasks: clientKey 唯一；依赖只指同 batch key；调用 `createWorkItemBatchTx(db, projectId, expectedMissionId, proposals, actor)`。该 primitive 只接受现有连接、不 begin/commit/close，复用导出的 S-3 field/DAG validator，一次分配 ids 并插入完整 DAG，递增 mission version，返回 key→id。
5. Claim 调用 `claimWorkItemTx(db, projectId, workItemId, agentId, expectedWorkItemVersion)`；用条件 UPDATE 断言存在、todo、unassigned、依赖 done并递增 work-item version。owner 看板写与 finalize 都 `BEGIN IMMEDIATE`；先取得写锁者提交，后者基于 expected version 成功或 `ACTION_CONFLICT`，绝不覆盖。
6. disposition:
   - handoff: target 是其他成员，当前 Agent committed outgoing handoff 未超配置。
   - decision: 不含 tasks/claim；创建 open decision，run waiting_owner。
   - plan_ready: distinct committed Agent count≥2、mission task count≥1、claimed/in_progress count≥1。
7. 检查 calling 期间新增 pending owner messages:
   - handoff + 最新 mention → target 改 mention；普通 pending 保持 handoff target。
   - plan_ready + 任一 pending →不进入 planned，保持 running；最新 mention 改 current，否则保持 current。
   - decision →仍 waiting_owner，pending 不消费为答案。
8. 若所有校验通过，一次写 Agent message/turn/tasks/claim/disposition/events/round+1，标 attempt committed并完成原 advance receipt；只标记 sequence≤attempt.included_message_sequence 且确实进入 prompt 的 owner messages consumed。任何失败 rollback业务事实，再单独短事务 CAS 标 attempt failed、run paused(`action_invalid`)、error event并完成原 receipt。

### 5.4 Attempt 后到与暂停

- pause during calling立即将 run paused(manual)并写事件；finalizer只记录 call/usage，discard业务动作。
- stop立即终态；finalizer同样 discard。
- 过期 reconcile 可由 run 读取、任一 mutation 或显式 `POST /runs/:id/recover` 触发：同一事务 CAS attempt calling→interrupted、run→paused、写唯一 interrupted event，并把 attempt.operation_id 对应 pending receipt 完成为 `{attemptStatus:"interrupted",run...}`。recover 自身 operation receipt也独立完成。未过期返回 calling。
- provider/解析/usage/action 公开失败都在独立短事务完成 attempt 及其原 advance receipt；即使业务动作回滚也不遗留 pending。
- late finalizer 的 attempt CAS affected rows=0，只读取并返回原 operation 已持久 response；不得改 call、usage、event或receipt。若进程在 HTTP 完成后、model-call 落库前崩溃，reconcile 记 interrupted + usage unreported，不猜测已发生的外部响应。

## 6. API 契约

所有 mutation body 含 `operationId: UUID`；canonical request hash不含该字段。聊天使用 project 路由而不是把消息生命期绑到 run。

- `GET /api/projects/:projectId/collaboration?messageAfter=&eventAfter=` → `{run|null,projectMessagesPage,timelinePage,pendingDecision,usage,readiness}`
- `GET /api/runs/:runId/timeline?after=<sequence>&limit=1..200`
- `POST /api/projects/:projectId/runs` + `{operationId,message,mentionAgentId?}` 是 create-or-append：无 active run 时原子保存消息并创建 run，返回 201 `{created:true,run,message}`；已有 running/waiting/paused/failed run 时不创建第二行，原子追加消息并按 owner 优先规则处理，返回 200 `{created:false,run,message}`。planned/stopped 不算 active，因此该路由表示 owner 明确启动新 run并返回 201。
- `POST /api/projects/:projectId/messages` + `{operationId,content,mentionAgentId?}` → 始终保存 project chat；有 active run 时关联并排队，无 active run（包括 latest planned/stopped）时 `run_id=null`，返回 `{message,run:null}`且不复活/创建 run。
- `POST /api/runs/:runId/advance` + `{operationId}` → attempt/run/new events
- `POST /api/runs/:runId/recover` + `{operationId}` → attempt/run
- `POST /api/runs/:runId/decisions/:id/answer` + `{operationId,answer,mentionAgentId?,expectedVersion}` → run/decision
- `POST /api/runs/:runId/control` + `{operationId,action:"pause"|"continue"|"retry"|"stop"}` → run

公开 DTO:

```ts
type CollaborationRun = {
  id: string;
  projectId: string;
  status: "running"|"waiting_owner"|"paused"|"failed"|"planned"|"stopped";
  currentAgentId: string;
  roundCount: number;
  pauseCategory: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};
type UsageTotals = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  repairCalls: number;
  unreportedCalls: number;
  byAgent: Array<{agentId:string; promptTokens:number; completionTokens:number; totalTokens:number; handoffs:number}>;
};
type ProjectMessage = {
  id:string; sequence:number; runId:string|null; authorType:"owner"|"agent";
  authorAgentId:string|null; authorDisplayName:string; content:string;
  mentionAgentId:string|null; mentionDisplayName:string|null;
  mentionMemberStatus:"current"|"left"|null; createdAt:string;
};
type TimelinePage = {
  items: Array<{id:string;runId:string;sequence:number;type:TimelineEventType;
    actorType:"owner"|"agent"|"system";actorId:string|null;
    payload:TimelinePayload;createdAt:string}>;
  nextAfter:number|null;
};
type CollaborationApiError = {
  error: {
    code: CollaborationErrorCode;
    message: string;
    category?: RunErrorCategory;
    fields?: Record<string,string>;
    currentVersion?: number;
    correlationId?: string;
  };
};
```

Timeline event types 与精确 public payload（每种均 `.strict()`）:

- `run_started {messageId,messageSequence,currentAgentId}`；`owner_message {messageId,messageSequence,mentionAgentId,mentionDisplayName}`；`agent_message {messageId,messageSequence,agentId,agentDisplayName,turnId}`。
- `model_call_started {attemptId,agentId,kind}`；`model_call_succeeded {attemptId,kind}`；`model_call_failed {attemptId,kind,category}`；`usage_recorded {attemptId,kind,promptTokens,completionTokens,totalTokens,reported}`。
- `tasks_created {turnId,items:[{id,title,dependsOnIds}]}`；`task_claimed {turnId,workItemId,agentId}`；`handoff {turnId,fromAgentId,toAgentId,summary,reason,overriddenByMention}`。
- `decision_requested {decisionId,turnId,agentId,question,options}`；`decision_answered {decisionId,messageId,messageSequence,answer,nextAgentId}`。
- `boundary_paused {boundary:"tokens"|"handoffs"|"rounds",agentId,value,limit}`；`run_paused {category}`；`run_resumed {currentAgentId}`；`run_retried {currentAgentId}`；`run_planned {turnId}`；`run_stopped {}`。
- `attempt_interrupted {attemptId}`；`action_rejected {attemptId,category,missing:("participants"|"tasks"|"claim")[]}`；`context_changed {attemptId}`。

payload只含上述字段；公开文本沿用各字段边界，category为 contract enum，客户端按 category映射说明，不含 raw Error。timeline page只按 `(run_id,sequence)`，project messages page只按 `(project_id,sequence)`；`after` 不存在也返回大于它的下一项。

稳定错误:

- 400 `INVALID_JSON`, `INVALID_INPUT`, `STRUCTURED_OUTPUT_INVALID`, `ACTION_INVALID`
- 404 `PROJECT_NOT_FOUND`, `RUN_NOT_FOUND`, `DECISION_NOT_FOUND`, `AGENT_NOT_FOUND`
- 409 `CONTEXT_NOT_READY`, `COLLABORATION_ACTIVE`, `AGENT_NOT_MEMBER`, `TURN_IN_PROGRESS`, `RUN_STATE_CONFLICT`, `DECISION_ALREADY_ANSWERED`, `OPERATION_CONFLICT`, `OPERATION_IN_PROGRESS`, `ACTION_CONFLICT`, `BOUNDARY_REACHED`
- 401 `PROVIDER_AUTH`; 429 `RATE_LIMITED`
- 502 `PROVIDER_UPSTREAM`, `PROVIDER_UNREACHABLE`, `PROVIDER_RESPONSE_INVALID`
- 504 `PROVIDER_TIMEOUT`
- 503 `CREDENTIAL_UNAVAILABLE`, `STORAGE_UNAVAILABLE`
- 500 `INTERNAL_ERROR`

409 version 错误附 currentVersion；readiness 附固定顺序 missing；provider/action 错误只附稳定 code/category，未知内部错误再附 correlationId。

所有失败严格复用 `{error:{code,message,...}}` envelope。`code` 是 HTTP/API 稳定枚举并由 `apiErrorCopy` 消费；`category` 只在 provider、边界、结构动作或持久 run 失败时出现，是写入 run/event 的 lower-snake-case 分类。400 field 校验可带 allowlisted `fields`；409 optimistic conflict 可带 `currentVersion`；500/internal 可带 `correlationId`。除此之外拒绝 unknown public keys，绝不返回 raw cause/provider message。

新增 `collaborationErrorResponse(error, route)` 统一把领域错误映射为上述 status/body；存储异常调用现有 `storageErrorResponse`，未知异常调用现有 `internalErrorResponse`，两者保持脱敏。扩展共享 `ApiError` 可选字段和 `api-error-copy.ts` 的全部 collaboration `code`，客户端只按 `error.code` 取固定中文 copy，category 只用于状态详情的固定映射，不直接显示 `error.message`。operation receipt 保存 mapper 产出的精确 HTTP status 与 canonical JSON body；重复 operation 从 receipt 原样恢复，API 测试断言 status/body 深相等。

## 7. NFR 落点

| NFR | 满足机制 | 验证方式 |
|-----|---------|---------|
| NFR-1 Provider/prompt安全 | vault server-only；prompt allowlist；workspace path排除；raw prompt/response不持久；typed sanitized logger；public event schemas | 隔离 provider 出站检查 Authorization+当前 Agent allowlist；产品响应/DB/DOM/log/evidence secret/other-private扫描=0 |
| NFR-2 单持棒/幂等 | partial unique calling；lease token CAS；operation receipts；single transaction action commit；terminal discard | 并发 advance、duplicate operations、delayed finalizer、pause/stop/expiry/restart故障注入，成功计数断言 |
| NFR-3 可访问性 | 语义 feed/log、成员 mention combobox、非打断 live summary、44px/focus tokens、单 mobile surface | 组件语义/键盘测试、desktop/narrow真实浏览器完整操作 |

## 8. 错误处理与恢复

- Provider error → attempt failed、run paused，category按 spec；重试前服务重新检查 provider verified/key。
- structured/action invalid →不写业务 turn，保留 call/usage/error event；run paused，owner retry新 attempt。
- internal storage invariant → run failed；sanitized correlation only。
- decision answer、control、message 与 start都通过 operation receipt；相同 operation不同 body拒绝。
- client auto-loop在 response run=running时生成新 advance operation；等待/暂停/终态立即停止。
- timeline pagination只按 sequence，after不存在也返回下一可用；limit最大200。

## 9. 测试策略

- Migration: v3→v4、漂移/故障、active/calling unique与既有数据保留。
- Operations/run: start/message/all control/decision duplicate same/different body、active run、终态与version。
- Prompt: two Agents shared相同/current private不同，workspace path/other prompts/secret禁止，30/60000边界与hash稳定。
- Provider client:真实本地 server覆盖success/repair、usage、1MiB、redirect、auth/429/5xx/timeout/network、日志脱敏。
- Schema/action: strict组合、batch refs/DAG、claim、handoff、decision、plan_ready与整轮rollback。
- Concurrency: parallel advance、calling owner messages、pause/stop delayed result、lease expiry/recover、restart/late finalizer。
- Usage: primary/repair/invalid/retry/failure usage aggregate、unreported与pre/post budget。
- Components: chat loading/empty/error/draft、mention、timeline event kinds/baton/usage、decision、controls、auto-loop、scroll preservation、live announcement、narrow focus。
- Browser: local compatible provider returns scripted two-Agent valid/repair/decision flows；owner start/@/answer/pause/retry，tasks/claim/handoff/planned，refresh/restart；outbound/product domain scans与screenshots。
- Commands: `npm test`、`npm run build`、`npm run smoke:collaboration`。

## 10. UI 设计

### 信息架构
- 中栏切换为项目群聊/时间线主视图：run status header、当前持棒者、timeline feed、owner composer。
- 使命看板从中栏移动到右栏第一个 tab；其余 tabs 为共享记忆、决策、用量/运行。已有功能不消失。
- Timeline只展示真实 events/messages；model call显示“正在调用/已完成/失败分类”，不伪装为 Agent 发言。
- 当前持棒 Agent使用既有头像/accent + 明文“当前持棒”，所有成员仍无 leader/rank。

### 关键状态
- readiness empty: 列出 workspace/members/mission/provider缺项与真实修复入口。
- chat loading/empty/error；发送中 disabled但保留draft；成功后聚焦新 owner message/回composer按用户动作决定。
- auto running: advance进行中显示 current Agent与取消不可用说明；pause/stop仍可操作。
- waiting_owner: 决策 panel置顶，question/options/free text；普通 chat不冒充answer。
- paused/failed: category中文摘要、修复提示、retry/continue可用性按状态。
- planned/stopped: 终态 banner；composer仍可保存项目聊天，但明确“启动新协作”。
- timeline新增事件时，用户位于底部才自动滚动；否则显示“有新事件”按钮。

### Mention
- composer内“@成员”按钮打开语义 combobox/listbox；选择后插入不可歧义 mention chip，提交保存 agent id。
- Arrow/Enter/Escape与Tab可操作；已移出成员的历史mention仍显示旧公开名和“已离组”。
- 多个 mention首版只允许一个定向目标；普通文本中的 `@` 不自行解析。

### 运行/决策/usage
- run controls为明确按钮并有确认 stop dialog；同一窄屏覆盖区内不叠第二 modal。
- decision options用 radio fieldset，自由文本可替代；answer disabled原因明文。
- usage显示 run totals与按 Agent列表，prompt/completion/total、handoff、round与repair分开；未知usage显示“未报告”。
- 事件error不展示raw provider message。

### 视觉与可访问性
- 完全复用现有 tokens/accent；新增仅 timeline密度 token（`--timeline-gap`引用现有space）而非新色。
- timeline使用 `role=log`、每事件有可读heading/time/actor；非打断摘要独立 live region。
- status、usage、错误都有文本；控件≥44px、focus-visible。
- 窄屏通过统一 mobile surface在 chat / board / run detail间切换，任一时刻最多一个 modal；focus trap/inert/restore沿用 S-3 primitive。

## 11. 任务清单

- [x] T-1 打通 owner 消息→create-or-append→持久读取→最薄 UI 回显 (覆盖: FR-1, FR-9, FR-10, NFR-2) — 判据: `npm test -- tests/collaboration-slice.test.tsx` 先红后绿；只实现必要 v4 happy migration、最小 operation receipt、稳定 sequence、平等首棒、真实 API loading/empty/error、发送和刷新回显，且 duplicate submit 不重复
- [x] T-2 收紧 SQLite v4 迁移全部失败边界 (覆盖: FR-9, NFR-2) — 判据: `npm test -- tests/migrations-v4.test.ts` 先红后绿；完整/部分/漂移 v3、既有数据、DDL rollback、完整 v4 validator、重开幂等与 partial unique index 通过
- [x] T-3 泛化 operation receipt 与项目聊天终态语义 (覆盖: FR-1, FR-6, FR-9) — 判据: `npm test -- tests/collaboration-operations.test.ts tests/project-chat.api.test.ts` 先红后绿；所有 mutation same/different hash、精确 error status/body、无 active project message、终态不复活与显式新 run 通过
- [x] T-4 建立 run control 状态机 (覆盖: FR-6, FR-8, FR-9, NFR-2) — 判据: `npm test -- tests/collaboration-controls.service.test.ts` 先红后绿；pause/continue/retry/stop、version/epoch、类别前置条件、终态与并发 CAS 通过
- [x] T-5 建立 active collaboration 的上下文变更 guard (覆盖: FR-6, FR-9, NFR-2) — 判据: `npm test -- tests/collaboration-context-guards.test.ts` 先红后绿；使命/任务 hash 变化、成员添加 discard、成员/Agent/provider 删除阻止与配置更新下轮生效通过
- [x] T-6 实现 prompt allowlist 与历史边界 (覆盖: FR-1, FR-2, NFR-1) — 判据: `npm test -- tests/collaboration-prompt.test.ts` 先红后绿；两 Agent shared 相同、私有隔离、path/secret 排除、30/60000、snapshot/hash稳定通过
- [x] T-7 实现 OpenAI HTTP 与逐类 usage 解析 (覆盖: FR-2, FR-7, FR-8, NFR-1) — 判据: `npm test -- tests/openai-chat-client.test.ts` 先红后绿；2xx/401/403/429/5xx/timeout/network、错误 body usage、manual redirect、90s/1MiB、每请求一 call 与日志脱敏通过
- [x] T-8 实现 strict turn schema 与一次 repair (覆盖: FR-2, FR-3, FR-4, FR-5) — 判据: `npm test -- tests/agent-turn-schema.test.ts tests/structured-repair.test.ts` 先红后绿；组合/基数/unknown/边界、repair usage 与两次无效暂停通过
- [x] T-9 实现 attempt acquire 与单调用占用 (覆盖: FR-2, FR-9, NFR-2) — 判据: `npm test -- tests/turn-acquire.test.ts` 先红后绿；不可变 snapshot、epoch/hash/sequence、并发 advance、单 calling、边界 pre-check 与 pending receipt 通过
- [x] T-10 实现 attempt finalize/CAS 与 late discard (覆盖: FR-2, FR-6, FR-9, NFR-2) — 判据: `npm test -- tests/turn-finalize.test.ts` 先红后绿；成功/公开失败完成 receipt、pause/stop/context-change、lease/epoch/token CAS、affected rows 与 late finalizer 通过
- [x] T-11 实现 lease reconcile 与崩溃恢复 (覆盖: FR-6, FR-9, NFR-2) — 判据: `npm test -- tests/collaboration-recovery.test.ts tests/collaboration-recovery.api.test.ts` 先红后绿；读取/mutation/recover触发、120s、原 advance 完成、restart、重复 recover 和 unreported 通过
- [x] T-12 抽取 S-3 transaction-aware mission primitives (覆盖: FR-3, FR-4, NFR-2) — 判据: `npm test -- tests/mission-transaction-primitives.test.ts` 先红后绿；外部连接、不嵌套事务、field/DAG/mission/work-item version 与 owner 写竞争通过
- [x] T-13 原子提交任务提案与领取 (覆盖: FR-3, FR-4, NFR-2) — 判据: `npm test -- tests/agent-task-actions.test.ts` 先红后绿；batch key/DAG、existing/proposed claim、条件更新、整轮 rollback 与纯文本通过
- [x] T-14 原子提交交棒与 plan-ready (覆盖: FR-4, NFR-2) — 判据: `npm test -- tests/handoff-plan-ready.test.ts` 先红后绿；target/summary/reason、双 Agent、任务/领取条件、原子持棒与缺项拒绝通过
- [x] T-15 实现 usage aggregate 与三类边界 (覆盖: FR-7, FR-8) — 判据: `npm test -- tests/collaboration-usage-budget.test.ts` 先红后绿；primary/repair/error/unreported、Agent/run 聚合、token/handoff/50轮 pre/post 与超预算 discard 通过
- [x] T-16 实现决策请求与回答状态 (覆盖: FR-5, FR-6, FR-9) — 判据: `npm test -- tests/collaboration-decisions.test.ts` 先红后绿；open 唯一、answer/version/@、普通 chat 非答案、重启与 duplicate operation 通过
- [x] T-17 实现 calling owner 消息对 handoff/plan-ready 的覆盖 (覆盖: FR-1, FR-6, FR-9, NFR-2) — 判据: `npm test -- tests/owner-handoff-plan-races.test.ts` 先红后绿；普通/@、多个 mention、稳定 sequence、任务动作保留、plan 延期与消费窗口通过
- [x] T-18 实现 calling owner 消息对 decision 的排队 (覆盖: FR-1, FR-5, FR-6, FR-9) — 判据: `npm test -- tests/owner-decision-races.test.ts` 先红后绿；普通/@ 均不冒充答案、不覆盖请求、失败消息不消费与下一 prompt 顺序通过
- [x] T-19 完成 typed timeline/message/usage 读取 API (覆盖: FR-7, FR-9, NFR-1) — 判据: `npm test -- tests/collaboration-read-api.test.ts` 先红后绿；每类 strict payload、双 cursor page、显示名快照、aggregate、sanitized DTO 与重启读取通过
- [x] T-20 交付 chat composer 与 mention UI (覆盖: FR-1, FR-10, NFR-3) — 判据: `npm test -- tests/collaboration-chat.test.tsx` 先红后绿；三态/draft、单稳定 mention chip/快照、键盘 combobox、field/API error copy 与发送焦点通过
- [x] T-21 交付实时 timeline、持棒者与 auto-loop UI (覆盖: FR-2, FR-9, FR-10, NFR-3) — 判据: `npm test -- tests/collaboration-timeline-ui.test.tsx` 先红后绿；typed feed、scroll preservation、新事件/live、baton、单次 advance、停止条件与重试通过
- [x] T-22 交付决策、控制与 usage UI (覆盖: FR-5, FR-6, FR-7, FR-8, FR-10, NFR-3) — 判据: `npm test -- tests/collaboration-controls.test.tsx` 先红后绿；decision、所有 run state/control、disabled reason、usage/unreported 与 stop confirm通过
- [x] T-23 交付窄屏协作驾驶舱可访问性 (覆盖: FR-10, NFR-3) — 判据: `npm test -- tests/collaboration-accessibility.test.tsx` 先红后绿；单 mobile surface/modal、focus trap/restore/inert、44px、文本状态与 contrast token通过
- [x] T-24 收口真实两 Agent smoke/demo（只验证既有行为，不首次实现需求） (覆盖: FR-1 至 FR-10, NFR-1 至 NFR-3) — 判据: README、`npm test`、`npm run build`、`npm run smoke:collaboration` 通过；真实本地 HTTP 两 Agent 拆分/领取/交棒/@/决策/usage/planned与刷新恢复，outbound allowlist和产品域 secret/CoT 扫描，desktop/narrow demo 分别落盘
