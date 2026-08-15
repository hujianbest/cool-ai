# 进度

- 特性: 050-phase-1-usable-cockpit
- 对应切片: S-60
- 当前阶段: implement（T-01～T-05 已勾选；下一步 hf-code-review）
- 执行模式: auto
- 已加载扩展: 无
- 下一步: 独立会话执行 hf-code-review（DirectoryPicker 路径来源 + Identity 写入，不得豁免）

## 状态记录

- 2026-08-15 用户否定 049 HelpTip/手输路径，要求系统文件夹选择器、自带 Agent、聊天优先、使命/记忆暂不展示，并按第一性原理重排阶段。路线见 `product/phases.md`，决策 D-49。
- 项目级 spec/architecture/`hf-review` 豁免（AGENTS.md 2026-08-14）。本片含 DirectoryPicker 路径来源与 Identity 写入，implement 后必须 hf-code-review，不豁免代码门。
- 规模例外 A-359：用户要求一次完成阶段 1，不拆成选夹/Agent/卸载三片。
- Grill 按用户明确指示记录 A-353～A-361。

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
