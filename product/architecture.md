# Cool AI 产品架构

- 日期: 2026-08-09
- 状态: 产品级架构基线；目标架构收敛已完成（特性 019，D-45），后续功能开发按本文件准入
- 用户确认: 2026-08-09 采用领域模块化单体 + Ports/Adapters + 跨域 Application Workflow；2026-08-09 确认先把当前工程实现完整迁入目标架构，再恢复后续功能开发；2026-08-09 确认解除架构优先冻结（D-45）
- 更新: 2026-08-09 收敛完成后按 hf-to-product-architecture 刷新——第 8 节现状证据、第 9 节收敛完成记录，新增第 11 节关键场景与第 12 节横切约定
- 决策依据: `docs/adr/0002-domain-modular-monolith.md`、`docs/adr/0003-pre-release-canonical-database-schema.md`、`docs/adr/0004-architecture-first-convergence.md`

## 1. 架构目标

Cool AI 保持一个本地优先、单进程、单 SQLite 的**领域模块化单体**。模块边界按事实所有权划分，不按页面、HTTP 路由、数据库表类别或技术层划分。

- 每类命令事实只有一个逻辑子系统 owner。
- 每张可写表必须在写表 owner 清单中登记恰好一个 owner；未登记、重复登记或跨 owner 直接写入都失败。
- 跨子系统只能调用公开 Interface；不得导入对方私有服务、直接读写对方表或把 React/HTTP 状态当成领域契约。
- 涉及多个 owner 的用户结果由 Application Workflow 协调。需要强一致时，Workflow 在同一 SQLite 事务中调用各子系统事务内 Interface，维持共同不变量。
- 读投影可由同库 outbox 中的选择性公开事件构建；读投影不是命令事实源，也不能反向推导或修补业务事实。
- UI、HTTP、SQLite、Windows verified-handle、Provider、CLI、MCP 都是 Adapter；领域能力不以某个 Adapter 的形态定义。

这不是微服务规划。逻辑边界先在单体内变得清楚、可测试、可机械约束；没有独立部署、扩缩容、数据驻留或故障隔离证据时不拆进程。

## 2. 逻辑子系统与事实所有权

下列“拥有”指有权验证并提交该事实的唯一逻辑 owner；“不拥有”用于明确常见越界。具体表名可以随迁移改变，所有权不得随调用方便而漂移。

### Identity & Capability

拥有：

- Provider 配置身份、加密凭据引用与连接验证结果。
- Skill、Agent Template、Agent 稳定身份、角色职责、模型绑定、能力声明、工具权限和预算配置。
- Adapter 注册所需的受控能力描述、版本与启停状态。

不拥有：

- Project 成员关系、Thread 成员策略、Mission 分工或运行中的持棒者。
- 某次执行获得的实际授权、Approval 裁决或工作区路径。
- 用量投影和“哪个 Agent 更适合”的派生结论。

### Project & Workspace

拥有：

- Project 身份、生命周期与隔离边界。
- Project Member 关系，以及绑定工作区的规范身份、已验证根、文件系统支持状态和 Validation Policy。
- 项目级非敏感偏好中确属 Project 配置的事实。

不拥有：

- Agent 本身的角色/能力配置。
- Mission、Work Item、Thread Message、Execution、Review、Memory 或 Delivery 的业务状态。
- 任意宿主文件内容；绑定只建立能力边界，不把文件系统变成 Project 数据库。

### Mission & Work

拥有：

- Mission 目标、状态与完成门槛。
- Work Item、负责人、依赖 DAG、阻塞原因、状态、版本和唯一有效任务事实。
- 任务领取资格和与任务生命周期直接相关的派发意图。

不拥有：

- 公开聊天、Thread/Run 生命周期、执行产物、Approval、Review 裁决或知识条目。
- 页面看板排序、依赖图布局或 SOP 读投影。
- Agent 身份与工具权限。

### Public Collaboration

拥有：

- Thread 身份、标题、成员策略版本和公开活动顺序。
- Collaboration Run 的协作生命周期、Turn/Attempt、公开 Message、Thread Fact、handoff、owner 决策请求与回答。
- Structured Message Block、Inline Decision 与其 Action Receipt（在相应能力 ship 后）。
- 公开协作中的 actor 快照、来源关联和可见用量事实。

不拥有：

- Mission/Work Item 状态、Execution 工具动作、Approval 裁决、Review 结论、Memory 内容或 Delivery。
- Provider 原始响应、隐藏推理、凭据和私密 diff。
- 搜索索引、通知发送状态或跨域时间轴投影。

### Safe Execution

拥有：

- Execution、Attempt、Action、sandbox 身份与基线快照。
- 工具调用、Validation、Artifact、Staged Change、冲突/陈旧状态、Merge Journal 和工作区合入结果。
- 执行阶段的 acquire/checkpoint/finalize 租约状态、资源边界和确定终态。

不拥有：

- Mission 完成、公开协作交棒、Approval 裁决、Review 结论或最终 Delivery。
- Project 绑定根和 Agent 能力配置；只消费其冻结授权快照。
- canonical workspace 之外的宿主能力，或 owner 未明确授权的网络/进程能力。

