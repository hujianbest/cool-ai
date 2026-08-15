# 规格

## Problem Statement

owner 打开驾驶舱时，左栏、右栏和设置页同时摊开创建表单、分区说明和文字按钮，视觉噪声盖过对话与看板。038 只对齐了暖陶色板与四列栅格，没有改变「表单常驻 + 文字说明常驻」的交互语言。owner 要求按 UI UX Pro Max 推倒重来：输入框在点击按钮后弹出，说明做成帮助提示，能用图标就不要用文字。

## Solution

把驾驶舱改成 **图标优先、渐进披露** 的安静工作台：chrome 与工具用 Phosphor 线性图标（`aria-label` 中文名）；创建/编辑/绑定等表单放进 `role="dialog"` 浮层，仅在 owner 点按后出现；说明段落改成可键盘操作的 HelpTip（禁止 hover-only `title` 作为唯一帮助）。暖陶色板、四列栅格、44×44 热区、窄屏抽屉与既有路由/props 不变。群聊 composer 作为主工作面保持常驻（A-351）。

## User Stories

1. As owner, I want 导航、工具和上下文 tab 用图标表示并用 aria-label 读出名称, so that 栏内不再堆文字按钮。
2. As owner, I want 打开文件夹、创建使命/任务/记忆、绑定工作区、创建模型服务/技能/Agent 的输入框只在我点击对应按钮后弹出, so that 列表与看板不被表单占满。
3. As owner, I want 字段说明和空状态补充解释放在可点击/可聚焦的帮助提示里, so that 默认视图安静，需要时仍能读到完整说明。
4. As owner, I want 浮层表单仍有可见 label、焦点环、Escape 关闭与提交反馈, so that 披露后的表单可访问且可恢复。
5. As owner, I want 亮/暗主题、窄屏抽屉和既有协作流程不回归, so that 改版只收噪声不丢能力。

## UI 设计

### 信息架构

- 桌面四列与 D-9/D-46 不变：rail / Thread 目录 / 群聊 / 看板。
- 窄屏仍用现有项目 / 编辑 / 上下文抽屉（A-352）；抽屉工具栏改为图标按钮。
- 右栏 tab 与设置资源 tab 改为图标 + `aria-label`（名称与现文案一致：共享记忆、上下文预览、骨架运行、审批、审计；技能、模型服务、Agent）。
- 产品标识只保留 mark；「协作驾驶舱 / Cool AI」进入 sr-only 或 HelpTip，不占侧栏正文。

### 渐进披露

常驻：列表、消息、看板卡、composer、搜索 pill（目录过滤）。

点按后弹出（`ActionDialog`）：

- 打开文件夹（路径表单）
- 绑定/保存工作区
- 创建/编辑使命、任务
- 写入共享记忆；记忆检索筛选项（类型/来源/版本）收入检索浮层
- 创建/编辑 Provider、Skill、Agent（桌面不再常驻右侧编辑器）

浮层：`role="dialog"`、可见标题、焦点陷阱、Escape/关闭按钮、提交 loading→success/error。字段必须有可见 `<label>`，禁止 placeholder-only。

### 帮助提示

- HelpTip 是按钮（Question 图标），`aria-expanded` / `aria-controls`，点击或 Enter/Space 打开，再次点击或 Escape 关闭。
- 不得把唯一说明放在 `title` 或 hover-only tooltip。
- 空状态保留一句短状态 + 图标 CTA；长解释进 HelpTip。

### 图标系统

- 库：`@phosphor-icons/react`，`weight="regular"`，控件 20px，装饰 `aria-hidden`。
- 交互图标控件必须有中文 `aria-label`，适用时暴露 `aria-pressed` / `aria-expanded` / `aria-current`。
- 禁止 emoji 充当结构图标。主题切换用 Sun/Moon，不用「日/夜」字。

### 交互三态

- 列表/看板/设置：既有 loading / empty / error。
- 浮层提交：disabled + busy 文案；失败 `role="alert"` 且保留输入。
- 焦点环继续 `--focus-ring`；控件 `--control-min` 44px。

### 反粗制滥造

拒绝第二交互强调色、渐变、玻璃、发光、emoji 图标、hover-only 作为唯一帮助、无 label 的浮层输入。

## Implementation Decisions

- 新增共享原语（入站 UI Adapter，非领域 Module）：`IconButton`、`HelpTip`、`ActionDialog`；复用 `useModalSurface` / `trapModalFocus`。
- Provider/Skill 桌面编辑器从「旁路常驻 aside」改为与窄屏相同的 dialog（去掉 `(!narrow || editorOpen)` 常驻分支）。
- 打开文件夹：侧栏只留图标 opener；表单进 dialog。onboarding「使用现有表面打开文件夹」打开同一 dialog 并聚焦路径字段。
- 测试：可访问名称保持中文动词；原先假定表单已在 DOM 的用例改为先点 opener。ActivityBar 补 `aria-label`（不再只靠 `title`）。
- `product/ui/DESIGN.md` 增补交互语言（icon-first / overlay form / HelpTip）；色板与栏宽不改。preview 增加图标按钮、HelpTip、ActionDialog 样例。
- 不改 schema、路由语义、领域 Interface、安全边界。

## Testing Decisions

- 缝 1 原语 jsdom：IconButton 必须有 accessible name 且 44px；HelpTip 键盘开关且关闭后焦点回到按钮；ActionDialog 打开后焦点进入、Escape 关闭、表单可见 label。
- 缝 2 壳层：activity-bar / cockpit-layout / context tabs 断言图标控件的 aria-label 等于原文字名称；侧栏默认找不到「文件夹路径」；点「打开文件夹」后出现 dialog。
- 缝 3 设置与看板：Provider/Skill 桌面默认无编辑字段；点创建后 dialog 内有 label。使命/记忆/工作区同理。
- 缝 4 真实浏览器：受影响 smoke（theme/settings/threads/context）+ 全量 smoke 一次；axe desktop/narrow × light/dark 0 serious/critical。
- 回归：聚焦 RED/GREEN；收尾 `npm test`、`npx tsc --noEmit`、`npm run build`。

## Out of Scope

- 更换暖陶色板或四列栅格。
- 把群聊 composer 藏进按钮（A-351）。
- 新 Thread/Mission 领域行为、schema、路由。
- 动效系统、新 Structured Message Block、复制 Phosphor 以外的品牌资产。

## Further Notes

- 项目级 review 豁免（spec/architecture/hf-review；本片不强制 hf-code-review）。不伪造评审工件。
- 用户确认: auto-approved 2026-08-15（grill 取用户明确指示；A-341～A-352；演示验收可驳回）
