# 任务票

- [x] T-01 交互原语与设计契约 — Blocked by: None — 增加 `@phosphor-icons/react`；实现 `IconButton`、`HelpTip`、`ActionDialog`；`DESIGN.md` 写入 icon-first / overlay / HelpTip 条款（色板不改）；cockpit.css 增加 dialog/help/icon-button token 化样式。RED=`tests/browser/cockpit-shell/icon-first-primitives.test.tsx` 因原语缺失失败；GREEN=最小实现后通过。验证该文件。
- [x] T-02 壳层图标 chrome — Blocked by: T-01 — ActivityBar / 窄屏工具栏 / 产品 mark / 上下文 tab / 设置资源 tab 改为 Phosphor 图标 + 中文 aria-label（名称与现文案一致）；主题用 Sun/Moon。RED=更新 `activity-bar.test.tsx`、`cockpit-layout.test.tsx`、`context-accessibility.test.tsx` 为图标名称/不再要求侧栏常驻「Cool AI」正文与常驻 primary「打开文件夹」表单提交；GREEN=最小 chrome。验证上述聚焦测试。
- [x] T-03 打开文件夹与设置编辑器浮层 — Blocked by: T-01 — 文件夹路径表单、Provider/Skill 桌面编辑器改为 dialog（与 Agent 一致）；onboarding 现有表面入口打开同一 dialog。RED=更新 `project-panel.test.tsx`、`provider-panel.test.tsx`、`skill-panel.test.tsx`、相关 onboarding/code-review 用例：默认 DOM 无路径/编辑字段，点 opener 后出现。GREEN=最小披露改动。验证这些文件。
- [x] T-04 看板与记忆披露 — Blocked by: T-01 — 使命创建/编辑、任务创建、工作区绑定、记忆写入与检索筛选项收入 dialog/浮层；短空状态 + HelpTip。RED=更新 `mission-board.test.tsx`、`memory-panel.test.tsx`、workspace/project-setup 相关用例。GREEN=最小披露。验证这些文件。
- [ ] T-05 preview 与全量验收 — Blocked by: T-02, T-03, T-04 — preview 增加 IconButton/HelpTip/Dialog 样例；`npx tsc --noEmit`、`npm test`、`npm run build`、受影响 smoke（theme/settings/threads/context）+ 全量 smoke；axe 0 serious/critical。演示证据落盘 `features/049-icon-first-cockpit/evidence/`。Linux 云环境已完成 tsc/build、browser 642、smoke/settings/team（axe 0 critical）。`npm test` 全量与 `smoke:context` 文件树依赖 Windows verified-handle；`smoke:threads` reply-highlight 待跟。

约束：只触碰 UI Adapter、DESIGN.md、preview、相关测试与 `@phosphor-icons/react`。不改领域模块、schema、路由语义、安全边界。每票先 RED 再最小 GREEN；不得弱化断言、skip 或 mock 被测主体；无硬编码视觉字面量；浮层输入必须有可见 label。
