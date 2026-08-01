# 同伴复核、记忆沉淀与结果交付技术设计

- 日期: 2026-08-01
- 规格: ./spec.md

## 1. 架构总览

S-6 在现有 S-3 使命看板、S-4 真实 provider 编排和 S-5 execution/result 之上增加一个独立的“复核与交付域”。该域不重新执行任务、不修改已 merged execution，也不让平台替 Agent 作业务判断；它只读取已持久的公开事实，冻结一次复核材料，调用 owner 明确选择的合格非执行者 Agent，并把 Agent 的唯一裁决原子地投影为任务完成状态、共享记忆和最终交付。

```text
MissionBoard / ExecutionPanel / MemoryPanel / DeliveryPanel
                         │
                         ▼
strict S-6 Route Handlers + operation receipts
                         │
         ┌───────────────┼─────────────────┐
         ▼               ▼                 ▼
 review-service   completion-gate   delivery-service
         │               │                 │
         ▼               ▼                 ▼
 review-material   mission-service   immutable manifest
 review-orchestrator      │
         │                └── all legacy write/replay paths
         ▼
 real provider call → strict parse → one repair → CAS finalize
         │
         ├── reject → rework head
         ├── escalate → owner issue / new attempt
         └── pass → decision + memories + task done (one transaction)
                         │
                         ▼
                    SQLite v6 facts
```

### 1.1 现有代码关系

复用:

- `openDatabase`、`migrateDatabase` 的逐版本、单事务、fail-closed schema 迁移模式。
- S-4 `canonicalRequestHash`、operation receipt、`callOpenAiChat`、provider/vault、strict JSON 与一次 repair 模式。
- S-5 `BEGIN IMMEDIATE`、短事务 acquire/事务外外部动作/CAS finalize、120 秒 lease、30 秒 heartbeat、90 秒单次 provider timeout、model-call usage、stable event sequence、bounded read API 与 HMAC cursor 模式。
- S-5 merged execution、validation、artifact、staged result、merge journal 与 execution event 作为只读复核来源。
- S-3 mission/work item、project membership、memory 历史和既有 owner 创建入口。
- 现有 `TaskPanel`、`ExecutionPanel`、`ExecutionReview`、`MemoryPanel`、`useModalSurface`、`useNarrowMode` 与 `app/tokens.css`。

新增:

- `src/server/migrations-v6.ts`: v5→v6 原子迁移、严格 schema/data validator、不可变触发器。
- `src/shared/review-contracts.ts`: strict S-6 DTO、事件、错误和 mutation schema。
- `src/server/review/review-material.ts`: 冻结公开材料、版本指纹和 prompt allowlist。
- `src/server/review/review-schema.ts`: review Agent 公开输出与一次 repair 的 strict schema。
- `src/server/review/review-orchestrator.ts`: acquire、真实 provider 调用、heartbeat、finalize、late discard、reconcile。
- `src/server/review/review-service.ts`: 资格、attempt/read/history、退回/升级/通过事务。
- `src/server/review/completion-gate.ts`: 所有任务/使命完成写入口共享的唯一门槛。
- `src/server/review/memory-committer.ts`: 候选验证、actor/source、确定性去重和 supersedes。
- `src/server/review/delivery-service.ts`: 最终交付 fingerprint、摘要和 evidence manifest。
- `src/server/review/review-events.ts`: strict append/read 与稳定 sequence。
- `components/review/**`: 复核工作区、升级回答、历史、交付和关联导航。

依赖方向固定为 UI → route → domain service → transaction primitive。`review-service` 可以调用 transaction-aware completion/memory primitive；`mission-service` 的全部状态写入必须反向调用 completion gate，但 memory/delivery 不依赖 UI 或 route。provider client 不接触数据库，review orchestrator 不把原始 provider body交给任何产品读取接口。

### 1.2 核心事实与派生状态

- result version 是不可变业务材料；“当前 result”和其复核状态只由 work-item review head 指向。
- review attempt 冻结一个 result version 和一份公开材料；attempt 的三种业务终态各有且仅有一个 immutable decision。
- work item 的 S-3 `status` 继续用于看板兼容，但 `done` 只是 completion gate 成功后的投影；复核有效状态从 review head 唯一派生。
- mission 的成功状态由 mission delivery head 唯一表示；`completed` 必须指向一份完整 immutable delivery。
- memory entry 是 immutable version；active 由“没有后继 supersedes 行”派生，不用可被客户端改写的布尔列。
- event、attempt、decision、memory、delivery 均保留稳定 id/version 引用；历史详情永远按原版本导航。

## 2. 关键决策

### D-1: 复核是否复用 S-4 collaboration run

- 方案 A: 把复核做成新的 collaboration turn/disposition。取舍: 可复用 run UI，但 S-4 的单持棒、任务提案和 plan-ready 状态机与逐 result 独立复核不同；会让 owner 选择 reviewer、一个 result 一个 attempt 和业务裁决变成隐式聊天动作。
- 方案 B: 新建 review attempt 域，只复用 provider、usage、lease、receipt 和 strict-output 基础设施。取舍: 多一组表和服务，但 result/reviewer/decision 关系可由 FK、unique index 和 CAS 直接证明。
- 选择: B。S-4 公开消息可作为带版本引用的相关材料，但不是裁决入口；只有 S-6 review attempt 能形成复核裁决。

### D-2: review 能力如何机械判定

- 方案 A: 从 role、system prompt 或 skill 自由文本中做关键词推断。取舍: 无迁移，但不同语言/措辞会产生不可审计的资格差异，平台实质上在暗中判断。
- 方案 B: Agent 配置增加显式 `reviewCapable` 布尔能力；v6 对既有 Agent fail-closed 回填 `false`，owner 可在既有 Agent 配置中明确开启。取舍: 需要扩展团队 DTO/UI，但资格规则确定、可审计且不猜测旧文本。
- 选择: B。候选资格为 `current membership && reviewCapable=true && agentId != result.executorAgentId`。该字段实现规格“角色或技能配置明确具备 review 能力”的可观察配置，不从模板名或 role 文本推断；内置 reviewer 模板创建新 Agent 时显式预选，保存后仍是普通可编辑能力。

### D-3: result 版本与复核状态存储

- 方案 A: 在原 `work_item_execution_results` 行上更新 status、decision 和 current 标志。取舍: 改动少，但旧 merged result 会被反复改写，返工/补证和并发 attempt 无法证明不可变。
- 方案 B: result rows immutable；每个 work item 一行 mutable head 指向最新 result、current attempt 和 current state。取舍: 需要 pointer CAS 与 validator，但历史材料不变且任一时刻只有一个 current relationship。
- 选择: B。v5 result 原子迁为 version 1；以后每次新 merged execution 插入 version `prior+1`、`supersedesResultId=prior`，再 CAS 移动 head。旧 result 不更新；head state 驱动 `pending_review/reviewing/rework/waiting_owner/passed`。

### D-4: provider 调用事务边界

- 方案 A: 在 `BEGIN IMMEDIATE` 中调用 provider。取舍: 状态直观，但最长两次 90 秒调用会阻塞整个本地数据库。
- 方案 B: 短事务 acquire attempt/operation/lease，事务外真实调用，短事务 CAS finalize。取舍: 需要 lease/context hash/reconcile，但与 S-4/S-5 已验证模式一致。
- 选择: B。调用期间每 30 秒把 lease 延到 `now+120s`；每个 primary/repair 仍独立 90 秒 timeout，最多一次 repair。provider output checkpoint必须匹配 attempt=`calling`、lease token、未过期 lease、review-head/current result/material/context和 reviewer资格；后续 business finalize只接受 attempt=`finalizing`与 checkpoint hash，不再接触 provider。

### D-5: 结构修复与 usage

- 方案 A: 任何 schema 错误立即失败。取舍: 实现简单，但偏离 S-4/S-5 已有一次 repair 契约。
- 方案 B: primary invalid 时用同一 provider/model 做一次只含 schema 指令和 invalid content 的 repair。取舍: 多一次真实调用和 usage，但仍有确定上界。
- 选择: B。raw invalid content只存在于当前请求内存；不写 DB、event、log、DOM。每个调用单独落 model-call 状态和可信 usage；2xx usage 缺失/不一致是 `usage_invalid`，整个 review attempt 无裁决失败。两次无效也是无裁决失败。

### D-6: 通过裁决与记忆提交原子性

- 方案 A: 先完成任务，再异步写 memories。取舍: UI快，但会出现任务完成而记忆缺失。
- 方案 B: decision、validated candidates、memory reuse/create/supersede、review head passed、work item done、events 在一个 `BEGIN IMMEDIATE` 中提交。取舍: 事务更大，但全部是本地有界写入且满足零部分成功。
- 选择: B。provider 调用已在事务外完成；finalize 前先在内存完成全部 candidate/source/supersedes 校验，事务中只做精确查询和写入。

### D-7: memory 去重与 active 历史

- 方案 A: 为 content 做 Unicode normalize/case-fold 或相似度匹配。取舍: 看似减少重复，但引入规格外阈值并破坏 code point 可观察性。
- 方案 B: 在 `BEGIN IMMEDIATE` 中按完整 tuple 精确查询 active entry：type、trimmed content 原 code point、source type/id/version。取舍: 补充内容可能形成多个条目，但规则确定且符合 A-65。
- 选择: B。`dedupeHash` 只是 canonical tuple 的 SHA-256 索引辅助，命中后仍逐字段全等确认；不得仅凭 hash 合并。supersedes 必须指向同项目/同类型、当前无后继的唯一 entry；新 row保存 parent/chain/version，旧 row不更新。

### D-8: 使命交付由模型生成还是确定性组装

- 方案 A: 再调用一个 Agent撰写最终摘要。取舍: 文案可能更自然，但规格没有新增交付 Agent/调用，且带来新失败、usage和作者问题。
- 方案 B: 服务端从已通过 decision 的公开 summary/limitations及精确证据引用确定性组装摘要和 manifest。取舍: 文案模板化，但输入、版本和重试 fingerprint完全可核对。
- 选择: B。交付生成没有 provider 调用；summary 是已批准公开字段的稳定组合，evidence manifest 是 typed version references。相同 input fingerprint 重试返回同一 current delivery。

### D-9: 旧看板 `done` 兼容

- 方案 A: 删除旧 transition endpoint，只允许新 review endpoint写 done。取舍: 边界最窄，但旧客户端/replay会变404，无法验证“所有旧入口服从同一门槛”。
- 方案 B: 保留 route/DTO，所有 `toStatus=done` 在 transaction 内调用同一个 completion predicate；不满足时稳定拒绝，满足时返回已有 passed 投影而不制造新裁决。
- 选择: B。Agent action、owner 看板、内部 primitive、旧 operation replay均进入相同 guard。任何写层不得直接执行 `UPDATE work_items SET status='done'`。

### D-10: 任务重开和依赖失效

- 方案 A: 继续沿用 S-3“有 active downstream 时禁止重开”。取舍: 实现小，但不能闭合已通过依赖重开后交付失效。
- 方案 B: 合法重开在一个事务中把目标及其传递下游的 effective head转为 rework，board投影为 in_progress，并使 current delivery失效。取舍: 影响多个 task，但关系可由 DAG 确定且旧裁决/交付仍只读。
- 选择: B。重开不改 result/decision/delivery row；只移动 mutable heads、递增版本并 append invalidation events。下次完成必须由新 execution→new result→new review。

## 3. SQLite v6、状态与不可变版本

### 3.1 迁移协议

`migrateDatabase` 支持最高版本改为 6，并导入 `createV6/validateV6/hasAnyV6Object`：

1. 打开 v5 时先运行完整 v1-v5 validator；失败返回既有 `SCHEMA_DRIFT` 或 `SCHEMA_DATA_INVALID`，不写任何 v6 DDL。
2. 若发现任一 v6 object 但 `user_version=5`，返回 `SCHEMA_DRIFT`，不“见缺补建”。
3. 一个 `BEGIN IMMEDIATE` 内执行:
   - `agents ADD COLUMN review_capable INTEGER NOT NULL DEFAULT 0 CHECK(review_capable IN (0,1))`；重建严格 validator 期望列。
   - 把 v5 `work_item_execution_results` 改名为迁移临时表，创建 v6 immutable result 表并按 `(work_item_id,created_at,id)` 稳定顺序回填连续 version；正常 v5 每 execution 唯一，首条为 version 1。
   - 为每个有 result 的 work item 创建 review head，指向最后一版并置 `pending_review`；不把任何 v5 `work_items.status='done'` 视为复核通过。
   - 重建 memory entries为 v6形态；既有 owner rows保持 id/content/source/supersedes/history，`sourceVersion=null`、actor=`owner`、chain/version按现有 supersedes DAG稳定回填。
   - 为每个 mission创建 delivery head：既有 mission均为 `ongoing`；不从旧 work item done推导 mission completed。
   - 创建其余 review/model-call/decision/escalation/memory-candidate/operation/event/delivery表、index和immutable trigger。
   - 运行 `validateV6`、`foreign_key_check` 和数据不变量检查；全部通过后设置 `PRAGMA user_version=6`。
4. 任一 DDL、回填或 validator故障回滚整个事务，数据库仍是完整 v5。
5. 打开 v6 时完整验证，不自动修复；比支持版本更高继续 `SCHEMA_TOO_NEW`。

v5 中若存在 `work_items.status='done'`，迁移保留其原看板历史值但 v6 completion gate在首次读取时公开 `effectiveStatus="executing"` 与 blocker `LEGACY_DONE_UNREVIEWED`，并在同一迁移把 board status降为 `in_progress`。这是防止旧 done冒充复核通过的 fail-closed 数据转换，不生成 result、decision或 memory。

全新 v6 数据不依赖迁移回填:

