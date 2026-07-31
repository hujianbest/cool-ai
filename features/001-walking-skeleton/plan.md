# 行走骨架计划

- 日期: 2026-07-29
- frame: ./frame.md

## 1. 需求

### FR-1: 一条命令启动与测试
- 优先级: 必须
- 描述: owner 按 README 中各一条命令即可启动本地 Web 应用和运行全量自动化测试。
- 验收标准:
  - Given 已安装 README 声明的 Node.js 环境并完成依赖安装 When 执行 `npm run dev` Then 本地地址可访问并呈现协作驾驶舱。
  - Given 依赖已安装 When 执行 `npm test` Then 全量测试结束且进程退出码为 0。
  - Given 必要环境不满足 When 启动失败 Then README 能让 owner 定位 Node 版本、端口或数据目录问题，而不是依赖未记录的手工步骤。

### FR-2: 创建并持久化示例项目
- 优先级: 必须
- 描述: owner 能在 Web UI 创建一个项目，项目被真实写入 SQLite 并立即出现在项目导航中。
- 验收标准:
  - Given 当前没有项目 When owner 输入非空项目名并提交 Then 新项目出现在左侧项目导航中且自动成为当前项目。
  - Given 项目已经创建 When owner 刷新页面 Then 该项目仍从 SQLite 加载并保持可选择。
  - Given 项目名去除首尾空白后为空 When owner 提交 Then UI 显示可理解的校验提示且数据库中不新增项目。

### FR-3: 提交并运行确定性示例任务
- 优先级: 必须
- 描述: owner 能给当前项目提交目标；确定性示例 Agent 依次留下 queued、running、completed 状态并返回结果，全部状态与结果由服务端持久化。
- 验收标准:
  - Given 已选中项目且目标非空 When owner 提交任务 Then 中间事件流先显示排队与运行状态，最终显示完成状态和确定性结果。
  - Given 任务已经完成 When owner 刷新页面 Then 事件流仍显示目标、最终状态和结果。
  - Given 未选中项目或目标去除首尾空白后为空 When owner 尝试提交 Then 提交控件禁用或显示校验提示，服务端拒绝非法请求。
  - Given 项目不存在或任务状态不允许再次运行 When API 收到请求 Then 返回结构化 404 或 409 错误，不产生孤立任务或重复执行。

### FR-4: 关键界面状态可恢复
- 优先级: 必须
- 描述: 项目导航、事件流和右侧上下文在 loading、empty、error 三态下都给出可操作反馈。
- 验收标准:
  - Given 首次进入且数据尚未返回 When 页面加载 Then 对应区域显示非阻塞 loading 状态，并避免把“尚未加载”误报为“没有数据”。
  - Given 没有项目或当前项目没有任务 When 加载完成 Then 显示带下一步动作的 empty 状态。
  - Given API 请求失败 When 页面无法加载或提交 Then 显示错误摘要与重试入口，已输入的项目名或目标不被静默清空。

### FR-5: 协作驾驶舱形成真实入口
- 优先级: 必须
- 描述: 首屏按产品决策呈现项目/使命导航、群聊与事件流、任务上下文三部分，并在窄屏保持可操作。
- 验收标准:
  - Given 桌面宽度 When owner 打开首页 Then 左侧项目导航、中间事件流和右侧当前任务上下文同时可见，页面中每个区域都对应 FR-2 或 FR-3 的真实数据。
  - Given 窄屏宽度 When owner 打开首页 Then 主事件流保持可用，左侧导航和右侧上下文可通过明确控件打开，不发生水平溢出。
  - Given owner 仅使用键盘 When 在创建项目、选择项目和提交任务之间导航 Then 焦点顺序合理且焦点指示清晰可见。

### 非功能需求
- NFR-1: 可访问性 — 要求: 正文与交互文本对比度满足 WCAG AA，交互目标至少 44×44px，关键操作可通过键盘完成且焦点可见 — 出处: product/product.md 与 ext-ui-design — 验证方式: 组件断言、浏览器键盘冒烟和渲染截图人工核对。

## 2. 设计

### 现状与改动面
仓库当前只有 Node.js 内置测试形成的可运行基线，没有应用代码。S-1 新增单仓 Next.js App Router 应用、服务端 SQLite 数据访问、项目与任务服务、Route Handler、客户端协作驾驶舱、测试配置和 README。真实 provider、技能、多人接力、共享记忆与工作区工具保持在 frame 的范围外。

