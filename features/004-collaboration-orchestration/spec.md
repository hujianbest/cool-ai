# 在群聊发起使命并观察自主编排 需求规格

- 日期: 2026-07-29
- frame: ./frame.md

## 1. 背景与问题

项目已有平等成员、使命、看板和共享上下文，但 Agent 尚未真正调用模型，也不能在群聊中协作。owner 仍是唯一做计划、分配和推进的人。S-4 要证明第一轮自治闭环：owner 在项目群聊发起目标，平台把相同共享上下文和每名 Agent 自身配置交给真实 OpenAI-compatible provider，模型通过可审计结构动作拆任务、领取和交棒，必要时暂停请求 owner 决策。

本切片只允许模型改变协作消息、使命任务、领取和运行状态；不开放文件、命令或外部工具。

## 2. 目标与成功标准

- owner 在项目群聊发送目标后，产生真实 provider 请求和持久运行。
- 至少两名不同 Agent 各完成一轮有效模型响应，并形成任务拆分、领取和结构化交棒。
- owner 能发送普通消息、通过成员选择器 @Agent、回答决策请求并恢复运行。
- 任一时刻只有一个当前持棒者；owner 能看到每次请求、消息、任务动作、交棒、用量、暂停/失败与恢复的完整时间线。
- 应用刷新或重启后，运行、消息、当前持棒者、决策、用量与时间线可继续读取和恢复。

## 3. 范围

### 范围内
- 项目群聊 owner 消息与稳定成员 mention。
- 单持棒者协作运行的创建、逐轮推进、暂停、失败、显式重试、停止和完成。
- OpenAI-compatible chat-completions 真实网络调用与一次结构格式修复。
- Agent 结构化可见消息、任务提案、任务领取、交棒、决策请求和完成动作。
- owner 决策回答与 @Agent 定向下一棒。
- provider usage 记录、Agent token/交棒边界、50 轮总边界。
- 完整持久时间线、当前持棒者与使用量 UI。

### 范围外
- 同一运行内并行模型调用或并行任务执行；S-5。
- 文件读写、命令、网络工具、审批、隔离变更或合并；S-5。
- 同伴复核、最终摘要和自动长期记忆沉淀；S-6。
- 隐藏思维链、原始 provider headers、API key、完整原始 prompt/response body 的展示或持久化。
- 多个同时 active 的项目协作运行；S-4 每项目最多一个 active run。

## 4. 功能需求

### FR-1: owner 在项目群聊发起协作
- 优先级: 必须
- 描述: owner 能发送 1–10000 字符消息并以该消息启动或介入项目协作。
- 验收标准:
  - Given 项目已有工作区、至少两名成员、当前使命且成员 provider 可用 When owner 发送消息并启动 Then 消息立即进入时间线，创建 running 协作 run 和第一名当前持棒者。
  - Given owner 使用成员选择器 @Agent When 消息提交 Then mention 以稳定 Agent id 持久化并把下一棒定向给该成员；显示名变化不破坏历史 mention。
  - Given 未 @Agent When 启动 Then 第一棒按平等名册的稳定顺序选择；后续由结构化交棒选择，不设固定 leader。
  - Given 文本空白、超长、mention 非成员或项目上下文未就绪 When 提交 Then 显示具体错误且不创建 run/消息。
  - Given 项目已有 running/waiting run When owner 再次“启动” Then 不创建第二个 active run，而是把消息追加到现有 run 并按 owner 优先规则处理。

### FR-2: 真实模型轮次形成可见 Agent 消息
- 优先级: 必须
- 描述: 当前持棒 Agent 使用自己的 provider/model、system prompt、技能和项目上下文发起真实模型请求，并提交 schema 约束动作。
- 验收标准:
  - Given 当前 run 可推进 When 执行一轮 Then 时间线依次显示调用开始、调用完成/失败和 Agent 可见消息，且 provider usage 被记录。
  - Given provider 返回合法结构 When 提交 Then只接受消息、任务提案、领取、交棒、决策请求或完成字段，不保存隐藏思维链。
  - Given 首次响应不是合法结构 When 平台请求一次格式修复 Then 修复请求不计业务轮次；第二次仍无效时 turn 失败、run 暂停且不提交任何任务/领取/交棒动作。
  - Given provider 401/403/429/5xx、超时、网络失败或密钥不可用 When 调用 Then run 持久化暂停/失败分类，不泄露凭据，owner 可显式重试。
  - Given provider usage 缺失、负数、非整数或 total 与明细不一致 When 响应 Then turn 失败并暂停，不伪造或提交结构动作。
  - Given 模型返回一个业务 turn When 解析 Then必须包含 1–20000 字符可见消息和且仅一个 disposition：交棒、决策请求或“编排就绪”；决策请求不能同时带任务/领取，交棒与编排就绪可同时带 0–20 个任务提案和最多一个领取。
  - Given 任一任务、领取或 disposition 不合法 When 提交 Then 该业务 turn 的可见 Agent 消息、任务、领取和 disposition 全部不进入群聊/事实状态；provider attempt、合法 usage 与结构动作失败事件仍保留用于审计。

