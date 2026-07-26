# 001-skeleton 计划(行走骨架)

- 日期: 2026-07-26
- frame: ./frame.md

## 0. 范围外
(引自 frame.md)本切片不做:接 LLM / agent 执行逻辑 / 真实角色协作(后续切片);认证;部署;角色模板。骨架只交付"可运行空壳 + 最薄端到端 + 一键命令 + 可观察 UI"。

## 1. 需求

### FR-1: 一键启动应用
- 优先级: 必须
- 描述: 用户执行一条命令即可在本地启动应用,浏览器访问能看到页面。
- 验收标准:
  - Given 依赖已安装 When 执行 `npm run dev` Then 应用在 localhost 启动且 `GET /` 返回 200、HTML 含标题文本 `COOL AI`(见 §4 标题值)。
  - Given 默认端口被占 When 启动 Then Next 自动选下一可用端口(不崩溃)。

### FR-2: 一键运行全量测试
- 优先级: 必须
- 描述: 用户执行一条命令运行全部测试并通过。
- 验收标准:
  - Given 依赖已安装 When 执行 `npm test` Then 进程退出码为 0。
  - Given 存在失败测试 When 执行 `npm test` Then 退出码非 0(不掩盖失败)。

### FR-3: 最薄端到端数据通路(UI → API → DB → UI)
- 优先级: 必须
- 描述: 数据库存在种子记录时,首页能经由 API 读取到该真实记录的字段并渲染(非硬编码)。
- 验收标准:
  - Given DB 有种子 Agent(name="骨架 Agent") When 调 `GET /api/agents` Then 返回 200 且 body 含该 name。
  - Given 首页渲染 When API 返回 agents Then 页面渲染出该 name 文本。
  - Given DB 无 agent 记录 When `GET /api/agents` Then 返回 200 且 `{ agents: [] }`,UI 显示 empty 态文案。
  - Given DB 读取抛异常 When `GET /api/agents` Then 返回 500 且 body 含 error 字段,UI 进入 error 态并显示 error 文案 + 重试入口(重试为 error 态 UX,见 §4 组件契约)。

### FR-4: 基础 UI 布局(侧栏 + 主区)
- 优先级: 必须
- 描述: 首页具备侧栏(Agent/项目组列表区)与主区(消息流占位区)两栏结构。
- 验收标准:
  - Given 访问首页 Then 存在语义化 landmark:`<aside>`(侧栏,role=complementary)与 `<main>`(主区)。
  - Given 视口收窄(<640px) Then 布局降级为单列不溢出。

