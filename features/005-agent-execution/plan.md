# 005-agent-execution 计划

- 日期: 2026-07-26
- frame: ./frame.md

## 0. 范围外
(引自 frame.md)不做 agentic 工具循环(S-3b)、流式、多 agent/项目组(S-4/S-5)、运行历史持久化、中断/重试、模型高级参数。本切片只交付"单轮 LLM 执行 + skill 注入 + 轨迹可见"。

## 1. 需求

### FR-1: 运行 agent(单轮)
- 优先级: 必须
- 描述: POST /api/agents/:id/run `{task}` → 用 agent 的 providerConfig(key)+ model 调 OpenAI 兼容 chat/completions,返回 `{output, trace}`。
- 验收标准:
  - Given agent 已配 providerConfig + model When POST /api/agents/:id/run `{task:"你好"}` Then 200,body.output 为上游 assistant 文本,trace 含 system/user/assistant 三步。
  - Given agent 不存在 When POST Then 404。

### FR-2: skill 内容注入 system prompt
- 优先级: 必须
- 描述: agent 关联的 skill 的 content 拼入 system prompt。
- 验收标准:
  - Given agent 关联 skill A(content 含"# Skill: A...")When 运行 Then 发往上游的 system message 内容包含 A 的 content;trace 的 system 步含 skill 内容。

### FR-3: 未配 provider 时拒绝
- 优先级: 必须
- 描述: agent.providerConfigId 为 null 时拒绝运行。
- 验收标准:
  - Given agent.providerConfigId 为 null When POST /api/agents/:id/run Then 400 `{error}`。

### FR-4: 上游失败处理 + 不泄漏 key
- 优先级: 必须
- 描述: 上游(provider)非 2xx/网络失败 → 502;任何响应不泄漏 apiKey。
- 验收标准:
  - Given 上游返回 500 When 运行 Then 502 `{error:"upstream error"}`,body 不含 apiKey。
  - Given 任意响应 When 检查 Then 不含 apiKey 字段。

### FR-5: UI 运行面板
- 优先级: 必须
- 描述: UI 选 agent + 输入 task + 运行 → 展示 output 与 trace;三态(idle/running/error)。
- 验收标准:
  - Given 打开运行面板 When 选 agent、填 task、点运行 Then 展示 output 文本与 trace 各步。
  - Given 运行中 When 等待 Then 按钮禁用 + "运行中…"。
  - Given 返回 400(未配 provider)When 运行 Then 显示错误文案。

### 非功能需求
- NFR-1: 可访问性 + 密钥不泄漏 — task 输入有 `<label>`、键盘可达、运行按钮 ≥44px/focus-visible;**响应/UI 永不返回 apiKey**。出处: ext-ui-design + 安全基线。验证: 组件 getByLabelText;handler/runner 单测断言响应不含 apiKey。

## 2. 设计

### 现状与改动面
新增执行能力,不改既有表结构。改动:
- `src/server/agentRunner.ts`(新):`runAgent(agentId, task, client?)` → `{output, trace}`;加载 agent/providerConfig/skills、构建 messages、fetch chat/completions、解析。
- `app/api/agents/[id]/run/route.ts`(新):POST handler。
- `components/AgentRun.tsx`(新):选 agent(GET /api/agents)+ task 输入 + 运行 + output/trace 展示 + 三态。
- `app/page.tsx`:主区新增"运行 Agent"段(AgentRun)。

### 关键决策(仅真实决策点)
- PD-1: runner 错误建模 — A: 单一 Error + 路由按 message 字符串判 / B: 自定义错误类(NotFoundError/UpstreamError)+ 复用 ValidationError,路由 instanceof 映射。选 B:可冷读、不依赖文案;代价是几个小类,可接受。
- PD-2: trace 形态 — A: 完整 messages 数组(含 system 全文,可能很长) / B: trace 含 system/user/assistant 概要 + 单独 output。选 A(frame 已定):trace = 三步 {role,content},system 步含注入后的全文(便于"执行轨迹可见");UI 折叠展示。
- PD-3: 工具定义 — A: 本切片就传 tools 给上游(function-calling) / B: 不传 tools(纯文本回合)。选 B:工具循环在 S-3b;本切片纯文本,避免上游 function-calling 一致性问题。