### Governance

拥有：

- Approval Request、裁决、失效、作用域和不可变授权证据。
- 跨域安全政策中确属治理的版本、例外、审计保留与风险分类。
- operation 注册/对账协议的共享治理规则；具体业务 operation 的结果仍归产生它的子系统。

不拥有：

- 被批准动作的业务成功、Execution 结果、Mission 状态或 Review 结论。
- 通过审批自动扩大 Adapter 权限，或替代 verified-handle、sandbox、版本和冲突检查。
- 运维审计页面的查询投影。

### Review & Delivery

拥有：

- Result 版本、Review Attempt、复核者资格快照、退回/升级/通过裁决和复核证据。
- Delivery、交付包身份、最终摘要、证据清单与交付完成版本。
- “全部任务独立通过且最终交付已持久化”的交付侧完成证据。

不拥有：

- Execution 的工具结果、Mission 的最终状态写入、Memory 内容或公开 Thread Fact。
- 复核 Agent 的身份配置和 Provider 凭据。
- 用“最新运行”替代冻结 Source Tuple。

### Knowledge & Provenance

拥有：

- Project Memory、类型、actor、来源、版本、active/supersedes 链和集合关系。
- 可引用证据身份、知识来源边及提炼发布状态。
- 知识索引任务的领域状态；检索结果本身是可重建投影。

不拥有：

- 原始 Message、Execution Artifact、Review 或 Delivery。
- 无来源模型推断、Provider 原始响应或把聊天自动升级为知识。
- 跨项目聚合事实。

### Runtime

拥有：

- 受控 Runtime/Adapter 实例、会话、能力协商、版本、健康握手和生命周期。
- Provider 调用、CLI/ACP 会话、MCP transport/tool 调用等外部交互的脱敏请求元数据与确定结果引用。
- 基于冻结配置权限、项目范围、风险政策与 Approval 来源版本计算或缓存的 effective grant 运行时投影及其撤销/失效状态；该投影不是授权事实源。

不拥有：

- Agent 身份、Project/Workspace 事实、Mission 状态、公开消息、执行合入、Approval 或知识。
- 任意进程内插件对数据库、凭据、宿主文件、进程或网络的直接访问。
- 把外部 runtime 的“成功”直接提交为业务完成。

### Operations Projection

拥有：

- 从公开事件重建的服务健康、用量、审计浏览、运行时间轴、通知、搜索和只读回放投影。
- 投影 checkpoint、消费者版本、重建进度、失败和 freshness。

不拥有：

- 任何命令事实、Approval、Mission/Work 状态、Thread Fact、Execution、Review、Memory 或 Delivery。
- 对源子系统回写“修正值”或以投影缺失证明业务事实不存在。
- 隐藏推理、凭据、原始 Provider 响应和未脱敏私密内容。

### 权限事实四分与转换

权限不是一个可被多个模块覆写的通用 `grant`。四类事实具有不同身份、版本和唯一 owner：

1. **配置权限与能力声明** — owner: Identity & Capability。描述 Agent/Adapter 被配置为可以请求哪些工具、预算和能力；只有 Identity & Capability 的命令 Interface 能写。它不证明某次 Project 或 Runtime 调用已获授权。
2. **项目授权范围** — owner: Project & Workspace。描述 Project Member、绑定 workspace root、Validation Policy 及该项目允许使用的能力范围；只有 Project & Workspace 能写。它不能扩大 Identity 配置，也不构成高风险 Approval。
3. **Approval 请求、裁决证据与风险政策** — owner: Governance。Approval 绑定精确 actor、Project、目标、风险、operation、Frozen Source Tuple、期限和版本；只有 Governance 能创建请求、记录 owner 裁决或使其失效。裁决只是授权证据，不写入执行成功。
4. **effective grant 运行时投影** — owner: Runtime。它是从上述三类冻结输入求交集后计算、或按来源版本与短 TTL 缓存的可撤销投影；Runtime 只能写缓存 identity、source versions、expiresAt/revokedAt 和计算结果，不能写配置权限、项目范围、Approval 或风险政策，也不能把缓存当成第二授权源。

授权转换由 `Resolve Effective Runtime Grant` Application Workflow 发起：

1. 冻结 actor/Agent、Project/Workspace、requested capability、operation、目标资源和全部来源版本。
2. 分别查询 Identity & Capability 的配置声明、Project & Workspace 的项目范围，以及 Governance 的风险政策与适用 Approval；查询不产生授权事实。
3. Workflow 将冻结输入交给 Runtime 的纯求交/校验 Interface。任一来源缺失、过期、撤销、版本变化或目标不匹配即拒绝；grant 不能比任一输入更宽。
4. Runtime 可缓存带完整 source versions 的 effective grant；每次 acquire/checkpoint/finalize 都重新校验撤销、期限和目标。缓存失配只能失效，不能回写或自动续期来源授权。
5. Safe Execution 或其他调用方只消费本次 Workflow 返回的冻结 grant；业务结果仍由动作所属子系统写入。

## 3. Interface、Workflow 与事务

### 公开 Interface

