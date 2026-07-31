# 配置有技能的第一支 Agent 小队 需求规格

- 日期: 2026-07-29
- frame: ./frame.md

## 1. 背景与问题

owner 目前只能运行确定性示例 Agent，无法连接自己的模型服务，也无法表达不同 Agent 的身份、技能和权限。没有可持久配置的小队，后续项目组、群聊接力与并行工作都没有真实成员基础。

本切片先建立 Agent 库：owner 安全配置一个 OpenAI-compatible 服务，创建可复用文本技能，再创建至少两个有明显身份差异的角色 Agent。配置必须在刷新和应用重启后存在，但本切片不让 Agent 加入项目或执行真实项目任务。

## 2. 目标与成功标准

- owner 能添加并验证一个 OpenAI-compatible 服务，保存后 UI 只显示 API key 掩码。
- owner 能创建、编辑并查看可复用文本技能。
- owner 能从模板创建至少两个角色 Agent，并配置身份、模型、技能、工具权限与预算。
- 两名 Agent 在头像、强调色和角色信息上清晰可辨，刷新页面后全部配置仍在。
- 直接检查 API 响应、SQLite 与运行日志时，均找不到保存过的 API key 明文。

## 3. 范围

### 范围内
- OpenAI-compatible provider 的创建、编辑、列表、连接验证与密钥替换。
- 可复用文本技能的创建、编辑与列表。
- 角色 Agent 的模板创建、手工创建、编辑与列表。
- Agent 对 provider/model、技能、工具权限、预算、文字/几何头像和强调色的配置。
- Team 配置 UI 的 loading、empty、error、disabled、success 与 focus 状态。
- 配置的 SQLite 持久化与凭据保密验证。

### 范围外
- Agent 加入具体项目或项目成员关系；推迟到 S-3。
- 群聊、接力、共享记忆与使命看板；推迟到 S-3/S-4。
- 实际调用模型生成项目成果；推迟到 S-4。
- 文件读写、命令运行与高风险审批；推迟到 S-5。
- 图片上传头像；文字/几何头像足以闭合本切片。
- Provider 删除、技能删除和 Agent 删除；首版避免引入引用清理语义，编辑已足够闭合演示判据。
- 原生 Anthropic/Gemini 接口、本地 CLI、MCP 或插件执行。

## 4. 功能需求

### FR-1: 创建并持久化 Provider
- 优先级: 必须
- 描述: owner 能填写显示名称、base URL、默认 model 与 API key，保存一条 OpenAI-compatible provider 配置。
- 验收标准:
  - Given 字段合法且连接验证通过 When owner 保存 Then provider 出现在 Team 配置中，刷新后仍存在。
  - Given API key 已保存 When owner 或客户端读取 provider Then 只能看到非空掩码提示，不能得到完整 API key。
  - Given base URL 不是 http/https、包含 URL 用户信息，或必填字段去除空白后为空 When owner 保存 Then UI 显示简体中文字段错误且不持久化。
  - Given显示名称超过 80、base URL 超过 2048、model 超过 120 或 API key 超过 8192 个字符 When owner 保存 Then UI 指出具体超限字段且不持久化。
  - Given base URL 使用非 HTTPS When owner 尚未明确确认风险 Then 保存被阻止；确认后允许保存本地或 owner 明知的 HTTP 服务。

### FR-2: 验证 Provider 连接
- 优先级: 必须
- 描述: owner 能主动验证当前表单中的 provider 配置是否可访问并接受所选模型。
- 验收标准:
  - Given endpoint 与凭据有效 When owner 点击验证 Then 模型目录请求返回 2xx JSON 且其中包含与表单完全相同的 model 标识，UI 显示成功并标明该 model，之后允许保存。
  - Given endpoint 返回非 2xx、非 JSON、模型目录结构无效或不含所选 model When owner 点击验证 Then UI 显示可区分的简体中文失败摘要，provider 不被标记为已验证。
  - Given endpoint 在 10 秒内未完成、网络失败或返回重定向 When owner 点击验证 Then 请求失败且 provider 不被标记为已验证；系统不跟随重定向，也不向重定向目标发送凭据。
  - Given owner 在验证后修改 base URL、model 或 API key When 再次保存 Then 旧验证失效，必须重新验证。
  - Given 验证正在进行 When owner 再次点击验证或保存 Then 对应操作禁用，避免重复请求。

