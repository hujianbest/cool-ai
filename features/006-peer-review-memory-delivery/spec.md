# 同伴复核、记忆沉淀与结果交付需求规格

- 日期: 2026-08-01
- frame: ./frame.md

## 1. 背景与问题

S-3 已建立使命看板和带来源、可追溯修订的目标、决策、事实、产物记忆；S-4 已形成真实模型协作、结构化交棒和完整公开时间线；S-5 已让 Agent 在隔离执行后形成验证结果、产物和待复核的已合入结果，但任务仍保持“进行中”，使命也不能据此宣告完成。

当前缺口是完成权仍未闭环：执行者不能自行证明任务完成，owner 也没有一份把逐任务裁决、验证证据、产物、共享记忆和最终结论连起来的交付结果。若没有独立复核、完成门槛和持久审计，团队可能把未验证、已过期或自我批准的结果当成完成；关键知识仍会散落在执行记录中，并在重启后难以追溯。

S-6 要让项目内非执行者 Agent 基于现有任务、执行结果和公开证据逐项裁决“退回、升级或通过”；只在通过后沉淀有来源、去重且可追溯版本的共享记忆，并在所有任务满足最终门槛后向 owner 交付可审计摘要与证据。

## 2. 目标与成功标准

- 每个有待复核执行结果的子任务都由符合资格、且独立于该结果执行者的项目 Agent 作出唯一有效裁决：退回、升级或通过。
- 退回产生可执行的返工要求且不完成任务；升级形成明确的 owner 待决事项且不完成任务；通过把复核结论、任务状态和知识沉淀闭合为一个一致结果。
- 使命只有在全部子任务均经独立复核通过、无待返工或待升级事项、共享记忆沉淀完成且最终交付可生成时，才可显示最终完成。
- 目标、决策、事实、产物四类既有记忆继续可用，并新增经验记忆；S-6 自动沉淀的决策、事实、产物和经验均有可追溯来源，不产生相同内容与来源的重复 active 条目，修订保留历史版本。
- owner 能查看最终摘要、逐任务裁决、关键改动/产物、验证证据和共享记忆引用；刷新或应用重启后，完整历史、来源和关联保持可追溯。
- 桌面和窄屏均能完成复核、返工/升级处理、最终交付查看；关键交互覆盖 loading、empty、error、disabled、success、focus，并满足既有可访问性要求。

## 3. 范围

### 范围内

- 待复核任务的资格判定、独立复核分派和复核所需公开上下文。
- 非执行者 Agent 对每个子任务作出退回、升级或通过裁决，并记录理由、发现和证据引用。
- 退回后的返工闭环、升级后的 owner 决策闭环，以及新结果的再次独立复核。
- 子任务通过、任务完成和使命最终完成的确定性门槛。
- 目标、决策、事实、产物、经验五类带来源共享记忆；S-6 对决策、事实、产物、经验的受控沉淀、去重和版本历史。
- owner 最终交付摘要、逐任务结果、产物和验证证据索引。
- 复核、记忆和交付操作的幂等、并发冲突、失效结果、重启恢复与完整公开审计。
- 协作驾驶舱中的桌面/窄屏复核、记忆和最终交付体验及可访问性状态。

### 范围外

- 多人账号、邀请、角色权限或真人之间的审批流；首版仍是本地单 owner。
- 外部消息频道、自动发布、部署或向项目工作区之外发送交付结果；这些动作仍受既有 owner 审批和安全边界约束。
- 允许执行者复核自己的结果、由固定 leader 自动批准，或让平台充当隐藏的业务裁决者。
- 从原始聊天、隐藏思维链或无来源自由文本中无筛选地生成长期记忆。
- 修改 S-5 的隔离、路径、命令、审批、验证、合入和人工恢复安全保证；S-6 只消费其公开且已持久化的结果与证据。
- 新增并行执行规模、跨项目复核、多人共识投票、复核者声誉/评分、知识搜索或跨项目记忆。
- 云端托管、移动端完整编辑、无人值守定时复核或应用重启后自动后台续跑。
- 物理删除历史复核、记忆版本、证据或审计事件；错误知识通过新版本取代并保留历史。

## 4. 功能需求

### 4.0 互斥状态与当前有效关系