初始目录约定:

- `app/`: 页面、全局样式与 `/api` Route Handler。
- `components/`: 客户端协作驾驶舱及只负责呈现的子组件。
- `src/server/`: 仅服务端可导入的 SQLite、项目与任务业务逻辑。
- `src/shared/`: UI 与服务端共享的 JSON 契约和状态枚举，不含密钥或数据库句柄。
- `tests/`: 服务、组件与契约测试；测试数据库使用临时路径。
- `.data/`: 本地 SQLite 数据文件，加入 `.gitignore`。

### 关键决策

#### D-1: 首条端到端路径的进程边界
- 方案 A: Next.js 页面与 Route Handler 同进程，确定性任务执行也在请求内完成。优点是一个 dev 命令、调试链最短；缺点是不具备长任务恢复能力。
- 方案 B: 从 S-1 起拆出独立 API 与 worker。优点是接近后续自治执行；缺点是尚无相关 FR，会让骨架先承担进程编排、队列与恢复设计。
- 选择: 方案 A。S-1 只证明 UI → 业务逻辑 → SQLite → UI 回显的集成风险；后续长任务切片再以已验证需求引入 worker，避免为未来预建。

#### D-2: SQLite 访问方式
- 方案 A: 使用当前 Node.js 提供的 `node:sqlite`，不引入原生扩展或 ORM 生成步骤。优点是本机 Node 24 环境无需额外工具链；缺点是数据库抽象较薄。
- 方案 B: 使用 Prisma 或原生扩展驱动。优点是 schema/migration 工具成熟；缺点是对只有两张表的骨架增加生成、二进制与构建复杂度。
- 选择: 方案 A。通过很薄的 `src/server/db.ts` 集中 schema 初始化和参数化 SQL；不提前发明通用 repository 层。

#### D-3: 示例任务的状态呈现
- 方案 A: 一个请求直接返回 completed，UI 只显示最终结果。实现最少，但无法闭合 backlog 对 queued/running/completed 可见性的要求。
- 方案 B: 创建、开始、执行是三个明确服务端动作；每次动作同时更新任务当前状态并追加不可变状态事件，客户端按顺序调用并渲染服务端返回事件。
- 选择: 方案 B。它让 queued、running、completed/failed 都是可读取的持久事实，而不是根据“请求尚未结束”推断。S-1 仍不引入后台 worker；客户端收到 running 后再调用确定性 execute。

### 接口与数据契约

共享 JSON 类型:

```ts
type Project = {
  id: string;
  name: string;
  createdAt: string;
};

type TaskStatus = "queued" | "running" | "completed" | "failed";

type TaskRun = {
  id: string;
  projectId: string;
  goal: string;
  status: TaskStatus;
  result: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

type TaskEvent = {
  id: string;
  taskId: string;
  sequence: number;
  status: TaskStatus;
  message: string;
  createdAt: string;
};

type ApiError = {
  error: { code: string; message: string };
};

type TaskFailureResponse = {
  task: TaskRun;
  events: TaskEvent[];
  error: { code: "TASK_EXECUTION_FAILED"; message: string };
};
```

SQLite:

- `projects(id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL)`
- `task_runs(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), goal TEXT NOT NULL, status TEXT NOT NULL, result TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`
- `task_events(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES task_runs(id), sequence INTEGER NOT NULL, status TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(task_id, sequence))`
- 数据库路径由 `COCKPIT_DB_PATH` 指定，默认 `.data/cockpit.sqlite`；服务首次启动幂等创建目录与表。
- 事件按同一任务内单调递增的 `sequence` 排序；项目时间线按 `createdAt ASC, id ASC` 稳定排序。任务当前状态与对应最后一条事件在同一 SQLite 事务中写入。

HTTP:

