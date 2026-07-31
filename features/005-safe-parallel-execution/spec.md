# 并行且安全地执行项目工作 需求规格

- 日期: 2026-07-30
- frame: ./frame.md

## 1. 背景与问题

S-4 已能让真实模型拆分带依赖的任务、领取任务并完成可审计交棒，但运行仍停在协作编排层：Agent 不能读取或修改项目内容，也不能运行验证。owner 仍需手工把已领取任务变成文件改动、执行命令、判断冲突并更新任务结果。

S-5 要在不破坏 owner 绑定工作区的前提下，让最多两名 Agent 真正并行执行互不依赖的已领取任务。每项工作必须先在独立隔离区内完成，经过路径、权限、资源、审批、基线、冲突和验证检查后，才允许以可审计方式进入 canonical workspace。这里的“安全”仅指平台级 guardrail；它不是、也不宣称是能抵抗恶意本地程序的操作系统沙箱。

## 2. 目标与成功标准

- 同一项目可从看板中选择最多两个不同、已领取、进行中且所有依赖已完成的任务并行执行；同一任务不得出现两个 active execution。
- 两名 Agent 均通过真实模型调用迭代提出结构化的文件列举、文本读取、文本写入和命令请求，并且每次请求都受该 Agent 权限、路径和资源边界约束。
- 每个 execution 的结构化文件写入只作用于自己的隔离区；命令从隔离区作用域发起并受 FR-6 的机械禁令与审批约束，但未知 executable 的实际副作用不作 OS 沙箱保证。进入提交前，canonical workspace 不因平台结构化文件工具改变。
- owner 能看到每项 execution 的持久状态、当前 Agent/任务、模型回合、工具调用、用量、审批、验证、变更预览、冲突、失败与控制动作。
- 低风险、验证成功、基线未过期且无冲突的 UTF-8 文本变更，在没有不合作外部 writer 时可崩溃恢复为全旧或全新；检测到外部写入时必须保留外部内容、转人工恢复且不得标记 merged 或写任务结果。
- 应用刷新或重启后，execution、审批、隔离变更、预览、验证结果、用量和审计时间线仍可读取；未确认完成的在途动作不会被静默重放。
- 自动化演示完整闭合 S-5：两名 Agent 并行修改独立路径并运行验证；同时证明重复执行、stale 结果、预算越限、越界/高风险工具和同路径冲突被阻止，owner 能审批、暂停、继续、重试和停止。

## 3. 范围

### 范围内

- 从 S-4 形成的任务 DAG 中选择并启动最多两个可执行任务。
- 每任务独立、持久、可恢复的 execution 生命周期和 owner 可见并行状态。
- 真实模型驱动的多回合结构化列举、读取、写入和命令请求。
- Agent 文件/命令权限、路径与文件类型防护、资源上限和失败关闭。
- canonical workspace 之外的独立隔离区、基线与项目上下文快照。
- owner 在非 OS sandbox 警示下保存的验证政策 standing approval、未精确匹配命令的一次性审批及审批后继续。
- staged diff、产物和验证结果预览。
- stale、同路径冲突、重复执行和后到结果阻断。
- 符合低风险边界、受外部 writer 条件约束的平台-owned 一致合入，以及与该合入一致的 execution/任务执行结果更新。
- execution 的暂停、继续、重试、停止、lease 过期和重启恢复。
- 完整审计时间线，以及桌面和窄屏审批/执行界面。

### 范围外

- 非执行者 Agent 的同伴复核、退回/升级/通过决定；S-6。
- 把任务标记为“完成”、把使命标记为完成、形成最终交付摘要；S-6。
- 把结果自动沉淀为长期共享决策、事实、产物或经验记忆；S-6。
- 容器、虚拟机、内核策略或其他抗恶意代码的 hostile OS sandbox。
- 无限制 shell、交互式终端和任意命令字符串。
- 产品不提供内建 remote deploy、publish 或 push 能力；命令请求中可机械识别的已知 deploy/publish/push 子命令与危险参数绝对拒绝。
- 平台不承诺静态证明未知或本地 executable 的真实副作用，也不承诺 owner 批准的程序无法自行访问网络、系统资源或凭据；这需要本产品范围外的 hostile OS sandbox。
- 任意二进制编辑、删除、重命名、权限位修改或自动合入。
- 多于两个并行 execution、跨项目调度、多节点执行、无人值守定时执行或应用重启后自动后台续跑。
- S-5 新增任务拆分或改变任务依赖；任务定义与依赖沿用使命看板事实。

## 4. 功能需求

### FR-1: 只选择最多两个独立且 DAG-ready 的已领取任务
- 优先级: 必须
- 描述: 平台只为满足确定前置条件的任务创建 execution，并机械阻止重复或相关任务并行。
- 验收标准:
  - Given 同一使命有两个不同任务，二者状态均为进行中、均已领取给当前项目成员、全部依赖均为完成，且二者之间不存在直接或间接依赖 When owner 启动执行 Then 两项 execution 均进入可运行状态并分别绑定原任务和领取 Agent。
  - Given 可选任务超过两个 When 调度 Then 同一项目同时 active 的 execution 始终不超过 2，未选任务保持原状态且显示未启动原因。
  - Given 任务未领取、领取者已不是项目成员、状态不是进行中、任一依赖未完成、两任务互相可达或任务已存在 active execution When 启动 Then 对应任务不启动并显示逐项拒绝原因。
  - Given 同一 Agent 已有 active execution When owner 为该 Agent 领取的另一任务启动 execution Then 新 execution 不启动并显示“该 Agent 正在执行”；同一 Agent 任一时刻的 active execution 数和在途模型调用数均不超过 1。
  - Given 两个客户端并发请求启动同一任务 When 请求完成 Then 最多创建一个 active execution，另一请求返回同一既有结果或明确冲突。
  - Given 一个 execution 进入终态 When 仍有合格任务 Then 平台不会因空出名额而无人值守自动启动新任务；必须由当前 owner 操作或当前已打开会话中的明确继续动作触发。