- `createMission` 的原有 mission insert 与 `initializeMissionDeliveryTx` 在同一个 `BEGIN IMMEDIATE` 中提交。后者插入唯一 `mission_delivery_heads(missionId,projectId,state='ongoing',contextVersion=1,nextEventSequence=1,version=1)`，随后分配 sequence 1 写 `mission_review_initialized` 并把 next sequence推进到2；mission/head/event任一失败，mission创建整体回滚。
- work item创建时不伪造 result/review head；无 result 的任务按 §3.5派生为 `executing`。首次 S-5 merge 的原有 execution/result/journal事务调用 `initializeFirstResultHeadTx`：先插 result version 1，再以 work-item PK插 review head `pending_review/currentResultId/version=1`，并使用所属 mission delivery head的 next sequence写 `result_version_created`。两个并发首次 merge只有取得 execution/project merge既有锁且成功插入唯一 work-item head者提交；输家整笔 rollback并返回 `REVIEW_STATE_CONFLICT`，不能留下第二个 version 1或无 head result。
- 返工 merge只走既有 head CAS；首次 merge禁止假装 prior head=`executing`。`initializeFirstResultHeadTx` 与 `advanceResultHeadTx` 是两个显式 primitive，调用方不能临场选择模糊 upsert。
- `createMission`、first merge、迁移回填三条路径产生相同 FK/版本不变量；测试必须从全新 v6 project/mission/work item走完首次 execution→merge→review→delivery，不能只用迁移 fixture。

### 3.2 核心表

以下是实现必须遵守的逻辑结构；字段名即实现契约。

```sql
CREATE TABLE work_item_result_versions(
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version>=1),
  execution_id TEXT NOT NULL UNIQUE,
  staged_result_id TEXT NOT NULL UNIQUE,
  merge_journal_id TEXT NOT NULL UNIQUE,
  supersedes_result_id TEXT,
  executor_agent_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(work_item_id,version),
  UNIQUE(work_item_id,id),
  FOREIGN KEY(project_id,mission_id,work_item_id,execution_id)
    REFERENCES executions(project_id,mission_id,work_item_id,id),
  FOREIGN KEY(work_item_id,supersedes_result_id)
    REFERENCES work_item_result_versions(work_item_id,id)
);

CREATE TABLE work_item_review_heads(
  work_item_id TEXT PRIMARY KEY REFERENCES work_items(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  current_result_id TEXT,
  current_attempt_id TEXT,
  state TEXT NOT NULL CHECK(state IN
    ('executing','pending_review','reviewing','rework','waiting_owner','passed')),
  version INTEGER NOT NULL CHECK(version>=1),
  updated_at TEXT NOT NULL,
  FOREIGN KEY(work_item_id,current_result_id)
    REFERENCES work_item_result_versions(work_item_id,id)
);

CREATE TABLE review_operations(
  id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN
    ('start_review','answer_escalation','generate_delivery','terminate_mission')),
  parent_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','completed')),
  http_status INTEGER,
  response_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(project_id,id)
);

CREATE TABLE review_attempts(
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  result_id TEXT NOT NULL,
  reviewer_agent_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN
    ('calling','finalizing','rejected','escalated','passed',
     'failed','interrupted','discarded')),
  lease_token TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  frozen_material_json TEXT NOT NULL,
  frozen_material_hash TEXT NOT NULL,
  prompt_hash TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  provider_version INTEGER NOT NULL,
  credential_generation INTEGER NOT NULL,
  verified_at TEXT NOT NULL,
  model TEXT NOT NULL,
  parsed_output_json TEXT,
  parsed_output_hash TEXT,
  output_checkpointed_at TEXT,
  finalize_error_code TEXT,
  error_category TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  UNIQUE(project_id,operation_id),
  FOREIGN KEY(project_id,operation_id)
    REFERENCES review_operations(project_id,id),
  FOREIGN KEY(work_item_id,result_id)
    REFERENCES work_item_result_versions(work_item_id,id),
  CHECK(
    (status='finalizing' AND parsed_output_json IS NOT NULL
      AND parsed_output_hash IS NOT NULL AND output_checkpointed_at IS NOT NULL)
    OR status<>'finalizing'
  ),
  CHECK(
    (parsed_output_json IS NULL AND parsed_output_hash IS NULL
      AND output_checkpointed_at IS NULL)
    OR
    (parsed_output_json IS NOT NULL AND parsed_output_hash IS NOT NULL
      AND output_checkpointed_at IS NOT NULL)
  )
);
CREATE UNIQUE INDEX review_one_active_result
  ON review_attempts(result_id) WHERE status IN ('calling','finalizing');

CREATE TABLE review_model_calls(
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES review_attempts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('primary','repair')),
  call_index INTEGER NOT NULL CHECK(call_index IN (1,2)),
  status TEXT NOT NULL CHECK(status IN
    ('calling','succeeded','provider_failed','response_invalid',
     'usage_invalid','interrupted','discarded')),
  prompt_hash TEXT NOT NULL,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  total_tokens INTEGER,
  error_category TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  UNIQUE(attempt_id,call_index),
  CHECK(total_tokens IS NULL OR total_tokens=prompt_tokens+completion_tokens)
);

CREATE TABLE review_decisions(
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL UNIQUE REFERENCES review_attempts(id),
  result_id TEXT NOT NULL,
  reviewer_agent_id TEXT NOT NULL,
  choice TEXT NOT NULL CHECK(choice IN ('reject','escalate','pass')),
  public_summary TEXT NOT NULL,
  findings_json TEXT NOT NULL,
  evidence_refs_json TEXT NOT NULL,
  limitations_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE review_memory_candidates(
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES review_attempts(id),
  position INTEGER NOT NULL CHECK(position>=0),
  type TEXT NOT NULL CHECK(type IN ('decision','fact','artifact','experience')),
  content TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK(source_type IN
    ('task','result','review','validation','artifact')),
  source_id TEXT NOT NULL,
  source_version TEXT NOT NULL,
  supersedes_memory_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(attempt_id,position)
);

CREATE TABLE review_memory_associations(
  candidate_id TEXT PRIMARY KEY REFERENCES review_memory_candidates(id),
  decision_id TEXT NOT NULL REFERENCES review_decisions(id),
  memory_id TEXT NOT NULL REFERENCES memory_entries(id),
  outcome TEXT NOT NULL CHECK(outcome IN ('reused','created','superseded')),
  created_at TEXT NOT NULL
);

CREATE TABLE review_escalations(
  id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL UNIQUE REFERENCES review_decisions(id),
  work_item_id TEXT NOT NULL,
  result_id TEXT NOT NULL,
  question TEXT NOT NULL,
  options_json TEXT NOT NULL,
  evidence_refs_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE review_escalation_answers(
  id TEXT PRIMARY KEY,
  escalation_id TEXT NOT NULL UNIQUE REFERENCES review_escalations(id),
  operation_id TEXT NOT NULL,
  answer TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN
    ('continue_review','rework','terminate_mission')),
  created_at TEXT NOT NULL
);
```

Review attempt row的 frozen material、provider identity和 lease token在 acquire 后不再被业务更新；允许且仅允许 `calling→finalizing` 写一次 durable parsed-output checkpoint，随后 `finalizing→业务终态|discarded`。checkpoint只含 strict-parse、secret/CoT扫描通过且 canonical redacted 的公开结构 JSON与 SHA-256，不含 raw provider response、prompt或私有推理。decision、candidate、escalation、answer 由 trigger禁止 UPDATE/DELETE，除非 parent project已删除并由 FK cascade清理。

### 3.3 Memory v6

```sql
CREATE TABLE memory_entries(
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  chain_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version>=1),
  type TEXT NOT NULL CHECK(type IN
    ('goal','decision','fact','artifact','experience')),
  content TEXT NOT NULL,
  dedupe_hash TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK(source_type IN
    ('owner_input','work_item','artifact_path',
     'task','result','review','validation','artifact')),
  source_id TEXT NOT NULL,
  source_version TEXT,
  proposer_actor_type TEXT NOT NULL CHECK(proposer_actor_type IN ('owner','agent')),
  proposer_actor_id TEXT,
  confirming_review_attempt_id TEXT,
  persistence_actor TEXT NOT NULL CHECK(persistence_actor='platform'),
  supersedes_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(project_id,id),
  UNIQUE(chain_id,version),
  FOREIGN KEY(project_id,supersedes_id)
    REFERENCES memory_entries(project_id,id),
  FOREIGN KEY(confirming_review_attempt_id)
    REFERENCES review_attempts(id),
  CHECK(
    (proposer_actor_type='owner' AND proposer_actor_id IS NULL
      AND confirming_review_attempt_id IS NULL)
    OR
    (proposer_actor_type='agent' AND proposer_actor_id IS NOT NULL
      AND confirming_review_attempt_id IS NOT NULL
      AND source_version IS NOT NULL)
  )
);
CREATE INDEX memory_v6_dedupe
  ON memory_entries(project_id,type,dedupe_hash);
```

- `content` 保存 trim 后原 code point序列；不做 NFC/NFKC、大小写或内部空白变换。
- canonical dedupe input是 UTF-8 JSON array
  `[type,content,sourceType,sourceId,sourceVersion]`，`dedupe_hash=SHA-256`。
- active entry 是不存在 `child.supersedes_id=entry.id` 的 row。
- reuse 查询必须同时满足 active、hash 和五字段逐项全等。
- owner legacy `sourceVersion=null` 保持旧语义；Agent 自动 candidate必须有非空精确 source version。
- Agent candidate的 proposer为 selected reviewer；confirming attempt必须是同 Agent的 pass decision；platform只显示 persistence actor。
- `goal` 对 owner入口继续可写；review Agent candidate schema不接受 goal。

### 3.4 Mission delivery

```sql
CREATE TABLE mission_delivery_heads(
  mission_id TEXT PRIMARY KEY REFERENCES missions(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  context_version INTEGER NOT NULL CHECK(context_version>=1),
  state TEXT NOT NULL CHECK(state IN
    ('ongoing','generating','completed','owner_terminated')),
  current_delivery_id TEXT,
  current_operation_id TEXT,
  generation_lease_token TEXT,
  generation_lease_expires_at TEXT,
  last_error_code TEXT,
  next_event_sequence INTEGER NOT NULL CHECK(next_event_sequence>=1),
  version INTEGER NOT NULL CHECK(version>=1),
  updated_at TEXT NOT NULL,
  FOREIGN KEY(mission_id,current_delivery_id)
    REFERENCES mission_deliveries(mission_id,id),
  CHECK(
    (state='generating' AND current_operation_id IS NOT NULL
      AND generation_lease_token IS NOT NULL
      AND generation_lease_expires_at IS NOT NULL)
    OR
    (state<>'generating' AND current_operation_id IS NULL
      AND generation_lease_token IS NULL
      AND generation_lease_expires_at IS NULL)
  )
);

CREATE TABLE mission_deliveries(
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version>=1),
  input_fingerprint TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  evidence_manifest_json TEXT NOT NULL,
  supersedes_delivery_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(mission_id,version),
  UNIQUE(mission_id,id),
  UNIQUE(mission_id,input_fingerprint),
  FOREIGN KEY(mission_id,supersedes_delivery_id)
    REFERENCES mission_deliveries(mission_id,id)
);

CREATE TABLE review_events(
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK(sequence>=1),
  type TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK(actor_type IN ('owner','agent','system')),
  actor_id TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(mission_id,sequence)
);
```

`mission_deliveries`、`review_events` 使用 immutable trigger。SQLite 建表时先创建 `mission_deliveries` 再创建含该 FK 的 head（上方按概念依赖展示）。delivery head是唯一 mutable pointer；`state='completed'` iff `current_delivery_id` 非空，`generating` iff `current_operation_id` 指向 pending generate operation且 generation lease完整，`owner_terminated` 永不指向成功 current delivery。

### 3.5 状态机

Result/head:

```text
new merged result -> pending_review
pending_review -> reviewing                   (owner start + acquire)
reviewing -> pending_review                   (provider/schema/usage failure)
reviewing -> rework                           (reject)
reviewing -> waiting_owner                    (escalate)
reviewing -> passed                           (pass + memory commit + work_item done)
reviewing -> pending_review                   (discarded stale/late)
waiting_owner -> pending_review               (answer continue; next attempt required)
waiting_owner -> rework                       (answer requests rework/evidence)
rework -> pending_review                      (new execution merged -> new result)
passed -> rework                              (dependency/material/reopen invalidation)
```

Attempt:

```text
calling -> finalizing                         (durable public output checkpoint)
calling -> failed | interrupted | discarded
finalizing -> rejected | escalated | passed
finalizing -> discarded                      (material/mission/context stale)
all terminal; never reopen or append second decision
```

Mission:

```text
ongoing -> generating                         (all completion blockers empty)
generating -> completed                       (delivery row + head atomically finalize)
generating -> ongoing(lastError)              (generation/finalize failure)
completed -> ongoing                          (any task/dependency/material invalidation)
ongoing|generating -> owner_terminated
```

任务 effective status 读取规则:

1. review head存在时直接映射 `pending_review/reviewing/rework/waiting_owner/passed`。
2. 无 current result、board=`todo|in_progress|blocked`时公开为 `executing`，并保留 board substatus。
3. board=`done`但 head不是 passed 是 invariant failure；读取返回 fail-closed error，不把任务显示完成。
4. head=passed但 board不是 done同样是 invariant failure。

### 3.6 不变量 validator

`validateV6` 至少拒绝:

- result version不从1连续递增、supersedes不指同 work item前一版、executor与 execution agent不一致。
- head current result不属于同项目/mission/work item；state reviewing但 current attempt为空或不是 `calling|finalizing`；非reviewing却指 active attempt。
- 同 result有多个 `calling|finalizing` attempt；attempt reviewer等于 result executor；reviewer不是项目成员或 acquire snapshot的 capability不为true。
- terminal business attempt没有恰一同 choice decision，或 failed/interrupted/discarded存在decision。
- decision/attempt/result/reviewer identity不一致。
- passed head没有 pass decision、work item不是 done、confirmed memory关系缺失；非passed work item为done。
- escalation没有 escalate decision、一个 escalation多 answer、回答后 head仍误指原 attempt为reviewing。
- active memory deterministic tuple重复；supersedes跨项目/类型、分叉、环、version不连续；Agent memory缺 proposer/confirm/source version。
- mission completed无 current delivery；delivery manifest引用非当前 passed result/decision/memory；生成中无 pending operation。
- review event sequence非连续或 payload不能被对应 strict schema解析。
- `foreign_key_check` 非空、任一 immutable trigger/index/DDL SQL漂移。

