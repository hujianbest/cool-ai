# 架构 — 打开文件夹即项目

- 日期: 2026-08-14
- 对应规格: `spec.md`
- 用户确认: auto-approved 2026-08-14（项目级 review 豁免，不伪造 architecture-review）

## 对齐产品架构

落在 `product/architecture.md` 第 2 节 Project & Workspace 与第 11 节场景 1「组队与立项」：进入 Project 的命令从「名称创建 + 稍后 bind」改为「打开文件夹 create-or-resume」。不越界到 Mission、Collaboration 或把 Workspace 提升为领域同义词。D-47。

## 本片模块与缝

- **深模块**：`openWorkspaceAsProject` — 小接口（path）背后隐藏规范路径、查找、创建、绑定、审计。
- **Command Interface**：`ProjectWorkspaceCommands.openWorkspaceAsProject`；实现放在既有 sqlite project-workspace Adapter（复用 `canonicalDirectory` / `workspaceKey`，避免两事务）。
- **入站 Adapter**：`POST /api/projects` 改为 `{ path }`；装配经 `src/composition`。
- **UI Adapter**：`components/project-panel.tsx` 与引导文案；不新增领域事实。
- **测试缝**：命令测试、route 测试、jsdom 面板/引导；冒烟改造数路径。

`createProject(name)` 仍是 Adapter 函数，不作为 owner 命令。

## 核心数据

不改 schema。`projects.workspace_key` 已 UNIQUE 语义用于查找。新建行：`name` = basename，`workspace_path` / `workspace_key` 同事务写入，`version` 随 bind 递增。

## 关键流程

1. owner 提交绝对路径 → 入站校验 DTO → `openWorkspaceAsProject` → 规范目录 → `SELECT` by key → 命中则返回既有 Project（200）→ 未命中则 INSERT+policy+outbox+bind+outbox（201）。
2. 再次打开同一路径 → 200 同一 id，无第二份 `project_created`。
3. 非法/缺失/非目录/不可读 → 既有 `WorkspaceError`，失败关闭，不写 projects。

## 横切偏离

无。审计沿用 036 白名单（路径只进 basename excerpt）。凭据/sandbox/approval 不因打开文件夹而放宽。

## ADR 链接

- `product/decisions.md` D-47
- 假设 A-264～A-275
