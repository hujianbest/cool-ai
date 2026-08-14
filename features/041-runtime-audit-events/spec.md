# 041 AUD-RUN 规格

- 日期: 2026-08-15
- 特性: 041-runtime-audit-events
- 对应切片: S-23 的 AUD-RUN 纵切（实现片号 S-57）
- 模式: 建造
- 用户可感知: 是
- 执行模式: auto
- 主 Capability: `CAP-RUN-07`

## 问题陈述

审计中心已覆盖 Safe Execution、Collaboration、Mission & Work、Project & Workspace、Governance。Runtime HTTP session（OpenAI-compatible chat 调用成败）仍不可见；owner 无法在项目审计中看到「这次模型调用是否打到了 Provider、以什么公开错误类别失败」，且不得看到凭据、提示词或原始响应。

## 解决方案

复用 028 投影基座做第五个 source-owner 纵切：Runtime 在 `callOpenAiChat` 返回后、与领域 `*_model_calls` 行同一事务内，向 `audit_event_outbox` 追加 `source='runtime'` 脱敏 session 信封。consumer 零改动。审计 UI 增加运行时域文案/徽标/定位。schema identity 23→24，source CHECK 加 `'runtime'`。

`*_model_calls` 表仍归各领域 owner（manifest notes.model_calls）；本片只追加 outbox，不改写那些表的事实归属。

## 事件选型

入列（2 类，actor 恒为 owner）：

| eventType | 写入时机 | payload 白名单 |
| --- | --- | --- |
| `runtime_call_succeeded` | `callOpenAiChat` 成功且领域事务提交 | `surface`（collaboration/execution/review）、`model`（公开模型名，grapheme 截断）、可选导航 id |
| `runtime_call_failed` | `callOpenAiChat` 失败且领域事务仍提交失败行 | 同上 + `errorCategory`（公开分类枚举） |

不入列：apiKey、baseUrl/宿主、messages、content、原始 provider JSON、隐藏推理、token 明细（usage 已由执行/协作域各自事件覆盖）、Provider 设置页的全局 verify（无 project_id，移交健康切片）。

## 用户故事

1. 作为 owner，我想在审计中心看到本项目的 Runtime 调用成败，从而判断模型通道是否工作。
2. 作为 owner，我想从该事件跳回对应协作 run / 执行 / 复核来源，畸形 id 不渲染链接。

## 测试缝

- Outbox 写缝：成功/失败同事务入列；白名单无秘密；选型外不入列；seq 单调；reopen 幂等。
- UI 缝：运行时文案、域徽标、定位 href、与既有五域混排。
- 浏览器验收：复用已有真实模型调用的 smoke（优先 smoke:execution 或 smoke:collaboration），不新开第四轮完整 Agent execution。

## 范围外

- CAP-RUN-02 外部 CLI/ACP 会话、MCP、插件、通知、语音。
- 全局 Provider verify。
- AUD-UI 统一筛选。