## 4. 真实 Review Agent 调用

### 4.1 候选资格

`listReviewCandidates(workItemId,resultId)` 在一个 read transaction中:

1. 读取 head并要求 current result匹配、state=`pending_review`。
2. 读取 result executor。
3. 项目当前 memberships join Agent公开配置。
4. 只返回 `reviewCapable=true && agentId !== executorAgentId`。
5. 每项返回稳定身份、role、skill names、provider/model非敏感身份、`qualification=["current_member","review_capable","not_executor"]`；不返回 system prompt、skill instructions、endpoint、key/mask。
6. 0候选返回空数组和 blocker `NO_INDEPENDENT_REVIEWER`；1候选也不默认选择。

发起时重新执行同一资格查询；客户端列表只用于显示，不具授权作用。owner必须提交 reviewer id、current result id和 expected head version。

### 4.2 Frozen review material

`ReviewMaterialV1` 是 canonical recursive-key-sorted JSON，整体复用 S-5 frozen public context的 2 MiB上限:

```ts
type VersionRef = {
  type: "task"|"result"|"review"|"validation"|"artifact"|"memory"|"execution";
  id: string;
  version: string;
};

type FrozenPublicContent = {
  source:VersionRef;
  mediaType:"text/plain"|"text/x-diff"|"application/json";
  status:"complete"|"truncated"|"missing"|"unreadable";
  originalBytes:number|null;
  includedBytes:number;
  sha256:string|null;
  chunks:Array<{
    offset:number;
    bytes:number;
    text:string;
    sha256:string;
  }>;
  reasonCode:null|"SOURCE_MISSING"|"SOURCE_UNREADABLE"|
    "SOURCE_REDACTED"|"MATERIAL_BUDGET_EXHAUSTED";
};

type ReviewMaterialV1 = {
  schemaVersion: 1;
  review:{attemptId:string;version:"1"};
  project: { id:string; name:string };
  mission: {
    id:string; title:string; goal:string;
    version:number;contextVersion:number;
  };
  task: {
    id:string; title:string; description:string; version:number;
    boardStatus:"todo"|"in_progress"|"blocked"|"done";
    assigneeAgentId:string|null;
  };
  dependencies: Array<{
    id:string; title:string; version:number;
    effectiveStatus:"executing"|"pending_review"|"reviewing"|
      "rework"|"waiting_owner"|"passed";
    resultId:string|null; resultVersion:number|null;
  }>;
  executor: { agentId:string; name:string };
  result: {
    id:string; version:number; executionId:string; stagedResultId:string;
    mergeJournalId:string; createdAt:string;
  };
  changes: {
    stagedHash:string; classification:string;
    observedPathCount:number; observedFinalBytes:number;
    mergeFileCount:number; mergeFinalBytes:number;
    observations:Array<{
      id:string;position:number;path:string;kind:string;
      baselineHash:string|null;observedHash:string|null;
      finalSize:number;diffBytes:number;diffTruncated:boolean;
      publicDiff:FrozenPublicContent;
    }>;
    blockers:Array<{
      position:number;observationId:string;path:string;
      kind:string;detailCode:string;
    }>;
  };
  validations: Array<{
    id:string; version:string; policyEntryId:string; required:boolean;
    exitCode:number;succeeded:boolean;afterLastWrite:boolean;
    stdout:FrozenPublicContent;
    stderr:FrozenPublicContent;
    finishedAt:string;
  }>;
  artifacts: Array<{
    id:string;version:string;name:string;path:string;
    content:FrozenPublicContent;createdAt:string;
  }>;
  auditEvents: Array<{
    executionId:string;eventId:string;sequence:number;type:string;
    payload:FrozenPublicContent;
  }>;
  sharedMemories: Array<{
    id:string;version:number;type:string;content:string;
    source:{type:string;id:string;version:string|null};
  }>;
  ownerAnswer: null|{
    escalationId:string;answerId:string;answer:string;createdAt:string;
  };
  sourceRefs: VersionRef[];
};
```

规则:

- 每个 `FrozenPublicContent.source` 必须是同 project/mission/result冻结时可导航的精确 id+version；diff绑定 observation/result version，validation绑定 validation id+manifest hash，artifact绑定 artifact id+sha256，event绑定 execution event id+sequence。hash/header与正文 chunk同时存在，不能用“当前同名”内容替代冻结版本。
- acquire通过 S-5 bounded read primitive读取并内嵌公开 diff、validation stdout/stderr、artifact body和相关 typed event public payload。每 chunk复用 S-5 64 KiB读取边界，offset从0连续、每块与整体 hash可校验；文本经过现有 redaction/UTF-8 replacement规则后才计入 canonical 2 MiB material。绝对路径、环境、credential、private prompt及不在 event allowlist的字段先移除。
- 打包顺序固定为 `(required desc, source.type, source.id, source.version, stream, offset)`；required内容必须完整装入2 MiB，否则 acquire失败 `REVIEW_MATERIAL_LIMIT_EXCEEDED`且不调用 provider。optional内容在剩余预算内装入完整 chunk，无法继续时置 `truncated/MATERIAL_BUDGET_EXHAUSTED`，保留精确 source/hash/bytes；源不存在、读取失败或被 redaction整体拒绝分别置 `missing`、`unreadable`、`unreadable/SOURCE_REDACTED`，不伪造空正文。
- required review内容包括每个非空文本 change的 public diff、每个 required validation的 stdout/stderr（零字节以 `complete`+空 chunks表示）、result/pass所引用的 artifact/event以及 Agent输出 evidence/candidate将引用的 source。二进制或 S-5本就未持久正文的 change按 `unreadable`处理。仅有 hash/header、任一 required内容非 `complete`、或非零内容 `chunks=[]` 时，`pass`业务校验返回 `REVIEW_CONTENT_INCOMPLETE`；Agent仍可基于明确限制选择 reject/escalate。optional缺失可 pass，但必须在 limitations和后续 manifest保留状态，且不能被 output引用。
- observations/blockers沿用 S-5 已持久 summary并附实际 diff；完整结构本身超过2 MiB同样 acquire失败，不静默删除数组。
- `auditEvents`只读取与 result/merge/validation/artifact/manual-recovery有关的 strict public event payload；不在 allowlist的事件不进入 sourceRefs，不能被 Agent声称已读。
- shared memory只含当前 active条目和 source tuple；不含 owner/Agent私有 prompt。
- owner escalation answer仅在同 result继续复核时加入。
- acquire先分配 attempt id，再把 `{type:"review",id:attemptId,version:"1"}` 加入 sourceRefs；因此 Agent可把候选精确绑定到当前 review，而不引用尚未存在的 decision。
- canonical material hash同时是 stale检查输入；任务、依赖、result、validation、artifact、memory active set或 owner answer任一版本变化都会改变 hash。
- snapshot持久化的是上述 allowlist，不持久化生成的 OpenAI request、Authorization或 provider response。

### 4.3 Prompt 与公开输出

消息顺序:

1. 平台 system：独立复核职责、只返回面向 owner的公开结论、不输出隐藏思维链、strict schema。
2. 当前 reviewer私有 system：该 Agent自己的 role/systemPrompt/skills instructions；只在出站请求内存在。
3. 冻结 review material system：canonical JSON。
4. user：要求基于冻结材料三选一，不得声称读取未提供内容。

Review output:

```ts
type EvidenceRef = {
  type:"task"|"result"|"review"|"validation"|"artifact";
  id:string;
  version:string;
};

type MemoryCandidate = {
  type:"decision"|"fact"|"artifact"|"experience";
  content:string;                       // S-3 memory 1..20000 graphemes
  source: EvidenceRef;
  supersedesMemoryId:string|null;
};

type ReviewOutput = {
  publicSummary:string;                 // 1..20000 graphemes
  findings:Array<{
    title:string;                       // 1..5000 graphemes
    detail:string;                      // 1..5000 graphemes
    evidenceRefs:EvidenceRef[];
  }>;
  evidenceRefs:EvidenceRef[];
  limitations:string[];                 // each 1..5000 graphemes
  memoryCandidates:MemoryCandidate[];
  decision:
    | {choice:"reject"; reworkRequirements:string[]} // each 1..5000 graphemes
    | {choice:"escalate"; question:string; options:string[]}
    | {choice:"pass"};
};
```

所有 object `.strict()`、unknown key拒绝。`publicSummary` 和 memory content复用既有 Agent公开消息/共享记忆 20,000 grapheme边界；findings title/detail、limitations和rework requirement复用 S-4 handoff summary/reason 5,000 grapheme边界；question/options复用 S-4 decision request的1,000、2..8、每项500边界。provider raw response先受1 MiB上限，解析后的完整 public output再受 S-5 mutation/detail 256 KiB上限；数组不另设规格外数量阈值。每个 EvidenceRef必须在 frozen `sourceRefs`中逐字段存在；candidate source必须属于同项目当前 attempt的 frozen材料。

业务校验:

- decision discriminated union保证且仅一个 choice。
- reject要求至少一个非空 rework requirement。
- escalate复用 S-4 question/options合法性。
- pass允许0个 memory candidate；不为缺失类别补空条目。
- pass的每个 evidenceRef和candidate source必须对应 `status=complete` 的实际公开内容或可完整读取的 task/result/review结构；对 diff/output/artifact/event，非零 source还必须至少有一个已校验 chunk。只有 hash/header、`truncated|missing|unreadable` source不得支持 pass。
- 任一 candidate/source/supersedes非法使整个 attempt无裁决失败，不部分保存。
- owner/client构造相同 JSON不能提交；输出只由持有 acquire lease的 provider finalizer内部参数进入 commit，不提供“提交裁决”公开 route。

### 4.4 Acquire、调用、finalize

Acquire `BEGIN IMMEDIATE`:

1. strict解析 body、计算不含 operationId的 canonical request hash。
2. same operation/hash返回 receipt；same id/different hash → `OPERATION_CONFLICT`；pending且 lease仍有效 → `OPERATION_IN_PROGRESS`。
3. reconcile该 work item已过期 calling attempt。
4. CAS验证 head version/state/current result、无 current calling attempt、mission非terminated。
5. 重算 reviewer资格、provider verified状态、credential可用状态和 Agent共享 token usage。
6. 若当前可信 usage已达到 Agent `maxTokens`，返回 `REVIEW_TOKEN_BOUNDARY`，不创建 attempt、不调用 provider。
7. 构造/freeze/size-check material，创建 pending operation、calling attempt、随机 lease、head state=`reviewing`/currentAttempt，append `review_started`，提交。

事务外:

1. vault解密 acquire绑定 provider凭据；调用 `callOpenAiChat`。
2. 每个 call先插 `calling` model-call。失败或 primary invalid以短事务写 call终态/可信 usage/event；最终 schema合法的 primary或repair则先在内存 strict parse和 redaction/secret/CoT扫描。source、evidence、candidate、completion等业务校验故意留到 checkpoint后的 business finalize。
3. primary schema无效才执行一次 repair；每个 call独立90秒。
4. 每30秒 heartbeat延长 attempt lease到 `now+120s`；heartbeat不改变 frozen hash或业务状态。
5. 调用后按同一 source collaboration run + Agent汇总 S-4/S-5/S-6可信 usage；超过 maxTokens时保留 call/usage，attempt=`discarded`，无裁决。

Durable output checkpoint `BEGIN IMMEDIATE`:

1. 对最终合法 call CAS `attempt.status=calling + leaseToken + lease有效`，同时重算 head/result/reviewer/material/context identity。
2. 一笔事务写最终 call terminal、reported nullable usage、call/usage events，并把 strict-parse且redaction通过的 canonical public output、SHA-256和 checkpoint时间写入 attempt，状态 `calling→finalizing`，append `review_output_checkpointed`。raw response、request、CoT和redaction前文本从不进入参数或 SQLite。
3. SQLite fault时整笔不提交；该 provider动作尚未形成 durable confirmed output。进程若仍存活可用内存结果重试相同 checkpoint，不重新调用 provider；若进程已丢失内存，reconcile将 attempt标 `interrupted`，owner只能显式创建新 attempt，不能声称恢复不存在的输出。
4. checkpoint成功是“provider外部动作已确认完成”的唯一 durable边界。此后任何 API replay、进程重启或本地 finalize fault只能读取 `parsed_output_json/hash`重放本地业务提交，严禁再次调用 provider；model-call行也不得新增。

Business finalize `BEGIN IMMEDIATE`:

1. CAS attempt id/status=`finalizing`/checkpoint hash；重算 head identity/version、current result、reviewer资格和 material/context hash。
2. lease失效、mission终止、head变化、result被取代、资格丢失或 material/context hash变化 → 记录 typed discard原因，保留只读 checkpoint，head回到适当 current state，不提交 decision/memory/delivery。
3. provider/schema/usage/redaction失败发生在 checkpoint前：attempt=`failed`、head=`pending_review`、完成 receipt为稳定 error；不自动 retry。
4. 从 checkpoint重新 strict parse，完成 evidence/content/candidate/source/supersedes/completion全量业务校验，再按 choice进入 §5事务；不接受调用栈传入的未持久 output。
5. 可确定的业务校验失败（如正文不完整、source/supersedes非法）在独立收口事务中保留 checkpoint、attempt=`failed`、head=`pending_review`并完成稳定 error receipt；same operation replay返回原错误，不重新调用 provider。材料修复后必须新 attempt。
6. 成功后 attempt终态、decision、head、board/memory/escalation/events和 receipt在同一事务完成。
7. SQLite/memory不可用或事务 fault使业务事务整体 rollback，attempt保持 `finalizing`，短事务只更新 `finalize_error_code`及 `review_finalize_failed`事件；same operation replay或 owner点击“继续提交裁决”重放此 business finalize，不创建新 attempt/call。
8. late finalizer CAS=0只读取已完成 receipt或当前 checkpoint；不得新增 call/usage/decision/memory/event。