- 每个 result version 在任一时刻只有一个当前复核状态：`待复核`、`复核中`、`待返工`、`待 owner`、`已通过`、`已被新版本取代`。`待返工`只能来自退回或 owner 要求返工/补证；`待 owner`只能来自升级；`已通过`只能来自合格 review Agent 的通过裁决；新 result version 成为当前版本时，旧版本只读并转为`已被新版本取代`。
- 每个 review attempt 只针对一个冻结 result version 和一份冻结公开材料，且状态互斥为`复核中`、`退回终态`、`升级终态`、`通过终态`、`无裁决失败`或`无裁决中断`。三个业务终态各自恰有一个同名裁决；失败/中断终态没有业务裁决且永不后补，owner 显式重试创建新 attempt。
- 同一 result version 在任一时刻至多一个 current review attempt。升级终结当前 attempt 并使 result 进入`待 owner`；owner 回答不能改写该 attempt，必须使原 result 回到`待复核`并创建新 attempt，或在材料变化时先产生新 result version 再创建新 attempt。
- 每个 work item 在任一时刻只有一个当前完成状态：`执行中`、`待复核`、`复核中`、`待返工`、`待 owner`、`已通过完成`。既有看板“完成”只可对应`已通过完成`；其他状态都保持未完成，且 owner、Agent、平台、客户端、旧写入口和重放均不能直接越过复核门槛。
- 每个 mission 在任一时刻只有一个当前状态：`进行中`、`交付生成中`、`已完成`、`owner 终止`。全部 work item 为`已通过完成`只使使命有资格进入`交付生成中`；当前交付完整持久化后才进入`已完成`。交付生成失败回到带失败原因且可显式重试的`进行中`，不撤销仍有效的任务通过裁决。
- 一个任务/使命/交付版本只能有一个 current effective state；旧 result、review attempt、裁决、交付和记忆版本始终只读可追溯，不与新版本共同冒充当前有效结果。

### FR-1: 只允许合格且独立的 Agent 复核任务结果
- 优先级: 必须
- 描述: owner 显式发起复核并从具备复核能力的独立项目 Agent 中选择复核者；平台不暗选，任何非 Agent actor 都不能伪造裁决。
- 验收标准:
  - Given 一个子任务有当前待复核 result version When owner 打开复核入口 Then 候选只包含项目当前成员中不是该 result 执行者、且角色或技能配置明确具备 review 能力的 Agent，并清楚显示资格依据、执行者与候选身份。
  - Given 恰有一名合格候选 When owner 发起复核 Then owner 仍须确认该候选后才开始真实 Agent 调用；平台不得仅因候选唯一而静默发起。
  - Given 有多名合格候选 When owner 尚未选择 When 查看或提交入口 Then 不存在默认复核者，发起操作 disabled 且平台不得按顺序、负载或隐藏规则暗选；When owner 选择一名并确认 Then 只为所选 Agent 创建当前 review attempt。
  - Given 某 Agent 是该待复核结果的执行者 When 该 Agent 尝试领取、提交或重放复核裁决 Then 请求被拒绝，结果、任务状态和记忆均不改变，审计记录自复核拒绝。
  - Given 复核者在裁决前离开项目、失去 review 能力、被识别为该结果执行者，或待复核结果已被替换 When 提交裁决 Then 裁决因资格或上下文失效被拒绝，不得沿用旧资格。
  - Given 项目只有执行者而没有其他当前成员 When 查看复核入口 Then 显示“缺少独立复核者”的阻断原因，所有裁决操作 disabled，任务不能完成。
  - Given owner、平台、客户端或未被选中的 Agent 尝试直接提交带 Agent 身份的裁决 When 校验 Then 请求被拒绝且伪造裁决、任务状态和记忆的新增数为 0。

### FR-2: 选定 Agent 通过真实 provider 读取冻结公开复核材料
- 优先级: 必须
- 描述: 选定 review Agent 使用自己的已验证 provider 读取与当前 result version 绑定的冻结公开材料，平台与客户端不能用 fixture 或人工裁决冒充真实复核。
- 验收标准:
  - Given owner 已选择合格 Agent 并确认发起 When review attempt 开始 Then 产生该 Agent 自身已验证 provider 的真实调用；冻结材料包含当前使命/任务及依赖版本、执行者、result version、公开变更/产物、验证版本与结论、相关公开审计事实及来源引用。
  - Given review attempt 正在运行 When owner 查看详情 Then 可见所选 Agent、provider/model 的非敏感身份、冻结 result/material 版本、调用状态和 usage 状态，且 work item 显示`复核中`。
  - Given 证据包含失败、截断、过期、缺失或无法读取的验证/产物 When 展示复核材料 Then 这些状态被明确标注，不得伪装为通过或完整内容。
  - Given 任务、依赖、result、validation、artifact 或相关共享上下文在复核开始后变化 When provider 结果返回 Then 当前 attempt 标记失效且不提交裁决；owner 必须基于最新冻结材料显式发起新 attempt。
  - Given 复核材料为空或待复核结果尚未可靠持久化 When 请求开始复核 Then 不调用复核 Agent，不创建裁决，并显示缺少的材料类别。
  - Given 复核材料被持久化、展示或用于 Agent 上下文 When 扫描内容 Then 不包含 API key、Authorization、主密钥、凭据密文、原始 provider 请求/响应、未脱敏环境值或隐藏思维链。

