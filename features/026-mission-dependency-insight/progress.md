# 进度

- 特性: 026-mission-dependency-insight（对应切片: S-25 / CI-4.4）
- 当前阶段: done
- 执行模式: auto（用户 2026-08-09 明示：不在电脑前，问题按助手推荐处理）
- 已加载扩展: 无
- 下一步: T-01/T-02/T-03 全部完成；待 ship 阶段（评审豁免下的收尾与演示验收确认）
- 用户可感知: 是
- 评审状态: 项目级 review 豁免（2026-08-09）；不伪造评审工件；spec 由主会话按 backlog S-25 已确认条目直接产出
- 共享理解: backlog S-25 条目视为 auto-approved 2026-08-10

## 实施记录

- 2026-08-10 特性开立：S-25 前置 `CAP-MWK-01` 已交付核心、无阻塞项；选它因当前无阻塞切片中风险最低且解锁 S-26/S-27。
- 2026-08-10 T-01 完成（实现 subagent，4 轮 RED/GREEN）：公开 Queries 新增 `getMissionDependencyInsight(databasePath, projectId, missionId)`；DTO（`MissionDependencyInsight/Node/Edge/Cycle`）落 `src/modules/mission-work/public/dto.ts`；实现为新 Adapter `src/adapters/outbound/sqlite/mission-work/dependency-insight.ts`（纯派生 `deriveMissionDependencyInsight` + tuple 校验查询），装配根登记 `missionWorkDependencyInsight`；路由 `GET /api/projects/[projectId]/missions/[missionId]/dependencies`（严格校验 + missionApiError 脱敏）。零 schema 变更、零写能力。RED/GREEN：①查询不存在→空态/tuple 404；②链/菱形/阻塞原因/确定性→图派生；③两节点环/环+正常混合/自环/悬空→Tarjan SCC + missing 分类；④路由不存在→路由+装配。勘察结论：写路径 DEPENDENCY_SCOPE/DEPENDENCY_CYCLE 守卫 + CHECK 禁止自环 + FK ON 与 reopen foreign_key_check 禁止悬空行，故自环/悬空经纯函数缝防御覆盖（A-126）；done 依赖 blockedReason 同缝覆盖（A-126）；路由落点 A-127。验证：tests/modules/mission-work/ 8 文件 53 测试通过（新文件 18 测试）、tests/architecture/ 25 通过、workflows create-mission/project-context-snapshot 14 通过、`npx tsc --noEmit` 通过；全量套件与 build 留 T-03 一次性运行。
- 2026-08-10 T-02 完成（实现 subagent，1 轮 RED→GREEN + 2 次测试选择器修正）：新组件 `components/project-context/mission-dependency-insight.tsx`（`MissionDependencyInsightPanel`，fail-closed DTO parse、active epoch 防陈旧、refreshSignal 重取），挂载于 MissionBoard 看板网格后（A-128）；列表化节点（状态徽章复用 `.status-label` 变体映射、blockedReason、被阻塞于/阻塞 标题引用按钮、循环组 role=group + 节点循环徽章、empty/loading/error/retry 全态、脱敏文案）；节点激活复用看板 focusWorkItemId 焦点缝（新增 scrollIntoView）。RED：无依赖区 4 测全失败；GREEN 后新文件 4/4 通过。同波次夹具更新：mission-board.test ×3 处、onboarding-happy-path ×5 处补 /dependencies 空 insight。验证：tests/browser/project-context/ + onboarding + thread-policy-ui 共 12 文件 96 测试通过；`npx tsc --noEmit` 通过；ReadLints 无告警。全量套件/build/浏览器验收留 T-03。UI 默认与夹具波次记录 A-128。
- 2026-08-10 T-03 完成（实现 subagent）：真实浏览器验收落点 `tests/browser/context-browser-smoke.mjs`（smoke:context，既有 mission 面板 smoke）。造数：既有 Plan→Build 链上补 Test(←Plan)、Ship(←Build,Test) 成链+菱形（环因 DEPENDENCY_CYCLE 写守卫在持久层不可达，循环呈现由组件测试覆盖，A-129）；empty 态用第二项目零任务 Mission 隔离造数。验收断言 35 条：4 节点呈现、状态徽章（进行中/待办）、blockedReason（Ship"前置依赖未完成：待办 2 项"、Build/Test"进行中 1 项"、Plan 无）、被阻塞于/阻塞关系按钮、无循环标注、只读（无输入控件）、API 直查（nodes/edges=4、cycles=0、hasDependencies、两次调用逐字一致、边集=链+菱形）、点击与 Enter 双路径定位焦点落看板任务卡、键盘焦点环可见（:focus-visible + box-shadow）、依赖区按钮全量 ≥44px、跨页导航后视图与事实源一致。axe 4 态（desktop light/dark + narrow light/dark 抽屉）全部 0 violation（门禁 serious/critical，实测全零）；矩阵四象限各至少一次关键路径 + 截图证据。缺陷处理：026 本身零生产缺陷；修复 smoke 预存腐化 5 处（测试选择器/结构缺口：模型服务/创建任务 exact 化、窄屏抽屉先看板 tab、Tab 序有界遍历、axe 需 newContext 页面）；对齐统一完成门槛（006）后看板"完成任务"需评审通过，既有完成序列不可达，smoke 保留守卫拦截+正向启动控制；发现 REVIEW_REQUIRED 在 MissionBoard 无专属文案（兜底"操作失败"）——既有 UX 缺口，记录 A-129 不在本片扩张。一次性全量验证：`npx vitest run` 246 文件 2111 测试全通过（117.11s，基线 ~111s 内）；`npx tsc --noEmit` 通过；`npm run build` 通过（新路由 /api/projects/[projectId]/missions/[missionId]/dependencies 在列）。证据：features/026-mission-dependency-insight/evidence/（dependencies-desktop-light/dark.png、dependencies-narrow-light/dark.png、dependencies-acceptance-results.json）。
