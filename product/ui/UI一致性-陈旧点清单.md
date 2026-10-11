# 冒烟脚本与审计运行器「陈旧点清单」（修复前考古落盘）

- 日期: 2026-10-11
- 状态: 已落盘，修复按本清单成批执行；同一脚本内的陈旧点一次性改完再跑第一条冒烟
- 方法: 对 10 个冒烟脚本（16304 行）与审计运行器逐行整读；对照 `UI一致性差异清单.md`（U-01~U-18）、`UI设计.md`、`assumptions.md` 与当前产品源码逐条核对
- 判定口径: **【现已红】**＝产品源码已无该元素/文案，跑到即失败；**【前向】**＝批次 D–H 落地后该断言失效；**改断言 / 改产品 / 改基建**
- 纪律: 禁止「修一个点 → 整脚本重跑一次」；最终 DoD 必须全脚本全量跑（`npm run smoke*` 全部 + 审计运行器全跑）

---

## 0. 总览

| 脚本 | 运行模式 | 状态 | 陈旧点 |
|---|---|---|---|
| persistent-threads（4821 行） | dev + `.next-thread-smoke-<pid>` | **【现已红】847 行必失败**（`选择对话运行` 不存在），另 21 处术语/4 处 run 面/2 处审计挂载点 | 27 |
| collaboration（964 行） | `next start`（共享 `.next`，需先 build） | **【现已红】3 处**：L639-648 决策答复、L661/673/768 运行状态、L685-771 运行详情 tab | 3 + 基建 |
| execution（2928 行） | `next start`（共享 `.next`） | 绿；【前向】U-09 两处键盘 Tab 距离、L1397 已批准不渲染、L1684 使命标题唯一性 | 6 |
| context（2665 行） | dev **共享 `.next`**（无隔离） | 绿；【前向】U-13 四类改名断言、U-08 三条入口缺席断言 | 10 |
| onboarding（1732 行） | `next start`（共享 `.next`） | 绿；【前向】L1210 `使命看板` sr-only h2 | 2 |
| settings（476 行） | `next start`（死代码 distDir） | 绿；【前向】L226 `共享记忆` exact h2 | 2 |
| browser-smoke（317 行） | dev + `.next-smoke-<pid>` ✅范式 | 绿（批次 B 已同步）；缺「查看引导」断言 | 2 |
| team（523 行） | dev **共享 `.next`**（最差） | 绿；基建：无隔离 + 无生成文件还原 | 2 |
| structured（966 行） | dev + `.next-structured-smoke-<pid>` ✅ | 绿；待复核 run 深链参数 | 1 |
| review（912 行） | `next start`（共享 `.next`） | 绿；【前向】U-07 卡片编号若并入按钮 aria | 4 |

**跨脚本硬事实**：`collaboration-panel.tsx:3069` `showRun = surface==="all" || surface==="run"`，而生产仅 `surface="chat"`（`task-panel.tsx:658/773`）→ 运行选择、决策答复、运行状态/控制/用量、待处理队列**全部不可达**；`project-context-panel.tsx` 已无生产 import（审计右栏 tab 亦不可达）。这是最大的「产品缺口 × 脚本假设」冲突，须以 T-A1（见 §7.1）一次性裁决。

---

## 1. persistent-threads-browser-smoke.mjs（【现已红】）

**已证实的红灯**：`features/014-persistent-project-threads/evidence/persistent-threads-failure.txt` 显示 847 行 `locator.selectOption: Timeout 60000ms`（`getByRole("combobox", { name: "选择对话运行" })`）。847 行即终止 → 其后 500+ 断言与 39 个 axe 状态全部无效。

### 1.1 run 表面残留（改断言，随 T-A1 重挂 chat 口径）

