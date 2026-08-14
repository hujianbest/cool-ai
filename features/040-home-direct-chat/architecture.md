# 架构 — 无项目时单 Agent 聊天

- 日期: 2026-08-14
- 对应规格: `spec.md`
- 用户确认: auto-approved 2026-08-14（项目级 review 豁免）

## 对齐产品架构

落在 Project & Workspace（项目隔离边界）与 Public Collaboration（Thread/Run/Message）。不把 Thread 从 Project 拆出（第 2 节 ownership tuple）。个人对话是**未绑定工作区的单例 Project**，不是新子系统。场景 1「组队与立项」的群聊仍要求选中文件夹项目。D-47 的文件夹立项由 039 承担，本片不实现。

## 本片模块与缝

- **深模块** `ensureDirectProject` / `setDirectChatAgent`：调用方只给 Agent，背后隐藏单例查找、1 成员写入。
- **Query** `getHomeState`：无 Agent → needs_agent；有 Agent → project + 当前成员 + threads。
- **入站** `GET /api/home`（及必要时 POST 选 Agent / 新建 Thread，优先复用既有 `/api/projects/:id/threads`）。
- **UI** TaskPanel 无 `projectId` 分支改为 home chat；ProjectThreadNavigation 在 `/` 挂到个人项目。
- 不改 Collaboration 派发内核；1 成员时既有 `members[0]` 即对端。

## 核心数据

不改 schema。约定：`projects.name = '个人对话' AND workspace_path IS NULL`。`project_memberships` 对该行允许 1 条。Thread policy 1 名成员。

## 关键流程

1. 打开 `/` → GET /api/home → 无 Agent 则空态；有 Agent 则确保个人项目与 1 成员 → 列出 Thread → 中栏 CollaborationPanel。
2. 发送消息 → 既有 thread message/start，mention 默认该 Agent。
3. 打开 `/projects/:id`（非个人容器）→ 既有群聊 + 看板。个人容器不作为「文件夹项目」主路径强调。

## 横切偏离

无。无工作区时 Safe Execution 仍失败关闭。审计：若创建个人项目，沿用 `project_created`；1 成员写入沿用 `member_joined`。

## ADR 链接

- A-276～A-284
- 039 D-47 仍有效但本片不交付打开文件夹