## 5. 裁决、返工、升级与完成门槛

### 5.1 Reject

同一 finalize事务:

- 插入唯一 reject decision和全部 candidate审计行（不沉淀 shared memory）。
- attempt=`rejected`；head=`rework`、`currentAttemptId=null`、version+1。
- work item board确保为 `in_progress`；若已是 done则 invariant failure而非静默降级。
- append `review_decided`、`rework_requested`；完成 receipt。
- merged execution/result/validation/artifact/decision不更新。

S-5 `startExecution` 资格增加:

- 普通首次执行仍要求 board=`in_progress`。
- 返工执行额外要求 head=`rework`、无 active execution、assignee仍是项目成员、依赖全部 effective passed。
- merged 返工结果在现有 merge DB commit事务中插入 next result version并 CAS head `rework→pending_review`；若 head/current prior/version不匹配，merge不提交 result且返回 conflict。
- 同一 execution永远只生成一个 result version。

### 5.2 Escalate

同一 finalize事务:

- 插入 escalate decision与一个 escalation issue。
- attempt=`escalated`；head=`waiting_owner`、current attempt清空。
- board保持 `in_progress`；mission completion blocker显示 issue id。
- 同 result已有 open issue时应由 head/unique invariant阻止第二个 start；不会出现重复 open escalation。

Answer endpoint只接受 owner:

```ts
type AnswerEscalationInput = {
  operationId:string;
  expectedHeadVersion:number;
  answer:string;
  action:"continue_review"|"rework"|"terminate_mission";
};
```

- `continue_review`: 插 immutable answer，head `waiting_owner→pending_review`；原 result不变。owner仍需重新打开候选并创建新 review attempt。
- `rework`: 插 answer，head `waiting_owner→rework`；后续必须新 execution/new result。
- `terminate_mission`: 插 answer并调用 mission termination primitive；mission head=`owner_terminated`，所有成功交付从 current指针移除但历史保留。
- 重复 same operation返回原 answer；不同 operation并发最多唯一 answer，输家返回 existing或 conflict。
- answer不能直接写 pass，也不能修改原 escalation decision/attempt。

### 5.3 Pass + memory + task completion

Finalize pass事务顺序:

1. 重新验证 head/current result/current attempt/reviewer资格、依赖 effective passed、result merged、required validations仍有效、无 manual recovery/open escalation/rework。
2. 预解析全部 candidate，验证 source导航、source版本、supersedes和 deterministic dedupe。
3. 插 pass decision与 candidate审计行。
4. 对每个 candidate按 position稳定顺序:
   - 查 active exact tuple；存在则关联既有 entry。
   - 否则验证显式 supersedes目标，分配 chain/version并插 immutable Agent memory。
   - 记录 decision→memory association（包含 reused/created/superseded outcome）。
5. 要求每个合法 candidate均有 association；0 candidate合法。
6. CAS head `reviewing→passed`，清 current attempt，version+1。
7. 通过 completion primitive把 work item board `in_progress→done`并 version+1。
8. append decision/memory/task events，完成 operation receipt。

checkpoint前任一步失败全部 rollback，随后独立短事务把 calling attempt安全收口为 failed、head回 `pending_review`并完成 sanitized error receipt。checkpoint后任一步本地提交失败不得把 attempt降为 failed或完成 operation；保持 `finalizing`并按 §4.4重放。若另一个状态写先赢，fallback CAS=0并返回胜者 receipt。

### 5.4 统一完成门槛

`assertWorkItemMayBecomeDoneTx(database,workItemId)` 唯一谓词:

- 存在 current result和 head=`passed`。
- 当前 result有唯一 pass attempt/decision；reviewer与 executor不同且 acquire资格事实完整。
- result仍对应 merged execution，execution无 manual recovery，required validation对该 result版本仍有效。
- 所有依赖 head=`passed`且 board=`done`。
- 没有 open escalation/rework。
- pass decision的每个 memory candidate都有已提交 association。

调用点:

- `transitionWorkItem(...toStatus="done")`
- `claimWorkItemTx`/Agent action内任何状态投影
- owner mission board API
- operation receipt replay后的状态返回校验
- S-6 pass finalizer
- migration后 legacy数据读取
- 任何内部 helper/测试 seed不得绕过 production primitive

对 owner/旧客户端直接 done: 若门槛未满足返回 `REVIEW_REQUIRED` 409及 blocker codes，数据库副作用0；若已满足只返回当前 done row，不创建新 decision/event。相同旧 operation重放原拒绝或原成功，不能在事实变化后重新解释旧 receipt。

Mission completion predicate:

- mission至少一个 work item。
- 每项 head passed、board done、无 open issue/manual recovery。
- 每个 pass candidate association完整。
- 当前 required evidence按下表均为允许状态；optional evidence即使缺失也只进入 manifest，不阻塞。
- delivery input可构造。

只有 predicate成功可 acquire `generating`；只有 delivery finalize可写 `completed`。不存在公开“set mission done”通用写接口；若旧/内部路径尝试更新，统一 `MISSION_COMPLETION_BLOCKED`。

Review pass与 mission delivery共用 `classifyEvidenceTx`，required位一经 pass checkpoint确定，delivery不得改判:

| Evidence | Required 判定 | 允许状态 | 非允许状态与效果 |
|---|---|---|---|
| current result + merge journal | 恒 required | `available`且 FK/version/hash一致 | `missing/stale/unreadable` 阻断 pass/completion |
| pass review + decision + checkpoint | 恒 required | `passed`且 attempt/result/reviewer/output hash一致 | `missing/stale/unreadable` 阻断 |
| change public diff | 非空文本 change required；无正文的二进制/不支持项 required但 unreadable | `available`且 material `complete`并有实际 chunk | hash/header-only、`truncated/missing/unreadable` 阻断 pass |
| validation stdout/stderr | policy `required=true`则 required，否则 optional | required须 validation passed、after-last-write且两流 `complete`；optional任意状态可列清单 | required 的 `failed/truncated/stale/missing/unreadable` 阻断；optional不阻断 |
| artifact body | 默认 optional；被 decision evidence或memory candidate引用时 required | required须 source/version/hash一致且 body `complete`；optional可 `available/failed/truncated/stale/missing/unreadable` | required非完整阻断；optional只记录状态/影响 |
| relevant event payload | 默认 optional；被 decision evidence引用时 required | required须 strict public payload `complete` | required非完整阻断；optional不阻断 |
| candidate→memory association | 每个 candidate恒 required | `available`且 decision/source/version一致 | `missing/stale/unreadable` 阻断 |

manifest统一使用 `passed|available|failed|truncated|stale|missing|unreadable`；optional missing合法但 UI必须显示，不能改写为 passed。required不可读在 review阶段返回 `REVIEW_CONTENT_INCOMPLETE`，在 delivery阶段返回 `VALIDATION_REQUIRED`或 `MISSION_COMPLETION_BLOCKED`并附精确 blocker ref。

### 5.5 重开与失效

这些入口必须调用 `invalidateCompletionTx`:

- owner将已完成任务重开。
- 修改已通过任务的 title/description/assignee/dependencies。
- 修改 mission title/goal，或任何事务推进 mission context version。
- 合法重开某依赖。
- 对已通过任务创建新 rework。
- S-5 material被人工恢复判定失效。

事务:

1. `updateMission(title|goal)`先 CAS mission version；project context snapshot中会改变公开 mission/task/dependency/active-memory/roster事实的既有 mutation，必须在同一事务调用 `bumpMissionContextVersionTx`，CAS delivery head `contextVersion+1`。review acquire冻结 mission version+contextVersion，delivery fingerprint包含二者。
2. 用 recursive CTE取目标和传递下游，稳定按 DAG/id处理。
3. context变化命中的 `calling` attempt置 `discarded`并使其 model call晚到结果只能落 discarded call审计；`finalizing` attempt保留 checkpoint但置 `discarded`，永不重放旧业务裁决。对应 head清 currentAttempt并回当前 result的 `pending_review`。append `review_attempt_discarded` reason=`MISSION_CONTEXT_CHANGED`。
4. 每个受任务/依赖变化影响的 passed head置 `rework`、board置 `in_progress`、递增版本；只改变 mission title/goal且 task材料未变时，passed task本身保持 passed，但旧 current delivery仍必须失效。
5. mission head若 completed/generating，置 ongoing、current delivery清空；pending generation operation以 `DELIVERY_CONTEXT_CHANGED`完成。title/goal update、context bump、attempt discard、delivery invalidation、head/event sequence必须同事务，任一失败全部 rollback。
6. append每个 task invalidated、review discarded与 delivery invalidated event。并发 provider/checkpoint/delivery finalizer靠 version/context CAS只有一方胜出；输家不得恢复旧 current。
7. 不物理删除 memory；已沉淀知识仍按其原 source/version展示。若知识错误，后续 review以显式 supersedes修订。

## 6. 五类 Memory 的 actor、source、版本与导航

### 6.1 Public DTO

```ts
type MemoryEntryV6 = {
  id:string;
  projectId:string;
  chainId:string;
  version:number;
  type:"goal"|"decision"|"fact"|"artifact"|"experience";
  content:string;
  source:{
    type:"owner_input"|"work_item"|"artifact_path"|
      "task"|"result"|"review"|"validation"|"artifact";
    id:string;
    version:string|null;
    href:string|null;
  };
  actor:{
    proposerType:"owner"|"agent";
    proposerAgent:null|{id:string;name:string;avatarText:string;accentToken:string};
    confirmer:null|{reviewAttemptId:string;decisionId:string};
    persistedBy:"platform";
  };
  supersedesId:string|null;
  active:boolean;
  createdAt:string;
};
```

- `href` 服务端按 source type生成同项目相对产品路由；无法证明合法关系则整个 DTO fail-closed，不返回漂移链接。
- owner条目 proposerType=owner、confirmer=null，保留旧 source语义。
- Agent条目显示 reviewer快照身份和 pass decision；platform不作为业务作者。
- history按 `(chainId,version,id)`；active list按 `(createdAt,id)`。

### 6.2 Source resolver

- task: work item id + work item version。
- result: result id + integer version。
- review: attempt id + attempt frozen material hash或 decision id version identity。
- validation: validation id + `sandboxManifestHash`。
- artifact: artifact id + artifact `sha256`。

resolver要求 source存在、同项目、属于本 attempt frozen sourceRefs；后续同 id新版本不改变旧 entry的 sourceVersion。artifact path legacy source只展示规范相对路径且 version=null，不读取文件。

### 6.3 Supersedes

- candidate必须显式传 `supersedesMemoryId`；null永不自动替代。
- 目标必须同项目、同 type、active且无 child。
- 新 content/source tuple即使等于另一 active entry，也先执行 exact dedupe：若 exact active已存在则 reuse，不能再用它制造自环 supersedes。
- 若 supersedes目标与 exact reused entry是同一 id，candidate非法；“用相同知识取代自身”没有新版本。
- 两个并发 pass由 `BEGIN IMMEDIATE`串行；后提交者重读 active。如果 exact winner存在则reuse；若 supersedes目标已历史化则整笔 pass conflict，不分叉。

## 7. Final Delivery 摘要与 Evidence Manifest

### 7.1 Fingerprint

按 work item稳定 `(createdAt,id)` 顺序构造:

```ts
type DeliveryInputV1 = {
  schemaVersion:1;
  mission:{id:string;version:number;contextVersion:number};
  tasks:Array<{
    workItemId:string;workItemVersion:number;
    resultId:string;resultVersion:number;
    executionId:string;
    decisionId:string;reviewAttemptId:string;
    reviewerAgentId:string;
    validationRefs:VersionRef[];
    artifactRefs:VersionRef[];
    memoryRefs:Array<{id:string;version:number}>;
  }>;
};
```

canonical JSON SHA-256为 `inputFingerprint`。任何任务重开、新 result/review/memory source变化都会改变 fingerprint。相同 fingerprint已有 delivery时不创建新版本，直接把 head指回该 row并返回它；不同 fingerprint生成 next version并 supersedes旧 current delivery。

### 7.2 Summary

`summary_json`:

```ts
type DeliverySummary = {
  mission:{id:string;title:string;goal:string;conclusion:"completed";completedAt:string};
  tasks:Array<{
    workItem:{id:string;title:string};
    executor:{agentId:string;name:string};
    reviewer:{agentId:string;name:string};
    decision:{id:string;choice:"pass";publicSummary:string};
    result:{id:string;version:number};
    changes:{stagedHash:string;mergeFileCount:number;mergeFinalBytes:number};
    validations:{requiredCount:number;passedCount:number;refs:VersionRef[]};
    artifacts:VersionRef[];
    memories:Array<{id:string;version:number;type:string}>;
    limitations:string[];
  }>;
};
```

摘要只复制已通过 decision的公开 summary/limitations和数据库事实；不调用模型、不生成未经 source支持的新判断。

### 7.3 Evidence manifest

```ts
type EvidenceManifestV1 = {
  schemaVersion:1;
  inputFingerprint:string;
  entries:Array<{
    kind:"result"|"review"|"validation"|"artifact"|"memory"|"execution_event";
    id:string;
    version:string;
    status:"passed"|"available"|"failed"|"truncated"|"stale"|"missing"|"unreadable";
    sha256:string|null;
    href:string;
    required:boolean;
  }>;
};
```

- required evidence不是 passed/available即 completion blocker，类别完全取自 §5.4统一表。
- optional failed/truncated/stale/missing/unreadable保留状态和影响，不表述为通过，也不阻塞完成。
- href绑定 id/version，不跳到“当前同名”。
- manifest不内嵌正文、stdout/stderr、artifact bytes或绝对 path。
- summary+manifest整体复用 S-5 detail 256 KiB公开响应上限；若合法输入无法在该上限内返回，生成失败 `DELIVERY_RESPONSE_LIMIT_EXCEEDED`，mission回 ongoing且可显式重试，不写部分 delivery。

### 7.4 两阶段生成

