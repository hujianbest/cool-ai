# 003-skill-management 计划

- 日期: 2026-07-26
- frame: ./frame.md

## 0. 范围外
(引自 frame.md)不做 skill 内容加载/执行注入(S-3)、skill edit/delete(A-16 推迟)、Skills Hub 联网/agentskills.io 同步、skill bundle、frontmatter 高级字段、agent 执行/LLM。本切片只交付"skill 被管理 + agent 关联已有 skill + 关联可见"。

## 1. 需求

### FR-1: 创建 skill
- 优先级: 必须
- 描述: 用户能通过 UI 表单(名/描述/content/category)创建 skill 并保存;名字做 trim、空白校验(与 S-2 agent name 一致)。
- 验收标准:
  - Given 填齐名字 When 提交 Then POST /api/skills 返回 201,body.skill 含 {id,name,description,content,category},name 为 trim 后值。
  - Given 名字为空/全空白 When 提交 Then UI 显示"必填"且不发请求;API 侧 name 缺失/空白 → 400。

### FR-2: 查看 skill(索引 + 详情)
- 优先级: 必须
- 描述: GET /api/skills 返回轻量索引(含被关联 agent 数);GET /api/skills/:id 返回全文;UI 列出 skill 索引。
- 验收标准:
  - Given 已有 skill When GET /api/skills Then 200,每项含 {id,name,description,category,agentCount},不含 content。
  - Given skill id 存在 When GET /api/skills/:id Then 200,body.skill.content 为全文。
  - Given id 不存在 When GET /api/skills/:id Then 404。

### FR-3: agent 关联已有 skill(替换静态勾选)
- 优先级: 必须
- 描述: 创建 agent 时,skills 字段为从"已有 skill 列表"多选(选项由父组件从 GET /api/skills 获取后下传);保存 agent.skills 为 skill id 数组。
- 验收标准:
  - Given 系统已有 skill [A,B] When 渲染 AgentForm(skills=[A,B] 由父传入)Then skills 选项为 A、B(非静态常量)。
  - Given 勾选 A When 创建 agent Then POST /api/agents body.skills 为 [A 的 id]。
  - Given body.skills 含不存在的 id When POST /api/agents Then 400。

### FR-4: 关联关系可见
- 优先级: 必须
- 描述: agent 卡片显示其关联的 skill 名字(由 id 解析);skill 索引显示被多少 agent 关联(后端聚合 agentCount)。
- 验收标准:
  - Given agent 关联 skill A When 渲染 agent 卡片(传入 skills 索引)Then 显示 A 的名字(非裸 id)。
  - Given skill A 被 2 个 agent 关联 When GET /api/skills Then A 的 agentCount=2,UI 显示"被 2 个 agent 关联"。

### FR-5: 迁移既有(去静态池)
- 优先级: 必须
- 描述: 移除 src/shared/agentOptions.ts 的 SKILLS 常量;Agent.skills 语义由静态字符串改为 skill id 数组;S-2 引用 SKILLS 的代码与测试全部适配,全量测试绿。
- 验收标准:
  - Given 改动完成 When grep SKILLS 于 src/ 与 tests/ Then 无残留引用。
  - When npm test Then 全绿(含 S-2 既有用例适配后)。

### 非功能需求
- NFR-1: skill 表单可访问性与对比度 — 要求: 每个输入 `<label>` 关联(getByLabelText)、键盘可达、提交按钮 ≥44px、focus-visible;主按钮用 `--accent-strong #15803d`(白字对比度 ≈5.6:1 满足 AA,沿用 S-2 验证)。出处: ext-ui-design + S-2 基线。验证: 组件测试 getByLabelText + focus 样式。

## 2. 设计

