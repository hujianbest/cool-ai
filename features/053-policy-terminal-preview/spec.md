# 策略内终端与本地浏览器预览需求规格

- 日期: 2026-08-19
- 切片: S-43 / 053
- 主 Capability: `CAP-EXE-03` Policy Terminal & Local Preview
- 主子系统: Safe Execution

## 1. 背景与问题

`CAP-EXE-01` 已能在 Execution 的隔离工作区执行命令，Validation Policy 也已保存精确的 executable / args / workdir tuple；但这些能力只能由 Agent 工具动作消费。Owner 无法在某个工作项的 Execution 内选择并运行被冻结政策允许的命令、查看脱敏输出，也无法在浏览器中打开一个有边界和生命周期的本地预览。

把它做成自由 shell 会绕过精确 tuple、Approval、进程树终止、输出脱敏和审计；把任意 URL 做成预览又会制造 SSRF 与外部发布入口。本片只提供“策略内命令选择器 + 只读输出 + loopback 预览”，不是通用终端。

## 2. 目标与成功标准

- Owner 在具体 Execution / Work Item 内选择**冻结 Validation Policy** 中的精确命令并运行；没有自由 shell 文本框。
- UI 在执行前清楚展示命令、相对工作目录、授权来源、网络边界、端口与超时；运行中可查看脱敏的 stdout/stderr 并显式停止。
- 标记为 preview 的政策命令只暴露 `127.0.0.1` / `::1` 本地预览地址；浏览器打开目标由服务端持久化政策生成，客户端不能提交任意 URL。
- 越界路径、shell、命令替换、未许可 tuple、外部发布/推送、非 loopback 目标、端口抢占、超时与无法确认进程树退出均失败关闭。
- 重启不自动重放命令；遗留 running 会话进入 `interrupted` 并等待 Owner 显式重试。
- 桌面与窄屏覆盖 loading / empty / error / disabled / success / focus；控件 ≥44px；axe 无 critical/serious。

## 3. 范围

### 范围内

- Validation Policy 条目增加用途与运行边界：
  - `purpose: "validation" | "preview"`（既有条目默认 `validation`）；
  - `timeoutSeconds`（30–900）；
  - preview 条目必须有 `port`（1024–65535）、`openPath`（站内绝对路径，默认 `/`）与 `network: "loopback_only"`。
- 绑定到既有 Execution 当前 attempt 与其冻结 policy revision 的 Owner 命令会话。
- 精确政策命令直接运行；未命中但机械分类为 `one_shot` 的命令只生成既有 Approval，批准且来源版本仍匹配后才可运行。
- stdout/stderr 脱敏、有界分块、hash、截断标记与只读查询。
- preview 就绪探测、loopback URL 生成、显式停止、到期终止、重启对账与审计。
- 任务内 Execution 卡片的按需“终端与预览”表面；不新增图标轨主项。

### 范围外

- shell / PTY、stdin、命令历史、环境变量编辑、任意命令补全、交互式 TUI。
- 任意 URL 代理、远程站点预览、外部发布、端口转发、LAN/公网监听。
- 宣称任意本地程序已获得 hostile OS sandbox 或完整网络隔离。此能力仍运行 Owner 明确配置的可信本机 executable；平台只承诺精确 tuple、最小环境、隔离 cwd、loopback 预览约束和失败关闭生命周期。
- 自动打开浏览器、后台永久服务、应用重启后自动恢复进程。
- 从 canonical workspace 运行；命令始终使用当前 attempt sandbox。

## 4. 功能需求

### FR-1: 冻结政策命令目录

- Given Execution 有当前 attempt 和冻结 policy revision When Owner 打开终端表面 Then 只列出该冻结 revision 的条目，并显示安全命令摘要、相对 workdir、purpose、network、port、timeout。
- Given 活动政策后来改变 When 查看既有 Execution Then 不用 latest 替换冻结条目。
- DTO 不返回宿主绝对 executable、sandbox 根、凭据或私有路径；只返回 executable basename、args 与相对 workdir。

### FR-2: 精确政策命令运行

- Given 选择的 entry 属于该 Execution 冻结 revision，identity / args / workdir / classifier version 完全匹配 When POST start Then 创建 process session，使用 `shell:false`、无 stdin、最小环境在 attempt sandbox 运行。
- Given entry 不属于 tuple、Execution 非可运行状态、已有活动 action、sandbox manifest 不匹配或 executable identity 漂移 Then 在 spawn 前失败关闭。
- 同 operationId + 同 request hash 重放同一会话；同 ID 不同输入 409。

### FR-3: 单次命令审批与硬拒绝

- Given Owner 提交未命中冻结 policy 的结构化 executable / args / workdir When 分类为 `one_shot` Then 只创建/复用既有 command Approval；未批准不得 spawn。
- Given shell、控制符、命令替换、路径逃逸、`git push/remote/credential`、package publish/deploy/release 或远程传输命令 Then `deny`，不得以 Approval 放行。
- Approval 只能消费一次，且 project/execution/attempt/requestHash/input sandbox hash 全部匹配。

