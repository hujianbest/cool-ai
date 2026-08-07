# plan.md 评审 (第 1 轮)

- 日期: 2026-08-07
- 评审方式: subagent
- 结论: 需修改

## Findings

### 可实现性（对照现有代码验证）

- [严重] 设计 D-1（项目路由方案）: 决策理由存在事实性错误。plan 称"新建 `app/projects/[projectId]/page.tsx`，catch-all 天然不匹配无 resource 段的 URL"。但现有路由目录为 `app/projects/[projectId]/[[...resource]]/page.tsx`——双括号 `[[...resource]]` 是**可选 catch-all**，它已经匹配 `/projects/<id>`（resource 段为空）的情形。Next.js App Router 不允许同一层级的 `page.tsx` 与可选 catch-all 子目录的 `page.tsx` 并存，二者会在 `/projects/<id>` 路径上发生路由冲突或其中一方被忽略，构建期可能直接报错。现有 catch-all page 内容是"可追溯来源"静态展示页（非 ProjectPanel 壳），plan 对其性质的描述（"当前是静态来源引用"）正确，但"互不冲突"的结论错误。 → 修正 D-1：要么 (a) 把现有 `[[...resource]]/page.tsx` 重构为在该 page 内根据 `resource` 是否为空分流——空则渲染 `<ProjectPanel>`、非空走来源引用页；要么 (b) 将来源引用页迁至另一路径（如 `/projects/[projectId]/source/[...resource]`）再新建 `page.tsx`。无论哪种，都需在"改动面"表和 T-4 中显式记录对现有 catch-all page 的处置，并补一条验证 Next.js 路由不冲突的判据（`npm run build` 通过、两条路径各可达）。

- [一般] 设计 D-3 / FR-5（agent-mark 配色）: plan 声称"复用 collaboration-panel 已有 `accentToken` 字段直接透传，与现有 `[data-accent]` CSS 无缝衔接，零新逻辑"，且 FR-5 描述为"`.agent-mark` 通过 `data-accent` 着色"。但代码核查显示：现有 `[data-accent]` 选择器（cockpit.css L873–900）全部是 `[data-accent="..."] .agent-avatar` 后代选择器，作用于 `.agent-avatar` 元素；`.agent-mark`（cockpit.css L238/L248）没有任何 `data-accent` 规则，只有固定 `background: var(--agent-warm)`。collaboration-panel.tsx L861–866 中 `data-accent` 挂在外层 `.baton` 容器、着色的是内层 `className="agent-avatar"`。也就是说"零新逻辑、无缝衔接"不成立——要让 `.agent-mark` 响应 `data-accent`，必须新增 `[data-accent="..."] .agent-mark` 选择器族（6 组），属新增 CSS 而非纯复用。task-panel.tsx L256 当前用的是 `agent-mark`。 → 修正：在"改动面"表 `app/cockpit.css` 行明确写"新增 `.agent-mark[data-accent]` 选择器族（对齐已有 `.agent-avatar` 规则）"（目前该行只笼统写了 `.agent-mark[data-accent]` 规则，但"关键决策"D-3 的"零新逻辑/无缝衔接"措辞需订正为"新增选择器复用既有 token"）；并在 FR-5 验收标准中区分 `agent-mark` 与 `agent-avatar` 两个目标类，或明确本次只改其一。

- [一般] 设计 D-2 / FR-2（四栏布局与窄屏响应式的交互未覆盖）: plan 将 grid 从三栏改为四栏（`grid-template-columns: var(--activity-bar-width) var(--sidebar-width) ...`），改动面仅列 `app/cockpit.css`。但现有的窄屏折叠机制不在 cockpit.css，而在 `app/tokens.css` 的 `@media (max-width: 56.25rem)`（`responsive-cockpit` 区块，L92+），该区块把 `.collaboration-cockpit` 的 `grid-template-columns` 强制改为 `minmax(0, 1fr)` 单栏，并隐藏 `.cockpit-sidebar/.cockpit-context`、显示 `.mobile-toolbar`。FR-2 第 5 条验收标准要求"窄屏（≤56.25rem）ActivityBar 可见且不与 mobile-toolbar 冲突"，但 plan 没有说明：四栏 grid 在窄屏如何退化为单栏的同时让 ActivityBar 仍可见？是让 ActivityBar 不参与窄屏折叠（始终占第一列），还是改为 fixed 叠加？这直接决定 D-2（grid 第一列 vs fixed 叠加）在窄屏下的可行分支。改动面表也未列入对 tokens.css `responsive-cockpit` 媒体查询的修改。 → 修正：在 D-2 补一个窄屏分支说明，并在"改动面"表新增 `app/tokens.css` 的 `@media` 区块改动（或明确 ActivityBar 在窄屏的显隐/定位策略），T-3 判据补充"窄屏下 ActivityBar 可见、mobile-toolbar 正常"的断言。