### 接口与数据契约
- `POST /api/agents/:id/run` body `{task: string}` → `200 {output: string, trace: [{role, content}]}`;agent 不存在 → 404;providerConfigId 为 null → 400;上游失败 → 502 `{error:"upstream error"}`。
- runner 内部:system content = `${agent.systemPrompt}\n\n${skills.map(s=>"# Skill: "+s.name+"\n"+s.content).join("\n\n")}`(无 skill 则仅 systemPrompt);**runner 自己 `providerConfig.findUnique`(不复用 getProviderFull,后者抛普通 Error 会落 500)**,缺失则抛 ValidationError;上游请求 URL 做尾斜杠规范化 `${config.baseUrl.replace(/\/$/,"")}/chat/completions`,header `Authorization: Bearer ${apiKey}`、`Content-Type: application/json`,body `{model, messages:[{system},{user}]}`;解析 `choices[0].message.content`。
- 错误类:`NotFoundError`、`UpstreamError`(agentRunner 导出);复用 `ValidationError`(agentService)。

### 错误处理
- agent 缺失 → NotFoundError → 404;providerConfigId null 或 providerConfig 记录缺失 → ValidationError → 400(runner 自查 findUnique);上游非 2xx/网络 → UpstreamError → **502,body 恰为 `{error:"upstream error"}`(不透传上游 body)**;其余 → 500。所有响应不含 apiKey。

## 3. 测试策略
- 服务层单测(node,mock global.fetch 上游):runAgent 成功(output 解析、trace 三步、system 含 skill content)、providerConfigId null 抛 ValidationError、上游 !ok 抛 UpstreamError;**断言发起上游请求的 body/header 不含明文 key 于返回结果**(返回结果本身只有 output/trace)。
- handler 单测(node,mock runAgent):POST 200(output+trace)、404(agent not found)、400(no provider)、502(upstream);**断言所有响应 body 不含 `apiKey`**。
- 组件单测(jsdom):AgentRun 渲染(选 agent + task label)、运行中禁用、成功展示 output+trace、400 显示错误(mock fetch /api/agents/:id/run)。
- 运行命令:`npm test`;边界:无 provider、上游失败、空 task(允许,透传)、apiKey 不泄漏。
- 运行时冒烟(verify):`npm run dev` + 真实浏览器 —— 真实 LLM 需用户已建真实 provider 配置;smoke 用 mock 上游验证 200/400/502 + 浏览器渲染轨迹。

## 4. UI 设计(ext-ui-design)

### 既有 Design System
沿用 token(森绿、--accent-strong)。无外部 DS。

### 信息架构
主区新增"运行 Agent"段:`<section>` AgentRun(agent 下拉 + task 多行输入 + 运行按钮 + 结果区:output 卡片 + trace 折叠列表)。

### 交互三态
idle(可运行)/ running(按钮禁用 + "运行中…")/ error(错误文案 + 可重试);成功 → 展示 output + trace。

### 视觉系统
复用 token;output 卡片 `rounded-token border-line bg-surface p-4`;trace 步用 `text-muted` 小字 + role 标签。禁止紫蓝渐变/emoji。

### 可访问性(NFR-1)
task `<label htmlFor>`(getByLabelText);运行按钮 min-h/focus-visible;对比度沿用 token。

## 5. 任务清单

- [x] T-1 agentRunner 服务(加载配置/skill/provider + 构建消息 + 调上游 + 解析) (覆盖: FR-1, FR-2, FR-3, FR-4) — 判据: runAgent 单测 成功(output 解析、trace 三步、system 含 skill content)、providerConfigId null 抛 ValidationError、上游 !ok 抛 UpstreamError 通过。
- [x] T-2 POST /api/agents/:id/run handler (覆盖: FR-1, FR-3, FR-4) — 判据: handler 单测 200(output+trace)、404、400、502 全通过;**所有响应 body 不含 apiKey**;**502 body 恰为 `{error:"upstream error"}`(不透传上游)**。
- [x] T-3 AgentRun UI + page 集成 + 三态 + build (覆盖: FR-5, NFR-1) — 判据: AgentRun getByLabelText + 运行中禁用 + 成功展示 output/trace + 400 错误态(mock fetch run);page 新增运行段;`npm run build` exit 0。