- `GET /api/projects` → `200 { projects: Project[] }`
- `POST /api/projects`，body `{ name: string }` → `201 { project }`；空名称 → `400 EMPTY_PROJECT_NAME`
- `GET /api/projects/:projectId/tasks` → `200 { tasks: TaskRun[], events: TaskEvent[] }`；项目不存在 → `404 PROJECT_NOT_FOUND`
- `POST /api/projects/:projectId/tasks`，body `{ goal: string }` → `201 { task, events }`，持久化 queued 与 sequence 1 事件；空目标 → `400 EMPTY_GOAL`
- `POST /api/tasks/:taskId/start` → `200 { task, events }`，仅允许 queued→running 并追加事件；不存在 → `404 TASK_NOT_FOUND`；非法状态 → `409 TASK_NOT_STARTABLE`
- `POST /api/tasks/:taskId/execute` → `200 { task, events }`，仅允许 running→completed 并追加事件；不存在 → `404 TASK_NOT_FOUND`；非法状态 → `409 TASK_NOT_EXECUTABLE`
- 所有接收 JSON 的接口: 畸形 JSON → `400 INVALID_JSON`；字段类型错误 → `400 INVALID_INPUT`。
- SQLite 打开、建表或写入不可用 → `503 STORAGE_UNAVAILABLE`；未知异常 → `500 INTERNAL_ERROR`。
- 确定性执行抛错时，在同一事务写 failed 与事件，返回 `500 TaskFailureResponse`；客户端以响应中的 task/events 更新时间线。

确定性结果只回显经截断的目标摘要和“示例 Agent 已完成骨架任务”，不调用模型、不读写项目工作区，也不伪装成真实 Agent 推理。

### 错误处理
- Route Handler 区分 JSON 解析、字段类型、领域冲突、存储不可用和未知异常，按 HTTP 契约返回稳定 code；未知错误只向 UI 返回通用消息，详细堆栈留在服务端。
- execute 若抛错则以事务写 failed 与事件，并返回 `TaskFailureResponse`，避免任务永久卡在 running。
- 客户端请求使用单一 fetch 包装解析 `ApiError`。加载失败保留已有界面并提供重试；提交失败保留输入。
- SQLite 路径不可创建或打开时启动/请求明确失败，不退化为内存数据，以免骨架绕过真实持久化。

## 3. 测试策略

- 服务层: 使用临时 SQLite 文件验证项目创建、空值校验、任务状态转换、非法重跑、关联项目不存在和刷新后重新读取。
- API 契约: 直接调用 Route Handler 或其薄适配验证成功响应、畸形 JSON、字段类型、404、409、执行失败、存储不可用与未知异常的状态码及稳定 code，不 mock 业务服务。
- 组件: Vitest + Testing Library + jsdom，覆盖 loading / empty / error、保留输入、禁用态、键盘焦点与三栏数据呈现；网络边界可替换 fetch，但不替换服务层存储测试。
- 构建: `npm run build` 验证 Next.js 生产构建、服务端模块边界与 TypeScript。
- 浏览器冒烟: 启动真实应用，通过浏览器创建项目和任务、刷新后核对持久化，并保存桌面截图；窄屏至少核对无水平溢出与上下文抽屉入口。
- 全量测试命令: `npm test`。Windows 中所有 HarnessFlow 证据命令设置 `PYTHONUTF8=1`，npm 经 `cmd /c` 调用。

## 4. UI 设计

### 信息架构
- 单一路由 `/` 即协作驾驶舱，避免骨架阶段引入空页面。
- 左栏（248px）: 产品标识、项目列表、创建项目入口；仅展示真实项目数据。
- 中栏（弹性宽度，最小 480px）: 当前项目标题、示例 Agent 身份、任务目标输入、按时间排序的状态/结果事件。
- 右栏（320px）: 当前任务上下文，展示目标、状态、更新时间与结果摘要；没有任务时给出下一步提示。
- 小于 900px 时左栏变为可打开导航，右栏变为上下文抽屉；中栏保持主操作面。

### 关键交互状态
- 首次加载: 三栏对应区域使用静态骨架块并带 `aria-busy`，不使用无限装饰动画。
- 无项目: 中栏说明“先创建项目”，创建入口聚焦可达；右栏不展示伪任务。
- 无任务: 中栏显示任务输入和简短下一步；右栏显示空上下文。
- 请求错误: 区域内错误摘要 + “重试”按钮；项目名/目标输入保持。
- 提交中: 按钮 disabled 并显示明确文本；任务创建后显示 queued，run 请求期间显示 running，完成后显示 completed。
- 成功: 新项目自动选中；任务完成后上下文同步更新，不额外播放装饰动画。
- 焦点: 创建成功后焦点移到当前项目标题；任务完成后以 `aria-live="polite"` 宣告状态。