### FR-3: Agent 拆分带依赖的子任务
- 优先级: 必须
- 描述: Agent 能在一轮中向当前使命提议最多 20 个新子任务及其批内依赖。
- 验收标准:
  - Given 合法任务提案 When turn 提交 Then 任务按模型给出的稳定 client key 映射创建为待办，字段边界与 S-3 一致，依赖形成无环图并显示在看板/时间线。
  - Given 提案含重复 client key、未知依赖、自依赖、环路、超 20 项或字段越界 When 提交 Then 整个 turn 的状态动作回滚，run 暂停并显示结构动作错误。
  - Given 同一 turn 同时提案和领取 When 领取引用本批稳定 client key或提交前已存在任务 Then 在同一原子提交中先建立完整合法任务图再领取；其他临时/未知引用使整轮失败。
  - Given 任务标题/说明来自模型 When UI 展示 Then 作为纯文本处理，不执行 HTML/代码。

### FR-4: Agent 领取任务并结构化交棒
- 优先级: 必须
- 描述: 当前持棒者能领取一个可开始的待办任务，并把下一棒交给另一名成员。
- 验收标准:
  - Given 待办任务依赖已完成且未分配 When Agent 提交领取 Then 负责人设为该 Agent、状态变为进行中并记录 claim 事件。
  - Given 任务不存在、非待办、已有负责人、依赖未完成或领取者不是当前持棒者 When 提交 Then turn 动作回滚并暂停，不产生重复领取。
  - Given Agent 提交 1–5000 字符摘要、原因和另一成员 id When 交棒 Then 当前持棒者原子切换，timeline 记录 from/to/摘要/原因。
  - Given target 不在项目、等于自己或该 Agent 已达到 maxHandoffs When 交棒 Then 被拒绝并暂停。
  - Given Agent 提交“编排就绪” When run 至少有两名不同 Agent 提交有效业务轮次、当前使命至少有一个任务且至少一个任务已被领取 Then run 进入 planned 终态，表示可交给 S-5 执行；使命和未完成任务不被标为完成，也不替代 S-6 的非执行者复核。
  - Given 编排就绪条件不满足 When 当前 Agent 提交该 disposition Then 整轮被拒绝并暂停，时间线指出缺少的参与者/任务/领取。

### FR-5: 决策请求暂停并由 owner 恢复
- 优先级: 必须
- 描述: Agent 能提出一个问题和 2–8 个选项，owner 回答后协作继续。
- 验收标准:
  - Given 合法决策请求 When turn 提交 Then run 进入 waiting_owner，问题、选项、请求 Agent 和时间出现在 timeline，自动推进停止。
  - Given run waiting_owner When owner 选择一个选项或输入 1–5000 字符自由文本并提交 Then 答案进入 timeline，run 恢复 running，下一棒默认为请求 Agent。
  - Given owner 回答时 @另一成员 When 提交 Then 恢复后的下一棒改为被 mention 成员。
  - Given decision 已回答、run 非 waiting_owner、答案空白/超长或 mention 非成员 When 提交 Then 请求被拒绝且原运行状态不变。
  - Given 应用在 waiting_owner 时重启 When 重新打开项目 Then 同一未回答请求与输入入口仍可用。
  - Given run waiting_owner When owner 只发送普通消息或 @mention 而未回答当前请求 Then 消息排队但 run 仍 waiting_owner，mention 不覆盖请求；只有有效答案可恢复。