### FR-3: 真实 review Agent 产生结构化公开输出和三选一裁决
- 优先级: 必须
- 描述: 每个成功 review attempt 必须由被选 Agent 返回结构化公开结论，并且恰有一个退回、升级或通过裁决。
- 验收标准:
  - Given provider 返回合法结构化公开输出 When 提交成功 Then 输出包含公开摘要、发现、证据引用、记忆提议和且仅一个退回/升级/通过裁决，并唯一关联项目、使命、任务、result version、review attempt、review Agent 与冻结材料版本。
  - Given 输出包含多个裁决、没有裁决、公开理由为空、unknown 业务动作、证据引用不属于冻结材料或记忆提议缺少来源 When 校验 Then 整个 attempt 失败且无裁决，任务、result、记忆和交付均不发生部分变更。
  - Given provider 认证/网络/超时失败、输出格式无效或 usage 缺失/不一致 When attempt 结束 Then owner 可见失败类别与已确认 usage 状态，result 回到`待复核`，旧 attempt 只读且无裁决。
  - Given 上述失败或应用中断 When owner 未操作 Then 不静默重放；When owner 点击显式重试 Then 创建新的 provider/review attempt，继承同一当前 result 但重新冻结当前公开材料，既有 attempt/usage/错误不被覆盖或重置。
  - Given owner、平台或客户端构造与合法结构相同的 payload 但没有选定 Agent 的真实调用结果 When 提交 Then 不得形成 Agent 裁决。
  - Given 查看任一已处理任务 When 展开历史 Then 能按稳定顺序区分每次 provider/review attempt 的 Agent、冻结版本、调用/usage 结果、唯一裁决或“无裁决失败”，以及当前 effective state。

### FR-4: “退回”产生明确返工闭环且不完成任务
- 优先级: 必须
- 描述: review Agent 退回时，当前 attempt 终结，旧 merged execution/result 永久只读，work item 明确进入`待返工`并可产生新 result version。
- 验收标准:
  - Given 合格 review Agent 发现结果不满足任务或验证要求 When 裁决“退回” Then 当前 review attempt 以退回终结，当前 result 进入`待返工`，work item 明确显示`待返工`及返工要求，既有 merged execution/result、验证、产物和裁决全部只读。
  - Given 任务有未解决的退回事项 When 尝试把任务或使命标记完成 Then 操作被拒绝并列出未解决返工项。
  - Given work item 处于`待返工` When owner 按返工要求再次启动执行 Then 允许为同一任务创建新的 execution；When 新 execution 合入 Then 产生新的 result version 并成为当前`待复核`结果，旧 result 标记被新版本取代且保持只读。
  - Given 返工尚未产生新的 result version When 查看任务 Then 不提供再次复核或通过入口，也不把旧 result 恢复为待复核。
  - Given 新 result version 已产生 When 发起再次复核 Then 必须重新判断非执行者与 review 能力，旧 review Agent 只有在不是新 result 执行者且仍具能力时才可再次被 owner 选择。
  - Given 退回提交与执行结果更新并发发生 When 两者竞争 Then 旧版本上的退回不得覆盖较新的结果，失败方获得明确冲突并可刷新。

### FR-5: “升级”暂停完成并向 owner 形成唯一待决事项
- 优先级: 必须
- 描述: review Agent 升级时，当前 review attempt 以升级裁决终结，result 进入`待 owner`但尚无最终通过/退回；owner 回答后必须走新的 review attempt。
- 验收标准:
  - Given review Agent 发现需求歧义、风险越界、证据不足或需要 owner 取舍 When 裁决“升级” Then 当前 attempt 以升级终结，result 和 work item 唯一显示`待 owner`，owner 看到问题、可选方向或所需补充、理由、证据和提出者；该 result 尚未最终通过或退回。
  - Given 某任务已有未解决升级事项 When 同一结果再次提交升级 Then 系统返回既有待决事项或明确冲突，不创建重复 open 事项。
  - Given owner 回答后 result、validation 和 artifact 未变化，只有带版本的 owner 回答加入公开复核上下文 When 继续复核 Then 原升级 attempt 保持终态，原 result 回到`待复核`，owner 必须选择合格 Agent 创建使用新冻结材料的 review attempt，不能给原 attempt 添加第二裁决。
  - Given owner 回答要求返工或补充/替换证据 When 回答生效 Then work item 进入`待返工`，旧 merged execution/result 与升级 attempt 只读；返工或补证必须通过新的 execution/提交形成新的 result version，之后才能创建新 review attempt。
  - Given 所谓“补证”没有形成新的 result version When 尝试再次复核或通过 Then 请求被拒绝，避免在旧 result 上无痕更换材料。
  - Given owner 明确终止使命 When 回答升级事项 Then 记录为`owner 终止`而非复核通过或使命成功完成。
  - Given owner 的回答试图直接把任务标记为独立复核通过 When 提交 Then 请求被拒绝；通过仍需合格非执行者针对当前结果作出。
  - Given 升级已回答、任务结果已变化或事项已关闭 When 重复或并发回答 Then 最多一个回答生效，其余返回原结果或明确冲突，历史不被覆盖。