### 现状与改动面
复用 S-1/S-2 的 Next.js+Prisma+token+测试基础设施。改动:
- `prisma/schema.prisma`:**新增** `model Skill { id Int @id @default(autoincrement()); name String; description String @default(""); content String @default(""); category String @default(""); createdAt DateTime @default(now()) }`。**纯加性迁移**(仅加表,不动 Agent 列)。
- 迁移:`prisma migrate dev --name add_skill`。加性迁移通常无需清库;若非交互环境触发 drift 提示,则清空 dev.db(仅 seed)后重跑。
- `src/server/skillService.ts`(新):createSkill / getSkills(索引 DTO,含 agentCount)/ getSkill(全文)。
- `src/server/agentService.ts`:createAgent 对 skills 做"id 存在性校验"(传入 skill id 数组,校验全部存在,未知 → ValidationError);AgentDTO.skills 为 `number[]`。
- `src/shared/agentOptions.ts`:移除 SKILLS(PROVIDERS/TOOLS 保留)。
- `app/api/skills/route.ts`(新):POST、GET(索引)。`app/api/skills/[id]/route.ts`(新):GET 详情。
- `components/SkillForm.tsx`(新)、`components/SkillList.tsx`(新,**纯展示**)。
- `components/AgentForm.tsx`:契约改 `({onCreated, skills: SkillIndexDTO[]})`——skills 选项**由父传入**(不再自 fetch);勾选存 id。
- `components/AgentList.tsx`:契约改 `({version=0, skills: SkillIndexDTO[] = []})`——用 skills 解析 agent.skills id→name 显示;`skills` 默认 `[]`(保既有三态用例不破)。
- `app/page.tsx`:**统一 fetch /api/skills**(skillsVersion + skillsStatus: loading/empty/error/success + retry),作为单一数据源;把 skills 下传 AgentForm(选项)、AgentList(解析名)、SkillList(渲染);skill/agent 创建后自增 skillsVersion 刷新。

### 关键决策(仅真实决策点)
- PD-1: skill 索引是否含 content — A: 含全文 / B: 仅 {id,name,description,category,agentCount},详情单独取。选 B:对标 Hermes progressive disclosure,索引轻量。
- PD-2: agent.skills 校验 — A: 仅存不校验(允许悬挂引用) / B: createAgent 校验 skill id 全部存在,未知抛 400。选 B:entity 引用应有引用完整性。
- PD-3: skills 数据获取位置 — A: 各组件自 fetch /api/skills / B: 父 page.tsx 统一 fetch 后下传(AgentForm 选项、AgentList 解析、SkillList 渲染共用,SkillList 为纯展示组件带 status prop)。选 B:单一数据源、避免多次请求与不一致;刷新用一个 skillsVersion 控制;SkillList 不自 fetch,三态由父传入 status 驱动。
- PD-4: skill CRUD 范围 — A: 全 CRUD / B: 仅 create+list+view。选 B:YAGNI(A-16)。
- PD-5: skill 被关联数(agentCount)计算位置 — A: 后端在 getSkills 聚合(加载 agents 计数) / B: 前端拿 agents 自行计数。选 A:SkillList 只渲染 DTO 字段、无需 agents 数据;后端加载 agents 的 skills 列计数,MVP 数据量可接受。

### 接口与数据契约
- Prisma Skill:`{id, name, description, content, category, createdAt}`。
- SkillIndexDTO:`{id, name, description, category, agentCount}`(无 content);SkillDTO(详情):`{id, name, description, content, category, createdAt}`。
- REST:
  - `POST /api/skills` body `{name, description?, content?, category?}` → `201 {skill: SkillDTO}`;name 空/空白 → 400。
  - `GET /api/skills` → `200 {skills: SkillIndexDTO[]}`。
  - `GET /api/skills/:id` → `200 {skill: SkillDTO}` | 404。
  - `POST /api/agents` body.skills 改为 `number[]`;含未知 id → 400。
- 组件契约:
  - `AgentForm({onCreated: ()=>void, skills: SkillIndexDTO[]})` — skills 选项由父传入;勾选存 id。
  - `AgentList({version=0, skills: SkillIndexDTO[] = []})` — 用 skills 把 agent.skills(id)解析成名。
  - `SkillList({status: 'loading'|'empty'|'error'|'success', skills: SkillIndexDTO[], onRetry: ()=>void})` — 纯展示组件,按 status 渲染三态;数据与拉取由父 page.tsx 拥有(见 PD-3)。

### 错误处理
- skill name 空/空白 → 400(后端 trim);agent.skills 含未知 id → 400;GET 不存在 id → 404;其余 500 不泄漏堆栈。
- 前端:SkillForm/SkillList 提交与加载沿用 idle/submitting/error 三态(S-2 模式)。

