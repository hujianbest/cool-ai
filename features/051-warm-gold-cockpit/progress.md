# 进度

- 特性: 051-warm-gold-cockpit（S-61）
- 当前阶段: implement（P0 壳层已实现并验证；收尾项：全量套件与冒烟）
- 执行模式: interactive
- 下一步: 按 `product/development-plan.md` §3 完成 P0 收尾（全量测试、必需冒烟、axe 关键路径）；主区已收成「中间对话流 + 底部 composer」，未打开文件夹为 1:1 大厅，打开文件夹后主页面仍是聊天框

## 状态记录

- 2026-08-15 用户确认三点（色板/治理收轨/落地方式），立项本特性。
- 项目级 review 豁免沿用（纯 UI 切片，AGENTS.md 2026-08-14 选择性评审条款）；TDD、聚焦测试、tsc、build 与真实渲染验收仍为完成条件。
- 2026-08-15 T-01 进行中：`product/ui/DESIGN.md` 已重写为暖金契约，`app/tokens.css` 亮暗两套令牌已换色（暖米 + 暖金），preview 页与视觉契约测试已同步（4 处断言/对比度待修）。随后用户转向先重写产品设计文档与交付计划，本特性暂停。
- 2026-08-15 恢复 P0 并完成 T-01～T-05：
  - T-01 ✅ DESIGN.md 暖金契约 + tokens 亮暗换色 + preview 同步 + 视觉契约测试 25/25（含对比度修正：soft-hover `#F4EFE7`、queued `#8F5E12`）。
  - T-02 ✅ 52px 图标轨：新增 任务/记忆/审批/审计 治理按钮（Phosphor 线性图标 + tooltip + aria-pressed），选中态暖金；治理入口接线到主区按需视图。
  - T-03 ✅ 240px 会话侧栏：宽度令牌 15rem、暖米 parchment 背景；既有 搜索/全部/已收藏/回收站/创建线程 结构保留并按新令牌呈现。
  - T-04 ✅ 聊天主区：桌面 header（产品名 + 项目/语境 + 打开项目文件夹）、居中聊天流 max 840px、composer 圆角浮起样式。
  - T-05 ✅ 空状态：无 Agent 首页空态加「欢迎来到 Cool AI」+ @成员 引导；治理视图（任务看板/共享记忆/审批中心/审计中心）由图标轨打开，无项目时引导打开文件夹，带「返回对话」。
  - T-06 ⏳ 部分完成：`tsc` ✅、`build` ✅、聚焦测试（cockpit-shell 87/90、28 项相关测试）✅、亮/暗截图与交互验证 ✅；全量套件与必需冒烟待 P0 收尾。
