# 002-agent-definition 计划

- 日期: 2026-07-26
- frame: ./frame.md

## 0. 范围外
(引自 frame.md)不做 agent 执行/LLM 调用(S-3)、项目组(S-4)、多角色协作(S-5)、角色模板(S-6);不实际接通 provider、不执行工具、不注入 skill(均 S-3+)。本切片只交付"定义 → 保存 → 可见"。服务端按内置池校验 tools/skills/provider 合法性亦推迟(S-3 接入执行时再做),本切片 API 仅校验 name。

## 1. 需求

### FR-1: Agent 五要素创建表单
- 优先级: 必须
- 描述: UI 提供表单填写五个要素:名字、角色描述(system prompt)、可用工具(多选)、模型供应商(下拉)、harness/skill 集合(多选)。
- 验收标准:
  - Given 打开主区 When 渲染表单 Then 出现五个输入:名字(文本)、角色描述(多行文本)、工具(多选,来自内置池)、供应商(下拉,来自内置池)、skill(多选,来自内置池),每个输入有可点 `<label>`。
  - Given 未填名字 When 提交 Then 不发送请求,名字字段显示"必填"错误,fetch 未被调用。
  - Given 填齐有效值 When 提交 Then 发送 POST 请求(工具/skill 以数组提交)。

### FR-2: 保存 agent(POST /api/agents)
- 优先级: 必须
- 描述: 提交有效数据后,agent 持久化到 DB 并返回新建记录;tools/skills 以数组形态在 API 上往返。
- 验收标准:
  - Given POST /api/agents body 含五要素 When 调用 Then 返回 201 且 body.agent 含 {id,name,systemPrompt,tools,provider,skills},其中 tools/skills 为 `string[]`(与入参数组相等)。
  - Given 入参 tools=["shell","file.read"] When 保存再读回 Then getAgents 返回的 tools 等于该数组(序列化为 JSON 列存储、service 层反序列化为数组)。

### FR-3: 创建后列表可见
- 优先级: 必须
- 描述: 创建成功后列表刷新并显示新 agent 的名字。
- 验收标准:
  - Given 表单提交成功(201) When 响应返回 Then 列表新增一条,显示新 agent 的名字。
  - Given 多次创建 When 列表渲染 Then 按 id 升序展示全部。

### FR-4: 名字缺失/空白被拒
- 优先级: 必须
- 描述: 名字缺失(undefined)、空串或全空白时,API 拒绝创建。
- 验收标准:
  - Given name 为 undefined / "" / "   " When POST /api/agents Then 返回 400 且 body 含 error 字段。
  - Given 名字两端含空白 When 合法保存 Then 存储与返回均为 trim 后的值。

