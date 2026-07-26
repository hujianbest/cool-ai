# 004-provider-management 计划

- 日期: 2026-07-26
- frame: ./frame.md

## 0. 范围外
(引自 frame.md)不做 LLM 调用/agent 执行(S-3)、provider edit(A-19)、流式/function-calling(S-3)、工具执行(S-3)、apiKey 加密(生产化)、按 provider 反查 agent。本切片只交付"provider 配置被管理 + 模型可查询 + agent 关联 provider/model + 关联可见"。

## 1. 需求

### FR-1: 创建 provider 配置
- 优先级: 必须
- 描述: 用户能创建 provider 配置(名/baseUrl/apiKey)并保存;apiKey 不回显。
- 验收标准:
  - Given 填齐 name+baseUrl When 提交 Then POST /api/providers 返回 201,body.config 含 {id,name,baseUrl,createdAt},**不含 apiKey**。
  - Given name 空 When 提交 Then 400。
  - Given 已保存 When GET /api/providers Then 200,列表项 {id,name,baseUrl,createdAt},**不含 apiKey**。

### FR-2: 查询可用模型
- 优先级: 必须
- 描述: 给定一个 provider 配置,服务端用其 key 查询 `{baseUrl}/models`(OpenAI 兼容),返回模型 id 列表。
- 验收标准:
  - Given 配置存在且上游可达 When GET /api/providers/:id/models Then 200,{models:["id",...]}。
  - Given 配置不存在 When GET /api/providers/:id/models Then 404。
  - Given 上游返回非 2xx When GET /api/providers/:id/models Then 502(上游失败),不泄漏内部细节。

### FR-3: agent 关联 provider 配置 + 模型(替换静态下拉)
- 优先级: 必须
- 描述: 创建 agent 时,provider 字段改为"选已有 provider 配置";选定后查询其模型列表并选定 model;保存 agent 携带 providerConfigId + model。
- 验收标准:
  - Given 已有配置 [P] When 渲染 AgentForm(providerConfigs=[P])Then provider 选项为 P(非静态常量)。
  - Given 选 P + 选 model "glm-5.2" When 创建 agent Then POST /api/agents body 含 {providerConfigId:P.id, model:"glm-5.2"}。
  - Given body.providerConfigId 指向不存在配置 When POST /api/agents Then 400。

### FR-4: 关联关系可见
- 优先级: 必须
- 描述: agent 卡片显示其 provider 配置名 + model(由 providerConfigId 解析);provider 列表显示被多少 agent 关联。
- 验收标准:
  - Given agent 关联 P、model "glm-5.2" When 渲染 agent 卡片(传入 providerConfigs)Then 显示 P 的 name + "glm-5.2"。
  - Given agent 未关联 provider(providerConfigId 为 null)When 渲染卡片 Then 显示"未配置 provider"(降级,不报错)。
  - Given P 被 1 个 agent 关联 When GET /api/providers Then P 的 agentCount=1,UI 显示"被 1 个 agent 关联"。

### FR-5: 迁移既有(去静态 PROVIDERS)
- 优先级: 必须
- 描述: 移除 PROVIDERS 常量;Agent.provider(String)拆为 providerConfigId(Int?)+ model(String);S-2.5 引用 PROVIDERS 的代码与测试全部适配,全量测试绿。
- 验收标准:
  - Given 改动完成 When grep PROVIDERS 于 src/ 与 tests/ Then 无残留。
  - When npm test Then 全绿。

### 非功能需求
- NFR-1: 表单可访问性 + 密钥不泄漏 — 每输入 `<label>`(getByLabelText)、键盘可达、按钮 ≥44px、focus-visible;主按钮 `--accent-strong #15803d`(白字对比度 ≈5.6:1 满足 AA,沿用 S-2);**任何 API 响应与前端永不返回 apiKey**(仅存本地 db)。出处: ext-ui-design + 安全基线。验证: 组件测试 getByLabelText;handler/服务单测断言响应 JSON 不含 `apiKey` 字段。

## 2. 设计

