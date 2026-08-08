# 渐进式首次使用引导计划

- 日期: 2026-08-08
- frame: ./frame.md

## 1. 需求
### FR-1: 正式最薄首次旅程
- 优先级: 必须
- 描述: owner 按 Provider→Agent→项目选择→workspace→members→使命创建→项目群聊启动协作前进；目标只在正式 Mission + CollaborationRun 入口受理，不调用旧 Task executor。
- 验收标准:
  - Given 空库 When 完成旅程 Then 存在 verified Provider、合格项目成员、`workspace.status=ready`、Mission，以及带 `run_started` 与 owner message 的 CollaborationRun
  - Given 协作已启动 When 引导完成 Then 只宣告“目标已受理/协作已启动”；后续仍走 planned work→Execution(`sourceCollaborationRunId`)→非执行者 Review→Delivery

### FR-2: 真实事实与复核资格
- 优先级: 必须
- 描述: 完成度只从现有 Provider/Agent/Project/Workspace/Members/Mission/Collaboration API 派生。
- 验收标准:
  - Given 一个项目 When 判定 members ready Then 至少两名不同成员均关联 verified Provider，且其中至少一名 `reviewCapable=true`、另一名可作为角色分离的未来执行者
  - Given 正式执行者以后确定 When 复核 Then 仍由现有 review 服务动态要求 reviewer 属于项目、reviewCapable、Provider verified 且 `reviewerId != executorId`；引导资格不替代该检查

### FR-3: 多项目 URL 与历史
- 优先级: 必须
- 描述: 当前阶段由 URL 的 `provider|agent|project-select|workspace|members|goal` 唯一表达，项目 ID 只在合法 `/projects/<id>` 路径。
- 验收标准:
  - Given 0/1/多个项目 When 到 `project-select` Then 均要求 owner 明确创建或选择，不静默选首个；无效/不存在 ID 显示错误并返回选择
  - Given next/back/forward/refresh When 重放 Then provider/agent 使用 `/team?section=...&guide=...`，其余使用 `/?guide=project-select` 或 `/projects/<id>?guide=...`，且同一 URL 得到同一子状态

### FR-4: 可恢复控制状态
- 优先级: 必须
- 描述: skip/reset/dismiss/resume/complete 跨刷新和标签确定性收敛，业务事实不入偏好。
- 验收标准:
  - Given skip When 前进 Then 只置该 step skip register；reset 可清单步/全部 skip 并激活；dismiss 关闭；resume 激活且可选择 reset skipped；仅正式入口事实齐全才能 complete
  - Given completed 后资源失效 When 重新检测 Then completed 历史不倒退，显示 drift/repair 与缺失事实；只有 owner 显式 reset 才重开完整引导

### FR-5: 失败关闭且不重复写
- 优先级: 必须
- 描述: Guide retry 只 GET；业务写结果不确定时先事实对账，绝不自动重发。
- 验收标准:
  - Given POST/PUT 网络失败 When 对账 Then 可由唯一事实确认成功才前进；无法确认则留在原表面提示人工核对，不承诺 Project/Mission 等 API 幂等
  - Given Provider secret、workspace 或运行治理 When 引导 Then 不持久化/回显秘密、路径、使命正文；绑定 ready 不等于执行 handle，执行时仍重新取得 verified handle 并进入 sandbox/审批/审计/复核

### FR-6: 响应式与可访问
- 优先级: 必须
- 描述: 桌面和窄屏覆盖 loading/empty/error/success/disabled/focus，亮暗主题均清晰。
- 验收标准:
  - Given 键盘和 390px viewport When 跨路由、开关 drawer/dialog、失败重试 Then 主标题→引导状态→目标控件焦点顺序稳定，dialog trap/Escape/restore 优先于跨路由聚焦，live region 不重复播报
  - Given axe/对比度检查 When 渲染关键状态 Then critical/high 为 0，字段错误关联、标题不跳级、禁用原因可感知，正文 ≥4.5:1、关键边界 ≥3:1

