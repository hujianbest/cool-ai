# 进度

- 特性: 050-phase-1-usable-cockpit
- 对应切片: S-60
- 当前阶段: implement（hf-code-review 复审 **PASS**；用户可感知一般项已关；跨 owner 分事务按 A-376 保持三步编排）
- 执行模式: auto
- 已加载扩展: 无
- 下一步: ship 收口（演示 auto-approved 须呈上驾驶舱与 UCD 对照）。跨 owner 单事务 UoW 不在本片实现。

## 状态记录

- 2026-08-15 用户否定 049 HelpTip/手输路径，要求系统文件夹选择器、自带 Agent、聊天优先、使命/记忆暂不展示，并按第一性原理重排阶段。路线见 `product/phases.md`，决策 D-49。
- 项目级 spec/architecture/`hf-review` 豁免（AGENTS.md 2026-08-14）。本片含 DirectoryPicker 路径来源与 Identity 写入，implement 后必须 hf-code-review，不豁免代码门。
- 2026-08-15 独立 hf-code-review 初审已落盘 `reviews/code-review.md`。结论：**需修改**（未伪造 PASS）。严重项：`COCKPIT_SCRIPTED_DIRECTORY` 无生产门闩；OpenFolder 跨 owner 分事务且仅 `created` 才入组，失败重试不补 roster。
- 2026-08-15 作者已按初审修改（未自评 PASS）：
  - 脚本化选夹仅在 `NODE_ENV=test` 或 `COCKPIT_ALLOW_SCRIPTED_PICKER=1` 时短路；冒烟 server env 已加 allow 开关。
  - OpenFolder 入组去掉 `created` 门闩：`starters.length >= 2` 且 roster 空则 `replaceMembers`，再次打开可重放。
  - 一般项：`POST /api/directory-picker` 拒绝非空 body；`deleteAgent` 对不存在的 `starter-*` 返回 404；Linux 无 DISPLAY/WAYLAND 且对话框非 0 退出视为 `PICKER_UNAVAILABLE`。
  - 聚焦测试：directory-picker / directory-picker.api / starter-agents / open-folder-starter-roster 19/19 通过。
- 2026-08-15 独立 hf-code-review 复审 **PASS**（`reviews/code-review.md`，对照 `5cf4d0b`）。严重项全关。仍开一般项：GET `/api/home` ensure 写；左栏 HelpTip / onboarding 使命焦点；跨 owner 分事务残余（不升严重）。
- 规模例外 A-359：用户要求一次完成阶段 1，不拆成选夹/Agent/卸载三片。
- 2026-08-17 长任务关闭两项 050 一般项：(1) 会话创建/标签对话框去掉 HelpTip（A-374）；(2) `GET /api/home` 不再 `ensureStarterAgents`，仅 Provider、无 Agent 时返回 `needs_agent` 且不插入 starter（A-375）。仍开：onboarding `onFocusMission` 仍尝试点击未挂载的使命标题；GET home 仍 `ensureDirectProject`；跨 owner 分事务。聚焦：persistent-thread-list-ui / thread-tags / home.api 绿。
- 2026-08-17 长任务再关两项用户可感知一般项：(1) 引导「查看已受理使命」打开任务治理视图（A-378）；(2) `GET /api/home` 只读，`needs_direct_chat` 后由 `POST /api/home` 幂等 ensure（A-377）。跨 owner 分事务按 A-376 保持三步编排，不升实现。聚焦：home.api / direct-project / home-direct-chat 17、onboarding T-1 绿。

## implement 验证（2026-08-15）

- `npx tsc --noEmit`：通过。
- 聚焦测试：directory-picker、starter-agents、open-folder-starter-roster、phase-1-cockpit、theme-tokens、cockpit-layout、context-accessibility、project-panel、accessibility、responsive-layout、onboarding-happy-path 等通过。
- `npm run build`：通过（含 `/api/directory-picker`）。
- `npm run smoke`：通过（`COCKPIT_SCRIPTED_DIRECTORY` 一次点击打开文件夹；无「文件夹路径」；axe 无 critical）。
- 其余冒烟（已改选夹接线，未为隐藏的 run/看板 chrome 重写交互）：
  - `smoke:collaboration`：打开项目与 API 创建使命成功；在 `getByRole('radio', { name: 'Proceed with the verified path' })` 超时（决策 UI 挂在 `surface==="run"`，阶段 1 只渲染 chat）。
  - `smoke:onboarding`：空引导无路径框后继续；在 `getByRole('dialog', { name: '确认改绑工作区' })` 超时。
  - `smoke:context`：选夹后停在 `getByRole('tree', { name: '工作区文件' })`（Linux 上 Windows verified-handle 文件树，按指示不改 native）。
  - `smoke:execution` / `smoke:review` / `smoke:structured`：未完整跑完；与 collaboration 同样依赖已卸载的 run/看板 chrome。
- MissionBoard / MemoryPanel 组件与其单元测试保留；使命/记忆 API 测试未改。
