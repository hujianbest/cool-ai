# 统一设置导航计划

- 日期: 2026-08-08
- frame: ./frame.md

## 1. 需求

### FR-1: 可深链设置分区
- 描述: `/team?section=<id>` 直接打开技能、模型服务或 Agent 分区；无效/缺失 section 安全回退技能分区。
- 验收标准:
  - Given 直接打开合法 section When 页面渲染 Then 对应 tab 与 panel 激活，刷新保持
  - Given section 无效 When 页面渲染 Then 回退 skills 且不崩溃；浏览器前进/后退同步选中态

### FR-2: 设置分区检索
- 描述: owner 能按分区名称、用途与关键词筛选设置入口并打开结果。
- 验收标准:
  - Given 输入中文或英文关键词 When 去除首尾空白并不区分英文大小写检索 Then 只显示匹配名称、用途或关键词的可用分区，不检索/渲染 API key 或实体内容
  - Given 无匹配结果 When 渲染 Then 显示带清除检索 CTA 的 empty state；清除后恢复全部入口

### FR-3: 固定常用入口
- 描述: owner 能固定/取消固定设置分区，固定入口显示在 ActivityBar 并在刷新后保持；偏好保存最近 100 条非敏感 pin/unpin 历史。
- 验收标准:
  - Given 不同标签同时写不同分区或对同一分区反向操作 When storage 事件乱序到达 Then 按 section 的 Lamport clock + writerId 确定性合并，不丢失无冲突写入、不接受陈旧状态且所有标签收敛
  - Given 写入成功 When 查看偏好历史 Then 每次操作具有 clock、writerId、eventId、section、action 与 changedAt；最近 100 条刷新后保持且不记录搜索词、凭据或实体数据
  - Given localStorage 不可用、值损坏、写失败或含未知 ID When 加载/写入 Then 忽略无效值或回滚，显示非阻塞公告并保持导航可用

### FR-4: 返回原上下文
- 描述: 从工作台进入设置时携带受控 `returnTo`，桌面与窄屏都能返回原项目上下文；外部或非法地址回退 `/`。
- 验收标准:
  - Given 从 `/projects/<id>` 进入设置 When 点击返回 Then 回到同一项目
  - Given 重复参数、编码斜杠/反斜杠、点段、query/hash、协议/协议相对地址、空或多段项目路径 When 解析 returnTo Then 回退 `/`
  - Given 切换/检索打开 section When 构造 URL Then 使用 URLSearchParams 保留合法 returnTo；浏览器前进/后退持续由当前 URL 派生选中态

## 2. 设计

### 现状与改动面
- `app/team/page.tsx`: 服务端解析唯一 `section`、`returnTo` 参数，只传规范化合法值。
- `components/settings-navigation.ts`: 三个分区的稳定 ID、标签、用途、关键词、availability 与纯 URL helper。
- `components/settings-preferences-store.ts`: SSR-safe external store、按 section 合并的版本化 localStorage envelope、同窗口/跨标签同步、历史上限与失败回滚。
- `components/team-panel.tsx`: 当前 URL 是唯一 section 状态源；检索、固定、返回入口和窄屏 dialog/focus 行为。
- `components/activity-bar.tsx`: 消费同一 preference store，普通团队入口与固定深链都携带由当前 `activePath` 规范化的 returnTo。
- `components/project-panel.tsx`: 把当前 `/projects/<id>` 路径传给 ActivityBar，使项目上下文回返路径真实可达。
- `app/cockpit.css`: 只增加使用既有 token 的搜索、结果行、固定态和空状态样式。
- `tests/`: 分区路由、检索、固定、storage 失败、returnTo 安全与桌面/窄屏路径。

### 信息架构与交互
- 焦点任务: owner 快速定位并进入一个设置分区；搜索框和匹配结果位于团队导航顶部，资源内容仍是主区。
- 结构: ActivityBar 一级入口 → 团队设置二级导航 → Skills/Providers/Agents 内容；不建立空壳设置页。
- 固定入口复用 `.activity-bar-item`，用现有 `ChatIcon/TeamIcon` 的线性图标容器与分区首字母文本，不新绘 SVG；不与工作/团队争夺一级层级。
- 窄屏搜索结果打开后关闭 dialog，焦点在路由完成后落到活动 panel 标题；Escape/关闭/返回恢复到各自触发按钮；清除检索后焦点回搜索框；storage error 公告不抢焦点。

### 状态矩阵
| 交互 | loading | empty | error | success/focus |
|---|---|---|---|---|
| URL 导航 | N/A：服务端已有规范值 | N/A：至少 skills 可用 | 非法值规范到 skills/`/` | panel 标题获焦，history 由 URL 派生 |
| 静态搜索 | N/A：同步元数据 | 无结果 + 清除 CTA | N/A：无外部输入 | 打开结果；清除后焦点回搜索 |
| 固定偏好 | hydration 时容器 `aria-busy`，按钮 disabled | 无固定项时不造占位入口 | `role=status` 非阻塞公告，写失败回滚 | `aria-pressed`、即时 ActivityBar、revision/updatedAt |

