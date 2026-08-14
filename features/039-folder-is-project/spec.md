# 打开文件夹即项目 需求规格

- 日期: 2026-08-14
- 特性: 039-folder-is-project
- 对应切片: S-55
- 模式: 建造
- 用户可感知: 是
- 执行模式: auto（用户要求自动完成整改；默认记入 A-264～A-275）
- 共享理解来源: 用户指示对齐 Codex/Cursor；`CONTEXT.md` Project ≠ 仓库；已交付 `CAP-PWS-01/02`
- 公共行为接缝: Project Workspace Command（`openWorkspaceAsProject`）；`POST /api/projects`；项目导航 UI（ProjectPanel / 引导）
- 主子系统: Project & Workspace；主 Capability: `CAP-PWS-01`（扩展打开/恢复语义，不新建 Capability ID）

## 问题陈述

owner 现在必须先输入「项目名称」才能得到一个空 Project，再另填绝对路径绑定工作区。这与 Cursor、Codex、Claude Code 等常用 Agent 的习惯相反：打开本机文件夹就是进入该项目。名称创建还容易产生没有绑定根的空项目。

## 解决方案

把 owner 进入 Project 的动作改成「打开本地文件夹」：校验绝对目录 → 按规范 `workspace_key` 查找 → 已有则恢复，没有则用目录名创建 Project 并在同一事务绑定工作区。侧栏与空状态不再提供名称创建表单。

## 用户故事

1. **作为 owner，我想打开一个本机文件夹就进入该项目，从而立刻在真实工作区里协作。**
   - 空状态说明「打开本地文件夹开始使用协作驾驶舱」；表单标签为「文件夹路径」，主按钮为「打开文件夹」。
   - 提交有效绝对目录后，项目显示名为该目录 basename，工作区状态为 ready。
   - loading / empty / error / disabled / success / focus 均覆盖；热区 ≥ 44×44；错误不回显完整宿主路径中的未校验原文以外的秘密。
2. **作为 owner，我想再次打开同一文件夹时回到原来的项目，而不是得到一份空白副本。**
   - 同一规范路径（Windows 大小写折叠）返回既有 Project；HTTP 200。
   - 新建为 HTTP 201。响应信封仍为 `{ project }`。
3. **作为 owner，我想在首次引导里用打开文件夹代替「创建项目」，从而与驾驶舱同一套动作。**
   - 引导文案与 CTA 改为打开文件夹；仍可跳到既有项目表面聚焦路径输入。
   - 打开成功后可继续 workspace 步骤（改绑或确认已绑定），不删除 WorkspaceSetup。

## 实现决策

- 新命令 `openWorkspaceAsProject(databasePath, path, workspaceFs?)` 属于 Project & Workspace Command Interface；在同一 `BEGIN IMMEDIATE` 内查找 `workspace_key`、必要时 INSERT project + 初始化 validation policy + `project_created` outbox + 绑定列 + `workspace_bound` outbox。
- 复用既有 `canonicalDirectory` / `workspaceKey` 与 bind 校验（绝对路径、realpath、目录、可读）。不向上找 `.git`。
- `POST /api/projects` 只接受 `{ path: string }`；拒绝 `{ name }` 与缺 path。映射既有 `WorkspaceError` 稳定码。`createProject(name)` 保留给测试夹具。
- 零 schema identity 变更。`parseProjectCreateEnvelope` 保持单键 `{ project }`。
- UI 复用既有表单控件与 token，不新造视觉语言。`caughtApiErrorCopy` 补齐工作区错误码中文。
- 不引入系统选文件夹对话框、Electron 或多绑定根。

## UI 设计

- 信息架构：项目导航仍为最近/已打开项目列表；创建区改为打开文件夹。
- 交互态：空列表引导 + 路径表单；提交中按钮 disabled「正在打开…」；校验空路径就地 alert；API 错误就地 alert 并保留输入；成功清空输入并选中该项目。
- 视觉：沿用暖陶 token 与既有 `form-field` / `button-primary`；禁止新渐变/emoji。

## 测试决策

- TDD 每轮一个公共缝 RED + 最小 GREEN；内存库 + 临时真实目录（workspace 语义需要真实/可 mock 的 Fs）。
- **命令缝**：新目录 → 创建且 bound；再打开 → 同一 id；非法路径 typed error；审计两事件同事务；失败不落半成品。
- **API 缝**：`POST { path }` 201/200；`{ name }` 400；错误码稳定且脱敏。
- **UI 缝**：jsdom ProjectPanel / onboarding / cockpit-layout / task-flow 文案与 POST body。
- **冒烟**：所有通过「项目名称/创建项目」造数的 browser smoke 改为打开临时目录；受影响 `smoke:onboarding`、`smoke:context`、`smoke` 及其他仍走该表单的 harness。

## 范围外事项

- 系统文件夹拾取器 / 拖放目录拿到 OS 路径（需原生宿主）。
- 多文件夹项目、向上 Git 根、把 Project 重命名为仓库概念。
- 删除 `createProject(name)` 夹具；删除 WorkspaceSetup 改绑。
- 037 AUD-GOV。

## 补充说明

- 单一用户结果：打开文件夹即进入/恢复 Project。
- 项目级 review 豁免，不伪造 spec-review。
- 用户确认: auto-approved 2026-08-14