### NFR（有来源）
- NFR-1 viewport 390px — 出处: S-9/S-10 既有窄屏测试基线 — 验证: Playwright 固定 viewport。
- NFR-2 触控目标 ≥44×44px — 出处: `product/product.md` 可访问性边界与 `--control-min:2.75rem` — 验证: computed size。
- NFR-3 WCAG AA（正文 4.5:1、大字/边界 3:1；critical/high 0）— 出处: product.md、ext-ui-design/ui-checklist — 验证: token 对比度 + axe。
- 范围外: 旧 Task API、自动造角色/目标、第二业务配置源、执行/复核/交付自动完成、Clowder 品牌/角色/文案/资产。

## 2. 设计
### 源码核验后的正式入口
- `MissionBoard` 先 `POST /api/projects/:id/mission` 创建唯一 Mission；`CollaborationPanel` 无活动 run 时 `POST /api/projects/:id/runs`，返回 `created/message/run` 并落 `run_started`。run 后续产出 work items，Execution 强制 `sourceCollaborationRunId`，Review 服务再按项目 membership + verified Provider + reviewCapable + 非 executor 校验。
- 复用上述组件、`ProviderPanel`、`AgentPanel`、`ProjectPanel`、`WorkspaceSetup`、`MembersSetup`；Guide 仅导航、检测、聚焦和解释，不复制表单/提交器。架构边界不变。

### URL 与多项目转移
- provider→`/team?section=providers&guide=provider&returnTo=/`；agent→同页 agents；next→`/?guide=project-select`。
- project-select 始终显示真实列表与创建入口；点击已有项目或创建响应明确返回 `project.id` 才 push `/projects/<id>?guide=workspace`；next 依次 push workspace→members→goal。back/forward 只解析当前 URL，不用组件 state 改写历史。
- 非法重复 guide、非法 project path、项目 GET 中不存在的 ID均 error；不回退首项目。deep link 前置缺失显示 earliest blocker CTA，但地址保持，owner 明确操作后才导航。project ID 不进 localStorage/event。

### 状态机与偏好
```typescript
type Step="provider"|"agent"|"project-select"|"workspace"|"members"|"goal";
type Status="active"|"dismissed"|"completed";
type Register<T>={value:T;clock:number;writerId:string;changedAt:string};
type Preference={version:1;clock:number;status:Register<Status>;
 skips:Record<Step,Register<boolean>>;events:GuideEvent[]};
```
- status 是独立 LWW register；status/skips 分别按 `(clock,writerId)`、同版本 canonical JSON 决胜，events 按 eventId 并集后保留 100 条；exact parser、同窗口 event、跨标签 storage、写失败回滚。
- skip:`false→true` 后 next；reset:`true→false`（单步/全部）并 status=active；dismiss: active→dismissed；resume: dismissed→active（默认保留 skip，可显式 reset）；complete: active + 全事实 satisfied→completed；completed + drift→completed/repair；completed 只能显式 reset→active。每次记录非敏感 action/step/time，不记 ID/名称/path/secret/正文。