每个子系统公开少量以业务能力命名的 Interface，统一使用领域 DTO 和稳定错误，不泄漏表行、SQLite connection、React state 或 Adapter SDK 类型。适用性矩阵如下：

- **查询 Interface**：校验适用的 Project/ownership scope、调用者能力、输入上限和稳定错误；不要求 operation/hash、expected version 或 lease。跨域批量报表优先进入 Operations Projection，而不是开放任意表查询。
- **写命令 Interface**：必须携带 operation ID 与覆盖完整意图的 request hash，并在命令/父聚合层携带一个可机械判定的并发前置。update/transition 使用 expected aggregate/state version；create 使用 `not-exists/0`，或由 owner 明确定义的 expected stream/head version。同 operation + hash 重放同一结果，同 ID 不同 hash 冲突。只有命令跨时间占有资源时才要求 lease。
- **事务内写命令 Interface**：只允许 Application Workflow 在既有 SQLite transaction boundary 内调用；它继承父命令的 operation/hash 与并发前置，并使用由外层 operation 派生、可稳定重放的 step identity。若该步骤独立修改另一个既有聚合，必须额外提供那个聚合的 expected aggregate/state version；若只追加不可变 child fact、operation outcome、receipt、audit/outbox envelope 等同事务派生记录，则这些记录不拥有也不伪造独立 expected version。事务内命令不得自行提交、开启外部调用或制造 lease；若工作跨时，必须退出事务并进入 acquire/checkpoint/finalize。
- **Port**：描述领域需要的持久化或外部能力，不是跨域命令入口；Adapter 实现 Port。Port 调用是否需要 operation/version/lease，取决于其所属命令而非“一律要求”。

只有两种情况建立 Interface：存在两个以上真实替换实现，或跨越明确的信任/所有权接缝。单一内部实现、无替换证据的 helper 不为“未来插件”提前端口化。

### 可执行依赖方向

命令路径固定为：

`入站 Adapter → Application Workflow → 领域 Capability Interface → 领域 Port ← 持久化/外部 Adapter`

查询路径可以是 `入站 Adapter → 领域 Query Interface`，或 `入站 Adapter → Operations Projection Query`；查询不得在返回前隐式发起命令。

允许/禁止矩阵：

- **入站 Adapter**：允许依赖 Workflow entry contract、领域 Query Interface 和稳定 DTO；禁止依赖领域 private、repository、SQLite connection 或外部 Adapter concrete。
- **Application Workflow**：允许依赖多个领域 Capability Interface、事务协调 Port 和稳定 DTO；禁止依赖 React/HTTP、具体 SQLite/Windows/Provider Adapter、领域 private 或 Operations Projection 来决定命令真相。
- **领域模块**：只允许依赖自身 private、共享的无业务 owner 基础类型和自身声明的 Port；禁止依赖 Workflow、任何 Adapter、Operations Projection 或其他领域模块。跨域所需事实由 Workflow 冻结后作为 DTO 传入。
- **持久化/外部 Adapter**：允许实现一个明确领域 Port，并依赖对应 Port contract 与外部 SDK；禁止调用领域命令、编排 Workflow、直接写其他 owner 的表或互相形成业务调用链。
- **Operations Projection**：允许消费公开事件并写自己的投影存储；禁止被领域模块依赖、发起业务命令、写 owner 表或参与强不变量裁决。
- **composition root**：只负责构造与注入 Workflow、Capability Interface 和 Adapter；禁止包含业务分支。

跨域命令只能由 Application Workflow 发起。领域 A 不直接命令领域 B，即使 B 暴露 public Interface；因此命令依赖图以 Workflow 为中心，不允许领域间环或 Workflow 回调 Adapter 后再进入另一领域的隐式环。

### Application Workflow

Application Workflow 表达一个跨 owner 的用户结果，例如：

- 接受 owner 目标：Project/成员资格检查 → Mission 建立 → Thread/Run 公开受理。
- 执行完成推进：Safe Execution finalize → Mission & Work 状态转换 → Public Collaboration 公开事实。
- 复核通过交付：Review 裁决 → Knowledge 候选/来源 → Delivery → Mission 完成。
- 审批后续接：Governance 裁决 → 原 owner Interface 重新检查版本与租约 → 执行动作。

Workflow 只拥有流程 operation、步骤/checkpoint 和补偿状态，不拥有被协调的领域事实。强不变量在一个 SQLite transaction boundary 内提交；外部调用不得长时间占用数据库事务，而应使用 acquire → 外部动作/安全点 checkpoint → finalize：

1. **acquire**：在短事务内验证 tuple、operation/version/lease、能力与预算，冻结输入并取得租约。
2. **checkpoint**：外部动作期间只记录有界、脱敏且可恢复的进度；每次继续前重新验证租约与取消状态。
3. **finalize**：在短事务内重新检查冻结来源、版本、租约和冲突，再原子写入终态、公开事实与 outbox。

## 4. 必须保留的强不变量

