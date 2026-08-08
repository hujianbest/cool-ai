# 项目内持久线程与上下文续接技术设计

- 日期: 2026-08-08
- 规格: ./spec.md（已批准）
- 评审修订: 关闭 `reviews/design-review.md` 第 1 轮全部 blocking/general findings
- 架构影响: 保持 Next.js/React/TypeScript/SQLite 边界；把 v4 项目级协作收紧为项目+线程 tuple，并删除 execution 对“项目最新 run”的隐式依赖。

## 1. 架构与依赖方向

- `src/server/migrations-v7.ts` 是 v7 schema、迁移、规范化校验、事实校验的唯一来源；`migrations.ts` 只执行 6→7 的一次原子调用。
- `src/server/collaboration/thread-service.ts` 统一分配项目活动序号、线程 fact/message 序号、policy revision 和 receipt；`run-service`、`turn-orchestrator`、`action-committer` 不自行写 thread facts。
- 所有 collaboration HTTP 入口使用显式 `ProjectThreadRunTuple={projectId,threadId,runId}`；API→service→SQL 不降级为 runId-only。
- `prompt-builder` 只读取 tuple.threadId；Mission、看板、active memory 继续读取项目共享事实。execution/review/delivery 只沿冻结 source tuple 追溯。
- `ProjectPanel` 解析 URL；`CollaborationPanel` 接收 `{projectId,threadId,selectedRunId}` props 并传给所有读取、轮询、写入、对账和下游表面。

## 2. 关键决策

### D-1: v7 升级形态
- A `ALTER ADD thread_id`：简单，但无法补 NOT NULL/复合 FK/精确 CHECK。
- B 单个 `BEGIN IMMEDIATE` 内建最终 shadow schema、回填、替换、校验、最后写 `user_version=7`：步骤多，但任何 fault 全回滚。
- 选择 B；迁移过程中不存在可打开的“临时 v7”，T-1 即最终 schema/validator。

### D-2: 公开渲染与审计
- A UI 合并 messages 与 run events：会重复显示 owner/Agent message。
- B `thread_facts` 是唯一渲染流，message fact 内嵌 dereferenced message DTO；messages page 只供 prompt/receipt 对账。
- 选择 B；每个业务事实一个 fact，每项目活动序号决定列表，每线程 fact 序号决定历史。

### D-3: policy 历史
- A 直接覆盖成员集合：无法保留历史或并发冲突。
- B 不可变 revision/member + thread active head 的 deferred FK：多 join，但历史和 version 可证明。
- 选择 B；live roster 只在 owner 显式修复及实际 dispatch 时校验，不自动改 policy。

### D-4: URL 与 run 选择
- A 本地状态+最新 run：刷新丢失且可能跨线程替代。
- B `/projects/:projectId?thread=:threadId[&run=:runId]` 是选择事实；run 缺失即未选，不猜最新。
- 选择 B；无 thread 才按线程列表首项恢复，run 始终 owner 显式选择。

### D-5: Agent 凭据检查时机
- A parse/repair 后只扫 message：其他公开字段可绕过，primary secret 会发给 repair Provider。
- B primary raw 成功响应先扫；未命中才 parse/repair；repair raw 再扫；解析后原子扫所有公开文本。
- 选择 B；任一命中立即生成 sanitized terminal outcome，不 repair、不再次调用 Provider、不提交任何业务 fact。

## 3. v7 权威对象 manifest

实现必须把下方每条 `CREATE ...;` 原文分别保存为 `V7_TABLE_SQL`/`V7_INDEX_TRIGGER_SQL` map value，`V7_OBJECT_SQL=[...maps.values()]` 是 migration 与 validator 唯一 DDL source。`renderV7(prefix:""|"v7_")` 只能 token-safe 替换这些 map 中已知 object identifier，不能生成或改写列/CHECK/FK/index/trigger；final执行 `renderV7("")`，shadow执行 `renderV7("v7_")`。所有时间 CHECK 使用现有 UTC GLOB；grapheme 上限由第6节唯一 strict request schemas执行。

### 3.1 唯一 DDL source of truth