### FR-6: “通过”一致地完成当前任务结果
- 优先级: 必须
- 描述: 只有合格复核者对当前未失效结果作出通过，且该任务没有未解决返工/升级事项时，任务才能完成。
- 验收标准:
  - Given 当前结果已合入、证据可读、复核者合格、依赖仍完成且没有未解决事项 When 裁决“通过” Then 裁决、结果通过状态、任务完成状态和该次通过所要求的记忆关联形成一个一致的可观察结果。
  - Given 通过所需的任一裁决、任务更新或记忆沉淀失败 When 操作结束 Then 不得出现“任务已完成但裁决/记忆缺失”或“记忆已沉淀但通过未成立”的部分成功。
  - Given 结果已退回、已被新结果替换、已失效、仍处于人工恢复，或必需验证不再有效 When 尝试通过 Then 请求被拒绝，任务保持未完成。
  - Given 任务已有一个有效通过裁决 When 另一复核者并发提交不同裁决 Then 最多一个最终裁决生效，失败方看到已生效裁决且不能覆盖。
  - Given 已通过任务的依赖被合法重新打开、任务材料变化或新返工被创建 When 状态生效 Then 原通过裁决和 result 保持只读但不再 current effective，任务回到未完成的相应状态，关联使命与当前交付立即失效；新完成必须基于新 result version 重新独立复核。

### FR-7: 使命最终完成有不可绕过的确定性门槛
- 优先级: 必须
- 描述: 使命成功完成必须由全部子任务的独立通过、知识沉淀和最终交付就绪共同决定，不能由单个 Agent 自报完成。
- 验收标准:
  - Given 使命至少有一个子任务，且每个子任务的当前结果均由合格非执行者通过、状态为完成、无未解决返工/升级/人工恢复事项，相关记忆关联完整且最终摘要与证据可生成 When 系统评估完成条件 Then 使命可进入`交付生成中`；只有唯一 current 交付完整持久化后才进入`已完成`。
  - Given 任一任务没有当前待复核结果、未复核、被退回、升级待答、返工中、结果失效、证据缺失或记忆沉淀未完成 When 评估 Then 使命不得显示成功完成，并逐项指出阻断任务与原因。
  - Given 使命没有子任务 When 尝试完成 Then 请求被拒绝，不允许以空集合宣告成功。
  - Given 所有任务通过后其中一个任务被合法重新打开 When 重新评估 Then 当前最终完成状态失效，旧交付保留历史标记，新最终交付须待全部门槛再次满足。
  - Given 任一调用既有 owner 看板写入口、Agent 动作、旧客户端请求、内部平台动作或 operation replay 试图把未处于`已通过完成`的任务改为完成 When 校验 Then 全部被同一完成门槛拒绝，任务/result/review/记忆状态不变。
  - Given 任一既有或新增入口试图在任务未全部通过、当前交付未完整生成时把使命写为完成 When 校验 Then 请求被拒绝；重放也只能返回原拒绝或原已完成结果，不能绕过门槛。
  - Given 应用在任务通过、使命资格评估或完成状态写入之间重启 When 恢复 Then 只根据持久的 current result/review/memory/delivery 关系重建唯一状态，不从旧看板“done”或客户端缓存推断完成。
  - Given owner 终止使命 When 查看结果 Then 明确显示“已终止”及原因，不生成或冒充成功交付。

### FR-8: 共享记忆支持既有四类和经验类并要求来源
- 优先级: 必须
- 描述: 共享记忆保留目标、决策、事实、产物四类并新增经验类；S-6 候选由实际 review Agent 提议并署名、由该 Agent 的裁决确认，平台只验证和持久化。
- 验收标准:
  - Given review Agent 识别出关键决策、事实、产物或经验 When 返回结构化记忆提议 Then 每项显示类型、正文、提议者 Agent、确认该提议的 review attempt/裁决，以及精确 source type、source id、source version。
  - Given review Agent 裁决通过且记忆提议有效 When 完成通过 Then 每个被确认条目按对应类型进入同项目共享记忆；业务作者显示该 review Agent，确认者显示关联通过裁决，平台仅显示为持久化 actor 而不冒充提议者或确认者。
  - Given 某一类别在该任务中没有可证实的新内容 When 复核完成 Then 不为凑齐类别生成空白、猜测或占位记忆；复核记录能说明该类别没有新增。
  - Given 目标类既有记忆存在 When S-6 沉淀任务知识 Then 目标记忆继续可读和可修订，但不会仅因任务通过而复制使命目标。
  - Given 候选记忆缺少正文、review Agent、确认裁决、source type/id/version，或来源已失效/跨项目 When 尝试沉淀 Then 该任务通过不能完成，UI 指出具体无效条目。
  - Given 来源绑定 task、result、review、validation 或 artifact When owner 查看记忆 Then 可导航到被绑定的历史实体及精确版本；后来出现同类型新版本时，旧记忆来源仍指向原版本而不漂移。
  - Given 既有 owner 创建的目标、决策、事实或产物条目 When 与 S-6 Agent 条目共同展示 Then owner 条目继续显示 owner actor 与既有来源语义，Agent 条目显示提议/确认/platform 三类责任，二者都可参与 active/history 展示且不被改写作者。

