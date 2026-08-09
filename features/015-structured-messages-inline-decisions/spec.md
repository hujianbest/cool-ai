# 结构化消息与就地决策需求规格

- 日期: 2026-08-09
- 特性: 015-structured-messages-inline-decisions
- 对应切片: S-13（CI-2.3）
- 依赖: 已交付 S-12 项目内持久线程与上下文续接

## 问题陈述

owner 目前只能在公开 Thread 中阅读纯文本消息和既有运行事实。提案、清单、差异、文件来源与交棒信息缺少统一、可验证的表达，owner 必须从文本中自行判断来源和当前版本，也无法在消息原位安全地完成低风险决定。若直接把模型输出渲染成任意富内容或把卡片点击接到执行动作，又会绕过 Project/Thread/Run 归属、版本冲突、verified-handle、sandbox、Approval、凭据保护和公开审计边界。

## 解决方案

owner 在既有 fact-only transcript 中按公开事实顺序看到五类正式 Structured Message Block：Proposal、Checklist、Diff Preview、File Reference 与 Handoff Card。每个 block 都显示可理解的内容、actor、block schema/revision、当前 state version 和冻结 Source Tuple；Proposal 与 Checklist 只提供规格明确列出的低风险 Inline Decision，成功提交得到确定的 Action Receipt，冲突得到不含业务 Receipt 的稳定脱敏 envelope。文件、差异和高风险动作仍沿用既有受控导航、读取、执行与 Approval 边界，消息卡只改善理解和入口，不获得新的权限。

## 用户故事

1. **作为 owner，我想在公开消息流中辨认五类正式 block，从而无需从自由文本猜测内容用途。**
   - Given 同一 Message 含 Proposal、Checklist、Diff Preview、File Reference 与 Handoff Card，When owner 打开 Thread，Then transcript 按 Thread Fact、Message 和 block 原始顺序各渲染一次，并以可访问名称明确区分五种类型。
   - Given Message 只有纯文本或同时含纯文本与 block，When 渲染，Then 纯文本保持原样且 block 不覆盖、重复或重新排序 Message 内容。
   - Given block 类型或 `blockSchemaVersion` 不在 allowlist，When owner 看见该事实，Then 显示保留 actor、`blockSchemaVersion`、`blockRevision` 和来源提示的稳定不可执行占位，不猜测字段、不显示动作控件，其他合法事实继续可读。

2. **作为 owner，我想确认 block 的作者、结构版本、内容修订、状态版本和冻结来源，从而知道自己正在查看和决定哪一项事实。**
   - Given 一个合法 block，When owner 查看其来源信息，Then 可辨认 actor、block 类型、`blockSchemaVersion`、`blockRevision`、当前 `stateVersion`，以及精确 Project、Thread、Message、适用的 Run、来源实体身份与 `sourceEntityVersion`。
   - Given 来源实体后来产生新 `sourceEntityVersion`、同一逻辑 block 产生新 `blockRevision` 或 Project 中出现更晚 Run，When 重新打开旧 block，Then 仍显示原展示快照、原 revision 和冻结来源，不替换为 latest。
   - Given actor 改名或离开 Project，When 查看历史，Then block 保留创建时可读身份快照且不会把当前成员冒充原 actor。

3. **作为 owner，我想在 Proposal 原位接受或拒绝，从而快速完成不会产生外部副作用的正式决定。**
   - Given 未决定且 `expectedStateVersion` 等于当前 `stateVersion` 的 Proposal，When owner 选择 `accept` 或 `reject` 并提交，Then 只产生一个绑定该 `blockRevision`、从旧 state version 到新 state version 的 Inline Decision 与 Action Receipt，界面显示唯一决定结果。
   - Given Proposal 已有终态决定，When owner 再次查看，Then `accept`/`reject` 均禁用并说明已决定，不允许反向改写历史；需要变化时由新的 block 版本表达。
   - Given 请求携带自由文本、额外参数或非 `accept`/`reject` 动作，When 提交，Then 整个请求被拒绝且不产生 Decision、Receipt 或其他业务事实。