### 视觉与 craft 约束
- 延续 Cool AI 暖色、紧凑工具界面和四级表面；不引入新色、渐变、阴影、字体、图标依赖或装饰动效。
- 复用 `.nav-item`、`.button-ghost`、`.button-secondary`、`.state-message`、`.activity-bar-item` 与 `--control-min`、`--interactive-soft`、`--interactive-soft-hover`、`--border-subtle`、`--surface-card`；不新增图标资产。
- 页面签名是“设置入口即团队资源”，搜索与固定都围绕现有 Skills/Providers/Agents，而非通用 SaaS 设置模板。

### 数据与路由契约
```typescript
type SettingsSectionId = "skills" | "providers" | "agents";
type SettingsSection = {
  id: SettingsSectionId;
  label: string;
  purpose: string;
  keywords: readonly string[];
  available: true;
};
type SettingsPreference = {
  version: 1;
  clock: number;
  pinned: SettingsSectionId[];
  registers: Record<SettingsSectionId, {
    pinned: boolean;
    clock: number;
    writerId: string;
    changedAt: string;
  }>;
  events: {
    clock: number;
    writerId: string;
    eventId: string;
    changedAt: string;
    action: "pin" | "unpin";
    section: SettingsSectionId;
  }[];
};
const PINNED_SETTINGS_KEY = "cool-ai:pinned-settings:v1";
const MAX_SETTINGS_AUDIT_EVENTS = 100;
function parseSingleParam(value: string | string[] | undefined): string | null;
function parseSettingsSection(value: string | string[] | undefined): SettingsSectionId;
function parseReturnTo(value: string | string[] | undefined): "/" | `/projects/${string}`;
function buildSettingsHref(section: SettingsSectionId, returnTo: string): string;
```
- localStorage 仅保存每个 section 的 LWW register、派生固定 ID 与最近 100 条事件；截断历史不影响 registers 的当前事实，不保存搜索词、凭据或实体数据。
- preference store 用 `useSyncExternalStore`：每标签持有 session writerId；事件按 eventId 去重，register 按 `(clock, writerId)` 总序择新，历史同序保留最新 100 条；接收远端后合并而非覆盖并幂等回写 canonical envelope。固定 server snapshot 保持稳定，写失败不发布新 snapshot。
- 本地操作的 `clock = 1 + max(envelope.clock, 所有 register/event clock)`；writerId 是 browsing context 内稳定 UUID（sessionStorage 不可用时退回内存），eventId 是 writerId + clock + 随机 UUID，测试可注入确定值。
- 纯 `mergePreferences(a,b)` 对每个 section 取 `(clock,writerId)` 较大 register；同一 `(clock,writerId)` 内容冲突时取 canonical register JSON 字典序较大项并标记损坏公告。事件按 eventId 并集，碰撞时同样取 canonical JSON 字典序较大项；按 `(clock,writerId,eventId)` 升序并只保留最后 100 条。`pinned` 固定按 `SETTINGS_SECTIONS` 顺序从 registers 派生，envelope clock 取所有已观察最大值，展示更新时间从总序最大的 winning register `changedAt` 纯派生，字段与数组序列化顺序固定。
- merge 必须满足交换律、结合律、幂等性；storage 事件合并结果与当前持久化 canonical 字节相同则不写，与内存 snapshot 相同则不发布通知，避免跨标签回写循环。
- `returnTo` 只接受恰好一个参数，值严格为 `/` 或 `/projects/[A-Za-z0-9_-]+`；URLSearchParams 已解码后拒绝 `%`、反斜杠、控制字符、点段、query/hash、空段和额外路径。
- TeamPanel 的 section 直接来自当前服务端 searchParams prop；点击用 `router.push(buildSettingsHref(...))`，非法初始值由服务端 `replace` 语义规范化，前进/后退触发新 prop 而无本地副本。

### 关键决策
- 深链选择 URL query，而非新增路由文件：三个资源已共用 TeamPanel，query 能保留当前组件和 tab 语义。
- 固定偏好选择 localStorage，而非 SQLite/API：它是单 owner、单浏览器的非敏感展示偏好，避免新增业务写模型。
- 可追溯性选择有界 LWW-map envelope：每次 pin/unpin 追加 clock/writerId/eventId/section/action/changedAt；register 保留最终状态，最近 100 条只读历史避免 localStorage 无界增长。

### 错误处理
- 非法 section → skills；非法 returnTo → `/`。
- localStorage 异常 → 固定功能失败关闭、旧 snapshot 保留并以 `role=status` 公告；未知 ID 过滤，损坏 envelope 回到空 clock 0；陈旧/乱序 snapshot 合并而不倒退。
- 搜索只针对静态元数据，不触发网络请求、不进入日志。