### FR-4: 有界输出与停止

- stdout/stderr 按 UTF-8 安全块持久化，单流最大 1 MiB；凭据脱敏后才落盘和返回。
- GET 支持 cursor/offset 增量读取；UI 用 `aria-live="polite"` 汇报状态，不逐字符打断读屏。
- Owner stop、timeout、lease 丢失均终止整棵进程树；无法确认退出时状态为 `termination_unconfirmed`，Execution 不得继续或产出验证/成功事实。

### FR-5: 本地浏览器预览

- preview 会话只从政策中的 `port` 与 `openPath` 生成 `http://127.0.0.1:{port}{openPath}`；请求体不接受 URL、host 或 port 覆盖。
- start 前端口必须未占用；start 后仅探测同一 loopback 端口。就绪后 UI 提供「打开本地预览」；新窗口使用 `noopener,noreferrer`。
- 非 loopback host、任意 URL 代理、外部发布或远程传输没有 API。
- 会话终止后预览入口 disabled；到期自动终止并保留脱敏 receipt。

### FR-6: 崩溃恢复与审计

- `starting|running|stopping` 会话在应用重启后只对账为 `interrupted`，不重放 spawn。
- started / ready / stopped / completed / timed_out / interrupted / denied 写入 Safe Execution 事实并通过既有 execution audit outbox 脱敏公开。
- 进程成功不等于 Work Item 完成、Review 通过或 Delivery。

## 5. API 契约（先行）

所有路由校验 executionId、project ownership、内容类型、正文上限与严格 DTO。

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/executions/:executionId/policy-commands` | 查询冻结 policy 的安全命令目录与当前会话 |
| POST | `/api/executions/:executionId/policy-processes` | 启动精确 entry 或请求 one-shot Approval |
| GET | `/api/executions/:executionId/policy-processes/:processId` | 查询状态、receipt 与预览就绪信息 |
| GET | `/api/executions/:executionId/policy-processes/:processId/output` | cursor 读取脱敏 stdout/stderr 块 |
| POST | `/api/executions/:executionId/policy-processes/:processId/stop` | 显式停止并确认进程树退出 |

`POST` body 三选一：

- 精确政策：`{ entryId, expectedExecutionVersion, operationId }`
- 单次申请：`{ command: { executable, args, workdir }, expectedExecutionVersion, operationId }`
- 批准后续接：`{ approvalId, expectedExecutionVersion, operationId }`

停止请求使用 `{ expectedVersion }` 对 Process Session 做乐观并发校验；终态重放幂等返回既有 receipt。

响应只含稳定状态、相对/摘要信息与本地 preview URL；不含绝对 executable、sandbox 路径、PID、环境或未脱敏输出。

## 6. UI（消费 API，不另造主路径）

- 入口：任务治理视图中的 Execution 卡片内「终端与预览」。没有当前 Project / Execution 时不显示。
- 表面：按需展开或窄屏 modal；上部是政策命令选择器与“命令 / 工作目录 / 授权 / 网络 / 端口 / 超时”摘要，下部是只读输出区域与状态操作。
- 命令不允许拼接编辑；需要额外命令时使用结构化「申请单次命令」，不是 shell。
- preview ready 后显示「打开本地预览」；停止/超时后按钮 disabled 并解释原因。
- Loading / Empty / Error / Disabled / Success / Focus 六态齐全；输出区可键盘滚动，停止与打开预览触区 ≥44px，焦点不被 sticky 操作条遮挡。

## 7. 安全与审计

- 冻结 policy revision、executable identity、exact args/workdir 与 attempt sandbox hash 是授权输入。
- 复用 command classifier、Approval、process tree termination、bounded redaction 与 execution audit outbox；不得在 route/UI 重写安全判断。
- preview URL 只能由持久政策产生；服务端不抓取 URL，避免 SSRF。
- 本片不承诺通用进程的 hostile OS sandbox；Validation Policy UI 必须继续显示该限制。
- 独立复核仍消费冻结 Result/Validation；终端成功不能直接推进完成门槛。

## 8. 假设

- A-393：S-43 不提供自由 shell；“终端”是只读输出与结构化命令选择器。理由：满足 Owner 运行政策命令的主结果，同时不绕过 exact tuple。
- A-394：本地预览使用受控 loopback 新窗口，不做代理任意 URL，也不内嵌第三方 origin iframe。理由：避免 SSRF、同源与焦点风险。
- A-395：既有政策条目缺省为 `validation`；只有显式 `preview` 条目声明 port/openPath/network。理由：兼容既有事实且不从命令文本猜端口。
- A-396：进程重启后不恢复；running 会话对账为 interrupted，Owner 显式重试。理由：符合 acquire/checkpoint/finalize 与 0 自动重放外部动作。