- [一般] 设计「接口与数据契约」/ 改动面（ProjectPanel URL 化的改动被低估）: plan 写"ProjectPanel 从 `usePathname` 解析 projectId，单一组件双路由复用"，改动面对 `project-panel.tsx` 仅一句话"接入 URL 路由"。但现状是：`ProjectPanel()` 当前是无参客户端组件，`currentProjectId` 是内部 `useState`，选择项目走 `setCurrentProjectId(project.id)`（L29/L337），首次加载自动选中首个项目（L107）。改为 URL 驱动需要：引入 `usePathname`/`useRouter`、把 `currentProjectId` 的来源从内部 state 改为 pathname 解析、将所有 `setCurrentProjectId` 调用改为 `router.push`、处理 SSR 首帧 pathname 为空与 URL/列表加载的竞态、保留"首次加载默认选中首个项目"与"URL 指定项目"两条路径的一致性。这是一次中等规模的内部状态模型重构，不是一行接入。 → 修正：在改动面或 T-4 中展开 ProjectPanel 的状态改造子步骤（pathname 解析、router.push 替换 setState、首帧/竞态处理），并在测试策略中显式覆盖"URL 指定有效项目时跳过默认选中首个"这一与现有行为的差异点。

### requirements-checklist（可测性 / 反幻觉 / 完整与一致）

- [建议] FR-1 验收标准: "中文走 PingFang SC""无布局偏移"在自动化测试中难以客观判定（字体回退由浏览器/OS 决定，jsdom 无法验证实际命中字体；"无布局偏移"无量化阈值）。建议把可测部分收敛为"CSS 解析后 `--font-sans` 以 `-apple-system` 开头且包含 `PingFang SC`/`Segoe UI Variable`/`Microsoft YaHei UI`"，把"无布局偏移"降级为人工验收或给出可断言的代理指标（如 font-display 策略）。当前 T-1 判据已是 CSS 解析测试，与 FR 验收标准的可测部分一致，建议二者措辞对齐。

- [建议] FR-6 验收标准: "每个 input 有非空 placeholder 且与 label 不重复"——"与 label 不重复"需要明确的判定规则（纯文本相等？包含关系？），否则 T-7 的"属性断言通过"难以覆盖该条。建议给出占位符与 label 关系的可测定义，或在 T-7 中说明该条靠人工/review 核对。

- [建议] frame.md A-81 假设与 plan D-1 存在认知差: A-81 称"项目路由 /projects/[projectId] 已有路由文件 `[[...resource]]`，本次复用该路由做主导航"，而 plan D-1 选择的方案 B 恰恰是**不复用**该 catch-all、另建 page。两者方向相反，且 D-1 的事实性错误（见上条严重 finding）使"复用/新建"的真实成本被扭曲。建议修正 D-1 后同步回看 A-81 的措辞是否仍准确。

### design-checklist（需求覆盖 / 决策质量 / 可实现性 / 任务清单）

- [建议] 决策质量 D-2: 仅列出"grid 第一列（四栏）"与"fixed 叠加"两个方案，但未评估四栏方案对窄屏响应式（见上条一般 finding）的影响，取舍分析不完整。建议补充四栏方案在窄屏下的处置后再定稿。

- [建议] 任务清单 T-3: 判据"四栏 grid 渲染测试通过"过于宽泛，未覆盖窄屏折叠分支。建议细化为"宽屏四栏、窄屏 ActivityBar 可见且 mobile-toolbar 正常"两条断言（与 FR-2 第 5 条对齐）。