| # | 行号 | 陈旧内容 | 处置 |
|---|---|---|---|
| S1 | 846-847 | `combobox 选择对话运行` + `selectOption("legacy-run-stopped")` | 删除选择动作，改规范深链 `goto(?thread=<id>&run=legacy-run-stopped)`；保留 848-850 `waitForURL` 与 852-859 `readThread().selectedRun.id` API 断言 |
| S2 | 851 | `heading 运行 legacy-run-stopped` | 改断言为会话面安静事实 `运行状态：stopped`（T-A1 后可达） |
| S3 | 1331-1333 | 草稿跨运行选择用 combobox | 同一 deep link 导航替代；保留 1334-1340「切换运行不丢草稿」断言 |
| S4 | 2434-2440 | `inputValue() === activeRun.id` | 改 `readThread(...).selectedRun.id` API 断言（与 2419-2433 URL 断言组合） |
| S5 | 4496-4624 | 队列 UI（展开/位置/consumed/窄屏抽屉）整段 | 删除 UI 断言（T-A1 裁决：队列不进会话面）；保留 4424-4495 enqueue API 与 4559-4584 消费 API；点击操作（4513-4545）改 `api()` POST |

### 1.2 审计面板挂载点（改断言）

| # | 行号 | 陈旧内容 | 处置 |
|---|---|---|---|
| S6 | 2333-2334 | `.cockpit-context` + `tab 共享记忆` | 改图标轨治理视图：主导航 `按钮 /^审计/`（或 `ControlOrMeta+5`）+ `.cockpit-flow`（范式见 execution:2234-2255、2524） |
| S7 | 2337-2345 | `desktop light memory tab audit baseline` + `aria-selected` | 基线改名 `desktop light audit governance baseline`；键盘断言改 rail `aria-pressed==="true"` |
| S8 | 2445-2447 | 右栏 tab 重复点按 | 改治理视图返回（Ctrl+5 / rail）后 `已追平` 断言 |
| S9 | 2471-2521 | 窄屏 `打开当前任务上下文` 抽屉 | 改 `ControlOrMeta+5` + `.cockpit-flow`（execution:2748-2760 范式）；`定位来源对话` 44px/焦点断言保留 |
| — | 2346-2418、2496-2510 | 审计事件列表/已追平/加载更多/定位来源对话 | **保留**，仅把 locator 前缀换治理视图容器 |

### 1.3 术语「线程→对话」未同步（改断言，21 处）

同步 627c40f 已完成的同批漏网点（产品现文案见括注）：

- L2944「创建标签后开始整理线程」→「…整理对话」（`project-thread-navigation.tsx:3169`）
- L2992/3426/3429/3432/3753「已分配 N 条线程」→「…条对话」（:3189）
- L3105/3782/3839 group「按标签筛选线程」→「按标签筛选对话」（:2257）
- L3173「标签“X”下暂无线程。」→「…下暂无对话。」（:2576）
- L3258 按钮「整理线程」→「整理对话」（:2019）
- L3261 region「批量整理线程」→「批量整理对话」（:2302）
- L3263/3279/3297「已选 N 条线程」→「已选 N 条对话」（:2325）
- L3317「将为 2 条线程…」→「将为 N 条对话…」（:1918）
- L3320「移除会立即解除这些线程上的标签分配」→「…这些对话上的…」（:3298）
- L3355「已为 2 条线程更新标签。」→「已为 N 条对话更新标签。」（:1970）
- L4191/4299「该线程已移入回收站。」→「该对话已移入回收站。」（`collaboration-panel.tsx:3415`）
- L4192 按钮「返回线程列表」→「返回对话列表」（:3434）
- L4200 dialog「永久删除线程」→「永久删除对话」（`project-thread-navigation.tsx:3387`）
- L4300 按钮「恢复线程」→「恢复对话」（`collaboration-panel.tsx:3427`）

### 1.4 与 U-15/U-16 耦合

- L3259-3268：`organizeButton.click()` 后断言筛选胶囊 `count()===0` —— U-15 浮动条落地时重审（浮动条与筛选栏并存与否），并同步 region 名。
- L2699-2716 等：搜索即时结果断言有效；U-16 补 Cmd+K 路径（`ControlOrMeta+K` → dialog + 输入即出结果）。
- U-14 补审计行时间本地化断言（S6 重挂后）。