```sql
CREATE TABLE collaboration_threads(
 id TEXT PRIMARY KEY,project_id TEXT NOT NULL,title TEXT NOT NULL CHECK(length(title)>=1 AND title=trim(title)),
 active_policy_revision_id TEXT NOT NULL,policy_version INTEGER NOT NULL CHECK(policy_version>=1),
 next_fact_sequence INTEGER NOT NULL CHECK(next_fact_sequence>=1),last_activity_sequence INTEGER NOT NULL CHECK(last_activity_sequence>=1),
 version INTEGER NOT NULL CHECK(version>=1),
 created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z'),
 updated_at TEXT NOT NULL CHECK(updated_at GLOB '????-??-??T??:??:??.???Z'),
 UNIQUE(project_id,id),UNIQUE(project_id,last_activity_sequence),
 FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
 FOREIGN KEY(project_id,id,active_policy_revision_id)
  REFERENCES collaboration_thread_policy_revisions(project_id,thread_id,id)
  ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE collaboration_project_thread_sequences(
 project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
 next_activity_sequence INTEGER NOT NULL CHECK(next_activity_sequence>=1)
);
CREATE TABLE collaboration_runs(
 id TEXT PRIMARY KEY,project_id TEXT NOT NULL,thread_id TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN('running','waiting_owner','paused','failed','planned','stopped')),
 current_agent_id TEXT NOT NULL,round_count INTEGER NOT NULL DEFAULT 0 CHECK(round_count>=0),
 next_event_sequence INTEGER NOT NULL DEFAULT 1 CHECK(next_event_sequence>=1),
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),execution_epoch INTEGER NOT NULL DEFAULT 1 CHECK(execution_epoch>=1),
 pause_reason TEXT,pause_category TEXT,
 created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z'),
 updated_at TEXT NOT NULL CHECK(updated_at GLOB '????-??-??T??:??:??.???Z'),
 UNIQUE(project_id,id),UNIQUE(project_id,thread_id,id),
 FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
 FOREIGN KEY(project_id,thread_id) REFERENCES collaboration_threads(project_id,id) ON DELETE CASCADE,
 FOREIGN KEY(current_agent_id) REFERENCES agents(id) ON DELETE NO ACTION
);
CREATE TABLE collaboration_operations(
 id TEXT NOT NULL,project_id TEXT NOT NULL,thread_id TEXT NOT NULL,run_id TEXT,
 kind TEXT NOT NULL CHECK(kind IN('thread_create','policy_update','start','message','control','answer_decision','advance','recover')),
 request_hash TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN('pending','completed')),
 http_status INTEGER,response_json TEXT,response_schema_version INTEGER,
 created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z'),
 updated_at TEXT NOT NULL CHECK(updated_at GLOB '????-??-??T??:??:??.???Z'),
 PRIMARY KEY(project_id,id),UNIQUE(project_id,thread_id,id),UNIQUE(project_id,thread_id,run_id,id),
 CHECK(
  (status='pending' AND http_status IS NULL AND response_json IS NULL AND response_schema_version IS NULL) OR
  (status='completed' AND http_status BETWEEN 100 AND 599 AND json_valid(response_json)
   AND length(CAST(response_json AS BLOB))<=262144 AND response_schema_version=7)
 ),
 FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
 FOREIGN KEY(project_id,thread_id) REFERENCES collaboration_threads(project_id,id)
  ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(project_id,thread_id,run_id) REFERENCES collaboration_runs(project_id,thread_id,id) ON DELETE CASCADE
);
CREATE TABLE collaboration_thread_policy_revisions(
 id TEXT PRIMARY KEY,project_id TEXT NOT NULL,thread_id TEXT NOT NULL,version INTEGER NOT NULL CHECK(version>=1),
 created_operation_id TEXT NOT NULL,
 created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z'),
 UNIQUE(project_id,thread_id,id),UNIQUE(project_id,thread_id,version),
 FOREIGN KEY(project_id,thread_id) REFERENCES collaboration_threads(project_id,id) ON DELETE CASCADE,
 FOREIGN KEY(project_id,thread_id,created_operation_id) REFERENCES collaboration_operations(project_id,thread_id,id)
  ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE collaboration_thread_policy_members(
 project_id TEXT NOT NULL,thread_id TEXT NOT NULL,revision_id TEXT NOT NULL,position INTEGER NOT NULL CHECK(position>=0),
 agent_id TEXT NOT NULL,agent_display_name TEXT NOT NULL CHECK(length(agent_display_name)>=1),
 PRIMARY KEY(project_id,thread_id,revision_id,agent_id),UNIQUE(project_id,thread_id,revision_id,position),
 FOREIGN KEY(project_id,thread_id,revision_id) REFERENCES collaboration_thread_policy_revisions(project_id,thread_id,id) ON DELETE CASCADE
);
CREATE TABLE collaboration_project_sequences(
 project_id TEXT NOT NULL,thread_id TEXT NOT NULL,next_message_sequence INTEGER NOT NULL DEFAULT 1 CHECK(next_message_sequence>=1),
 PRIMARY KEY(project_id,thread_id),
 FOREIGN KEY(project_id,thread_id) REFERENCES collaboration_threads(project_id,id) ON DELETE CASCADE
);
CREATE TABLE collaboration_messages(
 id TEXT PRIMARY KEY,project_id TEXT NOT NULL,thread_id TEXT NOT NULL,run_id TEXT,
 author_type TEXT NOT NULL CHECK(author_type IN('owner','agent')),author_agent_id TEXT,
 author_display_name TEXT NOT NULL CHECK(length(author_display_name)>=1),content TEXT NOT NULL CHECK(length(content)>=1),
 mention_agent_id TEXT,mention_display_name TEXT,sequence INTEGER NOT NULL CHECK(sequence>=1),
 consumed_at TEXT CHECK(consumed_at IS NULL OR consumed_at GLOB '????-??-??T??:??:??.???Z'),
 created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z'),
 UNIQUE(project_id,thread_id,id),UNIQUE(project_id,thread_id,run_id,id),UNIQUE(project_id,thread_id,sequence),
 CHECK((author_type='owner' AND author_agent_id IS NULL) OR (author_type='agent' AND author_agent_id IS NOT NULL)),
 CHECK((mention_agent_id IS NULL AND mention_display_name IS NULL) OR
       (mention_agent_id IS NOT NULL AND mention_display_name IS NOT NULL)),
 FOREIGN KEY(project_id,thread_id) REFERENCES collaboration_threads(project_id,id) ON DELETE CASCADE,
 FOREIGN KEY(project_id,thread_id,run_id) REFERENCES collaboration_runs(project_id,thread_id,id) ON DELETE NO ACTION,
 FOREIGN KEY(author_agent_id) REFERENCES agents(id) ON DELETE NO ACTION,
 FOREIGN KEY(mention_agent_id) REFERENCES agents(id) ON DELETE NO ACTION
);
CREATE TABLE collaboration_attempts(
 id TEXT PRIMARY KEY,project_id TEXT NOT NULL,thread_id TEXT NOT NULL,run_id TEXT NOT NULL,agent_id TEXT NOT NULL,
 operation_id TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN('calling','committed','failed','interrupted','discarded')),
 lease_token TEXT NOT NULL,lease_expires_at TEXT NOT NULL CHECK(lease_expires_at GLOB '????-??-??T??:??:??.???Z'),
 prompt_hash TEXT NOT NULL,acquire_execution_epoch INTEGER NOT NULL CHECK(acquire_execution_epoch>=1),
 acquire_context_hash TEXT NOT NULL,included_message_sequence INTEGER NOT NULL CHECK(included_message_sequence>=0),
 error_category TEXT,failure_provider_id TEXT,
 failure_provider_version INTEGER CHECK(failure_provider_version IS NULL OR failure_provider_version>=1),
 failure_credential_version INTEGER CHECK(failure_credential_version IS NULL OR failure_credential_version>=1),
 failure_credential_generation INTEGER CHECK(failure_credential_generation IS NULL OR failure_credential_generation>=1),
 failure_verified_at TEXT CHECK(failure_verified_at IS NULL OR failure_verified_at GLOB '????-??-??T??:??:??.???Z'),
 started_at TEXT NOT NULL CHECK(started_at GLOB '????-??-??T??:??:??.???Z'),
 finished_at TEXT CHECK(finished_at IS NULL OR finished_at GLOB '????-??-??T??:??:??.???Z'),
 UNIQUE(project_id,thread_id,id),UNIQUE(project_id,thread_id,run_id,id),
 UNIQUE(project_id,thread_id,run_id,operation_id),
 CHECK((status='calling' AND finished_at IS NULL) OR (status<>'calling' AND finished_at IS NOT NULL)),
 FOREIGN KEY(project_id,thread_id) REFERENCES collaboration_threads(project_id,id) ON DELETE CASCADE,
 FOREIGN KEY(project_id,thread_id,run_id) REFERENCES collaboration_runs(project_id,thread_id,id) ON DELETE CASCADE,
 FOREIGN KEY(project_id,thread_id,run_id,operation_id)
  REFERENCES collaboration_operations(project_id,thread_id,run_id,id) ON DELETE NO ACTION,
 FOREIGN KEY(agent_id) REFERENCES agents(id) ON DELETE NO ACTION
);
CREATE TABLE collaboration_model_calls(
 id TEXT PRIMARY KEY,attempt_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN('primary','repair')),
 call_index INTEGER NOT NULL CHECK(call_index IN(1,2)),
 status TEXT NOT NULL CHECK(status IN('succeeded','provider_failed','response_invalid','usage_invalid')),
 prompt_tokens INTEGER CHECK(prompt_tokens IS NULL OR prompt_tokens>=0),
 completion_tokens INTEGER CHECK(completion_tokens IS NULL OR completion_tokens>=0),
 total_tokens INTEGER CHECK(total_tokens IS NULL OR total_tokens>=0),error_category TEXT,
 created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z'),
 UNIQUE(attempt_id,call_index),
 CHECK((prompt_tokens IS NULL AND completion_tokens IS NULL AND total_tokens IS NULL) OR
       (prompt_tokens IS NOT NULL AND completion_tokens IS NOT NULL AND total_tokens=prompt_tokens+completion_tokens)),
 FOREIGN KEY(attempt_id) REFERENCES collaboration_attempts(id) ON DELETE CASCADE
);
CREATE TABLE collaboration_turns(
 id TEXT PRIMARY KEY,project_id TEXT NOT NULL,thread_id TEXT NOT NULL,attempt_id TEXT NOT NULL,
 run_id TEXT NOT NULL,agent_id TEXT NOT NULL,round_number INTEGER NOT NULL CHECK(round_number>=1),
 message_id TEXT NOT NULL,disposition TEXT NOT NULL CHECK(disposition IN('handoff','decision_request','plan_ready')),
 created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z'),
 UNIQUE(project_id,thread_id,id),UNIQUE(project_id,thread_id,run_id,id),
 UNIQUE(attempt_id),UNIQUE(message_id),UNIQUE(run_id,round_number),
 FOREIGN KEY(project_id,thread_id,run_id,attempt_id)
  REFERENCES collaboration_attempts(project_id,thread_id,run_id,id) ON DELETE NO ACTION,
 FOREIGN KEY(project_id,thread_id,run_id) REFERENCES collaboration_runs(project_id,thread_id,id) ON DELETE CASCADE,
 FOREIGN KEY(project_id,thread_id,run_id,message_id)
  REFERENCES collaboration_messages(project_id,thread_id,run_id,id) ON DELETE NO ACTION,
 FOREIGN KEY(agent_id) REFERENCES agents(id) ON DELETE NO ACTION
);
CREATE TABLE decision_requests(
 id TEXT PRIMARY KEY,project_id TEXT NOT NULL,thread_id TEXT NOT NULL,run_id TEXT NOT NULL,turn_id TEXT NOT NULL,
 requesting_agent_id TEXT NOT NULL,question TEXT NOT NULL CHECK(length(question)>=1),
 options_json TEXT NOT NULL CHECK(json_valid(options_json) AND json_type(options_json)='array' AND json_array_length(options_json) BETWEEN 2 AND 8),
 status TEXT NOT NULL CHECK(status IN('open','answered')),answer TEXT,answer_message_id TEXT,
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
 created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z'),
 answered_at TEXT CHECK(answered_at IS NULL OR answered_at GLOB '????-??-??T??:??:??.???Z'),
 UNIQUE(project_id,thread_id,run_id,id),UNIQUE(turn_id),
 CHECK((status='open' AND answer IS NULL AND answer_message_id IS NULL AND answered_at IS NULL) OR
       (status='answered' AND length(answer)>=1 AND answer_message_id IS NOT NULL AND answered_at IS NOT NULL)),
 FOREIGN KEY(project_id,thread_id,run_id) REFERENCES collaboration_runs(project_id,thread_id,id) ON DELETE CASCADE,
 FOREIGN KEY(project_id,thread_id,run_id,turn_id)
  REFERENCES collaboration_turns(project_id,thread_id,run_id,id) ON DELETE NO ACTION,
 FOREIGN KEY(project_id,thread_id,run_id,answer_message_id)
  REFERENCES collaboration_messages(project_id,thread_id,run_id,id) ON DELETE NO ACTION,
 FOREIGN KEY(requesting_agent_id) REFERENCES agents(id) ON DELETE NO ACTION
);
CREATE TABLE collaboration_events(
 id TEXT PRIMARY KEY,project_id TEXT NOT NULL,thread_id TEXT NOT NULL,run_id TEXT NOT NULL,
 sequence INTEGER NOT NULL CHECK(sequence>=1),
 type TEXT NOT NULL CHECK(type IN('run_started','owner_message','agent_message','model_call_started','model_call_succeeded','model_call_failed','usage_recorded','tasks_created','task_claimed','handoff','decision_requested','decision_answered','boundary_paused','run_paused','run_resumed','run_retried','run_planned','run_stopped','attempt_interrupted','action_rejected','context_changed')),
 actor_type TEXT NOT NULL CHECK(actor_type IN('owner','agent','system')),actor_id TEXT,
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json) AND length(CAST(payload_json AS BLOB))<=65536),
 created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z'),
 UNIQUE(project_id,thread_id,run_id,id),UNIQUE(run_id,sequence),
 FOREIGN KEY(project_id,thread_id,run_id) REFERENCES collaboration_runs(project_id,thread_id,id) ON DELETE CASCADE
);
CREATE TABLE collaboration_thread_facts(
 id TEXT PRIMARY KEY,project_id TEXT NOT NULL,thread_id TEXT NOT NULL,sequence INTEGER NOT NULL CHECK(sequence>=1),
 activity_sequence INTEGER NOT NULL CHECK(activity_sequence>=1),
 type TEXT NOT NULL CHECK(type IN('thread_created','policy_changed','owner_message','agent_message','run_linked','run_event')),
 actor_type TEXT NOT NULL CHECK(actor_type IN('owner','agent','system')),actor_id TEXT,
 run_id TEXT,message_id TEXT,run_event_id TEXT,policy_revision_id TEXT,
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json) AND length(CAST(payload_json AS BLOB))<=65536),
 created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z'),
 UNIQUE(project_id,thread_id,id),UNIQUE(project_id,thread_id,sequence),UNIQUE(project_id,activity_sequence),
 FOREIGN KEY(project_id,thread_id) REFERENCES collaboration_threads(project_id,id) ON DELETE CASCADE,
 FOREIGN KEY(project_id,thread_id,run_id) REFERENCES collaboration_runs(project_id,thread_id,id) ON DELETE NO ACTION,
 FOREIGN KEY(project_id,thread_id,message_id) REFERENCES collaboration_messages(project_id,thread_id,id) ON DELETE NO ACTION,
 FOREIGN KEY(project_id,thread_id,run_id,message_id) REFERENCES collaboration_messages(project_id,thread_id,run_id,id) ON DELETE NO ACTION,
 FOREIGN KEY(project_id,thread_id,run_id,run_event_id) REFERENCES collaboration_events(project_id,thread_id,run_id,id) ON DELETE NO ACTION,
 FOREIGN KEY(project_id,thread_id,policy_revision_id) REFERENCES collaboration_thread_policy_revisions(project_id,thread_id,id) ON DELETE NO ACTION,
 CHECK(
  (type='thread_created' AND run_id IS NULL AND message_id IS NULL AND run_event_id IS NULL AND policy_revision_id IS NULL) OR
  (type='policy_changed' AND run_id IS NULL AND message_id IS NULL AND run_event_id IS NULL AND policy_revision_id IS NOT NULL) OR
  (type IN('owner_message','agent_message') AND message_id IS NOT NULL AND run_event_id IS NULL AND policy_revision_id IS NULL) OR
  (type='run_linked' AND run_id IS NOT NULL AND message_id IS NULL AND run_event_id IS NULL AND policy_revision_id IS NULL) OR
  (type='run_event' AND run_id IS NOT NULL AND message_id IS NULL AND run_event_id IS NOT NULL AND policy_revision_id IS NULL)
 )
);
```

