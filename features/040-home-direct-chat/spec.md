# 无项目时单 Agent 聊天 需求规格

- 日期: 2026-08-14
- 特性: 040-home-direct-chat
- 对应切片: S-56
- 模式: 建造
- 用户可感知: 是
- 执行模式: auto
- 共享理解来源: 用户要求对照 pi-agent 等主流 Agent WebUI；A-276～A-284
- 公共行为接缝: Direct-home Command/Query；TaskPanel 无项目中栏；ProjectThreadNavigation 在 `/`
- 主子系统: Project & Workspace（个人对话容器）+ 入站 UI Adapter；消费 `CAP-COL-01`、`CAP-IDC-01`；主领域 Capability: `CAP-PWS-01`（允许未绑定项目 1 成员）

## 问题陈述

未选项目时中栏是「请先创建或选择项目，再运行任务」。主流 Agent WebUI（pi-agent-web、pi-outpost、ChatGPT、Open WebUI）打开就是聊天窗，默认跟一个 Agent 说话。Cool AI 把聊天锁在项目群聊后面，没有项目就无法对话。

## 解决方案

`/` 且未选项目时，中间仍是聊天列：消息流 + composer。对端是一名已配置 Agent。左侧列出个人对话（Thread）。选中一个文件夹项目后，才切换到现有多 Agent 群聊 / 使命看板。

## 用户故事

1. **作为 owner，未选项目时我也想直接和一名 Agent 聊天，从而先对话再决定是否立项。**
   - `/` 中栏不再是「选择项目以运行任务」死胡同。
   - 至少一名 Agent 时：可新建对话、发送、看到回复（复用既有 Collaboration Run）。
   - 没有 Agent 时：空态说明并提供去配置 Agent 的入口。
2. **作为 owner，我想在无项目时不能把聊天变成多 Agent 群聊，从而项目协作仍有明确边界。**
   - 个人对话容器只有当前选中的一名成员。
   - 不展示使命看板、执行面板、多人线程策略。
   - composer 不邀请第二名 Agent 入组。
3. **作为 owner，我想在左侧看到个人对话列表，从而像 pi-agent 一样切换 session。**
   - 无项目选中时左侧列出个人对话 Thread（标题/最近）。
   - 选中项目后左侧恢复该项目的 Thread 目录（既有）。

## 实现决策

- `ensureDirectProject`：查找 `name='个人对话' AND workspace_path IS NULL`，没有则 `createProject`。不出现在「这是一个文件夹项目」的心智里时可仍被 GET /api/projects 返回——UI 在无项目路由下优先把它当 home 容器，不强制从项目列表点选。
- `setDirectChatAgent(databasePath, projectId, agentId, expectedVersion)`：仅当该项目未绑定工作区时允许恰好 1 名成员；绑定项目仍走 `replaceMembers`（≥2）。
- 个人 Thread：创建时 policy 仅含该 Agent；发送不带 mention 时走既有 `members[0]` 派发。
- `GET /api/home`：返回 `{ project, agent, threads }` 或 `{ kind: 'needs_agent' }`。信封保持严格、脱敏。
- UI：`projectId` 为空时 TaskPanel 加载 home，渲染 CollaborationPanel（surface=chat）；隐藏 MissionBoard / ExecutionPanel；标题显示 Agent 名而非「任务活动」。
- 暖陶 token，不引入 pi 品牌色或第三方 CSS。
- 零 schema identity 变更。

## UI 设计

- IA：Rail | 对话目录（个人 Thread）| 1:1 聊天列 | 右侧改为当前 Agent 摘要（无使命）。
- 态：loading 加载个人对话；empty 无 Agent / 无消息；error 就地；disabled 发送中；success 出现回复；focus 可见。
- 热区 ≥ 44×44。

## 测试决策

- 命令缝：ensure 幂等、1 成员仅未绑定项目、绑定项目拒绝 1 成员、无 Agent 不建可聊状态。
- API 缝：GET /api/home 形态；错误脱敏。
- UI 缝：无 projectId 时中栏是聊天而非「选择项目以运行任务」；有项目时群聊/看板不回归。
- 冒烟：`smoke` 或 `smoke:onboarding` 受影响段；至少覆盖打开 `/` 见到 composer。

## 范围外事项

- 打开文件夹即项目（039）。
- 把 pi-agent 源码/包引进仓库。
- 无工作区执行文件命令；多根；Electron 选文件夹。
- 重写 S-11 引导顺序。
- 037 AUD-GOV。

## 补充说明

- 用户确认: auto-approved 2026-08-14