- **Project/Thread/Run tuple**：Thread、Run、Message、Block、Decision、Execution 来源及下游事实必须按完整 ownership tuple 查询和约束；跨 tuple 访问失败关闭。
- **Frozen Source Tuple**：Project、Thread、Run、Message 及适用来源实体/版本在动作开始时冻结；恢复、复核、投影和交付不得替换成 latest。
- **operation/version/lease**：每个写命令必须有幂等 operation/hash，并在命令/父聚合层声明并发前置：update/transition 使用 expected aggregate/state version，create 使用 `not-exists/0` 或 owner 定义的 expected stream/head version。不可变 child fact、operation、receipt、audit/outbox 等同事务派生记录继承父命令前置，不拥有虚构的独立 expected version。只有跨时间占有才使用 lease，单事务动作不得制造虚假长租约。
- **acquire/checkpoint/finalize**：所有跨进程、Provider、CLI、MCP 或长时工作都服从三阶段协议；崩溃恢复不得补造业务成功。
- **单一写 owner**：每张写表恰有一个 owner，只有 owner repository/transaction Interface 可写；首次发布前 canonical schema bootstrap 是受控生命周期入口，不成为第二个运行时业务 writer。
- **来源与历史不可变**：公开事实、复核裁决、交付、已完成 receipt 与来源版本不就地改写；变化通过新版本或新事实表达。
- **安全组合不降级**：verified-handle、sandbox、Approval、冲突检测、脱敏、审计和独立复核按动作风险组合适用；任何 Interface 或 Adapter 都不能旁路。

## 5. 事件、outbox 与投影

采用**选择性同库 outbox**，不采用全面事件溯源。

- owner 子系统在提交命令事实的同一 SQLite 事务中追加稳定的公开事件 envelope。
- 只有明确消费者的跨域通知、搜索、运维、用量、审计、时间轴和回放事件进入 outbox；内部实现步骤不因“可能有用”而公开。
- 事件包含 event identity、schema version、occurredAt、actor、完整适用 tuple、source version 和脱敏 payload；不含凭据、隐藏推理、原始 Provider 响应或私密原文。
- 消费者按 event identity 幂等处理并保存 checkpoint；投影可丢弃重建，重建不得调用命令 Interface 或产生业务动作。
- 命令查询以 owner 的当前事实/版本链为准。投影陈旧、失败或缺失只能显示 freshness/error，不能回写或伪造成业务失败。
- 需要监管级历史、任意时点重建或分叉的事实出现前，不把现有状态表改造成事件流。

## 6. Ports/Adapters 边界

目标 Adapter 分类：

- **入站 Adapter**：HTTP route、React server/client action、CLI 管理入口；负责传输限制、身份/项目上下文组装和错误映射，不包含领域决定。
- **持久化 Adapter**：SQLite repository、transaction、canonical schema bootstrap/validation、outbox；SQLite schema 是实现细节，但复合约束和原子性必须兑现领域不变量。首次发布前不保留版本间 migration。
- **工作区 Adapter**：Windows verified-handle、文件系统、Git、进程与本地预览；只实现 Safe Execution/Project & Workspace 所授予的窄能力。
- **模型与外部运行时 Adapter**：OpenAI-compatible Provider、原生 CLI/ACP、MCP；外部返回始终不可信，经严格 schema、大小、凭据和来源校验后才能成为业务事实。
- **通知与媒体 Adapter**：浏览器通知/PWA、未来受控语音；默认最小内容、显式同意、可撤销，不代替 Approval。

受控扩展端口只暴露领域允许的窄能力，不暴露数据库连接、任意文件路径、通用 shell、主密钥或进程内对象图。新增 Adapter 必须独立切片、声明权限、来源、版本、失败模式、撤销/卸载和审计方案；开闭原则不是安全协议的免审通行证。

## 7. 目标状态目录结构

目标目录把逻辑所有权落实为可机械检查的物理接缝。当前工程已完成架构收敛（第 9 节），本节结构即当前现实；后续产品功能必须直接落在目标结构上，不得在旧结构或目录外重建入口。`runtime` 与 `operations-projection` 尚无自有命令事实，按 A-101 不建空壳 Module，待对应 Capability 切片建立时再补目录。