Policy member `agent_id` intentionally 没有 FK 到 live membership/agent：历史策略在成员离组后仍可读；所有新 revision 在 transaction 中验证当前 `(project_id,agent_id)`。

以上 code block 是 `V7_TABLE_SQL` 的 verbatim strings；migration 直接执行它，validator 直接 normalized-compare 它，禁止另写 CREATE SQL、摘要展开器或人工拼列。shadow 只由 token-aware `prefixIdentifiers(V7_TABLE_SQL,"v7_")` 对 manifest 已知 object identifiers 做机械替换；该函数有逐字符串 snapshot test，不能改任何其他 token。

### 3.2 必需 indexes/triggers

```sql
CREATE UNIQUE INDEX collaboration_one_active_project ON collaboration_runs(project_id) WHERE status IN('running','waiting_owner','paused','failed');
CREATE UNIQUE INDEX collaboration_one_calling_attempt ON collaboration_attempts(run_id) WHERE status='calling';
CREATE UNIQUE INDEX collaboration_one_open_decision ON decision_requests(run_id) WHERE status='open';
CREATE UNIQUE INDEX thread_fact_one_created ON collaboration_thread_facts(project_id,thread_id) WHERE type='thread_created';
CREATE UNIQUE INDEX thread_fact_one_policy ON collaboration_thread_facts(project_id,thread_id,policy_revision_id) WHERE type='policy_changed';
CREATE UNIQUE INDEX thread_fact_one_message ON collaboration_thread_facts(project_id,thread_id,message_id) WHERE type IN('owner_message','agent_message');
CREATE UNIQUE INDEX thread_fact_one_run_link ON collaboration_thread_facts(project_id,thread_id,run_id) WHERE type='run_linked';
CREATE UNIQUE INDEX thread_fact_one_run_event ON collaboration_thread_facts(project_id,thread_id,run_event_id) WHERE type='run_event';
CREATE INDEX collaboration_threads_activity_page ON collaboration_threads(project_id,last_activity_sequence DESC,id);
CREATE INDEX collaboration_facts_page ON collaboration_thread_facts(project_id,thread_id,sequence,id);
CREATE INDEX collaboration_runs_thread_page ON collaboration_runs(project_id,thread_id,created_at,id);
CREATE TRIGGER thread_policy_revision_no_update BEFORE UPDATE ON collaboration_thread_policy_revisions
 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_THREAD_POLICY_REVISION'); END;
CREATE TRIGGER thread_policy_revision_no_delete BEFORE DELETE ON collaboration_thread_policy_revisions
 WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id)
 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_THREAD_POLICY_REVISION'); END;
CREATE TRIGGER thread_policy_member_no_update BEFORE UPDATE ON collaboration_thread_policy_members
 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_THREAD_POLICY_MEMBER'); END;
CREATE TRIGGER thread_policy_member_no_delete BEFORE DELETE ON collaboration_thread_policy_members
 WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id)
 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_THREAD_POLICY_MEMBER'); END;
CREATE TRIGGER thread_fact_no_update BEFORE UPDATE ON collaboration_thread_facts
 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_THREAD_FACT'); END;
CREATE TRIGGER thread_fact_no_delete BEFORE DELETE ON collaboration_thread_facts
 WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id)
 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_THREAD_FACT'); END;
CREATE TRIGGER thread_identity_no_update BEFORE UPDATE OF id,project_id,created_at ON collaboration_threads
 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_THREAD_IDENTITY'); END;
```

以上 code block 是 `V7_INDEX_TRIGGER_SQL` verbatim strings，和 `V7_TABLE_SQL` 一起构成唯一 `V7_OBJECT_SQL`；旧 v4 同名 index 随旧表删除，最终只能存在这里的 SQL。

## 4. 原子迁移、receipt 与校验

### 4.1 单一安全路径

