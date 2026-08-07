# UI 交互体验优化 计划

- 日期: 2026-08-07
- frame: ./frame.md

## 1. 需求

### FR-1: macOS 优先字体栈
- 优先级: 必须
- 描述: `--font-sans` 以 `-apple-system`、`"PingFang SC"`、`"Noto Sans SC"` 优先，Windows 下回退 `"Segoe UI Variable"` / `"Microsoft YaHei UI"`。
- 验收标准:
  - Given tokens.css 解析完成 When 读取 `--font-sans` Then 以 `-apple-system` 开头且含 `PingFang SC`/`Segoe UI Variable`/`Microsoft YaHei UI`（实际命中字体与无布局偏移由人工验收）

### FR-2: ActivityBar 垂直图标导航轨
- 优先级: 必须
- 描述: 新建 `components/activity-bar.tsx`，48px 宽竖轨，内联 SVG 图标 + tooltip，承载"工作""团队"导航，替代侧栏内文字 nav。
- 验收标准:
  - Given 驾驶舱任意页面 When 渲染 Then 48px 宽 `role="navigation"` 轨出现在三栏左侧，内含 ≥2 按钮
  - Given 焦点在 ActivityBar When Tab 遍历 Then 焦点环 `--focus-ring` 可见
  - Given 鼠标悬停图标 When hover Then tooltip 显示，背景进入 hover 态
  - Given 当前路由 `/` When 渲染 Then "工作"按钮有 `aria-current="page"`
  - Given 窄屏（≤56.25rem）When 渲染 Then ActivityBar 可见且不与 mobile-toolbar 冲突

### FR-3: 项目路由化（URL 驱动）
- 优先级: 必须
- 描述: 选择项目改变 URL 到 `/projects/[projectId]`，支持浏览器前进/后退/书签直达。
- 验收标准:
  - Given 项目列表已加载 When 点击项目 Then URL 变 `/projects/<id>` 且项目高亮
  - Given URL `/projects/<id>` When 直接打开 Then 该项目选中并加载任务
  - Given 已选项目 When 浏览器后退 Then 回到上一 URL，选中态同步
  - Given URL 指向不存在的 projectId When 加载 Then 显示错误态非崩溃（复用 projectLoadError）

### FR-4: 引导式空状态
- 优先级: 应该
- 描述: "暂无项目""暂无任务"等替换为带 CTA 按钮的引导卡片（复用 `.state-message` + `.button-primary`）。
- 验收标准:
  - Given 项目列表空 When 渲染 Then 引导卡片含说明 + CTA"创建项目"，点击聚焦项目名输入框
  - Given 有项目无任务 When 渲染任务区 Then 引导卡片 + CTA 聚焦任务目标输入框
  - Given 未选项目 When 渲染上下文栏 Then 引导提示"选择项目"

### FR-5: Agent 身份色头像
- 优先级: 应该
- 描述: `.agent-mark` 通过 `data-accent` 着色（复用 sage/terracotta/gold/slate/rose/olive token），默认仍为 `--agent-warm`。
- 验收标准:
  - Given `.agent-mark[data-accent="sage"]` When 渲染 Then 前景/背景用 `--agent-sage-fg` / `--agent-sage-bg`
  - Given `.agent-mark` 无 data-accent When 渲染 Then 保持 `--agent-warm` 默认色（无回归）
  - Given 未知 accent 值 When 渲染 Then 回退默认色（不崩溃）
  - Given `.agent-avatar[data-accent]`（已有规则）When 渲染 Then 不受本次改动影响（无回归）

### FR-6: 输入框 placeholder
- 优先级: 可选
- 描述: 所有 `<input>` 添加语义化 placeholder。
- 验收标准:
  - Given 任意表单 When 渲染 Then 每个 input 有非空 placeholder（纯文本不等于其关联 label，语义不重复由 review 核对）

## 2. 设计