## 3. 测试策略
- 服务层单测(node):skillService createSkill(name trim/空白抛错)、getSkills(索引无 content、含 agentCount)、getSkill(全文/不存在抛);agentService.createAgent 对 skills"未知 id 抛 ValidationError""已知 id 通过"单测(先建 skill 再建 agent)。
- handler 单测(node,mock service):POST /api/skills 201/400(name 空);GET /api/skills 索引;GET /api/skills/:id 200/404;POST /api/agents 含未知 skill id → 400。
- 组件单测(jsdom):SkillForm 渲染 label + 空名/空白校验;SkillList 纯展示三态(传入 status=loading/empty/error/success 断言对应文案 + 重试按钮,对标 AgentList.test);AgentForm skills 选项来自 props + 勾选存 id;AgentList 卡片用 skills 解析出名字(skills 默认 [] 时既有三态用例不破)。
- 既有适配:agentService.test(createAgent 用 skill id + 先建 skill)、agentsApi.test(POST 校验 + 未知 id→400)、AgentForm/createFlow 适配(传 skills prop、fetch mock 应答 /api/skills)。
- 运行命令:`npm test`;边界:skill name 空/空白、未知 skill id、索引无 content、agentCount、关联名解析。
- 运行时冒烟(verify):`npm run dev` + 真实浏览器(创建 skill、创建 agent 关联该 skill、卡片显示 skill 名、skill 索引显示被关联数)+ 截图。

## 4. UI 设计(ext-ui-design)

### 既有 Design System
沿用 S-1/S-2 token(森绿 #16a34a、--accent-strong #15803d、中性灰、圆角/阴影)。无外部 DS。

### 信息架构
主区三段:`<section>` Skill 管理(SkillForm + SkillList 索引)+ `<section>` 创建 Agent(AgentForm)+ `<section>` Agent 列表(AgentList,卡片含关联 skill 名)。侧栏保持标题。

### 交互三态
- SkillForm 提交:idle/submitting/error/success + 名字必填(字段级),沿用 S-2 模式。
- SkillList 加载(纯展示,由父传入 status):loading(“加载中…”)/ empty(“暂无 skill”)/ error(“加载失败”+重试,点 onRetry)/ success(索引卡片,含 agentCount 小标签),对标 AgentList。

### 视觉系统
复用 token;skill 索引项 `rounded-token border-line bg-surface p-3` 卡片,agentCount 用 `text-muted` 小标签。禁止紫蓝渐变/emoji/glassmorphism。

### 可访问性(NFR-1)
SkillForm 每输入 `<label htmlFor>`(getByLabelText);键盘可达;按钮 ≥44px + focus-visible;主按钮 #15803d×#fff≈5.6:1(沿用 S-2)。

## 5. 任务清单

- [x] T-1 Skill 数据层(model + 加性迁移 + seed + skillService) (覆盖: FR-2) — 判据: model Skill;migrate 应用;seed 2 条 skill;getSkills 索引单测(无 content、含 agentCount)、getSkill 全文/不存在单测、createSkill(name trim/空白)单测通过。
- [x] T-2 Skill API(POST + GET 索引 + GET /:id) (覆盖: FR-1, FR-2) — 判据: handler 单测 POST 201/400(name 空/空白)、GET 索引(含 agentCount)、GET /:id 200/404 全通过。
- [x] T-3 agent 关联迁移(service 校验 + 去 SKILLS 常量 + 既有适配) (覆盖: FR-3, FR-5) — 判据: createAgent 未知 skill id 抛错、已知 id 通过单测;`src/`+`tests/` grep 无 SKILLS 残留;全量 npm test 绿(含 agentService/agentsApi/AgentForm/createFlow 适配)。
- [x] T-4 Skill 管理 UI(SkillForm + SkillList 纯展示三态 + page 拥有 skills fetch) (覆盖: FR-1 UI, FR-2 UI, NFR-1) — 判据: SkillForm getByLabelText + 空名/空白校验;SkillList 传入 status 断言 loading/empty/error(重试)+success(agentCount 显示);page 拥有 /api/skills fetch+status+retry,按 status 渲染 SkillList;skill 创建后 skillsVersion 自增刷新。
- [x] T-5 AgentForm skills 多选(父传)+ AgentList 关联名解析 + build (覆盖: FR-3 UI, FR-4) — 判据: AgentForm skills 选项来自父传 prop、勾选存 id;AgentList 卡片用 skills 解析出名(skills 默认 [] 既有用例不破);createFlow 集成测试(建 skill → 建 agent 关联 → 卡片显示 skill 名);`npm run build` exit 0。