## 3. 测试策略

- 组件: 初始深链、push 保留 returnTo、新 prop/history 同步、键盘 tab；中英/大小写/空白/用途匹配、availability、无结果/清除。
- store: SSR/client snapshot、hydration busy、LWW registers、事件去重/100 条边界、不同/相同 section 并发、陈旧乱序、损坏/未知/抛错 rollback、同窗口/跨标签/重挂载。
- 安全: 重复参数、编码斜杠/反斜杠、`%`、点段、query/hash、协议/协议相对、空/多段项目路径拒绝；搜索不含实体/密钥。
- 项目回返: 从真实 `/projects/<id>` 的 ActivityBar 普通团队入口与固定入口进入设置后，返回 href/导航保持同一项目；直接 team 深链回退 `/`。
- 可访问性: tablist、search、`aria-pressed`、status、44px 目标、窄屏打开结果/清除/Escape/返回的焦点路径。
- 回归: `npm test`、`npm run build`、`npm run smoke:team`；真实桌面/窄屏截图与 axe critical 0。
- demo: 桌面从项目进入设置→检索并打开→固定→返回项目→ActivityBar 入口→刷新保持；窄屏重复检索/固定/返回并验证焦点；另走恶意 returnTo 回退 `/`，用连续浏览器步骤与截图记录。

## 4. UI 设计

- 复用既有设计证据 `app/tokens.css`、`app/cockpit.css` 和 S-8/S-9 已验收壳层，不创建第二视觉系统。
- loading/empty/error/success/focus 已在上文逐项定义；所有视觉值必须使用现有 token。
- 反 slop: 无装饰渐变/glow/glass/emoji 图标；每个新元素直接对应 FR-2、FR-3 或 FR-4。

## 5. 任务清单

- [x] T-1 设置元数据与严格 URL helper (覆盖: FR-1, FR-2, FR-4) — 判据: section/用途/availability、重复与编码绕过 returnTo、结构化 href 的纯函数测试先红后绿
- [x] T-2 URL 驱动分区与安全返回 (覆盖: FR-1, FR-4) — 判据: 服务端规范化、push 保留 returnTo、prop/history 同步及桌面/窄屏返回测试先红后绿
- [x] T-3 设置分区检索与焦点 (覆盖: FR-2) — 判据: 中英/大小写/空白/用途/availability、无结果、清除和窄屏结果焦点测试先红后绿
- [x] T-4 SSR-safe 固定偏好 store (覆盖: FR-3) — 判据: hydration、完整 revision/section/action/time 历史、损坏/未知/抛错 rollback、同窗口/跨标签同步测试先红后绿
- [x] T-5 固定控件、审计历史与 ActivityBar 快捷入口 (覆盖: FR-3) — 判据: 即时、跨路由/刷新同步、只读历史、深链、aria-pressed/status/失败焦点测试先红后绿
- [x] T-6 窄屏键盘与状态收口 (覆盖: FR-2, FR-3, FR-4) — 判据: dialog 关闭、panel/搜索/触发器焦点与 loading/empty/error/success 状态矩阵测试先红后绿
- [x] T-7 偏好并发合并与历史容量 (覆盖: FR-3) — 判据: merge 交换/结合/幂等、两上下文同/异 section 并发、陈旧乱序、canonical 无回写循环和 100 条边界测试先红后绿
- [x] T-8 真实项目 ActivityBar 回返 (覆盖: FR-4) — 判据: 普通团队入口与固定入口从 `/projects/<id>` 进入后都携带合法 returnTo，桌面/窄屏返回同项目测试先红后绿
- [x] T-9 [verification-only] 清理生成噪声并核对 diff 范围 — 判据: `next-env.d.ts` 与无关 `tests/review-browser-smoke.mjs` 恢复仓库版本且对应 git diff 为空；不改变产品或测试行为，运行现有相关测试通过
- [x] T-10 S-9 浏览器 smoke 与 demo 自动化 (覆盖: FR-1, FR-2, FR-3, FR-4) — 判据: 新增失败的 S-9 浏览器契约后实现连续桌面/窄屏、固定/刷新/审计、恶意 returnTo 和 axe 路径，定向运行通过；S-9 新增同名搜索/固定控件后，旧 review smoke 必须以精确 combobox selector 保持 provider 选择兼容（非无关噪声）
- [x] T-11 [verification-only] 全量 UI 回归与真实渲染 (覆盖: FR-1, FR-2, FR-3, FR-4) — 判据: 全量测试/build/S-9 smoke 通过，完整桌面/窄屏 demo、恶意 returnTo 与 axe 机器输出在 `features/011-settings-navigation/evidence/` 落盘