```text
cool-ai/
├─ app/                                  # Next.js 入站 HTTP / 页面 Adapter
│  ├─ api/                              # route.ts：传输校验、上下文组装、错误映射
│  └─ ...                               # page/layout：只装配产品表面
├─ components/                           # React 入站 UI Adapter
│  ├─ shell/
│  ├─ collaboration/
│  ├─ mission/
│  ├─ execution/
│  ├─ review/
│  └─ shared/                           # 仅无领域所有权的 UI primitive
├─ src/
│  ├─ modules/                          # 长期稳定的逻辑子系统 Module
│  │  ├─ identity-capability/
│  │  ├─ project-workspace/
│  │  ├─ mission-work/
│  │  ├─ public-collaboration/
│  │  ├─ safe-execution/
│  │  ├─ governance/
│  │  ├─ review-delivery/
│  │  ├─ knowledge-provenance/
│  │  ├─ runtime/
│  │  └─ operations-projection/
│  ├─ application/
│  │  └─ workflows/                     # 跨 owner 用户结果与事务/补偿编排
│  ├─ adapters/
│  │  ├─ inbound/                       # 非 Next 入站：CLI、未来受控本机入口
│  │  └─ outbound/
│  │     ├─ sqlite/                     # repository、transaction、canonical schema、outbox
│  │     ├─ workspace/                  # Windows verified-handle、文件、Git、进程
│  │     ├─ model-runtime/              # OpenAI-compatible、CLI/ACP、MCP
│  │     └─ notification-media/         # 浏览器通知与未来受控媒体能力
│  ├─ composition/                      # composition root；只构造和注入
│  └─ shared/                           # 无业务 owner 的最小基础类型与工具
├─ tests/
│  ├─ modules/                          # 按逻辑 owner 分治的 Interface 行为测试
│  ├─ workflows/                        # 按命名用户结果分治的跨域测试
│  ├─ adapters/                         # 按技术接缝再按 owner/capability 分治
│  ├─ browser/                          # 按可演示垂直切片分治
│  ├─ architecture/                     # 全局 import、owner、writer、依赖图约束
│  └─ fixtures/                         # 按 owner 分治的确定性 fixture builder
├─ product/                             # 产品定义、目标架构、决策与待办
├─ features/                            # 垂直切片规格、架构、票据、评审与进度
└─ docs/adr/                            # 跨切片长期架构决定
```

### 子系统 Module 内部形态

每个 `src/modules/<module>/` 都采用同一最小骨架；目录名称表达角色，不要求每个可选目录都预先创建：

```text
src/modules/<module>/
├─ index.ts                             # 唯一对外导入入口，导出完整公开 Interface
├─ public/                              # 调用方必须知道的命令、查询、DTO、稳定错误
│  ├─ commands.ts
│  ├─ queries.ts
│  ├─ dto.ts
│  └─ errors.ts
├─ internal/                            # 聚合、政策、命令实现、查询实现与内部接缝
│  ├─ model/
│  ├─ commands/
│  ├─ queries/
│  └─ policies/
└─ ports/                               # 本 Module 声明的持久化/外部能力 Port
```

- `index.ts` 与 `public/` 共同构成一个小而完整的 Module Interface；其他 Module、Workflow 和入站 Adapter 不得深导入 `internal/` 或 `ports/`。
- `ports/` 只供本 Module 的 Implementation 和被授权的 outbound Adapter 使用，不是第二套跨域 Interface。不存在真实替换或信任接缝时不创建 Port。
- Module 私有类型不得进入 HTTP、React、SQLite、Windows 或 Provider SDK 类型；公开 DTO 只能引用本 Module 类型或 `src/shared/` 中无业务 owner 的基础类型。
- `operations-projection` 使用相同骨架，但其公开面只有投影查询、freshness 和重建管理 Interface；不得导出业务写命令。
- 禁止建立通用 `services/`、`repositories/`、`models/` 或 `utils/` 横切目录。无法确定 owner 的代码先视为架构发现项，不能以“shared”规避所有权。

### Workflow、Adapter 与装配形态

一个跨 owner 用户结果对应一个命名目录，而不是一个万能 Workflow：

```text
src/application/workflows/<user-result>/
├─ index.ts                             # 唯一 Workflow entry contract
├─ workflow.ts                          # 步骤、事务、checkpoint 与补偿
└─ dto.ts                               # 该用户结果的输入和输出
```

- Workflow 只依赖各 Module 的 `index.ts`、事务协调 Port 和无 owner 基础类型；不得导入 Module `internal/`、具体 Adapter、React/HTTP 或投影来裁决命令真相。
- `app/`、`components/` 和 `src/adapters/inbound/` 是入站 Adapter。HTTP route 不得成为业务目录：同一用户结果即使有多个 route，也必须汇入同一个 Workflow 或 Module Query Interface。
- `src/adapters/outbound/<technology>/<module-or-capability>/` 实现明确 Port。SQLite Adapter 必须按 owner 分目录；共享 connection、transaction、canonical bootstrap 和 validator 只能提供技术能力，不能包含领域分支。
- `src/composition/` 是唯一可同时看到 concrete Adapter 与 Interface 的生产代码位置。它可以按 Web、worker、CLI 入口拆文件，但不得包含业务条件、校验或状态转换。

### 测试与导入规则

测试目录采用“被测对象优先、owner 或用户结果次级分区”，不建立全仓 `unit/`、`integration/`、`e2e/` 三个彼此失去所有权的大桶：