---

## 2. collaboration-browser-smoke.mjs（【现已红】3 处）

| # | 行号 | 陈旧内容 | 处置（T-A1 重挂 chat 后） |
|---|---|---|---|
| C-1 | 639-648 | 决策答复：radio「Proceed with the verified path」+ `回答后交给成员` + `提交回答` | **改产品（T-A1）**：DecisionPanel 在会话面渲染；保留现有选择器（它们是 chat 面元素） |
| C-2 | 661/673/768 | `getByText("运行状态：planned", {exact:true})` | **改产品（T-A1）**：运行状态安静行进会话面；语句可保留 |
| C-3 | 685-771 | 窄屏任务编辑「运行详情」tab + 运行控制/用量断言 | **改断言**：`task-panel.tsx:439` 现仅「对话」一个 tab。改断言 tablist 恰 1 个 tab + 无横向溢出；运行控制/用量断言移至会话面（T-A1 后同页可达） |

其余（L617-637 首轮/继续发送文案、L443-469 建对话、L866-905 DB 计数）**保留**。

---

## 3. execution-browser-smoke.mjs（【前向】）

| # | 行号 | 风险 | 处置 |
|---|---|---|---|
| E-1 | 1376-1381 | 一次 Tab 必落到「批准执行 …--help」——U-09 筛选控件插入即断 | 改键盘路径断言为「从刷新列表出发可 Tab 到批准/驳回」或先 focus 再断言（不数步数） |
| E-2 | 1405-1411 | 两次 Tab 必落到「驳回」 | 同上 |
| E-3 | 1397-1401 | 已批准项 `count()===0`——历史归档同屏挂载即断 | 作用域收窄到待裁决列表 + 新增归档 Tab 内出现断言 |
| E-4 | 1414-1415 | 空态时 `<ol>` 不渲染假设 | 改语义断言（空态文案可见 且 待裁决列表无项） |
| E-5 | 1233/1445/1849-1851 | `/approvals` 仅列待裁决的契约假设 | U-09 若扩展路由语义则同步（固定 `?status=pending` 或断言 status 集合） |
| E-6 | 1684 | `heading Execution Smoke Mission` 唯一性——U-05 banner 若再渲染一个 heading 即 strict violation | 改 `.first()` 或改断言 banner 内 `progressbar` |

### 3.1 运行时风险（基建）

- `stopAppServer`（338-364）posix 仅 SIGTERM，无端口清扫——本日已实际产生孤儿 `next-server`（占 5399）。**基建统一修**（见 §6）。
- 三处「定位来源执行」诚实降级文案（1344-1347/2545-2552/2781-2783）：T-A1 后若跨视图可达性变化需同步。
- 治理/时间轴两组验收只打 console 不落 JSON（2063/2568）——补落盘。

---

## 4. context-browser-smoke.mjs（【前向】）

| # | 行号 | 风险（批次 D–H 落地即断/漂移） | 处置 |
|---|---|---|---|
| X-1 | 1075 | `region 使命任务看板` 缺席断言——U-13 改名后永真 | 改新名或改结构断言（`#mission-board` 缺席） |
| X-2 | 270/1509 | `heading 使命看板` 缺席断言——同上 | 同上 |
| X-3 | 1269 | `heading 共享记忆` exact——U-08/U-13 改「共享记忆与知识库」即断 | 改新名 + 断言治理标题 `共享记忆与知识库 · <项目>` |
| X-4 | 268/1543/1895/2556/269 | tab「共享记忆/使命看板」缺席——子串匹配风险 | 改结构断言（治理视图内无 tablist） |
| X-5 | 298/1264/1265 | 「添加记忆」「打开记忆检索」缺席——U-08 新 IA 后失去防护意义 | 改为新 IA 正面断言（搜索框+类型胶囊+卡片列表为主） |
| X-6 | 1050 | `region 进行中` 缺席——泳道加英文后缀后语义漂移 | 改新泳道名/结构断言 |
| X-7 | 1173-1205 | **U-17 零覆盖**：切换项目瞬间 404 未断言 | 新增：切换后 `errorResponseBodies` 不含 `RESOURCE_NOT_FOUND` |
| X-8 | 2092-2100 | DB 全表精确计数（7 表）——D–H 任何新写路径即断 | 改实体集合断言 |
| X-9 | 1994-2029 | workspace-audit.jsonl 精确 9 项数组——U-17 改造即断 | 改语义断言（含 realpath/stat/access 且读写枚举为 0） |
| X-10 | 2325-2329/2376-2387/2483-2493 | 事件精确条数/精确数组——同上 | 降级为集合断言 + required 事件类型 |
| — | 1508/1531 | 窄屏编辑「看板」tab 缺席——U-06 后子串风险 | 同 X-4 口径 |