1. `validateV6` PASS，确认无任一 v7 object；`BEGIN IMMEDIATE; PRAGMA defer_foreign_keys=ON`。
2. 以 `v7_` shadow 名创建最终 table shapes；预检 legacy facts/receipts并回填、校验 shadow；shadow绝不 rename 为 final（SQLite rename会改写 sqlite_master SQL）。
3. `PRAGMA defer_foreign_keys=ON` 下按 child→parent drop v6 collaboration tables，直接执行 verbatim `V7_TABLE_SQL` 创建 final names，再按 parent→child从已验证shadow复制，最后drop shadow。外部 `executions.source_collaboration_run_id` 在同一未提交事务结束前重新指向最终同名 parent及其 `UNIQUE(project_id,id)`。
4. 直接执行 verbatim `V7_INDEX_TRIGGER_SQL`；运行 4.4 全部 validator；仅此后 `PRAGMA user_version=7; COMMIT`。
5. 每个可注入 step（precheck/create/copy-thread/copy-policy/copy-each-table/map-facts/convert-receipts/drop-each/rename-each/index/trigger/validate/version）抛错后 `ROLLBACK`；断言 user_version=6、无 `v7_%`、v6 sqlite_master/facts 字节等同迁移前。

### 4.2 v6 receipt 确定转换

- 每项目 legacy thread ID=`legacy-thread-`+`sha256(project_id UTF-8)`，title=`历史协作`；另插入一个 synthetic completed `thread_create` receipt：ID=`migration-thread-`+同 hash、request hash=`sha256(canonicalJson(["v7-legacy-thread",projectId]))`、HTTP 201、v7 `ThreadCreateResponse`、时间=该项目最早 collaboration `created_at`（无历史则 project.created_at）。revision 1 的 `created_operation_id` 必须指向它。
- 保留每个 v6 receipt 的 `(project_id,id,kind,request_hash,status,created_at,updated_at)`；`thread_id=该项目 legacy thread`，已有 run_id 不变。除上述 synthetic row 外不得生成 operation ID。
- completed replayable error 严格解析为 `ErrorResponse`，canonical-key 排序后写 `response_schema_version=7`；保留原 http status/code/message/optional metadata，不把 error改成 success。
- v6 completed `start` 只接受 pre-v7 strict shape `{created:boolean,run:{id,projectId,status,currentAgentId,roundCount,pauseCategory,version,createdAt,updatedAt},message:{id,sequence,runId,authorType,authorAgentId,authorDisplayName,content,mentionAgentId,mentionDisplayName,mentionMemberStatus,createdAt}}`（字段类型/枚举等于 v6 shared contract且无 extra key）；转换为 `MigratedStartReceiptResponse`，对 run/message 注入同一确定 `threadId`并保留 `projectId`，保留 `created` true/false、HTTP status、IDs、sequence及其余 body 语义。`created:false` 表示该 v6 operation 向当时 active run 追加消息，只能 receipt replay，不能作为新 v7 `RunStartResponse`。
- 其他 completed success 按 kind 严格转换：`message→MessageResponse`、`control→ControlResponse`、`answer_decision→DecisionAnswerResponse`、`recover→RecoverResponse`、`advance→AdvanceResponse`；每个嵌套 run/message/event 注入同一 tuple，其余 identity/order/status 不变；unknown/extra/malformed 失败关闭。
- v6 不存在 `thread_create|policy_update`；出现即 `SCHEMA_DATA_INVALID`。completed 缺 http/response、pending 带 response、未知 kind 均失败。
- v6 service 只有 `advance` acquire 会插入 pending；因此 pending `start` 或任何其他 kind 非法并失败关闭。pending advance 必须恰有一个同 project/run/operation 的 calling attempt、无 model call/turn/该 attempt业务 message；原样保留 pending、`response_schema_version=NULL`。打开 v7 不调用 Provider；到 lease 过期后 tuple-scoped GET/recover 才以同 operation ID完成一次。未过期返回 `OPERATION_IN_PROGRESS`；重复 reopen不改行。

### 4.3 legacy event→fact 完整映射

- 每项目先写一个 `thread_created`、revision 1 的 `policy_changed`；每 run 写一个 `run_linked`。
- `owner_message`→`owner_message` fact，必须精确链接同 project/run 的 owner message ID+sequence；`agent_message`→`agent_message` fact，必须再链接同 run turn/committed attempt。
- 以下每一种均 1:1→`run_event` fact并保留 event ID/type/payload/actor/run：`run_started,model_call_started,model_call_succeeded,model_call_failed,usage_recorded,tasks_created,task_claimed,handoff,decision_requested,decision_answered,boundary_paused,run_paused,run_resumed,run_retried,run_planned,run_stopped,attempt_interrupted,action_rejected,context_changed`。
- project-only message（run_id NULL）各生成一个 owner/agent message fact；run-linked message 缺对应 message event、同 message 多 event、event payload extra/unknown/wrong type、未知 event type、断序、重复 sequence、decision/turn/attempt tuple 不一致均失败。pending calling attempt 仅保留 `model_call_started` 既有公开 event，不合成成功/失败。
- fact 合并排序固定 `(created_at,rank,source_sequence,id UTF-8)`；rank=`thread_created 0,policy_changed 1,run_linked 2,message 3,run_event 4`。同一 message 的 message fact 使用其 message event 的时间/actor；project-only 使用 message 时间。

### 4.4 sqlite_master 与 data validator

- `normalize(sql)=sql.replace(/;\s*$/,'').replace(/\s+/g,' ').trim().toLowerCase()`；`EXPECTED_V7_SQL=Map<objectName,normalize(V7_OBJECT_SQL string)>`，migration 只执行同一 `V7_OBJECT_SQL`，validator 将实际 `sqlite_master(type,name,sql)` 与 map 做对象数/type/name/value 全等。大小写/空白之外不做语义宽松，因而 `DEFERRABLE INITIALLY DEFERRED` 只由这次 exact CREATE SQL comparison 保证。
- 非 collaboration 的 v1–v6 retained 对象使用现有 expected maps；新增 `validateV6RetainedWithoutCollaboration` 复用 v5/v6 chunk、merge、review、memory、delivery facts，但排除被替换 collaboration SQL，拒绝缺失/额外同名对象。
- 另逐表比对 `PRAGMA table_info` 的列序/type/notnull/default/pk、`foreign_key_list` 的 parent table/child columns/parent columns/on_update/on_delete/match、`index_list/index_xinfo` 的 columns/unique/partial；SQLite `foreign_key_list` 不报告 deferrability，禁止据此验证，deferrability 仅由上一条 normalized CREATE SQL 全等保证；`PRAGMA foreign_key_check` 必须空。
- `V7_DATA_INVARIANTS` 是以下 exact violating-row queries；每条必须零行（表名可由同一个 prefix renderer处理）：

