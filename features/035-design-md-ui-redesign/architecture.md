# 架构 — 035 DESIGN.md 设计基座与应用壳层

- 日期: 2026-08-12
- 对应规格: `spec.md`
- 用户确认: auto-approved 2026-08-12（项目级 review 豁免，AGENTS.md 2026-08-09；不伪造 spec/architecture 评审工件）

## 对齐产品架构

落点在 `product/architecture.md` 的「入站 UI Adapter」（components/ 与 app/ 全局样式）与「跨切面」设计令牌：本片不新增领域事实，不改写任何 owner 的 Capability Interface，schema 零变更。越界项：既有暖色 token 条款（D-18/A-67 的色板）由 A-242 替换为 DESIGN.md 语言，ship 演示验收后回写 `product/decisions.md`；其余 IA（D-9/A-17 三栏+窄屏抽屉）不变。

## 本片模块与缝

新增/触及模块（均属入站 UI Adapter 与交付证据，不属领域 Module）：

1. **设计令牌 Module** —— `DESIGN.md`（产品级契约，原样）+ `app/tokens.css`（CSS 投影）+ 扩展 token（状态/Agent 身份/布局）。Interface：全部具名 token 及其语义；调用方（组件 CSS 与 preview 页）只经 `var(--token)` 消费。Seam：`tests/browser/cockpit-shell/visual-tokens.test.ts` 与 `theme-tokens.test.ts`（含 DESIGN.md 核心 token 同步断言）。
2. **壳层与公共组件 Module** —— activity rail、侧栏、线程头、上下文面板框架、button/status chip/panel/message block/approval card/composer。Interface：既有 props/aria 契约不变（行为不改），仅样式与可访问性结构收敛。Seam：jsdom 组件测试（三态/键盘/aria/44px）+ 真实浏览器 smoke/axe。
3. **设计目录页 Module** —— `preview.html` / `preview-dark.html` 静态资产。Interface：可打开的独立页面，展示 token 色板、字阶、组件规格。Seam：浏览器打开断言关键 token/组件存在。

深模块原则：token Module 是小接口大行为（一个 `var(--token)` 驱动全仓样式）；壳层组件只收敛样式不改 props，保持既有接缝深度，删除测试成立（删除本片后 token 纪律重回到 N 个散落字面量）。

## 核心数据

无 schema/表变更。数据面仅为 CSS 自定义属性：`DESIGN.md` 核心 token（accent/ink/canvas/parchment/pearl/tile/black/muted/divider/hairline/字体/圆角/间距/阴影）→ `tokens.css` 声明 → 组件引用。明暗各一套，`[data-theme]` 驱动。

## 关键流程

1. **契约流**：DESIGN.md 核心值 → tokens.css 声明 → 组件 `var()` 引用 → 视觉契约测试断言同步；改 token 必须先改契约测试（RED）。
2. **主题流**：`theme-prepaint.js` + `[data-theme]` → 明暗 token 块切换 → 壳层/组件跟随，FCP 前恢复、无闪烁（既有机制复用）。
3. **验收流**：preview 页展示 token 目录 → smoke 断言 + axe（desktop/narrow、light/dark）→ 全量回归 → 演示验收 → ship。

## 横切偏离

- 项目级 review 豁免（AGENTS.md 2026-08-09）记录于 progress.md；无 spec/architecture 评审文件，不伪造。
- ext-design-md 官方 `npx @google/design.md` 校验面向 Stitch 规范文件；根目录 DESIGN.md 为第三方 Apple 分析原文件（用户要求原样），格式不适用官方校验器，改用 tokens.css↔DESIGN.md 同步测试兜底并记录。
- 安全/凭据/审计横切不适用（纯 UI Adapter 切片）；工作区=不适用。

## ADR 链接

本片无新 ADR；视觉方向替换（A-242）为可逆默认，ship 验收后追加 `product/decisions.md`（D-46）；DESIGN.md 产品级落位（A-239）与排期（A-240）已在假设台账。