**最佳夹具**：`Empty Mission`（空泳道）与 `Context Smoke Mission`（4 工作项/1 完成=25%）可支撑 U-05/U-07/U-13 正面验收。

---

## 5. onboarding / settings / 其余（【前向】与基建）

| 脚本 | 行号 | 风险 | 处置 |
|---|---|---|---|
| onboarding | 1210-1211 | `heading 使命看板`（sr-only h2，`mission-board.tsx:984-986`）——U-13 改名即断 | 改 `#mission-board-title-<pid>` 文本断言 / `name: /使命.*看板/` |
| onboarding | 1212-1216 | `使命标题` label + `mission-title-<pid>` id 契约——U-05/U-06 落地复核 | 保留 id 契约（A-483 意图消费依赖），label 放宽 |
| onboarding | 1258 | `编辑使命 count()===0`——banner 加编辑入口后若跨 region 碰撞 | 限定 scope 到引导 region |
| settings | 226 | `heading 共享记忆` exact（`memory-panel.tsx:600-602` sr-only h2）——U-08/U-13 即断 | 改 `#memory-title-<projectId>` / 新名 + 补治理标题断言 |
| settings | 227-239 | 索引健康条位置假设 | 改 region 内文本断言（`记忆索引健康`） |
| settings | 27/96-104 | `smokeDistDirectory` 死代码（env 从未传 `NEXT_DIST_DIR`） | 清理或真正接入隔离 |
| browser-smoke | 164-171 | 缺「查看引导」链接断言（`task-panel.tsx:640-645`） | 补一条 |
| team | 105-127/517-523 | dev 无隔离 distDir、无生成文件快照还原 | 基建统一（§6） |
| structured | 719 | run 深链参数断言——U-17 若清 run 参数则同步 | 待 U-17 定案 |
| review | 653-659/884-892 | U-07 卡片编号若并入按钮 aria / U-13 改名 | 落批次 D 后复跑；R1 改稳健定位 `/打开复核 .*/` |

---

## 6. 基建改造（最先做，受益全程）

> 落地状态（2026-10-11）：`tests/browser/smoke-steps.mjs`（步骤控制）、`tests/browser/smoke-preflight.mjs`（预检，`npm run smoke:preflight`）、`tests/browser/runner-process.mjs`（posix 端口清扫）已入库；`browser-smoke.mjs` 已接入步骤控制并验证默认路径输出与改造前逐字节一致（端口归一后 diff 为空）；其余脚本在各自修复批次接入（每批完成后更新本节状态）。

