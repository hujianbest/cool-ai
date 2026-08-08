# Cool 自有亮暗主题计划

- 日期: 2026-08-08
- frame: ./frame.md

## 1. 需求

### FR-1: 全局主题切换
- 描述: owner 能从所有主页面的 ActivityBar 在 Cool 亮色与暗色主题间切换。
- 验收标准:
  - Given 任一工作台/团队页 When 切换主题 Then 根元素 `data-theme`、原生 `color-scheme` 与按钮状态即时一致
  - Given 键盘或窄屏操作 When 聚焦/激活切换 Then 有明确 accessible name、44px 目标和可见焦点，不以颜色单独表达状态

### FR-2: 刷新与跨标签保持
- 描述: 本机非敏感主题偏好刷新、跨路由和其他标签页保持一致，默认仍是当前亮色。
- 验收标准:
  - Given 保存 dark When 刷新或打开另一标签 Then 首次绘制前就是 dark，无亮色闪烁
  - Given storage 不可用、损坏、旧版本或写失败 When 加载/切换 Then 安全回退 light 或保留旧主题，显示非阻塞错误且应用可用
  - Given 陈旧 storage 事件 When 接收 Then 不覆盖更高 revision；成功写入只记录 theme/revision/updatedAt

### FR-3: 双主题视觉与状态完整性
- 描述: `/`、项目页与 `/team` 的关键表面、文本、边框、按钮、表单、Agent 身份色及 loading/empty/error/success/focus 在两种主题下可读。
- 验收标准:
  - Given light/dark 任一主题 When 展示关键页面/三态 Then 无硬编码颜色穿透、层级与状态语义保持
  - Given 自动检查 When 计算正文/控件/状态 token 对比度并运行 axe Then 正文 ≥4.5:1、大字/非文本关键边界 ≥3:1，critical 为 0

## 2. 设计

### 改动面
- `app/tokens.css`: `:root` 保持 light；新增 `:root[data-theme="dark"]` 完整覆盖颜色/阴影/焦点 token 与 `color-scheme`。
- `public/theme-prepaint.js` + `app/layout.tsx`: 使用 `<head>` 内 parser-blocking 的外部同源静态 `<script src>`，在 Next client chunks 之前验证 envelope 并设置 html dataset；真实延迟 chunks 证明 `next/script beforeInteractive` 仍依赖 Next bootstrap、不能保证本场景无闪烁。脚本无 inline 内容/用户插值，兼容未来 `script-src 'self'`。
- `components/theme-preference-store.ts`: SSR-safe external store，独立 key、revision/updatedAt、同窗口 custom event、跨标签 storage 与陈旧事件拒绝。
- `components/activity-bar.tsx`: 增加文本主题切换按钮；hydration 前 disabled，失败以 `role=status` 公告。
- `tests/theme-*.{ts,tsx,mjs}` 与 `smoke:theme`: token/contrast、bootstrap、store、toggle、跨页面与真实双主题 demo。

### 主题状态契约
```typescript
type Theme = "light" | "dark";
type ThemePreference = { version: 1; revision: number; updatedAt: string; theme: Theme };
const THEME_KEY = "cool-ai:theme:v1";
```
- Server snapshot 为 `{hydrated:false, theme:"light"}`；prepaint 脚本只负责首次视觉，client effect 从 html/storage hydration 后成为交互事实源。
- Parser 要求 exact keys、version 1、`Number.isSafeInteger(revision) && revision >= 0`、canonical ISO updatedAt 与枚举 theme；拒绝额外字段、null、旧版本、超大数、无效日期、getter/Storage 异常。storage 删除事件在活跃标签忽略，刷新后缺失 key 回到 light。
- 本地切换先构造 revision+1 envelope，storage 写成功才发布。同窗口 custom event 同步；远端高 revision 胜，同 revision 不同值按固定字段顺序的 canonical JSON 字典序决胜，winner 必要时幂等回写且相同字节不写/不通知，使两个同时 N+1 的标签、第三标签与刷新收敛。
- html 使用 `suppressHydrationWarning` 仅覆盖 data-theme；prepaint 记录静态 `themeAtBootstrap/timestamp` 供 smoke 对比 FCP，不把 storage 字符串写入 DOM/脚本。hydration 前 toggle 只显示“主题偏好加载中”、disabled/aria-busy，不宣称 light/dark。

