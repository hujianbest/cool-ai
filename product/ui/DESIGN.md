---
version: alpha
name: Cool-AI-warm-gold-cockpit
description: A local-first multi-agent cockpit on warm beige with a warm-gold accent. Chat-first shell — 52px icon rail, 240px conversation sidebar, centered chat flow, floating composer. Governance (mission/memory/approval/audit) lives behind the icon rail. Token-driven, quiet, high-whitespace, WCAG AA in both themes.
confirmed: 2026-08-15
---

# Cool AI 暖金驾驶舱设计契约（DESIGN.md）

本文件是 Cool AI 界面**视觉令牌与壳层组件**的单一事实源：颜色、字体、间距、圆角、阴影与壳层组件都由此定义，并由 `app/tokens.css` 投影为运行时令牌。任何界面改动不得在组件内硬编码设计值。

用户体验、人物、旅程、信息架构与交互全态见 [`UI设计.md`](./UI设计.md)（UCD）。两份文档一起构成产品「UI 设计」。

## 0. 确认与参考

- 用户 2026-08-15 确认：(1) 整体换成暖米 + 暖金视觉方向（替换陶土绿 accent）；(2) 治理面板收进左侧图标轨，主路径只留会话；(3) 先产出本契约，再按「图标轨 → 会话栏 → 聊天主区 → 空状态」四步改壳层，最后逐页收敛。
- 参考对象为用户指定的 Clowder AI 会话优先驾驶舱（localhost:3003）。只取信息架构与视觉方向，不复用其名称、猫角色、文案、商标或品牌资产。

## 1. 设计原则

1. **会话优先**：主路径只有对话。治理（使命 / 记忆 / 审批 / 审计）收进 52px 图标轨，按需打开为视图，不占主界面。
2. **安静工作台**：高留白、弱边框、极少阴影、无装饰动画；层次靠色彩明度与字重，不靠浮层堆叠。
3. **令牌驱动**：所有颜色/间距/圆角/字号来自本契约与 tokens.css；禁止组件内硬编码。
4. **无障碍底线**：正文对比 ≥4.5:1（亮/暗各自独立验证）；控件 ≥44px；图标按钮有可访问名称与 tooltip；焦点可见。
5. **窄屏可退让**：桌面三区（轨/侧栏/主区）在窄屏退化为抽屉模型，图标轨常驻。

## 2. 全局信息架构

### 桌面布局

```text
┌────┬──────────┬────────────────────────────────────┐
│ 图 │ 会话侧栏   │ header（产品名 · 项目/Thread 语境 · 动作） │
│ 标 │ 240px    ├────────────────────────────────────┤
│ 轨 │ 标题「对话」 │ 主区（居中聊天流，max 840px）             │
│ 52 │ + 新对话  │                                    │
│ px │ 过滤 tabs │  ┌──────────────────────────────┐  │
│    │ 线程列表   │  │ composer（浮起，圆角 12px）        │  │
│    │ 回收站    │  └──────────────────────────────┘  │
└────┴──────────┴────────────────────────────────────┘
```

- **图标轨 52px**：主项为 对话 / 任务 / 记忆 / 审批 / 审计；底部分隔后为 团队 / 设置 / 主题。纯图标 + tooltip，选中态为暖金。
- **会话侧栏 240px**：标题「对话」+「+ 新对话」；过滤 tabs（全部 / 收藏 / 标签）；线程列表；底部「回收站」。
- **header**：左产品名，中当前项目 + Thread 语境，右动作（打开文件夹、Needs Me 徽标）。
- **主区**：聊天流宽度上限 840px 居中；无项目时显示 1:1 对话；治理视图打开时替代聊天流，带「返回对话」。
- **composer**：浮于主区底部，圆角 12px、1px 弱边框，占位符说明 @ 与 / 命令；左「添加」（上下文/附件），右发送。

### 空状态

一句欢迎 + 一行可操作引导（例如「输入 @规划 让规划 Agent 开始」）+ 可选「第一次来？开始引导」卡片。不展示未接线的表单。

## 3. 色板（暖米 + 暖金）

### 亮色主题

| 令牌 | 值 | 用途 |
|---|---|---|
| `--color-canvas` | `#F4EFE7` | 应用底色 / 主区背景 |
| `--color-canvas-parchment` | `#FAF6F1` | 侧栏 / 面板背景 |
| `--color-surface-pearl` | `#FEFBF8` | 卡片 / 浮起表面 |
| `--color-rail` | `#EAE4DA` | 图标轨背景 |
| `--color-ink` | `#221E1C` | 主文字 |
| `--color-ink-muted-80` | `#595451` | 次级文字（AA） |
| `--color-ink-muted-48` | `#847F7B` | 弱化文字 / 占位 |
| `--color-divider-soft` | `#E8E3DC` | 细分隔线 |
| `--color-hairline` | `#B2ADA9` | 边框 |
| `--color-primary` | `#9A5F1A` | 主按钮（暖金 600，白字 AA） |
| `--color-primary-focus` | `#794819` | 主按钮 hover / 焦点 |
| `--color-primary-on-dark` | `#E4B066` | 暗底上的暖金强调 |
| `--color-on-primary` | `#FFFFFF` | 主按钮文字 |