```text
tests/
├─ modules/
│  ├─ identity-capability/
│  ├─ project-workspace/
│  ├─ mission-work/
│  ├─ public-collaboration/
│  ├─ safe-execution/
│  ├─ governance/
│  ├─ review-delivery/
│  ├─ knowledge-provenance/
│  ├─ runtime/
│  └─ operations-projection/
│     ├─ behavior/                      # 公开命令、查询、不变量与稳定错误
│     └─ contracts/                     # 可复用于 Adapter 的 Port contract suite
├─ workflows/
│  └─ <user-result>/                    # 原子性、重放、补偿、跨 owner 失败关闭
├─ adapters/
│  ├─ sqlite/
│  │  └─ <module>/                      # repository、bootstrap、重开与精确 schema
│  ├─ workspace/
│  │  └─ <capability>/                  # verified-handle、文件、Git、进程
│  ├─ model-runtime/
│  │  └─ <adapter>/                     # Provider、CLI/ACP、MCP
│  └─ notification-media/
├─ browser/
│  └─ <vertical-slice>/                 # 真实渲染、可访问性与用户结果验收
├─ architecture/
│  ├─ imports/
│  ├─ ownership/
│  ├─ writers/
│  └─ dependency-graph/
└─ fixtures/
   ├─ <module>/                         # 该 owner 的聚合和持久化 fixture builder
   └─ shared/                           # 仅 ID、时钟等无 owner 确定性基础设施
```

- 测试归属由主要被测 Interface 决定，而不是由使用了数据库、HTTP 或 React 决定。同一 Module 的纯行为与 SQLite 集成分别位于 `modules/<module>/` 和 `adapters/sqlite/<module>/`。
- 只有命名 Workflow 测试可以在一个场景中驱动多个 Module；Module 测试不得通过直接组装其他 Module 来模拟跨域业务。
- 每个垂直切片的浏览器目录只保留用户可观察验收和 axe 证据，不重复 Module/Workflow 已覆盖的状态组合。
- fixture builder 归事实 owner 所有；跨域测试组合多个 owner builder，但不得建立可任意写所有表的“万能数据库 fixture”。
- 测试文件名表达行为与接缝，例如 `answer-inline-decision.behavior.test.ts`、`sqlite-inline-decision.contract.test.ts`；不得继续使用无法判断 owner 的 `service.test.ts` 或按历史票号无限增长的聚合文件。
- Module 行为测试的被测入口与生产调用方相同，统一从 `src/modules/<module>/index.ts` 导入；只有 Module 自身的少量白盒测试可位于该 Module 内并访问内部接缝。
- Adapter 契约测试复用 Module 提供的 Port contract suite；不得 mock 被测 Module 来证明 Adapter 正确。
- 浏览器测试按可演示纵切组织，不镜像页面文件树；架构测试单独验证跨域 deep import、循环依赖、未知 writer 和未登记表。
- TypeScript path alias 只为公开入口和稳定顶层角色服务；不得为 `internal/`、`ports/` 或具体 Adapter 建立绕过规则的捷径。
- `src/server/`、按技术类别聚集的根级 `*-service.ts`，以及 route 内的跨域编排不属于目标状态；这些旧入口已随架构收敛删除，架构测试阻断其重新出现。

### 子系统目录完成判据

一个子系统（含未来新增 Module）只有同时满足以下条件，才视为符合目标目录：

1. 命令事实和写表清单登记唯一 owner，运行时写入只来自该 owner 的 Adapter。
2. 公开调用方只通过 Module `index.ts` 或命名 Workflow 进入，不存在跨域 deep import。
3. Interface 不泄漏技术类型，Module 内部不反向依赖 Workflow、Adapter 或其他 Module。
4. 公共行为、fresh bootstrap/exact reopen、operation/version/lease、tuple 与安全组合测试仍通过。
5. 架构测试能阻止旧写入口或禁止依赖重新出现；仅移动文件或增加 barrel export 不算完成。

## 8. 当前已实现

架构收敛已于 2026-08-09 完成（特性 019，PR #1；D-45 解除功能冻结）。当前工程即第 1～7 节描述的领域模块化单体：Next.js 16 / React 19 / strict TypeScript / SQLite 单仓，`src/server/` 已删除。

