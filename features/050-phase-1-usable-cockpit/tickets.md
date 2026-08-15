# 任务票

- [ ] T-01 宿主目录选择器 — Blocked by: None — DirectoryPicker Adapter（Windows/macOS/Linux 原生；`COCKPIT_SCRIPTED_DIRECTORY` 脚本化）+ `POST /api/directory-picker`。RED=`tests/adapters/workspace/directory-picker.test.ts` 与路由测试因缺失失败；GREEN=最小 Adapter。验证这些文件。安全：返回路径不记录到日志正文；错误脱敏。
- [ ] T-02 自带 Agent — Blocked by: None — `ensureStarterAgents` 幂等落地模板；无 Provider 跳过；删除自带 Agent 冲突。RED=`tests/modules/identity-capability/starter-agents.test.ts`；GREEN=Identity 命令。验证该文件。
- [ ] T-03 打开文件夹工作流入组 — Blocked by: T-01, T-02 — Workflow：选夹 → openWorkspaceAsProject → ensure → 空 roster 则 replaceMembers。UI 去掉路径表单。RED=`tests/workflows/open-folder-starter-roster.test.ts` + 更新 `project-panel` 测试：默认 DOM 无路径框。GREEN=最小编排与按钮。验证这些文件。
- [ ] T-04 聊天优先卸载 — Blocked by: T-03 — 驾驶舱隐藏使命/记忆/HelpTip/右栏；三列栅格；更新 `theme-tokens.test.ts` 四列断言。RED=`tests/browser/cockpit-shell/phase-1-cockpit.test.tsx`；GREEN=条件卸载。验证该文件与壳层 token 测试。
- [ ] T-05 冒烟与验收 — Blocked by: T-04 — 更新 browser-smoke / onboarding / context 中「文件夹路径」与驾驶舱使命/记忆点击；`npx tsc --noEmit`、聚焦测试、`npm run build`、`npm run smoke`。演示截图 gitignore evidence。

约束：零 schema。DirectoryPicker 与 starter 删除保护命中安全/领域写，implement 后必须 hf-code-review。不得把路径手输当 fallback。不得 mock 被测主体。用户明确不拆片（A-359）。