### FR-9: 记忆沉淀去重并保留版本历史
- 优先级: 必须
- 描述: 重复复核或重试按确定的可观察等价规则复用 active 记忆；取代必须显式选择唯一 active 前版，历史链保持可追溯。
- 验收标准:
  - Given 同一项目内已有 active 条目 When 候选的类型、去除首尾空白后的正文、source type、source id 和 source version 全部逐项相等 Then 返回并关联既有条目，不创建第二个 active 副本。
  - Given 两段正文仅首尾空白不同 When 比较去重身份 Then 视为相同；Given 正文内部 Unicode 字符/code point、空白、大小写或规范等价形式有任何差异 When 比较 Then 保持原样并视为不同，不做大小写折叠、Unicode 规范化或相似度合并。
  - Given source type/id 相同但 source version 不同，或 source version 相同但 id/type 不同 When 沉淀 Then 视为不同来源，不复用旧条目。
  - Given review Agent 确认新知识取代旧知识 When 提议 supersedes Then 必须显式指向同项目、同类型且当前唯一 active 的前版；成功后新条目 active、旧条目历史，默认上下文只读取新版本。
  - Given 新内容只是补充、类型不同、没有显式 supersedes、目标已是历史失效版本，或目标不是同类型唯一 active 前版 When 沉淀 Then 不得自动替代；合法补充创建独立 active 条目，非法取代整体拒绝。
  - Given 两个并发通过操作尝试创建同一条记忆或取代同一 active 版本 When 提交 Then 最多产生一个 active 新版本，另一操作关联胜者或返回冲突，不形成分叉、环路或两个 active 副本。
  - Given owner 查看历史记忆 When 展开版本 Then 能看到从旧到新的稳定顺序、每版来源、关联裁决和 active/历史状态，任何版本不被物理删除。

### FR-10: owner 获得最终摘要和可核对证据
- 优先级: 必须
- 描述: 使命满足最终完成门槛后，owner 能获得一份面向交付的摘要，并可追溯到逐任务复核、产物、验证和记忆。
- 验收标准:
  - Given 使命首次满足 FR-7 的任务门槛 When 开始生成最终交付 Then 使命显示`交付生成中`而不是`已完成`；When 交付完整持久化 Then owner 看到使命结论、完成时间、逐任务执行者与复核者/裁决、关键改动或产物、验证结论、关键决策/事实/产物/经验记忆引用，以及未消除的已知限制，使命才显示`已完成`。
  - Given owner 从摘要选择某个任务、证据、产物或记忆引用 When 打开 Then 到达与摘要所指版本一致的公开详情，而不是当前同名但不同版本的内容。
  - Given 某项证据失败、截断、过期或缺失 When 最终门槛评估 Then 不能把它表述为通过；若它属于必需证据则阻止交付，否则摘要明确标注其状态和影响。
  - Given 使命尚未满足最终门槛 When owner 查看交付区 Then 显示缺失项和当前进度，不展示虚构的“最终完成”摘要。
  - Given 最终交付生成或持久化失败 When 操作结束 Then 任务通过裁决和记忆保持有效，使命不显示`已完成`且不存在部分 current 交付；owner 可见失败并可显式重试。
  - Given owner 对同一任务/裁决/记忆版本集合显式重试交付生成 When 成功 Then 只产生一个 current 交付；相同重试返回该交付，不重复生成历史版本。
  - Given 交付生成失败后应用重启 When owner 重新打开项目 Then 仍显示可重试的交付失败/未完成状态和原通过任务，平台不自动生成；owner 显式重试后才再次尝试。
  - Given 最终完成随后因任务重新打开而失效 When owner 查看历史 Then 旧摘要保持只读并标注已被后续版本取代，当前区不再把它展示为有效最终交付。