### FR-2: execution 生命周期持久且状态含义唯一
- 优先级: 必须
- 描述: 每项 execution 具有 owner 可见、可恢复且无歧义的生命周期。
- 验收标准:
  - Given execution 被创建 When 查询状态 Then 状态只会是 queued、running、waiting_approval、paused、staged、stale、conflicted、failed、stopped 或 merged，并显示任务、Agent、开始/更新时间和当前原因。
  - Given execution 被计入并行/任务/Agent 上限 When 判断 active Then active 仅指 queued、running、waiting_approval、paused 或 staged；stale、conflicted、failed、stopped 和 merged 均不占 active 名额，但同一任务只能通过 FR-12 的 retry 延续原 execution，不能另建 execution 绕过历史与预算。
  - Given execution 正常推进 When 状态变化 Then 合法顺序为 queued→running；queued 可因 owner 暂停进入 paused（恢复目标为 queued）或因 owner 停止进入 stopped；running 可进入 waiting_approval、paused（恢复目标为 running）、staged、stale、conflicted、failed 或 stopped；waiting_approval 在批准被消费时进入 running，在拒绝、批准撤销或请求替换时分别进入 paused（恢复目标均为 running，原因分别为 approval_rejected、approval_revoked、request_replaced），也可进入 stale、failed 或 stopped；paused 只可按记录的恢复目标回 queued、running 或 waiting_approval，也可因显式重试进入 queued、或进入 failed/stopped；staged 可进入 merged、stale、conflicted、failed 或 stopped；stale、failed 及 manualRecoveryRequired=false 的普通 conflicted 可经显式重试创建新 attempt并唯一进入 queued；manualRecoveryRequired=true 的 conflicted 只可按 FR-9 进入 recovered_old 后可重试、recovered_new/merged 或 abandoned/stopped；stopped 和 merged 为终态。
  - Given execution 处于任一非终态 When 页面刷新或应用重启 Then 相同 execution、状态、隔离变更、预算计数和等待事项仍可读取，不伪造成功或自动重放未确认动作。
  - Given execution 因提交/恢复期间检测到外部写入而进入 conflicted When 查询状态 Then 同时显示 manualRecoveryRequired=true、受影响路径、提交前/staged/当前 manifest hash 和未解决状态；在 FR-9 的三种 owner resolution 之一完成前，该标记不得自动清除。
  - Given 同一项目有两个 active execution When owner 查看项目 Then 两项状态独立显示；一项等待审批、暂停或失败不会隐式暂停另一项。
  - Given execution 已 merged 或 stopped When owner 请求继续或再次提交旧结果 Then 请求被拒绝且 canonical workspace、任务和审计事实不变。

### FR-3: 真实模型以迭代结构动作执行任务
- 优先级: 必须
- 描述: 领取 Agent 使用自己的 provider、模型、提示、技能、任务上下文和权限，在多个模型回合中一次提出一个可判定动作或声明变更已准备好。
- 验收标准:
  - Given execution 为 running When 推进一个模型回合 Then 发起真实 OpenAI-compatible 模型请求，并记录调用开始、成功/失败、可信 usage 和 Agent 可见摘要，不保存或展示隐藏思维链。
  - Given 模型响应合法 When 解析 Then 每回合只接受一个 disposition：请求列举、读取、写入、执行命令，或声明 staged；所有参数均为结构字段，不从自然语言或 shell 字符串猜测工具动作。
  - Given disposition 请求工具 When 权限和全部 guard 通过 Then 执行一次工具动作，把有界、脱敏结果加入下一模型回合，execution 保持 running。
  - Given Agent 未获对应 read、write 或 execute 权限 When 请求该类动作 Then 动作不执行，execution 暂停并明确显示缺少的权限；owner 不能用一次性工具审批绕过 Agent 本身未获的能力。
  - Given 响应结构无效 When 请求一次格式修复 Then 修复调用计入模型 usage 但不增加业务回合；第二次仍无效时 execution 暂停，且该回合没有工具或 staged 动作。
  - Given Agent 声明 staged When 尚无变更、存在待审批请求、命令仍在运行或要求的验证未成功 Then 声明被拒绝并暂停，显示未满足项。
  - Given execution 启动 When 构造模型上下文 Then 使用启动时冻结的任务/依赖/使命/共享上下文、成员、Agent 身份、provider 非凭据配置、model、system prompt、技能、权限和项目验证政策；FR-8 规定这些输入变化对当前 execution 的失效语义。