```sql
SELECT p.id FROM projects p LEFT JOIN collaboration_project_thread_sequences s ON s.project_id=p.id
 WHERE EXISTS(SELECT 1 FROM collaboration_threads t WHERE t.project_id=p.id) AND s.project_id IS NULL;
SELECT t.id FROM collaboration_threads t LEFT JOIN collaboration_thread_policy_revisions r
 ON (r.project_id,r.thread_id,r.id)=(t.project_id,t.id,t.active_policy_revision_id)
 WHERE r.id IS NULL OR r.version<>t.policy_version OR r.version<>(SELECT max(x.version) FROM collaboration_thread_policy_revisions x WHERE (x.project_id,x.thread_id)=(t.project_id,t.id));
SELECT revision_id FROM (SELECT revision_id,position,row_number() OVER(PARTITION BY project_id,thread_id,revision_id ORDER BY position)-1 expected FROM collaboration_thread_policy_members) WHERE position<>expected;
SELECT id FROM (SELECT id,sequence,row_number() OVER(PARTITION BY project_id,thread_id ORDER BY sequence)-1+1 expected FROM collaboration_messages) WHERE sequence<>expected
 UNION ALL SELECT id FROM (SELECT id,sequence,row_number() OVER(PARTITION BY run_id ORDER BY sequence) expected FROM collaboration_events) WHERE sequence<>expected
 UNION ALL SELECT id FROM (SELECT id,sequence,row_number() OVER(PARTITION BY project_id,thread_id ORDER BY sequence) expected FROM collaboration_thread_facts) WHERE sequence<>expected;
SELECT t.id FROM collaboration_threads t WHERE t.next_fact_sequence<>1+(SELECT count(*) FROM collaboration_thread_facts f WHERE (f.project_id,f.thread_id)=(t.project_id,t.id))
 OR t.last_activity_sequence<>(SELECT max(f.activity_sequence) FROM collaboration_thread_facts f WHERE (f.project_id,f.thread_id)=(t.project_id,t.id));
SELECT s.project_id FROM collaboration_project_thread_sequences s WHERE s.next_activity_sequence<>1+coalesce((SELECT max(f.activity_sequence) FROM collaboration_thread_facts f WHERE f.project_id=s.project_id),0);
SELECT t.id FROM collaboration_threads t WHERE (SELECT count(*) FROM collaboration_thread_facts f WHERE (f.project_id,f.thread_id,f.type)=(t.project_id,t.id,'thread_created'))<>1
 OR EXISTS(SELECT 1 FROM collaboration_thread_policy_revisions r WHERE (r.project_id,r.thread_id)=(t.project_id,t.id) AND (SELECT count(*) FROM collaboration_thread_facts f WHERE f.policy_revision_id=r.id AND f.type='policy_changed')<>1);
SELECT m.id FROM collaboration_messages m WHERE (SELECT count(*) FROM collaboration_thread_facts f WHERE f.message_id=m.id AND f.type=CASE m.author_type WHEN 'owner' THEN 'owner_message' ELSE 'agent_message' END)<>1
 UNION ALL SELECT r.id FROM collaboration_runs r WHERE (SELECT count(*) FROM collaboration_thread_facts f WHERE f.run_id=r.id AND f.type='run_linked')<>1
 UNION ALL SELECT e.id FROM collaboration_events e WHERE (SELECT count(*) FROM collaboration_thread_facts f WHERE f.run_event_id=e.id AND f.type='run_event')<>CASE e.type WHEN 'owner_message' THEN 0 WHEN 'agent_message' THEN 0 ELSE 1 END;
SELECT id FROM collaboration_operations WHERE (status='pending')<>(http_status IS NULL AND response_json IS NULL AND response_schema_version IS NULL)
 OR (status='completed')<>(http_status BETWEEN 100 AND 599 AND json_valid(response_json) AND response_schema_version=7);
SELECT o.id FROM collaboration_operations o
 WHERE o.status='pending' AND (
  o.kind<>'advance' OR
  (SELECT count(*) FROM collaboration_attempts a
    WHERE (a.project_id,a.thread_id,a.run_id,a.operation_id)=(o.project_id,o.thread_id,o.run_id,o.id)
      AND a.status='calling')<>1 OR
  EXISTS(SELECT 1 FROM collaboration_attempts a
    WHERE (a.project_id,a.thread_id,a.run_id,a.operation_id)=(o.project_id,o.thread_id,o.run_id,o.id)
      AND (a.status<>'calling' OR EXISTS(SELECT 1 FROM collaboration_model_calls c WHERE c.attempt_id=a.id)
       OR EXISTS(SELECT 1 FROM collaboration_turns t WHERE t.attempt_id=a.id)))
 );
SELECT project_id FROM collaboration_runs WHERE status IN('running','waiting_owner','paused','failed') GROUP BY project_id HAVING count(*)>1;
```

- `PRAGMA foreign_key_check` 覆盖所有 tuple orphan；此外逐行用 shared strict schemas parse operation response、fact payload、event payload/options JSON，任一 parse failure即 invariant violation。
- `validateV7` 首次迁移与每次 open 都运行；schema mismatch=`SCHEMA_DRIFT`，关系/序列/receipt/payload mismatch=`SCHEMA_DATA_INVALID`。

## 5. 领域契约

### 5.1 policy availability/readiness

```ts
type PolicyAvailability = "ready" | "repair_required";
type DispatchReadiness =
  | "ready" | "project_context_not_ready" | "policy_repair_required"
  | "selected_member_provider_unavailable" | "project_run_active";
```

- policy `ready` iff member IDs unique、数量≥2、每个仍是该 project live membership；否则 `repair_required`，历史可读/owner 可发言，但任何 Agent dispatch 被拒绝。
- 新线程必须 owner 显式给 current member IDs；按请求数组 position 保存。legacy revision 按 `(joined_at,agent_id UTF-8)` 收录迁移时有效全集；历史作者不自动加入。
- 新 run 初始 Agent：合法 mention 优先，否则 policy position 0；handoff：尚未消费的 owner mention 优先，否则 structured target。mention/target/current Agent 必须同时位于 active policy 与 live membership。
- Provider 可用性只检查“本次将 dispatch 的 Agent”（start 的初始、advance 的 current、handoff 的 next）；其他 policy member Provider 故障不使 policy 失效，也不阻止当前 Agent。故障返回既有 sanitized `CREDENTIAL_UNAVAILABLE`，不得自动删 member。
- 项目新增/改名/其他非 policy roster 变化不影响 policy、prompt roster 或 context hash；prompt roster 只由 policy snapshots+当前可执行配置构造。成员移除会令 policy repair_required；改名不改历史 snapshot。

### 5.2 prompt 与 AgentTurn 凭据

- `classifyPublicText` 四类保持 A-72：configured Provider 明文、PEM private-key block、Authorization Basic/Bearer 值、api-key/api_key/apikey/token/secret/password 后非占位值；`***`,`<redacted>`,`${ENV_NAME}`,仅字段名放行。
- owner 入口：start message、后续 message、decision answer 在 transaction 前扫描；命中 `422 CREDENTIAL_CONTENT_REJECTED`，无 receipt/fact/message。
- Agent 流程：primary `content` 一到达即扫描；命中返回 `credential_content_rejected` sanitized call outcome，跳过 `parseAgentTurnContent` 和 repair。primary 未命中但 parse 失败才 repair；repair raw 一到达先扫描，命中不 parse。有效 turn 再以一个数组原子扫描 `message`、每个 task `title/description`、handoff `summary/reason`、decision `question/options[]`；任一命中则整个 turn 不提交。
- model-call audit 只记 status/category/usage，不保存 raw；receipt/error/event/log/DOM 只含通用 code/category/correlationId。分类器不得把输入或 key 放入 Error/console。
- prompt 的最近 30 条/60000 字符 SQL 必带 `(project_id,thread_id)`；snapshot/hash 含 threadId、policy revision、selected run、included message sequence及项目共享 fingerprint；别线程文本永不进入 repair input。

### 5.3 active run、重启和下游 source tuple

- 同项目最多一个非终态 run。其他线程可收 owner message；start/advance 返回 `409 PROJECT_RUN_ACTIVE` 和同项目授权的 `{activeThreadId,activeRunId}`。切换不改 run。
- Continue/Retry 只恢复 URL tuple 的同一 run；终态线程“开始新一轮”创建新 run。首次 GET/recover 仅 reconcile 过期 calling attempt，不发 Provider。
- `SourceTuple={projectId,threadId,runId}` 从 URL→CollaborationPanel→ExecutionPanel start input，execution 保存既有 `source_collaboration_run_id` 且 frozen public/private envelope新增 exact tuple/hash。retry/rework 从 execution frozen tuple读取，不从当前 URL或最新 run替换。
- review material 从 result→execution→source run join恢复同 tuple；delivery 从每个 result 的 source tuple构建来源；execution/review/delivery UI link 均回 canonical `?thread=&run=`。任一 tuple mismatch 安全 404，绝不 fallback。

## 6. HTTP/URL 契约

### 6.1 通用 grammar

- path segment decode exactly once；ID 必须 `^[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$` 且不是 `.`/`..`；拒绝 encoded/decoded `/`,`\`,NUL。所有 query allowlist；`getAll(key).length!==1` 为 duplicate；未知 key、空 required value、fragment 均 `400 INVALID_INPUT`。
- mutation 只接受 `application/json`，流式上限 65536 bytes；strict object，extra/missing/wrong type 均 400。UUID operationId；整数 safe、version≥1。
- 所有 detail/action 首条 SQL即按完整 tuple join；未知 ID和跨 project/thread/run/decision/operation得到相同 `404 RESOURCE_NOT_FOUND` 和相同 body，无内容/归属差异。

### 6.2 routes 与 exact envelopes

以下是本节唯一 shared strict schema 名录；全部 object `.strict()`，文本先 trim 再按 `Intl.Segmenter("zh-CN",{granularity:"grapheme"})` 计数，数组不接受重复，integer 必须 `Number.isSafeInteger`。

```ts
type ResourceId = string;       // /^[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$/
type OperationId = string;      // UUID /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
type Version = number;          // safe integer 1..Number.MAX_SAFE_INTEGER
type SequenceAfter = number;    // safe integer 0..Number.MAX_SAFE_INTEGER
type PageLimit = number;        // safe integer 1..200
type ThreadListLimit = number;  // safe integer 1..100
type ThreadCursor = string;     // base64url canonical JSON {"v":1,"a":safe integer >=1,"id":ResourceId}
type OperationKind = "thread_create"|"policy_update"|"start"|"message"|"control"|"answer_decision"|"advance"|"recover";
type ApiErrorCode = "INVALID_JSON"|"INVALID_INPUT"|"BODY_TOO_LARGE"|"UNSUPPORTED_MEDIA_TYPE"|"STRUCTURED_OUTPUT_INVALID"|"ACTION_INVALID"|"RESOURCE_NOT_FOUND"|
 "PROJECT_NOT_FOUND"|"RUN_NOT_FOUND"|"DECISION_NOT_FOUND"|"AGENT_NOT_FOUND"|"CONTEXT_NOT_READY"|"COLLABORATION_ACTIVE"|"AGENT_NOT_MEMBER"|
 "OPERATION_CONFLICT"|"OPERATION_IN_PROGRESS"|"VERSION_CONFLICT"|"TURN_IN_PROGRESS"|"RUN_STATE_CONFLICT"|"DECISION_ALREADY_ANSWERED"|
 "PROJECT_RUN_ACTIVE"|"THREAD_POLICY_REPAIR_REQUIRED"|"ACTION_CONFLICT"|"BOUNDARY_REACHED"|"CREDENTIAL_CONTENT_REJECTED"|
 "PROVIDER_AUTH"|"RATE_LIMITED"|"PROVIDER_UPSTREAM"|"PROVIDER_UNREACHABLE"|"PROVIDER_RESPONSE_INVALID"|"PROVIDER_TIMEOUT"|
 "CREDENTIAL_UNAVAILABLE"|"STORAGE_UNAVAILABLE"|"INTERNAL_ERROR";
