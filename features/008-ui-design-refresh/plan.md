# 协作驾驶舱 UI 设计改善计划

- 日期: 2026-08-06
- frame: ./frame.md

## 1. 需求

### FR-1: 主要界面呈现清晰且一致的空间层级
- 优先级: 必须
- 描述: 工作与团队界面应让 owner 立即区分应用背景、左右承载面板、主工作区和浮起内容，而不是把所有区域表现为相同的白色阴影卡片。
- 验收标准:
  - Given owner 打开桌面工作或团队界面 When 页面完成渲染 Then 背景、面板、主区和卡片使用四级命名表面且边界清晰。
  - Given 内容包含嵌套面板 When 查看同一视口 Then 普通分组主要依赖表面或细边框，只有浮层和关键抬升内容使用阴影。

### FR-2: 导航与操作具有可辨认的当前状态和主次层级
- 优先级: 必须
- 描述: owner 应能辨认当前页面、当前项目、当前资源页签，以及每个表单的主要、次要和幽灵操作。
- 验收标准:
  - Given owner 位于工作或团队界面 When 查看导航 Then 当前项同时具有语义属性和视觉状态，非当前项具有可见 hover/focus 状态。
  - Given 一个表单包含提交与辅助操作 When 查看或键盘聚焦 Then 主要操作使用单一强调色，辅助操作不与之争夺注意力，disabled 状态仍可辨认。

### FR-3: 密集协作内容保持可扫读的排版和状态语义
- 优先级: 必须
- 描述: 标题、说明、字段、时间线、状态、指标和代码内容应形成稳定的字号、字重、间距和语义色层级。
- 验收标准:
  - Given 页面同时显示任务、事件和状态 When owner 扫读 Then 标题、辅助文字、状态标签和正文层级可由共享 token 与类规则判定。
  - Given 状态为排队、运行、完成或失败 When 显示标签 Then 每类具有独立的文字与浅色语义表面，且不只依赖颜色传达状态。
  - Given 长标识、数值或代码内容 When 空间受限 Then 内容可换行或截断且数值采用等宽数字，不产生页面级横向溢出。

### FR-4: 窄屏保留清晰的上下文切换和可用状态
- 优先级: 必须
- 描述: 窄屏工具栏、抽屉与协作页签应继承同一视觉层级，打开面板时不泄漏背景滚动或横向溢出。
- 验收标准:
  - Given 视口宽度不超过既有 56.25rem 断点 When owner 打开项目、编辑或上下文面板 Then 单列布局、固定工具栏、抽屉层级和安全区内边距可由样式规则验证。
  - Given loading、empty 或 error 状态 When 在桌面或窄屏显示 Then 状态与就近重试/下一步操作保持可见，既有语义和焦点管理不退化。

### 非功能需求
- NFR-1: 可访问性 — 要求: 普通文本对比度 ≥4.5:1，大文本与非文本交互边界/状态 ≥3:1，所有控件最小 44×44px、键盘可达且焦点可见 — 出处: `product/product.md` 第 25 行、ext-ui-design 与 WCAG 2.2 AA — 验证方式: token 对比度计算、既有 accessibility 测试和浏览器 smoke。
- NFR-2: 视觉值治理 — 要求: 颜色、字号、间距、圆角、阴影和布局尺寸通过 `app/tokens.css` 命名 token 使用，组件不新增 inline style 或原始视觉值 — 出处: `product/product.md` 第 25 行与 ext-ui-design — 验证方式: `tests/visual-tokens.test.ts` 静态契约。

### 范围、假设与开放问题
- 继承 frame 范围外: 不复制参考项目代码/品牌/资产，不新增业务、主题、动画、移动端专用功能或数据模型。
- A-67 [生效]: 只参考 Clowder AI 的外壳、密度、层级和状态原则；若被推翻，四级表面、紧凑密度和语义 class 方案需回到 plan 重做，T-2 至 T-4 均不可继续。
- 开放问题: 无；reference 的具体做法只在满足既有 D-9、D-10 和产品边界时采用。

## 2. 设计

### 现状与改动面
- 复用 `app/tokens.css`、`app/cockpit.css` 和既有 class/data/ARIA 属性；不引入 Tailwind、图标库、动画、组件原语或运行时主题。
- `tokens.css` 扩充四级表面、细/强边框、三档文本、交互浅色、语义浅色、两级阴影与完整间距；保留已有 token alias，避免一次性破坏 28 个组件。
- `cockpit.css` 重排全局控件、三栏外壳、导航、卡片、页签、表单、时间线和状态规则；普通内容减少阴影，浮层维持明确 elevation。
- `project-panel.tsx`、`task-panel.tsx`、`team-panel.tsx` 只增加语义化视觉 class，不改 fetch、状态机、文案、ARIA 或业务行为；子领域组件通过共享选择器继承刷新。
- `tests/visual-tokens.test.ts`、`tests/cockpit-layout.test.tsx`、`tests/responsive-layout.test.ts` 扩展为新设计契约；现有领域与 accessibility 测试继续防回归。
- 架构影响: 无；改动完全落在架构地图的 Web 外壳、设计系统与用户界面边界。

### 关键决策
- D-1 表面体系 — 方案 A: 直接复制 Clowder 的 OKLCH 多主题体系，层次丰富但引入未要求的暗色主题和兼容成本；方案 B: 在 Cool AI 现有暖色十六进制 token 上建立四级表面与语义 alias，改动小且品牌连续。选择 B，符合 A-67 与现有测试可验证方式。
- D-2 改造方式 — 方案 A: 重写组件结构并引入新 UI 库，可获得更大变化但会触碰大量交互与焦点行为；方案 B: 以 token/CSS 为主、少量语义 class 为辅，在不改变 DOM 行为的前提下统一层级。选择 B，风险与 S-8 的“改善设计而非新增功能”一致。
- D-3 密度 — 方案 A: 大留白营销式卡片，视觉醒目但不适合三栏协作；方案 B: 采用 Clowder 控制台的紧凑控件、细分隔和清晰表面，同时保持 44px 点击目标。选择 B，以信息密度服务长时间工作台使用。