### FR-6: owner 消息优先且运行可控制
- 优先级: 必须
- 描述: owner 能在自治运行间隙插入消息，并暂停、继续、重试或停止运行。
- 验收标准:
  - Given 当前没有 provider 调用提交中 When owner 发送新消息 Then 消息先于下一 Agent turn 被纳入上下文；@Agent 覆盖当前计划下一棒。
  - Given provider 调用已经开始 When owner 发送消息 Then 当前 attempt 不并发取消或重写；消息按提交顺序排队并在任何下一次 provider 请求前进入上下文。
  - Given calling attempt 返回交棒且存在排队 owner 消息 When 提交 Then任务/领取/Agent 消息可原子提交，普通消息后下一棒仍是合法交棒目标，@mention 则覆盖下一棒为被 mention 成员。
  - Given calling attempt 返回编排就绪且存在排队 owner 消息 When 提交 Then编排就绪被延期、run 保持 running；普通消息保持当前持棒者，@mention 指定下一棒。
  - Given calling attempt 返回决策请求且存在排队 owner 消息 When 提交 Then run 仍进入 waiting_owner，排队消息不会被误当答案。
  - Given run paused/failed When owner 点击重试 Then 创建新 attempt，旧失败保留在 timeline，同一旧 attempt 的状态动作不会再次提交。
  - Given run running When owner 暂停 Then 暂停阻止新 turn；若 attempt 已 calling，其响应/usage 记录但业务 turn 不提交。Given owner 停止 Then 停止为终态且不能继续，进行中的 attempt 结果不得提交业务 turn。
  - Given run paused When owner 继续 Then 保持同一 run 与当前持棒者并恢复推进。
  - Given run planned/stopped When owner 发送消息、回答、继续或重试 Then 终态不复活；消息可作为项目聊天保留，但启动新协作必须显式创建新 run。

### FR-7: 用量和边界可见且生效
- 优先级: 必须
- 描述: owner 能看到每 Agent 和整个 run 的 usage、业务轮次与交棒数，边界达到时运行暂停。
- 验收标准:
  - Given 任一次真实 provider 请求返回合法 usage When 请求无论最终业务结构成功、需修复、失败或属于显式 retry Then 该次 prompt/completion/total 都按 Agent 与 run 累计并关联对应 attempt；格式修复调用单独计数但不增加业务轮次。
  - Given provider 网络/认证失败且没有 usage When 记录 attempt Then 显示“未报告用量”且不伪造数字；若失败响应带合法 usage 则仍累计。
  - Given Agent 累计 token 达到其 maxTokens、发出交棒达到 maxHandoffs 或 run 达到 50 业务轮次 When 试图再推进 Then 不再发起 provider 请求，run 进入 paused 并显示命中的具体边界。
  - Given provider 单次响应导致累计越过 token 边界 When 提交 Then usage 与“超预算响应”审计事件保留，但 Agent 可见消息、任务、领取和 disposition 不提交，run 暂停。

### FR-8: Provider 失败分类可恢复
- 优先级: 必须
- 描述: 每类 provider 失败产生唯一可观察分类和重试条件。
- 验收标准:
  - Given 密钥缺失/损坏或 provider 未验证 When 调用 Then run paused，类别 `credential_unavailable`；只有配置恢复后可重试。
  - Given 401/403 When 调用 Then run paused，类别 `provider_auth`；只有 provider 重新验证或替换凭据后可重试。
  - Given 429 When 调用 Then run paused，类别 `rate_limited`；owner 可稍后显式重试。
  - Given 5xx、超时或网络失败 When 调用 Then run paused，类别分别为 `provider_upstream`、`provider_timeout`、`provider_unreachable`；owner 可显式重试。
  - Given 两次结构响应无效 When 调用 Then run paused，类别 `structured_output_invalid`；owner 可显式重试。
  - Given usage 无效/缺失 When 调用 Then run paused，类别 `usage_invalid`；只有 provider 能报告合法 usage 后可重试。
  - Given 持久化/内部不变量失败 When 提交 Then run failed，类别 `internal_failure`；不能直接继续，修复后只能显式重试为新 attempt或启动新 run。

### FR-9: 完整时间线和恢复
- 优先级: 必须
- 描述: 所有协作事实以稳定顺序持久化，刷新/重启后可恢复。
- 验收标准:
  - Given owner 消息、调用、Agent 消息、任务动作、交棒、决策、usage、状态或错误发生 When 读取 timeline Then 每项有稳定 sequence、类型、公开 payload、actor 和时间，按 sequence 唯一排序。
  - Given 客户端因超时重发同一次启动、owner 消息、推进、重试、决策回答、暂停、继续或停止提交 When 服务处理 Then 返回第一次提交的同一结果且消息/attempt/回答/控制事件/状态动作最多出现一次；同一重试标识配不同内容被拒绝为冲突。
  - Given calling attempt 的 120 秒占用期过期或应用重启 When 读取/推进 Then attempt 标记 interrupted，run paused，owner 可显式重试；旧 attempt 后到结果不能提交。
  - Given timeline/API/日志被扫描 When 查找 provider key、Authorization、主密钥、密文、validation token、隐藏思维链或原始 headers/body Then 匹配次数为 0。

