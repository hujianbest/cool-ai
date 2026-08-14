# Cool AI

一个面向单个产品 owner 的本地优先协作驾驶舱：把可配置 Agent 组成平等团队，共同协作、执行、复核、记忆并交付结果。

[English](./README.md) · **简体中文**

## 为什么需要 Cool AI？

同时使用多个 Agent 时，owner 往往成了“人肉路由器”：反复复制上下文、指定下一棒、拼接分散产物，还要逐一确认结果是否真正验证。Cool AI 让 owner 保持最终控制权，但不必亲自转发每一条消息。团队围绕同一使命看板、共享记忆、显式交棒、受限执行和可审计交付链工作。

![Cool AI 协作驾驶舱总览](docs/images/cool-ai-cockpit-overview.png)

## 核心能力

- **团队配置：**连接 OpenAI-compatible Provider，创建可复用文本技能，并为不同 Agent 配置职责、模型、权限和预算。
- **项目上下文：**绑定本地工作区，组建平等项目组，通过带负责人、依赖、状态和来源记忆的使命 DAG 管理事实。
- **真实协作：**Agent 通过结构化 Provider 调用提出和领取任务，在项目群聊讨论、显式交棒、请求 owner 决策，并从持久化状态继续。
- **最多双路安全执行：**每个项目最多让两个独立任务在隔离区执行，并应用 verified path、精确命令授权、资源上限、验证、stale/冲突检查和受控合入。
- **独立复核：**owner 为冻结结果选择合格的非执行者 Agent，由其给出 `reject`、`escalate` 或 `pass`；平台不能冒充 Agent 生成裁决。
- **记忆与最终交付：**用不可变版本链保存有来源的目标、决策、事实、产物和经验；全部任务通过复核后生成最终交付。

## 从 Provider 到最终交付

1. 添加并验证 Provider，创建技能和至少两个职责不同的 Agent。
2. 不选择文件夹项目即可先与一名 Agent 进行 1:1 对话；需要协作时打开本地文件夹，系统会创建或恢复对应项目，再把 Agent 作为平等成员加入项目组。
3. 建立使命与任务 DAG，在项目群聊提交目标。
4. 让 Agent 提议、领取、讨论和交棒；owner 可随时发言、@Agent、回答决策请求、暂停或调整方向。
5. 仅为依赖已满足的任务启动 execution。每个 execution 在隔离区工作，合入前展示文件动作、命令审批、验证和 staged 变更。
6. 为每个当前结果选择合格的非执行者 Agent。处理退回或升级，保留通过的记忆；所有任务通过后生成最终交付。

<details>
<summary>查看团队配置</summary>

![两名 Agent 的不同职责、技能、权限与独立复核能力](docs/images/cool-ai-team-configuration.png)
</details>

<details>
<summary>查看真实 Agent 协作</summary>

![多 Agent 协作与显式交棒](docs/images/cool-ai-collaboration-run.png)
</details>

<details>
<summary>查看安全执行</summary>

![双 Agent 执行中的验证与一次性审批](docs/images/cool-ai-safe-execution.png)
</details>

<details>
<summary>查看复核与交付</summary>

![独立复核者、pass 裁决与最终交付摘要](docs/images/cool-ai-review-delivery.png)
</details>

## 平台与安全边界

Cool AI 是**本地优先、单 owner、无认证**的应用。只应在受信任本机使用，不要把开发服务器或 API 暴露到不可信网络。模型请求及任务所需上下文会发送给 owner 配置的 Provider，因此“本地优先”不等于“完全离线”。

- **Web、配置与协作：**面向本地桌面浏览器。某个平台能启动这些界面，不代表它已具备 verified file execution 支持。
- **完整 verified execution：**仅支持 Windows 10+ 或 Windows Server 2016+ x64、x64 Node.js 和本地 NTFS/ReFS 卷。其他操作系统、架构或文件系统上的文件 execution 会以 `SANDBOX_UNVERIFIABLE` 失败关闭。
- **Guardrail 不是 OS 沙箱：**隔离、verified handle、权限、审批、资源限制、验证和冲突检查可降低误操作风险，但 owner 批准的本地 executable 仍可能访问网络、系统资源、进程、服务、文件或凭据。处理敌对代码应使用虚拟机、容器或 OS 安全策略。
- **Provider 契约：**仅承诺 `GET /models` 与 `POST /chat/completions`；chat 内容必须是 JSON object，usage 必须合法、非负且算术一致。
- **生命周期：**每项目最多两个 active execution，同一 Agent 最多一个。应用没有后台 worker；关闭浏览器或重启应用后，不会无人值守继续或重放任务。