4. **作为 owner，我想在 Checklist 原位勾选或取消一个既有项，从而更新清单状态而不改写 Mission 看板。**
   - Given Checklist 中一个既有项目且 `expectedStateVersion` 等于当前 `stateVersion`，When owner 提交 `check_item` 或 `uncheck_item`，Then 只为该项目产生一个递增后的新 `stateVersion` 和对应 Action Receipt，`blockRevision` 与其他项目保持不变。
   - Given 请求同时指向多项、创建/删除/改写项目文本、携带自由文本或使用其他动作，When 提交，Then 请求被拒绝且旧 Checklist 不变。
   - Given Checklist 内容与 Mission Work Item 文本相似，When owner 更新清单，Then 不自动创建或更新 Mission、Work Item、执行、handoff 或共享记忆事实。

5. **作为 owner，我想让重复、冲突和陈旧决定得到确定结果，从而避免一次点击产生多次业务动作。**
   - Given 相同 operation ID 与相同规范 request hash 已 `completed`，When 客户端因超时重放，Then 返回原 Action Receipt 和原业务结果，不新增 Decision、`stateVersion`、Receipt、Thread Fact 或审计业务动作。
   - Given 已存在 operation ID 携带不同 request hash，When 提交，Then 返回 sanitized `OPERATION_CONFLICT` envelope，不产生新 Action Receipt/Decision/Thread Fact，不改变或取代原 operation。
   - Given 两个页面持有相同旧 `expectedStateVersion`，When 第一个提交成功、第二个随后提交，Then 第二个 operation 原子终结为 `VERSION_CONFLICT`，只持久化其 operation/hash 与 sanitized 冲突结果，不产生业务 Receipt/Decision/state version/Thread Fact；同 ID + 同 hash 重放同一 envelope，owner 重读后须使用新 operation ID。
   - Given Inline Decision 是同步单事务，When 请求执行中或进程中断，Then S-13 不持久化 `pending` operation；客户端 unknown-write 查询 operation 后，`completed` 重放原 Receipt，`version-conflict` 重放原冲突 envelope，`not-found` 返回 `OPERATION_NOT_FOUND` 并且只允许原 ID + 原 hash 重试。

6. **作为 owner，我想安全查看 Diff Preview 与 File Reference 的来源，从而定位证据而不扩大宿主文件权限。**
   - Given Diff Preview 引用同一 Source Tuple 下已存在且已验证的 workspace/execution artifact，When 渲染，Then 只显示经脱敏、受大小边界约束的快照和冻结来源；它是只读预览，不提供编辑或合入动作。
   - Given File Reference 指向已验证的项目文件或 artifact，When owner 选择打开，Then 只进入既有受控导航/读取流程，并重新执行项目归属、verified-handle、sandbox/读取策略与可用性校验。
   - Given 文件、artifact、Run 或来源不属于当前 tuple，已失效、越界、不可验证或超限，When 渲染或打开，Then 失败关闭且不读取宿主内容、不回显宿主路径、不 fallback 到同名或 latest 来源。

7. **作为 owner，我想清楚区分就地决定、受控读取与正式 Approval，从而不会因点击卡片意外执行高风险动作。**
   - Given Proposal/Checklist 只请求本规格列出的低风险状态转换，When owner 决定，Then 可直接形成 Inline Decision。
   - Given File Reference 的“打开”，When owner 激活，Then 它只是进入既有受控导航/读取，不构成 Approval、文件修改或执行。
   - Given 任一 block 涉及文件变化、合入、命令、网络、外部发布、破坏性动作或其他外部副作用，When owner 激活入口，Then 只能创建或导航到既有正式 Approval；卡片点击和 Inline Decision 均不能批准、执行或续接该动作。
   - Given Approval 被拒绝、过期或归属不匹配，When 返回 transcript，Then block 只关联脱敏结果，不把失败伪造成执行成功。