### 非功能需求(仅当有真实来源)
- NFR-1: 可访问性基线 — 要求: (a) 侧栏/主区为语义化 landmark 可被 role 选中;(b) 交互元素(重试按钮)键盘可达、`:focus-visible` 可见;(c) 正文文本对比度 ≥ 4.5:1。出处: ext-ui-design 计划阶段检查项(本特性含 UI)。验证方式: 组件测试用 `getByRole('complementary')`/`'main'` 断言 landmark;断言重试按钮存在且带 focus 样式类;对比度由 token 推导(白底 #ffffff × #0f172a ≈ 16:1,满足)。

## 2. 设计

### 现状与改动面
全新项目(绿地),无既有 Design System、无既有业务代码。本计划确立初始约定。新增:Next.js(App Router)应用、Prisma 数据层、REST API 层、design token(Tailwind 表达)、vitest+jsdom 测试基础设施。复用:已存在 `package.json`(vitest)与 `tests/baseline.test.ts`(并入新测试集)。

### 关键决策(仅真实决策点)
- PD-1: Next.js 脚手架方式 — 方案 A: `create-next-app` 新建子目录(各自 package.json,dev/test 命令分裂) / 方案 B: 手动把 Next.js 集成进现有仓库,保留单 `package.json` 与 vitest。选择 B:单清单管 dev/test/build,符合"一键命令"。
- PD-2: 数据获取分层 — 方案 A: Server Component 直读 Prisma(跳过 HTTP 层) / 方案 B: Client Component `fetch('/api/agents')` 经 REST 穿透三层。选择 B:骨架要真实穿透 UI→API→DB 全部关键层(frame:占位层不可以),REST 端点后续 client 交互复用。
- PD-3: API 逻辑组织 — 方案 A: 逻辑直接写在 route handler 内(文件少,但 handler 难独立单测、需起 Next 运行时) / 方案 B: handler 保持 thin,业务放进 `src/server/agentService.ts` 可独立单测,handler 只做 try/catch + HTTP 格式化。选择 B:可独立单测是骨架建立测试基础设施的关键收益;代价是多一个文件,可接受。

### 接口与数据契约
- Prisma schema (`prisma/schema.prisma`):
  - `model Agent { id Int @id @default(autoincrement()); name String; role String; createdAt DateTime @default(now()) }`
  - datasource provider = sqlite, url = env(DATABASE_URL),默认 `file:./prisma/dev.db`
- REST: `GET /api/agents` → `200 { agents: [{id, name, role}] }` | 空 → `200 { agents: [] }` | 异常 → `500 { error: string }`
- Seed: 一条 `{ name: "骨架 Agent", role: "占位角色" }`
- 组件契约 `AgentList`(client component):无必填 props(自行 `fetch('/api/agents')`);内部状态机 `status ∈ {loading, success, empty, error}`;error 态含"重试"按钮(点击重置为 loading 并重新 fetch)。测试时可注入初始 status 以断言各态。

### 错误处理
- `agentService.getAgents()` 抛错 → 路由 catch → 500 + `{ error }`,不泄漏堆栈到 body。
- Client fetch 非 2xx / 网络失败 → AgentList 进入 error 态显示"加载失败"+ 重试入口。
- DB 文件缺失/未迁移 → 表现为 500;测试与 smoke 前用 `prisma migrate deploy` + seed 保证就绪。

## 3. 测试策略
- 分层:
  - 服务/数据层单测(node env):`agentService.getAgents()` 三态——读种子数据、空、异常(独立 test DB `DATABASE_URL=file:./prisma/test.db`,`beforeAll` migrate+seed,`beforeEach` 清表)。
  - 组件单测(jsdom env,文件首行 `// @vitest-environment jsdom`):`AgentList` 四态(loading/empty/error/success),用 `@testing-library/react` + `@testing-library/jest-dom` 断言文案、重试按钮、landmark role。
  - handler 层:thin,逻辑在 service(已单测);handler 的 HTTP 格式化与 500 路径由 verify 阶段真实 smoke 覆盖(起 `npm run dev` 探活 `/api/agents`),不在单测层重复(理由见 PD-3)。
- 可访问性验证(NFR-1):组件测试断言 `getByRole('complementary')`/`'main'` 存在;重试按钮可选中且带 focus 样式类;对比度由 token 推导(§4)。
- 测试数据:Prisma test DB + seed;不依赖网络。
- 运行命令:`npm test`(vitest)。
- 必须覆盖的边界:空数组、读取异常、渲染降级(窄屏)、四态文案。

## 4. UI 设计(ext-ui-design)

### 既有 Design System
绿地项目,无既有 Design System / 品牌规范;本骨架确立初始 token(后续切片复用)。

### 信息架构
单页两栏:`<aside>` 侧栏(顶部标题 `COOL AI`;Agent 列表区,后续承载项目组切换)+ `<main>` 主区(消息流占位,骨架阶段显示欢迎语"消息流将在此显示")。

### 交互四态(AgentList)
- loading: 首次拉取中 → "加载中…"。
- empty: `agents=[]` → "暂无 Agent(后续可在侧栏创建)"。
- error: fetch 失败/非 2xx → "加载失败,请重试" + "重试"按钮(重置状态机并重新 fetch)。
- success: 渲染每条 agent 的 name + role。

### 视觉系统(初始 design token)
- 色板:中性灰为底(`--bg #ffffff` / `--bg-subtle #f8fafc` / `--text #0f172a` / `--text-muted #64748b` / `--border #e2e8f0`);主色克制蓝 `--accent #2563eb` 仅用于焦点/链接。**禁止**无理由紫蓝渐变。
- 字体:系统字体栈(`-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`),不引入 Inter 或外链字体。
- 间距/圆角/阴影:`--space 8/12/16px`、`--radius 6px`、单一 `--shadow-sm`。全部走 Tailwind theme token / CSS 变量,不硬编码。
- 样式工具选型:Tailwind CSS(假设 A-13,待确认;可逆,不影响数据通路)。
- 占位资产:缺图标用语义占位符 `{{ icon:agent }}` 文本位,不自画 SVG、不用 emoji 当图标。

### 反 AI 默认审美
不使用:无理由紫蓝渐变主色、Inter/Roboto 默认外链字体、"左彩条+圆角卡片" callout、emoji 当图标、未要求的装饰动效/glassmorphism/多套阴影。

### 可访问性
对比度达 WCAG AA(白底 × #0f172a ≈ 16:1,满足);`<aside>`/`<main>` 语义化;交互元素键盘可达、`:focus-visible` 可见;触控目标 ≥ 44×44px(重试按钮)。

## 5. 任务清单

- [x] T-1 脚手架 + 最薄端到端(硬编码穿透)+ 测试基础设施 (覆盖: FR-1, FR-2) — 判据: 手动集成 Next.js App Router(加 next/react/react-dom 依赖、app/layout.tsx+page.tsx、next.config.mjs、tsconfig.json);装 vitest node+jsdom 环境、@testing-library/react、@testing-library/jest-dom;新增 `/api/agents` 返回硬编码数组、首页 client fetch 并渲染;一条组件测试先红(无页面)后绿(渲染硬编码 name);`npm run dev` 探活 `/` 返回 200 且含 `COOL AI`;`npm run build` exit 0。
- [x] T-2 Prisma 数据层 + agentService + seed (覆盖: FR-3) — 判据: schema `model Agent`;Prisma client 单例;seed 一条记录;`agentService.getAgents()` 三态单测(数据/空/异常)通过(test DB migrate+seed+清表)。
- [x] T-3 /api/agents 接 service + 错误处理 (覆盖: FR-3) — 判据: thin handler 调 `agentService.getAgents()`;空→`{agents:[]}`、异常→500 `{error}`、不泄漏堆栈;handler 层由 verify smoke 覆盖(PD-3 理由),单测层不重复。
- [x] T-4 AgentList 四态 + 布局 + 可访问性 (覆盖: FR-3, FR-4, NFR-1) — 判据: 组件状态机 loading/empty/error/success;error 态含重试按钮;jsdom 组件测试覆盖四态文案 + 重试按钮;`getByRole('complementary')`/`'main'` 断言通过;窄屏单列(断言或 build);focus 样式存在。
- [x] T-5 README + 一键命令 + .gitignore (覆盖: FR-1, FR-2) — 判据: `package.json` 含 `dev`/`test`/`build` 脚本;README 写明 `npm run dev` 与 `npm test` 两条命令及访问地址;`.gitignore` 忽略 `node_modules/`、`.next/`、`prisma/*.db`、`prisma/test.db*`;`npm test` exit 0。