### FR-11: 所有复核、记忆和交付变更可幂等重试并抵抗并发失效
- 优先级: 必须
- 描述: 客户端重试、并发复核和迟到结果不得重复提交或覆盖较新事实。
- 验收标准:
  - Given 同一逻辑变更以相同操作标识和相同内容重发 When 服务处理 Then 返回第一次的持久结果，review/provider attempt、裁决、任务状态、升级事项、result version、记忆和交付副作用各最多发生一次。
  - Given 同一操作标识携带不同任务、结果版本、裁决、记忆或回答内容 When 服务处理 Then 返回冲突且不执行新内容。
  - Given owner 的两个客户端并发选择不同合格 Agent 发起同一 result 的复核 When 提交 Then 最多一个 Agent 成为 current reviewer 且最多一个 current review attempt 开始，另一方获得可刷新的冲突。
  - Given 两名合格复核者并发返回同一 result 的裁决 When 提交 Then 只有 current review attempt 的一个裁决可生效；另一方获得可刷新的冲突且其内容不部分落盘。
  - Given 复核 Agent 调用在 owner 改变任务/结果/上下文、暂停/终止使命或有效占用过期后才返回 When 迟到结果到达 Then 只记录公开的中断/失效事实，不提交裁决、任务完成、记忆或交付。
  - Given 一次通过在任一原子边界前失败 When owner 重试 Then 只能从已持久化事实继续，不重复调用已经确认完成的外部动作，也不猜测未确认动作成功。

### FR-12: 刷新和重启后完整历史可恢复且不自动续跑
- 优先级: 必须
- 描述: 复核、返工、升级、记忆和交付均为持久事实；重启恢复只重建可观察状态，不静默重放 Agent 或变更动作。
- 验收标准:
  - Given 任意复核已开始、调用失败、待 owner 回答、待返工、已通过、交付生成失败或最终交付已生成 When 页面刷新或应用重启 Then 相同任务、result version、current effective state、review/provider attempt、冻结材料、裁决、升级回答、记忆版本、摘要和证据关联仍可读取。
  - Given 应用在复核 Agent 调用或通过提交结果持久化前中断 When 重启 Then 对应动作显示 interrupted、in-progress 且占用仍有效，或明确失败/待重试；不得自动再次调用 Agent 或重复提交。
  - Given owner 没有打开项目或明确继续 When 重启后存在未完成复核或升级事项 Then 平台不在后台自动继续复核、返工、回答或生成最终交付。
  - Given 历史包含多轮退回、升级、回答、补证、新 result version、通过、依赖重开、交付生成失败/重试和交付失效 When 重启后读取 Then 顺序、actor、来源、版本、互斥状态和 current 标记与重启前一致。
  - Given 持久状态之间出现无法解释的不一致 When 读取 Then 系统失败关闭并显示可审计错误，不推断任务或使命已经完成。

### FR-13: owner 可审计全部公开事实且系统不保存或展示 CoT
- 优先级: 必须
- 描述: owner 能按稳定顺序追溯复核到交付的公开事实，同时敏感凭据、原始模型载荷和隐藏思维链不进入产品域。
- 验收标准:
  - Given 复核资格判断/owner 选择、冻结材料读取、Agent/provider 调用、usage、裁决、返工/补证、新 result version、升级/回答、任务状态、记忆提议/确认/持久化/取代、完成门槛或交付生成/失败/重试发生 When 读取审计历史 Then 每项包含稳定顺序、公开 actor、项目/使命/任务/result/review 关联、时间、结果类别和必要版本/证据引用。
  - Given 某动作被拒绝、重放、并发冲突、中断或因旧上下文丢弃 When 查看历史 Then 明确显示对应结果，不伪装成新的成功动作。
  - Given Agent 提供复核理由 When 持久化和展示 Then 只保留面向 owner 的结论、发现、证据引用和行动建议，不要求、不保存、不展示隐藏思维链。
  - Given 产品响应、持久记录、页面、日志、截图或最终交付被扫描 When 查找 API key、Authorization、主密钥、凭据密文、原始 provider 请求/响应、未脱敏环境值或隐藏思维链 Then 匹配次数为 0。
  - Given owner 查看被取代或失效的历史 When 展开 Then 历史保持只读且带状态，不允许无痕修改或物理删除。