8. **作为 owner，我想只让通过严格校验的 Agent block 成为公开事实，从而不把不可信模型输出变成可执行 UI。**
   - Given Agent 通过 strict structured output 提议合法 block，When 平台提交 Agent turn，Then 在同一原子边界校验类型/`blockSchemaVersion` allowlist、`blockRevision`、初始 `stateVersion`、数量、大小、文本、动作集合、actor、Source Tuple/`sourceEntityVersion`、凭据与可见内容后，Message、block 和 Thread Fact 一起提交。
   - Given 任一 block 或任一公开字段校验失败，When 提交 turn，Then 整个业务提交被拒绝，不保存部分 Message/block/fact/Decision，不生成可执行降级卡，也不以纯文本伪装成功。
   - Given primary 或修复响应含已知凭据、raw Provider 内容或不允许的结构，When 处理，Then 不将原值写入持久化、日志、错误、Action Receipt、公共审计或 DOM；错误只返回稳定的脱敏结果。

9. **作为 owner，我想把 Handoff Card 视为既有公开交棒的清晰投影，从而理解接力而不产生第二条生命周期。**
   - Given Thread 已有合法公开 handoff fact，When 显示 Handoff Card，Then 卡片保留同一 actor、from/to 成员、Run 和 Source Tuple，并且只投影一次。
   - Given 没有对应 handoff fact、来源归属不符或引用损坏，When 尝试构造或显示，Then 失败关闭为不可执行占位，不创建 Collaboration Run、handoff、私语或新业务事实。
   - Given owner 激活 Handoff Card 的来源入口，When 导航，Then 只定位既有 handoff/Run 事实，不启动、继续、暂停或终止 Run。

10. **作为 owner，我想在重启和分页后看到相同历史，从而信任长期线程记录。**
    - Given current identity 9 数据库中的纯文本 Thread Fact，When 重复 reopen，Then 原文本、actor、顺序和来源原样可读，不追溯生成 Structured Message Block。
    - Given 新 Message 含多个 block 和已完成 Inline Decision，When 跨分页边界、刷新或重启后读取，Then Message/block 顺序、block schema/revision、state/source entity version、Source Tuple、Decision 与 Action Receipt 的 schema/状态版本保持一致且各出现一次。
    - Given fresh identity 9 bootstrap、exact current reopen，或任意 unsupported/partial/drift/非法 current 数据，When open，Then fresh 原子建立、exact reopen 保持同一完整结果，其余稳定失败关闭且不重复、丢弃、改写或跨 Project 归并事实。

11. **作为 owner，我想让所有 block 与决定严格留在其 Project/Thread/Run/source 中，从而不泄漏或误操作其他上下文。**
    - Given 只替换 Project、Thread、Run、Message、block 或 source identity 中任一成员，When 读取、决定、打开来源或关联 Approval，Then 与未知资源得到同形安全失败，且任何 Project 都无写入。
    - Given 快速切换 Project/Thread/Run 时旧读取或决定响应延迟返回，When 新目标已生效，Then 旧响应不得渲染、聚焦、启用动作或覆盖新目标状态。
    - Given Source Tuple 不完整、内部矛盾或仅能找到其他上下文的同名/latest 来源，When 处理，Then 失败关闭且不通过错误、占位或时间差泄漏其他资源存在性。

12. **作为 owner，我想获得足够且脱敏的审计关联，从而核对谁对哪个来源做了什么。**
    - Given block 创建、Inline Decision、Approval 跳转或 Approval 结果关联，When 查看其公开事实、冲突 envelope 或 Action Receipt，Then 可辨认 operation、明确命名的 block/state/decision/receipt/source version、actor、Source Tuple、动作类别和脱敏结果引用；Inline Decision 标记 lease 不适用，Agent turn/Approval 只引用各自既有 lease。
    - Given 内容含 Provider 凭据、raw response、隐藏推理、原始私密 diff、宿主路径或被拒绝的可见文本，When 请求失败或被审计，Then 原内容不进入公开事实、公共审计、日志、错误、Receipt 或 DOM。
    - Given `completed` success operation 以同 ID + 同 hash 重放，When 查看审计关联，Then 仍只关联原 Action Receipt 与一个业务动作，不把 replay 记录成第二次决定。
    - Given `version-conflict` operation 以同 ID + 同 hash 重放，When 查看审计关联，Then 关联同一 sanitized terminal `VERSION_CONFLICT` envelope，始终为零 Action Receipt、零 Decision/Thread Fact、零第二业务动作。
    - Given 已存在 operation 收到同 ID + 异 hash，When 返回 `OPERATION_CONFLICT`，Then 不改变原 operation、不新建审计业务结果；Given 客户端 pending/unknown-write，When 对账，Then 只按 `completed`/`version-conflict`/`not-found` 既定结果恢复。