- **App Router 与 React 入站 Adapter**：页面/API 同仓，route 只做传输校验、上下文组装与错误映射；HTTP 共享助手归 `app/api/_shared/`（A-100）。证据索引：`app/api/projects/[projectId]/threads/route.ts`、`components/collaboration/collaboration-panel.tsx`、`components/project-context/mission-board.tsx`、`components/execution/execution-panel.tsx`、`components/review/review-product-surface.tsx`。
- **领域 Module 已按 8 个有事实 owner 的子系统收敛**：identity-capability、project-workspace、mission-work、public-collaboration、safe-execution、governance、review-delivery、knowledge-provenance，均为 `index.ts` + `public/{commands,queries,dto,errors}.ts` + `internal/` 骨架；公开调用只经 Module `index.ts` 或命名 Workflow。证据索引：`src/modules/public-collaboration/public/commands.ts`、`src/modules/safe-execution/index.ts`、`src/modules/governance/public/commands.ts`。
- **SQLite Adapter 按 owner 分治**：共享 connection、`CURRENT_SCHEMA` bootstrap/validator、数据不变量与 unit-of-work 只提供技术能力；repository 按 owner 分目录，canonical bootstrap 之外无未登记 writer。证据索引：`src/adapters/outbound/sqlite/current-schema.ts`、`src/adapters/outbound/sqlite/bootstrap-current-schema.ts`、`src/adapters/outbound/sqlite/validate-current-schema.ts`、`src/adapters/outbound/sqlite/sqlite-unit-of-work.ts`、`tests/adapters/sqlite/current-schema.test.ts`。
- **Application Workflow 与事务协调 Port 已显式化**：跨 owner 结果由命名 Workflow 编排；事务协调 Port 归应用层、SQLite 实现归 outbound Adapter（A-99）。证据索引：`src/application/workflows/create-mission/workflow.ts`、`src/application/workflows/project-context-snapshot/workflow.ts`、`src/application/unit-of-work.ts`、`tests/workflows/create-mission/`。
- **composition root 唯一装配**：concrete Adapter 与 Interface 的构造注入集中在 `src/composition/`，不含业务分支。证据索引：`src/composition/index.ts`、`src/composition/server-composition.ts`。
- **Safe Execution 边界保持**：Windows verified-handle、sandbox、Validation、Staged Change、Approval、冲突检查与 Merge 路径按 owner/技术接缝归位；`execution_approvals` 写 SQL 已提取为 Governance approval-store 能力。证据索引：`src/adapters/outbound/workspace/windows-verified-execution-adapter.ts`、`src/adapters/outbound/sqlite/safe-execution/execution-service.ts`、`src/adapters/outbound/sqlite/governance/approval-store.ts`、`tests/adapters/sqlite/safe-execution/execution-security-integration.test.ts`、`tests/modules/safe-execution/execution-approvals.test.ts`。
- **公开 Thread Fact 流与 S-12 tuple 已交付**：`collaboration_thread_facts` 由 current canonical schema 和唯一 writer seam 支撑，线程读取按 fact 分页。证据索引：`src/adapters/outbound/sqlite/public-collaboration/thread-fact-store.ts`、`tests/modules/public-collaboration/thread-fact-store.test.ts`、`tests/modules/public-collaboration/thread-history-api.test.ts`、`features/014-persistent-project-threads/progress.md`。
- **S-13 结构化消息代码在途、尚未 ship**：block/decision 持久化位于 public-collaboration owner 与其 SQLite Adapter，不能视为已交付 Capability；阶段与票据状态以 feature 记录为准。证据索引：`src/adapters/outbound/sqlite/public-collaboration/structured-message-store.ts`、`src/adapters/outbound/sqlite/public-collaboration/inline-decision-service.ts`、`src/modules/public-collaboration/internal/structured-message-schema.ts`、`features/015-structured-messages-inline-decisions/progress.md`。
- **机械约束已阻断化**：import 边界、写表 owner、运行时 writer、依赖图与测试分区检查已进入 `tests/architecture/` 并阻断回退。证据索引：`tests/architecture/imports.test.ts`、`tests/architecture/ownership.test.ts`、`tests/architecture/writers.test.ts`、`tests/architecture/dependency-graph.test.ts`、`tests/architecture/test-partition.test.ts`。
- **通用 outbox/Operations Projection 未交付**：收敛后扫描确认 `src/` 无 outbox 实现；`CAP-OPS-01/02` 保持规划中，由 S-23 拆分片按第 5 节建立。
- **第三方通用插件宿主未交付**：产品/ADR 继续禁止任意进程内插件；`CAP-RUN-04` 保持规划中，不能作为现有能力。

后续功能切片必须直接落在目标结构上：新命令事实先登记唯一 owner 与写表清单，跨 owner 结果新增命名 Workflow，禁止在 route 内重建编排、跨域 deep import 或绕过机械约束。

## 9. 架构收敛完成记录

目标架构收敛作为架构优先基础交付（ADR-0004）已于 2026-08-09 完成，用户同日确认解除功能冻结（D-45）。

- 全部生产代码与测试已迁入第 7 节目录；`src/server/`、根级 `*-service.ts`、route 内业务编排、兼容 re-export 与临时 alias 已删除，无长期双写、双事实 owner 或双 Interface 残留。
- 写表 owner 清单与 import/dependency/writer/测试分区架构检查已转为阻断并通过；冻结基线中的 Windows 环境性失败（A-102）不计入回归判据。
- 迁移保持公共行为、安全组合、错误 envelope、事务原子性与不可变历史不变；fresh bootstrap / exact reopen / 非法非空库失败关闭语义不变（ADR-0003）。
- 分波执行、过渡口登记与各波验证证据见 `features/019-architecture-convergence/progress.md`（T-01～T-15，PR #1）；过渡口已在收编波次删除。
- 后续约束：新功能切片不得重建已删除的旧入口形态；新增写表、Module、Workflow 或 Adapter 必须先满足第 7 节子系统目录完成判据与第 10 节机械约束，再进入 implement。

## 10. 建议的机械约束