### 非功能需求
- NFR-1: 表单可访问性与对比度 — 要求: (a) 每个输入有可点 `<label>`(测试用 `getByLabelText` 选中);(b) 所有控件键盘可达、`:focus-visible` 可见、提交按钮触控目标 ≥44px;(c) 正文对比度 ≥4.5:1(沿用 S-1 token);主按钮用 `--accent-strong #15803d`(白字对比度 ≈5.6:1,满足 AA 正文),森绿主色 `--accent #16a34a`(D-13)用于非文本点缀(状态点/焦点环)。出处: ext-ui-design + S-1 a11y 基线。验证方式: 组件测试断言 `getByLabelText`、按钮可选中且带 focus 样式类;对比度由 token 推导(#15803d×#ffffff≈5.6:1)。

## 2. 设计

### 现状与改动面(含破坏性变更声明)
复用 S-1 的 Next.js 应用、Prisma/SQLite、Tailwind token、测试基础设施。**本特性对 S-1 既有代码是破坏性变更**:Agent 模型去 `role` 列、加四列,SQLite 下 Prisma 以重建表方式生成迁移,会令 S-1 中引用 `role` 的既有测试与组件先转红,必须在 T-1 内一并适配(清单见 T-1)。

改动:
- `prisma/schema.prisma`:Agent 由 `{id,name,role,createdAt}` → `{id,name,systemPrompt,tools,provider,skills,createdAt}`。
- 迁移:用 `prisma migrate dev --name add_agent_fields` 生成 migration 文件(可复现,非 db push);dev.db 仅 seed,重建可接受。
- `src/shared/agentOptions.ts`(新):三池常量。
- `src/server/agentService.ts`:引入 `AgentDTO`(tools/skills 为数组);`getAgents` 返回 `AgentDTO[]`(反序列化);新增 `createAgent(input)`(序列化存储 + 校验)。
- `app/api/agents/route.ts`:新增 POST handler;GET 返回 `AgentDTO[]`。
- `components/AgentList.tsx`:类型去 `role`、显示仅名字;**新增 `version: number` prop(默认 0)**,写入 `useEffect` 依赖,`version` 变化时重新拉取。
- `components/AgentForm.tsx`(新):五要素表单(client),`onCreated` 回调通知父。
- `app/page.tsx`:主区 AgentForm(上)+ AgentList(下);持有 `version` 状态,`onCreated` 时自增并传入 AgentList。
- `app/globals.css` + `tailwind.config.ts`:新增 `--accent-strong` token。

### 关键决策(仅真实决策点)
- PD-1: 选项数据来源 — A: GET /api/agent-options 端点 / B: `src/shared/agentOptions.ts` 共享模块,客户端直接 import 静态数据。选 B:静态内置池无需端点,客户端/服务端单一事实源。
- PD-2: tools/skills 存储 — A: 关系表(AgentTool) / B: JSON 字符串列。选 B:骨架阶段元素简单、无独立查询需求;未来需按工具反查再升关系表。
- PD-3: 创建后列表刷新 — A: 引入 SWR/React Query / B: 父组件持 `version` 状态,AgentList 以 `version` prop 入 useEffect 依赖,创建成功 `onCreated` 自增触发重拉。选 B:无新依赖、贴合骨架体量;数据层推迟到 S-4+。
- PD-4: 序列化边界 — A: API 返回原始 JSON 字符串、由组件 parse / B: service 层做 (de)serialization,对外(API/组件)统一是数组。选 B:契约统一、消费者无需感知存储细节。

### 接口与数据契约
- Prisma Agent(存储):`id Int @id @default(autoincrement()); name String; systemPrompt String @default(""); tools String @default("[]"); provider String @default("zhipuai-coding-plan"); skills String @default("[]"); createdAt DateTime @default(now())`
- AgentDTO(对外):`{id:number; name:string; systemPrompt:string; tools:string[]; provider:string; skills:string[]; createdAt:Date}`;service 负责 `JSON.parse`(失败回退 `[]`)/`JSON.stringify`。
- `agentOptions`:`providers=[{id:"zhipuai-coding-plan",label:"GLM (zhipuai-coding-plan)"}]`;`tools=[{id:"file.read",label:"文件读取"},{id:"file.write",label:"文件写入"},{id:"shell",label:"Shell 执行"},{id:"web.search",label:"网络搜索"}]`;`skills=[{id:"requirements",label:"需求整理"},{id:"tdd",label:"TDD"},{id:"testing",label:"写测试"}]`。
- REST:`POST /api/agents` body `{name, systemPrompt?, tools?, provider?, skills?}` → `201 {agent:AgentDTO}`;name 缺失/空白 → `400 {error}`;body 非法 JSON → `400`。`GET /api/agents` → `200 {agents:AgentDTO[]}`。
- 组件契约:`AgentList({version=0})` version 变 → 重拉;`AgentForm({onCreated: ()=>void})` 提交成功调用 onCreated。

### 错误处理
- name 校验失败(undefined/空/全空白)→ service 抛 `ValidationError` → 路由映射 400 `{error:"name 必填"}`;trim 在 service 内做。
- body 非法 JSON → 路由 400。
- 其它异常 → 500(不泄漏堆栈)。
- 表单:提交中 disabled;非 2xx/网络失败 → error 态"保存失败,请重试",可重试。

## 3. 测试策略
- 服务层单测(node):`createAgent`——成功(数组往返、读回相等)、name 为 undefined/""/"   " 抛错、两端空白 trim;`getAgents` 返回 `tools/skills` 为数组。
- handler 单测(node,mock service):POST 有效→201+`agent.tools` 为数组、name 空→400、name undefined→400、非法 JSON→400、service 异常→500 不泄漏堆栈。
- 组件单测(jsdom):AgentForm 渲染五要素且 `getByLabelText` 可选中各输入;空名提交显示"必填"且 fetch 未调用;有效提交(mock fetch 201)后调用 onCreated;AgentList 受 `version` prop 变化触发重拉(version+1 后出现新 mock 数据)。
- 既有用例适配(T-1):`agentService.test.ts`(create 改新字段、断言数组)、`AgentList.test.tsx`(mock 去 role)、`agentsApi.test.ts`(mock 返回 AgentDTO 数组)。
- 运行命令:`npm test`;边界:name 缺失/空白/trim、数组往返、version 刷新。
- 运行时冒烟(verify):`npm run dev` + 真实浏览器 render-check(表单渲染、真实创建一条后列表出现)+ 截图。

## 4. UI 设计(ext-ui-design)

### 既有 Design System
沿用 S-1 token(森绿主色 `--accent #16a34a`、中性灰底、系统字体、圆角/阴影 token)。新增 `--accent-strong #15803d` 用于主按钮(对比度)。无外部 DS。

### 信息架构
主区自上而下:`<section>` AgentForm(创建) + `<section>` AgentList(网格,沿用 S-1 卡片,仅显示名字)。侧栏保持 COOL AI 标题。

### 交互三态(AgentForm 提交)
- idle: 初始可填写。
- submitting: 按钮 disabled + "保存中…"。
- error: 非 2xx/网络失败 → "保存失败,请重试" + 可重试。
- success: 201 → 清空名字、调用 onCreated、回 idle。
- 字段级:名字空提交 → 名字下方"必填",不进入 submitting。

### 视觉系统
复用 token:输入框 `rounded-token border-line bg-surface`;主按钮 `bg-accent-strong text-surface`;复选/下拉原生控件加 token 边框。禁止紫蓝渐变、emoji 图标、glassmorphism。

### 可访问性(NFR-1)
每个输入 `<label htmlFor>` 关联(`getByLabelText`);select/checkbox 键盘可达;提交按钮 `min-h-[44px]` + focus-visible;主按钮白字×#15803d≈5.6:1 满足 AA 正文。

## 5. 任务清单

- [x] T-1 schema 破坏性迁移 + options + seed + 既有代码/测试适配 (覆盖: FR-3) — 判据: `prisma migrate dev --name add_agent_fields` 生成并应用 migration 文件;Agent 模型含五要素列;`agentOptions` 导出三池;seed 含 systemPrompt;**适配清单全部完成且全量 `npm test` 绿**:`agentService.test.ts`(create 用新字段、`getAgents` 断言 tools 为数组)、`components/AgentList.tsx`(去 role、显示仅名字、加 `version` prop 入 useEffect 依赖)、`tests/AgentList.test.tsx`(mock 去 role)、`tests/agentsApi.test.ts`(GET mock 返回 AgentDTO 数组)。
- [x] T-2 agentService.createAgent + 序列化/校验 (覆盖: FR-2, FR-4) — 判据: createAgent 成功单测(入参数组→JSON 存储、返回 DTO 数组与入参相等)、name 为 undefined/""/"   " 抛错、两端空白 trim 单测通过。
- [x] T-3 POST /api/agents handler (覆盖: FR-2, FR-4) — 判据: handler 单测 有效→201 且 `agent.tools` 为数组、name 空→400、name undefined→400、非法 JSON→400、异常→500 不泄漏堆栈;GET 沿用 AgentDTO。
- [x] T-4 AgentForm + version 刷新 + a11y (覆盖: FR-1, FR-3, NFR-1) — 判据: 表单渲染五要素且 `getByLabelText` 可选中;空名提交显示"必填"且 fetch 未调用;有效提交(mock 201)调用 onCreated;AgentList 受 `version` 变化重拉(version+1 后出现新 mock 名);主按钮 `--accent-strong` + min-h/focus;`npm run build` exit 0。