Acquire transaction:

- operation dedupe、head expectedVersion、completion predicate。
- head `ongoing→generating`、绑定 operation和随机 generation lease（过期时间复用120秒）、append `delivery_generation_started`，提交。

事务外仅进行纯内存 canonical组装与 strict schema parse，不做外部调用。

Finalize transaction:

- 重算 completion predicate和 fingerprint；要求等于 acquire fingerprint且 head仍 generating/current operation/lease token匹配、lease未过期。
- 已有同 fingerprint delivery则reuse；否则插 next immutable version。
- CAS head completed/current delivery/version，append completed event，完成 receipt。
- 任意错误以短事务 head回 ongoing/lastError、append failed、完成 sanitized receipt；passed tasks/memories不变。
- 进程在 acquire后崩溃：lease有效时重启读取显示 generating；lease过期后 reconcile把 generation标失败/ongoing并完成原 receipt，但不自动再次生成。owner点击重试创建新 operation。

## 8. Strict API、DTO、Redaction 与 Events

### 8.1 Routes

Read:

- `GET /api/work-items/:workItemId/review` → `ReviewWorkspaceDto`
- `GET /api/work-items/:workItemId/reviews?after=<startedAt,id>&limit=1..20`
- `GET /api/reviews/:attemptId` → frozen material摘要、calls、decision/escalation、candidate associations；不返回 private prompt/raw body。
- `GET /api/missions/:missionId/review-events?after=<sequence,id>&limit=1..100`
- `GET /api/missions/:missionId/delivery` → current/progress/blockers/latest error。
- `GET /api/missions/:missionId/deliveries?after=<version,id>&limit=1..20`
- 既有 memory GET升级为 `MemoryEntryV6[]`，继续支持 includeInactive。

Mutation:

- `POST /api/work-items/:workItemId/reviews`
  `{operationId,resultId,reviewerAgentId,expectedHeadVersion}`
  → 200 `{workspace,attempt}` 或稳定错误。
- `POST /api/escalations/:escalationId/answer`
  `AnswerEscalationInput` → `{workspace,answer}`。
- `POST /api/missions/:missionId/delivery`
  `{operationId,expectedHeadVersion}` → `{missionCompletion,delivery}`。
- `POST /api/missions/:missionId/terminate`
  `{operationId,expectedHeadVersion,reason}` → `{missionCompletion}`。
- 既有 Agent update DTO增加 `reviewCapable:boolean`，strict保存。
- 既有 memory POST只接受 owner actor shape；客户端不能提交 proposer Agent/confirming attempt/persistence actor。

所有 mutation body必须是 strict object、含 UUID operationId和 expected version（Agent config沿用自身 expectedVersion）。复用 S-5 请求≤128 KiB、mutation/detail≤256 KiB、list≤512 KiB、event page≤100、普通 history page≤20、24小时 scoped HMAC cursor；不引入新数字。

### 8.2 Core DTO

```ts
type EffectiveReviewStatus =
  "executing"|"pending_review"|"reviewing"|"rework"|"waiting_owner"|"passed";

type ReviewCandidateDto = {
  agent:{id:string;name:string;role:string;avatarText:string;accentToken:string};
  provider:{id:string;name:string;model:string};
  qualification:["current_member","review_capable","not_executor"];
};

type ReviewModelCallDto = {
  id:string;
  kind:"primary"|"repair";
  callIndex:1|2;
  status:"calling"|"succeeded"|"provider_failed"|"response_invalid"|
    "usage_invalid"|"interrupted"|"discarded";
  usage:
    | {reported:true;promptTokens:number;completionTokens:number;totalTokens:number}
    | {reported:false;promptTokens:null;completionTokens:null;totalTokens:null};
  failure:null|{
    category:"auth"|"rate_limit"|"upstream"|"network"|"timeout"|
      "schema"|"usage"|"redaction"|"interrupted"|"stale";
    apiErrorCode:null|
      "PROVIDER_AUTH"|"RATE_LIMITED"|"PROVIDER_UPSTREAM"|
      "PROVIDER_UNREACHABLE"|"PROVIDER_RESPONSE_INVALID"|
      "PROVIDER_TIMEOUT"|"STRUCTURED_OUTPUT_INVALID"|
      "REVIEW_OUTPUT_REDACTED";
  };
  startedAt:string;
  finishedAt:string|null;
};

type ReviewCheckpointDto = {
  publicOutputHash:string;
  checkpointedAt:string;
};

type LocalFinalizeOnly = {
  mode:"local-finalize-only";
  checkpoint:ReviewCheckpointDto;
  lastErrorCode:null|"REVIEW_FINALIZE_FAILED"|"STORAGE_UNAVAILABLE";
  retryRequiresProvider:false;
};

type NewProviderAttempt = {
  mode:"new-provider-attempt";
  checkpoint:null;
  lastErrorCode:string|null;
  retryRequiresProvider:true;
};

type NoAttemptRetry = {
  mode:"none";
  checkpoint:ReviewCheckpointDto|null;
  lastErrorCode:string|null;
  retryRequiresProvider:false;
};

type ReviewAttemptBase = {
  id:string;
  result:{id:string;version:number};
  reviewer:{id:string;name:string;avatarText:string;accentToken:string};
  provider:{id:string;name:string;model:string;version:number};
  material:{hash:string;resultVersion:number;sourceCount:number};
  calls:ReviewModelCallDto[];
  usageTotal:{
    promptTokens:number;completionTokens:number;totalTokens:number;
    reportedCalls:number;unreportedCalls:number;repairCalls:number;
  };
  errorCategory:string|null;
  startedAt:string;finishedAt:string|null;
};

type ReviewDecisionDto = {
    id:string;choice:"reject"|"escalate"|"pass";
    publicSummary:string;findings:unknown[];evidenceRefs:EvidenceRef[];
};

type ReviewAttemptDto = ReviewAttemptBase & (
  | {
      status:"calling";
      finalize:LocalFinalizeOnly|(
        NoAttemptRetry & {checkpoint:null;lastErrorCode:null}
      );
      decision:null;
    }
  | {
      status:"finalizing";
      finalize:LocalFinalizeOnly;
      decision:null;
    }
  | {
      status:"failed";
      finalize:
        | NewProviderAttempt
        | LocalFinalizeOnly
        | (NoAttemptRetry & {checkpoint:ReviewCheckpointDto});
      decision:null;
    }
  | {
      status:"interrupted";
      finalize:NewProviderAttempt;
      decision:null;
    }
  | {
      status:"discarded";
      finalize:NoAttemptRetry;
      decision:null;
    }
  | {
      status:"rejected"|"escalated"|"passed";
      finalize:NoAttemptRetry & {
        checkpoint:ReviewCheckpointDto;
        lastErrorCode:null;
      };
      decision:ReviewDecisionDto;
    }
);

type ReviewAttemptHistoryItemDto = ReviewAttemptDto;
type ReviewAttemptDetailDto = ReviewAttemptDto & {
  frozenMaterial:unknown;
  escalation:unknown|null;
  candidateAssociations:unknown[];
};

type ReviewWorkspaceDto = {
  workItem:{id:string;title:string;version:number;boardStatus:string};
  effectiveStatus:EffectiveReviewStatus;
  headVersion:number;
  result:null|{id:string;version:number;executorAgentId:string;createdAt:string};
  candidates:ReviewCandidateDto[];
  currentAttempt:ReviewAttemptDto|null;
  escalation:null|{
    id:string;question:string;options:string[];
    answer:null|{id:string;answer:string;action:string;createdAt:string};
  };
  blockers:Array<{code:string;refId:string|null}>;
  historyCount:number;
};

type MissionCompletionDto = {
  missionId:string;
  state:"ongoing"|"generating"|"completed"|"owner_terminated";
  version:number;
  currentDeliveryId:string|null;
  blockers:Array<{workItemId:string|null;code:string;refId:string|null}>;
  lastErrorCode:string|null;
};
```

`ReviewAttemptDto.calls`按 callIndex稳定排序且最多是 primary、repair各一项；workspace `currentAttempt`、history page item和 detail顶层均复用上面的 discriminated union，detail只追加冻结材料/escalation/association，不重定义 status/finalize/retry。model-call refine：calling必须 `finishedAt=null/failure=null`；succeeded必须 `finishedAt!=null/failure=null`；其余终态必须 `finishedAt!=null/failure!=null`。provider/response/redaction失败的 `apiErrorCode`取上列对应唯一值；usage_invalid、interrupted、discarded使用 `apiErrorCode=null`并由 status+category表达，不能临场造新 public code。`reported=false`时三个 token必须全为null，不能用0冒充 provider已报告；`reported=true`时三个均为非负整数且 total相加一致。attempt aggregate只累加 reported call，未报告数量独立显示。

attempt/finalize refine矩阵:

- `status=calling`且 checkpoint为空：`mode=none`，调用仍在进行，不显示 retry；若 checkpoint已存在则只能是 `local-finalize-only`，用于读取与 checkpoint事务交界处的合法投影。
- `status=finalizing`：必须有 checkpoint，且只能 `local-finalize-only/retryRequiresProvider=false`；`lastErrorCode`非空表示本地 business finalize提交失败。
- `status=failed`：checkpoint为空只能 `new-provider-attempt/retryRequiresProvider=true`；checkpoint存在且错误是本地提交失败只能 `local-finalize-only/false`；checkpoint存在但业务校验已确定失败只能 `none/false`。
- `status=interrupted`：checkpoint必须为空，只能 `new-provider-attempt/true`。有 checkpoint 的 lease过期不得投影为 interrupted。
- `status=rejected|escalated|passed`：必须有 checkpoint与 decision，只能 `none/false`；裁决终态没有 retry。
- `status=discarded`：无论是否保留历史 checkpoint都只能 `none/false`，因为 stale/context失效输出不得再次提交。
- 任一不在矩阵中的 status/checkpoint/mode/decision组合在 workspace、history、detail route均以 sanitized 500 fail-closed；客户端不自行推断 retry方式。

所有 response在 route返回前过 `.strict()` Zod schema；unknown persisted enum/row shape返回 sanitized 500，不 passthrough。

### 8.3 Error matrix

| HTTP | Code | 固定中文 message | Event / blocker | 持久副作用 |
|---|---|---|---|---|
| 400 | `INVALID_JSON`, `INVALID_INPUT`, `STRUCTURED_OUTPUT_INVALID` | “请求格式无效” / “输入不符合约束” / “复核输出格式无效” | `review_model_call_failed`（已acquire时） | checkpoint前 attempt failed；否则0 |
| 401 | 既有 `PROVIDER_AUTH` | “Provider 身份验证失败，请检查配置。” | `review_model_call_failed` category=auth | call终态，零裁决 |
| 403 | `OWNER_REQUIRED`, `REVIEWER_INELIGIBLE` | “仅 Owner 可执行此操作” / “所选 Agent 不具备独立复核资格” | `review_candidates_evaluated` | decision/memory/task=0 |
| 404 | `PROJECT_NOT_FOUND`, `WORK_ITEM_NOT_FOUND`, `RESULT_NOT_FOUND`, `REVIEW_NOT_FOUND`, `ESCALATION_NOT_FOUND`, `DELIVERY_NOT_FOUND` | “未找到对应的项目 / 任务 / 结果 / 复核 / 升级 / 交付” | 无；scope泄露=0 | 0 |
| 409 | `REVIEW_REQUIRED` | “任务尚未通过独立复核” | `completion_write_rejected` | 0 |
| 409 | `LEGACY_DONE_UNREVIEWED` | “旧完成状态未经独立复核” | blocker + `completion_write_rejected` | 0 |
| 409 | `NO_INDEPENDENT_REVIEWER` | “缺少可用的独立复核 Agent” | `review_candidates_evaluated` | 0 |
| 409 | `REVIEW_STATE_CONFLICT`, `RESULT_SUPERSEDED`, `REVIEW_ALREADY_IN_PROGRESS` | “复核状态已变化” / “结果版本已被取代” / “已有复核正在进行” | `review_attempt_discarded`或拒绝审计 | 0或返回winner |
| 409 | `REVIEW_TOKEN_BOUNDARY` | “复核 Agent 已达到 token 使用边界” | `review_attempt_failed` category=usage | acquire前0 call |
| 409 | `ESCALATION_ALREADY_ANSWERED` | “该升级问题已被回答” | `escalation_answered` winner可导航 | 0或返回winner |
| 409 | `MISSION_COMPLETION_BLOCKED` | “使命尚未满足最终完成条件” | completion blocker list | 0 |
| 409 | `MISSION_CONTEXT_CHANGED`, `DELIVERY_CONTEXT_CHANGED` | “使命上下文已变化，请基于最新内容重试” | `review_attempt_discarded` / `delivery_invalidated` | 旧current失效 |
| 409 | `DELIVERY_INTERRUPTED` | “交付生成已中断，请显式重试” | `delivery_generation_failed` | head回ongoing |
| 409 | `OPERATION_CONFLICT`, `OPERATION_IN_PROGRESS` | “操作标识与原请求冲突” / “操作仍在进行” | `operation_replayed`（replay） | 0或原receipt |
| 409 | `MEMORY_NOT_ACTIVE`, `MEMORY_TYPE_MISMATCH` | “被取代的记忆不能再次取代” / “记忆类型不匹配” | `review_finalize_failed` | pass事务0 |
| 413 | `REQUEST_LIMIT_EXCEEDED`, `RESPONSE_LIMIT_EXCEEDED` | “请求 / 响应超过既有限制” | route size audit | 0 |
| 413 | `REVIEW_MATERIAL_LIMIT_EXCEEDED` | “公开复核材料超过既有限制” | `review_attempt_failed` category=material | acquire回滚、0 call |
| 413 | `DELIVERY_RESPONSE_LIMIT_EXCEEDED` | “交付摘要超过既有限制” | `delivery_generation_failed` | 无delivery |
| 422 | `REVIEW_MATERIAL_INVALID`, `REVIEW_CONTENT_INCOMPLETE` | “公开复核材料无效” / “复核材料正文不完整，不能通过” | `review_attempt_failed`或`review_finalize_failed` | 无裁决 |
| 422 | `REVIEW_OUTPUT_REDACTED` | “复核公开输出包含不可持久化内容” | `review_model_call_failed` category=redaction | 无checkpoint/裁决 |
| 422 | `MEMORY_SOURCE_INVALID`, `MEMORY_SUPERSEDES_INVALID` | “记忆来源无效” / “记忆版本关系无效” | `review_finalize_failed` | pass整体回滚 |
| 422 | `VALIDATION_REQUIRED` | “必需验证或证据不可用” | completion blocker / `review_finalize_failed` | pass/delivery整体回滚 |
| 429 | 既有 `RATE_LIMITED` | “Provider 请求过于频繁，请稍后重试。” | `review_model_call_failed` category=rate_limit | call终态，零裁决 |
| 502 | 既有 `PROVIDER_UPSTREAM`, `PROVIDER_UNREACHABLE`, `PROVIDER_RESPONSE_INVALID` | “Provider 服务暂时异常。” / “当前无法连接 Provider。” / “Provider 返回了无效响应。” | `review_model_call_failed` category=upstream/network/schema | call终态，零裁决 |
| 503 | `CREDENTIAL_UNAVAILABLE`, `STORAGE_UNAVAILABLE` | “复核凭据暂不可用” / “存储暂不可用” | acquire前无event；已acquire则 attempt/finalize event | 无伪成功 |
| 504 | 既有 `PROVIDER_TIMEOUT` | “Provider 请求超时，请稍后重试。” | `review_model_call_failed` category=timeout | call终态，零裁决 |
| 500 | `REVIEW_FINALIZE_FAILED` | “复核结果已保存，但本地提交失败；重试不会再次调用模型” | `review_finalize_failed` | checkpoint保留、operation pending |
| 500 | `SCHEMA_DRIFT`, `SCHEMA_DATA_INVALID`, `SCHEMA_TOO_NEW` | “本地数据结构不可安全读取” | 启动/迁移审计，不写业务event | fail-closed |
| 500 | `REVIEW_INVARIANT_FAILED`, `DELIVERY_INVARIANT_FAILED`, `INTERNAL_ERROR` | “复核 / 交付数据不一致” / “发生内部错误” | 对应 failed event（可安全分配时） | fail-closed，correlationId only |