### FR-14: 桌面与窄屏完整呈现复核、记忆和交付状态
- 优先级: 必须
- 描述: owner 在协作驾驶舱内能查看和操作复核闭环；桌面与窄屏均覆盖完整异步状态、焦点和键盘路径。
- 验收标准:
  - Given 桌面宽度且多个任务处于不同复核状态 When 打开项目 Then owner 能同时辨认任务、执行者、合格候选/已选复核者、result version、review attempt、裁决/阻断、证据与最终完成进度，并能在看板、复核、共享记忆和交付之间保持关联。
  - Given 窄屏 When 打开复核材料、升级事项、记忆历史或最终证据 Then 一次只出现一个主要覆盖区域；关闭后焦点返回触发控件，且 owner 能完成查看、回答和重试主路径。
  - Given 候选列表、复核材料/调用、记忆、升级事项或交付正在加载、加载完成但为空、或加载/调用失败 When UI 展示 Then 分别提供 loading、empty、error 与可执行恢复动作，不提前把 loading 显示成 empty。
  - Given 裁决条件未满足、操作进行中、复核者不合格、上下文过期或使命尚有阻断 When 展示操作 Then 对应按钮 disabled 并给出可感知原因，不只依赖颜色。
  - Given owner 选择 Agent 并发起、显式重试、裁决、回答升级、记忆沉淀或最终交付成功 When UI 更新 Then 以非打断方式宣告 success，并把焦点移到新结果标题或保持在可继续工作的合理位置。
  - Given 保存或提交失败 When owner 修复并重试 Then 未提交的理由、发现、选择和回答草稿不被清空；字段错误与对应控件语义关联。
  - Given owner 仅使用键盘和辅助技术 When 完成桌面或窄屏主路径 Then 所有交互可达、焦点可见、弹层焦点受控且可恢复，状态/Agent/裁决不只用颜色表达，文本对比度和触控目标满足 NFR-4。

## 5. 非功能需求

### NFR-1: 完成一致性、独立性与幂等
- 要求: 每个 result version 的 current review attempt 数≤1；每个成功 review attempt 的三选一裁决数=1，失败/中断 attempt 的业务裁决数=0；每个任务/使命/交付的 current effective state 数=1；通过裁决的复核者与该 result 执行者相同的次数=0；同一逻辑变更的 attempt、裁决、任务状态、升级事项、result version、记忆版本和交付副作用成功提交次数均≤1；过期、终止、失效或后到复核结果提交任务完成/记忆/交付的次数=0；任何可观察部分完成状态数=0。
- 出处: product/assumptions.md A-5、A-10、A-15、A-41、A-61、A-62、A-63；features/004-collaboration-orchestration/spec.md NFR-2；features/005-safe-parallel-execution/spec.md NFR-1、NFR-4；S-6 演示判据。
- 验证方式: 自复核、无能力候选、多候选未选择、双复核者并发、重复操作标识、同标识不同内容、任务/result/上下文竞态、旧看板写入口/replay、暂停/终止、迟到 Agent 结果、通过/记忆/交付提交故障注入，按公开状态与副作用计数核对。

### NFR-2: 持久恢复与审计完整性
- 要求: 刷新/重启后任务 result version、复核资格/选择/attempt/冻结材料/调用与 usage 状态、裁决、返工/补证、新 execution/result、升级/回答、current effective state、记忆 actor/来源/版本、完成门槛、最终摘要和证据关联可恢复率=100%；审计事件保持稳定顺序和关联；未确认在途动作的自动后台重放次数=0。
- 出处: product/product.md MVP“项目、角色、会话、执行事件和结果持久化”及“历史可在重启后继续查看”；features/004-collaboration-orchestration/spec.md FR-9；features/005-safe-parallel-execution/spec.md NFR-4；S-6 演示判据。
- 验证方式: 在复核调用、裁决提交、升级回答、记忆沉淀和最终交付各阶段刷新并重启独立进程，比较重启前后公开历史、顺序、版本、来源和引用，并确认无 owner 明确继续时外部调用与业务副作用计数为 0。

### NFR-3: 隐私、凭据与公开推理边界
- 要求: 产品响应、持久记录、Agent 可见复核上下文、页面、日志、截图和最终交付中的 API key、Authorization、主密钥、凭据密文、validation token、原始 provider headers/body、未脱敏环境值及隐藏思维链匹配数=0；复核 Agent 只接收当前任务复核所需的公开 allowlist 事实。
- 出处: product/assumptions.md A-16、A-20、A-23；features/004-collaboration-orchestration/spec.md NFR-1；features/005-safe-parallel-execution/spec.md NFR-4。
- 验证方式: 使用已知哨兵凭据与 CoT 标记分别扫描出站复核上下文和产品域；出站上下文只允许当前复核所需的公开项目/任务/结果/证据及复核者自身配置，产品域对全部禁止项匹配为 0。

### NFR-4: 可访问性与响应式交互
- 要求: 新增复核、升级、记忆和交付 UI 文本对比度满足 WCAG AA；交互目标至少 44×44px；桌面与窄屏主路径可仅用键盘完成；焦点可见且弹层关闭后恢复；状态、Agent 和裁决不只依赖颜色表达。
- 出处: product/product.md MVP UI 边界；product/assumptions.md A-7、A-17；ext-ui-design。
- 验证方式: 桌面与窄屏真实渲染下仅用键盘完成复核查看、升级回答、历史记忆和最终交付路径，核对语义树、对比度、目标尺寸、焦点移动/恢复、live 状态和截图。

## 6. 约束与依赖

