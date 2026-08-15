# 050 阶段1 code-review
- 固定点: 0a5288b
- 范围: 其后 050 implement 提交至 HEAD（`f52d971` 及 `a5fd932`–`576e2c2`）
- 日期: 2026-08-15
- 评审人: 独立 subagent 双轴；作者未自评通过
- 聚焦测试: directory-picker / starter-agents / open-folder-starter-roster / phase-1-cockpit / home.api / api-error-sanitization 18/18 通过（通过不等于本门通过）

## Standards

1. **严重** `COCKPIT_SCRIPTED_DIRECTORY` 在 Adapter 入口无任何运行时门闩：非空即短路原生对话框并返回该路径。`NODE_ENV=production` 的 `next start` 同样生效。路径来源可被环境变量替换，违反 fail-closed 的宿主选择器边界。
   - `src/adapters/outbound/workspace/directory-picker.ts:32-37`、`:67-69`

2. **严重** OpenFolder Application Workflow 对 IDC/PWS 三次独立 `openDatabase`/`withTransaction`，不是 `create-mission` 那种 `UnitOfWork` 单事务。`openWorkspaceAsProject` 提交后 `ensureStarterAgents` 或 `replaceMembers` 失败无法回滚。入组条件是 `opened.created && starters.length >= 2`：重试时 `created=false`，空 roster 永久不补写。违反「重试必须重放事实或明确失败」。
   - `src/application/workflows/open-folder-project/workflow.ts:24-36`
   - `src/composition/open-folder-project.ts:6-12`
   - `src/adapters/outbound/sqlite/project-workspace/workspace-service.ts:144-151`
   - `src/adapters/outbound/sqlite/identity-capability/agent-service.ts:543-561`
   - 对照 `src/application/workflows/create-mission/workflow.ts:19-28`

3. **一般** `GET /api/home` 调用 `ensureStarterAgents`，查询动词上新增 Identity 写；入站路由直接打 IDC 命令，未走本片指定的 OpenFolder workflow。该路由原先已有 PWS `ensureDirectProject`/`setDirectChatAgent` 写，故不升严重，但仍是本片新旁路。
   - `app/api/home/route.ts:18-37`
   - 架构：「入站路由不得直接写对方表」

4. **一般** 新路由 `POST /api/directory-picker` 不接收 `Request`，无 content-type、正文大小、DTO 校验。路径虽不从 body 读取，仍违反「路由处理器必须校验内容类型、正文大小和严格 DTO 形态」。
   - `app/api/directory-picker/route.ts:7-13`

5. **一般** `deleteAgent` 对任意 `starter-` 前缀在存在性检查之前抛 `STARTER_AGENT_PROTECTED`。不存在的 `starter-*` 也是 409 而非 404。保留命名空间偏 fail-closed，但掩盖 `AGENT_NOT_FOUND`。
   - `src/adapters/outbound/sqlite/identity-capability/agent-service.ts:565-575`

6. **建议** `firstVerifiedProvider` 用 `as` 收窄 SQLite 行；同文件既有模式，未绕过 verified_at 条件。
   - `src/adapters/outbound/sqlite/identity-capability/agent-service.ts:311-324`

## Spec

1. **严重** 架构与 A-353 写明 `COCKPIT_SCRIPTED_DIRECTORY` 仅测试/冒烟，生产走原生对话框。实现无 `NODE_ENV` / Vitest / 冒烟专用开关，生产进程带该变量即跳过系统选择器。冒烟把该变量注入 `npm run dev` 合法；缺的是生产拒绝。
   - `src/adapters/outbound/workspace/directory-picker.ts:32-37`、`:67-69`
   - `features/050-phase-1-usable-cockpit/architecture.md`「仅测试/冒烟；生产走原生对话框」
   - 冒烟先例：`tests/browser/browser-smoke.mjs:75-80`

2. **一般** Linux 上 zenity/kdialog 能 spawn 但对话框失败（无 DISPLAY、exit 1）被当成 `cancelled`（`spawnFailed` 仅 `child.error`）。A-354 要求无 DISPLAY/对话框失败返回「无法打开系统文件夹选择器」，取消才静默。
   - `src/adapters/outbound/workspace/directory-picker.ts:39-59`、`:92-106`

3. **一般** 驾驶舱仍有 HelpTip：线程标题/标签规则气泡仍挂在左栏会话导航。T-04/A-358/D-49 要求阶段 1 不展示 HelpTip。049「如何打开项目」已卸；本项未卸净。
   - `components/project-thread-navigation.tsx:2471-2473`、`:2618-2620`
   - onboarding 仍尝试聚焦不存在的使命标题：`components/task-panel.tsx:448-468`

4. **建议** 聊天列在非引导态仍渲染行走骨架「任务目标 / 运行任务」（`legacyTasksEnabled={!guideActive}`）。不阻塞「无使命/记忆 tab」，但与「中间是群聊 composer」并列多余 chrome。
   - `components/task-panel.tsx:548-572`
   - `components/project-panel.tsx:748`

### 已核对（不作为缺陷）

- **宿主路径进入 picker JSON**：架构明确 `{ path }` 或 `{ cancelled: true }`；A-361 要求再交给 `POST /api/projects`。成功体不是错误 envelope（AGENTS.md 禁的是错误 envelope 里的宿主路径）。`components/project-panel.tsx:394-406`、`:364-366`。
- **无手输路径**：驾驶舱无「文件夹路径」控件；`tests/browser/cockpit-shell/phase-1-cockpit.test.tsx:33-38`。
- **POST `/api/projects` 仍接受 `{ path }`**：`app/api/projects/route.ts:30-46`、`:73-104`；workflow 测试经该契约入组。
- **ensure 幂等 + 已存在 starter 不可删**：`tests/modules/identity-capability/starter-agents.test.ts`。
- **新建空 roster 自动入组、已有成员不覆盖（快乐路径）**：`tests/workflows/open-folder-starter-roster.test.ts`。未覆盖「created 已提交、入组失败后的重试」。
- **使命看板 / 记忆 tab / 右栏 ProjectContextPanel 已从 `task-panel` 卸下**；桌面三列：`app/cockpit.css:142-146`。

## 结论

**需修改。** 存在未关闭严重项：脚本化选夹无生产门闩；跨 owner 分事务且 `created` 门闩使入组失败不可重放。作者未自评通过；本文件不是 PASS。