type TimelineEventType = keyof typeof timelinePayloadSchemas;
type TimelinePayload<T extends TimelineEventType> = z.infer<(typeof timelinePayloadSchemas)[T]>;

type RunDto={id:ResourceId;projectId:ResourceId;threadId:ResourceId;status:"running"|"waiting_owner"|"paused"|"failed"|"planned"|"stopped";currentAgentId:ResourceId;roundCount:number;pauseCategory:string|null;version:Version;createdAt:string;updatedAt:string};
type MessageDto={id:ResourceId;projectId:ResourceId;threadId:ResourceId;sequence:number;runId:ResourceId|null;authorType:"owner"|"agent";authorAgentId:ResourceId|null;authorDisplayName:string;content:string;mentionAgentId:ResourceId|null;mentionDisplayName:string|null;mentionMemberStatus:"current"|"left"|null;createdAt:string};
type MemberPolicyDto={revisionId:ResourceId;version:Version;availability:PolicyAvailability;members:Array<{agentId:ResourceId;displayNameSnapshot:string;position:number;live:"current"|"removed"}>;unavailableMemberIds:ResourceId[];createdAt:string};
type ThreadSummaryDto={id:ResourceId;projectId:ResourceId;title:string;policyVersion:Version;availability:PolicyAvailability;lastActivitySequence:number;version:Version;createdAt:string;updatedAt:string};
type ThreadDetailDto=ThreadSummaryDto&{policy:MemberPolicyDto};
type TimelineEventDto<T extends TimelineEventType=TimelineEventType>={id:ResourceId;projectId:ResourceId;threadId:ResourceId;runId:ResourceId;sequence:number;type:T;actorType:"owner"|"agent"|"system";actorId:ResourceId|null;payload:TimelinePayload<T>;createdAt:string};
type DecisionDto={id:ResourceId;projectId:ResourceId;threadId:ResourceId;runId:ResourceId;turnId:ResourceId;requestingAgentId:ResourceId;question:string;options:string[];status:"open"|"answered";answer:string|null;answerMessageId:ResourceId|null;version:Version;createdAt:string;answeredAt:string|null};
type FactBase={id:ResourceId;projectId:ResourceId;threadId:ResourceId;sequence:number;activitySequence:number;actorType:"owner"|"agent"|"system";actorId:ResourceId|null;createdAt:string};
type ThreadFactDto=
 | FactBase&{type:"thread_created";runId:null;messageId:null;runEventId:null;policyRevisionId:null;payload:{title:string};message:null}
 | FactBase&{type:"policy_changed";runId:null;messageId:null;runEventId:null;policyRevisionId:ResourceId;payload:{policyVersion:Version};message:null}
 | FactBase&{type:"owner_message"|"agent_message";runId:ResourceId|null;messageId:ResourceId;runEventId:null;policyRevisionId:null;payload:{messageId:ResourceId};message:MessageDto}
 | FactBase&{type:"run_linked";runId:ResourceId;messageId:null;runEventId:null;policyRevisionId:null;payload:{runId:ResourceId};message:null}
 | FactBase&{type:"run_event";runId:ResourceId;messageId:null;runEventId:ResourceId;policyRevisionId:null;payload:{eventType:TimelineEventType};message:null};
type ErrorResponse={error:{code:ApiErrorCode;message:string;fields?:Record<string,string>;currentVersion?:Version;category?:string;correlationId?:string;activeThreadId?:ResourceId;activeRunId?:ResourceId}};
type ThreadListResponse={threads:ThreadSummaryDto[];nextCursor:ThreadCursor|null};
type ThreadCreateResponse={created:true;thread:ThreadDetailDto;fact:Extract<ThreadFactDto,{type:"thread_created"}>};
type ThreadDetailResponse={thread:ThreadDetailDto;runs:RunDto[];selectedRun:RunDto|null;activeRun:{threadId:ResourceId;runId:ResourceId}|null;readiness:{dispatch:DispatchReadiness;missingProjectFacts:string[];selectedMemberId:ResourceId|null}};
type MessagePageResponse={items:MessageDto[];nextAfter:SequenceAfter|null};
type FactPageResponse={items:ThreadFactDto[];nextAfter:SequenceAfter|null};
type PolicyUpdateResponse={thread:ThreadDetailDto;policy:MemberPolicyDto;fact:Extract<ThreadFactDto,{type:"policy_changed"}>};
type MessageResponse={message:MessageDto;fact:Extract<ThreadFactDto,{type:"owner_message"}>;run:RunDto|null};
type RunStartResponse={created:true;run:RunDto;message:MessageDto;facts:[Extract<ThreadFactDto,{type:"run_linked"}>,Extract<ThreadFactDto,{type:"owner_message"}>,Extract<ThreadFactDto,{type:"run_event"}>]};
type MigratedStartReceiptResponse={created:true|false;run:RunDto;message:MessageDto};
type TimelinePageResponse={items:TimelineEventDto[];nextAfter:SequenceAfter|null};
type ControlResponse={run:RunDto;fact:Extract<ThreadFactDto,{type:"run_event"}>};
type AdvanceResponse={attemptStatus:"committed"|"discarded";attempt:{id:ResourceId;status:"committed"|"discarded"};events:TimelineEventDto[];run:RunDto}|{attemptStatus:"interrupted";run:RunDto}|{kind:"paused";boundary:"rounds"|"tokens"|"handoffs";run:RunDto};
type RecoverResponse={attempt:{id:ResourceId;status:"calling"|"committed"|"failed"|"interrupted"|"discarded";leaseExpiresAt:string}|null;run:RunDto;fact:Extract<ThreadFactDto,{type:"run_event"}>|null}; // current 与 migrated v6 recover 均可严格表达最新 calling 或 terminal attempt；只对 calling/expired 执行 reconcile
type DecisionAnswerResponse={decision:DecisionDto;run:RunDto;message:MessageDto;facts:[Extract<ThreadFactDto,{type:"owner_message"}>,Extract<ThreadFactDto,{type:"run_event"}>]};
type OperationResponse=ErrorResponse|ThreadCreateResponse|PolicyUpdateResponse|MessageResponse|RunStartResponse|MigratedStartReceiptResponse|ControlResponse|AdvanceResponse|RecoverResponse|DecisionAnswerResponse;
type OperationLookupResponse={operationId:OperationId;kind:OperationKind;status:"pending"|"completed";httpStatus:number|null;response:OperationResponse|null};

