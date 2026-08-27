# 架构 — 策略内终端与本地浏览器预览

- 日期: 2026-08-19
- 对应规格: [`spec.md`](./spec.md)
- 状态: 项目级 review 豁免生效；未送独立评审，不伪造工件
- 高风险: 本机进程、Approval 与 loopback 预览边界；实现后必须 code review + security review

## 架构目标

S-43 不建立通用 terminal owner。它把 Owner 发起的命令建模为 **Safe Execution 当前 attempt 上的一种受控 Process Session**：冻结 policy entry / one-shot Approval → acquire → direct spawn → checkpoint/output → finalize/terminate。UI 只消费公开 DTO，不持有 PID、绝对 executable、sandbox root 或任意 URL。

Validation Policy 仍归 Project & Workspace，Process Session、输出与终态归 Safe Execution；Approval 裁决归 Governance。跨 owner 的 one-shot 授权续接只经现有 Execution workflow/公开 Interface。

## Module 与 Interface

### Project & Workspace

扩展 `ValidationPolicyEntry`：

- `purpose: "validation" | "preview"`
- `timeoutSeconds: number`
- preview-only: `network: "loopback_only"`, `port: number`, `openPath: string`

policy revision 继续 append-only。历史行缺省语义由 schema 明确保存为 `validation`，不得查询时猜测。

公开查询：

- `getFrozenExecutionPolicyCommands(databasePath, executionId)` 由组合层调用 Project & Workspace 的 revision 查询与 Safe Execution 的 tuple 查询组装；不把跨 owner SQL 放进 route。

### Safe Execution

公开命令/查询：

- `listPolicyCommands(databasePath, executionId)`
- `startPolicyProcess(databasePath, executionId, input, adapters)`
- `getPolicyProcess(databasePath, executionId, processId)`
- `readPolicyProcessOutput(databasePath, executionId, processId, cursor)`
- `stopPolicyProcess(databasePath, executionId, processId, input, adapters)`
- `reconcilePolicyProcesses(databasePath)` — 仅终止/标记遗留，不重放。

Process Adapter：

- 从现有 `process-runner.ts` 提取共享 direct-spawn、最小环境、UTF-8 分块、脱敏与树终止能力。
- 新的 session runner 支持可配置 30–900 秒 deadline、output checkpoint 与 preview readiness probe。
- adapter 只接受已解析的绝对 executable 与 sandbox root；公开层永不返回二者。

### Governance / Workflow

- exact frozen entry: `standing_policy`，无需新 Approval。
- `one_shot`: 复用 command Approval 事实与 input sandbox hash；批准后由命名 workflow 重新校验 Execution version / attempt / request hash / sandbox hash，再创建 Process Session。
- classifier `deny` 不创建 Approval。

## 数据

`CURRENT_SCHEMA` 26→27：

- `project_validation_policy_entries` 增加：
  - `purpose TEXT NOT NULL CHECK (...)`
  - `timeout_seconds INTEGER NOT NULL CHECK (30..900)`
  - `network TEXT NULL CHECK (network IS NULL OR network='loopback_only')`
  - `preview_port INTEGER NULL CHECK (1024..65535)`
  - `preview_open_path TEXT NULL`
  - 约束：validation 的 preview 字段全 NULL；preview 的 network/port/openPath 全非 NULL。
- `execution_policy_processes`：
  - identity: id, project_id, execution_id, attempt_id, policy_revision_id, policy_entry_id nullable, approval_id nullable
  - frozen request: request_hash, executable_identity, public_command_json, sandbox_manifest_hash, authorization_source
  - lifecycle: status (`starting|running|ready|stopping|completed|failed|timed_out|interrupted|termination_unconfirmed`), deadline_at, version
  - receipt: exit_code, stdout/stderr bytes/hash/truncated, preview_ready_at, reason_code, timestamps
  - 不保存/公开 PID；当前进程句柄只在 Adapter registry。重启通过非终态行对账。
- `execution_policy_process_output_chunks`：process_id, stream, chunk_index, byte_offset, byte_length, redacted_text, sha256。
- 部分唯一：同一 execution 至多一条非终态 policy process；与既有 `execution_actions` 活跃约束在 acquire 事务中联合检查。

写表 owner 清单与 schema identity/current fixture 同波次同步。

## 关键流程

### 精确政策命令

1. UI GET command catalog。
2. Safe Execution 读取 Execution 当前 attempt 与 frozen policy revision；Project & Workspace 返回该 revision entry。
3. 校验 entry identity、exact tuple、Execution version、sandbox manifest、无活动 action/session。
4. acquire 事务写 process row；外部 spawn 使用 `shell:false` / stdin ignore / minimal env / sandbox cwd。
5. 输出先脱敏再 checkpoint；preview 条目探测 persisted loopback port。
6. exit/stop/timeout 先确认整棵进程树退出，再 finalize receipt/outbox。确认失败进入 `termination_unconfirmed`。

### 单次命令

1. 结构化 command 过同一 classifier。
2. `deny` 直接稳定 4xx；`one_shot` 创建 command Approval，不 spawn。
3. Owner 裁决后 workflow 重新冻结并核对 approval/project/execution/attempt/request/input hash。
4. 仅 consumed Approval 进入与 exact policy 相同的 process acquire。

### 重启对账

composition 启动时把数据库中 `starting|running|ready|stopping` 标为 `interrupted`；registry 不存在即无可安全恢复句柄。绝不根据行自动 spawn。

## Preview 边界

- policy 持久化 `port/openPath`；start body 不接受 URL/host/port。
- `openPath` 必须以 `/` 开始、不得含 scheme、authority、反斜杠、NUL 或 `..` segment。
- start 前 probe 端口未占用；start 后只 probe `127.0.0.1:port` readiness。
- UI URL 固定由 `http://127.0.0.1:${port}${openPath}` 组成，新窗口 `noopener,noreferrer`。
- 平台不做代理、不抓取内容、不声称阻止可信本机程序自身发起所有 egress；publish/remote-transfer 类命令由 classifier 硬拒绝，Validation Policy 保留 hostile-sandbox 警告。

## Seam 与测试点

- Seam 1 — policy schema/append-only：`tests/modules/project-workspace/validation-policy*.test.ts`
- Seam 2 — exact/one-shot/deny：`tests/modules/safe-execution/policy-process*.test.ts`
- Seam 3 — process lifecycle/output/recovery：`tests/adapters/workspace/policy-process-runner.test.ts`
- Seam 4 — route strict DTO/ownership/body limit：`tests/modules/safe-execution/policy-process.api.test.ts`
- Seam 5 — Execution 卡片 UI + preview link：jsdom 聚焦测试与 `tests/browser/execution/`

## 横切

- operation/version/lease；外部动作三阶段；不自动重放。
- Project/execution/attempt/policy revision/entry/approval/sandbox hash 全 tuple 校验。
- 无 shell、无 stdin、无 env 输入、无任意 URL、无宿主绝对路径、输出先脱敏后持久化。
- 实现后 code review + security review：授权来源替换、Approval 重放、PID/进程树泄漏、端口混淆、SSRF、输出泄密、崩溃重放。