### 最小 API envelope/parser
- GET `/api/providers` `{providers:[{id,status,verifiedAt,...}]}`；GET `/api/agents` `{agents:[{id,providerId,reviewCapable,...}]}`；另有 AgentPanel GET `/api/agent-templates` `{templates:[]}`、`/api/skills` `{skills:[]}`，只由原组件消费。
- GET `/api/projects` `{projects:[{id,name,createdAt}]}`；GET workspace `{workspace:null|{path,status:"ready"},projectVersion:int>=1}`；GET members `{members:[{agentId,...}],projectVersion:int>=1}`。
- GET mission `{mission:null|{id,projectId,title,goal,version,...},workItems:[]}`；GET collaboration `{run:null|{id,projectId,status,...},projectMessagesPage:{items,nextAfter},timelinePage:{items,nextAfter},pendingDecision,usage,readiness}`。Goal satisfied 要求同项目 Mission、run、其 owner message 及引用该 message 的 `run_started`。
- 每个 Guide parser 校验 envelope 对象、必需数组/枚举/正整数及跨对象 ID 关系；无效即 error，不用 TypeScript cast 充当校验。workspace `ready` 只代表绑定事实；执行阶段由现有 sandbox preflight 重新打开并验证 handle。
- 原表面写入保持：POST provider verify `{draft}`→`{validationToken,verifiedModel}`、POST providers `{draft,validationToken}`→`{provider}`、POST agents→`{agent}`、POST projects `{name}`→`{project}`、PUT workspace→`WorkspaceState`、PUT members→`MembershipState`、POST mission `{title,goal}`→`{mission}`、POST runs `{message,operationId,mentionAgentId?}`→`{created,message,run}`。Guide 不发这些写请求。

### 失败对账与安全
- Guide retry 仅重跑相关 GET。业务写异常后依次 GET 当前事实：能按响应 ID/项目唯一 Mission/run_started 明确确认才前进；Project/Provider/Agent 无返回 ID 时不按名称猜，显示“核对列表后重试”，不自动重发。run 虽有 operation receipt，UI 仍只允许 owner 显式重试。
- 资格 join：`members.agentId→agents.id→providers.id`；成员数≥2、所有候选 Provider verified、至少一名 reviewCapable 且有另一不同成员。正式 review 仍动态排除 executor。
- 不读写旧 `/tasks`；不保存 API key/path/goal/message；不削弱 verified-handle、sandbox、approval、operation/version、独立 review、审计。

## 3. 测试与 demo
- 每任务先增加精确失败断言/浏览器场景再实现；browser contract 从 T-1 建立，T-4~T-10 在对应行为实现前逐场景扩展。定向 Vitest 后跑 `npm test`、`npm run build`、`npm run smoke:onboarding`。
- demo 使用监听随机 localhost 端口的确定性 OpenAI-compatible stub（`/models`,`/chat/completions`），隔离 `COCKPIT_DB_PATH`、临时 workspace/execution root、固定时钟/响应与网络/API/storage 失败注入；仅断言 Authorization 存在，不把 key/body secret 写日志/JSON。
- 稳定证据: `onboarding-happy-desktop.png`、`onboarding-existing-refresh-desktop.png`、`onboarding-drift-repair-narrow-dark.png`、`onboarding-error-focus-narrow.png`、`onboarding-results.json`；JSON 含步骤/URL/history/focus/live-region/axe/token/GET-write-count，demo 后 `reviews/demo-acceptance.md` 写 `结论: 通过` 与 `auto-approved 2026-08-08`。

## 4. UI 设计
- ActivityBar 入口→页面内引导区→既有表面；窄屏引导在当前可见面板顶部。跨路由先更新标题，再一次 polite status，最后聚焦目标；若 dialog/drawer 打开，其 trap/Escape/restore 完成后才路由聚焦；error 用 assertive alert，状态摘要不重复播报。
- loading `aria-busy`；empty 必有 CTA；error+retry；success 文本+图形；disabled 用 `aria-describedby` 解释；字段 `aria-invalid/describedby`、标题顺序、原生 button/label、focus ring、reduced motion 全覆盖。
- 只用 `--surface-panel`、`--surface-main`、`--surface-card`、`--text-primary`、`--text-secondary`、`--text-subtle`、`--border-subtle`、`--border-strong`、`--interactive-primary`、`--interactive-primary-hover`、`--interactive-soft`、`--interactive-soft-hover`、`--status-queued-surface`、`--status-running-surface`、`--status-success-surface`、`--status-danger-surface`、`--success`、`--warning`、`--danger`、`--space-2`、`--space-3`、`--space-4`、`--space-6`、`--radius-sm`、`--radius-md`、`--focus-ring`、`--control-min`；无新字面颜色/字号/间距、渐变/glow/glass/emoji/装饰动效。