- 2026-08-15 浏览器目录回归 646/656：10 个失败全部经基线对照确认为此环境既有问题（localStorage 实验性警告 x4、沙箱禁止测试自起服务器绑端口 x2、窄屏抽屉渲染 x1、review 流程 x3 中 1 个为真实浏览器 EPERM），另 execution-start-policy 为时序抖动（3 次跑 2 次失败 1 次通过，与本次改动无关）。
- 2026-08-15 全量套件 2587/2719 通过；132 个失败全部归因为环境/平台（本机为 macOS 而非目标 Windows x64——`tests/adapters/workspace/*` 与 safe-execution 原生/合并套件在 macOS 不适用；需绑本地端口的执行/合并路由测试受沙箱 EPERM 限制；浏览器侧为前述既有环境问题）。本次改动的组件测试（project-panel/task-panel/activity-bar/onboarding/collaboration 等）全部通过，无回归。P0 收尾的全量绿基线需在目标环境（Node 24.x、Windows x64 或可绑端口环境）复跑。
- 2026-08-15 按 `features/051-warm-gold-cockpit/evidence/` 运行截图修复壳层错乱：240px 侧栏把 CJK 压成竖排（筛选 tab / 线程标题 / 「移入回收站」全文按钮抢宽）；主区 `.panel-heading` 负边距造成阶梯；治理视图与子面板标题重复；使命卡按钮被 stretch 成大白块。已改为 tab/标题 nowrap+ellipsis、操作改图标按钮、侧栏可滚动、去掉负边距。`tsc` ✅；布局契约与线程/使命/a11y 聚焦测试绿；theme-activity-bar 2 项与 hydration 浏览器项为既有环境/主题存储失败，非本次回归。
- 2026-08-15 本地 `npm run dev` 真实渲染 loop（对话 / 任务 / 记忆 / 审批 / 审计）：对照 DESIGN「会话侧栏只留对话」把桌面侧栏的 `ProjectSetupPanel`（工作区路径 / 文件树报错 / 成员 checkbox）挪出主路径，仅窄屏抽屉与 onboarding `workspace`/`members` 步骤仍渲染；项目群聊 eyebrow 不再写「确定性示例 Agent」。布局契约测试已断言侧栏无「项目设置」；onboarding / 窄屏抽屉 / a11y 聚焦绿。仍可见但未在本轮改：聊天下方 legacy「任务目标」表单（`task-flow` 仍依赖）、侧栏标题仍是「项目/线程」而非「对话」、看板四列在 840px 流内偏挤。
- 2026-08-16 聊天窗对齐 DeepSeek / Clowder 大厅：未打开文件夹时 header 为「大厅」、主区为欢迎/消息流 + 底部 composer；打开文件夹后主页面仍是聊天框（可新建对话、@ 召唤成员）。首页不再被项目列表加载挡住；composer 在加载中也保持在底部。`tsc` 与 cockpit-layout / home-direct-chat / collaboration 聚焦测试绿。
- 2026-08-16 按 UCD 收口图标轨 IA：主项组为对话/任务/记忆/审批/审计，底部分组为团队/设置/主题；首次使用引导从轨上移到大厅空状态。`AGENTS.md` 明确产品开发以 `product/ui/UI设计.md` 为基准。
- 2026-08-16 按 UCD §8.4 / §8.7 落地返回对话与治理快捷键：项目页「对话」href 为当前 `/projects/:id`（团队页则带回程项目）；`ESC` / `Cmd/Ctrl+1` 关闭治理回对话，`Cmd/Ctrl+2–5` 打开任务/记忆/审批/审计。弹窗打开时不抢 `ESC`。聚焦测试（cockpit-layout / activity-bar / a11y / settings-return / team-skill）29/29，`build` 绿。
- 2026-08-16 按 UCD §8.1 落地图标轨选中态左侧 3px 暖金指示条（令牌 `--rail-indicator-width` / `--rail-indicator-radius`），并收口 `DESIGN.md` 与 UCD 冲突的「4px 圆点」表述。activity-bar / visual-tokens 20/20，`build` 绿。
- 2026-08-16 按 UCD §7.1 / §14.2 落地 Needs Me：`GET /approvals/pending` 驱动 Header 徽标与图标轨「审批」暖金圆点；点击徽标打开审批视图。cockpit-layout / activity-bar / visual-tokens / settings-return / a11y / home / approval-center 53/53，`build` 绿。
- 2026-08-16 按 UCD §7.1 / §9.1.5 收口会话侧栏：筛选 Tab 为全部/收藏/标签，回收站改为底部入口，「+ 新对话」支持 `Cmd/Ctrl+N`；无对话时主区不再留禁用 composer。线程列表/回收站/标签 44/44，`build` 绿。
- 2026-08-16 按 UCD §8.7 落地 `Cmd/Ctrl+O` 打开系统文件夹选择器。cockpit-layout 9/9，`build` 绿。
- 2026-08-16 按 UCD §8.6 落地 Composer 键盘：`Enter` 发送、`Shift+Enter` 换行；输入框键入 `@` 弹出成员补全，上下键 / `Enter` / `Tab` 选中并插入胶囊。collaboration-chat 8/8，相关 composer 测试 37/37，`build` 绿。

## 任务票

- T-01 DESIGN.md 暖金设计契约 + tokens.css 亮暗换色 + 视觉契约测试同步
- T-02 壳层一：52px 图标轨（纯图标 + tooltip + 治理入口接线）
- T-03 壳层二：240px 会话侧栏（过滤 tabs、新建对话、回收站）
- T-04 壳层三：聊天主区（header / 居中聊天流 / 浮起 composer）
- T-05 壳层四：空状态（欢迎 + @Agent 引导）+ 治理视图按需打开
- T-06 验收：tsc、聚焦测试、build、Playwright 截图对照