- [建议] 任务清单 T-4: 判据未覆盖"与现有 catch-all 路由共存/迁移"的验证。建议补"两条路径（`/projects/<id>` 与 `/projects/<id>/<resource>`）在 `npm run build` 下均可达、无路由冲突"的判据（与 D-1 修正联动）。

### ext-ui-design（plan 阶段评审检查项）

- [通过] UI 章节存在: plan 第 4 节"UI 设计"位于测试策略之后、任务清单之前，位置与内容均满足扩展要求；信息架构、交互三态表格、视觉系统（落点到 token：`--surface-panel`/`--border-subtle`/`--control-min`/`--interactive-*`/`--agent-*-fg-bg`）、可访问性（aria-label/aria-current/焦点环/44px/WCAG AA）均已覆盖。

- [建议] 三态覆盖: 交互三态表格基本覆盖 loading/empty/error，但"URL 路由"的 loading 态标为"—"（无）。考虑补一句说明（路由切换通常无显式 loading，或复用项目列表 loading），以免被误判为遗漏三态。

- [通过] 复用既有 Design System: 视觉决策全部回指 `tokens.css` 既有 token 与 `.nav-item`/`.state-message`/`.button-primary` 既有类，未引入新依赖、未硬编码色值、未出现反 AI 默认审美（无紫蓝渐变、无 emoji 图标、无装饰阴影）。符合"复用既有 Design System"检查项。

- [建议] FR-5 与现有视觉系统的偏差: 见上条一般 finding——`.agent-mark` 的 `data-accent` 在现有 Design System 中并不存在（现有的是 `.agent-avatar`）。严格说这是"偏离既有模式需显式说明理由"的情形，plan 把它表述成"复用/无缝衔接"掩盖了偏离。建议在视觉系统段落显式说明"本次为 `.agent-mark` 新增 `[data-accent]` 选择器，模式对齐已有的 `.agent-avatar`"。

---

附：本次代码核查的关键事实（供修改时参照）

- 路由：仅存在 `app/projects/[projectId]/[[...resource]]/page.tsx`（可选 catch-all），无 `[projectId]/page.tsx`；该 catch-all 已匹配 `/projects/<id>`。
- grid：`.collaboration-cockpit` 三栏定义在 `app/cockpit.css` L146；窄屏折叠（`grid-template-columns: minmax(0,1fr)` + 隐藏三栏 + mobile-toolbar）在 `app/tokens.css` L92 `@media (max-width: 56.25rem)`，cockpit.css 内无任何 `@media`。
- ProjectPanel：`components/project-panel.tsx` L1 `"use client"`（✓ 已是客户端组件），但 L27 `export function ProjectPanel()` 无参数，`currentProjectId` 为内部 `useState`（L29），选择项目走 `setCurrentProjectId`（L337），未引入 `usePathname`/`useRouter`。
- data-accent：`[data-accent="..."] .agent-avatar` 选择器族在 cockpit.css L873–900，全部作用于 `.agent-avatar`；`.agent-mark`（L238/L248）无 data-accent 规则。collaboration-panel.tsx L861–866 的 `data-accent` 挂在 `.baton` 容器、着色 `.agent-avatar`。`agent-mark` 仅 task-panel.tsx L256 使用。
- 字体：`--font-sans` 现状（tokens.css L2）为 `"Segoe UI Variable", "Microsoft YaHei UI", system-ui, sans-serif`，无 `-apple-system`/`PingFang SC`。

---

# plan.md 评审 (第 2 轮 复审)

- 日期: 2026-08-07
- 评审方式: subagent
- 结论: 通过
- 用户确认: auto-approved 2026-08-07

## Findings 闭合情况

### 可实现性

- **第1轮 [严重] D-1 路由冲突: 已闭合** — D-1 已改为方案 A（重构 `[[...resource]]/page.tsx`，page 内按 `params.resource` 是否为空分流：空渲染 `<ProjectPanel/>`、非空走现有来源引用页），不再新建同级 page，路由冲突风险消除。改动面表 L67 已显式列入对该 catch-all page 的"重构"处置；T-4 判据已补"`/projects/<id>` 与 `/projects/<id>/<resource>` 两条路径在 `npm run build` 下均可达、无路由冲突"。认知差项同步消解：plan 现选 A（复用该 catch-all 路由），方向与 frame A-81"复用该路由做主导航"一致，D-1 已注明"与 frame A-81 一致"。

