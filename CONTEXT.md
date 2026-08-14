# Cool AI 协作上下文

Cool AI 是单一 owner 与平等角色 Agent 在项目公开空间内协作、执行、复核并交付可追溯成果的领域。这里统一描述参与者、协作容器、公开事实、来源与决定的语言。

- 用户确认: 2026-08-09 用户确认采用“领域模块化单体 + Ports/Adapters + 跨域 Application Workflow；垂直切片交付，选择性事件投影，受控扩展端口”的主架构，并重写产品治理层。

## 参与者与项目

**Owner**：
对项目方向、安全授权和需要人工判断的事项拥有最终决定权的单一产品创造者。
_Avoid_：管理员、经理、最终执行者

**Agent**：
具有稳定角色身份、职责和能力配置的项目成员；模型或 Provider 的更换不改变该身份。
_Avoid_：机器人账号、模型、下属

**Project**：
承载团队、使命、公开线程、共享记忆与成果来源的隔离协作边界。Owner 通过打开本机文件夹进入或恢复一个 Project；该文件夹是 Workspace 绑定根，不是 Project 的同义词。
_Avoid_：工作区、仓库、会话

**Mission**：
项目组共同推进的目标，以及其工作项依赖与完成状态的唯一业务边界。
_Avoid_：聊天主题、线程、运行

**Work Item**：
Mission 中具有负责人、依赖和明确状态的可交付工作单位。
_Avoid_：消息、提示词、待办文本

## 协作与事实

**Thread**：
Project 内稳定、公开且可长期续接的会话容器；它组织消息上下文，但不取代 Project 共享的 Mission、看板或记忆事实。
_Avoid_：Run、私聊、分支

**Collaboration Run**：
明确归属一个 Thread 的一次 Agent 协作生命周期；切换 Thread 不会迁移、重放或结束它。
_Avoid_：Thread、会话标签、消息批次

**Thread Fact**：
Thread 公开历史中不可变、按序且可追溯的一项正式事实；Message、公开 Run 事件与 handoff 都通过它进入同一可见时间线。
_Avoid_：临时 UI 状态、模型原始响应、隐藏推理

**Message**：
由 Owner 或 Agent 署名、属于一个 Thread Fact 的公开表达，可包含纯文本或正式 Structured Message Block。
_Avoid_：Provider 响应、审计日志、私语

**Source Tuple**：
由精确 Project、Thread、Run、Message 及适用的来源实体身份共同形成的冻结来源；缺少某一不适用成员不允许用“最新”实体补足。
_Avoid_：当前上下文、最近运行、来源链接

**Artifact**：
由项目执行或工作区边界内已验证来源产生、可被事实引用的成果或证据。
_Avoid_：任意宿主文件、未经验证的路径、最新文件

## 结构化消息

**Structured Message Block**：
Message 内具有明确类型与版本的不可变正式内容，继承 Message 的 actor、Thread Fact 顺序和 Source Tuple。
_Avoid_：任意 HTML、插件组件、可执行小部件

**Proposal**：
Agent 或 Owner 提出的、带有限允许动作且等待 Owner 明确选择的 Structured Message Block。
_Avoid_：自动批准、审批请求、自由表单

**Checklist**：
以明确项目集合表达待确认状态、并只允许约定更新动作的 Structured Message Block。
_Avoid_：Mission 看板、任意任务列表、执行计划

**Diff Preview**：
对已验证 workspace 或 execution artifact 差异来源的只读结构化投影。
_Avoid_：编辑器、合入动作、原始私密 diff

**File Reference**：
对已验证项目文件或 artifact 身份的只读结构化引用；引用本身不授予读取或执行权限。
_Avoid_：宿主路径、文件上传、任意文件读取

**Handoff Card**：
既有公开 handoff fact 的结构化投影，保留原 actor 与 Source Tuple。
_Avoid_：新 Run、私语、第二份交棒

## 决定与回执

**Inline Decision**：
Owner 在 Proposal 或 Checklist 原位，从该项唯一允许动作集合中对其精确版本作出的正式决定。
_Avoid_：卡片点击、工具执行、正式审批

**Action Receipt**：
某次操作对冻结来源产生的确定结果；相同操作重放得到同一结果，冲突或陈旧操作不得产生新的业务动作。
_Avoid_：成功提示、审计事件、可变状态

**Approval**：
对高风险、破坏性或外部副作用动作的正式授权边界；Structured Message Block 只能关联或导航到它，不能替代它。
_Avoid_：Inline Decision、确认按钮、建议

## 领域不变量

- Project 是数据与权限隔离边界；Thread、Run、Message、Block、Decision、Receipt 与来源必须属于同一精确 Project 关系。
- Thread Fact 与 Structured Message Block 一经成为公开事实即不可变；后续状态以新版本或新事实表达，不改写历史。
- Source Tuple 冻结来源身份；任何读取、投影、决定或恢复都不得以 latest 实体替代指定来源。
- Structured Message Block 只表达受支持的正式类型；未知类型或版本不可执行，也不能被猜测解释。
- Inline Decision 只作用于一个 Block 的精确版本与唯一允许动作集合；它不等于工具执行或 Approval。
- Handoff Card、Diff Preview 与 File Reference 都是既有事实或已验证来源的投影，不创造新的生命周期、权限或宿主访问能力。
- 公开事实和审计只包含可见、脱敏且必要的领域内容；凭据、原始 Provider 响应、隐藏推理和私密原始 diff 不属于公开协作事实。

## 首次发布前数据库生命周期

- 用户确认: 2026-08-09 项目首次正式发布前不承诺历史 SQLite schema 或本地开发数据兼容。
- `openDatabase` 只接受空库 bootstrap 或 current exact schema reopen（identity 25）；legacy、partial、drift、unsupported 或数据不变量非法的数据库均失败关闭。
- `CURRENT_SCHEMA` 是唯一 DDL source of truth；仓库不保留版本间 migration、legacy adoption/backfill 或可重放旧 schema fixture。
- 本地开发数据库只能由开发者显式删除并重建，应用绝不静默删除、覆盖或自动重建非空数据库。
