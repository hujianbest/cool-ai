# 任务票

- [x] T-01 设计令牌契约投影 — Blocked by: None — 将根目录 DESIGN.md 核心 token（accent/ink/canvas/parchment/pearl/tile/black/muted/divider/hairline/字阶/圆角/间距/阴影）映射为 `app/tokens.css` 明暗两套声明，保留布局/控制/安全区扩展 token；RED=更新 `tests/browser/cockpit-shell/visual-tokens.test.ts` 与 `theme-tokens.test.ts` 为新契约断言（含 DESIGN.md↔tokens 核心 token 同步断言）先行失败，GREEN=最小改写 tokens.css 后通过；验证 `npx vitest run tests/browser/cockpit-shell/`。
- [x] T-02 应用壳层收敛 — Blocked by: T-01 — activity rail、侧栏、线程头、上下文面板框架按新 token 收敛视觉层级与密度，props/aria/路由契约零变化；RED=jsdom 壳层测试（三态、焦点、44px、aria 名称、窄屏抽屉）先行失败，GREEN=样式与可访问性结构最小改写；验证聚焦测试 + `npx tsc --noEmit`。
- [x] T-03 公共组件收敛 — Blocked by: T-01 — button、status chip、panel、message block、approval card、composer 按新 token 与 DESIGN.md 纪律收敛（单一 accent、极简 chrome、单一阴影族），交互三态（loading/empty/error，高风险含 disabled/success/focus）可验证；RED=jsdom 组件测试先行失败，GREEN=样式最小改写；验证聚焦测试。
- [x] T-04 设计目录页 — Blocked by: T-01 — 新增 `preview.html`/`preview-dark.html`（token 色板、字阶、圆角/间距、组件规格样例，Apple DESIGN.md 纪律），真实浏览器打开可见；RED=契约断言（页面存在、关键 token 名称与组件样例出现）先行失败，GREEN=页面落盘；验证浏览器打开 + 断言。
- [x] T-05 全量验证与验收证据 — Blocked by: T-02, T-03, T-04 — 全量 `npm test`、`npx tsc --noEmit`、`npm run build`、受影响 smoke（theme/settings/threads/context 至少一项）与全量 smoke 一次、axe desktop/narrow × light/dark 0 serious/critical、演示截图与结果 JSON 落盘 `features/035-design-md-ui-redesign/evidence/`；所有票勾选后交 ship。

约束：只触碰设计面（`app/tokens.css`、`app/cockpit.css`、壳层/公共组件样式与测试、preview 页）；不修改领域模块、schema、路由语义、props 契约与安全边界；每票先 RED（因行为缺失/契约变更失败）再最小 GREEN；不得弱化断言、skip 或 mock 被测主体；全程令牌纪律，不引入硬编码视觉字面量。
