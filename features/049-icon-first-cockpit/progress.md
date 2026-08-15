# 进度

- 特性: 049-icon-first-cockpit
- 对应切片: S-59
- 当前阶段: implement（T-05 验收进行中）
- 执行模式: auto
- 已加载扩展: ui-ux-pro-max（`.cursor/skills/ui-ux-pro-max/`）
- 下一步: 剩余全链 smoke（context/threads/onboarding/collaboration/execution/review）在 Linux 上对齐 opener/dialog 后勾选 T-05 并 ship

## 状态记录

- 2026-08-15 用户指示当前 UI 杂乱（大量文字与常驻输入框），要求安装 UI UX Pro Max 技能并完全重新设计前端：输入框点击按钮后弹出，文字描述做成帮助提示，能用图标就不要用文字。
- 2026-08-15 已用 `npx ui-ux-pro-max-cli init --ai cursor` 安装技能。设计系统检索：Minimalism & Swiss、density 9、Phosphor 线性图标。色板仍用 D-46 暖陶（技能推荐的青绿/橙 CTA 不覆盖已确认决策）。
- 项目级 review 豁免适用于 spec/architecture/`hf-review`（AGENTS.md 2026-08-14 选择性评审）。本片为纯 UI、6 票、零 schema、不触安全边界或跨 owner 写，不强制 `hf-code-review`；豁免记录于此，不伪造评审工件。
- Grill 按用户明确指示取 A（A-341～A-352）；演示验收可驳回。
- 2026-08-15 to-spec / to-architecture / to-tickets 完成。项目级 spec/architecture 豁免，不伪造评审工件。6 张票，进入 implement。纯 UI 不强制 hf-code-review。
- 2026-08-15 implement：已落地 IconButton / HelpTip / ActionDialog；壳层与设置/看板/记忆/工作区表单改为点按弹出；CLI 同套件的 banner/slides 等技能未纳入本仓库，只保留 `ui-ux-pro-max`。
- 2026-08-15 修复 `useModalSurface`：仅在浮层真正关闭时还原 opener 焦点，避免 `options` 引用变化把键入抢回首字段。不确定写入与工作区冲突把操作收回页面（关闭 dialog），避免 inert 挡住核对/重载。
- 2026-08-15 验证（Linux 云环境）：
  - `npx tsc --noEmit` 通过
  - `npm run build` 通过
  - `tests/browser` 聚焦 642 通过（排除 Windows sqlite-jsdom 切片、缺生产构建的 review full-chain、以及当时未装浏览器的 theme-hydration）
  - `npm test` 全量在此 Linux 环境会因 Windows verified-handle/native adapter 失败（与本片无关）
  - smoke 通过：`npm run smoke`（axe 0 critical）、`smoke:settings`、`smoke:team`（PASS 后清理超时）
  - `smoke:threads` 在 reply-target-highlight 断言失败（1!==0），待跟
  - 演示截图（gitignore `features/**/evidence/`）：`features/049-icon-first-cockpit/evidence/smoke-desktop.png`、`smoke-narrow.png`、`smoke-team-desktop.png`
