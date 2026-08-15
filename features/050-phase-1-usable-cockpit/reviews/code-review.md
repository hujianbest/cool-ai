# 050 阶段1 code-review

## 权威结论（复审）

**PASS。** 初审两项严重均已关闭。未把未修一般项升格为严重。作者未自评通过；本复审为独立核对。

- 复审固定点: `5cf4d0b`（050/S-60 修复选夹生产门闩与空 roster 可重放入组）
- 复审范围: 初审固定点 `0a5288b` 之后至 HEAD（含 `f52d971`…`576e2c2` 实现与 `5cf4d0b` 修复）
- 复审日期: 2026-08-15
- 复审人: 独立 subagent 双轴（非实现作者）
- 聚焦测试（复审当场）: directory-picker / directory-picker.api / open-folder-starter-roster / starter-agents **4 文件 / 19 通过**（通过不等于本门通过；下列关闭判定来自对照实现）

### 严重项清单（复审）

| 项 | 轴 | 状态 |
| --- | --- | --- |
| `COCKPIT_SCRIPTED_DIRECTORY` 生产门闩：非 test 且无 `COCKPIT_ALLOW_SCRIPTED_PICKER=1` 时不得短路原生对话框；`NODE_ENV=production` 的 next start 不得被脚本化路径劫持 | Standards #1 + Spec #1 | **关** |
| OpenFolder 去掉 `created` 门闩后，空 roster + starters≥2 可重放；已有成员不覆盖 | Standards #2 + Spec/A-356 | **关**（用户不变量已满足） |
| 跨 owner 分事务、未用 UnitOfWork 单事务 | Standards #2 残余 | **不升严重**；降为一般（仍开） |

### 一般项清单（复审）

| 项 | 状态 |
| --- | --- |
| GET `/api/home` 上 ensure 写 | **仍开** |
| POST `/api/directory-picker` Request/body 校验 | **关** |
| `deleteAgent` 不存在的 `starter-*` 应为 404 而非 409 | **关** |
| Linux zenity 无 DISPLAY 应为 `PICKER_UNAVAILABLE`，取消才 cancelled | **关** |
| 驾驶舱仍有 HelpTip / onboarding 使命标题 | **仍开** |
| 跨 owner 分事务（UnitOfWork 残余，由严重降级） | **仍开（一般）** |

---

## 复审核对

### Standards

1. **严重（已关闭）** 脚本化选夹生产门闩。
   - `allowsScriptedPicker()` 仅当 `NODE_ENV === "test"` 或 `COCKPIT_ALLOW_SCRIPTED_PICKER === "1"` 时为真；`scriptedDirectory()` 在门闩为假时直接返回 `undefined`，即使 `COCKPIT_SCRIPTED_DIRECTORY` 非空也不短路。
   - `pickDirectory()` 先读脚本化结果，未授权则落入原生对话框（Windows PowerShell / macOS osascript / Linux zenity|kdialog）。
   - 测试：`NODE_ENV=production` 且无 allow 开关、脚本化路径非空、PATH 清空 → `PICKER_UNAVAILABLE`（Linux 当场执行，未 early-return）。显式 `COCKPIT_ALLOW_SCRIPTED_PICKER=1` 时生产 NODE_ENV 仍可脚本化，与 A-353 / 架构「冒烟专用开关」一致。
   - 冒烟 server env 已同时注入 allow 开关与脚本化路径（`npm run dev`，非未授权的 `next start`）。
   - UI `fetch("/api/directory-picker", { method: "POST" })` 无 body、无 content-type，不会被新路由校验误伤。
   - 证据：`src/adapters/outbound/workspace/directory-picker.ts:33-46`、`:90-92`；`tests/adapters/workspace/directory-picker.test.ts:83-111`；`tests/browser/browser-smoke.mjs:75-82`。

