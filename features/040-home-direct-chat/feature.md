# 特性

- 特性: 040-home-direct-chat
- 对应切片: S-56
- 模式: 建造
- 用户可感知: 是
- 骨架: 否
- 状态: in-progress
- 一句话: 未选项目时中间仍是聊天窗，只能与一名 Agent 1:1 对话；打开项目后才进入多 Agent 群聊协作。

## 背景

- 当前 `/` 无项目时，中栏是「请先创建或选择项目，再运行任务」，右栏是「请先选择项目」。这不像 ChatGPT / Claude / Cursor / pi-agent WebUI。
- 用户 2026-08-14 要求对照主流 Agent WebUI（点名 pi-agent）把未选项目的默认布局改成聊天窗；此时只能跟 Agent chat，不能做基于项目的多 Agent 群聊。
- 039/S-55「打开文件夹即项目」暂停于 T-01 未开始；本片只改无项目空态。文件夹立项不在本片实现。
- 037 继续暂停。

## GitHub / 主流 WebUI 洞察（2026-08-14）

本机 `git clone` GitHub 443 失败，未把第三方源码拷进本仓库（也不应拷贝其版权代码）。依据公开 README / 文档：

| 产品 | 无项目时中间 | 左侧 | 项目/文件夹的作用 |
| --- | --- | --- | --- |
| [pi-agent-web](https://github.com/Neonotso/pi-agent-web) | ChatArea，可 Quick chat | 多 session 侧栏 | session 可挂项目，但聊天是一等公民 |
| [pi-web-ui](https://github.com/xing-shuyin/pi-web-ui) | 立刻能聊 | Recent projects + 每项目自己的 sessions | 工作区是可选上下文 |
| [pi-outpost](https://github.com/laurentftech/pi-outpost) | 单 AgentSession 聊天 | 无项目门槛 | 单会话；凭证配好就能聊 |
| [pi-webui](https://github.com/hyperdreamer/pi-webui) | 空 workspace 发一条即建 session | 项目=机器上的文件夹 | 文件夹是运行根，不是「先起名」 |
| [@mariozechner/pi-web-ui](https://github.com/badlogic/pi-mono/tree/main/packages/web-ui) | ChatPanel + AgentInterface | SessionsStore | Agent 实例驱动，不先选 Project |
| ChatGPT / Claude.ai / Open WebUI / LobeChat | 居中 composer + 对话 | 对话列表 | Project/Workspace 是可选分组 |

**要抄的交互（不是抄源码）：**

1. 打开应用，中间永远是聊天列（消息流 + 底部 composer）。
2. 左侧是对话/session，不是「请先立项」死胡同。
3. 默认一次只跟一个 Agent（或一个模型）说话；多角色群聊是进了项目之后的事。
4. 没有工作区时不假装能跑仓库命令。

## Grill 确认（2026-08-14，auto-approved）

- Q1 新切片 040，暂停 039 — A-276
- Q2 复用 Project+Thread 做「个人对话」容器，不新建 DirectChat 领域 — A-277
- Q3 个人容器允许 1 名项目成员（绑定文件夹的项目仍 ≥2）— A-278
- Q4 无 Agent 时中栏引导去配置 Agent，不假聊 — A-279
- Q5 本片不改引导主链、不实现 039 打开文件夹 — A-280
- Q6 零 schema bump；个人对话=未绑定工作区且名称为约定名的单例 Project — A-281
- Q7 抄交互不抄第三方源码进仓库 — A-282