### FR-3: 编辑 Provider 且安全替换密钥
- 优先级: 必须
- 描述: owner 能编辑 provider 的名称、URL、model，并选择保留原 API key 或输入新 key 替换。
- 验收标准:
  - Given provider 已有密钥 When owner 编辑但不输入新 key Then 原密钥保持不变，API 与 UI 仍只显示掩码。
  - Given owner 输入新 key并重新验证 When 保存 Then 产品只保存并在后续请求使用新 key，旧 key 不再被产品保存、返回、记录或发送。
  - Given owner 修改连接字段但未重新验证 When 保存 Then UI 阻止保存并说明需要重新验证。

### FR-4: 创建与编辑文本技能
- 优先级: 必须
- 描述: owner 能创建和编辑由名称、说明与指令正文组成的可复用文本技能。
- 验收标准:
  - Given 名称和指令正文非空 When owner 保存技能 Then 技能出现在技能列表，刷新后仍存在。
  - Given 技能已存在 When owner编辑说明或指令并保存 Then 列表与详情显示新内容。
  - Given 名称或指令正文去除空白后为空 When owner 保存 Then UI 显示字段错误且不持久化。
  - Given 名称超过 80、说明超过 280 或指令正文超过 20000 个字符 When owner 保存 Then UI 明确指出超限字段且不持久化。
  - Given 技能正文包含文本 When 保存与读取 Then 文本按纯文本处理，不执行其中代码或 HTML。

### FR-5: 从模板或空白创建角色 Agent
- 优先级: 必须
- 描述: owner 能从“规划、实施、复核”可编辑模板或空白配置创建角色 Agent。
- 验收标准:
  - Given owner 选择模板 When 开始创建 Then 表单预填模板角色名称、职责与系统提示，owner 可在保存前修改。
  - Given owner 修改模板预填内容并保存 When 再次使用同一模板 Then 模板默认值不被上一次 Agent 的修改污染。
  - Given owner 选择空白创建 When 填写必要身份与运行配置 Then 能保存不依赖模板的 Agent。

### FR-6: 配置并持久化 Agent 能力
- 优先级: 必须
- 描述: 每个 Agent 可配置名称、职责、系统提示、provider/model、技能、工具权限、预算、头像文字与强调色。
- 验收标准:
  - Given 至少一个已验证 provider When owner 填写必填身份字段、选择 provider/model、至少一个技能或明确无技能、设置 1–1000000 的整数 token 预算、1–100 的整数接力轮次与权限并保存 Then Agent 出现在列表且刷新后配置仍在。
  - Given owner 创建第二名 Agent When 使用不同头像文字或强调色 Then 两名 Agent 在列表和详情中可视觉区分，且状态不只依赖颜色。
  - Given provider 未验证、引用不存在的技能、预算为负数或必填字段为空 When 保存 Then UI 显示对应错误且不产生无效 Agent。
  - Given 名称超过 80、职责超过 160、系统提示超过 20000、模型标识超过 120 或头像文字不在 1–4 个 Unicode 字符范围 When 保存 Then UI 指出具体字段且不持久化。
  - Given 单次 token 预算不是 1–1000000 的整数，或最大接力轮次不是 1–100 的整数 When 保存 Then UI 显示预算边界错误且不持久化；边界值 1 与各自上限允许保存。
  - Given Agent 已存在 When owner 编辑角色、技能、权限或预算并保存 Then详情与刷新后的数据反映最新配置。