- 维护 `write-ownership` manifest：每张非只读表恰有一个 owner；CI 检查未登记、重复 owner 和 canonical bootstrap 之外的非 owner SQL。
- 维护可执行 dependency manifest，逐类编码允许边：入站 Adapter → Workflow/Query Interface；Workflow → 领域 Capability Interface/事务协调 Port；Adapter → 被实现的领域 Port；composition root → 全部装配目标。未列出的边默认禁止。
- import-boundary/lint 必须禁止：领域 → Workflow/Adapter/Operations Projection/其他领域，Workflow → 具体 Adapter/领域 private，入站 Adapter → repository/SQLite，Adapter → 其他 owner 表或领域命令。
- 构建依赖图必须无领域间命令边、无跨域命令环；跨域 command handler 只能位于 Application Workflow，领域 public Interface 不能被另一领域直接调用。
- 对 SQL 做静态清单检查：除 owner repository 和 canonical schema bootstrap 外，禁止 `INSERT/UPDATE/DELETE` 目标表；bootstrap 只能建立 current schema，不能写业务事实，新表必须先登记 owner。
- 为 Interface 适用性矩阵建立契约测试：Query 不要求 operation/version/lease；每个写命令要求 operation/hash，并验证 update/transition 的 expected aggregate/state version 与 create 的 `not-exists/0` 或 expected stream/head version；事务内派生 child fact、operation、receipt、audit/outbox 必须证明继承父命令前置且拒绝独立伪造 expected version；独立修改第二聚合时必须验证第二聚合 expected version；只有跨时占有路径要求 lease，并验证 tuple 与回滚原子性。
- 对公开事件做 schema/version、脱敏、outbox 原子提交、重复消费和从零重建测试。
- 对 acquire/checkpoint/finalize 建立崩溃点与重启对账测试，证明不会重复外部动作或伪造成功。
- 对 Project/Thread/Run 与 Frozen Source Tuple 建立数据库复合约束和 tuple-scoped 查询测试。
- 对 Adapter 建立能力/权限清单和架构测试，禁止数据库连接、主密钥、任意 host path 或通用 shell 穿过 Port。
- 对 Operations Projection 建立只读约束：投影代码不能链接命令 repository，重建过程不能写业务 owner 表。
- 首次发布前 storage lifecycle 只允许 atomic/idempotent fresh bootstrap、current exact-schema validation 和 drift fail-closed；禁止版本间 migration、legacy adoption 与 backfill。

## 11. 关键场景（垂直切片判据）

以下端到端路径是切片准入与验收的共同判据。每个进入 implement 的切片必须声明自己推进哪条路径的哪一段，沿路径上的 owner 顺序走公开 Interface 或命名 Workflow，不得旁路。

1. **组队与立项**（已交付 S-1～S-3）：owner 配置并验证 Provider、创建 Agent/Skill（Identity & Capability）→ 创建 Project、绑定工作区、组成项目组（Project & Workspace）→ 建立 Mission 与 Work Item（Mission & Work）。对应 Workflow：`create-mission`。
2. **公开协作接力**（已交付 S-4、S-12）：owner 在 Thread 公开发言/@Agent → Collaboration Run 受理、Turn/Attempt、结构化交棒与 owner 决策请求/回答（Public Collaboration）→ 暂停/恢复与可恢复时间线。治理点：凭据拒绝、Project/Thread/Run tuple、预算与轮次上限。
3. **受控执行与合入**（已交付 S-5）：Resolve Effective Runtime Grant（配置权限 ∩ 项目范围 ∩ Approval → Runtime 投影，第 2 节）→ Safe Execution acquire/checkpoint/finalize → sandbox 内工具动作与验证 → Staged Change 冲突/陈旧检查 → Merge Journal 原子合入或失败关闭。
4. **独立复核与交付**（已交付 S-6）：owner 显式发起、合格非执行者 Agent 复核裁决（Review & Delivery）→ 署名记忆候选沉淀（Knowledge & Provenance）→ Delivery 持久化 → Mission 完成门槛判定（Mission & Work）。
5. **脱敏运维读侧**（规划中，S-23 拆分片建立）：source owner 在命令事务内提交公开事件 envelope → Operations Projection 幂等消费、checkpoint/rebuild 与 freshness → owner 只读查询并跳回精确来源；投影永不回写命令事实（第 5 节）。

## 12. 横切约定

只写约定与链接，字段级细节归各特性规格与 Module 公开契约。

- **错误**：公共错误使用稳定、脱敏 envelope；不得返回原始异常、Provider 响应、提示词、凭据、宿主路径或隐藏推理（`AGENTS.md` 契约标准；各 Module `public/errors.ts`）。
- **身份与授权**：本地优先、单 owner、无登录；授权按第 2 节权限事实四分转换，不存在通用 `grant`；高风险动作必须经 Governance Approval，卡片点击或通知不等于批准。
- **持久化**：首次发布前只支持唯一 current canonical schema 的空库原子 bootstrap 与 exact reopen，其余失败关闭（ADR-0003、`CONTEXT.md`）；不保留版本间 migration 与 backfill。
- **观测**：服务健康、用量、审计、时间轴与回放只经 Operations Projection 只读投影（第 5 节）；投影缺失或陈旧显示 freshness/error，不伪造成业务状态。
- **安全**：verified-handle、sandbox、Approval、脱敏、审计与独立复核按动作风险组合适用（第 4 节；`product/product.md` 设计原则 6）；任何 Interface 或 Adapter 不得旁路。
- **可访问性**：关键交互覆盖 loading/empty/error/disabled/success/focus，语义化 HTML、键盘操作、≥44×44px 控件、WCAG AA 并以 axe 验证受影响界面（`AGENTS.md` UI 标准）。
