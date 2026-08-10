# 任务票 — Mission 依赖与阻塞全景

- 状态: 项目级 review 豁免生效，直接进入 implement
- 规模: 3 张纵向 RED/GREEN 票；单一"看懂并定位依赖阻塞"用户结果
- 公共缝: Mission Dependency Query、依赖视图 UI
- TDD: 每票先一个公共行为 RED，再最小 GREEN；内存库夹具；新树测试路径
- 依赖事实: work item `dependencyIds`（`src/modules/mission-work/public/dto.ts` L51/L63 已存在）

- [x] T-01 依赖查询读模型 — Blocked by: None
  - 公共缝: Mission Dependency Query。
  - RED: 查询不存在；空/环/404 行为未定义。
  - GREEN: `getMissionDependencyInsight`（nodes/edges/cycles/blockedReason 派生、确定性排序、循环检测、tuple 404）；API 路由（严格校验、脱敏错误）；装配根登记；零 schema 变更。
  - 验证: 空依赖、线性链、菱形、自环、多节点环、环+正常混合、阻塞原因、跨 tuple 404、两遍同输入同输出。
  - 命令: 聚焦 tests/modules/mission-work/；`npx tsc --noEmit`

- [x] T-02 依赖视图 UI — Blocked by: T-01
  - 公共缝: 依赖视图 UI（jsdom）。
  - RED: 无依赖区；循环/阻塞/empty 未呈现；节点不可导航。
  - GREEN: Mission 现有面板内只读依赖区（列表化节点+关系、循环组标注、阻塞原因、empty/loading/error/focus 全态）；节点激活导航现有任务详情；tokens/44px/键盘。
  - 验证: 呈现正确性、循环标注、导航触发、状态矩阵。
  - 命令: 聚焦对应 UI 测试文件；`npx tsc --noEmit`

- [x] T-03 真实浏览器验收 — Blocked by: T-02
  - 公共缝: 真实 Mission 面板 + tuple 路由。
  - 验证: 造数（链+环）→ 依赖区呈现/循环标注/导航/刷新一致；desktop/narrow、light/dark、keyboard、focus、44px、axe 无 serious/critical；随后一次性全量 `npx vitest run` + `npx tsc --noEmit` + `npm run build`。
  - 命令: 复用现有 mission 相关 smoke（勘察后定）；全量一次；`npm run build`
