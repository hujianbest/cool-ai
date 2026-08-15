# 架构 — 049 图标优先安静驾驶舱

- 日期: 2026-08-15
- 对应规格: `spec.md`
- 用户确认: auto-approved 2026-08-15（项目级 review 豁免；grill 取用户明确指示；不伪造评审工件）

## 对齐产品架构

落点在入站 UI Adapter（`components/`、`app/cockpit.css`、`product/ui/DESIGN.md`）。不新增领域事实，不改 Capability Interface，schema 零变更。D-9 三栏 IA 与 D-46 暖陶视觉保留。技能 UI UX Pro Max 约束交互语言（Minimalism、density 9、Phosphor、overlay form、operable help），不覆盖已确认色板。

## 本片模块与缝

均属入站 UI Adapter / 交付证据：

1. **交互原语 Module** — `IconButton`、`HelpTip`、`ActionDialog`（复用 `mobile-dialog` 焦点陷阱）。Interface：`aria-label` 必填、dialog 标题、HelpTip 展开态。Seam：`tests/browser/cockpit-shell/icon-first-primitives.test.tsx`。
2. **壳层 chrome Module** — activity rail、窄屏工具栏、产品 mark、上下文/设置 tab 图标化。Interface：既有 landmark / tab 名称不变。Seam：`activity-bar.test.tsx`、`cockpit-layout.test.tsx`、`context-accessibility.test.tsx`。
3. **披露表单 Module** — 打开文件夹、工作区绑定、使命/任务、记忆写入与检索、Provider/Skill/Agent 编辑器改为点按后 dialog。Interface：既有提交 API 与字段 id。Seam：`project-panel.test.tsx`、`mission-board.test.tsx`、`memory-panel.test.tsx`、`provider-panel.test.tsx`、`skill-panel.test.tsx`、`agent-panel.test.tsx`、onboarding 打开文件夹段。
4. **设计契约 Module** — DESIGN.md 交互条款 + preview 样例。Seam：preview 测试与视觉 token（色板断言不改）。

深度：删除原语后，图标按钮与浮层帮助应无法满足新断言；领域测试仍应能通过 opener→dialog 路径完成原命令。

## 核心数据

无表。偏好与领域写入路径不变。图标来自 `@phosphor-icons/react`（regular / 20px / currentColor）。

## 关键流程

1. Owner 点图标 opener → ActionDialog 打开 → 初始焦点到标题或首字段 → 提交沿用现有 fetch/command → 成功关闭并还原焦点到 opener。
2. Owner 点 HelpTip → 展开说明 → Escape 关闭并还原焦点。
3. 窄屏：抽屉仍由现有 toolbar 开关；抽屉内 opener 弹出的 dialog 叠在抽屉之上（复用既有 layered `useModalSurface`）。

## 横切偏离

- 纯 UI，hf-code-review 豁免（未命中 schema/安全/跨 owner 写/>8 票）。
- 凭据仍只出现在 Provider dialog 内，不回显明文。

## ADR 链接

无新 ADR。假设 A-341～A-352。ship 后把交互语言回写 `product/decisions.md`。