公开 error envelope统一 `{error:{code,message,category?,fields?,currentVersion?,correlationId?}}`。上述 code是 S-6唯一 registry；provider code复用 S-4同名枚举，不另起别名。每个 code的 HTTP/message/event由共享 mapping生成，route、receipt、DTO和 UI不得各自维护字符串；不返回 raw provider/database/error message。

`FrozenPublicContent.reasonCode`不是 HTTP error code，而是同一 strict DTO中的证据状态枚举：`SOURCE_MISSING`→“来源不存在”、`SOURCE_UNREADABLE`→“来源不可读取”、`SOURCE_REDACTED`→“来源包含不可公开内容”、`MATERIAL_BUDGET_EXHAUSTED`→“公开材料预算已用尽”。它们只随 material/manifest返回并由 `review_attempt_failed|review_finalize_failed`的上层 code归档，不单独改变 HTTP status或写任意 payload event。

### 8.4 Redaction

出站 review allowlist允许:

- 当前 reviewer自己的 private role/systemPrompt/skill instructions。
- frozen public material。
- provider请求所需 Authorization，仅在 server-only HTTP调用。

产品域（SQLite、receipt、event、response、DOM、console、截图、delivery）禁止:

- API key、Authorization、master key、cipher/IV/tag、validation token。
- provider endpoint完整私有值、raw request/response/headers。
- execution frozen private JSON、其他 Agent私有 prompt/skill instructions。
- raw environment和绝对 workspace/sandbox/journal path。
- 隐藏思维链标记或模型自称的私密推理。

实现复用 S-5 credential pattern scanner/redactor；review schema只允许 public conclusion/findings/evidence/actions。若合法字段命中哨兵 secret，整个 attempt以 `REVIEW_OUTPUT_REDACTED`无裁决失败，不能用替换后文本通过。logger只写 code/correlationId/projectId/workItemId/attemptId。

### 8.5 Event contract

每个 payload独立 `.strict()`:

- `review_candidates_evaluated {workItemId,resultId,candidateAgentIds,blockerCode}`（只在 owner 发起/被拒绝的 mutation 中落审计；候选 GET 不写事件）
- `review_started {attemptId,workItemId,resultId,resultVersion,reviewerAgentId,materialHash}`
- `review_model_call_started|succeeded {attemptId,modelCallId,kind}`
- `review_model_call_failed {attemptId,modelCallId,kind,category}`
- `review_usage_recorded {attemptId,modelCallId,reported,promptTokens,completionTokens,totalTokens}`
- `review_output_checkpointed {attemptId,modelCallId,publicOutputHash}`
- `review_finalize_failed {attemptId,publicOutputHash,code}`
- `review_attempt_failed|interrupted|discarded {attemptId,category}`
- `review_decided {attemptId,decisionId,resultId,choice}`
- `rework_requested {workItemId,resultId,decisionId}`
- `escalation_opened {escalationId,workItemId,resultId,decisionId}`
- `escalation_answered {escalationId,answerId,action}`
- `result_version_created {workItemId,resultId,resultVersion,executionId,supersedesResultId}`
- `memory_reused|created|superseded {decisionId,memoryId,memoryVersion,candidateId}`
- `work_item_passed|invalidated {workItemId,resultId,decisionId,reasonCode}`
- `completion_write_rejected {workItemId,entryPoint,blockerCodes}`
- `delivery_generation_started|failed {operationId,inputFingerprint,category}`
- `delivery_completed {deliveryId,deliveryVersion,inputFingerprint}`
- `delivery_invalidated {deliveryId,reasonCode,workItemIds}`
- `mission_review_initialized {missionId,headVersion,contextVersion}`
- `mission_context_changed {missionId,missionVersion,contextVersion,reasonCode}`
- `mission_terminated {reason}`
- `operation_replayed {operationId,kind}`

事件不含 review文本、memory正文、answer正文、raw evidence内容、provider错误或 lease token；详情通过 id导航。sequence在 mission delivery head事务内分配，严格递增。

## 9. Transaction 边界与并发

### 9.1 事务清单

| 边界 | 一个事务内必须全有或全无 |
|---|---|
| v5→v6 | DDL、数据回填、validators、user_version |
| create v6 mission | mission row、delivery/review sequence head v1、initialized event sequence 1 |
| first merged result | result v1、review head v1/pending_review、existing merge facts、result event |
| review acquire | receipt pending、attempt calling、head reviewing/current attempt、started event |
| failed/invalid model-call terminal | call status、可信 nullable usage、call/usage events |
| public output checkpoint | final call terminal/usage、redacted parsed output/hash、attempt finalizing、checkpoint event |
| review reject | decision、candidates、attempt rejected、head rework、board投影、events、receipt |
| review escalate | decision、candidates、issue、attempt escalated、head waiting_owner、events、receipt |
| review pass | decision、candidates、memory associations/versions、attempt passed、head passed、board done、events、receipt |
| escalation answer | immutable answer、head next state或mission terminate、events、receipt |
| merged rework | immutable result next version、head pending_review、result event、existing merge DB facts |
| mission/context invalidation | mission/context version、calling/finalizing discard、target/downstream heads、board投影、delivery head失效、operations、events |
| delivery acquire | pending receipt、head generating、started event |
| delivery finalize | immutable delivery/reuse、head completed、event、receipt |

### 9.2 CAS keys

- review head: `workItemId + expectedHeadVersion + currentResultId + state`。
- output checkpoint: `attemptId + status=calling + leaseToken + leaseExpiresAt>dbNow + materialHash + missionVersion + contextVersion`。
- business finalize: `attemptId + status=finalizing + parsedOutputHash + headVersion/currentResultId + missionVersion/contextVersion`。
- first result creation: absent `workItemReviewHead(workItemId)` + unique result version 1；rework result creation: `workItemId + priorHeadVersion + priorCurrentResultId + state=rework`。
- escalation answer: unique escalation id + head expected version/waiting_owner。
- mission delivery head: `missionId + expectedVersion + contextVersion + state + currentOperationId`。
- operation: `(projectId,operationId,kind,requestHash)`。

所有时间比较使用 SQLite UTC clock；不信任客户端时间。affected rows不是1时不得继续写，返回 durable winner或稳定 conflict。

### 9.3 Replay

- canonical request hash排除 operationId，包含 route kind/path ids/expected version及全部业务字段。
- same id/hash completed逐字返回原 HTTP status/body；不重新评估当前资格或门槛。
- same id/hash pending且 attempt=`calling`、lease有效返回 in-progress；lease过期先 reconcile，再返回 interrupted durable result。
- same id/hash pending且 attempt=`finalizing`时直接调用 business finalize replay；成功返回原 operation完成体，本地再次失败返回 `REVIEW_FINALIZE_FAILED`，两者 provider call count均保持不变。
- same id/different hash始终 conflict。
- read/reconcile不自动创建新 provider attempt、answer、execution或delivery generation。

## 10. Restart、Reconcile 与 Fault Matrix

### 10.1 Reconcile

项目/review read、任一相关 mutation和显式 owner重试前调用:

- expired calling review: CAS attempt→interrupted、calling model-call→interrupted（未知 usage为null）、head reviewing→pending_review、完成原 start receipt、append event。
- finalizing review有 durable checkpoint，不受 provider lease过期路径中断；read只显示“公开输出已保存，待提交”。same-operation replay或 owner显式 finalize retry从 checkpoint提交。若 material/mission/context已变化，则原子 discarded并回 pending_review，绝不调用 provider。
- generating delivery的 generation lease过期: CAS head→ongoing/`DELIVERY_INTERRUPTED`、清 lease、完成原 receipt；不生成 delivery。
- 状态已由 finalize完成时 reconcile changes=0，只读取 durable state。

重启不会:

- 自动调用 provider或repair。
- 自动创建新 review attempt。
- 自动回答 escalation。
- 自动启动 rework execution。
- 自动生成 final delivery。

### 10.2 Fault matrix

| 故障/竞态 | 持久结果 | 禁止副作用 | owner恢复 |
|---|---|---|---|
| 无候选/未选择候选 | head pending_review + blocker | attempt/provider/decision=0 | 配置能力并显式选择 |
| reviewer自复核/离组/失去能力 | 拒绝或 late discarded | decision/memory/done=0 | 选择当前合格Agent |
| material空/超2MiB/非法ref | acquire拒绝 | provider=0 | 修复结果/证据 |
| 只有diff/validation/artifact/event hash/header | attempt可 reject/escalate；pass以 `REVIEW_CONTENT_INCOMPLETE`回滚 | 无伪 pass/memory/done | 补齐可读公开正文后新attempt |
| provider auth/network/429/5xx/90s | attempt failed，call/usage可见，head pending_review | decision=0 | 修provider后显式retry新attempt |
| primary invalid、repair合法 | 两call/usage，单合法decision | raw content持久=0 | 无 |
| primary+repair invalid | attempt failed | decision/memory/done=0 | 显式retry |
| strict parse/redaction后 checkpoint成功 | attempt finalizing + public output/hash + final call/usage | raw response/CoT持久=0 | 自动进入本地 finalize或显式重放 |
| checkpoint SQLite fault、进程仍在 | 无 durable checkpoint | provider不重复，内存结果重试 checkpoint | 重试 checkpoint |
| checkpoint前 crash且内存丢失 | attempt到期 interrupted，call usage按已持久事实显示 | 不声称已有可恢复输出 | owner显式新attempt |
| checkpoint后 business finalize DB/memory fault | attempt保持 finalizing，checkpoint只读，operation pending | provider/call/decision/partial memory重复=0 | same operation重放本地 finalize |
| checkpoint后重启 | finalizing与output hash可读 | 自动 provider/repair=0 | 显式继续提交裁决 |
| usage缺失/不一致 | attempt failed `usage_invalid` | decision=0 | 修provider后retry |
| token pre-boundary | 不创建attempt | provider=0 | 调整既有Agent配置或停止 |
| token post-boundary | calls/usage保留，attempt discarded | decision=0 | owner决定后新attempt |
| heartbeat正常 | lease续到now+120s | state/event噪声=0 | 无 |
| lease expiry/reconcile先赢 | interrupted、head pending_review、receipt完成 | late decision/memory=0 | 显式retry |
| mission title/goal/context或task/dependency/result/evidence/memory变化 | calling/finalizing attempt discarded；current delivery失效 | old output业务提交/旧delivery current=0 | 刷新并新attempt/交付 |
| 两客户端选不同reviewer | 一个 acquire/head CAS胜者 | calling attempt≤1 | 输家刷新 |
| reject与new result merge并发 | 一个 head CAS胜者 | 旧decision覆盖新result=0 | 刷新 current result |
| pass中memory source/supersedes非法 | pass事务全回滚，attempt failed | done/partial memory=0 | 修复后新attempt |
| 两pass创建相同memory | 首个create；后者reuse或state conflict | active duplicate=0 | 刷新 |
| 两supersedes同active | 首个新version；后者conflict | 分叉/环=0 | 基于新active再复核 |
| escalation重复/并发answer | 唯一answer | 第二answer/state改写=0 | 读取winner |
| answer continue | old attempt终态，head pending_review | 原attempt第二decision=0 | 显式新attempt |
| answer rework/补证 | head rework | 旧result改写/复核=0 | 新execution→newresult |
| owner/旧API直接done | 409 + rejection event | done/mission/memory=0 | 完成独立复核 |
| passed dependency重开 | task+downstream rework，delivery失效 | 旧history删除=0 | 新execution/review |
| 新 v6 mission/首次 merge并发 | mission+delivery head或result v1+review head全有；唯一winner | orphan mission/result/head与双version1=0 | 输家读取winner |
| delivery acquire后构造失败 | head ongoing+error，tasks仍passed | partial current delivery=0 | 显式retry |
| delivery finalize DB fault | delivery/head全无或全有 | completed无manifest=0 | 显式retry |
| delivery同fingerprint retry | 返回同delivery | duplicate version=0 | 无 |
| restart calling/generating | 显示calling直到lease有效，否则interrupted/failed | 自动外部动作=0 | owner显式retry |
| persisted invariant drift | read 500 fail-closed | 推断pass/completed=0 | 修复存储，不自动改数据 |
| secret/CoT命中output | attempt无裁决失败 | 禁止文本产品域匹配=0 | 修provider输出后retry |