type ThreadListQuery={cursor?:ThreadCursor;limit?:ThreadListLimit};        // limit default 50
type ThreadCreateRequest={operationId:OperationId;title:string;memberAgentIds:ResourceId[]}; // title 1..80 graphemes; members 2..100
type ThreadDetailQuery={run?:ResourceId};
type SequencePageQuery={after?:SequenceAfter;limit?:PageLimit};           // defaults after=0, limit=50
type PolicyUpdateRequest={operationId:OperationId;expectedVersion:Version;memberAgentIds:ResourceId[]}; // members 2..100
type MessageRequest={operationId:OperationId;content:string;mentionAgentId?:ResourceId};     // content 1..10000 graphemes
type RunStartRequest={operationId:OperationId;message:string;mentionAgentId?:ResourceId};    // message 1..10000 graphemes
type ControlRequest={operationId:OperationId;action:"pause"|"continue"|"retry"|"stop";expectedVersion:Version};
type AdvanceRequest={operationId:OperationId};
type RecoverRequest={operationId:OperationId};
type DecisionAnswerRequest={operationId:OperationId;answer:string;mentionAgentId?:ResourceId;expectedVersion:Version}; // answer 1..5000 graphemes
```

DTO 展示文本沿持久值返回；request 的 `title/message/content/answer` 必须非空且满足注释 grapheme 上限，`memberAgentIds` 长度和唯一性在 trim/parse 后验证；mention若提供必须匹配 `ResourceId` 并属于 active policy。所有 query/path/body 未列字段、重复 query、`null` 代替 optional、非整数数字均 `400 INVALID_INPUT`。

- `GET /api/projects/:p/threads` + `ThreadListQuery`→200 `ThreadListResponse`；按 `(last_activity_sequence DESC,id ASC)`，`nextCursor=null` 表示结束。
- `POST /api/projects/:p/threads` + `ThreadCreateRequest`→201 `ThreadCreateResponse`；同 operation/hash replay 原 status/body。
- `GET /api/projects/:p/threads/:t` + `ThreadDetailQuery`→200 `ThreadDetailResponse`；run缺失=`selectedRun:null`，若有必须同 tuple；runs按 `(created_at DESC,id ASC)`。
- `GET /api/projects/:p/threads/:t/messages` + `SequencePageQuery`→200 `MessagePageResponse`；只含 sequence>after，nextAfter仅有后页时为最后 item sequence。
- `GET /api/projects/:p/threads/:t/facts` + `SequencePageQuery`→200 `FactPageResponse`；message fact含唯一嵌套 message。
- `PATCH /api/projects/:p/threads/:t/policy` + `PolicyUpdateRequest`→200 `PolicyUpdateResponse`。
- `POST /api/projects/:p/threads/:t/messages` + `MessageRequest`→201 `MessageResponse`。
- `POST /api/projects/:p/threads/:t/runs` + `RunStartRequest`→201 `RunStartResponse`；新 v7请求永远 `created:true`，已有非终态 run返回409。
- `GET /api/projects/:p/threads/:t/operations/:operationId` 无 query/body→200 `OperationLookupResponse`；pending的 httpStatus/response均null，completed均非null且response匹配kind/status；可重放 legacy start允许 `MigratedStartReceiptResponse.created=false`。
- `GET /api/projects/:p/threads/:t/runs/:r/timeline` + `SequencePageQuery`→200 `TimelinePageResponse`。
- `POST /api/projects/:p/threads/:t/runs/:r/control` + `ControlRequest`→200 `ControlResponse`。
- `POST /api/projects/:p/threads/:t/runs/:r/advance` + `AdvanceRequest`→200 `AdvanceResponse`；失败为 `ErrorResponse`，永不返回 acquired prompt/key/raw。
- `POST /api/projects/:p/threads/:t/runs/:r/recover` + `RecoverRequest`→200 `RecoverResponse`。
- `POST /api/projects/:p/threads/:t/runs/:r/decisions/:d/answer` + `DecisionAnswerRequest`→200 `DecisionAnswerResponse`。
- 旧 `/api/runs/:runId/**` 与 project-only `/messages|runs|collaboration` 不 redirect、不兼容执行，统一 404；避免 ID oracle。

### 6.3 status/error

- 400 `INVALID_JSON|INVALID_INPUT|STRUCTURED_OUTPUT_INVALID|ACTION_INVALID`; 404 `RESOURCE_NOT_FOUND`; 409 `OPERATION_CONFLICT|OPERATION_IN_PROGRESS|VERSION_CONFLICT|TURN_IN_PROGRESS|RUN_STATE_CONFLICT|PROJECT_RUN_ACTIVE|THREAD_POLICY_REPAIR_REQUIRED|ACTION_CONFLICT|BOUNDARY_REACHED`; 413 `BODY_TOO_LARGE`; 415 `UNSUPPORTED_MEDIA_TYPE`; 422 `CREDENTIAL_CONTENT_REJECTED`; 401/429/502/503/504 沿既有 sanitized Provider/storage codes。
- error body strict `{error:{code,message,fields?,currentVersion?,category?,correlationId?,activeThreadId?,activeRunId?}}`；仅 `PROJECT_RUN_ACTIVE` 可带同项目 active IDs。任何 rejected mutation不推进 message/fact/activity/version。

### 6.4 returnTo

- parser 只接受无 origin/hash 的 `/` 或 canonical `/projects/<encoded-id>`，query 仅单个 `thread`、可选单个 `run`；run 必须伴随 thread；顺序 canonical 为 `thread` 后 `run`。重复/未知/空值/fragment/encoded slash/backslash/dot segment/数组全部回退 `/`。
- 构建设置 URL：`/team?section=<allowlisted>&returnTo=<encodeURIComponent(canonical)>`；返回 project page 后服务端/页面再按数据库验证 `(p,t[,r])`，cross tuple 显示安全线程错误且不得选择其他 run。

## 7. UI 设计

- 信息架构：左栏项目下为线程列表/创建；中栏 thread 标题、run select、单一 fact transcript、composer；右栏 policy/readiness、修复、活动线程返回。窄屏线程留在“项目”drawer，policy/run 留在“上下文”drawer。
- 唯一 render model：UI 只 map `factsPage.items`；message fact 渲染其嵌套 message，绝不再 map messages page或selected run timeline。分页 merge key=`fact.id`，排序 sequence；同 ID不同内容视为 envelope invalid并停止合并。

| 表面 | loading | empty | error | disabled/success/focus |
|---|---|---|---|---|
| thread list/create | list `aria-busy` | CTA“创建线程”，无 composer | retry，不保留伪选择 | pending锁表单；成功聚焦新标题并 `role=status` |
| run select | skeleton/disabled | “尚无运行/开始新一轮” | retry | 无显式 run禁用控制/下游；选择后焦点到 run heading |
| policy read/repair | `aria-busy` | 不适用（无 revision=损坏） | retry/安全错误 | removed显式标注；stale保留选择并重读；成功聚焦 policy heading |
| facts/messages page | facts `aria-busy` | 创建后提示发第一条消息 | retry page，不清已有 facts | load-more pending disabled；新 fact polite live summary，不抢焦点 |
| active-thread return | readiness loading | activeRun null则不显示 | tuple失败不泄漏 | link键盘可达，点击更新 URL并聚焦 active run |

- `targetKey=p|t|r-or-empty`；每次 URL变化先 abort、递增 epoch、清空 draft/mention/member cache/pages/receipts，再请求。每个 response 在 setState 前同时校验 abort、epoch、payload tuple；轮询、写回、operation reconciliation同规则。
- dialog 用现有 `useModalSurface` 实现 Escape/trap/restore；原生 button/form/list/select，field error `aria-invalid/describedby`，状态 `role=status/alert`，live region polite+atomic。
- 只复用 `tokens.css/cockpit.css` 的 surface/text/border/interactive/status/agent/font/space/radius/shadow/focus/control/breakpoint token；无根 DESIGN.md，不硬编码视觉值。无动画、渐变、emoji 功能图标、glass、glow、品牌/文案/资产复制；触控≥`--control-min`，desktop/narrow 均用现有布局。

## 8. NFR 与测试

| NFR | 机制 | 可执行验证 |
|---|---|---|
| NFR-1 | URL 状态、原生语义、44px token、focus ring、dialog/live region、desktop/narrow matrix | Testing Library keyboard/focus/states；Playwright 两宽度；axe critical=0、AA |
| NFR-2 | 单事务 migration、复合 FK/UNIQUE、immutable facts、连续序号、receipt hash/version、每次 open validator | fault injection、并发/replay、cross tuple、真实进程 restart |

- 定向 RED/GREEN：`npm test -- tests/<target>.test.ts[x]`。收口：`npm test`; `npm run build`; `npm run smoke:collaboration`; `npm run smoke:execution`; `npm run smoke:review`; `npm run smoke:settings`; `npm run smoke:onboarding`。
- 当前 `hf_gate.py` 确实无 `run` 子命令且 owner 已记录豁免；上述直接 test/build/smoke stdout/exit code 是本切片接受的本地验证输出，不包装为 gate evidence，不手写/编辑 evidence log。

## 9. 任务清单

覆盖自检：FR-1=`T-7,T-10,T-29,T-34`；FR-2=`T-11,T-12,T-22,T-30,T-33,T-34`；FR-3=`T-2,T-3,T-8,T-9,T-22,T-31,T-34`；FR-4=`T-9,T-10,T-13..T-18,T-23..T-26,T-32,T-34`；FR-5=`T-2,T-3,T-5,T-18,T-23,T-27..T-29,T-33,T-34`；FR-6=`T-1,T-2,T-10..T-18,T-22,T-24..T-26,T-28,T-33,T-34`；FR-7=`T-19..T-21,T-34`；FR-8=`T-2..T-6,T-25..T-27,T-34`；FR-9=`T-2,T-4,T-6..T-8,T-11..T-13,T-21,T-30,T-34`；NFR-1=`T-29..T-34`；NFR-2=`T-1,T-2,T-4,T-5,T-6,T-8,T-34`。无未覆盖需求或范围外任务。

- [x] T-1 建立唯一 V7_OBJECT_SQL renderer、normalized expected map与纯 validateV7 (覆盖: FR-6, NFR-2) — 判据: `migrations-v7-schema.test.ts` 先红后绿验证完整 table/index/trigger/FK/deferrability SQL；本任务不运行迁移、不创建/替换业务表、不写 user_version
- [x] T-2 用T-1 map执行完整 v6→v7 shadow replacement、全部 backfill/event/receipt转换、最终校验并仅一次设置 user_version=7 (覆盖: FR-3, FR-5, FR-6, FR-8, FR-9, NFR-2) — 判据: `migrations-v7-complete.test.ts` 从完整v6 fixture单次得到最终v7，任一中间hook观察均仍是 transaction内user_version=6，COMMIT前无可打开中间v7
- [x] T-3 增加 legacy thread/policy/run/message 边界fixture并修正完整迁移 (覆盖: FR-3, FR-5, FR-8) — 判据: `migrations-v7-backfill.test.ts` 多项目/多run/project-only/removed author先红后绿
- [x] T-4 增加 completed receipt 全 kind/created true|false/error replay fixture并修正转换 (覆盖: FR-8, FR-9, NFR-2) — 判据: `migrations-v7-receipts.test.ts` identity/status/body严格重放先红后绿
- [x] T-5 增加 pending advance与非法pending start fixture并修正对账 (覆盖: FR-5, FR-8, NFR-2) — 判据: `migrations-v7-pending.test.ts` missing/duplicate calling attempt失败、无Provider resend、同operation完成一次
- [x] T-6 增加全部 legacy event type与非法event fixture并修正映射 (覆盖: FR-8, FR-9, NFR-2) — 判据: `migrations-v7-events.test.ts` 穷尽 `TimelineEventType` 且unknown/malformed/duplicate先红后绿
- [x] T-7 实现 thread create/list及确定 activity cursor (覆盖: FR-1, FR-9) — 判据: `thread-service.test.ts` 同名、边界、并发排序、receipt replay通过
- [x] T-8 实现 policy revision/head与 stale version conflict (覆盖: FR-3, FR-9, NFR-2) — 判据: `thread-policy.test.ts` immutable/head/deferred FK/concurrency通过
- [x] T-9 实现 policy availability与确定 Agent 选择 (覆盖: FR-3, FR-4) — 判据: `thread-readiness.test.ts` removed/new/rename/mention/handoff/provider scope通过
- [x] T-10 实现 tuple-scoped thread detail与显式 run选择 GET (覆盖: FR-1, FR-4, FR-6) — 判据: `thread-detail-api.test.ts` null/run/duplicate/unknown/cross tuple通过
- [x] T-11 实现 message/fact 两个独立严格分页读契约 (覆盖: FR-2, FR-6, FR-9) — 判据: `thread-history-api.test.ts` cursor/end/null/tuple/嵌套message通过
- [x] T-12 实现 owner message 的 tuple write+receipt+fact 原子提交 (覆盖: FR-2, FR-6, FR-9) — 判据: `thread-message-api.test.ts` replay/cross tuple/零部分写入通过
- [x] T-13 实现新 run 的 tuple write 与固定三 fact 原子提交 (覆盖: FR-4, FR-6, FR-9) — 判据: `thread-run-start-api.test.ts` fact order/receipt/active conflict通过
- [x] T-14 迁移 timeline GET 到完整 tuple并移除旧入口 (覆盖: FR-4, FR-6) — 判据: `run-timeline-tuple.test.ts` unknown与cross tuple同404
- [x] T-15 迁移 control POST 到完整 tuple并移除旧入口 (覆盖: FR-4, FR-6) — 判据: `run-control-tuple.test.ts` pause/continue/retry/stop严格归属通过
- [x] T-16 迁移 decision answer POST 到完整 tuple并移除旧入口 (覆盖: FR-4, FR-6) — 判据: `decision-answer-tuple.test.ts` decision/run/thread三重错配同404
- [x] T-17 迁移 advance POST 到完整 tuple (覆盖: FR-4, FR-6) — 判据: `run-advance-tuple.test.ts` 不返回prompt且cross tuple不调用Provider
- [x] T-18 迁移 recover POST并实现 restart reconciliation (覆盖: FR-4, FR-5, FR-6) — 判据: `run-recover-tuple.test.ts` pending/expired/no-resend通过
- [x] T-19 实现 owner 三个 ingress 的共享凭据拒绝 (覆盖: FR-7) — 判据: `owner-public-text-security.test.ts` 四类别/占位/零事实通过
- [x] T-20 在 structured repair 前扫描 primary/repair raw (覆盖: FR-7) — 判据: `structured-repair-credential.test.ts` primary命中时 Provider call count=1、repair命中不parse
- [x] T-21 原子扫描 AgentTurn 全部公开文本字段 (覆盖: FR-7, FR-9) — 判据: `agent-turn-credential.test.ts` 每字段×类别拒绝且无 message/task/event/receipt原值
- [x] T-22 隔离 thread prompt、policy roster与 context hash (覆盖: FR-2, FR-3, FR-6) — 判据: `collaboration-prompt.test.ts` 两线程互斥、项目共享、非policy roster无关
- [x] T-23 修正 active run与 Continue/Retry/新一轮规则 (覆盖: FR-4, FR-5) — 判据: `multi-thread-run-lifecycle.test.ts` owner消息可写、dispatch阻止、身份不迁移
- [x] T-24 冻结 execution source tuple并删除 latestRun读取 (覆盖: FR-4, FR-6) — 判据: execution start/retry/rework tests 显式 tuple通过
- [x] T-25 由 frozen execution tuple构造 review material (覆盖: FR-4, FR-6, FR-8) — 判据: review material tests 多 run不替代
- [x] T-26 由 frozen execution tuple构造 delivery来源与链接 (覆盖: FR-4, FR-6, FR-8) — 判据: delivery source/navigation tests 多 run不替代
- [x] T-27 更新 onboarding strict parser支持 thread+多 run envelope (覆盖: FR-5, FR-8) — 判据: `onboarding-fact-parsers.test.ts` 合法多 run与 malformed tuple通过
- [x] T-28 实现 safe returnTo parser与 URL恢复 (覆盖: FR-5, FR-6) — 判据: settings navigation tests 覆盖 duplicate/unknown/fragment/cross tuple
- [x] T-29 实现 thread list/create UI状态与URL选择 (覆盖: FR-1, FR-5, NFR-1) — 判据: `persistent-thread-list-ui.test.tsx` loading/empty/error/pending/success/focus通过
- [x] T-30 实现 fact-only transcript分页渲染 (覆盖: FR-2, FR-9, NFR-1) — 判据: `thread-transcript-ui.test.tsx` message只出现一次且分页按fact.id去重
- [x] T-31 实现 policy read/repair UI状态 (覆盖: FR-3, NFR-1) — 判据: `thread-policy-ui.test.tsx` removed/stale/keyboard/focus/disabled通过
- [x] T-32 实现 run select与active-thread return UI状态 (覆盖: FR-4, NFR-1) — 判据: `thread-run-select-ui.test.tsx` null/active/error/focus通过
- [x] T-33 实现 project/thread/run stale-request protection (覆盖: FR-2, FR-5, FR-6, NFR-1) — 判据: `thread-stale-response.test.tsx` delayed poll/write/reconcile均不能覆盖新target
- [x] T-34 新增持久线程真实浏览器回归并执行全套命令 (覆盖: FR-1, FR-2, FR-3, FR-4, FR-5, FR-6, FR-7, FR-8, FR-9, NFR-1, NFR-2) — 判据: 新 `persistent-threads-browser-smoke.mjs` 覆盖两线程/重启/设置返回/窄屏/axe，且第8节全套命令 exit 0
