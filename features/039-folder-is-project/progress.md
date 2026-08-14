# 进度

- 特性: 039-folder-is-project
- 对应切片: S-55
- 当前阶段: done
- 执行模式: auto
- 已加载扩展: ext-ui-design
- 下一步: 无；S-55 已完成

## 状态记录

- 2026-08-14 用户指示：不应输入项目名称创建项目；打开本地文件夹就是项目；参考 Codex 等 Agent 交互并自动完成整改。立项 039/S-55。037/S-53 AUD-GOV 继续暂停于 T-02。项目级 review 豁免（AGENTS.md 当前开发阶段条款，2026-08-09）适用于本特性，不伪造评审工件。
- 2026-08-14 grill auto-approved（A-264～A-275，D-47）。进入 to-spec / to-architecture / to-tickets。项目级 review 豁免，不伪造 spec-review / architecture-review。A-272：4 张票，直接 implement。
- 2026-08-14 进入 implement。项目级 review 豁免，不伪造 code-review 工件。TDD 红绿循环；实现委派 subagent。
- 2026-08-14 曾因 040 空态指示暂停于 T-01。2026-08-15 用户澄清：打开本地文件夹作为项目 **与** 不选项目直接聊天 **都要支持**（A-285）。本片恢复 implement；不得破坏 040 已落地的 `/` 1:1 聊天。
- 2026-08-15 T-01～T-03 完成：新增事务型 `openWorkspaceAsProject` create-or-resume 命令；`POST /api/projects` 改为严格 `{ path }` 并返回 201/200；ProjectPanel 与 onboarding 改为打开文件夹，同时保留 `/` 的 GET `/api/home` 个人对话、TaskPanel home chat、ProjectThreadNavigation direct mode 与「个人对话」列表过滤。
- 2026-08-15 验证：12 个聚焦文件共 104 tests 通过（含 040 `direct-project.test.ts`、`home.api.test.ts`、`home-direct-chat.test.tsx`），`npx tsc --noEmit` 通过。按用户指示未运行 T-04 smoke / 全量 suite / build；项目级 review 豁免继续生效，不创建 review 文件。
- 2026-08-15 T-04 / ship 完成：所有旧名称创建 Playwright 造数已改为打开临时文件夹，README 与上手/项目/团队指南明确首页可 1:1、打开文件夹进入多人协作；未知写核对会排除「个人对话」容器。最终 `npx tsc --noEmit`、`npx vitest run`（284 files / 2598 tests）、`npm run smoke`、`npm run smoke:onboarding`、`npm run build` 全绿。真实浏览器覆盖 `/` needs-agent 与文件夹 basename 项目、desktop/narrow 及 axe；项目级 review 豁免生效，未创建 review 文件。未 commit，零 schema bump，037 未触碰。