### 接口与数据契约
- 不修改 HTTP、数据库或 TypeScript 数据契约。
- 新增 token 集合: `--surface-sunken/panel/main/card`；`--text-primary/secondary/subtle`；`--border-subtle/strong`；`--interactive-primary/primary-hover/soft/soft-hover`；`--status-queued/running/success/danger-surface`；`--shadow-1/2`。旧 `--canvas/surface/surface-muted/text/text-muted/border/accent/shadow-panel` 作为 alias 保留。
- 稳定 class/选择器: `button-primary/secondary/ghost` 映射提交/辅助/低优先动作；`nav-item` + `[aria-current]` 映射主导航和项目；`surface-heading` 映射主区标题；`.status-label.status-*` 映射状态文字与浅色面；`[role="tab"][aria-selected]` 映射团队/上下文页签。
- 页面映射: `.collaboration-cockpit`=sunken，`.cockpit-sidebar/.cockpit-context`=panel，`.cockpit-flow`=main，composer/timeline/card/form=card；团队页沿用相同外壳；`.modal-surface/.mobile-toolbar` 使用 card + `--shadow-2`，普通卡片最多 `--shadow-1`。

### 错误处理
- 不新增运行时错误路径；loading/empty/error DOM 和就近重试按钮保持原样。
- 若 token 或关键选择器缺失，静态视觉契约测试失败；若 class 改动破坏语义或焦点，组件/accessibility 测试失败。
- 基线中两个 README smoke contract 先改为读取当前公开文档的真实位置，恢复全量测试后再进行 UI TDD。

## 3. 测试策略

- T-1 先用现有失败断言记录 RED，更新两个 stale smoke contract 指向 `docs/testing.md` 与当前 README 后运行定向测试和全量基线。
- token/CSS 层: 运行 `npm test -- tests/visual-tokens.test.ts tests/team-visual-tokens.test.ts tests/responsive-layout.test.ts`；计算 primary/secondary/subtle 文本与对应表面 ≥4.5:1、focus/边界/状态与相邻表面 ≥3:1，并验证四级表面、操作层级和无原始组件视觉值。
- 组件/可访问性层: 运行 `npm test -- tests/cockpit-layout.test.tsx tests/context-accessibility.test.tsx tests/collaboration-accessibility.test.tsx tests/execution-accessibility.test.tsx tests/review-accessibility.test.tsx`，验证语义 class、当前状态、44px、键盘与焦点契约共存。
- 回归层: `npm test` 与 `npm run build`。
- 真实渲染: 运行 `npm run smoke` 与 `npm run smoke:team`，保存工作台/团队桌面和窄屏截图；最终 demo 同时展示两页。

## 4. UI 设计

- 信息架构不变: 左侧项目/主导航，中间群聊与任务流，右侧看板/上下文；团队页复用同一外壳与资源页签。
- 视觉: 暖灰 canvas、承载 panel、明亮 main、白暖 card 四层；鼠尾草绿只用于主要操作与 active，Agent 色只用于身份；阴影仅用于 modal、sticky toolbar 和少量浮层。
- 工作台项目区: loading 显示 `aria-busy` muted 行；empty 保留“暂无项目”并让创建表单成为唯一下一步；error 就近显示重试。创建项目和任务提交以 disabled + 进行中文案表示 loading，error 留在表单附近，success 清空输入并聚焦/显示新结果。
- 中央协作与右侧上下文: loading/empty/error 继续由各领域 panel 就地呈现；状态面不遮盖重试或下一步操作；成功/警告/危险和 selected/focus 均使用独立 token。
- 团队资源页签: skills/providers/agents 每个 panel 保留各自 loading/empty/error 与重试/创建动作；tab 的 selected、focus 和 disabled 可区分，窄屏选择后关闭导航并恢复焦点。
- 窄屏抽屉: 项目、编辑、上下文以及团队资源继承相同三态内容；toolbar/close 始终可见，modal 使用 card elevation、安全区内边距和既有 focus trap，背景不可操作。
- 不增加动画或装饰性渐变。
- 可访问性: 44px 目标、`focus-visible`、语义属性、AA 对比、窄屏 modal 焦点管理沿用现有实现；不以纯颜色替代已有状态文字。

## 5. 任务清单

- [x] T-1 恢复 S-7 后失效的 smoke contract 环境基线 (覆盖: 无；基线恢复) — 判据: `tests/context-smoke-contract.test.ts` 与 `tests/collaboration-smoke-contract.test.ts` 先红后绿，随后 `npm test` 全量通过
- [x] T-2 建立四级表面与控件/状态视觉 token，并刷新共享 CSS 层级 (覆盖: FR-1, FR-2, FR-3, NFR-1, NFR-2) — 判据: visual/team token 与 responsive 定向测试先红后绿，CSS 无新增原始视觉值且现有组件测试通过
- [x] T-3 为工作台和团队主表面接入导航、标题与操作语义 class (覆盖: FR-2, FR-3, NFR-1, NFR-2) — 判据: cockpit/team 组件测试先红后绿，当前状态属性、键盘焦点与 loading/empty/error DOM 保持
- [x] T-4 收口桌面/窄屏层级与真实渲染回归 (覆盖: FR-1, FR-3, FR-4, NFR-1) — 判据: responsive/accessibility 定向测试先红后绿，全量测试、构建和浏览器 smoke 通过并产生桌面/窄屏截图