### FR-7: Team 配置状态完整
- 优先级: 必须
- 描述: Provider、技能和 Agent 三个配置区域在 loading、empty、error 下提供明确且可恢复的反馈。
- 验收标准:
  - Given 数据尚未返回 When 打开 Team 配置 Then 各区域显示 loading，而不是提前显示 empty。
  - Given 某类配置为空 When 加载完成 Then 显示对应创建动作，不展示虚构数据。
  - Given 加载或保存失败 When UI 显示 error Then owner 能重试且未提交输入不会被静默清空。
  - Given 保存成功 When UI 更新 Then 焦点移动到新建或更新实体的标题，并以非打断方式宣告成功。

## 5. 非功能需求

### NFR-1: Provider 凭据保密
- 要求: 对测试用 API key 的完整明文执行 API 响应、SQLite 文件、源码与应用日志扫描时匹配次数均为 0；只复制 SQLite 不提供独立主密钥时无法恢复 API key；主密钥缺失或无法创建时保存返回失败且 SQLite 中既无明文也无对应新凭据记录；保存后 UI 仅显示掩码。
- 出处: product/assumptions.md A-20、A-23 与 frame 风险档位 3
- 验证方式: 服务/API 安全测试、原始数据库/源码/日志扫描、仅数据库解密失败测试、主密钥不可用的失败关闭测试与浏览器断言。

### NFR-2: 可访问性
- 要求: 新增交互文本满足 WCAG AA；交互目标至少 44×44px；表单错误与验证状态有文本和语义关联；键盘可完成创建、编辑、验证和保存。
- 出处: product/product.md 与 ext-ui-design
- 验证方式: 组件语义/键盘测试、浏览器键盘冒烟与真实渲染截图核对。

### NFR-3: 外发凭据边界
- 要求: Provider 验证不跟随任何重定向，向重定向目标发送 Authorization 的次数为 0；请求在 10 秒内成功或以超时失败结束。
- 出处: product/assumptions.md A-24
- 验证方式: 本地兼容测试服务记录请求，覆盖 2xx、3xx 和挂起连接并断言凭据只到达 owner 原始 endpoint。

## 6. 约束与依赖

- 技术栈保持 Next.js + React + TypeScript + SQLite 单仓，来源为 product/assumptions.md A-1。
- 首版只支持 OpenAI-compatible HTTP 接口，来源为 product/decisions.md D-3。
- Agent 稳定身份与 provider/model 绑定分离，来源为 product/assumptions.md A-14。
- 技能仅为本地文本指令包，不执行代码，来源为 product/assumptions.md A-9。
- Provider 验证依赖 owner 提供的兼容 endpoint；自动测试与 demo 可使用本地兼容测试服务，不需要真实外部凭据。

## 7. 假设

- A-20/A-23: API key 加密持久化且只返回掩码；主密钥与数据库/源码分离，缺失或不可创建时失败关闭，不得降级明文。
- A-21: 文字/几何头像足以满足首版身份辨识；若用户要求上传图片，将新增文件安全与存储范围。
- A-22/A-24: HTTP provider 需显式风险确认；验证不跟随重定向且 10 秒超时。若用户要求静默允许任意 URL 或跟随跳转，将改变安全验收。
- A-25: 文本与预算边界采用产品假设中的保守默认；用户推翻时需同步修改字段验收与持久化校验。
- 工具权限首版为 `读取文件`、`修改文件`、`运行命令` 三个可配置声明；实际执行与审批语义在 S-5 生效。
- 预算首版记录单次运行最大 token 数与最大接力轮次；实际扣减与阻断在 S-4/S-5 生效。

## 8. 开放问题

| 问题 | 阻塞? | 状态 |
|------|-------|------|
| 是否需要真实外部 provider 凭据完成自动验收 | 否 | 已解决：使用本地 OpenAI-compatible 测试服务验证协议与网络路径，用户凭据不进入仓库 |
| 图片头像是否属于 S-2 | 否 | 已解决：按 A-21 使用文字/几何头像，图片上传后置 |
