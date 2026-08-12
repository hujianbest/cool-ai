# 规格

## Problem Statement

Cool AI 驾驶舱自 S-8/S-10 后采用暖色自研 token，但视觉契约散落在 `app/tokens.css` 与组件样式里，没有产品级、机器可读的设计单一事实源；新页面（审计、队列、回收站等）各自增量叠加样式，层级、密度与交互语言逐渐漂移。owner 需要一个以 `DESIGN.md` 为准的完整设计语言，并让应用壳层与公共组件先统一到该语言下，再逐面收敛其余页面。

## Solution

以仓库根目录 `DESIGN.md`（Apple-design-analysis 原文件，A-241）为产品级设计契约，建立其 CSS 投影 `app/tokens.css`（核心色板/字体/圆角/间距/阴影直接对齐 DESIGN.md，产品扩展 token 单独定义），并首批重构应用壳层（activity rail、侧栏、线程头、上下文面板框架）与共享公共组件（button、status chip、panel、message block、approval card、composer）到新语言：单一交互 accent、极简 chrome、强排版层级、白/羊皮纸/近黑交替表面、浮层单一阴影族、无装饰渐变与玻璃拟态（A-242）。布局 IA 保持桌面三栏 + 窄屏单抽屉（A-243）。交付配套 `preview.html` / `preview-dark.html` 设计语言目录页，供 owner 与后续切片直接查看 token、字阶与组件规格。

## User Stories

1. As owner, I want 根目录 `DESIGN.md` 作为产品级设计契约，so that 任何切片与设计 agent 都读取同一份设计语言。
2. As owner, I want 壳层与公共组件使用同一套 token（颜色/字体/圆角/间距/阴影），so that 页面层级、密度与交互语言不再漂移。
3. As owner, I want 亮/暗主题都基于 DESIGN.md 的明暗表面族，so that 两种主题下层级与对比度一致。
4. As owner, I want 关键交互覆盖 loading/empty/error（高风险另含 disabled/success/focus），so that 状态不依赖颜色单独表达且失败可恢复。
5. As owner, I want 预览页能展示 token 色板、字阶与组件规格（含暗色版），so that 验收与后续切片有可视化基准。
6. As owner, I want 全部既有页面在新 token 下不回归功能与可访问性，so that 改版不破坏既有流程。

## Implementation Decisions

- 契约落位：`/DESIGN.md` 保持逐字原样（A-239）；`app/tokens.css` 重写为核心 token 投影 + 扩展 token。核心色板取值自 DESIGN.md：accent `#0066cc`（暗面 `#2997ff`）、ink `#1d1d1f`、canvas `#ffffff`、canvas-parchment `#f5f5f7`、surface-pearl `#fafafc`、dark tiles `#272729/#2a2a2c/#252527`、surface-black `#000000`、body-muted `#cccccc`、ink-muted-48 `#7a7a7a`、divider-soft `#f0f0f0`、hairline `#e0e0e0`。字阶/圆角/间距对齐 DESIGN.md 刻度（display 56/40/34/28，body 17/14，caption 12；rounded 0/5/8/11/18/9999；spacing 4/8/12/17/24/32/48/80），按驾驶舱信息密度取用并保留 `--control-min: 2.75rem`、`--sidebar-width`、`--context-width`、断点等布局 token。
- 扩展 token（产品面）：语义状态色（queued/running/success/danger/review）、Agent 身份色六枚、focus-ring、shadow-panel（浮层单一阴影族）、安全区；均以 `--status-*`/`--agent-*` 命名，暗色版同步。
- 字体：`--font-sans` 保持 `-apple-system` 起头的系统栈（含 PingFang SC/Noto Sans SC/微软雅黑 UI），display 字阶采用负 letter-spacing（Design.md 纪律）；`--font-mono` 保留。
- 壳层与公共组件：只改样式与可访问性结构，不改变组件职责、路由、领域接口与 props 契约；交互三态沿用既有 state-message 范式；44×44px 由 `--control-min` 与组件 min-height 保证；纯图标控件保留 `aria-label`；焦点环统一 `--focus-ring`。
- 既有视觉契约测试（`tests/browser/cockpit-shell/visual-tokens.test.ts`、`theme-tokens.test.ts` 等）随本切片同波次更新为新 token 断言，不得弱化断言；新增 tokens.css↔DESIGN.md 核心 token 同步断言。

## Testing Decisions

- 公共缝 1（CSS 契约）：`visual-tokens.test.ts`/`theme-tokens.test.ts` 断言新 token 声明、明暗双块完整性与 DESIGN.md 核心 token 同步（accent/ink/canvas/parchment/pearl/tile/black/body-muted/muted/divider/hairline 等）。
- 公共缝 2（jsdom 组件）：壳层与公共组件测试覆盖三态（loading/empty/error，高风险含 disabled/success/focus）、键盘可达、aria 名称、44px 控件；不测试私有实现。
- 公共缝 3（真实浏览器）：theme-prepaint、亮暗切换、壳层导航在 desktop/narrow 下的真实渲染；axe 无 serious/critical；preview 页可达。
- 回归：全量 `npm test`、`npx tsc --noEmit`、`npm run build`、受影响 smoke 套件（theme/settings/threads/context 至少一项）+ 全量 smoke 一次。

## Out of Scope

- 业务面板（使命看板详情、审计列表、队列面板等）的组件级重构——只受新 token 影响，不重写结构；后续切片逐面收敛。
- 新窄屏导航模型、全局消息 redesign、动效系统、通知系统、新 block 类型。
- 修改领域模块、schema、路由语义、安全边界与既有 props 契约。
- 复制 Apple 品牌资产（logo、图片、文案）；只采用其 DESIGN.md 中的设计 token 与纪律。

## Further Notes

- 项目级 review 豁免（AGENTS.md，2026-08-09）适用于本特性；豁免记录在 progress.md，不伪造评审工件。
- 视觉方向（A-242）以 ship 演示验收为最终确认点；验收不通过则按反馈回滚或调整 token 后重跑。
- 参考证据：`product/ui/cool-ai-design-md-case.html`（暖陶工作台案例，作为格式与结构参考；色板以 `product/ui/DESIGN.md` 为准）。

- 用户确认: auto-approved 2026-08-12（A-240～A-244；演示验收在 ship 阶段呈上）
