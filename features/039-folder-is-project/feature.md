# 特性

- 特性: 039-folder-is-project
- 对应切片: S-55
- 模式: 建造
- 用户可感知: 是
- 骨架: 否
- 状态: in-progress
- 一句话: owner 打开本机文件夹即进入或恢复该 Project，不再先输入项目名称再另绑工作区。

## 背景

- S-3 / `CAP-PWS-01` 把「创建项目」做成名称表单，工作区绑定是后续独立步骤。
- 用户 2026-08-14 指示：不应输入项目名称来创建项目；打开本地文件夹就是一个项目。参考 Codex / Cursor / Claude Code 的交互，自动完成整改。
- 领域不变：Project 仍是协作边界，文件夹是 Workspace 绑定根，不是 Project 的同义词（`CONTEXT.md` Avoid：工作区、仓库）。
- 037/S-53 AUD-GOV 暂停于 T-02；本会话不并行实现 037。

## 常用 Agent 交互洞察（2026-08-14）

- **Cursor**：File → Open Folder（或拖放）。打开的目录就是 workspace root；Agent 搜索、sandbox、终端 cwd 都相对该根。没有「先起项目名」。
- **Codex CLI**：在 cwd 启动；向上找最近 `.git` 作为项目根。Desktop / ChatGPT app：*Choose where to work* → 打开文件夹；可另加附加目录，但有一个 primary folder 驱动 chats / Git / `AGENTS.md`。
- **Claude Code / 同类 IDE Agent**：在目标目录打开或 `claude` 于该 cwd；显示名默认是目录 basename；最近项目 = 最近打开过的文件夹。
- **共同模式**：打开文件夹 = 进入项目；显示名 = 目录名；再打开同一路径 = 恢复，不复制一份空项目。
- **Cool AI 约束**：本机 Next.js 浏览器拿不到 OS 真实路径（File System Access API 无 Windows 绝对路径）。绑定仍须 verified-handle 的绝对目录。本片用「文件夹路径 + 打开文件夹」作为打开动作；不引入 Electron，也不在 Next 路由里弹不可测的系统对话框。

## Grill 确认（2026-08-14，auto-approved）

- Q1 打开文件夹 = 按规范路径 create-or-resume Project，显示名 = 目录 basename — A-264
- Q2 同一 `workspace_key` 恢复已有 Project，不新建 — A-265
- Q3 本片不做系统文件夹对话框；owner 提交本机绝对路径 — A-266
- Q4 不向上走到 `.git`；打开的目录就是绑定根 — A-267
- Q5 仍单绑定根；Codex 多文件夹 / `--add-dir` 范围外 — A-268
- Q6 `createProject(name)` 仅夹具/测试；owner API 改为 `{ path }` — A-269
- Q7 零 schema identity 变更 — A-270
- Q8 037 继续暂停 — A-271