13. **作为 owner，我想在桌面和窄屏中可靠操作 block，从而不因状态、输入方式或视觉主题而误判。**
    - Given transcript 或 block 来源正在读取，When UI 为 loading，Then 对应区域标记忙碌、保留稳定布局且决定控件不可用。
    - Given Thread 没有 block，When UI 为 empty，Then 纯文本历史仍可读；若整个 Thread 为空则沿用既有明确 CTA，不伪造示例 block。
    - Given block、来源或决定读取失败，When UI 为 error，Then 错误与对应 block 关联、内容脱敏、可重试读取；高风险写入不自动重试。
    - Given block 已决定、版本陈旧、来源不可用、请求 pending 或动作不适用，When UI 为 disabled，Then 控件禁用并以文本说明原因，不只依赖颜色。
    - Given 决定成功，When UI 为 success，Then 显示来自事实对账的 Action Receipt 状态、禁用已终结动作并把焦点移到可理解的结果；未知写入不提前显示成功。
    - Given owner 使用 Tab、Shift+Tab、Enter、Space 或 Escape，When 遍历、激活动作或关闭来源覆盖层，Then 顺序符合视觉顺序、焦点始终可见、关闭后回到触发控件，且仅悬停内容有键盘等价入口。
    - Given 桌面或既有窄屏抽屉布局，When 查看长标题、Checklist、Diff Preview 或错误占位，Then 内容不遮挡 transcript/composer/导航，阅读顺序和当前 Project/Thread/Run 仍清晰。
    - Given 任一主题与关键状态，When 检查可访问性，Then 所有控件有可访问名称，原生语义优先，目标至少 44×44px，正文对比度至少 4.5:1（大字至少 3:1），焦点可见并通过受影响表面的 axe 检查。

## 实现决策

### 正式内容与来源契约

- Structured Message Block 属于一个 Message 和 Thread Fact，是版本化、不可变的公开正式内容；合法类型仅为 Proposal、Checklist、Diff Preview、File Reference、Handoff Card。
- `blockSchemaVersion` 只选择 block 字段结构和解码规则；未知值只能进入不可执行占位。
- `blockRevision` 是同一逻辑 block 的不可变内容、actor snapshot 与 Source Tuple 快照修订号；内容或来源变化必须形成新 revision，Inline Decision 不改变它。
- `stateVersion` 从 1 开始，只在成功 Inline Decision 后单调递增；`expectedStateVersion` 只与当前 `stateVersion` 比较，绝不指向 schema、block revision、source、Decision 或 Receipt 版本。
- `sourceEntityVersion` 是 Diff/File/handoff 等来源实体的冻结版本；来源没有版本化领域语义时必须明确为空，不能以当前/latest 值补足。
- Decision 是不可变记录，携带 `decisionSchemaVersion`、`blockRevision`、`fromStateVersion` 与 `toStateVersion`；Action Receipt 携带独立 `receiptSchemaVersion`、Decision identity、同一 `blockRevision`/`fromStateVersion`/`toStateVersion`、operation ID 与 request hash。`decisionSchemaVersion` 和 `receiptSchemaVersion` 都不参与 `expectedStateVersion` 比较。
- 每个 block 还必须携带 actor snapshot、精确 Message 身份和冻结 Source Tuple。适用 Run 或来源实体不得缺失；领域上不适用的成员必须明确为空，读取方不得用 Project latest 补足。
- 可读展示文本是创建时冻结且经校验的快照；来源身份与快照不可被后续 rename、artifact 变化或新 Run 改写。
- 未知类型/`blockSchemaVersion`、损坏来源和不满足归属的数据不进入可执行路径；读取已有未知 schema 时只能产生稳定不可执行占位。

