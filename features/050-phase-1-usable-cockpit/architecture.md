# 规格要点与架构（轻量合并页之外的完整主链）

阶段 1 用户结果：owner 用系统文件夹选择器打开项目，在已配置模型服务时立即拥有三名自带 Agent 并自动入组，在聊天优先驾驶舱公开对话。使命、记忆、HelpTip 不出现在驾驶舱。

## 范围

做：

- 宿主 `DirectoryPicker` Adapter + `POST /api/directory-picker`（`{ path }` 或 `{ cancelled: true }` 或稳定错误）。
- 驾驶舱「打开文件夹」只调用选择器，再把返回 path 交给既有 `POST /api/projects`。无路径输入。
- `ensureStarterAgents`：无则按模板插入 `starter-planner|builder|reviewer`，绑定第一个已验证 Provider。
- 新建文件夹项目且 roster 空时写入三名自带 Agent。
- 驾驶舱卸载使命看板、记忆、HelpTip、右栏上下文；桌面三列。
- `/team` 仍配置 Provider；自带 Agent 不可删除。

不做：schema bump；浏览器 `showDirectoryPicker` 当路径源；把使命/记忆 API 删掉；复制 pi/dsh 源码。

## 测试缝

- `tests/adapters/workspace/directory-picker.test.ts` — 脚本化/取消/失败。
- `tests/modules/identity-capability/starter-agents.test.ts` — 幂等 ensure、无 Provider 不创建、不可删除。
- `tests/workflows/open-folder-starter-roster.test.ts` — 新建项目自动入组；已有成员不覆盖；空 roster 再次打开可重放。
- `tests/browser/cockpit-shell/phase-1-cockpit.test.tsx` — 无路径框、无 HelpTip/使命/记忆 chrome、打开文件夹不渲染 input。
- 更新既有打开文件夹冒烟：设 `COCKPIT_SCRIPTED_DIRECTORY`，不再 `getByLabel('文件夹路径')`。

## 架构

- DirectoryPicker 是 Project & Workspace 出站 Adapter，不进领域模块。
- ensureStarterAgents 属 Identity & Capability 命令。
- 打开文件夹后入组由 Application Workflow 编排：先 PWS `openWorkspaceAsProject`，再 IDC ensure，再 PWS `replaceMembers`（`starters.length >= 2` 且 roster 空则写入；不依赖 `created`，以便入组失败后重放）。
- 入站路由不得直接写对方表。
- `COCKPIT_SCRIPTED_DIRECTORY` 仅测试/冒烟；生产走原生对话框。脚本化短路仅在 `NODE_ENV=test` 或显式 `COCKPIT_ALLOW_SCRIPTED_PICKER=1` 时生效。

主领域 Capability: 不适用（阶段 1 主结果是作业面编排 + UI）。主要架构单元: Application Workflow + 入站 UI Adapter + 出站 DirectoryPicker。消费: `CAP-PWS-01`、`CAP-IDC-01`、`CAP-COL-01`。
