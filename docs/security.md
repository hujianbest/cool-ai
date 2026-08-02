# 安全模型

Cool AI 的安全目标是让单个 owner 在受信任本机上，以可见权限、审批、隔离、超时、冲突和审计规则运行 Agent。它不是公开网络服务，也不是抗恶意代码的操作系统沙箱。

## 部署与信任边界

- 应用本地优先、单 owner、无登录认证。
- 不要将开发服务器或 API 暴露到不可信网络；任何能访问应用的人都可能以 owner 能力操作项目。
- 当前没有覆盖所有 Route Handler 的全局统一 parse 前请求体上限；execution、review 等安全关键 mutation 有显式 body cap，部分较早路由仍在 `request.json()` 后做 DTO/Zod 字段校验。字段校验不能替代 parse 前 body cap，这也是不得暴露到不可信网络的原因之一。
- 模型请求会发送到 owner 配置的 Provider，包括完成当前任务所需的公开上下文。产品不能被描述为“完全离线”。
- 工作区、数据库、execution 目录和主密钥均由本机 owner 负责访问控制与备份。

## Provider 凭据

- `COCKPIT_MASTER_KEY` 必须是 32 字节 base64url 值。
- API key 使用由该主密钥派生的密钥加密后写入 SQLite；UI/API 只返回掩码。
- 主密钥不应与数据库、源码或日志放在一起。丢失或更换密钥会使既有凭据无法使用，需要重新填写。
- Provider 请求禁止自动跟随重定向，防止 Authorization 被带到另一地址。
- HTTP Provider 必须由 owner 明确确认；远程服务应优先使用 HTTPS。

## 工作区与 execution guardrail

平台使用独立 sandbox、verified handle、路径/特殊文件检查、Agent 权限、精确命令政策、一次性审批、资源限制、基线 hash、验证、冲突检测和可恢复合并来降低误操作风险。越界或无法验证时失败关闭，不把“看起来在目录内”的字符串路径当作证明。

但这些 guardrail **不是 hostile OS sandbox**。owner 通过 standing approval 或一次性批准运行的本地程序，仍可能自行访问网络、系统资源、进程、服务、其他文件或凭据。平台也不承诺静态证明未知 executable 的真实副作用。只批准受信程序；处理敌对代码应另用容器、虚拟机或 OS 安全策略。

自动合入仅覆盖受限的 UTF-8 文本新增/修改。删除、重命名、二进制、权限位变化、验证失败、stale 基线、冲突或超限内容等待人工处理。合并期间发现外部 writer 时，平台保留外部内容并进入冲突/人工恢复，而不是静默覆盖。

## 模型输出与审计

- 协作与复核要求严格结构化 JSON object；未知字段、无效动作和不可信 usage 被拒绝。
- 响应、文本、工具调用和进程输出有有界大小/时间；原始 Provider body 不作为产品数据持久化。
- 产品保存公开消息、结构化动作、状态、usage、文件/验证结果及版本引用，不保存或展示隐藏思维链。
- 复核裁决只能来自 owner 选择的合格非执行者 Agent；平台和客户端不能伪造通过。
- 任务、result、review、memory 和 delivery 的版本关系可追溯，旧版本不会被补写成新结论。

## owner 操作清单

1. 只在受信任本机和网络接口上启动。
2. 使用独立随机主密钥，避免进入仓库和日志。
3. 只配置你信任其数据处理方式的 Provider。
4. 为 Agent 授予完成任务所需的最小工具权限。
5. 精确审查 validation policy 和每个一次性命令请求。
6. 合并前核对 staged 预览、验证、冲突与非 OS sandbox 警示。
7. 备份 SQLite、execution 状态和匹配的主密钥，但分开保管密钥。

继续阅读：[配置说明](./configuration.md)、[安全执行](./guides/safe-execution.md)、[Provider 兼容性](./provider-compatibility.md)。