2. **严重（已关闭）** 空 roster 可重放入组；**一般（仍开）** 跨 owner 仍分事务。
   - 入组条件现为 `starters.length >= 2` 且 `membership.members.length === 0`，**不再读 `opened.created`**。无 Provider 首次打开得到空 roster（201）；随后插入已验证 Provider 再打开同一路径（200）写入三名 starter。已有成员时 `length !== 0` 不调用 `replaceMembers`。
   - 测试覆盖该重放路径：`tests/workflows/open-folder-starter-roster.test.ts:161-178`。
   - **不要求 UnitOfWork 才能关原严重项。** 架构本片写的是 PWS `openWorkspaceAsProject` → IDC `ensureStarterAgents` → PWS `replaceMembers` 三步编排，不是 create-mission 那种跨模块单事务。空 roster 是合法中间态（无 Provider 路径已存在）；入组失败或中途崩溃后再次打开会补写，满足 A-356 与「重试必须重放事实」。残余窗口是 IDC 已写入、PWS roster 仍空，直到下一次打开——可恢复，不是永久毒化。故不升严重、不阻 PASS；保留为一般，供后续若要对齐 create-mission UoW 时处理。
   - 证据：`src/application/workflows/open-folder-project/workflow.ts:24-36`；`src/composition/open-folder-project.ts:6-12`（仍三次独立 Adapter 调用）。

3. **一般（仍开）** `GET /api/home` 仍调用 `agentService.ensureStarterAgents`，查询动词上的 Identity 写旁路未走 OpenFolder workflow。原路由已有 PWS 写，故仍不升严重。
   - `app/api/home/route.ts:18-37`

4. **一般（已关闭）** `POST /api/directory-picker` 现接收 `Request`：有 content-type 则 400；`content-length` 非空且非 `"0"` 则 400；实际 body 字节 >0 则 400；错误 envelope 为 `INVALID_INPUT`。路径不从 body 读取。驾驶舱调用无 body。未显式拒绝 query string，但不从 query 取路径，不构成新的 fail-closed 缺口。
   - `app/api/directory-picker/route.ts:19-31`；`tests/modules/project-workspace/directory-picker.api.test.ts:56-75`

5. **一般（已关闭）** `deleteAgent` 先 `selectAgent`：不存在 → `AGENT_NOT_FOUND` 404；存在且 `starter-` 前缀 → `STARTER_AGENT_PROTECTED` 409。
   - `src/adapters/outbound/sqlite/identity-capability/agent-service.ts:565-578`；`tests/modules/identity-capability/starter-agents.test.ts:200-215`

6. **建议（仍开）** `firstVerifiedProvider` 仍用 `as` 收窄 SQLite 行；未绕过 `verified_at` 条件。
   - `src/adapters/outbound/sqlite/identity-capability/agent-service.ts:311-324`

### Spec

1. **严重（已关闭）** 与 A-353 / 架构一致：脚本化短路仅 test 或显式 allow；生产 `next start` 仅带 `COCKPIT_SCRIPTED_DIRECTORY` 必须走原生对话框。实现与测试见上 Standards #1。冒烟改为 `COCKPIT_ALLOW_SCRIPTED_PICKER=1` + 脚本化路径，符合「测试/冒烟用脚本化」。

2. **一般（已关闭）** Linux：`hasGraphicalSession()` 看 `DISPLAY` / `WAYLAND_DISPLAY`。zenity/kdialog spawn 成功但非 0 退出时，有图形会话 → `cancelled`；无图形会话 → 试下一个二进制，都失败则 `PICKER_UNAVAILABLE`（文案「无法打开系统文件夹选择器」）。取消与无 DISPLAY 已分开。
   - `src/adapters/outbound/workspace/directory-picker.ts:48-52`、`:83-88`、`:115-131`
   - `tests/adapters/workspace/directory-picker.test.ts:113-149`