### 量化边界

- 文本上限按未做 Unicode 规范化的原字符串之 grapheme cluster 计数，统一使用 `Intl.Segmenter("zh-CN",{granularity:"grapheme"})`；标题最多 160、单个摘要/正文最多 5000，一条 Message 内全部 block 可见文本合计最多 20000 grapheme。
- 字节上限均按 1 KiB=1024 bytes 计算。canonical domain 对象统一采用 RFC 8785 JSON Canonicalization Scheme（JCS）；输入必须先满足 RFC 7493 I-JSON 与 strict domain schema。不得使用自定义键排序、转义或数字格式算法。
- wire 只接受 UTF-8 且无 BOM，并拒绝重复对象名、NaN、Infinity、负零、lone surrogate 与非法 Unicode；对象属性排序、数组保序、字符串转义和 ECMAScript 数字序列化完全遵循 JCS。
- 完整 S-13 blocks envelope 最多 256 KiB，计入 schema metadata、actor/source metadata 和全部 block；单 block 最多 64 KiB。两者都按各自 JCS UTF-8 canonical byte sequence 计量；每条 Message 最多 10 个 block。
- 顶层 `blocks` 最多 10 项；Proposal `actions` 必须按列出顺序恰为 `accept`/`reject` 两项，Checklist `actions` 必须按列出顺序恰为 `check_item`/`uncheck_item` 两项，Checklist `items` 最多 50 项且单项文本最多 500 grapheme，Diff Preview `fileReferences` 最多 100 项；首批 schema 的其他数组字段禁止。
- Diff Preview 脱敏展示文本最多 20000 grapheme；超限拒绝整个 block，不截断后伪装成完整差异。
- Inline Decision 的 operation ID 最多 128 grapheme。raw HTTP wire body 上限为 32 KiB，按解码前实际 bytes 计量并包含空白与原始 JSON 转义；它是 transport 防护边界，不等于 canonical domain envelope 边界。
- strict schema 通过后只对 `decisionIntent` 生成一次 JCS UTF-8 canonical byte sequence；该 domain envelope 覆盖完整 tuple、block identity、`blockRevision`、`expectedStateVersion`、action 和适用 item identity，排除 operation ID 与 request hash 字段，且最多 16 KiB。
- `decisionIntent` 的 16 KiB 大小校验与 request hash 必须复用上一条完全相同的 canonical bytes，不得再次序列化或使用 wire body bytes；operation ID/hash 仍在外层请求和 operation 幂等契约中校验。
- 所有 wire、逐字段、逐数组、单对象与总 canonical envelope 边界都必须分别通过后再原子提交；超出任一边界均无部分事实。A-91 的 JCS/I-JSON 与 wire/domain 分层是 A-89 informal canonical wording 的精确化。

### Action 分类

- **可直接 Inline Decision 的低风险状态转换只有四个**：Proposal 的 `accept`、`reject`；Checklist 的 `check_item`、`uncheck_item`。Proposal 动作集合固定为前两项；Checklist 动作集合固定为后两项且一次只作用一个既有 item。
- Inline Decision 只改变该 Structured Message Block 的领域状态。它不得创建/更新 Mission、Work Item、共享记忆、文件、execution、Run、handoff 或 Approval。
- File Reference 的打开属于受控导航/读取，每次都重新经过既有项目归属与 verified-handle 等读取边界；不是 Inline Decision 或 Approval。
- 来源定位、详情展开和返回 transcript 是只读导航，不产生业务决定。
- 文件创建/修改/删除、diff 应用或合入、命令、网络、外部发布、破坏性操作及其他外部副作用必须进入正式 Approval；block 只能发起或导航到该流程，任何卡片动作都不能代替批准或执行。

### 决定、并发、lease 与审计

