# Cool AI 文档

Cool AI 是面向单个产品 owner 的本地优先 Web 多 Agent 协作平台。模型请求会发送到 owner 配置的 Provider；“本地优先”不等于完全离线。

## 按目标阅读

### 新用户

1. [快速开始](./getting-started.md)：确认环境、安装、启动，并走通第一条产品路径。
2. [配置说明](./configuration.md)：设置数据库、凭据主密钥与 execution 目录。
3. [团队配置](./guides/team-setup.md)：连接 Provider、创建技能和至少两个 Agent。
4. [平台与能力边界](./limits-and-platforms.md)：开始安全执行前先确认完整支持矩阵。

### 日常使用

1. [项目工作流](./guides/project-workflow.md)：从工作区、成员和使命 DAG 开始。
2. [协作与接力](./guides/collaboration.md)：群聊、@Agent、决策请求和暂停恢复。
3. [安全执行](./guides/safe-execution.md)：隔离变更、验证、审批与合并。
4. [复核与交付](./guides/review-and-delivery.md)：独立复核、五类记忆和最终交付。
5. [故障排查](./troubleshooting.md)：按症状定位常见问题。

### 理解原理

- [架构概览](./architecture/overview.md)：React、Next.js App Router、Route Handler、领域服务、SQLite 与 Provider。
- [安全模型](./security.md)：可信边界、凭据、工作区 guardrail 与明确不保证的事项。
- [Provider 兼容性](./provider-compatibility.md)：当前承诺的 OpenAI-compatible HTTP 契约。
- [限制与平台](./limits-and-platforms.md)：并发、资源、后台运行和 verified execution 支持范围。

### 开发验证

- [测试与验证](./testing.md)：安装、构建、单元测试与六个浏览器 smoke 命令。
- [架构概览](./architecture/overview.md)：先理解三条主链，再定位实现。
- [项目产品规格说明书](../product/product.md)、[领域词汇表](../product/词汇表.md)、[产品架构设计说明书](../product/architecture.md)与[特性分解清单](../product/backlog.md)：分别查看产品边界、统一语言、架构基线与切片注册。文档地图见 [`product/README.md`](../product/README.md)。

## 文档事实边界

- 根目录 [README](../README.md) 是仓库入口与最短安装/运行说明，不承担完整产品手册。
- `docs/` 是当前用户与开发者文档，解释如何使用、配置、验证及理解已实现行为。
- [`product/`](../product/) 是产品层事实源：规格说明书、架构设计说明书、特性分解清单、开发计划、开发进展与 UI 设计；决策与假设台账为附录。用户文档不能反向替代这些记录。
- [`features/`](../features/) 是各切片的规格、设计、进度、评审与机器证据历史；它不是日常用户指南，也不应把某次验收数据写成永久产品承诺。
- 当前源码与测试是实现行为的最高优先级。文档与实现冲突时，应先按实现保护数据与安全，再修正文档或明确启动新的行为变更切片。

![协作驾驶舱总览](./images/cool-ai-cockpit-overview.png)
