# 任务票

- [x] T-01 暖陶设计契约投影 — Blocked by: None — 将 Apple `product/ui/DESIGN.md` 归档为 `product/ui/archive/apple-design-analysis.md`，写入暖陶 YAML DESIGN.md（case 色板/圆角/字阶）；`app/tokens.css` 保持变量名、改值为 case，布局 token 56/236/304px，`--control-min` 仍 2.75rem，补齐 `--surface-muted`/`--border`。RED=更新 `visual-tokens.test.ts` 与 `theme-tokens.test.ts` 为暖陶断言先行失败；GREEN=最小改写 DESIGN.md+tokens.css 后通过。验证 `npx vitest run tests/browser/cockpit-shell/visual-tokens.test.ts tests/browser/cockpit-shell/theme-tokens.test.ts`。
- [x] T-02 驾驶舱四列壳层 — Blocked by: T-01 — `.collaboration-cockpit` 桌面 `56px 236px 1fr 304px`；activity rail 深色轨道+当前项 accent；sidebar/flow/context 表面与分隔线跟 case；窄屏抽屉行为与 44px 热区不回归。RED=壳层 jsdom（`cockpit-layout.test.tsx`、`activity-bar.test.tsx`、`theme-activity-bar.test.tsx`）为新栏宽/rail 视觉先行失败；GREEN=最小改 `cockpit.css`/activity-bar 样式。验证聚焦壳层测试 + `npx tsc --noEmit`。
- [x] T-03 左对话与中群聊 chrome — Blocked by: T-02 — Thread 目录（项目切换、搜索 pill、线程行、标签、底栏）与群聊（线程头、消息、结构化块、composer 浮层）视觉对齐 case；props/aria/发送与列表行为不变。RED=既有协作/线程导航 jsdom 补样式/44px/三态断言先行失败；GREEN=最小样式。验证相关聚焦测试。
- [x] T-04 右侧看板状态 chrome — Blocked by: T-02 — 上下文 tab、使命任务卡、审批卡、记忆卡视觉对齐 case；既有 tab 切换与审批动作不变。RED=mission-board / approval / memory 既有 jsdom 补视觉断言先行失败；GREEN=最小样式。验证相关聚焦测试。
- [x] T-05 preview 与全量验收 — Blocked by: T-03, T-04 — preview/preview-dark 改为暖陶目录；全量 `npm test`、`npx tsc --noEmit`、`npm run build`、smoke:theme + smoke:threads + smoke:context 及全量 smoke 一次；axe desktop/narrow × light/dark 0 serious/critical。演示证据落盘 `features/038-warm-terracotta-cockpit/evidence/`。

约束：只触碰设计面（`product/ui/DESIGN.md`、归档、`app/tokens.css`、`app/cockpit.css`、壳层/协作/看板相关样式与测试、preview 页）。不修改领域模块、schema、路由语义、props 契约、安全边界，不改 037 未提交文件。每票先 RED（行为/契约缺失）再最小 GREEN；不得弱化断言、skip 或 mock 被测主体；无硬编码视觉字面量。
