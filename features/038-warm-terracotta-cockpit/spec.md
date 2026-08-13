# 规格

## Problem Statement

owner 已把 `product/ui/cool-ai-design-md-case.html` 定为想要的驾驶舱：左栏是对话（Thread 目录），中间是项目组群聊，右边是使命看板、审批和记忆等状态。035 只把 Apple 营销站令牌投影到壳层，当前驾驶舱仍是冷蓝表面、栏宽与 case 不一致，看起来不像那份暖陶工作台。

## Solution

以 case 暖陶色板与四列栅格为产品视觉契约：重写 `product/ui/DESIGN.md`，把 Apple 原文归档；`app/tokens.css` 投影暖陶明暗令牌；驾驶舱桌面改为 `56px 236px minmax(0,1fr) 304px`。左栏呈现 Thread 对话目录，中栏呈现当前 Thread 群聊（记录、结构化块、composer），右栏呈现看板/审批/记忆 chrome。不改领域事实、路由或 props。可点击目标保持 44×44；窄屏继续现有抽屉。设置、引导、复核工作区只跟随新 token，不重排。

## User Stories

1. As owner, I want 打开项目驾驶舱时看到暖陶四列工作台（轨道 / 对话 / 群聊 / 看板），so that 屏幕与 case 一致。
2. As owner, I want 左栏是当前项目的 Thread 对话目录（含搜索、标签、回收站入口的既有能力），so that 我先选对话再进群聊。
3. As owner, I want 中栏是项目组群聊（线程头、消息、结构化块、composer），so that 协作发生在视觉中心。
4. As owner, I want 右栏是使命看板、待批准与共享记忆等状态面，so that 不必离开群聊就能看进度。
5. As owner, I want 亮/暗主题都使用同一套暖陶表面与青绿强调色，so that 两种主题下层级一致。
6. As owner, I want 键盘、焦点、loading/empty/error 与 axe 不回归，so that 改版不破坏既有流程。
7. As owner, I want preview 页展示暖陶 token 与壳层样例，so that 后续切片有可视化基准。

## UI 设计

### 信息架构

- 桌面：activity rail（56px）+ 对话侧栏（236px）+ 群聊（弹性）+ 上下文看板（304px）。对齐 D-9，左栏明确为 Thread 目录。
- 窄屏：现有抽屉（项目 / 编辑 / 上下文）不变（A-261）。不采用 case 的 980px 堆叠或 620px 隐藏侧栏。
- 右栏保留既有 tab（使命看板 / 共享记忆 / 审计等）；视觉跟 case 的 tab + 任务卡 + 审批卡 + 记忆卡，不新增 tab、不删既有面板。

### 交互三态

- 对话列表、群聊记录、右栏看板：沿用既有 loading / empty / error（state-message + 可操作 CTA）。
- 高风险（批准/拒绝、发送）：保留 disabled / success / focus；焦点环用暖陶 `--focus-ring`。
- 纯图标控件保持 `aria-label`；装饰图标 `aria-hidden`。

### 视觉系统（令牌，取值自 case）

亮色核心：

- canvas `#F4EFE5`、panel `#FBF7EE`、card `#FFFCF4`、card-strong `#FFFFFF`
- ink `#2B251F`、muted `#6F665A`、faint `#9C9182`
- accent `#3E6B5E`、accent-ink `#FFFFFF`、accent-soft `rgba(62,107,94,.13)`、focus `#2F5A4E`
- rail `#241F18`、rail-ink `#EDE5D8`
- 状态：amber `#96691C`、green `#3F6A4D`、terra `#A0443F`、blue `#41607F`

暗色核心：

- canvas `#15110D`、panel `#1C1712`、card `#251F18`、card-strong `#2B241B`
- ink `#EDE5D8`、muted `#A99D8C`、faint `#786E60`
- accent `#82B8A5`、accent-ink `#10100C`、focus `#9ACBBA`
- rail `#0D0B08`

圆角：sm 8px / md 12px / lg 16px / pill 999px。阴影：仅 composer/审批浮层用 case 的 shadow-1/shadow-2，chrome 不加装饰阴影。无渐变、无玻璃拟态、无 emoji 图标。

字阶按驾驶舱密度取 case：xs 11 / sm 12.5 / md 14 / lg 17；系统字体栈不变。

AA：正文与主操作对比度 WCAG AA。若 muted/faint 作常规次级文本不足 4.5:1，只抬高次级文本实值（A-257 先例），不改 canvas/panel/accent/rail 主表面。

### 反粗制滥造

拒绝第二强调色（交互只用青绿 accent）、紫色默认主色、装饰渐变、大面积 blur、发光。Agent 身份色保留为扩展 token，不充当主交互色。

## Implementation Decisions

- 契约：新 `product/ui/DESIGN.md` 写暖陶 YAML（colors/typography/rounded/spacing/components）；Apple 原文移到 `product/ui/archive/apple-design-analysis.md`。`tokens.css` 保持现有 CSS 变量名，只改值为 case；布局 token 改为 `--activity-bar-width: 3.5rem`、`--sidebar-width: 14.75rem`、`--context-width: 19rem`；`--control-min: 2.75rem` 不变。
- 壳层：`.collaboration-cockpit` 桌面四列跟 case；`.activity-bar` 深色 rail + 当前项 accent 填充；`.cockpit-sidebar` 对话目录密度（项目切换、搜索 pill、线程行、标签、底栏）；`.cockpit-flow` 群聊（线程头、transcript、composer 浮层）；`.cockpit-context` 看板（tab、任务卡、审批卡、记忆卡）。只改样式与必要的可访问性结构，不改 props/路由/领域接口。
- 未定义的 `--surface-muted` / `--border`（A-257 遗留）本片一并接到暖陶 hairline/panel，禁止继续引用空变量。
- 设置/引导/复核：不重排；随 token 变色即可。
- 视觉契约测试同波次改为暖陶断言（含 DESIGN.md↔tokens 同步）；不得弱化 44px、三态、axe。

## Testing Decisions

- 缝 1 CSS 契约：`visual-tokens.test.ts` / `theme-tokens.test.ts` 断言暖陶核心色、明暗双块、栏宽 56/236/304、`--control-min` 仍为 2.75rem、DESIGN.md↔tokens 同步。
- 缝 2 jsdom 壳层：`cockpit-layout.test.tsx`、`activity-bar.test.tsx`、对话列表/群聊/看板相关既有组件测试覆盖三态、键盘、aria、44px；桌面四列可见（导航 complementary + 群聊 region + 上下文 complementary）。
- 缝 3 真实浏览器：theme-prepaint、亮暗、desktop 四列与 narrow 抽屉；axe 0 serious/critical；preview 页展示暖陶样例。
- 回归：聚焦 RED/GREEN；收尾一次全量 `npm test`、`npx tsc --noEmit`、`npm run build`、受影响 smoke（theme + threads + context）+ 全量 smoke 一次。

## Out of Scope

- 新窄屏导航、新 Thread/Mission 领域行为、schema、路由语义、props 契约。
- 设置页 / onboarding / 复核工作区的信息架构重排。
- 复制 case 里的示例文案、假数据或 Lucide CDN；产品继续用既有图标与真实数据。
- 动效系统、通知、新 Structured Message Block 类型。

## Further Notes

- 项目级 review 豁免（AGENTS.md，2026-08-09）：不伪造 spec/architecture/code-review 工件。
- 037/S-53 本片期间暂停；实现不得丢弃其未提交 T-01 文件，也不得在那些文件上继续开发。
- 用户确认: auto-approved 2026-08-14（grill AAAAA；A-258～A-263；演示验收可驳回）