- 依赖 S-3 的使命看板、项目成员、带来源 append-only 共享记忆及稳定项目上下文；目标、决策、事实、产物是既有类型，经验为 S-6 新增类型。
- 依赖 S-4 的真实 Agent 调用、公开消息/事件、usage、幂等操作与重启恢复边界；复核不得从自由聊天猜测事实或保存隐藏思维链。
- 依赖 S-5 已合入且状态为待复核的任务结果、公开变更、验证、产物和执行审计；未合入、stale、conflicted、failed、stopped 或人工恢复未解决的结果不能通过。
- S-5 merged execution 始终是不可继续、不可重试的只读终态；S-6 返工或补证通过同一 work item 的新 execution 产生新 result version，不修改旧 merged execution/result。
- 使命看板继续作为任务、依赖、负责人和状态的唯一事实源；复核和交付必须与当前任务版本一致。
- owner 仍是项目方向和高风险动作的最终裁决者，但不能替代非执行者 Agent 的通过裁决。
- 首版保持本地优先、单 owner、平等 Agent 项目组；不引入固定 leader 或隐藏总管 Agent。
- 既有文本边界继续适用于使命、任务、记忆正文与来源引用；本规格不新增无出处的字段长度、性能或容量阈值。
- UI 复用现有协作驾驶舱、浅色视觉 token、稳定 Agent 身份、桌面主布局和窄屏单覆盖区域，不新增品牌或装饰性视觉方向。

## 7. 假设

- A-5: 完成需要至少一名非执行者 Agent 复核通过；若改为 owner 或执行者可直接通过，FR-1、FR-6、FR-7 与 NFR-1 必须重定格。
- A-10: 使命看板仍是任务状态唯一事实源；若另建不一致的交付状态源，完成门槛和恢复语义必须重新评审。
- A-11/A-31: 长期记忆只收录带来源结构化条目，既有四类为目标、决策、事实、产物；S-6 在此基础上增加经验，原始聊天不自动入库。
- A-15/A-51: 上下文、结果或基线变化会使旧结果失效；若允许旧复核推动完成，FR-2、FR-6、FR-11 的竞态保护将失效。
- A-16: 只保存公开结论和可审计事实，不保存/展示隐藏思维链；若要求 CoT，本规格与既有隐私边界冲突。
- A-17: 桌面三栏优先，窄屏使用可切换覆盖区域；移动端首版只保证查看、发言和审批，不扩展为完整复核编辑承诺。
- A-61: owner 显式选择具备 review 能力的独立 Agent 并触发真实 provider 调用；若允许平台暗选或非 Agent 伪造裁决，FR-1 至 FR-3 必须重定格。
- A-62: 退回/补证产生新 execution/result version，升级回答后产生新 review attempt；若允许修改旧 merged result 或给同一 attempt 追加裁决，FR-4/FR-5 的历史与终态语义失效。
- A-63: task/mission/delivery 各自只有一个 current effective state，所有写入口服从同一门槛；若旧入口可直接写完成，FR-6/FR-7 与 NFR-1 无法成立。
- A-64: review Agent 是自动记忆提议者，裁决负责确认，平台仅持久化，来源精确绑定历史版本；若平台可冒充作者或来源漂移，FR-8 与审计边界失效。
- A-65: 去重仅按类型、trim 后正文原样 code point、source type/id/version 全等，supersedes 必须显式指向唯一 active 前版；若改用 Unicode 规范化、相似度或隐式替代，FR-9 的确定性样例需重写。

## 8. 开放问题

不适用: 当前规格所需的完成权限、记忆类别、演示判据、安全边界和 UI 状态均已有用户要求或现有产品事实来源，未发现阻塞性开放问题。

## 9. Requirements Checklist 自检

### 可测性
- [x] 每条 FR 描述可观察行为，不包含类名、接口签名、表结构或实现方案。
- [x] 每条 FR 均含 Given/When/Then，并覆盖失败路径和边界条件。
- [x] 每条 NFR 均有可判定阈值、验证方式和现有真实出处。

### 反幻觉
- [x] 未为填模板发明性能、容量或时延数字；新增要求均来自 frame、产品层、S-3/S-4/S-5 事实源或用户明确要求。
- [x] 未把未经确认的选择写成事实；假设区只复用当前生效假设并说明失效影响。
- [x] 已删除“快速、稳定、体验好”等不可判定模糊量词。

### 完整与一致
- [x] 规格闭合 S-6 演示判据，未夹带 frame 外的新范围。
- [x] 范围外已显式列出，范围内每项能力均有对应 FR。
- [x] FR 之间职责分离且无冲突：资格/材料/裁决/三种后果/完成门槛/记忆/交付/可靠性/UI 各自可测。
- [x] 无阻塞性开放问题。
- [x] 已加载并对照 ext-ui-design：覆盖桌面/窄屏、loading/empty/error/disabled/success/focus、键盘、焦点、对比度和 44×44px。