### 视觉系统
- 原始视觉值只允许出现在 `app/tokens.css`；组件样式必须引用具名 custom property。测试静态扫描其他 CSS，拒绝颜色字面量以及未引用 token 的字号、间距、圆角或阴影。
- 字体 token: `--font-sans: "Segoe UI Variable", "Microsoft YaHei UI", system-ui, sans-serif`，不引入 Inter/Roboto。
- 颜色 token:
  - `--canvas: #F3EFE7`
  - `--surface: #FFFDF8`
  - `--surface-muted: #ECE6DB`
  - `--text: #28241F`
  - `--text-muted: #6B645B`
  - `--border: #D7CEC0`
  - `--accent: #4E756D`
  - `--agent-warm: #A75F49`
  - `--success: #3F6A4D`
  - `--warning: #86662F`
  - `--danger: #A0443F`
- 字号/行高 token: `--text-xs: 0.75rem/1rem`、`--text-sm: 0.875rem/1.25rem`、`--text-md: 1rem/1.5rem`、`--text-lg: 1.25rem/1.75rem`、`--text-xl: 1.75rem/2.25rem`。
- 间距 token: `--space-1: 0.25rem`、`--space-2: 0.5rem`、`--space-3: 0.75rem`、`--space-4: 1rem`、`--space-6: 1.5rem`、`--space-8: 2rem`。
- 圆角 token: `--radius-sm: 0.5rem`、`--radius-md: 0.75rem`、`--radius-lg: 1rem`。
- 阴影/焦点 token: `--shadow-panel: 0 0.625rem 1.875rem rgba(77, 65, 49, 0.10)`、`--focus-ring: 0 0 0 0.1875rem rgba(78, 117, 109, 0.35)`。
- 布局 token: `--sidebar-width: 15.5rem`、`--context-width: 20rem`、`--content-min: 30rem`、`--control-min: 2.75rem`、`--breakpoint-cockpit: 56.25rem`。CSS 不能在 media query 中读取 custom property，因此断点字面量只在 `tokens.css` 的具名响应式区出现，并由静态测试核对其与 token 一致。
- Agent 头像使用文字/几何占位组件，强调色仅用于头像、状态点和细边框，不用 emoji、不自画 SVG。

### 可访问性与内容
- 语义化 `nav`、`main`、`aside`、`form` 和标题层级；按钮和输入均有可见 label。
- 所有交互目标最小 44×44px；`:focus-visible` 使用高对比双层轮廓。
- 状态不只依赖颜色，始终配合文本。
- 首版文案只描述真实功能；不添加营销数字、虚构 Agent 对话或未实现入口。

## 5. 任务清单

- [x] T-1 打通创建项目的最薄端到端路径 (覆盖: FR-2) — 判据: 从失败测试开始，实现 SQLite 项目持久化、项目 API 与最小页面创建/回显；服务、API 契约和组件测试通过
- [x] T-2 建立任务状态机与持久事件契约 (覆盖: FR-3) — 判据: 从失败服务/API 测试开始，实现 queued→running→completed/failed 事务、稳定事件排序及 400/404/409/500/503 错误契约；服务和 API 测试通过
- [x] T-3 接入任务事件流与恢复交互 (覆盖: FR-3, FR-4) — 判据: 从失败组件测试开始，实现 create→start→execute 顺序调用、事件流、刷新恢复、loading/empty/error/disabled/success 与输入保留；组件测试通过
- [x] T-4 落地桌面协作驾驶舱与视觉 token (覆盖: FR-5, NFR-1) — 判据: 从失败结构/静态样式测试开始，实现桌面三栏、具名 token、44px 控件、状态非纯颜色表达；测试证明组件 CSS 无硬编码视觉值
- [x] T-5 完成窄屏与键盘可访问性 (覆盖: FR-5, NFR-1) — 判据: 从失败交互测试开始，实现导航/上下文抽屉、无水平溢出、合理焦点顺序、focus-visible 与 aria-live；组件及浏览器键盘检查通过
- [x] T-6 收口一键开发验证与真实渲染 (覆盖: FR-1, FR-4, FR-5, NFR-1) — 判据: README 的 dev/test 命令可复现，`npm test` 与 `npm run build` 通过，真实浏览器完成创建项目和任务、刷新恢复及窄屏检查并产出 smoke/demo 证据