### 现状与改动面
| 文件 | 改动 |
|------|------|
| `app/tokens.css` L2 | 修改 `--font-sans`；新增 `--activity-bar-width: 3rem`；改 `@media (max-width:56.25rem)` 区块：grid 退化为 `var(--activity-bar-width) minmax(0,1fr)`（ActivityBar 不参与折叠，始终占第一列） |
| `app/cockpit.css` | `.activity-bar` 样式 + 新增 `[data-accent] .agent-mark` 选择器族（6组，对齐已有 `.agent-avatar` 规则）+ `.empty-guide` 引导卡片 |
| `components/activity-bar.tsx` | **新建**：48px 竖轨导航（客户端组件） |
| `components/project-panel.tsx` | 集成 ActivityBar；移除内联文字 nav；URL 路由化（见 T-4 子步骤）；空状态改引导卡片；input 加 placeholder |
| `components/team-panel.tsx` | 集成 ActivityBar；移除内联文字 nav |
| `components/task-panel.tsx` | 空状态改引导卡片；input 加 placeholder |
| `app/projects/[projectId]/[[...resource]]/page.tsx` | **重构**：page 内按 `params.resource` 是否为空分流——空渲染 `<ProjectPanel/>`，非空走现有来源引用页（不新建同级 page，避免与可选 catch-all 路由冲突） |

复用：token 体系（`--interactive-*`、`--agent-*-fg/bg`）、`.nav-item`、`.state-message`、`.button-primary`、`--control-min`。**不引入新依赖**，SVG 内联。

### 关键决策
**D-1: 项目路由方案** — 现有 `[[...resource]]/page.tsx` 是可选 catch-all，已匹配 `/projects/<id>`，同级新建 `page.tsx` 会与之冲突（Next.js 构建期报错）。**选 A**：重构该 catch-all page，按 `params.resource` 是否为空分流——空渲染 `<ProjectPanel/>`、非空走现有来源引用页。ProjectPanel 从 `usePathname` 解析 projectId。（与 frame A-81"复用该路由做主导航"一致。）

**D-2: ActivityBar 与三栏布局** — A: 作为 grid 第一列（四栏）/ B: `position:fixed` 叠加 — **选 A**：`grid-template-columns` 改为 `var(--activity-bar-width) var(--sidebar-width) ...`。窄屏分支：ActivityBar 不参与折叠，`tokens.css` 的 `@media (max-width:56.25rem)` 把 grid 从四栏退化为 `var(--activity-bar-width) minmax(0,1fr)`（ActivityBar 始终占第一列 + 单栏内容），mobile-toolbar 维持现有显隐。

**D-3: agent-mark 配色传递** — A: 调用方传 `data-accent` 字符串 / B: 新增 `agentAccent(id)` 哈希取色 — **选 A**：调用方复用 collaboration-panel 已有 `accentToken` 字段透传。CSS 侧新增 `[data-accent] .agent-mark` 选择器族（6组），模式对齐已有 `.agent-avatar` 规则、复用既有 `--agent-*-fg/bg` token（属新增 CSS 规则，非纯复用）。

### 接口与数据契约
```typescript
// components/activity-bar.tsx
type ActivityBarProps = { activePath: string };
// 导航项: [{ href: "/", label: "工作", icon }, { href: "/team", label: "团队", icon }]

// ProjectPanel: usePathname() → /^\/projects\/([^/]+)/ → projectId
// 选择项目 → router.push(`/projects/${id}`)
```

### 错误处理
- URL projectId 不存在 → fetch 过滤未命中 → 复用 `projectLoadError` 显示"未找到该项目"+返回按钮
- `usePathname` 返回 null（SSR 首帧）→ 跳过路由同步，不影响首次 fetch