## 11. NFR 落点

| NFR | 满足机制 | 验证方式 |
|---|---|---|
| NFR-1 完成一致性/独立/幂等 | explicit review capability；executor inequality；immutable result/decision；head单指针；partial unique calling；operation receipt；pass单事务；legacy completion gate | 自复核、双reviewer、same/different operation、late result、old done API/replay、pass fault injection，逐项计副作用 |
| NFR-2 持久恢复/审计 | v6全部事实持久；stable event sequence；immutable versions；lease reconcile；无自动重放 | primary/repair/finalize/escalation/memory/delivery各crash点关闭重开独立进程，对比100% refs/state/history |
| NFR-3 隐私/凭据/公开推理 | prompt allowlist；vault server-only；raw provider content内存态；strict public schemas；secret scanner；typed events | 出站允许域与产品禁止域哨兵扫描，DB/response/DOM/log/screenshot/delivery匹配0 |
| NFR-4 a11y/响应式 | 现有tokens/mobile modal；语义status/log/dialog；44px control token；focus trap/restore；文本状态 | desktop/narrow键盘真实浏览器、语义树、对比度、触控目标、live region与截图 |

## 12. 测试策略

### 12.1 分层

- Migration: 真实临时 SQLite，v5空库/含result/memory/legacy done、多result fixture、partial v6、schema drift、每个回填/DDL fault rollback、重开幂等、immutable trigger和完整 data validator；另从空 v6调用 createMission并首次 merge，断言 mission/delivery/review heads、FK/version/event sequence原子且并发唯一。
- Contracts: strict DTO、unknown keys、全部 enum、逐 primary/repair calling/terminal/reported nullable usage/failure refine、公开 response size、cursor scope，以及每个正文 code的 HTTP/固定中文 copy/event映射。
- Qualification: reviewCapable/current membership/executor inequality/0、1、多候选/配置变化。
- Material: source allowlist、稳定排序/hash、diff/validation output/artifact body/event payload实际 chunk、每类精确 source/ref/version/hash、complete/truncated/missing/unreadable、required预算不足/optional预算耗尽、只有header不得pass、2 MiB边界、secret/private/path排除。
- Provider: 本地 OpenAI-compatible server真实 HTTP，success/reject/escalate/pass、primary+repair、两次invalid、usage、1 MiB、manual redirect、401/403/429/5xx/network/90s timeout。
- Lease/operations: fake DB clock覆盖120秒、30秒 heartbeat、same/different id、并发 acquire、expiry reconcile、late finalizer、strict parse→checkpoint各 fault、checkpoint→business finalize各 fault、same operation本地重放 provider call count不变、进程重启。
- Decisions: reject/rework、新 execution/result version、escalation三类answer/new attempt、pass门槛和一attempt一decision。
- Completion: owner route、Agent primitive、旧 replay、dependency DAG reopen、mission empty、manual recovery、mission title/goal/context变更、calling/finalizing attempt与current delivery失效，以及统一 required/optional evidence每个状态。
- Memory: 五类读取、四类Agent candidate、owner兼容、trim/code point/Unicode normalization/case/internal whitespace、source identity/version、reuse、supplement、cross-type、historical invalid、supersedes race/loop/fork。
- Delivery: blocker集合、fingerprint、summary/manifest refs、required/optional evidence、generation failure/retry/reuse、invalidate/history。
- Events/redaction: 每种 payload strict parse、sequence、actor/ref、拒绝/conflict/replay、中断；secret/CoT扫描。
- Components: review workspace、candidate picker、attempt/call/usage、decision/rework/escalation、memory history、delivery progress/evidence。
- Browser: 真实本地 provider、真实 SQLite和公开产品 API；owner选择非执行者→真实调用→三种裁决→返工/升级→新attempt→pass→memory→delivery，刷新和独立进程重启。
- T-24 smoke harness contract: `tests/review-browser-smoke.test.ts`先断言 `package.json`存在 `smoke:review`、harness启动本地 OpenAI-compatible真实 HTTP provider与真实 Next进程、用 Playwright经产品 UI/API而非route interception或直接业务SQLite写入完成全链，并产出 desktop/narrow结果；缺脚本/harness或任一公开闭环缺失即为该任务 RED。GREEN实现 `tests/review-browser-smoke.mjs`及 script，覆盖退回、升级、通过三次真实 provider输出、memory/delivery和独立应用进程重启。

### 12.2 必测边界

- 候选0/1/多；唯一候选也需确认；未选择 disabled。
- result v1/v2与旧attempt迟到；同任务新execution只生成一个next version。
- primary合法/invalid+repair合法/两次invalid；每call calling/各终态、usage reported/unreported/invalid/nullability。
- lease恰在 expiry前/等于/后；heartbeat/finalize/reconcile三方竞态。
- duplicate operation相同/不同 body；两个独立客户端不同reviewer。
- pass memory 0项/多项、exact duplicate、仅前后空白、内部code point差异、source version差异、supersedes winner/loser。
- mission 0 task/部分pass/全部pass、required/optional evidence全状态、title/goal/context并发变化、delivery失败、重试、task reopen。
- desktop/narrow的 loading/empty/error/disabled/success/focus；保存错误保留draft。

### 12.3 运行命令

- 单任务按任务判据运行对应 `npm test -- <files>`，所有普通实现任务经 HarnessFlow逐任务 red/green。
- 全量: `npm test`
- 类型/构建: `npm run build`
- 真实浏览器: 新增 `npm run smoke:review`
- `smoke:review`不得 intercept review/result/memory/delivery公开 route，不得直接写业务 SQLite合成结果；测试夹具只可启动 provider、应用进程和浏览器，并通过公开 owner交互驱动状态。
- 所有机器输出由 `hf_gate.py run`写入 feature evidence；不手写 evidence日志。

## 13. UI 设计（ext-ui-design）

### 13.1 信息架构

桌面:

- 使命看板每个任务卡保留标题/负责人/依赖，并新增明文 effective review status、current result `vN`、reviewer/阻断摘要和“打开复核”入口。
- `ExecutionCard` 在 merged 后不再只显示“已合入”；嵌入 `ReviewWorkspace`，顶部依次为 result版本、执行者、候选选择、真实调用状态、裁决/下一动作。
- `ReviewWorkspace` 设四个语义 tab：材料、复核历史、共享记忆、交付关联。材料复用 execution validation/changes/artifact read API，不复制正文。
- 右侧 context保留 MemoryPanel；memory row增加类型、actor三方、source version链接、active/history链。
- mission header增加 `DeliveryPanel`：ongoing blocker列表、generating状态、completed摘要与 evidence manifest、历史版本。
- escalation在对应 task workspace置顶，不能被普通 chat或通用 owner message冒充回答。

窄屏:

- 复用 cockpit单 `mobileSurface` 和 `useModalSurface`。
- 从 task摘要打开 review detail时一次只显示一个主覆盖区；材料、历史、memory source或delivery evidence使用同一覆盖栈替换内容，不叠第二 modal。
- 关闭/Escape返回触发 task/review/evidence按钮；背景 inert，focus trap保持。

### 13.2 Review 关键状态

- loading: 候选、材料、attempt、history各自 `aria-busy`；loading未完成不显示empty。
- empty:
  - 无result: “任务仍在执行或尚无已合入结果”。
  - 无候选: “缺少独立复核者”，链接到Agent能力配置。
  - 无history/memory: 明确“尚无”而非隐藏区域。
- error: 固定中文 code copy、保留当前 result/reviewer选择和展开位置；提供读取重试。
- disabled:
  - 未选reviewer、候选失效、result非current、head非pending、调用进行中、mission terminated、材料缺失。
  - 按钮附近用 `aria-describedby` 明文原因，不只用disabled视觉。
- success: 发起后 polite live “已由 X 开始复核 result vN”；终态后聚焦裁决 heading；重试成功不清空历史。
- focus: candidate radios使用 fieldset/legend；提交错误聚焦字段或错误摘要；history tab支持 Arrow/Home/End。

真实调用显示:

- reviewer稳定头像/accent + 明文名字。
- provider/model非敏感身份、material短hash、primary/repair状态、usage reported/unreported。
- material tab实际展示可读 diff/validation output/artifact/event公开正文、精确 source version与 complete/truncated/missing/unreadable；只有hash/header时 pass状态明确 disabled并关联 `REVIEW_CONTENT_INCOMPLETE`。
- attempt=`finalizing`显示“公开输出已保存，待提交”，提供“继续提交裁决”；失败文案明确重试不会再次调用模型，刷新后保留 checkpoint hash、逐call状态和选择。
- UI只按 `finalize.mode`决定动作：`local-finalize-only`显示“继续提交裁决”且明文“不会再次调用模型”；`new-provider-attempt`显示“重新发起复核”且明文“将创建新 attempt 并再次调用模型”；`none`不显示 retry。workspace current、history row和detail页的状态/copy/action必须一致，禁止根据 `errorCategory`猜测。
- 不显示prompt、raw response、key/mask或“思考中”CoT文案；使用“正在调用/正在校验公开输出”。

### 13.3 Reject / Escalate / Pass

- reject: 高优先级 `待返工`标题、Agent公开summary、返工要求、evidence链接；“开始返工执行”只在 S-5 execution资格满足时启用。
- escalation: question、options和evidence；owner answer textarea + action radio（继续复核/返工/终止使命）。提交失败保留answer/action draft；成功聚焦新状态。
- pass: 显示 reviewer/decision/result version、memory created/reused/superseded结果；task状态“已通过完成”同时有文字和图形，不只绿色。
- 历史每attempt展示 terminal choice或“无裁决失败/中断/失效”、material hash、usage和时间；旧attempt只读。

### 13.4 Memory

- 类型增加“经验”，完全复用既有 type tokens/排版，不新增装饰图标。
- actor区:
  - owner条目：“Owner 提议”。
  - Agent条目：“Agent X 提议 · 通过裁决 Y 确认 · 平台持久化”。
- source为可聚焦链接，显示 `type · id短码 · version`；legacy null version显示“原有来源（无版本）”，不伪造版本。
- history展开按 version顺序，active/已取代有文字；supersedes关系可导航。
- owner创建表单保持既有字段和draft行为；不能选择 Agent actor或review confirmation。

### 13.5 Delivery

- ongoing: 展示按 task稳定顺序 blocker（待结果/待复核/返工/待owner/证据/记忆/交付错误），不展示虚构summary。
- generate button disabled时列全部原因；enabled时文本“生成最终交付”。
- generating: `aria-busy`、按钮disabled、刷新后仍显示；不自动继续。
- failure: alert + fixed category +“显式重试”；passed task和memory仍显示成功。
- completed: mission conclusion、完成时间、逐任务 executor/reviewer/decision、changes、validation、artifact、memory、limitations；每个 evidence status有文字。
- invalidated: 旧delivery历史标“已被后续任务变化取代”，current区回ongoing。

### 13.6 视觉系统

- 只复用 `--canvas/--surface/--surface-muted/--text/--text-muted/--border/--accent/--success/--warning/--danger`、Agent accent tokens、现有 font/space/radius/shadow/focus。
- 所有新间距、字号、圆角、颜色引用 token；不硬编码色值，不新增渐变、glass、emoji、装饰动效或无需求数字徽标。
- review状态可复用 success/warning/danger但必须伴随文字和状态标题。
- result/material/evidence短hash使用 `--font-mono`；完整值放可访问详情，不以tooltip作为唯一信息。

### 13.7 Accessibility

- 文本对比度满足 WCAG AA；所有按钮、radio、tab、link至少 `--control-min`=44px。
- task/review/delivery用 `section`+heading；history/events `role=log`；异步成功独立 polite live region；错误 `role=alert`。
- tablist支持 ArrowLeft/Right、Home/End；dialog focus trap/inert/Escape/restore复用现有 primitive。
- 状态、Agent、decision、evidence不只靠颜色；头像文字仍有可读name。
- 保存/调用失败保留未提交选择、reason/findings/answer draft；字段错误用 `aria-describedby`关联。

## 14. 任务清单