暖金阶（由 `--color-primary` 派生）：`#FFF3DF` / `#FCE4C4` / `#F4CD99` / `#E4B066` / `#CC9140` / `#B77B29` / `#9A5F1A` / `#794819` / `#593215` / `#3A1E0E`。

状态色（亮）：queued `#8F5E12` / running `#9A5F1A` / success `#4F6B2E` / danger `#A34B32`，surface 对应 `#FDF3E0` / `#FBF3E6` / `#EFF5E6` / `#F9E9E2`。

### 暗色主题

| 令牌 | 值 |
|---|---|
| `--color-canvas` | `#1E1B17` |
| `--color-canvas-parchment` | `#26221D` |
| `--color-surface-pearl` | `#2E2923` |
| `--color-rail` | `#16130F` |
| `--color-ink` | `#F2EDE6` |
| `--color-ink-muted-80` | `#A79F95` |
| `--color-ink-muted-48` | `#847C72` |
| `--color-divider-soft` | `#332F29` |
| `--color-hairline` | `#4A453D` |
| `--color-primary` | `#E4B066`（暖金 300，深字 AA） |
| `--color-primary-focus` | `#F4CD99` |
| `--color-on-primary` | `#3A1E0E` |

## 4. 字体

- 家族：`Inter, -apple-system, "PingFang SC", "Noto Sans SC", "Segoe UI Variable", "Microsoft YaHei UI", system-ui, sans-serif`。
- 字号：基础 16px；标题 20/18px；辅助 14px；元信息 12px。
- 行高：正文 1.5，标题 1.3，紧凑列表 1.35。
- 字重：正文 400，标题/强调 600，状态徽标 600。

## 5. 间距 / 圆角 / 阴影

- 间距节奏 4/8px：`--space-xxs: 4px`、`--space-xs: 8px`、`--space-sm: 12px`、`--space-md: 16px`、`--space-lg: 24px`、`--space-xl: 32px`。
- 圆角：小控件 8px（`--rounded-sm`）、输入/卡片 12px（`--rounded-md`）、浮层/对话 16px（`--rounded-lg`）、胶囊 9999px。
- 阴影：极轻。卡片 `0 1px 2px rgba(34,30,28,0.05)`；浮起 composer `0 8px 24px rgba(34,30,28,0.10)`；抽屉 scrim 不变。

## 6. 组件规范

- **activity-bar-item**：48×48 触区（图标 20px，线性 stroke 1.5）；选中态 = 暖金图标 + 4px 圆点指示或左侧圆角条；hover 背景 `color-mix(ink 6%, transparent)`；tooltip 用 `title` + `aria-label`。
- **sidebar**：背景 `--color-canvas-parchment`；分组标题 12px 600；线程项 44px 高、hover 弱底色、选中态暖金左侧条 + 标题加重。
- **filter tab**：胶囊按钮 32px 高，选中 = 暖金 soft 底（`--interactive-accent-soft`）。
- **header**：48px 高，左产品名（16px 600），右动作按钮 44px。
- **composer**：圆角 12px、1px `--color-hairline`、背景 `--color-surface-pearl`；聚焦 ring 暖金；占位符 `--color-ink-muted-48`；左附加按钮 44px，右主按钮 44px。
- **empty-state**：居中，图标（Phosphor 线性 48px，`--color-ink-muted-48`）+ 标题（18px 600）+ 引导（14px muted）+ 主按钮。
- **dialog**：16px 圆角、`--color-surface-pearl`、scrim `rgba(20,16,10,0.4)`、标题 18px 600。
- **button**：主按钮 = 暖金 600 底 + 白字（hover 700）；次级 = parchment 底 + 边框；ghost = 无底。高度 ≥44px。
- **badge / status-label**：12px 600，pill，语义 surface 底 + 语义色字，对比 ≥4.5:1。
- **agent avatar**：36px 圆，名字首字 14px 600，暖金家族色对（fg/bg），聚焦可见。

## 7. 壳层交付步骤

1. **图标轨**：52px、纯图标 + tooltip、治理入口（任务/记忆/审批/审计）接线到按需视图。
2. **会话侧栏**：240px、标题「对话」+「+ 新对话」、过滤 tabs（全部/收藏/标签）、线程列表、底部「回收站」。
3. **聊天主区**：header（产品名/语境/动作）、居中聊天流（max 840px）、浮起 composer。
4. **空状态**：欢迎 + @Agent 引导 + 首次引导入口。

每步验收：tsc 通过、聚焦测试绿、真实渲染截图对照（亮/暗）、axe 无 critical。

## 8. 反模式

- 不再为单个面板引入新的常驻右栏或新的「信息百科」主路径。
- 不再把使命/记忆/审批/审计的完整表单摊在栏内；治理入口只在图标轨。
- 不复制 Clowder 品牌文案、猫角色与资产；不逐字拷贝其调色盘，只对齐暖米 + 暖金方向。