- Inline Decision 请求必须绑定 operation ID、平台计算的 request hash、`blockRevision`、`expectedStateVersion`、完整 tuple 和允许动作。
- **首次成功**：在一个同步事务中原子持久化 `completed` operation、Decision、新 `stateVersion`、业务 Action Receipt 与公开 Thread Fact；Receipt 是成功业务结果，不是任意请求的通用错误载体。
- **completed 同 hash 重放**：返回原 Action Receipt；不新增 Decision、state version、Receipt、fact 或审计业务动作。
- **同 operation ID 异 hash**：返回 sanitized `OPERATION_CONFLICT` envelope；不新建或修改 operation、Decision、Receipt、state version 或 fact，原 operation 继续决定后续同 hash 行为。
- **stale `expectedStateVersion`**：该 operation/hash 原子终结并持久化 sanitized `VERSION_CONFLICT` operation outcome，但不产生业务 Action Receipt、Decision、state version 或 Thread Fact；同 ID + 同 hash 重放原冲突 envelope，同 ID + 异 hash 为 `OPERATION_CONFLICT`，重读后必须使用新 operation ID。
- **pending/unknown**：同步事务不持久化 `pending`。客户端未知写入查询 operation：`completed` 重放 Receipt，`version-conflict` 重放冲突 envelope，未找到返回 `OPERATION_NOT_FOUND`；仅 not-found 允许原 ID + 原 hash 重试。
- 审计严格跟随上述终态：completed replay 只指回原 Action Receipt；version-conflict replay 只指回同一 sanitized terminal envelope，保持零 Receipt、零第二业务动作；`OPERATION_CONFLICT` 不改变原 operation 或新增审计业务结果；客户端 pending 不作为持久审计终态。
- Inline Decision 不新增长租约，因为判断与写入在同步单事务内完成；审计明确记录 `leaseApplicability=not_applicable`、`leaseId=null`。Agent block 提交沿用并引用既有 Collaboration turn/attempt lease（适用时），Approval/外部动作继续使用并关联各自既有 lease；S-13 不定义 block lease 或接管语义。
- 公共关联明确命名 `blockSchemaVersion`、`blockRevision`、`stateVersion`、`decisionSchemaVersion`、`receiptSchemaVersion`、`sourceEntityVersion`，并保存必要的 operation、actor、source、动作类别、lease applicability/既有 lease reference 与脱敏结果引用；不得使用无类型的 `version`，也不保存 Provider 凭据、raw response、隐藏推理、宿主路径或原始私密 diff。

### Agent 输出与原子提交

- Agent 只能在既有 strict structured output 中提议 block；平台不从自然语言、Markdown、HTML 或 Provider 自定义组件推断正式 block。
- 提交 Agent turn 前完整校验所有 block 和全部公开文本：allowlist、`blockSchemaVersion`、初始 `blockRevision`/`stateVersion`、逐层数量与 canonical UTF-8 大小、grapheme 文本长度、字段形状、动作集合、actor、tuple/`sourceEntityVersion` ownership、凭据与可见文本。
- Agent block 提交不引入新 lease；它只能在既有 Collaboration turn/attempt lease 允许的提交边界内原子写入并引用该 lease。
- 任一字段失败即拒绝整个业务 turn 的 Message/block/fact 提交；不得保留部分合法 block，不得降级为可执行卡或把失败结构伪装成成功纯文本。
- raw Provider 响应与隐藏推理永不成为 Message、block、错误、审计或修复素材的公开内容。

### 兼容与恢复

- current 数据库中的纯文本事实保持原语义、顺序和身份；reopen 不为它们合成 block。
- 新 block、Decision 和 Receipt 在分页、刷新与 exact reopen 后按原 fact/message/block 顺序恢复，`blockSchemaVersion`、`blockRevision`、`stateVersion`、`sourceEntityVersion`、Decision/Receipt schema 与状态版本均不漂移。
- 跨 Project/Thread/Run/Message/source tuple 的读取与写入同形失败；客户端目标切换使用 canonical target identity 和失效保护，旧响应不能污染新目标。