- **第1轮 [一般] D-3 / FR-5 agent-mark: 已闭合** — D-3 措辞已从"零新逻辑/无缝衔接"订正为"CSS 侧新增 `[data-accent] .agent-mark` 选择器族（6 组），模式对齐已有 `.agent-avatar` 规则、复用既有 `--agent-*-fg/bg` token（属新增 CSS 规则，非纯复用）"。改动面表 `app/cockpit.css` 行已明确"新增 `[data-accent] .agent-mark` 选择器族（6 组，对齐已有 `.agent-avatar` 规则）"。FR-5 验收标准已区分两个目标类：L44–47 针对 `.agent-mark[data-accent]`，L48 新增一条断言"`.agent-avatar[data-accent]`（已有规则）不受本次改动影响（无回归）"。视觉系统段落亦补充说明。

- **第1轮 [一般] D-2 / FR-2 窄屏: 已闭合** — D-2 已补窄屏分支："ActivityBar 不参与折叠，`tokens.css` 的 `@media (max-width:56.25rem)` 把 grid 从四栏退化为 `var(--activity-bar-width) minmax(0,1fr)`（ActivityBar 始终占第一列 + 单栏内容），mobile-toolbar 维持现有显隐"。改动面表已新增 `app/tokens.css` 行，列入对 `@media (max-width:56.25rem)` 区块的改动。T-3 判据已补窄屏断言"窄屏（≤56.25rem）ActivityBar 可见且 mobile-toolbar 正常"。

- **第1轮 [一般] ProjectPanel URL 化改动被低估: 已闭合** — T-4 已展开状态改造子步骤：① `usePathname` 解析 `/^\/projects\/([^/]+)/` → projectId；② 所有 `setCurrentProjectId` 改为 `router.push`；③ SSR 首帧 pathname 为空时跳过路由同步、URL/列表加载竞态下保留"默认选中首个"兜底。测试策略已显式覆盖"URL 指定有效项目时跳过默认选中首个"。改动面表 `components/project-panel.tsx` 行已标注"URL 路由化（见 T-4 子步骤）"。

### requirements-checklist / design-checklist / ext-ui-design（建议项）

- **第1轮 [建议] FR-1 可测性收敛: 已闭合** — 验收标准已收敛为"`--font-sans` 以 `-apple-system` 开头且含 `PingFang SC`/`Segoe UI Variable`/`Microsoft YaHei UI`（实际命中字体与无布局偏移由人工验收）"，"无布局偏移"降级为人工验收，与 T-1 判据（CSS 解析测试）措辞对齐。

- **第1轮 [建议] FR-6 placeholder 判定规则: 已闭合** — 验收标准已给出可测定义"每个 input 有非空 placeholder（纯文本不等于其关联 label，语义不重复由 review 核对）"，"纯文本不等于关联 label"可断言，语义层面靠 review 核对。

- **第1轮 [建议] A-81 认知差: 已闭合** — 见 D-1 闭合说明，plan 现选 A 与 A-81 方向一致。

- **第1轮 [建议] D-2 决策质量（窄屏取舍）: 已闭合** — D-2 已补窄屏分支分析，取舍完整。

- **第1轮 [建议] T-3 判据细化: 已闭合** — 已细化为宽屏四栏 + 窄屏 ActivityBar 可见/mobile-toolbar 正常两条断言。

- **第1轮 [建议] T-4 判据细化（路由共存）: 已闭合** — 已补两条路径 build 下均可达、无路由冲突判据。

- **第1轮 [建议] 三态 URL 路由 loading: 已闭合** — 交互三态表"URL 路由"行 loading 态已补"复用项目列表 loading"。

- **第1轮 [建议] FR-5 视觉系统偏差说明: 已闭合** — 视觉系统段落已显式说明"本次为 `.agent-mark` 新增 `[data-accent]` 选择器，模式对齐已有的 `.agent-avatar`"。

### 修订引入的新问题

无。通读修订后 plan，未发现修订引入的新的事实性错误、遗漏或前后矛盾。

注：改动面表与 D-3 使用后代选择器写法 `[data-accent] .agent-mark`（`data-accent` 挂在外层容器、着色后代 `.agent-mark`），与现有 `.agent-avatar` 的后代选择器模式一致，属正确实现，非问题。