### 现状与改动面
复用既有栈。改动:
- `prisma/schema.prisma`:**新增** `model ProviderConfig { id Int @id @default(autoincrement()); name String; baseUrl String; apiKey String @default(""); createdAt DateTime @default(now()) }`;**Agent 改** `provider String` → 去掉,加 `providerConfigId Int?`(可空)+ `model String @default("")`。混合迁移(加表 + Agent 去列/加列,SQLite 重建 Agent 表)。
- 迁移:`prisma migrate dev --name add_provider_config`(清空 dev.db 规避非交互;dev.db 仅 seed)。
- `src/server/providerService.ts`(新):createProvider / getProviders(索引 DTO,**无 apiKey**)/ getProviderFull(内部,含 key,仅供 /models 用)/ getSkill 等不需要。agentCount 聚合(同 skillService 模式)。
- `src/server/agentService.ts`:createAgent 入参 provider → providerConfigId?+ model?;校验 providerConfigId 存在(若提供);AgentDTO.provider(string)→ providerConfigId(number|null)+ model(string)。
- `src/shared/agentOptions.ts`:移除 PROVIDERS(仅留 TOOLS)。
- `app/api/providers/route.ts`(新):POST、GET(索引,无 key)。
- `app/api/providers/[id]/models/route.ts`(新):GET,服务端 fetch `{baseUrl}/models`。
- `components/ProviderForm.tsx`(新)、`components/ProviderList.tsx`(新,纯展示三态)。
- `components/AgentForm.tsx`:provider 下拉改为"选已有 providerConfig";选定后 fetch /api/providers/:id/models → model 下拉。
- `components/AgentList.tsx`:接收 providerConfigs prop,卡片解析 providerConfigId→name + 显示 model。
- `app/page.tsx`:新增 providerConfigs 索引状态(GET /api/providers,providersVersion),下传 AgentForm/AgentList/ProviderList。

### 关键决策(仅真实决策点)
- PD-1: 模型列表查询位置 — A: 前端直连上游(暴露 key) / B: 服务端代理查询(用存的 key)。选 B:key 不下发浏览器(NFR-1)。
- PD-2: agent.provider 拆分 — A: 仍单字段 "provider:model" 字符串 / B: 拆 providerConfigId(Int?)+ model(String)。选 B:引用完整性可校验(providerConfigId 外键语义)、模型独立可存可改。
- PD-3: providerConfigId 是否必填 — A: 必填(agent 必须有 provider) / B: 可空(可先建 agent 再配 provider)。选 B:灵活;S-3 执行前再要求非空。校验:若提供则必须存在。
- PD-4: 数据获取(同 S-2.5 PD-3)— 父 page 统一 fetch /api/providers 下传;ProviderList 纯展示带 status prop。

### 接口与数据契约
- Prisma:`ProviderConfig {id,name,baseUrl,apiKey,createdAt}`;`Agent {... providerConfigId Int?, model String @default("")}`。
- ProviderConfigDTO(对外,无 key):`{id,name,baseUrl,createdAt,agentCount}`。
- REST:
  - `POST /api/providers` body `{name,baseUrl,apiKey?}` → `201 {config: ProviderConfigDTO}`;name 空 → 400。
  - `GET /api/providers` → `200 {configs: ProviderConfigDTO[]}`。
  - `GET /api/providers/:id/models` → `200 {models: string[]}` | 404(配置不存在)| 502(上游失败)。
  - `POST /api/agents` body 改 `{...,providerConfigId?,model?}`;providerConfigId 不存在 → 400。
- 组件契约:`AgentForm({onCreated, skills = [], providerConfigs = []})`;`AgentList({version = 0, skills = [], providerConfigs = []})`;`ProviderList({status, configs, onRetry})`;`ProviderForm({onCreated})`。

### 错误处理
- provider name 空 → 400;agent.providerConfigId 不存在 → 400;GET /:id/models 配置不存在 → 404;上游非 2xx/网络失败 → 502 `{error:"upstream error"}`;其余 500 不泄漏堆栈。
- 任何对外响应不含 apiKey。

