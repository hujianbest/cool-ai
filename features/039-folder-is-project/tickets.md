# 任务票 — 打开文件夹即项目

- 状态: 项目级 review 豁免生效，直接进入 implement
- 规模: 4 张纵向 RED/GREEN 票；单一「打开文件夹即进入/恢复 Project」用户结果
- 公共缝: `openWorkspaceAsProject`；`POST /api/projects`；ProjectPanel / 引导 UI
- TDD: 每票先一个公共行为 RED，再最小 GREEN；内存库；打开命令用临时真实目录或 `WorkspaceFs` fake

- [x] T-01 打开文件夹命令：create-or-resume 同事务绑定 — Blocked by: None
  - 公共缝: Project & Workspace Command。
  - RED: 尚无 `openWorkspaceAsProject`；打开真实目录不会创建已绑定 Project，再打开也不会恢复。
  - GREEN: 实现命令（复用 canonical/key；name=basename；命中 key 则返回既有；未命中则同一事务创建+policy+`project_created`+bind+`workspace_bound`）；非法路径 typed `WorkspaceError`；失败回滚无半成品。`createProject(name)` 保留。零 schema bump。Command Interface 增加该方法。
  - 验证: 新建 bound、恢复同 id、错误码、审计两事件、无 `WORKSPACE_ALREADY_BOUND` 于同路径恢复。
  - 命令: `npm test -- tests/modules/project-workspace/`；`npx tsc --noEmit`
  - 验证记录（2026-08-15）: `open-workspace-as-project.test.ts` 覆盖创建/恢复、typed error、两条审计事件及不劫持「个人对话」；与 workspace/direct 聚焦测试共同通过。

- [x] T-02 owner API 改为 `POST /api/projects` `{ path }` — Blocked by: T-01
  - 公共缝: 入站 route。
  - RED: POST 仍要求 `name`；`path` 被忽略或 400。
  - GREEN: 只接受 `{ path: string }`；201 新建 / 200 恢复；信封 `{ project }`；WorkspaceError 映射同 workspace route；`{ name }` 与缺字段 400；未知失败仍走脱敏 INTERNAL_ERROR（更新 sanitization 测例 body）。composition 导出命令。
  - 验证: projects.api.test.ts 用临时目录；sanitization 不泄漏 sentinel。
  - 命令: `npm test -- tests/modules/project-workspace/projects.api.test.ts tests/adapters/inbound/api-error-sanitization.test.ts`
  - 验证记录（2026-08-15）: 真实临时目录 201/200、严格 `{ path }`、WorkspaceError 信封及未知错误脱敏聚焦测试通过。

- [x] T-03 项目导航与引导改为打开文件夹 — Blocked by: T-02
  - 公共缝: jsdom UI。
  - RED: 仍有「项目名称」「创建项目」。
  - GREEN: ProjectPanel 表单改为文件夹路径 + 「打开文件夹」；空状态说明可打开文件夹协作，也可不选项目在中间 1:1 聊天（040 已有）。POST `{ path }`；错误 copy（空路径/工作区码）；引导「使用现有表面打开文件夹」并聚焦路径输入。同步 cockpit-layout、task-flow、onboarding-happy-path 等引用旧文案的 jsdom。`api-error-copy` 补工作区码。不得把「个人对话」列成可点选的文件夹项目，也不得在打开文件夹时改绑该单例。
  - 验证: loading/empty/error/success；保留输入；不提交名称。
  - 命令: 聚焦 `tests/browser/project-context/project-panel.test.tsx` 及相关 jsdom；`npx tsc --noEmit`
  - 验证记录（2026-08-15）: 12 个聚焦文件共 104 tests 通过，含 ProjectPanel、onboarding、cockpit、task-flow、API/command 与 040 home API/UI/direct-project；`npx tsc --noEmit` 通过。

- [x] T-04 冒烟、文档与切片收口 — Blocked by: T-03
  - 公共缝: 真实浏览器造数 + 产品文案。
  - GREEN: 所有仍 fill「项目名称」/点「创建项目」的 smoke harness 改为填写临时目录并「打开文件夹」；若打开后工作区已 ready，跳过首次 bind，保留改绑用例（另填第二目录）。更新 README.zh-CN、docs/getting-started.md、docs/guides/project-workflow.md、docs/guides/team-setup.md 步骤。聚焦受影响 smoke（至少 `smoke` 与 `smoke:onboarding` 或 `smoke:context`）；一次全量 `npx vitest run` + `npx tsc --noEmit` + `npm run build`；勾选票；progress/backlog 收口。
  - 命令: 受影响 smoke；全量一次；build
  - 验证记录（2026-08-15）: `tests/browser` 的 `.mjs/.ts` 已无「项目名称」/「创建项目」；8 个 Playwright harness 与 settings contract 均改为打开真实临时文件夹并使用目录 basename，首次 bind 已移除、改绑路径保留。`npx tsc --noEmit` 通过；最终 `npx vitest run` 为 284 files / 2598 tests 全绿；`npm run smoke` 与 `npm run smoke:onboarding` 均通过；`npm run build` 通过。期间全量套件先暴露 production build 过期与 harness 误取个人对话容器，onboarding smoke 又暴露未知写核对把「个人对话」误算为新文件夹项目；均修复后按聚焦测试与全量门复核通过。