### 暗色 token（Cool 自有暖墨色）
| 组 | 暗色值 |
|---|---|
| surfaces | sunken `#151A18`; panel `#1B211F`; main `#202724`; card `#252D2A` |
| text | primary `#F3EFE7`; secondary `#D3CDC3`; subtle `#B5ADA1` |
| border | subtle `#807970`（对 card 约 3.29:1）; strong `#A69D91`; focus `#9AC6BC` |
| interactive | primary `#83B3A8`; hover `#9AC6BC`; soft `#2C403B`; soft-hover `#365149` |
| status fg | success `#8FC69E`; warning `#D4B66F`; danger `#E79288`; agent-warm `#D88B72` |
| status bg | queued `#3B3322`; running `#243B36`; success `#253A2C`; danger `#402925` |
| agent pairs | sage `#A6D6CB/#243B36`; terracotta `#E6A18C/#402C27`; gold `#E0C17A/#3B3322`; slate `#B9C7D6/#29343D`; rose `#E2A8B8/#3D2930`; olive `#C5CF8A/#343822` |
| shadows | `rgba(0,0,0,.28)` / `rgba(0,0,0,.42)`，仅沿用现有 shadow token |

### 页面/状态矩阵
| 页面/状态 | fixture/触发 | 核心断言 | PNG |
|---|---|---|---|
| `/` empty/light/desktop | 空隔离 DB | 引导 CTA、四级表面、axe | `theme-workbench-light-empty-desktop.png` |
| `/` error/dark/narrow | projects API 500 | error 文案、dark token、可见焦点 | `theme-workbench-dark-error-narrow.png` |
| `/projects/:id` loading/dark/desktop | 真实项目 + 延迟 context API | aria-busy/loading、无 light token | `theme-project-dark-loading-desktop.png` |
| `/projects/:id` success/light/desktop | seeded task/run | success、Agent pair、表单/卡片边界 | `theme-project-light-success-desktop.png` |
| `/team` empty/light/desktop | 无 Provider/Skill/Agent | 三种 empty、表单与设置导航 | `theme-team-light-empty-desktop.png` |
| `/team` hydration/dark/narrow | 预存 dark，延迟 Next client bundle | prepaint dark；toggle loading/disabled 不误报 | `theme-team-dark-hydration-narrow.png` |
| `/team` error+focus/dark/narrow | storage 写失败 + 键盘 toggle | status 公告、回滚、focus ring | `theme-team-dark-error-focus-narrow.png` |
- 基础矩阵另对 `/`、真实项目、`/team` × light/dark × desktop/narrow 共 12 组合逐一记录 computed token、toggle 状态与 axe；同步主题无业务 empty/error，分别由“无偏好=light”和 storage failure 覆盖。

### 视觉与交互
- 延续四级表面、紧凑密度和鼠尾草主交互；暗色是“暖墨纸面”，不是纯黑/霓虹/紫蓝默认主题。
- Toggle 复用 `.activity-bar-item`，可见文本按目标主题使用单字“夜/日”并配完整 aria-label；不新增 SVG、emoji、渐变、glow、glass 或动效。
- ActivityBar 现有挂载点为 ProjectPanel（覆盖 `/`、真实项目）和 TeamPanel（`/team`）；每处 toggle 恰好一个。loading: disabled/aria-busy；error: 非阻塞 status；success/focus: aria-pressed/name/44px/键盘与根主题一致。