## 3. 测试策略
- 服务层单测(node):providerService createProvider(name 空/trim)、getProviders(索引无 apiKey、含 agentCount);agentService.createAgent providerConfigId 不存在抛错/存在通过;**断言 getProviders 返回项不含 apiKey 属性**。
- handler 单测(node,mock service + 上游 fetch):POST /api/providers 201(响应无 apiKey)/400;GET /api/providers 索引(无 apiKey);GET /api/providers/:id/models 200(mock 上游 fetch 返回 {data:[{id:"glm-5.2"}]})/404/502(上游 500);POST /api/agents providerConfigId 不存在→400。
- 组件单测(jsdom):ProviderForm getByLabelText + 空名;ProviderList 纯展示三态 + agentCount;AgentForm provider 选项来自 providerConfigs prop、选定后 fetch models 填充 model 下拉、提交 body 含 providerConfigId+model;AgentList 卡片解析 provider 名 + model。
- 既有适配:agentService/agentsApi/AgentForm/createFlow(provider→providerConfigId+model、移除 PROVIDERS、fetch mock 应答 /api/providers)。
- 运行命令:`npm test`;边界:name 空、providerConfigId 不存在/为空、上游失败、apiKey 不泄漏。
- 运行时冒烟(verify):`npm run dev` + 真实浏览器(创建 provider 配置、创建 agent 选配置+模型、卡片显示)— 模型查询可用 mock 上游或用户提供真实配置;+ 截图。

## 4. UI 设计(ext-ui-design)

### 既有 Design System
沿用 token(森绿 #16a34a、--accent-strong #15803d)。无外部 DS。

### 信息架构
主区在 Skill 段后新增"创建 Provider 配置 + Provider 列表"段;AgentForm 的 provider 区改为"选配置 + 选模型"两步。

### 交互三态
ProviderForm 提交(idle/submitting/error/success + name 必填);ProviderList 纯展示(loading/empty/error+重试/success,带 agentCount);AgentForm model 下拉:选定 provider 后 loading(查询模型)/success(可选)/error(查询失败可重选)。

### 视觉系统
复用 token;provider 卡片同 skill 卡片样式;model 下拉用原生 select + token 边框。禁止紫蓝渐变/emoji。

### 可访问性(NFR-1)
ProviderForm 每输入 label(getByLabelText);apiKey 输入用 `type="password"`;按钮 ≥44px + focus-visible;对比度沿用 token。

## 5. 任务清单

- [x] T-1 ProviderConfig 数据层(model + 迁移 + seed + providerService) (覆盖: FR-1, FR-4) — 判据: model ProviderConfig + Agent(providerConfigId?/model);migrate 应用;seed 1 配置 + agent 关联;createProvider(name trim/空白)、getProviders(索引**无 apiKey**、含 agentCount)单测通过。
- [x] T-2 Provider API + 模型查询(POST/GET 索引 + GET /:id/models) (覆盖: FR-1, FR-2) — 判据: handler 单测 POST 201(响应无 apiKey)/400、GET 索引(无 apiKey)、GET /:id/models 200(mock 上游)/404/502 全通过。
- [x] T-3 agent 关联迁移(service 校验 + 去 PROVIDERS + 既有适配) (覆盖: FR-3, FR-5) — 判据: createAgent providerConfigId 不存在抛错、存在/为空通过单测;grep 无 PROVIDERS 残留;全量 npm test 绿。
- [x] T-4 Provider 管理 UI(ProviderForm + ProviderList 纯展示三态 + page providers fetch) (覆盖: FR-1 UI, FR-4 UI, NFR-1) — 判据: ProviderForm getByLabelText + apiKey type=password + 空名校验;ProviderList 三态 + agentCount;page 拥有 /api/providers fetch+status;**响应/UI 不含 apiKey**。
- [x] T-5 AgentForm 选配置+查模型+AgentList 显示 provider/model + build (覆盖: FR-3 UI, FR-4) — 判据: AgentForm provider 选项来自 providerConfigs prop、选定后 fetch /api/providers/:id/models 填充 model 下拉、提交 body 含 providerConfigId+model;AgentList 卡片显示 provider 名+model(null 时"未配置 provider");createFlow/集成适配;`npm run build` exit 0。
