# 架构 — 038 暖陶工作台驾驶舱

- 日期: 2026-08-14
- 对应规格: `spec.md`
- 用户确认: auto-approved 2026-08-14（项目级 review 豁免，AGENTS.md 2026-08-09；grill AAAAA；不伪造评审工件）

## 对齐产品架构

落点在 `product/architecture.md` 的入站 UI Adapter（`components/`、`app/tokens.css`、`app/cockpit.css`）与跨切面设计令牌。本片不新增领域事实，不改任何 Capability Interface，schema 零变更。越界：035 的 Apple 色板（A-245/A-246）由 A-258 替换为 case 暖陶；D-9 三栏 IA 保留，左栏语义明确为 Thread 目录。窄屏抽屉（A-17/A-261）不改。ship 后回写 `product/decisions.md` 视觉条款。

## 本片模块与缝

均属入站 UI Adapter / 交付证据，不是领域 Module：

1. **设计令牌 Module** — 新暖陶 `product/ui/DESIGN.md` + `app/tokens.css` 投影；Apple 原文归档。Interface：既有 CSS 变量名，值改为 case。Seam：`tests/browser/cockpit-shell/visual-tokens.test.ts`、`theme-tokens.test.ts`。
2. **驾驶舱壳层 Module** — `.collaboration-cockpit` 四列、activity rail、sidebar、flow、context。Interface：既有 DOM 角色（主导航、项目导航、任务事件流/群聊、当前上下文）与 props 不变。Seam：`cockpit-layout.test.tsx`、`activity-bar.test.tsx`、`responsive-layout.test.ts`。
3. **三栏 chrome Module** — 对话列表、群聊（线程头/消息/composer/结构化块）、右栏（tab/任务卡/审批卡/记忆卡）。Interface：既有组件 props。Seam：既有 jsdom 协作/看板/审批测试 + 样式断言；不测私有实现。
4. **设计目录页 Module** — `preview.html` / `preview-dark.html` 改为暖陶样例。Seam：`preview-pages.test.ts`。

深度：调用方仍只写 `var(--token)`；栏宽与色板一处变更，三栏与设置页同时跟随。删除本片后视觉退回 Apple 投影，测试应失败。

## 核心数据

无表。数据面 = DESIGN.md 暖陶 YAML → tokens.css 自定义属性 → 组件 `var()`。明暗由 `[data-theme]` 切换，复用 `theme-prepaint.js`。

## 关键流程

1. **契约流**：case 色板写入 DESIGN.md → RED 更新视觉测试期望 → GREEN 投影 tokens.css（含 56/236/304 与 44px 底线）。
2. **壳层流**：桌面四列 + rail/侧栏/群聊/看板 chrome 按 case；窄屏抽屉媒体查询保持 `--breakpoint-cockpit: 56.25rem`。
3. **验收流**：preview → smoke:theme/threads/context → axe desktop/narrow × light/dark → 全量测试/tsc/build → 演示。

## 横切偏离

- 项目级 review 豁免，无 spec/architecture 评审文件。
- 安全/凭据/审计横切不适用。
- 037 未提交治理审计文件本片只读不改。

## ADR 链接

无新 ADR（色板替换可逆，验收后写入 `product/decisions.md`）。假设：A-258～A-262。