### FR-4: 列举与读取只接受隔离区内的安全文本路径
- 优先级: 必须
- 描述: 所有文件工具都以 execution 隔离区为唯一根，路径和文件类型不满足精确规则时失败关闭。
- 验收标准:
  - Given Agent 请求列举或读取 When 校验路径 Then 只接受非空、NUL-free、相对隔离区根的路径；拒绝绝对路径、UNC 路径、带盘符路径、以 `\\?\` 或 `\\.\` 开头的设备命名空间、任意 `..` 段、替代数据流分隔符，以及大小写不敏感的 CON、PRN、AUX、NUL、CLOCK$、COM1–COM9、LPT1–LPT9 设备名（含扩展名形式）。
  - Given 路径的任一已有段或目标是符号链接、junction、reparse point，或解析后的真实位置不在该 execution 隔离区内 When 请求访问 Then 请求被拒绝；不存在目标的写入也必须先验证最深已有父级满足同一规则。
  - Given 目标是普通文件以外的目录（读取文件时）、socket、FIFO、字符/块设备或其他特殊对象 When 请求读取 Then 请求被拒绝。
  - Given Agent 列举目录 When 目录合法且不超过边界 Then 结果按稳定名称顺序返回至多 1000 个直接子项，并明确标记是否因上限截断；不递归越过请求目录。
  - Given Agent 读取文件 When 文件大小为 0–1048576 字节、内容为可解码 UTF-8（允许 UTF-8 BOM）且不含 NUL Then 返回文本和内容 hash；否则以二进制、编码无效或超限类别拒绝，不返回部分内容。
  - Given 请求路径不存在、无权限或在访问前后被替换 When 执行 Then 动作失败关闭且不把其他位置的内容返回给模型。

### FR-5: 写入仅改变每任务独立隔离区
- 优先级: 必须
- 描述: Agent 只能在自己的隔离区新增或完整替换有界 UTF-8 文本，canonical workspace 在提交前保持不变。
- 验收标准:
  - Given 两个 execution 同时运行 When 任一 Agent 使用结构化文件工具 Then 工具只观察并改变自己的隔离区，另一 execution 和 canonical workspace 不出现该工具的中间或最终写入。Given Agent 请求命令 When 进入执行 Then 命令以该隔离区为声明作用域，并按 FR-6 决定免审批、绝对拒绝或一次性审批；平台不把未知 executable 的实际副作用声称为已隔离。
  - Given Agent 写入 When 路径通过 FR-4、Agent 有 write 权限、内容为有效 UTF-8 且 UTF-8 字节数不超过 1048576 Then 在隔离区产生完整文本文件，并记录写前/写后 hash。
  - Given 写入内容含 NUL、编码无效、超过 1048576 字节、目标为目录/特殊对象、目标或父级是链接类对象，或写入会越出隔离区 When 请求 Then 不发生任何部分写入，execution 暂停并显示具体 guard。
  - Given 为任意受支持项目建立隔离区 When 隔离区初始内容将超过 100000 个目录项或 2147483648 字节 Then execution 在任何 Agent 工具运行前暂停并说明超限；所有项目和隔离方式均适用相同边界，未完成或超限的隔离区不能用于执行或提交。
  - Given 隔离区无法建立或完整性无法确认 When 启动 Then execution 失败关闭，canonical workspace 和任务事实不变。

### FR-6: 命令受机械禁令、standing approval 和一次性审批约束
- 优先级: 必须
- 描述: owner 在项目中维护可见的验证政策；平台绝对拒绝可由请求本身机械识别的禁令，其余不匹配验证政策的 sandbox-scoped 命令必须获得精确一次性批准。
- 验收标准:
  - Given owner 查看项目验证政策 When 创建或编辑条目 Then 每条必须完整声明 executable、按顺序的精确参数、隔离区内相对工作目录和“合入必需/可选”，并先通过与普通命令请求相同的机械禁令；命中已知绝对禁令的条目保存次数为 0，不能借政策进入或执行。
  - Given 合法政策变更尚未保存 When owner 确认 Then UI 明确说明“保存即对该 exact executable/args/workdir 授予可撤销 standing approval，可重复执行而不逐次询问；平台不是 OS sandbox，不能证明 executable 的实际副作用”，只有 owner 明确接受后才保存。
  - Given 政策条目已由 owner 在警示下保存 When execution 启动 Then 冻结整份政策及其中全部“合入必需”条目；与冻结条目的 executable、参数顺序和工作目录逐项完全相同的请求可重复执行而无需每次弹出审批。
  - Given 请求与冻结政策只存在 executable 大小写/路径表示、参数增删/重排/值变化或工作目录变化等任一 near-match，或完全未列出 When 请求 Then standing approval 不适用，必须按该 execution/attempt/精确请求取得一次性批准。
  - Given owner 创建、编辑、撤销或拒绝保存验证政策 When 操作结束 Then 审计时间线记录 actor、时间、操作结果、变更前/后政策 hash、条目 exact executable/args/workdir、“必需/可选”和警示确认结果，但不记录凭据或未脱敏环境值。
  - Given 命令按 standing approval 执行 When 记录工具事件 Then 明确关联冻结政策 hash 与匹配条目；Given 命令按一次性批准执行 Then 明确关联一次批准标识，二者在 UI/审计中不可混淆。
  - Given execution 要形成 staged 或提交 When 冻结政策含合入必需条目 Then 每条必需命令必须在最后一次文件变化后以冻结的 exact command/args/workdir 成功退出；缺少、失败或发生在更早内容上的结果均不算“验证成功”。
  - Given 冻结政策为空或没有合入必需条目 When execution staged Then 不允许自动合入并显示“无必需验证”；只有 owner 对该 staged hash 作一次明确合入批准后才可提交，且该批准仍不能绕过路径、类型、大小、stale、冲突或绝对禁令。
  - Given 请求包含可机械识别的 shell 命令字符串、管道、重定向、命令替换、环境展开、stdin 或环境变量覆盖，工作目录/参数明确引用 canonical workspace 或隔离区外路径，或命中平台公开列出的已知 remote deploy/publish/push 子命令或危险参数 When 校验 Then 请求被绝对拒绝，不尝试解释、审批或执行；任何 owner 批准均不能放行或改写该结果。
  - Given owner 查看命令安全说明 When 查看绝对禁令 Then 能看到平台当前机械识别的 shell 形式、canonical/隔离区外路径形式、已知 remote deploy/publish/push 子命令与危险参数；产品没有可直接触发 deploy、publish 或 push 的内建动作。
  - Given Agent 有 execute 权限且请求未命中机械禁令，但未与冻结验证政策精确匹配，或是在隔离区内安装包、读取网络资源、删除/批量覆盖隔离内容或运行其他 sandbox-scoped 命令 When 请求 Then execution 进入 waiting_approval，显示精确 executable、参数、工作目录、声明的 sandbox 作用、风险原因、非 OS sandbox 警示和将使用的 Agent 权限。
  - Given owner 批准可审批请求 When 批准仍绑定同一 execution、attempt、精确 executable/参数/工作目录、冻结输入 hash 和请求 hash Then execution 保持 waiting_approval 直至该批准与命令开始被一次性消费；消费时唯一转为 running，任何字段变化都需新审批。
  - Given owner 拒绝待批请求 When 决定提交 Then 请求永久失效且 execution 唯一转为 paused（approval_rejected，恢复目标 running）；owner 继续后回 running，下一模型回合收到拒绝结果并可提出不同动作，原请求不可重放。
  - Given owner 在批准尚未消费前撤销批准 When 撤销提交 Then 请求永久失效且 execution 唯一转为 paused（approval_revoked，恢复目标 running）；已消费批准不可撤销，后续仅能用暂停或停止控制。
  - Given owner 选择替换待批请求 When 替换提交 Then 旧请求及未消费批准永久失效，execution 唯一转为 paused（request_replaced，恢复目标 running）；owner 继续后回 running，由下一模型回合提出新请求，平台不自行改写参数。
  - Given execution 终止、stale、请求被替换或同一批准已消费 When 再提交旧批准 Then 动作不执行；批准不能跨 execution、attempt、任务或 staged 结果复用。
  - Given 单命令运行达到 120 秒 When 超时 Then 终止整个进程树；如果无法确认终止，execution 失败关闭且永不合入。
  - Given stdout 或 stderr 分别超过 1048576 字节 When 记录 Then 只保留各自首个 1048576 字节并明确标记截断；截断不把失败退出码变为成功。
  - Given owner 准备批准未知或本地 executable When UI 展示风险 Then 明确说明平台只能检查请求中可机械识别的形式，不能证明程序真实副作用；批准的程序仍可能自行访问网络、系统资源、凭据或产生其他平台无法隔离的本机影响。

### FR-7: staged 结果提供完整可判定预览
- 优先级: 必须
- 描述: execution 在提交前形成不可变 staged 结果，owner 能审阅变更、产物、验证和风险。
- 验收标准:
  - Given Agent 合法声明 staged When 平台生成预览 Then 显示任务/Agent、相对路径列表、每路径新增/修改类型、基线与 staged hash、文本 diff、文件数、变更字节数、冻结验证政策、每条必需/可选命令及退出码、结果是否晚于最后文件变化、截断标记、已消费审批和风险分类。
  - Given execution 生成供 owner 查看但不合入的文本产物 When 预览 Then 产物具有名称、相对路径、大小、hash 和可读取内容，且与对应 execution 关联。
  - Given staged 结果含删除、重命名、二进制、权限位变化、超过 100 个文件，或所有 staged 文件最终 UTF-8 内容的字节数之和超过 10485760 When 分类 Then 不允许自动合入，明确列出阻断项并等待 owner 处理；S-5 不把这些变更静默降级为普通文本修改。
  - Given 预览仍在计算、无变更或读取失败 When UI 展示 Then 分别显示 loading、empty 或 error；error 状态不显示“可提交”。
  - Given staged 后隔离区内容、验证结果或上下文再变化 When 提交 Then 原预览失效，必须重新生成并重新检查，旧预览不能用于合入。

### FR-8: 冻结输入、基线和同路径冲突阻止过期结果
- 优先级: 必须
- 描述: execution 捕获任务/依赖/项目上下文与 workspace 基线；任何相关变化都在提交前阻止旧结果。
- 验收标准:
  - Given execution 启动 When 捕获冻结输入 Then 冻结任务及依赖、使命、共享上下文、项目成员、Agent 身份、provider 身份及除凭据外的配置、model、system prompt、按顺序的技能内容、read/write/execute 权限、完整验证政策，以及 execution 可见的 canonical workspace 文件基线；owner 可查看各项版本或指纹。
  - Given 任务/依赖、使命、共享上下文、项目成员、Agent 身份、provider 身份或非凭据配置、model、system prompt、技能内容/顺序、任一权限或验证政策在 execution 期间变化 When 下一模型回合、staged 或提交检查 Then execution 标记 stale，所有待批请求和未消费批准失效，保留 usage、工具结果和预览，但不得再调用模型/工具、合入、推进任务或触发后续接力。
  - Given 只发生同一 provider 的凭据轮换且 provider 身份、endpoint、model 和其他冻结配置未变 When execution 继续 Then execution 不因凭据值变化而 stale；已开始模型调用使用开始时凭据，后续模型调用只使用最新已验证凭据，凭据不可用则暂停，轮换事实进入审计但凭据值不进入冻结指纹、时间线或预览。
  - Given provider 凭据轮换同时改变 provider 身份、endpoint、model 或其他非凭据配置 When 检查 Then 按冻结输入变化标记 stale，不适用凭据轮换例外。
  - Given execution 读取或修改的 canonical 文件自基线后被 owner、外部程序或另一 execution 改变 When 提交 Then execution 标记 stale 或 conflicted，且该路径的 staged 内容不得覆盖新内容。
  - Given 两个 execution 的 staged 集合包含同一规范相对路径，即使最终文本相同 When 任一尝试自动合入 Then 两项都显示同路径冲突，未先合入的一方不得自动合入；冲突不能通过提交先后静默消失。
  - Given 两个 execution 修改路径不相交 When 第一项合入 Then 第二项只因 canonical workspace 的无关路径变化不会被判 stale；仍须验证其任务/上下文 hash和自身基线相关路径未变。
  - Given execution 进入提交或崩溃恢复 When 处理任一 canonical 相对路径 Then 在该路径首次处理前、每次平台准备改变该路径前、每次改变后及最终确认 execution/任务事实前，均重新核对该路径身份与内容 hash；任一次与该阶段预期值不一致都按外部写入冲突处理。
  - Given staged 结果进入提交 When 建立可观察恢复基准 Then “提交前 manifest”与“staged/post manifest”均覆盖全部受影响规范相对路径；每项包含期望存在/不存在、普通文件身份和内容 hash，整体 manifest hash 对路径排序后的完整集合唯一，owner 可查看这些值但不能用 resolution 操作改写它们。
  - Given stale 或 manualRecoveryRequired=false 的普通 conflicted execution When owner 重试 Then 新 attempt 从当前事实和当前 canonical 基线建立新的独立隔离区；旧 staged 结果只保留审计，不复制为新 attempt 的可提交结果。Given manualRecoveryRequired=true When owner 请求重试 Then 按 FR-9 拒绝，不能以当前混合 canonical 状态建立新 attempt。

### FR-9: 低风险合入保持平台状态一致且不覆盖外部写入
- 优先级: 必须
- 描述: 只有满足全部低风险条件的 staged 结果可自动合入；无不合作外部写入时，workspace 变化与执行结果崩溃恢复为全旧或全新；检测到外部写入时绝不静默覆盖并转人工恢复。
- 验收标准:
  - Given staged 结果仅含不超过 100 个 UTF-8 文本新增/修改、所有 staged 文件最终 UTF-8 内容合计不超过 10485760 字节、冻结输入/基线未变、无同路径冲突、全部必需验证在最后文件变化后成功、无未决审批，且提交窗口没有不合作外部 writer When 提交 Then 所有文件作为一个一致结果进入 canonical workspace，execution 变为 merged，并把该任务的最新执行结果/产物引用与同一结果关联；无必需验证时还必须具备 FR-6 的一次 staged 合入批准。
  - Given 提交与恢复期间没有不合作的外部 writer 改动相关 canonical 路径 When 合入任一文件或执行结果更新失败 Then 恢复后的 canonical workspace、execution 与任务执行结果全部保持提交前状态，execution 不变为 merged，且不存在部分合入。
  - Given 自动合入成功 When 查看使命看板 Then 原任务仍为进行中并显示“已有待复核执行结果”；只有 S-6 的非执行者复核才能把任务变为完成或退回。
  - Given staged 结果包含删除、重命名、二进制、权限变化、超限、验证失败、stale 或冲突 When 请求自动合入 Then 请求被拒绝；owner 对高风险命令的批准不等于批准合入。
  - Given 相同提交操作因客户端超时被重发 When 处理 Then 文件合入和任务执行结果最多发生一次；相同标识携带不同 staged hash 时返回冲突。
  - Given 应用崩溃或机器中断发生在多文件合入与任务执行结果更新之间，且提交/恢复期间没有不合作的外部 writer 改动相关 canonical 路径 When 恢复完成 Then 可观察结果只能是“全部 canonical 文件为提交前版本，execution/任务事实为提交前状态”或“全部 canonical 文件为 staged 版本，execution 为 merged 且任务引用同一执行结果”；混合新旧文件、merged 但文件未全新、文件全新但 execution/任务事实未匹配的结果均为 0。
  - Given 外部 writer 在提交或恢复窗口改变任一相关 canonical 路径，导致 FR-8 的路径身份或 hash 与阶段预期不一致 When 平台检测到 Then 保留该路径当前外部内容，不以提交前内容或 staged 内容覆盖它，停止剩余自动提交/恢复，execution 与提交恢复记录进入 conflicted 且 manualRecoveryRequired=true，不标记 merged，也不写入任务执行结果。
  - Given manualRecoveryRequired=true When owner 请求 retry、普通 control、再次 merge 或自动 recovery Then 全部拒绝且 canonical 内容不变；只有以下三个带 operation id 的 resolution 可改变该状态。
  - Given owner 已在平台外把全部受影响 canonical 路径恢复为提交前 manifest When 选择“确认恢复旧版本” Then 平台重新读取每一路径并要求存在性、身份、内容 hash 及整体 manifest hash 与冻结提交前 manifest 完全相同；完全匹配时记录 resolution=recovered_old、清除 manualRecoveryRequired、保持 execution 未 merged/任务结果未提交并允许随后 retry，任一不匹配则拒绝且保持 conflicted。
  - Given owner 已在平台外把全部受影响 canonical 路径整理为 staged/post manifest When 选择“确认保留新版本” Then 平台重新读取每一路径并要求存在性、身份、内容 hash 及整体 manifest hash 与冻结 staged/post manifest 完全相同；完全匹配时原子记录 resolution=recovered_new、execution=merged 和对应任务执行结果，清除 manualRecoveryRequired，任一不匹配则拒绝且保持 conflicted。
  - Given owner 已查看平台展示的全部受影响路径当前存在性、身份、内容 hash 和整体 current manifest hash When 选择“放弃本次 staged/恢复记录”并确认该 current manifest hash Then 平台不改变任何 canonical 内容，只清理由身份/hash 可证明属于该 execution 且仍未被外部改变的临时产物，记录 resolution=abandoned、清除 manualRecoveryRequired并把 execution 终态设为 stopped；无法证明归属或已变化的临时内容也保留并报告。
  - Given 任一 manual recovery resolution 使用 operation id When 相同 id 与相同 resolution、manifest hash 和确认内容被重发 Then 返回首次持久结果且 resolution、状态、任务结果和清理最多提交一次；同一 id 携带不同内容被拒绝为冲突。
  - Given external-writer conflict 已发生 When owner 尚未完成上述任一 resolution Then 平台不得静默覆盖当前 external content，也不得把该提交自动重试、控制或完成为成功。

### FR-10: 预算、工具、回合、时间和 lease 边界机械生效
- 优先级: 必须
- 描述: 每项 execution 在模型调用、工具调用和墙钟时间上有确定上限，达到边界即停止自治推进。
- 验收标准:
  - Given execution 即将推进 When 已完成 20 个业务模型回合、40 次工具调用或从首次 running 起达到 15 分钟墙钟时间 Then 不再发起新模型或工具动作，execution 进入 paused 并显示命中的值与上限。
  - Given S-5 为 Agent 启动首个 execution When 计算 token 预算 Then 初始已用量等于该 Agent 在同一协作 run 的全部 S-4 合法 usage；S-5 的 primary、格式修复、失败调用和重试中 provider 报告的合法 usage继续累加到同一 Agent、同一 run 的共享 maxTokens。
  - Given 同一 Agent 的 execution 重试或产生新 attempt When 计算预算 Then 继承 S-4 和该 Agent 全部既有 S-5 usage，不重置、不返还；不同 Agent 分别使用自己的 maxTokens 和累计 usage，互不借用。
  - Given Agent 的共享可信 usage 已达到其 maxTokens When execution 尝试模型调用 Then 不发起调用并暂停；同一 Agent 最多一个 active execution，因而该 Agent 不会有两个 S-5 响应并发争用剩余预算。
  - Given 一次模型响应使该 Agent 的共享 usage 越过 maxTokens When 响应返回 Then usage 和超预算事件保留，但该响应提出的工具、staged 或任务结果提交次数为 0，execution 暂停；另一 Agent 的预算和结果不受影响。
  - Given provider usage 缺失、为负、非整数或总数与分项不一致 When 返回 Then 当前回合失败并暂停，不伪造 usage，也不执行其动作。
  - Given 模型或工具 attempt 获得 120 秒 lease When lease 过期、应用崩溃或后到结果返回 Then attempt 标记 interrupted，后到动作提交次数为 0，execution 暂停并等待 owner 显式重试。
  - Given execution 已达到任一固定上限且配置/事实未改变 When owner 点击继续 Then 不绕过上限；只有新 attempt 仍满足全部预算前置条件时才可重试。

### FR-11: 所有变更操作幂等且重启不静默重放
- 优先级: 必须
- 描述: 启动、模型推进、工具执行、审批、控制、staged 和提交均具有可重试而不重复副作用的语义。
- 验收标准:
  - Given 客户端以同一操作标识和相同内容重发任一变更操作 When 处理 Then 返回首次操作的持久结果，execution、工具、审批消费、文件和事件最多提交一次。
  - Given 同一操作标识配不同内容、参数、execution、attempt 或 hash When 处理 Then 返回冲突且不执行新内容。
  - Given 应用在模型/工具调用结果持久化前重启 When owner 重新打开 Then 对应 attempt 显示 interrupted 或仍在有效 lease 内的 in-progress；平台不会猜测外部动作成功，也不会自动再调用 provider、命令或工具。
  - Given 命令是否已终止、隔离区完整性或 staged hash 无法确认 When 恢复 Then execution 失败关闭或暂停，不允许合入；owner 只能显式重试到新 attempt。
  - Given 应用在多文件提交期间崩溃且相关 canonical 路径没有外部写入 When 恢复 Then 在 FR-9 的全旧或全新一致结果确定前，相关 execution 不允许继续、重试或再次提交；恢复后文件、execution 与任务执行结果必须匹配同一个提交前或提交后状态。
  - Given 恢复期间任一路径身份/hash 不匹配该阶段预期 When 检测 Then 不再自动写该路径或继续自动完成/回滚；保留外部内容，将 execution 与提交记录标记 conflicted/manual recovery，任务执行结果保持未提交，等待 owner 手工处理。
  - Given manual recovery resolution 被提交或重发 When 处理 Then 适用与其他 mutation 相同的 operation id 幂等规则；resolution 事件记录请求的 resolution 类型、owner 确认 manifest hash、实际核对 manifest hash、结果和时间。
  - Given 应用重启后没有 owner 打开项目或明确继续 When 存在非终态 execution Then 不自动后台续跑。

### FR-12: owner 可暂停、继续、重试和停止单项 execution
- 优先级: 必须
- 描述: 控制动作只影响目标 execution，并保留已完成审计和隔离结果。
- 验收标准:
  - Given execution 为 queued When owner 暂停 Then 唯一转为 paused 并记录恢复目标 queued；When owner 继续 Then 唯一回到 queued，随后仍需正常取得运行资格才可进入 running。
  - Given execution 为 running When owner 暂停 Then 唯一转为 paused 并记录恢复目标 running，不再开始新模型/工具动作；已开始的原子文件动作安全结束，运行中的进程被请求终止，结果保留审计但不得自动形成 staged 或提交。Given owner 继续且无未确认在途动作 When 控制生效 Then 唯一回到 running，既有工具/模型/usage 计数不重置。
  - Given execution 为 waiting_approval When owner 暂停 Then 当前待批请求和未消费批准保留但不可消费，execution 唯一转为 paused 并记录恢复目标 waiting_approval；When owner 继续 Then 唯一回到 waiting_approval，owner 仍须批准、拒绝、撤销或替换该请求。
  - Given execution 为 conflicted 且 manualRecoveryRequired=true When owner 请求重试、暂停、继续、停止或普通控制 Then 请求被拒绝并指向 FR-9 manual recovery；Given conflicted 已以 recovered_old 清除 manualRecoveryRequired When owner 重试 Then 创建新 attempt 且 execution 唯一进入 queued，以当时 canonical workspace 重新建立基线。Given execution 为 failed、stale、普通 conflicted 或 interrupted pause When owner 重试 Then 创建新 attempt 且 execution 唯一进入 queued；重新检查任务资格、权限、预算、上下文和 workspace 基线，旧 attempt、审批、usage 和结果仍只读可见，取得运行资格后才进入 running。
  - Given execution 为 queued 或任一其他非终态且 manualRecoveryRequired=false When owner 停止 Then 唯一转为 stopped，未消费审批失效，后到模型/工具/命令结果不得 staged 或合入；manualRecoveryRequired=true 时普通 stop 被拒绝，只能使用 FR-9 的 abandoned resolution 终态停止。
  - Given 两项 execution 并行 When owner 控制其中一项 Then 另一项状态和推进不变，除非其自身随后触发共享上下文或路径冲突检查。
  - Given 控制请求使用过期版本或重复标识 When 处理 Then 相同请求幂等返回，内容不同或状态不允许时明确冲突，不覆盖较新的 owner 动作。

### FR-13: 完整审计时间线覆盖从选择到合入
- 优先级: 必须
- 描述: owner 能按稳定顺序追溯所有公开执行事实，不依赖隐藏推理或原始敏感数据。
- 验收标准:
  - Given 任一 execution 发生选择、状态变化、模型调用、usage、结构动作、文件工具、命令、standing/一次性审批、验证政策变更、预览、基线检查、冲突、manual recovery resolution、控制、恢复或合入 When 读取时间线 Then 每项具有稳定顺序、execution/attempt、任务、公开 actor、时间、结果类别和必要的 hash/计数关联。
  - Given 工具或命令失败 When 查看事件 Then 可见请求摘要、命中的 guard、退出码/超时/截断和恢复条件，但不包含 API key、Authorization、主密钥、凭据密文、原始 provider body、隐藏思维链或未脱敏环境变量。
  - Given 页面刷新或应用重启 When 重新读取 Then 历史事件顺序、状态、审批决定、验证输出摘要和 staged/merge 关联保持一致。
  - Given 同一操作被重发、lease 后到或结果被 stale/conflict 丢弃 When 查看 Then 时间线明确显示“重放”“中断”或“未提交”结果，不能伪装成一次新的成功动作。

### FR-14: 桌面与窄屏 UI 闭合 S-5 演示
- 优先级: 必须
- 描述: 协作驾驶舱同时呈现双 execution、审批、变更预览和控制，并覆盖完整交互状态。
- 验收标准:
  - Given 桌面宽度 When 两项 execution 并行 Then owner 能同时看到两项任务/Agent、状态、当前动作、预算进度和阻断原因，并在时间线、任务、审批与 staged 预览间保持可辨关联。
  - Given 窄屏 When 查看执行详情、审批或 diff Then 一次只出现一个覆盖式交互区域；关闭后焦点回到触发控件，owner 可完成批准/拒绝、暂停/继续/重试/停止和查看预览。
  - Given 执行列表、审批或预览正在加载、为空或失败 When UI 展示 Then 分别提供 loading、empty、error；高风险审批另有 disabled、success 和可见 focus 状态，草稿/选择在可恢复错误后保留。
  - Given owner 审批命令或查看自动合入资格 When UI 展示 Then 精确显示单次请求、风险原因、权限、参数、验证状态、路径/大小边界和“非 hostile OS sandbox”警示；不得用含糊的“全部允许”按钮替代。
  - Given owner 查看项目执行设置或 staged 结果 When UI 展示验证 Then 能看到当前项目验证政策、execution 冻结版本、必需集合、exact executable/args/workdir、每项最近结果，以及政策为空时“禁止自动合入、需一次 staged 批准”的状态。
  - Given execution 的 manualRecoveryRequired=true When owner 查看执行详情 Then 显示提交前、staged/post 与当前 manifest hash、逐路径存在性/身份/hash 差异，禁用普通 retry/control/merge，并只提供“确认恢复旧版本”“确认保留新版本”“审阅当前内容后放弃”三种 resolution 及各自成功前置条件。
  - Given S-5 demo When 运行真实本地兼容模型流程 Then 两名 Agent 并行修改不相交文本路径并运行声明验证后形成可预览结果，至少一项低风险结果成功合入；同一 demo 还可观察地证明重复启动、越界路径、高风险命令待批、批准只消费一次、预算/工具/时间边界、stale 与同路径冲突均阻止不安全提交。

## 5. 非功能需求

### NFR-1: 并发、隔离与原子性
- 要求: 同一项目 active execution 数≤2；同一任务 active execution 数≤1；同一 Agent active execution 数和 S-5 在途模型调用数均≤1；提交前 canonical workspace 因平台结构化文件工具产生的变更数=0；同一提交或 manual recovery resolution 的成功提交次数≤1；失败、stale、conflict、stopped、过期或后到 attempt 最终残留的平台提交变更数=0；没有不合作外部写入时，正常失败及崩溃恢复后的文件、execution、任务执行结果只能全部保持提交前状态或全部达到同一提交后状态；在 FR-8 每个指定检查点注入并检测到 identity/hash 不匹配时，不匹配 external content 的覆盖次数=0、resolution 前普通 retry/control/merge 成功次数=0。
- 出处: A-12、A-15、A-46、A-47、A-50、A-51、A-57、A-59，以及用户 2026-07-30 第 1 轮修订要求（同 Agent 单 active）。
- 验证方式: 并发启动、双隔离区互不可见、canonical 前后快照、同路径/不相交路径竞态、无外部 writer 的提交故障注入与重启全旧/全新核对，以及在提交/恢复各路径阶段注入外部写入后核对外部内容保留、conflicted/manual recovery 和未提交任务结果。

### NFR-2: 路径、文件和资源边界
- 要求: 每个项目隔离区初始内容≤100000 个目录项且≤2147483648 字节，不因隔离方式或项目类型而变化；单次文本读/写≤1048576 字节；目录列举≤1000 项；每 execution≤20 个模型业务回合、≤40 次工具调用且≤15 分钟；单命令≤120 秒，stdout/stderr 各保留≤1048576 字节；自动合入≤100 个 UTF-8 文本新增/修改，且所有 staged 文件最终 UTF-8 内容合计≤10485760 字节；全部越界访问和超限自动提交次数=0。
- 出处: A-48、A-52、A-54、A-55、A-57，以及用户 2026-07-30 第 1 轮修订要求（所有隔离形态统一边界）。
- 验证方式: 对每个下限/上限/上限+1、链接逃逸、设备名、特殊文件、无效 UTF-8、NUL、输出截断、超时进程树和合入集合执行边界测试并核对 canonical workspace hash。

### NFR-3: 权限、审批与安全表述
- 要求: Agent 无对应权限时工具执行次数=0；命中公开机械禁令的政策保存和命令执行次数均=0；owner 在非 OS sandbox 警示下保存的 standing approval 只覆盖 exact executable、参数顺序和工作目录，exact-match 可重复执行且无需每次提示，near-match/unlisted 的 standing-approval 命中次数=0；其他 sandbox-scoped 请求每个精确请求最多消费一次批准，任一字段变化后的复用次数=0；政策保存/编辑/撤销及每次 standing/一次性授权执行的审计关联率=100%。
- 出处: D-4、A-6、A-48、A-49、A-53、A-56、A-58、product/product.md 的受限工作区边界。
- 验证方式: 权限矩阵；政策创建/编辑时的警示确认、已知 deny 拒绝和审计；同一 exact policy match 多次免提示执行；每种 near-match/unlisted 请求逐次一次性审批；批准重放/篡改/跨 attempt；桌面/窄屏警示与审计关联检查；不以推断任意程序实际副作用为验收项。

### NFR-4: 持久、幂等与审计完整性
- 要求: 刷新/重启后 execution、attempt、审批、usage、冻结输入、验证政策/结果、工具/命令结果、staged、冲突、manualRecoveryRequired/resolution、控制和合入事件可恢复率=100%；同一变更或 resolution 操作的业务副作用成功提交次数≤1；120 秒 lease 过期或终态后的后到动作提交次数=0；无外部写入时提交崩溃恢复后的混合文件或文件/任务/execution 不一致状态数=0；对在 FR-8 每个规定 identity/hash 检查点分别注入、且检查点检测到不匹配的外部变化，被平台 backup/staged 覆盖的对应 external content 数=0，resolution 前 execution/提交记录保持 conflicted/manualRecoveryRequired、merged/任务结果提交次数=0；产品响应、持久事件、DOM、日志与截图中的 API key、Authorization、主密钥、密文、原始 provider body和隐藏思维链匹配数=0。
- 出处: product/product.md 成功标准与可观察运行状态、A-15、A-16、A-20、A-23、A-41、A-51、A-59。
- 验证方式: 在每个生命周期阶段重启并恢复；重复 operation、lease 过期和延迟结果故障注入；无外部写入的每个提交崩溃点验证全旧/全新；在 FR-8 列出的每类路径检查点分别注入 identity/hash 变化并确认检测，然后验证 external content 保留、manualRecoveryRequired、普通操作拒绝，以及 recovered_old、recovered_new、abandoned 三种 resolution 的 exact manifest、状态/任务结果、清理边界和 operation idempotency；扫描持久数据、公开响应、DOM、日志和 demo 证据。

### NFR-5: 可访问性与响应式操作
- 要求: 新增执行、审批、预览和控制 UI 的正文/控件满足 WCAG AA；交互目标≥44×44px；仅键盘可完成选择任务、批准/拒绝、撤销/替换审批、暂停/继续/重试/停止和查看 diff；焦点始终可见且状态/风险/冲突不只依赖颜色；产品进入既有窄屏模式时，一次最多一个覆盖式执行/审批/预览区域，关闭后焦点返回触发控件且所有上述操作仍可完成。
- 出处: product/product.md、A-17、ext-ui-design。
- 验证方式: 自动语义/对比度/尺寸检查，加桌面和产品既有窄屏模式的真实浏览器键盘流程、焦点恢复、单覆盖区与截图核对。

## 6. 约束与依赖

- S-4 已交付，使命看板、任务 DAG、已领取/进行中状态、真实 OpenAI-compatible 调用、可信 usage、持久 operation、120 秒 lease、owner 控制和稳定时间线可复用为既有行为。
- 项目必须绑定可读取的本地 canonical workspace，任务领取 Agent 必须仍是项目成员且 provider 可用。
- 文件与命令能力必须服从 Agent 已配置权限；owner 的单次批准只能放行仍在该 Agent 能力范围内的高风险具体请求。
- 项目验证政策由 owner 明确维护并可见；每个 execution 使用启动时冻结版本，政策变化使该 execution stale。
- 自动测试和 demo 使用独立本地 OpenAI-compatible provider，不把用户云端凭据写入仓库或证据。
- Windows 与支持的本地文件系统均执行 FR-4 的保守拒绝规则；平台无法确认普通文件、规范路径、进程终止或隔离完整性时一律失败关闭。
- 外部程序不受应用锁约束；平台-owned 提交原子保证以相关 canonical 路径在提交/恢复期间没有不合作外部写入为前提，但“检测到不匹配时不静默覆盖”没有此前提。
- S-5 不改变 A-34 的任务状态集合；成功合入后任务保持进行中并等待 S-6 非执行者复核。

## 7. 假设

- A-12/A-46: 最多两个 execution，且只执行不同、DAG-ready、已领取、进行中的任务；若要求更多并行度，资源与冲突验收需重新定格。
- A-15/A-51: 任务、依赖、相关上下文或相关 workspace 基线变化使旧结果 stale；若允许自动重放旧结果，将破坏本规格的提交保证。
- A-47: 每任务独立、完整、可恢复且资源有界的隔离区，canonical workspace 提交前不变；具体隔离实现不属于本规格，若外部保证无法确认则 S-5 执行失败关闭。
- A-48/A-54: 只开放结构化列举、UTF-8 文本读写和命令，并采用本规格精确路径/文本/大小边界；若需二进制或链接操作，应另行扩大安全范围。
- A-49/A-56/A-58: owner 在非 OS sandbox 警示下保存验证政策即授予 exact command/args/workdir 可撤销 standing approval，exact-match 可重复免提示执行；near-match/unlisted 使用精确一次性审批。合入必需集合冻结；若没有必需验证则禁止自动合入并要求一次 staged 合入批准。可机械识别的 shell/path/已知远程发布与危险参数既不能保存进政策也不可审批。
- A-50/A-57: 仅满足全部低风险条件的新增/修改文本自动合入；删除、重命名、二进制、权限变化和超限不在 S-5 自动合入范围。
- A-52/A-55: 工具、回合、墙钟、命令和输出采用固定边界；若真实项目经 demo 证明不足，应先更新假设再修改规格。
- A-53: 平台 guardrail 不是 hostile OS sandbox；若产品要运行不可信恶意程序，需要新的产品切片和风险评估。
- A-59: 无不合作外部写入时平台-owned 多文件提交崩溃恢复为全旧或全新；检测到外部 writer 改写时保留其内容并转 conflicted/manual recovery，不自动覆盖或标记 merged。

## 8. 开放问题

无阻塞性开放问题。A-46 至 A-59 已为所有未由既有产品决策覆盖的执行边界提供生效默认值；规格评审可推翻这些假设，但推翻后必须回到本规格修订。