3. **一般（仍开）** 驾驶舱左栏会话导航仍挂 HelpTip（线程标题/标签字数规则）。T-04 / A-358 / 演示判据 3 要求阶段 1 不展示 HelpTip。049「如何打开项目」已卸；本项未卸净。onboarding 仍尝试聚焦不存在的使命标题 `#mission-title-${projectId}` / `#mission-board [aria-label="创建使命"]`。无新的 fail-closed 证据，不升严重。
   - `components/project-thread-navigation.tsx:2471-2473`、`:2618-2620`
   - `components/task-panel.tsx:448-468`

4. **建议（仍开）** 非引导态聊天列仍可渲染行走骨架「任务目标 / 运行任务」。
   - `components/task-panel.tsx:548-572`；`components/project-panel.tsx:748`

### 已核对（不作为缺陷）

- **宿主路径进入 picker JSON**：架构明确 `{ path }` 或 `{ cancelled: true }`；A-361 再交给 `POST /api/projects`。成功体不是错误 envelope。`components/project-panel.tsx:394-406`。
- **无手输路径**：驾驶舱无「文件夹路径」控件；`tests/browser/cockpit-shell/phase-1-cockpit.test.tsx:33-38`。
- **POST `/api/projects` 仍接受 `{ path }`**：`app/api/projects/route.ts:73-104` 走 `openFolderAsProject`。
- **ensure 幂等 + 已存在 starter 不可删**：`tests/modules/identity-capability/starter-agents.test.ts`。
- **空 roster 再次打开可重放**（初审缺口已补）：`tests/workflows/open-folder-starter-roster.test.ts:161-178`。已有成员不覆盖仍由 `members.length === 0` 门闩保证。
- **使命看板 / 记忆 tab / 右栏 ProjectContextPanel 已从 `task-panel` 卸下**；桌面三列仍在。

### 复审不升格说明

未修的 GET `/api/home` ensure 写、HelpTip / onboarding 使命焦点仍是一般。无新的生产劫持或空 roster 永久不入组证据。跨 owner 分事务在用户不变量已满足后不升严重。

---

## 初审（历史，2026-08-15，结论需修改；已被上方复审取代）

- 固定点: 0a5288b
- 范围: 其后 050 implement 提交至当时 HEAD（`f52d971` 及 `a5fd932`–`576e2c2`）
- 评审人: 独立 subagent 双轴；作者未自评通过
- 聚焦测试: directory-picker / starter-agents / open-folder-starter-roster / phase-1-cockpit / home.api / api-error-sanitization 18/18 通过（通过不等于本门通过）

### Standards（初审原文）

1. **严重** `COCKPIT_SCRIPTED_DIRECTORY` 在 Adapter 入口无任何运行时门闩：非空即短路原生对话框并返回该路径。`NODE_ENV=production` 的 `next start` 同样生效。路径来源可被环境变量替换，违反 fail-closed 的宿主选择器边界。
2. **严重** OpenFolder Application Workflow 对 IDC/PWS 三次独立 `openDatabase`/`withTransaction`，不是 `create-mission` 那种 `UnitOfWork` 单事务。`openWorkspaceAsProject` 提交后 `ensureStarterAgents` 或 `replaceMembers` 失败无法回滚。入组条件是 `opened.created && starters.length >= 2`：重试时 `created=false`，空 roster 永久不补写。违反「重试必须重放事实或明确失败」。
3. **一般** `GET /api/home` 调用 `ensureStarterAgents`。
4. **一般** 新路由 `POST /api/directory-picker` 不接收 `Request`。
5. **一般** `deleteAgent` 对任意 `starter-` 前缀在存在性检查之前抛 409。
6. **建议** `firstVerifiedProvider` 用 `as` 收窄 SQLite 行。

### Spec（初审原文）

1. **严重** 架构与 A-353 写明脚本化仅测试/冒烟，生产走原生对话框。实现无门闩。
2. **一般** Linux 无 DISPLAY 被当成 cancelled。
3. **一般** 驾驶舱仍有 HelpTip；onboarding 仍聚焦使命标题。
4. **建议** 行走骨架 chrome。

### 初审结论（已被取代）

**需修改。** 当时存在未关闭严重项。该结论不再是本文件权威结论。