## UI 设计

### 信息架构

- Structured Message Block 只出现在中间 fact-only transcript 对应 Message 内，保持 actor/message/source 阅读顺序；不新增平行消息流、右侧第二事实源或独立“富消息中心”。
- block 顶部提供类型、可读标题、block schema/revision、current state version、actor/source 摘要；主体呈现类型内容；底部仅呈现该类型允许的状态、只读导航或动作。
- Proposal/Checklist 的决定结果原位替换 pending 动作区；Diff Preview/File Reference/Handoff Card 保持只读投影和受控来源入口。
- desktop 保持既有驾驶舱层级；narrow 使用现有抽屉和单列 transcript 模型，不引入横向依赖的双栏卡片。

### 状态与反馈

- `loading`：对应内容区域使用既有 loading token/骨架与 `aria-busy`，动作 disabled，避免尺寸跳动。
- `empty`：Message 无 block 时不渲染空卡；Thread 全空沿用带明确 CTA 的既有空状态。
- `error`：在对应 block 内显示脱敏、可恢复说明；读操作可显式重试，写操作先对账，不能自动重放。
- `disabled`：已决定、stale、客户端请求 pending、不可用来源与未知 `blockSchemaVersion` 均说明禁用原因，状态不只靠颜色；客户端 pending 不得被解释为持久 operation 状态。
- `success`：只在 completed Action Receipt/事实对账后显示，保留决定 actor、动作、block revision 和 from/to state version 摘要；冲突 envelope 不显示 success。
- `focus`：每个可交互元素使用现有可见焦点 token；决定完成、错误恢复和覆盖层关闭后的焦点去向确定且可测试。
- unknown type/`blockSchemaVersion`：稳定不可执行占位包含安全可公开的类型/schema/revision/source 提示，不渲染任意字段、不提供动作。

### 视觉、响应式与可访问性

- 复用现有 `tokens.css` 与 cockpit 语义 token；颜色、字体、间距、圆角、阴影和断点不得硬编码。没有需求授权新增视觉品牌、渐变、发光、玻璃拟态或装饰动画。
- 不渲染任意 HTML，不使用 emoji 充当图标，不复制 Clowder AI 的品牌、猫角色、文案、源码、调色盘或资产。
- 优先使用原生 heading、list、button 和 disclosure 语义；纯图标控件必须有可访问名称，装饰图标对辅助技术隐藏。
- 全部交互可用键盘完成，焦点可见；覆盖层支持 Escape、限制焦点并在关闭后返回触发点。
- 点击/触控目标至少 44×44px；正文对比度至少 4.5:1，大字至少 3:1；disabled、error、success 不仅依赖颜色。
- 默认不新增动效；如既有反馈动效被复用，须服从 reduced-motion，且不以布局属性动画影响 transcript 阅读。

## 测试决策

测试只通过公共缝观察外部行为，不断言私有函数、内部表结构、具体组件文件或实现步骤。auto 选择记录于 A-85。

1. **strict block schema + tuple-scoped domain/API**
   - 穷尽五类合法 block、未知 type/`blockSchemaVersion`、block revision/state/source/Decision/Receipt 版本绑定，以及逐字段、逐数组、单对象和总 envelope 的 grapheme/JCS UTF-8 byte 边界 ±1。
   - 使用 RFC 8785 官方/兼容性测试向量验证对象排序、字符串转义、ECMAScript 数字、数组保序和同一输入跨重启 canonical bytes 一致；I-JSON 拒绝重复键、NaN/Infinity/负零、lone surrogate 与非法 Unicode。
   - 分别验证 raw wire body 32 KiB 与 canonical `decisionIntent` 16 KiB 边界，证明 wire 与 domain 大小互不替代，并断言 domain 大小校验和 request hash 接收同一 canonical byte sequence。
   - 验证完整/错误 Project、Thread、Run、Message、block、source 组合的同形失败和零部分写入。
   - 验证四个允许动作、所有额外动作/字段拒绝、completed receipt replay、`OPERATION_CONFLICT` 不改变原 operation、terminal `VERSION_CONFLICT` envelope replay 且零 Receipt/第二业务动作、无持久 pending、unknown-write 三态对账及 `expectedStateVersion` 确定性。
   - 验证 Inline Decision audit 的 lease not-applicable，Agent turn 与 Approval 只引用既有 lease 且不创建 block lease。
   - 验证 Diff/File verified source、受控打开与 Approval 分类，确保卡片不能触发变更或外部副作用。