### 错误与安全
- prepaint/parser 只接受严格 envelope；`</script>`、HTML、URL 等恶意字符串只会被拒绝，外部脚本源码不拼接 storage。
- preference 不含凭据、页面内容或系统主题指纹；搜索/Provider 数据不参与。
- 所有 CSS 色值只允许在 `tokens.css` 主题定义中出现，组件/CSS 继续只消费变量。

## 3. 测试策略

- token: light/dark 必需 token 集全等；产品 CSS 除 tokens 外无颜色字面量；正文、主按钮、状态与 Agent pair 对比度自动计算。
- bootstrap: 外部 beforeInteractive 顺序、无 inline/插值、恶意值、bootstrap timestamp≤FCP、dark 首绘与 hydration 无 mismatch。
- store: exact shape、安全整数/ISO/null/删除、读写异常、revision/rollback、真实双 Page 同时 N+1/不同到达顺序/第三 Page/刷新 canonical 收敛。
- UI: 两个 ActivityBar 挂载点与 `/`、项目、`/team` 集成；toggle 恰好一个、44px、键盘/focus/aria/status、跨路由。
- browser evidence: 上述 7 张状态 PNG + `theme-results.json`；JSON 含 12 个基础组合、7 个状态 fixture、bootstrap/FCP、真实双 Page 收敛、computed token、toggle 与 axe 结果，由临时 Playwright runner 生成后删除 runner，不改变仓库产品或测试行为。用户已明确豁免不存在的 `hf_gate.py run`，直接命令输出为本项目当前证据机制。
- verify 步骤: 先生成工作台/项目前 4 张 PNG 与中间 JSON，再扩展 `/team`、12 基础组合、剩余 3 状态、双 Page 收敛与 axe；发现产品缺陷即返回 build，不在 verify 修改实现。
- 回归: `npm test`、`npm run build`、既有 `npm run smoke`/`npm run smoke:settings`；临时 Playwright runner 只生成本 feature 稳定 PNG/JSON，不落入产品或测试源码。

## 4. 任务清单

- [x] T-1 暗色 token 与实际消费对比度 (覆盖: FR-3) — 判据: token 全等、CSS 字面量边界、表单/卡片/ActivityBar/focus/状态/Agent pair 对比度测试先红后绿
- [x] T-2 外部 prepaint bootstrap (覆盖: FR-2) — 判据: beforeInteractive 顺序、严格解析、恶意值、bootstrap≤FCP 与 hydration 契约测试先红后绿
- [x] T-3 主题偏好 store 收敛 (覆盖: FR-2) — 判据: exact envelope、回滚、窗口同步、真实双标签 N+1/第三标签/刷新 canonical 收敛测试先红后绿
- [x] T-4 ActivityBar 主题切换 (覆盖: FR-1, FR-2) — 判据: 两挂载点/三路由、hydration、唯一 toggle、44px/键盘/状态公告测试先红后绿
- [x] T-5 窄屏主题与内容布局返修 (覆盖: FR-1, FR-3) — 判据: 390px 下 ActivityBar 固定为第一列、mobile toolbar/活动 panel 使用第二列、drawer 正常覆盖；主题按钮单字不换行，错误 status 可见但不挤压导航，视觉回归测试先红后绿
- [x] T-6 代码评审行为返修 (覆盖: FR-1, FR-2) — 判据: 全量 Tab 顺序、read/invalid/write 公告、中性 hydration 文案与真实 hydration 无 mismatch 测试先红后绿
- [x] T-7 窄屏项目加载错误可见性 (覆盖: FR-3) — 判据: 390px 下 projects API 失败时无需打开隐藏侧栏即可看到非空 alert/status 与恢复动作，桌面行为不回归，测试先红后绿
- [x] T-8 parser-blocking prepaint 返修 (覆盖: FR-2) — 判据: 预存 dark 且延迟所有 Next client chunks 时，根主题仍在 FCP 前成为 dark；无 hydration mismatch/light 回写，外部 self CSP 形式保持，真实浏览器测试先红后绿