- [x] T-1 打通最薄 owner→真实非执行者 review→唯一裁决→UI 回显切片 (覆盖: FR-1, FR-2, FR-3, FR-14, NFR-1, NFR-3, NFR-4) — 判据: `npm test -- tests/review-slice.test.tsx` 先红后绿；从全新v6 mission/work item首次真实execution/merge开始，owner明确选择reviewCapable非执行者Agent，本地OpenAI-compatible HTTP实际读到冻结diff与required validation正文（不是hash/header），合法pass形成唯一decision并显示reviewer/material/call/usage/choice；唯一候选不自动发起，client/owner无提交裁决route，loading/empty/error/disabled/success/focus可断言
- [x] T-2 收紧 SQLite v6 完整迁移、全新 mission 初始化与不可变不变量 (覆盖: FR-4, FR-5, FR-6, FR-7, FR-8, FR-9, FR-10, FR-11, FR-12, FR-13, NFR-1, NFR-2, NFR-3) — 判据: `npm test -- tests/migrations-v6.test.ts tests/mission-v6-initialization.test.ts` 先红后绿；完整/部分/漂移v5回填与每fault rollback通过；全新createMission原子生成delivery head/context v1/sequence1 event，FK/version/validator正确，create并发唯一winner且无orphan
- [x] T-3 实现 review capability 配置与候选资格复算 (覆盖: FR-1, FR-11, FR-13) — 判据: `npm test -- tests/review-qualification.test.ts tests/agent-review-capability-ui.test.tsx` 先红后绿；v6既有Agent false、reviewer模板显式预选、owner保存strict boolean，0/1/多候选、自复核、离组/失能/执行者变化、资格依据和无暗选通过
- [x] T-4 实现首次 merge review-head 初始化、immutable result 与返工新版链 (覆盖: FR-4, FR-5, FR-6, FR-11, FR-12) — 判据: `npm test -- tests/result-version-rework.test.ts tests/execution-rework-integration.test.ts` 先红后绿；无历史head的首次merge原子写result v1/head v1/pending_review/result event，两个首次merge唯一winner；reject/补证旧result只读，新execution连续next version，旧attempt迟到与并发merge/reject不覆盖
- [x] T-5 统一所有旧任务/使命完成写入口与依赖重开失效 (覆盖: FR-6, FR-7, FR-10, FR-11, FR-12, FR-13) — 判据: `npm test -- tests/completion-gate.test.ts tests/mission-legacy-entrypoints.test.ts` 先红后绿；owner transition、Agent primitive、内部写、same-operation replay均不能绕过，passed投影一致，空mission/阻断列表、传递依赖重开、downstream rework、delivery失效与历史保留通过
- [x] T-6 实现 frozen bounded public正文、导航版本与 stale hash (覆盖: FR-2, FR-3, FR-6, FR-8, FR-10, FR-11, FR-13, NFR-3) — 判据: `npm test -- tests/review-material.test.ts` 先红后绿；真实diff/validation outputs/artifact body/event payload按精确ref/version/hash和64KiB chunk稳定内嵌，complete/truncated/missing/unreadable及required/optional 2MiB预算可断言；只有header/hash、required不完整不得pass，optional缺失可带限制，绝对path/private prompt/key/CoT排除且任一版本变化discard
- [x] T-7 实现 strict review output、一次 repair 与 evidence/candidate校验 (覆盖: FR-2, FR-3, FR-4, FR-5, FR-8, FR-13, NFR-3) — 判据: `npm test -- tests/review-output-schema.test.ts tests/review-structured-repair.test.ts` 先红后绿；三选一、reject要求、escalate边界、pass 0 candidate、unknown/multiple/missing decision、foreign ref/source、primary/repair组合、raw invalid不落产品域通过
- [x] T-8 实现 review operation、逐call usage、durable output checkpoint与显式 retry (覆盖: FR-2, FR-3, FR-11, FR-12, FR-13, NFR-1, NFR-2) — 判据: `npm test -- tests/review-orchestrator.test.ts tests/review-recovery.test.ts` 先红后绿；same/different operation、90s/30s/120s、primary/repair calling/terminal/reported nullable usage、token/provider失败通过；strict parse+redaction后只持久公开output/hash/call终态，raw/CoT为0，checkpoint后restart/replay provider call count不增加
- [x] T-9 实现 checkpoint→reject/pass 本地原子提交与可恢复重放 (覆盖: FR-3, FR-4, FR-6, FR-11, FR-13, NFR-1) — 判据: `npm test -- tests/review-decisions.test.ts tests/review-finalize-replay.test.ts` 先红后绿；business finalize只读checkpoint，每attempt一decision，reject/pass所有head/board/memory/event/receipt全有或全无；每个SQLite/memory fault保持finalizing，same operation重放成功且call/model usage行数不变
- [x] T-10 实现 escalation issue、owner answer 与新 attempt链 (覆盖: FR-3, FR-5, FR-7, FR-11, FR-12, FR-13) — 判据: `npm test -- tests/review-escalation.test.ts tests/review-escalation-ui.test.tsx` 先红后绿；唯一open issue、continue/rework/terminate、answer幂等并发、原attempt只读、同result新attempt/材料变化新result、不能直接pass、draft/error/focus通过
- [x] T-11 扩展五类 memory strict DTO、owner兼容与 source resolver (覆盖: FR-8, FR-12, FR-13) — 判据: `npm test -- tests/memory-v6-contracts.test.ts tests/memory-source-navigation.test.ts` 先红后绿；goal/decision/fact/artifact/experience、owner actor/source不变、Agent proposer/decision/platform责任、task/result/review/validation/artifact精确版本/href、跨项目/漂移fail-closed通过
- [ ] T-12 实现 memory 确定性去重与 reuse association (覆盖: FR-6, FR-8, FR-9, FR-11, NFR-1) — 判据: `npm test -- tests/review-memory-dedup.test.ts` 先红后绿；type+trim content原code point+source tuple全等reuse，前后空白、内部空白/大小写/NFC-NFD/不同source version、补充/跨类型/历史invalid样例及双pass并发active duplicate=0通过
- [ ] T-13 实现 memory supersedes immutable chain 与 pass集成 (覆盖: FR-6, FR-8, FR-9, FR-11, FR-12, FR-13) — 判据: `npm test -- tests/review-memory-supersedes.test.ts` 先红后绿；显式同类型唯一active前版、chain/version/history、无隐式替代、自环/跨项目/跨类型/历史target拒绝、双supersede无分叉、pass rollback和重启导航通过
- [ ] T-14 实现统一 required/optional evidence、mission context fingerprint与 manifest (覆盖: FR-7, FR-10, FR-11, FR-13) — 判据: `npm test -- tests/delivery-manifest.test.ts` 先红后绿；result/review/diff/validation/artifact/event/memory逐类required判定和每个status一致，optional missing/unreadable不阻断但可见，required不可读阻断；fingerprint含mission version/contextVersion，summary只取公开事实、version href和256KiB边界通过
- [ ] T-15 实现 delivery两阶段生成、mission/context失效、失败重试与历史 (覆盖: FR-7, FR-10, FR-11, FR-12, FR-13, NFR-1, NFR-2) — 判据: `npm test -- tests/delivery-service.test.ts tests/delivery-recovery.test.ts` 先红后绿；title/goal/context更新原子discard calling/finalizing attempt并失效current/generating delivery，CAS并发winner明确；生成每fault无partial，same fingerprint reuse、restart不自动生成、显式retry、task reopen通过
- [ ] T-16 完成 strict逐call/attempt finalize DTO、read API、error registry 与 typed events (覆盖: FR-3, FR-4, FR-5, FR-8, FR-9, FR-10, FR-12, FR-13) — 判据: `npm test -- tests/review-read-api.test.ts tests/review-events.test.ts tests/review-errors.test.ts` 先红后绿；attempt status含finalizing，workspace/history/detail共享严格联合：checkpoint+calling/finalizing/本地提交失败仅local-finalize-only/false，checkpoint前failed/interrupted仅new-provider-attempt/true，裁决终态none，非法组合500；primary/repair nullable usage/failure、全部code HTTP/中文copy/event、分页/size/cursor/sequence通过
- [ ] T-17 收口产品域 redaction、secret/CoT 与 actor防伪 (覆盖: FR-1, FR-2, FR-3, FR-8, FR-10, FR-13, NFR-3) — 判据: `npm test -- tests/review-redaction.test.ts tests/review-forgery.test.ts` 先红后绿；出站只含当前reviewer私有+allowlist，owner/platform/client伪造Agent裁决/记忆=0，key/Auth/master/cipher/token/raw body/env/path/other prompt/CoT在DB/response/event/log/DOM/delivery匹配0
- [ ] T-18 完成 restart/invariant/fault矩阵集成 (覆盖: FR-2, FR-3, FR-4, FR-5, FR-6, FR-7, FR-8, FR-9, FR-10, FR-11, FR-12, FR-13, NFR-1, NFR-2, NFR-3) — 判据: `npm test -- tests/review-fault-injection.test.ts tests/review-restart-integration.test.ts` 先红后绿；provider response→checkpoint→business finalize各crash点、mission/context并发失效、全新mission/first merge、其他裁决/memory/delivery crash关闭重开后refs/state/history一致率100%，checkpoint后provider重放0，invariant drift fail-closed
- [ ] T-19 交付桌面公开材料、逐call与 finalize 工作区 (覆盖: FR-1, FR-2, FR-3, FR-14, NFR-4) — 判据: `npm test -- tests/review-workspace-ui.test.tsx` 先红后绿；实际diff/output/artifact/event正文、source/status、primary/repair/nullable usage/failure可见；workspace/history/detail对local-finalize-only显示不调用模型的继续提交，对new-provider-attempt显示会调用模型的新attempt，对none无retry，finalizing刷新保留；hash-only pass disabled及全关键UI状态通过
- [ ] T-20 交付返工、升级与逐attempt历史 UI (覆盖: FR-4, FR-5, FR-6, FR-12, FR-14, NFR-4) — 判据: `npm test -- tests/review-outcomes-ui.test.tsx` 先红后绿；reject要求→新execution入口、escalation三action、answer draft、new attempt提示、terminal/无裁决/stale历史、version导航、键盘tab/focus/live通过
- [ ] T-21 交付五类 memory actor/source/version/history UI (覆盖: FR-8, FR-9, FR-12, FR-14, NFR-4) — 判据: `npm test -- tests/memory-v6-ui.test.tsx` 先红后绿；经验类、owner与Agent责任、source version/href、created/reused/superseded、active/history chain、loading/empty/error/disabled/success/focus且owner表单不能伪造actor通过
- [ ] T-22 交付 final delivery progress/summary/evidence UI (覆盖: FR-7, FR-10, FR-12, FR-14, NFR-4) — 判据: `npm test -- tests/delivery-ui.test.tsx` 先红后绿；blockers/generating/failure显式retry/completed/invalidated history、逐task refs、证据状态与影响、版本导航、无虚构summary、draft/error/live/focus通过
- [ ] T-23 交付窄屏单surface与完整 a11y/token纪律 (覆盖: FR-14, NFR-4) — 判据: `npm test -- tests/review-accessibility.test.tsx` 先红后绿；desktop+narrow仅键盘完成review/answer/memory/delivery，一次一个modal、trap/inert/Escape/restore、44px、WCAG AA、状态非仅颜色、无硬编码视觉值通过
- [ ] T-24 新增真实 provider/browser `smoke:review` harness并收口全链 (覆盖: FR-1, FR-2, FR-3, FR-4, FR-5, FR-6, FR-7, FR-8, FR-9, FR-10, FR-11, FR-12, FR-13, FR-14, NFR-1, NFR-2, NFR-3, NFR-4) — 判据: `npm test -- tests/review-browser-smoke.test.ts`先红后绿；RED固定证明`smoke:review` script/harness contract缺失或不能经真实provider+browser完成公开闭环，GREEN新增`tests/review-browser-smoke.mjs`和package script，禁止route interception/直接业务SQLite写入，从全新v6 mission/首次merge经非执行者Agent真实读取正文依次覆盖退回→新result、升级→owner answer/new attempt、通过→memory→delivery，独立应用进程重启后历史完整，并以Playwright完成desktop/narrow键盘路径与截图；GREEN后再运行`npm test`、`npm run build`、`npm run smoke:review`收口

任务覆盖索引:

- FR-1 → T-1, T-3, T-17, T-19, T-24
- FR-2 → T-1, T-6, T-7, T-8, T-17, T-18, T-19, T-24
- FR-3 → T-1, T-6, T-7, T-8, T-9, T-10, T-16, T-17, T-18, T-19, T-24
- FR-4 → T-2, T-4, T-7, T-9, T-16, T-18, T-20, T-24
- FR-5 → T-2, T-4, T-7, T-10, T-16, T-18, T-20, T-24
- FR-6 → T-2, T-4, T-5, T-6, T-9, T-12, T-13, T-18, T-20, T-24
- FR-7 → T-2, T-5, T-10, T-14, T-15, T-18, T-22, T-24
- FR-8 → T-2, T-6, T-7, T-11, T-12, T-13, T-16, T-17, T-18, T-21, T-24
- FR-9 → T-2, T-12, T-13, T-16, T-18, T-21, T-24
- FR-10 → T-2, T-5, T-6, T-14, T-15, T-16, T-17, T-18, T-22, T-24
- FR-11 → T-2, T-3, T-4, T-5, T-6, T-8, T-9, T-10, T-12, T-13, T-14, T-15, T-18, T-24
- FR-12 → T-2, T-4, T-5, T-8, T-10, T-11, T-13, T-15, T-16, T-18, T-20, T-21, T-22, T-24
- FR-13 → T-2, T-3, T-5, T-6, T-7, T-8, T-9, T-10, T-11, T-13, T-14, T-15, T-16, T-17, T-18, T-24
- FR-14 → T-1, T-19, T-20, T-21, T-22, T-23, T-24
- NFR-1 → T-1, T-2, T-8, T-9, T-12, T-15, T-18, T-24
- NFR-2 → T-2, T-8, T-15, T-18, T-24
- NFR-3 → T-1, T-2, T-6, T-7, T-17, T-18, T-24
- NFR-4 → T-1, T-19, T-20, T-21, T-22, T-23, T-24

## 15. Design Checklist 自检

- [x] FR-1 至 FR-14、NFR-1 至 NFR-4均有设计落点，任务覆盖索引穷尽全部编号。
- [x] 未增加多人账号、外部发送、跨项目复核、投票/评分、自动后台续跑、知识搜索或物理删除历史。
- [x] 关键真实决策均比较至少两个方案，并选择顺着 S-3/S-4/S-5现有模式的方案。
- [x] 接口、数据契约、错误、事件、事务、CAS、状态机和故障恢复具体到 build阶段无需再发明。
- [x] 所有资源数字沿用现有事实：90秒 provider call、120秒 lease、30秒 heartbeat、一次 repair、1 MiB provider response、2 MiB frozen context、20,000 grapheme公开文本/记忆、128/256/512 KiB API envelope、20/100分页、24小时cursor、44px与WCAG AA；未新增性能/容量阈值。
- [x] ext-ui-design章节位于测试策略后、任务清单前，覆盖 desktop/narrow、loading/empty/error/disabled/success/focus、token和a11y。
- [x] T-1先打通 owner→真实review→decision→UI最薄切片；普通 T-1 至 T-24均有一次明确先红后绿边界，T-24以缺失的真实 `smoke:review` provider/browser harness contract为RED、实现公开全链为GREEN；inline覆盖与逐项索引一致。