## 5. 任务清单
- [x] T-1 最薄纵向路径：完整既有资源 owner 从入口明确选项目、创建 Mission、在项目群聊启动 CollaborationRun (覆盖: FR-1, FR-2) — 判据: browser+组件 RED→GREEN，确认 run_started/owner message 且无 `/tasks`
- [x] T-2 纯状态机与严格 URL/history parser (覆盖: FR-3, FR-4) — 判据: 六子状态、0/1/N 项目、非法/重复/deep-link/back/forward/refresh RED→GREEN
- [x] T-3 status/skips LWW store (覆盖: FR-4, FR-5) — 判据: skip/reset/dismiss/resume/complete/drift、并发/损坏/回滚/100 事件 RED→GREEN
- [x] T-4 Provider 检测与原表面接入 (覆盖: FR-1, FR-2, FR-5) — 判据: verified/unavailable、GET retry、写后不确定对账、secret 拒绝 RED→GREEN，并先扩 browser
- [x] T-5 Agent join 与未来复核资格 (覆盖: FR-1, FR-2) — 判据: verified provider、两成员角色分离、reviewCapable 与动态非 executor 契约 RED→GREEN
- [x] T-6 显式项目选择/创建接入 (覆盖: FR-1, FR-3, FR-5) — 判据: 0/1/N 均不猜、返回 ID 才导航、未知 POST 不重发 RED→GREEN
- [x] T-7 workspace 绑定接入 (覆盖: FR-1, FR-5) — 判据: ready/null/error/rebind、执行期 verified-handle 仍强制 RED→GREEN
- [x] T-8 members 配置与资格修复接入 (覆盖: FR-1, FR-2, FR-5) — 判据: 两成员、Provider/reviewer 缺口、version conflict/GET 对账 RED→GREEN
- [x] T-9 正式 Mission+Collaboration goal 入口 (覆盖: FR-1, FR-5) — 判据: POST 后 GET 对账、operation receipt 显式重试、accepted≠delivered RED→GREEN
- [x] T-10 安全、跨路由 focus/live/dialog 与 UI 五态 (覆盖: FR-5, FR-6, NFR-1, NFR-2, NFR-3) — 判据: 390px/双主题、44px、WCAG high、播报/焦点优先级 RED→GREEN
- [x] T-11 真实 browser demo 与全量回归 (覆盖: FR-1, FR-2, FR-3, FR-4, FR-5, FR-6, NFR-1, NFR-2, NFR-3) — 判据: stub/隔离/失败注入、4 PNG+JSON、auto-approved 验收及 test/build/smoke 全绿
- [x] T-12 主旅程继续与 dismiss/resume 返修 (覆盖: FR-1, FR-4) — 判据: 入口从 Provider 开始，满足步骤正常继续不写 skip；dismiss 隐藏主体且刷新/跨标签 resume 恢复，测试先红后绿
- [x] T-13 六类事实严格 envelope parser (覆盖: FR-2, FR-5) — 判据: Provider/Agent/Project/Workspace/Mission/Collaboration 缺键、额外键、非法枚举/关联均失败关闭，测试先红后绿
- [x] T-14 旅程内未知写入统一 GET 对账 (覆盖: FR-4, FR-5) — 判据: Mission create/update、Collaboration start/message 的响应丢失均唯一事实对账且不自动重发，测试先红后绿
- [x] T-15 正式治理联结回归 (覆盖: FR-5) — 判据: onboarding 场景触发并证明执行期重新取得 verified handle、review 动态排除 executor、sourceCollaborationRunId 关联，测试先红后绿
- [x] T-16 全表面 axe 与证据重生成 (覆盖: FR-6, NFR-1, NFR-3) — 判据: 完整页面、复用表单、dialog/drawer 在 desktop/390px 与双主题 critical/high 0，重新生成 JSON/PNG 并全量回归