2. **Agent turn commit seam**
   - 以真实 strict structured output 验证合法 turn 在既有 turn/attempt lease 下只一次提交 Message/block/fact，且版本字段不混用。
   - 对每个 block 字段、全部公开文本、凭据类别、raw/repair 响应和多 block 中单项失败做原子拒绝测试；断言无降级卡、无部分事实、无原文泄漏。
   - 验证 Handoff Card 只投影既有 handoff fact，不创建新 handoff 或 Run。

3. **fact-only UI seam**
   - 用公共 transcript 输入验证纯文本、五类 block、block 顺序、分页去重、未知占位与冻结快照。
   - 对 loading/empty/error/disabled/success/focus 逐态断言明确版本标签、冲突与 Receipt 区分、禁用原因、unknown-write 对账、键盘路径、焦点恢复和 stale target 失效。
   - 验证 desktop/narrow 阅读顺序及 File/Approval 入口的动作分类，不以 mock 私有组件替代事实表面。

4. **真实浏览器与 axe seam**
   - 在真实应用进程中完成 Proposal/Checklist 决定、重复提交、stale 双页面、Diff/File 受控导航、Approval 隔离、刷新和窄屏流程。
   - 验证 44×44px、键盘、可访问名称、焦点、light/dark 对比度与受影响表面的 axe；真实渲染是 UI 交付证据，组件测试不能替代。

5. **canonical fresh/reopen seam**
   - 验证 identity 9 fresh bootstrap、exact reopen 与 unsupported/partial/drift/data-invalid fail-closed；current 纯文本事实不追溯造 block，新 block/Decision/Receipt 跨分页、进程重启和 reopen 保持一致。
   - 用非法归属、顺序、各类命名版本和来源数据验证原子失败关闭；重启后 completed operation 重放原 Receipt、version-conflict 重放原 envelope且仍零 Receipt、hash conflict 不变更原 operation、not-found 允许原 ID/hash 重试且不重复业务动作。

## 范围外事项

- 任意 HTML、插件、第三方组件协议或任意可执行消息内容。
- 消息分支、回复引用、附件、搜索、标签、收藏、回收站、消息队列、重排与 Steer。
- 新的 Collaboration Run 生命周期、私语、Agent 投票、自动多线程并行或第二份 handoff 事实。
- 任意宿主文件浏览；S-13 只引用已验证来源，通用只读工作区浏览属于后续 S-22。
- 在消息卡内编辑文件、应用/合入 diff、运行命令、发布外部内容或旁路 Approval。
- 把 Checklist 变成 Mission 看板或把 Proposal 决定自动写成共享记忆/业务任务。
- 追溯把旧纯文本事实转换为 block，或把冻结来源替换为 latest。
- 保存或展示 Provider 凭据、raw response、隐藏推理、原始私密 diff、未脱敏宿主路径。
- 复制 Clowder AI 品牌、猫角色、文案、源码、调色盘或视觉资产。

## 补充说明

- 本规格沿用 S-12 已交付的公开 Thread、fact-only transcript、复合 ownership、冻结来源、operation/request hash、版本冲突、凭据拒绝和 stale target 防护。
- 行为默认来自 `product/assumptions.md` A-74～A-91；若独立评审推翻任一默认，应回到 to-spec 评估规格与兼容影响。
- 本阶段不决定持久化表、模块文件、迁移版本号或具体组件划分；这些属于后续架构阶段。
- 规格完成后必须进行独立 spec review；本文件本身不构成批准，也不授权进入架构。
- 用户确认: 待独立规格评审