### FR-10: 协作驾驶舱状态完整
- 优先级: 必须
- 描述: 群聊/时间线、持棒者、决策、usage 和运行控制提供 loading、empty、error、disabled、success 与 focus。
- 验收标准:
  - Given timeline 尚在加载 When 打开项目 Then 显示 loading，不提前显示“尚无消息”。
  - Given 尚未发起协作 When 加载完成 Then 显示就绪检查和消息输入，不展示虚构 Agent 对话。
  - Given推进或控制失败 When UI 显示 error Then owner 能重试且未发送草稿保留。
  - Given新消息/事件到达 When timeline 更新 Then 以非打断方式向辅助技术宣告摘要，用户滚动查看历史时不强制抢滚动位置。
  - Given 窄屏 When 操作群聊、运行状态和决策 Then 任一时刻只有一个覆盖式交互区域，键盘可达且关闭后焦点恢复。

## 5. 非功能需求

### NFR-1: Provider 与 prompt 安全
- 要求: 产品响应、timeline、持久协作事件、页面、日志和截图中测试 API key/Authorization/master key/cipher/token/原始 headers 匹配为 0；每个 Agent prompt 只包含 allowlist 项目 shared、其 currentAgent 配置、公开 timeline 摘要和 owner 消息，不含其他 Agent system prompt/技能正文。
- 出处: A-16、A-20、A-23、A-35、frame 档位 3
- 验证方式: 安全域分开判定：(1)隔离测试 provider 捕获的出站请求允许且必须只在 Authorization 中含 API key，并允许当前 Agent 自身 system prompt/技能、项目 shared、公开 timeline 摘要与 owner 消息；禁止其他 Agent system prompt/技能、主密钥、密文和 validation token。(2)产品 API、持久时间线、DOM、日志、截图与 evidence 对 API key/Authorization/master key/cipher/token/原始 headers/body 的匹配均为 0。比较两名 Agent 出站 shared 相同且私有配置只属于当前 Agent。

### NFR-2: 单持棒与幂等
- 要求: 同一 run 任一时刻活动模型调用数≤1、当前持棒者数=1；同一次被重发写操作的 attempt/事件/任务动作成功提交次数≤1；停止或过期 attempt 的后到动作提交次数=0。
- 出处: A-15、A-36、A-41
- 验证方式: 并发推进、重复请求、故障/延迟 provider、120 秒调用占用期过期、停止竞态和重启恢复的外部行为计数。

### NFR-3: 可访问性
- 要求: 新增聊天、控制、决策和 usage UI 满足 WCAG AA、44×44px、键盘完成、焦点可见；Agent/状态/错误不只依赖颜色。
- 出处: product/product.md 与 ext-ui-design
- 验证方式: 桌面/窄屏仅键盘完成启动、@mention、决策回答、暂停/继续/重试/停止，核对语义、焦点、文本状态、对比度与真实截图。

## 6. 约束与依赖

- 需要项目完成 S-3 readiness，成员引用 S-2 verified provider。
- 自动测试/demo 使用独立本地 OpenAI-compatible server；不把真实云端凭据写入仓库。
- S-4 只变更持久协作事实和使命任务，不调用 workspace 内容能力。
- Provider 必须返回可信 usage；不支持 usage 的 provider 不能用于 S-4 自动运行。
- 每项目最多一个非终态协作 run。

## 7. 假设

- A-35: 本地兼容 provider 验证真实 HTTP 协议；若验收必须使用特定云模型，需要 owner 在本机提供凭据后追加人工 smoke，不改变运行时路径。
- A-36: 单持棒者；若本片要求并行，需引入 S-5 的隔离、冲突和 stale-result 语义。
- A-37: schema 动作和一次格式修复；若允许自由文本驱动状态，审计与原子提交规则需重定格。
- A-38: owner 优先和稳定 mention；若 Agent 消息优先，干预时序与 UI 提示需改变。
- A-39/A-43: 50 轮、Agent 配置边界与可信 usage；若缺 usage 仍继续，会使预算不可判定。
- A-40: 决策问题/选项/自由文本；若允许多个并行请求，等待状态和回答路由需重构。
- A-41: 120 秒调用占用期与显式 retry；若引入常驻后台执行器，可改为后台恢复但仍需幂等。
- A-42: 消息/任务/交棒边界；若推翻，prompt、事件和响应大小测试需同步。

## 8. 开放问题

| 问题 | 阻塞? | 状态 |
|------|-------|------|
| 自动验收是否必须使用用户云端模型 | 否 | 已解决：运行时走真实兼容 HTTP；自动 demo 用独立本地 provider，云端凭据不进入仓库 |
| S-4 是否需要 token 流式输出 | 否 | 已解决：S-4 以轮次/事件级实时状态为验收，token streaming 后置 |
