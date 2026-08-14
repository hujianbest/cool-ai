# 进度

- 特性: 040-home-direct-chat
- 对应切片: S-56
- 当前阶段: done
- 执行模式: auto
- 已加载扩展: ext-ui-design
- 下一步: 无；S-56 已完成

## 状态记录

- 2026-08-14 用户指示：未选项目时中间默认也是聊天窗，只能跟一名 Agent chat，不能做基于项目的多 Agent 群聊；对照 GitHub 上 pi-agent 等 WebUI 抄交互。立项 040/S-56。039 暂停于 T-01 未开始。037 继续暂停。项目级 review 豁免，不伪造评审工件。GitHub clone 443 失败，按公开文档抄 IA 不抄源码（A-282）。
- 2026-08-14 grill auto-approved A-276～A-284。to-spec / to-architecture / to-tickets 完成。A-284：5 张票，直接 implement。
- 2026-08-14 T-01～T-04 完成（个人对话容器、GET /api/home、无项目中栏 1:1、左侧 Thread 目录）。T-05 冒烟待与 039 打开文件夹一并收口。
- 2026-08-15 用户澄清两条路径都要：不选项目可聊（本片），打开本地文件夹即项目（039）。A-285。本片 T-05 等 039 UI 落地后一起跑冒烟，避免烟测改两次。
- 2026-08-15 T-05 / ship 完成：`/` 保持单 Agent 个人对话/needs-agent 空态，文件夹项目 smoke 只按显式 `/projects/:id` 继续多人协作，不再误取列表中的个人容器；未知打开结果核对同样排除个人容器。最终 `npx tsc --noEmit`、`npx vitest run`（284 files / 2598 tests）、`npm run smoke`、`npm run smoke:onboarding`、`npm run build` 全绿。项目级 review 豁免生效，未创建 review 文件；未 commit，零 schema bump，037 未触碰。