1. **步骤控制**：给 10 个冒烟脚本加 `--from-step/--only-step/--list-steps`。已有名称键可直接用（structured `pass(name)` 19 处、settings `recordStep(name)` 16 处）；其余 8 个按 §各脚本「结构报告」的分区表引入统一步骤包装（范式复用 `ui-audit-runner.mjs:174-209`：PASS/FAIL 记账 + 失败自动截图 + URL/console 诊断）。**不带参默认全跑、不改任何断言**；脚本头注明「最终 DoD 验证必须全跑」。
2. **posix 进程/端口清扫**：所有 spawn 了 server 的脚本在 `stopAppServer` 补「按端口反查 kill」兜底（现仅 win32 有）；重启前断言端口释放（避免旧进程假绿）。
3. **统一 dev 隔离范式**：`NEXT_DIST_DIR=.next-<name>-<pid>` + 生成文件快照/还原（测试期间**绝不回滚** tsconfig.json/next-env.d.ts，全部运行结束后统一 `git checkout` 一次）+ 退出 `rmSync` + dev overlay 隐藏。待补：collaboration / onboarding / settings（next start，改 dev 或至少快照还原纪律）、context（共享 `.next` + PID 模端口）、team（共享 `.next`）。
4. **端口策略**：execution `appPort+1`、context `pid%200` 改「探测空闲端口」。
5. **预检脚本**：任何冒烟前执行——kill 残留 `next dev`/`next-server`（按 cwd 归属仓库 + 端口占用者）、确认无 `.next` 锁、清理陈旧 `.next-*-smoke-*`（>15 分钟）与孤儿产物目录。落盘 `tests/browser/smoke-preflight.mjs`。
6. **提交纪律**：提交前确认 `tsconfig.json`/`next-env.d.ts` 未在暂存区。
7. **生成文件机制**（本轮查明）：dev server 每次运行会把当次 distDir 的**字面路径**追加进 `tsconfig.json` include，并把 `next-env.d.ts` 的 import 指向当次 distDir（如 `./.next-smoke-<pid>/dev/types/routes.d.ts`）。这正是此前「运行中回滚互相打架」的根因（回滚把别的运行刚写入的条目抹掉）。纪律定案：运行期间绝不回滚这两个文件；批次/会话全部运行结束后统一 `git checkout -- tsconfig.json next-env.d.ts` 一次；`ui-audit-runner.mjs` 与 `browser-smoke.mjs` 的逐运行还原已按此移除。

---

## 7. 专题

### 7.1 T-A1：运行生命周期可达性（批次 A 第一票，硬阻塞）

**裁决：重挂 chat 面（不恢复独立 run 表面）**。依据：U-10 已裁决「无需勾选历史运行即可发送新一轮」；A-477/A-479 已登记「run 表面段落整体改挂会话面」；生产仅传 `surface="chat"`，独立 run 表面无挂载点（`project-context-panel.tsx` 已死）。

落地口径（先更新 UCD §9.1.3/§9.1.4 + 台账 + 假设，后实现）：
1. **决策答复**：会话面内联渲染「等待你的决策」（`state.pendingDecision` 存在即渲染，不再要求 run 表面）。
2. **运行状态**：会话面以安静行渲染「运行状态：<status>」+ 终态提示；`state.run` 存在时渲染运行控制与用量（收编 run-details 块）。
3. **运行选择**：不提供下拉控件；历史运行查看唯一入口＝规范深链 `?thread=&run=`（保持现有 URL 语义与 `selectedRun` API 契约）。
4. **返回活动运行**：会话面在「另一对话有活动运行」时给出 `返回活动对话 <runId>` 链接（quiet 行 + 链接），保持 A-477 如实提示不变。
5. **待处理队列**：不进入会话面（内部机制，API/审计可证）。

### 7.2 术语统一

产品已全面「线程→对话」；脚本侧 21 处漏网（§1.3）+ 4 处 sr-only/tab 名（§4）随批次修复同步。

### 7.3 产品缺口（U-xx 落地后补验收）

U-05 banner（progressbar/门槛文案）、U-06 顶栏新建任务、U-07 卡片 `#N`+元数据行、U-08 记忆 IA（搜索框/类型胶囊/卡片列表为主）、U-09 状态筛选+归档 Tab、U-13 泳道英文后缀+空泳道 sr-only+治理标题、U-14 时间本地化、U-15 浮动条、U-16 Cmd+K 即时结果、U-17 切换 404 计数为 0、U-02/U-10/U-11 会话面新文案（创建使命引导/发送并开始新一轮/直聊自动建对话）、U-03 底部分组形态、U-04 安静行无卡片铬。