## 3. 测试策略
- **组件测试**（Vitest + Testing Library）:
  - `tests/activity-bar.test.tsx`: 渲染、aria-current、键盘焦点、tooltip
  - 扩展 `tests/task-flow.test.tsx`: URL 路由—— mock `usePathname`/`useRouter`，验证 push、后退同步、无效 ID 错误、URL 指定有效项目时跳过默认选中首个
  - 扩展 `tests/context-accessibility.test.tsx`: 空状态引导卡片 + CTA
  - 新增 `tests/agent-mark.test.tsx`: `.agent-mark` data-accent 各值着色 + 无效值回退
- **回归**: `npm test` 维持 ~1036 pass / ~120 fail，不新增 fail
- **命令**: `npm test`、`npm run build`
- **边界**: 空项目列表、无任务、无效 projectId、窄屏 ActivityBar

## 4. UI 设计

### 信息架构
ActivityBar(48px) 作为 grid 第一列，左侧三栏不变；替代原 sidebar 内文字 nav。

### 交互三态
| 交互 | loading | empty | error |
|------|---------|-------|-------|
| 项目列表 | "正在加载项目…" | 引导卡片+CTA | 错误+重试（现有） |
| 任务列表 | "正在加载任务历史…" | 引导卡片+CTA | 错误+重试（现有） |
| URL 路由 | 复用项目列表 loading | 无匹配→错误态 | 无效 ID→错误+返回 |

### 视觉系统
- ActivityBar: `var(--surface-panel)` 背景 + `var(--border-subtle)` 右边框；按钮 `--control-min`（44px）；hover `--interactive-soft-hover`；active `--interactive-soft`+`--interactive-primary`
- 图标: 内联 SVG `stroke="currentColor"`，`--space-5`（20px），无第三方库
- 引导卡片: 复用 `.state-message` + `.button-primary`，不加装饰阴影
- agent-mark: 本次为 `.agent-mark` 新增 `[data-accent]` 选择器族，模式对齐已有的 `.agent-avatar`

### 可访问性
- 按钮: `aria-label`+`aria-current`+`title`；Tab 遍历焦点环可见；触控 ≥44×44px；token 对比度已满足 WCAG AA

## 5. 任务清单

- [x] T-1 字体栈优化 (覆盖: FR-1) — 判据: `--font-sans` 以 -apple-system 开头，CSS 解析测试通过
- [x] T-2 新建 ActivityBar 组件+样式 (覆盖: FR-2) — 判据: activity-bar.test.tsx 验证渲染/aria-current/焦点/tooltip 全绿
- [x] T-3 四栏布局适配+集成 project-panel & team-panel (覆盖: FR-2) — 判据: 文字 nav 移除；宽屏四栏 grid 渲染通过；窄屏（≤56.25rem）ActivityBar 可见且 mobile-toolbar 正常
- [x] T-4 项目 URL 路由化 (覆盖: FR-3) — 子步骤: ① `usePathname` 解析 `/^\/projects\/([^/]+)/`→projectId；② 所有 `setCurrentProjectId` 改为 `router.push`；③ SSR 首帧 pathname 为空时跳过路由同步、URL/列表加载竞态下保留"默认选中首个"兜底 — 判据: URL 变更/后退同步/无效 ID 错误态测试全绿；`/projects/<id>` 与 `/projects/<id>/<resource>` 两条路径在 `npm run build` 下均可达、无路由冲突
- [x] T-5 引导式空状态 (覆盖: FR-4) — 判据: 空项目/空任务/未选项目显示引导卡片+CTA，测试断言可点击
- [x] T-6 Agent 身份色头像 (覆盖: FR-5) — 判据: `.agent-mark` data-accent 各 token 着色 + 默认回退测试全绿
- [x] T-7 所有 input 加 placeholder (覆盖: FR-6) — 判据: 全量 input 有 placeholder，属性断言通过
- [x] T-8 全量回归+build 验证 (覆盖: FR-1–FR-6) — 判据: `npm test` 无新增 fail，`npm run build` 成功
- [x] T-9 axe 页面结构返修 (覆盖: verify findings，不新增需求) — 判据: 页面有非空 title、单一 main、真实页面名 h1，mobile toolbar 位于 landmark 内