启用 execution 前，请阅读[安全模型](./docs/security.md)、[平台与限制](./docs/limits-and-platforms.md)和 [Provider 兼容性](./docs/provider-compatibility.md)。

## 快速开始

环境要求：Node.js 24.x、npm 11.x。

```powershell
npm install
# 如需严格按 lockfile 干净安装，可使用：npm ci
```

生成新的 32 字节 base64url 主密钥，切勿提交到仓库。

PowerShell：

```powershell
$env:COCKPIT_MASTER_KEY = node -e 'const { randomBytes } = require("node:crypto"); process.stdout.write(randomBytes(32).toString("base64url"))'
```

POSIX shell：

```sh
export COCKPIT_MASTER_KEY="$(node -e 'const { randomBytes } = require("node:crypto"); process.stdout.write(randomBytes(32).toString("base64url"))')"
```

启动应用：

```powershell
npm run dev
```

打开 <http://localhost:3000>。丢失或更换 `COCKPIT_MASTER_KEY` 后，之前保存的 Provider 凭据将无法解密，必须在团队设置中重新填写。

## 环境变量

- `COCKPIT_MASTER_KEY` — 保存或使用 Provider 凭据时必需；值为 32 个随机字节的 canonical base64url 编码。应与数据库和源码分开保管。
- `COCKPIT_DB_PATH` — 可选 SQLite 路径；默认 `.data/cockpit.sqlite`。
- `COCKPIT_EXECUTION_ROOT` — 可选 execution sandbox 与恢复目录；默认 `.data/executions`，不能放在项目工作区内。

路径示例、备份要求和恢复影响见[配置说明](./docs/configuration.md)。

## 架构概览

React 19 协作驾驶舱调用 Next.js 16 App Router handler；Route Handler 解析并验证 DTO，再调用服务端项目、协作、execution、复核、记忆和交付领域服务，execution、review 等安全关键 mutation 还会应用显式请求体上限。SQLite（`node:sqlite`）保存持久事实与不可变版本，Provider 提供模型调用，工作区 adapter 隔离并验证文件与进程操作。浏览器不会直接访问 SQLite、Provider 凭据或宿主文件。

```text
React 驾驶舱 → Next.js Route Handler → 领域服务 → SQLite
                                            ├──────→ owner 配置的 Provider
                                            └──────→ 工作区 / execution sandbox
```

协作、execution 与复核三条主链详见[架构概览](./docs/architecture/overview.md)。

## 文档导航

- [文档地图](./docs/README.md)
- [快速开始](./docs/getting-started.md)
- [团队配置](./docs/guides/team-setup.md)
- [项目工作流](./docs/guides/project-workflow.md)
- [协作与接力](./docs/guides/collaboration.md)
- [安全执行](./docs/guides/safe-execution.md)
- [复核与交付](./docs/guides/review-and-delivery.md)
- [故障排查](./docs/troubleshooting.md)

## 测试

仓库仅提供以下测试、构建和浏览器 smoke 命令：

```text
npm test
npm run build
npm run smoke
npm run smoke:team
npm run smoke:context
npm run smoke:collaboration
npm run smoke:execution
npm run smoke:review
```

各命令的覆盖范围见[测试与验证](./docs/testing.md)。

## 当前限制

Cool AI 当前不提供多用户账号或认证、公开云托管、生产部署工具、移动端优先操作、厂商原生 API、本地 Agent CLI 保证、任意 shell、敌对代码隔离、无人值守定时任务或跨重启自动推进。窄屏只提供基础查看、群聊与审批，配置和并行执行仍以桌面端为主。
